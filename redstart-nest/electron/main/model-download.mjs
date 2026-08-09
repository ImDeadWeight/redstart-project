// =============================================================================
// GGUF model downloader — Hugging Face artifacts into the Redstart models folder.
// =============================================================================
// This is the only place in Redstart that writes multi-gigabyte files fetched
// from the internet, so it is written around the ways that goes wrong rather
// than around the happy path:
//
//   - Every redirect hop is re-validated (shared walk, ./http-redirects.mjs).
//     A download leaves huggingface.co for a regional CDN, so "one allowed
//     host" is not expressible; the hf.co registrable domain is.
//   - The destination name is an UNTRUSTED remote string. It goes through
//     resolveWithinRoot() and is flattened to a basename.
//   - Bytes land in `<name>.part` and are renamed only after sha256 matches.
//     An interrupted download must never be indistinguishable from a model.
//   - The hash is computed DURING the stream. A second pass over 18 GB to
//     verify is not a thing anyone will wait for.
//   - Free disk is checked before the first byte, not discovered at 94%.
//
// Downloads are sequential and one at a time. Two concurrent multi-gigabyte
// transfers to one disk are slower than one and multiply the failure modes.
//
// Guarded by scripts/test-model-download.mjs, which drives all of the above
// against a local stub server with no network access.
// =============================================================================

import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { once } from 'events'

import { fetchFollowingRedirects } from './http-redirects.mjs'
import { resolveWithinRoot } from './path-scope.mjs'
import { isHuggingFaceUrl, buildDownloadUrl } from './hf-catalog.mjs'

const USER_AGENT = 'Redstart/1.0 (local AI assistant)'
// Applies to establishing the response only. It is deliberately NOT applied to
// the body: a 20 GB transfer legitimately outlives any request timeout, and a
// signal that fires mid-body would corrupt an otherwise healthy download.
const CONNECT_TIMEOUT_MS = 30000
// Headroom over the artifact size so a download cannot fill the volume to zero.
const DISK_HEADROOM_BYTES = 1024 * 1024 * 1024

export const PART_SUFFIX = '.part'

// ---------------------------------------------------------------------------
// Destination naming
// ---------------------------------------------------------------------------
// `rfilename` arrives from the Hub and legitimately contains '/'
// (`BF16/model-00001-of-00002.gguf`). That makes it a path-traversal primitive
// aimed at the models folder, so it is flattened to its basename and then
// contained — recreating the Hub's folder tree buys nothing and widens the
// surface. Shard members keep their distinct `-00001-of-00002` names, so
// flattening cannot collide within a set.
export function destinationFor(modelsDir, rfilename) {
  if (typeof rfilename !== 'string' || !rfilename.trim()) {
    throw new Error('Missing file name')
  }
  // Split on both separators: a Windows-style name from a remote source must
  // not survive as a directory component.
  const base = rfilename.split(/[/\\]/).pop()
  if (!base || base === '.' || base === '..') throw new Error('Invalid file name')
  if (!base.toLowerCase().endsWith('.gguf')) {
    throw new Error(`Refusing to download a non-GGUF file: ${base.slice(0, 80)}`)
  }
  // Contained even though the basename should already be safe — this is the
  // check that survives a future edit to the flattening above.
  return resolveWithinRoot(modelsDir, base)
}

// ---------------------------------------------------------------------------
// Disk space
// ---------------------------------------------------------------------------

export async function diskSpaceFor(dir) {
  const stat = await fsp.statfs(dir)
  return {
    freeBytes: stat.bavail * stat.bsize,
    totalBytes: stat.blocks * stat.bsize,
  }
}

// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------

async function sizeOrZero(p) {
  try { return (await fsp.stat(p)).size } catch { return 0 }
}

// Seeds a hash with the bytes already on disk so a resumed transfer can still
// verify the whole file without re-reading it at the end.
async function hashExistingPart(partPath) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(partPath)) hash.update(chunk)
  return hash
}

async function downloadFile({ url, destPath, expectedSha256, expectedSize, signal, onChunk }) {
  const partPath = destPath + PART_SUFFIX

  // Resume: if a .part is already here, ask for the remainder. The server may
  // ignore Range and send 200 with the whole body, which is handled below.
  let resumeFrom = await sizeOrZero(partPath)
  // A .part at or past the expected size is not a resume point — it is a stale
  // or corrupt remnant. Start over rather than verify a file we cannot explain.
  if (expectedSize && resumeFrom >= expectedSize) {
    await fsp.rm(partPath, { force: true })
    resumeFrom = 0
  }

  const headers = { 'User-Agent': USER_AGENT }
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`

  // The connect timeout bounds establishing the response only — see the
  // constant. AbortSignal.any rejects undefined members, so the caller's signal
  // is included only when there is one.
  const connectSignal = AbortSignal.any(
    [signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)].filter(Boolean),
  )

  const { response } = await fetchFollowingRedirects(url, {
    isUrlAllowed: isHuggingFaceUrl,
    headers,
    signal: connectSignal,
  })

  if (response.status === 401 || response.status === 403) {
    throw new Error('This model requires a Hugging Face account. Redstart cannot download gated models.')
  }
  if (response.status === 404) {
    throw new Error('The file is no longer available at this revision.')
  }
  if (response.status === 416) {
    // Range not satisfiable — the .part disagrees with the server about the
    // file. Discard it; the next attempt starts clean.
    await fsp.rm(partPath, { force: true })
    throw new Error('The partial download no longer matches the file on the server. Retry to start over.')
  }
  if (!response.ok) throw new Error(`Hugging Face returned HTTP ${response.status}`)
  if (!response.body) throw new Error('Empty response from Hugging Face')

  // Honour the server's answer, not our request: 206 means the Range was
  // accepted, anything else means we are receiving the file from byte zero.
  const resumed = response.status === 206
  if (resumeFrom > 0 && !resumed) resumeFrom = 0

  const hash = resumed && resumeFrom > 0 ? await hashExistingPart(partPath) : createHash('sha256')

  let received = resumeFrom
  const out = fs.createWriteStream(partPath, resumed && resumeFrom > 0 ? { flags: 'a' } : { flags: 'w' })

  // Read the web stream DIRECTLY, and write by hand. Two things go wrong with
  // the obvious `pipeline(Readable.fromWeb(body), out)`, and both silently
  // destroy resumability:
  //
  //   - stream.pipeline DESTROYS the destination when the source errors,
  //     discarding whatever the write stream had buffered.
  //   - Readable.fromWeb reads ahead into its own buffer and drops it on error,
  //     so chunks that already arrived never reach the consumer at all.
  //
  // Together those turn a connection dropped near the end of an 18 GB transfer
  // into a 0-byte .part, making the "resume" below a full restart. Reading the
  // reader directly delivers each chunk as it arrives, and the finally ends the
  // write stream cleanly so every received byte is on disk before the error
  // propagates — which is the entire reason a .part is kept.
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) throw new Error('Download cancelled')
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      hash.update(chunk)
      received += chunk.length
      onChunk?.(received)
      if (!out.write(chunk)) await once(out, 'drain')
    }
  } finally {
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())))
  }

  if (expectedSize && received !== expectedSize) {
    throw new Error(`Size mismatch: expected ${expectedSize} bytes, got ${received}`)
  }

  if (expectedSha256) {
    const actual = hash.digest('hex')
    if (actual !== expectedSha256.toLowerCase()) {
      // A file that fails its checksum is not kept under any name — leaving the
      // .part would let a later resume "complete" a corrupt download.
      await fsp.rm(partPath, { force: true })
      throw new Error('Checksum mismatch — the downloaded file is corrupt and has been discarded.')
    }
  }

  // fsync before the rename, for the same reason json-store.mjs does it on a
  // 2 KB config file: out.end() only hands the bytes to the OS. Without the
  // flush, a power loss between the rename and the writeback leaves a file
  // named like a complete, checksum-verified model that is short or zero-filled
  // — the one outcome the .part staging exists to prevent, and the one the
  // checksum cannot catch because it was computed from what we SENT, not from
  // what reached the platter. Cheap next to an 18 GB transfer.
  const fh = await fsp.open(partPath, 'r+')
  try { await fh.sync() } finally { await fh.close() }

  // The rename is the commit. Everything before this point is a .part.
  await fsp.rename(partPath, destPath)
  return { bytes: received, verified: !!expectedSha256 }
}

// ---------------------------------------------------------------------------
// One artifact (which may be several files)
// ---------------------------------------------------------------------------

/**
 * Download every file of an artifact into `modelsDir`.
 *
 * `artifact` is a buildArtifacts() entry: { quantLabel, files[], totalBytes,
 * complete }. An incomplete shard set is refused rather than half-downloaded.
 *
 * onProgress receives a snapshot suitable for direct display; it is throttled
 * by the caller (ipc/models.mjs), not here.
 */
export async function downloadArtifact({
  repoId, revision, artifact, modelsDir, signal, onProgress,
}) {
  if (!artifact?.files?.length) throw new Error('Nothing to download')
  if (artifact.complete === false) {
    throw new Error('This quantization is missing part of its file set on Hugging Face and cannot be assembled.')
  }

  await fsp.mkdir(modelsDir, { recursive: true })

  // Resolve every destination BEFORE fetching anything, so a containment
  // failure on the last shard cannot happen after 40 GB has been written.
  const targets = artifact.files.map(f => ({
    ...f,
    destPath: destinationFor(modelsDir, f.rfilename),
    url: buildDownloadUrl(repoId, revision, f.rfilename),
  }))

  // Disk check against what is still outstanding: files already downloaded, and
  // the bytes already sitting in a .part, do not need to be paid for twice.
  let outstanding = 0
  for (const t of targets) {
    if (fs.existsSync(t.destPath)) continue
    outstanding += Math.max(0, (t.size || 0) - await sizeOrZero(t.destPath + PART_SUFFIX))
  }
  if (outstanding > 0) {
    const { freeBytes } = await diskSpaceFor(modelsDir)
    if (freeBytes < outstanding + DISK_HEADROOM_BYTES) {
      throw new Error(
        `Not enough disk space: ${fmtGb(outstanding)} needed, ${fmtGb(freeBytes)} free on that drive.`,
      )
    }
  }

  const totalBytes = artifact.totalBytes ?? targets.reduce((a, t) => a + (t.size || 0), 0)
  // Bytes accounted for by files finished in earlier iterations, so the overall
  // percentage does not restart at each shard.
  let completedBytes = 0
  const results = []

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]

    if (fs.existsSync(t.destPath)) {
      completedBytes += t.size || 0
      results.push({ rfilename: t.rfilename, destPath: t.destPath, skipped: true })
      onProgress?.({ fileIndex: i, fileCount: targets.length, receivedBytes: completedBytes, totalBytes, state: 'skipped' })
      continue
    }

    const started = Date.now()
    const res = await downloadFile({
      url: t.url,
      destPath: t.destPath,
      expectedSha256: t.sha256,
      expectedSize: t.size,
      signal,
      onChunk: (fileReceived) => {
        const elapsed = (Date.now() - started) / 1000
        onProgress?.({
          fileIndex: i,
          fileCount: targets.length,
          receivedBytes: completedBytes + fileReceived,
          totalBytes,
          bytesPerSec: elapsed > 0 ? Math.round(fileReceived / elapsed) : 0,
          state: 'downloading',
        })
      },
    })
    completedBytes += res.bytes
    results.push({ rfilename: t.rfilename, destPath: t.destPath, ...res })
  }

  return {
    repoId,
    revision,
    quantLabel: artifact.quantLabel,
    files: results,
    // The path to hand the user — the first shard is what llama-server is
    // pointed at; it finds the rest of the set itself.
    modelPath: results[0].destPath,
    totalBytes: completedBytes,
  }
}

function fmtGb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

// Remove the staging file for an artifact — used when the user cancels, where
// keeping a .part would silently consume disk for a download they abandoned.
// A network FAILURE deliberately leaves the .part so a retry can resume.
export async function discardPartials(modelsDir, artifact) {
  const removed = []
  for (const f of artifact?.files || []) {
    try {
      const p = destinationFor(modelsDir, f.rfilename) + PART_SUFFIX
      if (fs.existsSync(p)) { await fsp.rm(p, { force: true }); removed.push(p) }
    } catch { /* an unresolvable name has nothing to clean up */ }
  }
  return removed
}
