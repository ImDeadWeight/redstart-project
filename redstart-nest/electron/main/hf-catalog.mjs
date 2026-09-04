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
    // What the model is FOR, as the Hub classifies it ('text-generation',
    // 'text-to-image', …). Structured and cheap; the prose that explains the
    // same thing costs a second request (getModelCard).
    pipelineTag: typeof raw.pipeline_tag === 'string' ? raw.pipeline_tag : null,
    // The repo this one was quantized FROM. See baseModelOf() — this is the
    // pointer that makes a useful description reachable at all.
    baseModel: baseModelOf(raw.cardData),
    artifacts: buildArtifacts(raw.siblings || []),
  }
}

// ---------------------------------------------------------------------------
// Model cards — the prose the API does not have
// ---------------------------------------------------------------------------
// Verified against the live API 2026-09-04: the Hub's model JSON has NO
// description field of any kind. `/api/models/{id}` returns `cardData` (the
// README's YAML frontmatter — license, tags, base_model, language) without
// asking for `full=true`, and nothing else resembling prose. The description
// lives in README.md, which is an ordinary file in the repo and is fetched the
// same revision-pinned way a GGUF is.
//
// AND THE OBVIOUS README IS THE WRONG ONE. Checked the same day against
// unsloth/Qwen3-30B-A3B-GGUF: 20 KB of quantizer marketing — Colab banners,
// Discord badges, fine-tuning tables — and not one sentence about what the
// model does. Its `cardData.base_model` points at Qwen/Qwen3-30B-A3B, whose
// card opens with "Qwen3 Highlights" and a Model Overview listing parameters,
// layers, experts and native context length. That is the difference between a
// GGUF repo and a model repo: the first documents a CONVERSION, the second
// documents the MODEL. Prefer the upstream card and fall back to the local one.
//
// `base_model` arrives as a string on a quantizer's card and as an array on an
// upstream one, and it is REMOTE TEXT that this module then interpolates into a
// URL path — exactly the traversal primitive isValidRepoId() exists to stop. It
// is validated here for that reason and not as a formality.

export function baseModelOf(cardData) {
  const raw = cardData?.base_model
  const first = Array.isArray(raw) ? raw[0] : raw
  return isValidRepoId(first) ? first : null
}

// A card is a README written by whoever owns the repo. It is UNTRUSTED TEXT and
// is treated as data everywhere downstream: capped here so a pathological repo
// cannot stream megabytes into the app, never rendered as HTML, and — when it
// eventually feeds a model — quoted as material, never as instructions.
export const MAX_CARD_BYTES = 128 * 1024

export async function getModelCard(repoId, revision = 'main') {
  assertValidRepoId(repoId)
  if (!isValidRevision(revision)) throw new Error(`Invalid revision: ${String(revision).slice(0, 80)}`)

  // /raw/ serves the file itself; /resolve/ would redirect an LFS pointer to a
  // CDN. A README is never LFS-backed, but /raw/ says what is meant.
  const url = `${API_ORIGIN}/${repoId}/raw/${revision}/README.md`
  const { response } = await fetchFollowingRedirects(url, {
    isUrlAllowed: isHuggingFaceUrl,
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  // A repo with no README is ordinary, not an error — say so and let the
  // caller fall back rather than throwing through a description lookup.
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Hugging Face returned HTTP ${response.status}`)

  const text = await response.text()
  const truncated = Buffer.byteLength(text, 'utf8') > MAX_CARD_BYTES
  return {
    repoId,
    markdown: truncated ? Buffer.from(text, 'utf8').subarray(0, MAX_CARD_BYTES).toString('utf8') : text,
    truncated,
  }
}

// ---------------------------------------------------------------------------
// Card -> description
// ---------------------------------------------------------------------------
// Pure string work, so the whole extraction is testable against recorded cards
// with no network — the same property that makes the rest of this module
// testable.
//
// Model cards are markdown written for a web page, and the top of one is almost
// never prose: YAML frontmatter, then a wall of centred HTML, shield badges and
// linked logos. Everything below strips a KNOWN NON-PROSE FORM rather than
// trying to recognise prose, because the failure directions are not equal — a
// dropped paragraph costs a sentence of context, while a kept `<img>` wall
// costs the entire description.

function stripFrontmatter(markdown) {
  // Only at position 0, and only closed. An unterminated '---' is a horizontal
  // rule in the body, not a frontmatter block, and eating the rest of the file
  // on that basis would be silent data loss.
  if (!markdown.startsWith('---')) return markdown
  const end = markdown.indexOf('\n---', 3)
  if (end === -1) return markdown
  const after = markdown.indexOf('\n', end + 1)
  return after === -1 ? '' : markdown.slice(after + 1)
}

const NON_PROSE_LINE = [
  /^\s*<[^>]/,                    // an HTML tag opening the line (badge walls, <div> layout)
  /^\s*\|/,                       // a table row
  /^\s*[-*+]?\s*!?\[[^\]]*\]\([^)]*\)\s*$/, // a line that is only a link or an image
  /^\s*[-:|\s]+$/,                // a table rule, or a horizontal rule
  /^\s*```/,                      // a fence — code is not a description
]

const LIST_LINE = /^\s{0,3}([-*+]|\d+[.)])\s/

// Line-level filters catch a card that is LAID OUT in HTML; this catches the
// far more common card that is prose with markup threaded through it —
// bartowski's opens "Using <a href=...>llama.cpp</a> release <a ...>b4877</a>".
// A URL is not information to a reader or to a model that will be asked to
// summarise this, so links collapse to their text and everything else goes.
function stripInlineMarkup(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')      // images: no text worth keeping
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // links: keep the label, drop the URL
    .replace(/<[^>]+>/g, ' ')                   // inline HTML tags
    .replace(/[*_`]{1,3}/g, '')                 // emphasis and inline code marks
    .replace(/\s+/g, ' ')
    .trim()
}

// A description is made of sentences. "**Model Page**: Gemma **Resources and
// Technical Documentation**:" survives every filter above and is still not a
// description — it is a link list with the links taken out. Requiring a
// sentence terminator is the cheapest thing that separates the two, and it is
// applied as a PREFERENCE rather than a rule so a card whose summary genuinely
// has no full stop still produces something.
const HAS_SENTENCE = /[.!?]["')\]]?(\s|$)/

export function extractDescription(markdown, { maxChars = 1200 } = {}) {
  if (typeof markdown !== 'string' || !markdown.trim()) return null

  const lines = stripFrontmatter(markdown).split(/\r?\n/)
  const kept = []       // prose only
  const keptAny = []    // prose + lists, the fallback
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    // Headings are dropped as text but end the paragraph before them, so
    // "# Qwen3-30B-A3B" does not glue the title onto the first sentence.
    if (/^\s*#{1,6}\s/.test(line)) { kept.push(''); keptAny.push(''); continue }
    if (NON_PROSE_LINE.some(re => re.test(line))) { kept.push(''); keptAny.push(''); continue }
    // A bullet list is held back rather than dropped. A quantizer's card
    // usually opens with one ("Fine-tune X for free using our Colab
    // notebook!"), which reads as a paragraph once joined and would otherwise
    // beat the real prose further down purely by being first. But a card that
    // is ONLY a list still has to describe something, so the list survives as
    // the fallback pass rather than being discarded.
    if (LIST_LINE.test(line)) { kept.push(''); keptAny.push(line); continue }
    kept.push(line)
    keptAny.push(line)
  }

  // Paragraphs, in order, until the budget is spent. Taking whole paragraphs
  // rather than a character slice is what keeps the result readable — and a
  // model card's first real paragraph is reliably the summary.
  const toParagraphs = source => source.join('\n').split(/\n\s*\n/)
    .map(p => stripInlineMarkup(p))
    // Two words is not a paragraph; it is a stray caption the filters missed.
    // Measured AFTER stripping, so a line that was only markup cannot qualify
    // on the length of its own URLs.
    .filter(p => p.length > 40)

  // Four tiers, best first. Each is a real card shape seen on the Hub, and the
  // fallback chain is what stops a strict rule from returning nothing at all.
  const prose = toParagraphs(kept)
  const all = toParagraphs(keptAny)
  const paragraphs =
    prose.filter(p => HAS_SENTENCE.test(p)).length ? prose.filter(p => HAS_SENTENCE.test(p)) :
    prose.length ? prose :
    all.filter(p => HAS_SENTENCE.test(p)).length ? all.filter(p => HAS_SENTENCE.test(p)) :
    all

  if (paragraphs.length === 0) return null

  const out = []
  let total = 0
  for (const p of paragraphs) {
    if (total + p.length > maxChars && out.length > 0) break
    out.push(p)
    total += p.length
    if (total >= maxChars) break
  }
  return out.join('\n\n').slice(0, maxChars)
}

// The whole lookup: prefer the upstream model's card, fall back to this repo's.
// `source` is returned because which card answered is real information — a
// description from the quantizer's own README is worth less than one from the
// model's authors, and a caller that shows it should be able to say which.
export async function getModelDescription(repoId, { detail = null } = {}) {
  assertValidRepoId(repoId)
  const info = detail ?? await getModelDetail(repoId)

  const candidates = []
  if (info.baseModel && info.baseModel !== repoId) {
    candidates.push({ id: info.baseModel, source: 'base_model', revision: 'main' })
  }
  candidates.push({ id: repoId, source: 'repo', revision: info.revision || 'main' })

  for (const candidate of candidates) {
    let card
    // An upstream repo can be gated, renamed or deleted long after a
    // quantization of it was published. That is a reason to fall back, never a
    // reason to fail the lookup.
    try { card = await getModelCard(candidate.id, candidate.revision) } catch { continue }
    const text = extractDescription(card?.markdown ?? '')
    if (text) return { text, source: candidate.source, repoId: candidate.id, truncated: !!card.truncated }
  }
  return null
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
