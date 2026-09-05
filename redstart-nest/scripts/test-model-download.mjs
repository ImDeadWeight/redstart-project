// =============================================================================
// Model downloader security suite — electron/main/model-download.mjs,
// ./hf-catalog.mjs and ./http-redirects.mjs.
// =============================================================================
// This is the only code in Redstart that writes multi-gigabyte files fetched
// from the internet, so the invariants it has to hold are the ones tested here:
//
//   - a redirect off the approved hosts is refused BEFORE it is requested
//   - a remote filename cannot escape the models folder
//   - a download is never renamed into place unless its checksum matches
//   - an interruption leaves a resumable .part, never something that looks
//     like a model
//   - insufficient disk fails before the first byte, not at 94%
//
// NO NETWORK. globalThis.fetch is replaced with a shim that serves canned
// responses. The shim is at the TRANSPORT layer only — the real host policy
// (isHuggingFaceUrl) still runs against real huggingface.co URLs, so these
// tests exercise the production allowlist rather than a relaxed copy.
//
// Run:  node scripts/test-model-download.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-path-scope.mjs)
// ---------------------------------------------------------------------------

const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg) }

async function expectReject(fn, matcher, why) {
  let threw = null
  try { await fn() } catch (err) { threw = err }
  assert(threw, `expected a rejection: ${why}`)
  if (matcher) {
    assert(matcher.test(threw.message), `wrong error for ${why}: ${threw.message}`)
  }
  return threw
}

// ---------------------------------------------------------------------------
// fetch shim
// ---------------------------------------------------------------------------
// routes: Map<urlPrefix, handler(url, init) => Response | {redirect: url}>
// Records every URL actually requested, which is how "refused BEFORE the
// request" is asserted rather than assumed.

const requested = []
let routes = new Map()

globalThis.fetch = async (url, init = {}) => {
  requested.push(String(url))
  if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  for (const [prefix, handler] of routes) {
    if (String(url).startsWith(prefix)) return handler(String(url), init)
  }
  throw new Error(`test shim: no route for ${url}`)
}

function reset() { requested.length = 0; routes = new Map() }

// Parsed host of a recorded request. Assertions about "was this host
// contacted" must compare the parsed hostname rather than substring-match the
// URL — see the note at the off-allowlist redirect test.
function hostOf(url) {
  try { return new URL(url).hostname } catch { return null }
}

function bodyStream(chunks, { delayMs = 0, signal } = {}) {
  return new ReadableStream({
    async pull(controller) {
      const chunk = chunks.shift()
      if (!chunk) { controller.close(); return }
      if (delayMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, delayMs)
          signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
        })
      }
      controller.enqueue(chunk)
    },
  })
}

function okResponse(buf, { status = 200, headers = {}, stream = null } = {}) {
  return new Response(stream || buf, {
    status,
    headers: { 'content-length': String(buf?.length ?? 0), ...headers },
  })
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ---------------------------------------------------------------------------
// Subject under test — imported AFTER the shim is installed
// ---------------------------------------------------------------------------

const {
  isHuggingFaceUrl, isValidRepoId, isValidRevision, parseQuant,
  buildArtifacts, buildDownloadUrl, baseModelOf, extractDescription,
} = await import('../electron/main/hf-catalog.mjs')

const {
  downloadArtifact, destinationFor, discardPartials, PART_SUFFIX,
} = await import('../electron/main/model-download.mjs')

const { fetchFollowingRedirects } = await import('../electron/main/http-redirects.mjs')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-model-dl-'))
const modelsDir = path.join(base, 'Models')
fs.mkdirSync(modelsDir, { recursive: true })

const REPO = 'unsloth/Test-Model-GGUF'
const REV = 'd5b1d57bd0b504ac62ae6c725904e96ef228dc74'

function artifactFor(name, buf, extra = {}) {
  return {
    id: name,
    quantLabel: 'Q4_K_M',
    quantRecognized: true,
    files: [{ rfilename: name, size: buf.length, sha256: sha256(buf), shardIndex: null }],
    shardTotal: 1,
    totalBytes: buf.length,
    complete: true,
    verifiable: true,
    ...extra,
  }
}

// ===========================================================================
console.log('\n--- host policy (the approved-origin allowlist) ---')
// ===========================================================================

await test('the Hub and its regional CDN are approved', () => {
  assert(isHuggingFaceUrl('https://huggingface.co/a/b'), 'main site rejected')
  // Observed live 2026-08-08: downloads redirect here.
  assert(isHuggingFaceUrl('https://us.aws.cdn.hf.co/xet-bridge-us/abc'), 'CDN rejected')
  assert(isHuggingFaceUrl('https://cdn-lfs.huggingface.co/x'), 'lfs CDN rejected')
})

await test('🔍 a lookalike domain cannot pass as an approved host', () => {
  assert(!isHuggingFaceUrl('https://evilhf.co/x'), 'evilhf.co accepted as hf.co')
  assert(!isHuggingFaceUrl('https://hf.co.evil.com/x'), 'suffix-prefixed domain accepted')
  assert(!isHuggingFaceUrl('https://nothuggingface.co/x'), 'nothuggingface.co accepted')
})

await test('🔍 plaintext http is refused even on an approved host', () => {
  assert(!isHuggingFaceUrl('http://huggingface.co/a/b'), 'http accepted')
})

// ===========================================================================
console.log('\n--- repo id / revision validation (they land in a URL path) ---')
// ===========================================================================

await test('🔍 a traversal-shaped repo id is rejected', () => {
  for (const bad of ['a/../../b', '../etc/passwd', 'a/b/../c', './x/y']) {
    assert(!isValidRepoId(bad), `accepted traversal id: ${bad}`)
  }
})

await test('🔍 a repo id carrying URL syntax is rejected', () => {
  for (const bad of ['a/b?x=1', 'a/b#frag', 'a/b c', 'a//b', 'a/b\\c', 'one']) {
    assert(!isValidRepoId(bad), `accepted malformed id: ${bad}`)
  }
})

await test('a legitimate repo id is accepted', () => {
  assert(isValidRepoId('unsloth/Qwen3-30B-A3B-GGUF'), 'rejected a real id')
  assert(isValidRepoId('ggml-org/gpt-oss-20b-GGUF'), 'rejected a real id')
})

await test('🔍 a traversal-shaped revision is rejected', () => {
  for (const bad of ['..', '../main', 'a/b', 'x?y']) {
    assert(!isValidRevision(bad), `accepted bad revision: ${bad}`)
  }
  assert(isValidRevision(REV), 'rejected a real sha')
})

await test('🔍 the download URL pins the revision, never a branch the repo can move', () => {
  const url = buildDownloadUrl(REPO, REV, 'model-Q4_K_M.gguf')
  assert(url === `https://huggingface.co/${REPO}/resolve/${REV}/model-Q4_K_M.gguf`, `wrong url: ${url}`)
  assert(!url.includes('/resolve/main/'), 'built a branch-relative URL')
})

await test('🔍 buildDownloadUrl refuses a malformed repo id or revision', async () => {
  await expectReject(async () => buildDownloadUrl('a/../b', REV, 'x.gguf'), /Invalid model id/, 'bad repo id')
  await expectReject(async () => buildDownloadUrl(REPO, '../main', 'x.gguf'), /Invalid revision/, 'bad revision')
})

// ===========================================================================
console.log('\n--- destination containment (rfilename is an untrusted remote string) ---')
// ===========================================================================

await test('🔍 a traversal filename cannot escape the models folder', () => {
  for (const bad of ['../../evil.gguf', '..\\..\\evil.gguf', 'sub/../../evil.gguf']) {
    const dest = destinationFor(modelsDir, bad)
    assert(dest.startsWith(modelsDir + path.sep), `escaped to ${dest} via ${bad}`)
    assert(path.basename(dest) === 'evil.gguf', `unexpected basename: ${dest}`)
  }
})

await test('🔍 an absolute or UNC filename is flattened into the models folder', () => {
  for (const bad of ['C:\\Windows\\System32\\evil.gguf', '/etc/evil.gguf', '\\\\server\\share\\evil.gguf']) {
    const dest = destinationFor(modelsDir, bad)
    assert(dest.startsWith(modelsDir + path.sep), `escaped to ${dest} via ${bad}`)
  }
})

await test("🔍 the Hub's folder prefix is flattened, not recreated", () => {
  const dest = destinationFor(modelsDir, 'BF16/model-00001-of-00002.gguf')
  assert(path.dirname(dest) === modelsDir, `created a subfolder: ${dest}`)
  assert(path.basename(dest) === 'model-00001-of-00002.gguf', `wrong name: ${dest}`)
})

await test('🔍 a non-GGUF file is refused outright', async () => {
  for (const bad of ['payload.exe', 'script.ps1', 'README.md', 'model.gguf.exe']) {
    await expectReject(async () => destinationFor(modelsDir, bad), /non-GGUF/, bad)
  }
})

await test('a NUL byte in the filename is refused', async () => {
  await expectReject(async () => destinationFor(modelsDir, 'evil\0.gguf'), /invalid character|non-GGUF/i, 'NUL byte')
})

// ===========================================================================
console.log('\n--- redirect policy (every hop re-validated before it is requested) ---')
// ===========================================================================

await test('an approved CDN hop is followed', async () => {
  reset()
  routes.set('https://huggingface.co/', () =>
    new Response(null, { status: 302, headers: { location: 'https://us.aws.cdn.hf.co/blob/1' } }))
  routes.set('https://us.aws.cdn.hf.co/', () => okResponse(Buffer.from('payload')))

  const { response } = await fetchFollowingRedirects('https://huggingface.co/a/b', { isUrlAllowed: isHuggingFaceUrl })
  assert(response.status === 200, `expected 200, got ${response.status}`)
  assert(requested.length === 2, `expected 2 requests, saw ${requested.length}`)
})

await test('🔍 a redirect to an unapproved host is refused BEFORE it is requested', async () => {
  reset()
  routes.set('https://huggingface.co/', () =>
    new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } }))
  routes.set('https://evil.example.com/', () => okResponse(Buffer.from('should never be fetched')))

  await expectReject(
    () => fetchFollowingRedirects('https://huggingface.co/a/b', { isUrlAllowed: isHuggingFaceUrl }),
    /not an approved address/, 'off-allowlist redirect',
  )
  // Compare the PARSED hostname, not a substring of the URL. A substring test
  // would also match a benign URL that merely mentions the host in its path or
  // query (`https://huggingface.co/?x=evil.example.com`), so it can both miss
  // the real case and fire on the wrong one. CodeQL flags the substring form
  // for exactly that reason (js/incomplete-url-substring-sanitization).
  assert(
    !requested.some(u => hostOf(u) === 'evil.example.com'),
    `the disallowed host WAS contacted: ${requested.join(', ')}`,
  )
  return 'no traffic to the disallowed host'
})

await test('🔍 a redirect chain longer than the cap is refused', async () => {
  reset()
  let n = 0
  routes.set('https://huggingface.co/', () =>
    new Response(null, { status: 302, headers: { location: `https://huggingface.co/hop${++n}` } }))

  await expectReject(
    () => fetchFollowingRedirects('https://huggingface.co/a', { isUrlAllowed: isHuggingFaceUrl }),
    /Too many redirects/, 'infinite redirect loop',
  )
  assert(requested.length <= 7, `followed too many hops: ${requested.length}`)
})

await test('🔍 the initial URL is checked too, for a caller that did not', async () => {
  reset()
  routes.set('https://evil.example.com/', () => okResponse(Buffer.from('x')))
  await expectReject(
    () => fetchFollowingRedirects('https://evil.example.com/x', { isUrlAllowed: isHuggingFaceUrl }),
    /not an approved address/, 'unapproved initial URL',
  )
  assert(requested.length === 0, 'made a request for an unapproved initial URL')
})

// ===========================================================================
console.log('\n--- download: commit only on a verified checksum ---')
// ===========================================================================

function routeFile(buf, opts = {}) {
  reset()
  routes.set('https://huggingface.co/', (url, init) => {
    const range = init.headers?.Range || init.headers?.range
    if (opts.gated) return new Response(null, { status: 401 })
    if (opts.missing) return new Response(null, { status: 404 })
    if (range && !opts.ignoreRange) {
      const from = Number(/bytes=(\d+)-/.exec(range)?.[1] || 0)
      if (from >= buf.length) return new Response(null, { status: 416 })
      const slice = buf.subarray(from)
      return okResponse(slice, {
        status: 206,
        headers: { 'content-range': `bytes ${from}-${buf.length - 1}/${buf.length}` },
        stream: opts.slow ? bodyStream([slice], { delayMs: opts.slow, signal: init.signal }) : null,
      })
    }
    const chunks = opts.truncateAfter
      ? [buf.subarray(0, opts.truncateAfter)]
      : [buf]
    return okResponse(buf, {
      stream: opts.slow || opts.truncateAfter
        ? bodyStream(chunks, { delayMs: opts.slow || 0, signal: init.signal })
        : null,
    })
  })
}

await test('a verified download lands as a .gguf with no .part left behind', async () => {
  const buf = Buffer.from('GGUF-model-bytes-happy-path')
  const art = artifactFor('happy-Q4_K_M.gguf', buf)
  routeFile(buf)

  const res = await downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir })
  const dest = path.join(modelsDir, 'happy-Q4_K_M.gguf')
  assert(fs.existsSync(dest), 'final file missing')
  assert(!fs.existsSync(dest + PART_SUFFIX), '.part left behind')
  assert(fs.readFileSync(dest).equals(buf), 'content mismatch')
  assert(res.modelPath === dest, `wrong modelPath: ${res.modelPath}`)
})

await test('🔍 a checksum mismatch leaves NO file under either name', async () => {
  const buf = Buffer.from('GGUF-model-bytes-corrupt')
  const art = artifactFor('corrupt-Q4_K_M.gguf', buf)
  art.files[0].sha256 = sha256(Buffer.from('a completely different file'))
  routeFile(buf)

  await expectReject(
    () => downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir }),
    /Checksum mismatch/, 'corrupt download',
  )
  const dest = path.join(modelsDir, 'corrupt-Q4_K_M.gguf')
  assert(!fs.existsSync(dest), 'a corrupt file was renamed into place')
  assert(!fs.existsSync(dest + PART_SUFFIX), 'a corrupt .part was kept and could be "resumed" to completion')
})

await test('🔍 a size mismatch is caught even when no checksum is published', async () => {
  const buf = Buffer.from('short')
  const art = artifactFor('sizemismatch-Q4_K_M.gguf', buf)
  art.files[0].sha256 = null
  art.files[0].size = buf.length + 500 // server sends fewer bytes than advertised
  art.verifiable = false
  routeFile(buf)

  await expectReject(
    () => downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir }),
    /Size mismatch/, 'short read',
  )
  assert(!fs.existsSync(path.join(modelsDir, 'sizemismatch-Q4_K_M.gguf')), 'short file renamed into place')
})

// ===========================================================================
console.log('\n--- the fixed embedding-model artifact ---')
// ===========================================================================
// Everything above drives an artifact assembled from a Hugging Face listing at
// runtime. The embedding model is the other kind: one file, chosen by Nest,
// pinned by sha256 in embed-model.mjs, fetched on first need rather than
// picked. It goes down the SAME path, and these checks say so — a second
// downloader for the small file is exactly how "an interrupted download must
// never look like a model" stops being true in one place.
//
// `pin` is a test seam on ensureEmbedModel/hasEmbedModel: it lets the
// production code run against bytes the stub server can actually serve.
// Production never passes it.

const { EMBED_MODEL, embedModelPath, hasEmbedModel, ensureEmbedModel } =
  await import('../electron/main/embed-model.mjs')

// The real pin, with the checksum and size of whatever the stub is serving.
function pinFor(buf) {
  return { ...EMBED_MODEL, rfilename: 'embed-test.gguf', sha256: sha256(buf), size: buf.length }
}

await test('the pinned artifact names a commit, not a moving branch', () => {
  assert(/^[0-9a-f]{40}$/.test(EMBED_MODEL.revision), `revision is not a commit sha: ${EMBED_MODEL.revision}`)
  assert(/^[0-9a-f]{64}$/.test(EMBED_MODEL.sha256), `sha256 is not a hash: ${EMBED_MODEL.sha256}`)
  assert(EMBED_MODEL.size > 0, 'no pinned size')
  return EMBED_MODEL.label
})

await test('🔍 the fixed artifact lands verified, and is then recognised on disk', async () => {
  const buf = Buffer.from('GGUF-embedding-model-bytes')
  const pin = pinFor(buf)
  routeFile(buf)
  const dest = embedModelPath(modelsDir, pin)
  fs.rmSync(dest, { force: true })
  const got = await ensureEmbedModel({ modelsDir, pin })
  assert(got === dest, `landed at ${got}, expected ${dest}`)
  assert(fs.readFileSync(dest).equals(buf), 'content mismatch')
  assert(!fs.existsSync(dest + PART_SUFFIX), '.part left behind')
  assert(hasEmbedModel(modelsDir, pin), 'a complete download was not recognised')
})

await test('🔒 a corrupt embedding model yields null rather than throwing, and leaves nothing', async () => {
  const buf = Buffer.from('GGUF-embedding-model-corrupt')
  const pin = { ...pinFor(buf), sha256: sha256(Buffer.from('different bytes entirely')) }
  routeFile(buf)
  const dest = embedModelPath(modelsDir, pin)
  fs.rmSync(dest, { force: true })
  const got = await ensureEmbedModel({ modelsDir, pin })
  assert(got === null, `a hash mismatch returned ${got} instead of null`)
  assert(!fs.existsSync(dest), 'a corrupt file was renamed into place')
  assert(!hasEmbedModel(modelsDir, pin), 'hasEmbedModel accepted a file that is not there')
})

await test('🔒 a truncated download is not mistaken for a model', async () => {
  const buf = Buffer.from('GGUF-embedding-model-truncated-at-the-source')
  const pin = pinFor(buf)
  routeFile(buf, { truncateAfter: 8 })
  const dest = embedModelPath(modelsDir, pin)
  fs.rmSync(dest, { force: true })
  fs.rmSync(dest + PART_SUFFIX, { force: true })
  const got = await ensureEmbedModel({ modelsDir, pin })
  assert(got === null, 'a truncated transfer reported success')
  assert(!fs.existsSync(dest), 'a partial file was renamed into place')
})

await test('a file of the wrong size on disk is replaced, not served', async () => {
  const buf = Buffer.from('GGUF-embedding-model-wrong-size-on-disk')
  const pin = pinFor(buf)
  const dest = embedModelPath(modelsDir, pin)
  fs.rmSync(dest + PART_SUFFIX, { force: true })
  fs.writeFileSync(dest, 'far too short')
  assert(!hasEmbedModel(modelsDir, pin), 'a short file was accepted as the model')
  routeFile(buf)
  const got = await ensureEmbedModel({ modelsDir, pin })
  assert(got === dest && fs.readFileSync(dest).equals(buf), 'the stale file was not replaced')
})

await test('🔍 an already-present model is not downloaded again', async () => {
  const buf = Buffer.from('GGUF-embedding-model-already-here')
  const pin = pinFor(buf)
  fs.writeFileSync(embedModelPath(modelsDir, pin), buf)
  reset()
  routes.set('https://huggingface.co/', () => { throw new Error('should not have been requested') })
  const got = await ensureEmbedModel({ modelsDir, pin })
  assert(got === embedModelPath(modelsDir, pin), 'an existing model was not returned')
  assert(requested.length === 0, `a present model was re-fetched: ${requested.join(', ')}`)
})

// ===========================================================================
console.log('\n--- interruption, resume and cancellation ---')
// ===========================================================================

await test('🔍 an interrupted transfer leaves a resumable .part, not a model', async () => {
  const buf = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
  const art = artifactFor('resume-Q4_K_M.gguf', buf)
  const dest = path.join(modelsDir, 'resume-Q4_K_M.gguf')

  // First attempt: the connection drops after part of the body.
  //
  // The chunk is delivered on the first pull and the error raised on the
  // SECOND — enqueue-then-error in start() would not model a dropped
  // connection at all, because controller.error() resets the queue and the
  // consumer would never see the bytes.
  reset()
  let sent = false
  routes.set('https://huggingface.co/', () => okResponse(buf, {
    stream: new ReadableStream({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(buf.subarray(0, 10)); return }
        controller.error(new Error('connection reset'))
      },
    }),
    headers: { 'content-length': String(buf.length) },
  }))
  await expectReject(
    () => downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir }),
    /.*/, 'dropped connection',
  )
  assert(!fs.existsSync(dest), 'a partial transfer was presented as a model')
  assert(fs.existsSync(dest + PART_SUFFIX), 'no .part left to resume from')
  assert(fs.statSync(dest + PART_SUFFIX).size === 10, 'unexpected .part size')

  // Second attempt: resumes with a Range request and completes.
  routeFile(buf)
  await downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir })
  assert(fs.existsSync(dest), 'resume did not complete')
  assert(fs.readFileSync(dest).equals(buf), 'resumed file has wrong content — hash seeding is broken')
  assert(!fs.existsSync(dest + PART_SUFFIX), '.part left after a completed resume')
  return 'resumed from byte 10 and verified the whole file'
})

await test('🔍 a resumed download still verifies the FULL checksum', async () => {
  const buf = Buffer.from('the-quick-brown-fox-jumps-over-the-lazy-dog')
  const art = artifactFor('badresume-Q4_K_M.gguf', buf)
  const dest = path.join(modelsDir, 'badresume-Q4_K_M.gguf')
  // A .part whose bytes are the wrong length-but-plausible content. Resuming
  // must not "complete" it: the hash covers the bytes already on disk too.
  fs.writeFileSync(dest + PART_SUFFIX, Buffer.from('XXXXXXXXXX'))
  routeFile(buf)

  await expectReject(
    () => downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir }),
    /Checksum mismatch/, 'resume over corrupt partial data',
  )
  assert(!fs.existsSync(dest), 'a corrupt resume was renamed into place')
  fs.rmSync(dest + PART_SUFFIX, { force: true })
})

await test('cancelling discards the staging file', async () => {
  const buf = Buffer.from('x'.repeat(4096))
  const art = artifactFor('cancel-Q4_K_M.gguf', buf)
  const dest = path.join(modelsDir, 'cancel-Q4_K_M.gguf')
  routeFile(buf, { slow: 50 })

  const controller = new AbortController()
  const p = downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir, signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  await expectReject(() => p, /.*/, 'cancelled download')

  assert(!fs.existsSync(dest), 'a cancelled download produced a model file')
  await discardPartials(modelsDir, art)
  assert(!fs.existsSync(dest + PART_SUFFIX), 'discardPartials left the .part behind')
})

// ===========================================================================
console.log('\n--- preflight: disk, shard sets, gated repos ---')
// ===========================================================================

await test('🔍 insufficient disk space fails before the first byte is requested', async () => {
  const buf = Buffer.from('tiny')
  const art = artifactFor('huge-Q4_K_M.gguf', buf)
  // Larger than any test machine's free space.
  art.files[0].size = 900 * 1024 ** 4
  art.totalBytes = art.files[0].size
  routeFile(buf)

  await expectReject(
    () => downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir }),
    /Not enough disk space/, 'oversized artifact',
  )
  assert(requested.length === 0, `made ${requested.length} request(s) before the disk check`)
  return 'no bytes requested'
})

await test('🔍 an incomplete shard set is refused rather than half-downloaded', async () => {
  const buf = Buffer.from('shard')
  const art = {
    id: 'BF16', quantLabel: 'BF16', quantRecognized: true, shardTotal: 2,
    files: [{ rfilename: 'm-00001-of-00002.gguf', size: buf.length, sha256: sha256(buf), shardIndex: 1 }],
    totalBytes: buf.length, complete: false, verifiable: true,
  }
  routeFile(buf)

  await expectReject(
    () => downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir }),
    /missing part of its file set/, 'incomplete shard set',
  )
  assert(requested.length === 0, 'started downloading an unusable set')
})

await test('a complete shard set downloads every part and points at the first', async () => {
  const a = Buffer.from('part-one-bytes')
  const b = Buffer.from('part-two-bytes')
  const art = {
    id: 'BF16', quantLabel: 'BF16', quantRecognized: true, shardTotal: 2,
    files: [
      { rfilename: 'BF16/set-00001-of-00002.gguf', size: a.length, sha256: sha256(a), shardIndex: 1 },
      { rfilename: 'BF16/set-00002-of-00002.gguf', size: b.length, sha256: sha256(b), shardIndex: 2 },
    ],
    totalBytes: a.length + b.length, complete: true, verifiable: true,
  }
  reset()
  routes.set('https://huggingface.co/', (url) => okResponse(url.includes('00001') ? a : b))

  const res = await downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir })
  assert(fs.existsSync(path.join(modelsDir, 'set-00001-of-00002.gguf')), 'part 1 missing')
  assert(fs.existsSync(path.join(modelsDir, 'set-00002-of-00002.gguf')), 'part 2 missing')
  assert(res.modelPath.endsWith('set-00001-of-00002.gguf'), `modelPath should be the first shard: ${res.modelPath}`)
})

await test('🔍 a gated repo is refused with an explanation, not a stack trace', async () => {
  const buf = Buffer.from('never served')
  const art = artifactFor('gated-Q4_K_M.gguf', buf)
  routeFile(buf, { gated: true })

  await expectReject(
    () => downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir }),
    /requires a Hugging Face account/, 'gated repo',
  )
})

await test('a file already present is skipped rather than re-downloaded', async () => {
  const buf = Buffer.from('already-here-bytes')
  const art = artifactFor('present-Q4_K_M.gguf', buf)
  fs.writeFileSync(path.join(modelsDir, 'present-Q4_K_M.gguf'), buf)
  routeFile(buf)

  await downloadArtifact({ repoId: REPO, revision: REV, artifact: art, modelsDir })
  assert(requested.length === 0, 're-downloaded a file already on disk')
})

// ===========================================================================
console.log('\n--- catalog parsing (offline, against recorded Hub shapes) ---')
// ===========================================================================

await test('quantization is parsed out of the filename, including UD and IQ forms', () => {
  const cases = [
    ['Qwen3-30B-A3B-UD-Q3_K_XL.gguf', 'UD-Q3_K_XL'],
    ['Qwen3-30B-A3B-Q4_K_M.gguf', 'Q4_K_M'],
    ['Qwen3-30B-A3B-IQ4_XS.gguf', 'IQ4_XS'],
    ['Qwen3-Coder-30B-A3B-Instruct-UD-IQ2_M.gguf', 'UD-IQ2_M'],
    ['BF16/Qwen3-30B-A3B-BF16-00001-of-00002.gguf', 'BF16'],
    ['model-Q8_0.gguf', 'Q8_0'],
  ]
  for (const [name, want] of cases) {
    const got = parseQuant(name)
    assert(got === want, `${name}: expected ${want}, got ${got}`)
  }
})

await test('🔍 a model name starting with Q is not mistaken for a quantization', () => {
  // Q\d requires a digit immediately after the Q, so "Qwen"/"QwQ" cannot match.
  assert(parseQuant('QwQ-32B-Q6_K.gguf') === 'Q6_K', 'misparsed QwQ')
  assert(parseQuant('Qwen3-30B-A3B.gguf') === null, 'invented a quant from the model name')
})

await test('an unrecognized filename reports itself rather than guessing', () => {
  const arts = buildArtifacts([{ rfilename: 'mystery-model.gguf', size: 10, lfs: { sha256: 'ab' } }])
  assert(arts[0].quantRecognized === false, 'claimed to recognize an unknown quant')
  assert(arts[0].quantLabel === 'mystery-model.gguf', `wrong fallback label: ${arts[0].quantLabel}`)
})

await test('🔍 a split GGUF is grouped into ONE artifact of summed size', () => {
  const arts = buildArtifacts([
    { rfilename: 'BF16/m-00001-of-00002.gguf', size: 100, lfs: { sha256: 'a' } },
    { rfilename: 'BF16/m-00002-of-00002.gguf', size: 50, lfs: { sha256: 'b' } },
    { rfilename: 'm-Q4_K_M.gguf', size: 30, lfs: { sha256: 'c' } },
  ])
  assert(arts.length === 2, `expected 2 artifacts, got ${arts.length}`)
  const split = arts.find(a => a.quantLabel === 'BF16')
  assert(split.files.length === 2, 'shards were not grouped')
  assert(split.totalBytes === 150, `expected summed size 150, got ${split.totalBytes}`)
  assert(split.complete === true, 'a complete set was marked incomplete')
})

await test('🔍 a shard set missing a part is marked incomplete', () => {
  const arts = buildArtifacts([{ rfilename: 'm-00001-of-00003.gguf', size: 100, lfs: { sha256: 'a' } }])
  assert(arts[0].complete === false, 'a 1-of-3 set was marked complete')
})

await test('a file with no published checksum is marked unverifiable, not assumed good', () => {
  const arts = buildArtifacts([{ rfilename: 'm-Q4_K_M.gguf', size: 100 }])
  assert(arts[0].verifiable === false, 'claimed verifiability with no sha256')
  assert(arts[0].files[0].sha256 === null, 'invented a checksum')
})

await test('non-GGUF siblings are ignored', () => {
  const arts = buildArtifacts([
    { rfilename: '.gitattributes', size: 10 },
    { rfilename: 'README.md', size: 20 },
    { rfilename: 'm-Q4_K_M.gguf', size: 30, lfs: { sha256: 'c' } },
  ])
  assert(arts.length === 1, `expected only the GGUF, got ${arts.length}`)
})

// ===========================================================================
// Model cards — the description the Hub's JSON does not carry
// ===========================================================================
// Both fixtures are real cards, captured 2026-09-04 and trimmed to their
// openings, because the thing being tested IS the shape real cards take: the
// quantizer's opens with a badge wall and a bullet list of Colab links, the
// upstream one with a sentence about the model. A hand-written fixture would
// have been written to pass.

const cardsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const quantizerCard = fs.readFileSync(path.join(cardsDir, 'hf-card-quantizer-repo.md'), 'utf8')
const upstreamCard = fs.readFileSync(path.join(cardsDir, 'hf-card-upstream-repo.md'), 'utf8')

await test('🔍 base_model is validated as a repo id before it can reach a URL path', () => {
  // It is remote text that gets interpolated into a request path, so it is a
  // traversal primitive if trusted. Both real shapes are accepted (a string on
  // a quantizer's card, an array on an upstream one); anything else is not.
  assert(baseModelOf({ base_model: 'Qwen/Qwen3-30B-A3B' }) === 'Qwen/Qwen3-30B-A3B', 'rejected a valid string')
  assert(baseModelOf({ base_model: ['Qwen/Qwen3-30B-A3B-Base'] }) === 'Qwen/Qwen3-30B-A3B-Base', 'rejected a valid array')
  assert(baseModelOf({ base_model: '../../etc/passwd' }) === null, 'a traversal id was accepted')
  assert(baseModelOf({ base_model: 'a/b?x=1' }) === null, 'a query-bearing id was accepted')
  assert(baseModelOf({ base_model: 42 }) === null, 'a non-string was accepted')
  assert(baseModelOf({}) === null, 'invented a base model')
  assert(baseModelOf(undefined) === null, 'threw on a card with no data')
})

await test('🔍 an upstream card yields the paragraph that says what the model is', () => {
  const text = extractDescription(upstreamCard)
  assert(text, 'no description extracted from a card that plainly has one')
  assert(/^Qwen3 is the latest generation/.test(text), `wrong opening: ${text.slice(0, 80)}`)
  assert(!/^---/.test(text) && !/license:/.test(text), 'YAML frontmatter leaked into the description')
})

await test('🔍 a badge wall and a list of links never become the description', () => {
  // The quantizer's card opens with centred HTML, shield images and a bullet
  // list of Colab links. Taking "the first paragraph" literally returns that.
  const text = extractDescription(quantizerCard)
  assert(text, 'nothing extracted at all')
  assert(!/<div|<img|<a href/i.test(text), `raw HTML reached the description: ${text.slice(0, 120)}`)
  assert(!/Colab notebook here/.test(text), `a link bullet won over prose: ${text.slice(0, 120)}`)
})

await test('🔍 inline markup is stripped, so no URL or tag survives into the text', () => {
  // The common card is not laid out in HTML, it is prose with markup threaded
  // through it — real example, bartowski's: 'Using <a href=...>llama.cpp</a>
  // release <a ...>b4877</a> for quantization.'
  const md = 'Using <a href="https://github.com/ggerganov/llama.cpp/">llama.cpp</a> release <a href="https://x/y">b4877</a> for quantization of this model.\n'
  const text = extractDescription(md)
  assert(text, 'nothing extracted')
  assert(!/<a |href=|https?:\/\//.test(text), `markup survived: ${text}`)
  assert(/Using llama.cpp release b4877/.test(text), `the label text was lost too: ${text}`)
})

await test('🔍 a de-linked heading stub loses to a real sentence further down', () => {
  // 'Model Page: Gemma  Resources and Technical Documentation:' passes every
  // structural filter and is still not a description. A sentence terminator is
  // what separates it from one.
  const md = '**Model Page**: [Gemma](https://ai.google.dev/gemma/docs/core)\n**Resources and Technical Documentation**: [docs](https://example.com/documentation/here)\n\nGemma is a family of lightweight, state-of-the-art open models from Google.\n'
  const text = extractDescription(md)
  assert(/^Gemma is a family/.test(text), `the link stub won: ${text.slice(0, 90)}`)
})

await test('a card whose only prose has no full stop still returns it', () => {
  // The sentence rule is a preference, not a gate — a card with no terminator
  // anywhere must not come back empty.
  const md = '# M\n\nA compact multilingual embedding model for offline semantic search\n'
  const text = extractDescription(md)
  assert(text && /compact multilingual embedding model/.test(text), `preference became a gate: ${text}`)
})

await test('a list-only card still describes itself rather than returning nothing', () => {
  // Lists are held back, not discarded — a card with no prose at all has to
  // fall back to them or the model has no description.
  const listOnly = '---\nlicense: mit\n---\n\n# Thing\n\n- A compact model for summarising long documents offline.\n- Trained on public data only.\n'
  const text = extractDescription(listOnly)
  assert(text && /summarising long documents/.test(text), `list fallback did not fire: ${text}`)
})

await test('🔍 an unterminated leading --- is a horizontal rule, not frontmatter', () => {
  // Eating the rest of the file on an unclosed delimiter is silent data loss.
  const md = '---\n\nA small instruction-tuned model for local assistants and offline drafting work.\n'
  const text = extractDescription(md)
  assert(text && /small instruction-tuned model/.test(text), `body was swallowed: ${text}`)
})

await test('code fences are not mistaken for prose', () => {
  const md = '# M\n\n```python\nfrom transformers import AutoModel  # this is a long enough line to pass the filter\n```\n\nA retrieval model for semantic search over technical documentation.\n'
  const text = extractDescription(md)
  assert(!/AutoModel/.test(text), `code leaked into the description: ${text}`)
  assert(/retrieval model/.test(text), 'the prose after the fence was lost')
})

await test('the description is capped, and cut at a paragraph rather than mid-sentence', () => {
  const para = 'This paragraph is comfortably longer than the forty character floor the extractor uses. '
  const text = extractDescription(`${para}\n\n${para}\n\n${para}`, { maxChars: 120 })
  assert(text.length <= 120, `cap exceeded: ${text.length}`)
  assert(!text.includes('\n\n'), 'took a second paragraph past the cap')
})

await test('a card with nothing usable returns null rather than an empty string', () => {
  assert(extractDescription('---\nlicense: mit\n---\n\n<div><img src="x"></div>\n') === null, 'invented a description')
  assert(extractDescription('') === null, 'invented a description from nothing')
  assert(extractDescription(null) === null, 'threw on a missing card')
})

// ---------------------------------------------------------------------------

fs.rmSync(base, { recursive: true, force: true })

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
