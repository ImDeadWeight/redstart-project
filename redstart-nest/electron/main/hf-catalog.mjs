// =============================================================================
// Hugging Face catalog client — model discovery for the Models tab.
// =============================================================================
// Pure: no filesystem, no downloads, no Electron. Everything here is either an
// HTTPS GET against the Hub's public JSON API or a string transform on what it
// returned, which is what lets scripts/test-model-download.mjs drive the
// parsing against recorded fixtures with no network.
//
// The Hub is treated as a CATALOG, not as an architectural dependency: it
// answers "what GGUF files exist and how big are they", and nothing else in
// Redstart learns that Hugging Face exists.
//
// Verified against the live API 2026-08-08 (unsloth/Qwen3-30B-A3B-GGUF).
// =============================================================================

import { fetchFollowingRedirects } from './http-redirects.mjs'

const API_ORIGIN = 'https://huggingface.co'
const USER_AGENT = 'Redstart/1.0 (local AI assistant)'
const API_TIMEOUT_MS = 15000

// Publishers whose GGUF conversions the project already recommends in the
// README. The Models tab opens on these rather than on an empty search box:
// raw Hub search returns a large number of abandoned and mislabeled repos, and
// "which uploader can you trust" is exactly the knowledge a generic search box
// throws away. Search is still available, this is only the default view.
export const TRUSTED_PUBLISHERS = [
  { id: 'unsloth', label: 'Unsloth', note: 'Dynamic (UD) quants — better quality at the same size' },
  { id: 'bartowski', label: 'bartowski', note: 'Broad model coverage, imatrix quants' },
  { id: 'ggml-org', label: 'ggml-org', note: 'From the llama.cpp maintainers' },
]

// ---------------------------------------------------------------------------
// Host policy
// ---------------------------------------------------------------------------
// Both the API and the file downloads are pinned to Hugging Face. This is NOT
// a general-purpose URL fetcher and must never become one: the user picks from
// search results, never types a URL.
//
// Downloads redirect off the main site to a regional CDN — observed
// 2026-08-08, huggingface.co/{repo}/resolve/{sha}/{file} 302s to
// us.aws.cdn.hf.co. The regional prefix varies by caller location, so the CDN
// is matched on the hf.co registrable domain rather than on one hostname.
//
// Suffix checks are anchored with a leading dot so `evilhf.co` cannot pass as
// `hf.co`.
const ALLOWED_HOSTS = ['huggingface.co', 'hf.co']

export function isHuggingFaceUrl(url) {
  let target
  try { target = new URL(url) } catch { return false }
  if (target.protocol !== 'https:') return false
  const host = target.hostname.toLowerCase()
  return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h))
}

// ---------------------------------------------------------------------------
// Repo id validation
// ---------------------------------------------------------------------------
// The id is interpolated into a URL PATH, so without this it is a traversal
// primitive: `a/../../b` or an id carrying `?`/`#` would reshape the request.
// Hub ids are `owner/name` with a conservative character set.
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isValidRepoId(repoId) {
  return typeof repoId === 'string' &&
    repoId.length <= 200 &&
    REPO_ID_RE.test(repoId) &&
    // Belt and braces: the character class already excludes '/', so a segment
    // cannot be '..', but assert it rather than reasoning about it.
    !repoId.split('/').some(seg => seg === '.' || seg === '..')
}

function assertValidRepoId(repoId) {
  if (!isValidRepoId(repoId)) throw new Error(`Invalid model id: ${String(repoId).slice(0, 80)}`)
}

// A revision is a git sha or a branch/tag name; it also lands in the URL path.
const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isValidRevision(rev) {
  return typeof rev === 'string' && rev.length <= 100 && REVISION_RE.test(rev) && rev !== '.' && rev !== '..'
}

// ---------------------------------------------------------------------------
// Quantization parsing
// ---------------------------------------------------------------------------
// The Hub has NO structured quant field. It lives in the filename, or in a
// folder prefix (`BF16/model.gguf`), so this is pattern matching with all the
// fragility that implies — an unrecognized name surfaces the raw filename
// rather than a guess, because a wrong quant label on an 18 GB download is
// worse than no label.
//
//   Qwen3-30B-A3B-UD-Q3_K_XL.gguf          -> UD-Q3_K_XL
//   Qwen3-30B-A3B-Q4_K_M.gguf              -> Q4_K_M
//   Qwen3-30B-A3B-IQ4_XS.gguf              -> IQ4_XS
//   BF16/Qwen3-30B-A3B-BF16-00001-of-2.gguf-> BF16
//
// `Q\d` requires a digit immediately after the Q, so a model NAME beginning
// with Q (Qwen, QwQ) cannot be mistaken for a quant.
const QUANT_RE = /(?:^|[-_/.])((?:UD-)?(?:IQ\d+(?:_[A-Z]+)*|Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32))(?=[-_./]|$)/gi

export function parseQuant(rfilename) {
  if (typeof rfilename !== 'string') return null
  // Strip the shard suffix first so `-00001-of-00002` can never be read as
  // part of a quant token.
  const withoutShard = rfilename.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, '')
  const matches = [...withoutShard.matchAll(QUANT_RE)]
  if (!matches.length) return null
  // Last match wins. Quant normally trails the model name; when it is instead a
  // folder prefix the same token is repeated in the filename, so the last match
  // is correct either way.
  return matches[matches.length - 1][1].toUpperCase()
}

// ---------------------------------------------------------------------------
// Shard grouping
// ---------------------------------------------------------------------------
// A split GGUF is ONE artifact. Downloading part 1 of 2 produces a file that
// llama-server cannot load, so the set is the unit of choice and of transfer —
// modelling these as independent files is how a browser ships a broken model.
const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i

export function shardKey(rfilename) {
  const m = SHARD_RE.exec(rfilename)
  if (!m) return null
  return { base: m[1], index: Number(m[2]), total: Number(m[3]) }
}

// ---------------------------------------------------------------------------
// API access
// ---------------------------------------------------------------------------

async function apiGet(pathAndQuery) {
  const url = `${API_ORIGIN}${pathAndQuery}`
  const { response } = await fetchFollowingRedirects(url, {
    isUrlAllowed: isHuggingFaceUrl,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('This model requires a Hugging Face account to access.')
  }
  if (response.status === 404) throw new Error('Model not found on Hugging Face.')
  if (!response.ok) throw new Error(`Hugging Face returned HTTP ${response.status}`)
  return response.json()
}

// Search, or list a publisher when `publisher` is set and `query` is empty.
// Returns the light shape — the Hub omits file sizes here, so the tab shows
// which quants exist and fetches sizes only when a model is opened.
export async function searchModels({ query = '', publisher = '', limit = 24 } = {}) {
  const params = new URLSearchParams({
    filter: 'gguf',
    sort: 'downloads',
    direction: '-1',
    limit: String(Math.min(Math.max(1, Number(limit) || 24), 100)),
    // Counterintuitive but verified 2026-08-08: OMITTING `full` returns LESS
    // than full=false. Without it the response carries no `siblings` (so no
    // quant list), no `author` and no `gated` flag. full=false is the shape
    // this function needs; full=true adds card data we do not use.
    full: 'false',
  })
  if (query.trim()) params.set('search', query.trim())
  if (publisher.trim()) params.set('author', publisher.trim())

  const raw = await apiGet(`/api/models?${params}`)
  if (!Array.isArray(raw)) return []

  return raw.filter(m => isValidRepoId(m?.id)).map(m => {
    const ggufFiles = (m.siblings || [])
      .map(s => s?.rfilename)
      .filter(f => typeof f === 'string' && f.toLowerCase().endsWith('.gguf'))
    // Distinct quant labels, so a row can say "Q3_K_XL, Q4_K_M, Q8_0" without
    // the caller re-deriving it.
    const quants = [...new Set(ggufFiles.map(parseQuant).filter(Boolean))]
    return {
      repoId: m.id,
      author: m.author || m.id.split('/')[0],
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      lastModified: m.lastModified || null,
      gated: !!m.gated,
      quants,
      ggufFileCount: ggufFiles.length,
    }
  })
}

// Full detail for one model, including per-file sizes and sha256 checksums.
// `?blobs=true` is what adds `siblings[].size` and `siblings[].lfs.sha256` —
// without it the response carries filenames only.
export async function getModelDetail(repoId) {
  assertValidRepoId(repoId)
  const raw = await apiGet(`/api/models/${repoId}?blobs=true`)

  const license = (raw.tags || [])
    .find(t => typeof t === 'string' && t.startsWith('license:'))
    ?.slice('license:'.length) || null

  return {
    repoId: raw.id || repoId,
    author: raw.author || String(repoId).split('/')[0],
    // The revision every download for this model must be pinned to. Without it
    // a repo updated mid-transfer yields files from two different revisions.
    revision: raw.sha || null,
    gated: !!raw.gated,
    downloads: raw.downloads || 0,
    likes: raw.likes || 0,
    license,
    lastModified: raw.lastModified || null,
    // gguf.* is the Hub's own parse of the GGUF header — structured, not
    // guessed from the filename.
    architecture: raw.gguf?.architecture || raw.config?.model_type || null,
    paramCount: typeof raw.gguf?.total === 'number' ? raw.gguf.total : null,
    contextLength: typeof raw.gguf?.context_length === 'number' ? raw.gguf.context_length : null,
    chatTemplate: raw.gguf?.chat_template || null,
    // MoE models are the reason a 35B runs on a 12 GB card at all, so active
    // params — not total — is the number that predicts speed. Present only for
    // MoE architectures.
    experts: typeof raw.config?.num_experts === 'number'
      ? { total: raw.config.num_experts, active: raw.config.num_experts_per_tok ?? null }
      : null,
    artifacts: buildArtifacts(raw.siblings || []),
  }
}

// Collapse the sibling list into selectable artifacts: one per quant, with
// shard sets folded into a single multi-file entry.
export function buildArtifacts(siblings) {
  const groups = new Map()

  for (const s of siblings) {
    const rfilename = s?.rfilename
    if (typeof rfilename !== 'string' || !rfilename.toLowerCase().endsWith('.gguf')) continue

    const shard = shardKey(rfilename)
    // Group by the shard base when split, otherwise by the file's own path, so
    // two quants never merge and one quant never splits into two rows.
    const key = shard ? shard.base : rfilename
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        quantLabel: parseQuant(rfilename) || rfilename.split('/').pop(),
        quantRecognized: parseQuant(rfilename) !== null,
        files: [],
        shardTotal: shard ? shard.total : 1,
      })
    }
    const g = groups.get(key)
    g.files.push({
      rfilename,
      size: typeof s.size === 'number' ? s.size : (s.lfs?.size ?? null),
      // Present for LFS-backed files, which every GGUF of consequence is.
      // Null means "no checksum published" — recorded rather than silently
      // treated as verified.
      sha256: s.lfs?.sha256 || null,
      shardIndex: shard ? shard.index : null,
    })
  }

  return [...groups.values()].map(g => {
    g.files.sort((a, b) => (a.shardIndex ?? 0) - (b.shardIndex ?? 0))
    const sizes = g.files.map(f => f.size)
    return {
      ...g,
      // Sum the parts. gguf.totalFileSize from the API is NOT this number —
      // it reported 17.3 GB for a repo whose BF16 set alone is 61 GB.
      totalBytes: sizes.every(n => typeof n === 'number') ? sizes.reduce((a, b) => a + b, 0) : null,
      // A set missing a part cannot be downloaded into something loadable.
      complete: g.files.length === g.shardTotal,
      verifiable: g.files.every(f => !!f.sha256),
    }
  }).sort((a, b) => (a.totalBytes ?? Infinity) - (b.totalBytes ?? Infinity))
}

// The pinned, revision-locked URL for one file.
export function buildDownloadUrl(repoId, revision, rfilename) {
  assertValidRepoId(repoId)
  if (!isValidRevision(revision)) throw new Error(`Invalid revision: ${String(revision).slice(0, 80)}`)
  if (typeof rfilename !== 'string' || !rfilename) throw new Error('Missing file name')
  // rfilename comes from the Hub and legitimately contains '/'. Encode each
  // segment so a name cannot inject query or fragment syntax into the URL; the
  // filesystem side of the same untrusted string is contained separately, in
  // model-download.mjs.
  const encoded = rfilename.split('/').map(encodeURIComponent).join('/')
  return `${API_ORIGIN}/${repoId}/resolve/${revision}/${encoded}`
}
