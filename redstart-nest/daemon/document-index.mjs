'use strict'

// =============================================================================
// Redstart Nest — the document index behind search_documents (Phase 5a)
// =============================================================================
// rag-plan.md is the design; chat-tooling-plan.md Phase 5 adds the split that
// unblocks half of it: 5a searches the caller's OWN documents (their
// Documents folder, conversation workspaces included), which are private by
// construction and need no grants. 5b, shared spaces, waits for resource grants.
//
// THE STORE IS NEST'S OWN STATE, not a capability. It's SQLite through sql.js
// (already a dependency, wasm), one file at <config>/document-index.sqlite,
// loaded into memory and written back atomically after a change. Every row
// carries `scope` (the account) AND a nullable `grant_id`. 5a writes NULL, and
// 5b adds rows with a grant id: one index, N scopes, no schema change, no
// re-index (rag-plan §1, plan D2).
//
// WHAT IT IS AND IS NOT:
//   - chunks are a fixed window with overlap (rag-plan §4: "start boring")
//   - re-index is mtime-on-access: each search first syncs the caller's own
//     folder (new / changed / deleted files), within a time budget, plus a
//     manual rebuild (clearScope)
//   - ranking is hybrid: BM25 over the text always, and cosine over vectors
//     when the embedding sidecar answers. rag-plan foreclosed nothing here, and
//     an exact term (a policy number, a filename) is what vector-only misses.
//     A chunk with no vector is still found by its words, so the sidecar is
//     never load-bearing.
//
// Derived data: a corrupt index file is moved aside and rebuilt, never fatal.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import initSqlJs from 'sql.js'
import { TRASH_DIR_NAME } from './trash.mjs'
import { logEvent } from './logger.mjs'

export const INDEX_FILE = 'document-index.sqlite'
export const INDEXABLE_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.txt', '.md', '.csv', '.json', '.html', '.py', '.js'])
export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_FILES_PER_SCOPE = 2000
export const CHUNK_CHARS = 1200
export const CHUNK_OVERLAP = 200
const EMBED_BATCH = 32

// ---------------------------------------------------------------------------
// Chunking (pure)
// ---------------------------------------------------------------------------

/**
 * Fixed windows of ~`size` characters overlapping by `overlap`, each cut at
 * the last paragraph break, then line break, then space, in the back third of
 * the window, so a chunk rarely ends mid-word. Whitespace runs are collapsed
 * first. Pure; exported for the suite.
 */
export function chunkText(text, { size = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (!clean) return []
  const chunks = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size)
    if (end < clean.length) {
      const window = clean.slice(start, end)
      const floor = Math.floor(size * 0.66)
      for (const sep of ['\n\n', '\n', ' ']) {
        const at = window.lastIndexOf(sep)
        if (at >= floor) { end = start + at; break }
      }
    }
    const piece = clean.slice(start, end).trim()
    if (piece) chunks.push(piece)
    if (end >= clean.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

const STOP = new Set('the a an and or of to in is are was were be for on with as by at it this that from what which how does do can my our your their there not no'.split(' '))

export function terms(s) {
  return String(s).toLowerCase().match(/[a-z0-9][a-z0-9._-]*[a-z0-9]|[a-z0-9]/g)?.filter((t) => !STOP.has(t)) ?? []
}

/** BM25 over a candidate set. Returns one score per chunk, 0 when nothing matches. */
export function bm25Scores(query, texts, { k1 = 1.2, b = 0.75 } = {}) {
  const q = [...new Set(terms(query))]
  if (!q.length || !texts.length) return texts.map(() => 0)
  const docs = texts.map((t) => terms(t))
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]))
  return docs.map((d) => {
    let s = 0
    for (const t of q) {
      const n = df.get(t)
      if (!n) continue
      const f = d.filter((x) => x === t).length
      if (!f) continue
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)))
    }
    return s
  })
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/**
 * Hybrid rank: each signal normalised to [0, 1] over the candidates, then
 * weighted. With no query vector, BM25 alone. Weights from the measurement in
 * the implementation record (5.3). Pure.
 *
 * @param {{ text: string, vector: Float32Array|null }[]} chunks
 * @param {string} query
 * @param {Float32Array|null} queryVector
 */
export function rankChunks(chunks, query, queryVector, { vectorWeight = HYBRID_VECTOR_WEIGHT } = {}) {
  const kw = bm25Scores(query, chunks.map((c) => c.text))
  const kwMax = Math.max(0, ...kw)
  const vec = queryVector ? chunks.map((c) => (c.vector ? cosine(queryVector, c.vector) : 0)) : null
  return chunks.map((c, i) => {
    const k = kwMax > 0 ? kw[i] / kwMax : 0
    if (!vec) return { chunk: c, score: k, keyword: kw[i], semantic: null }
    // Cosine from bge-small sits in roughly [0.3, 0.9] for any English text;
    // rescale so unrelated text is near 0 rather than at 0.4.
    const v = Math.max(0, (vec[i] - SEMANTIC_FLOOR) / (1 - SEMANTIC_FLOOR))
    return { chunk: c, score: vectorWeight * v + (1 - vectorWeight) * k, keyword: kw[i], semantic: vec[i] }
  })
    .filter((r) => r.keyword > 0 || (r.semantic !== null && r.semantic > SEMANTIC_FLOOR + 0.1))
    .sort((a, b) => b.score - a.score)
}

export const HYBRID_VECTOR_WEIGHT = 0.8
export const SEMANTIC_FLOOR = 0.45

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  scope TEXT NOT NULL, grant_id TEXT, path TEXT NOT NULL,
  mtime INTEGER NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL, error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sources_key ON sources(scope, IFNULL(grant_id, ''), path);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY, scope TEXT NOT NULL, grant_id TEXT, path TEXT NOT NULL,
  ord INTEGER NOT NULL, text TEXT NOT NULL, vector BLOB
);
CREATE INDEX IF NOT EXISTS chunks_scope ON chunks(scope, path);
`

let SQL = null
const open = new Map()   // file → { db, dirty }

async function db(dir) {
  const file = path.join(dir, INDEX_FILE)
  if (open.has(file)) return open.get(file)
  if (!SQL) SQL = await initSqlJs()
  let handle
  try {
    handle = new SQL.Database(fs.existsSync(file) ? fs.readFileSync(file) : undefined)
    handle.exec(SCHEMA)
  } catch (err) {
    // Derived data: keep the bad file for a human, start over.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
    logEvent('documents', 'index_corrupt_rebuilt', { reason: err.message })
    handle = new SQL.Database()
    handle.exec(SCHEMA)
  }
  const entry = { db: handle, file, dirty: false }
  open.set(file, entry)
  return entry
}

function persist(entry) {
  if (!entry.dirty) return
  const bytes = Buffer.from(entry.db.export())
  const tmp = `${entry.file}.${process.pid}.${Date.now()}.tmp`
  fs.mkdirSync(path.dirname(entry.file), { recursive: true })
  const fd = fs.openSync(tmp, 'w')
  try { fs.writeSync(fd, bytes); try { fs.fsyncSync(fd) } catch {} } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, entry.file)
  entry.dirty = false
}

/** For tests and shutdown: drop the in-memory handles. */
export function closeAll() {
  for (const e of open.values()) { try { persist(e) } catch {} e.db.close() }
  open.clear()
}

function rows(handle, sql, params = []) {
  const stmt = handle.prepare(sql)
  try {
    stmt.bind(params)
    const out = []
    while (stmt.step()) out.push(stmt.getAsObject())
    return out
  } finally { stmt.free() }
}

const toBlob = (v) => (v ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null)
const fromBlob = (b) => (b && b.length ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null)

/** Readable files under a root, relative and '/'-separated, skipping the trash and links. */
export function listIndexable(root, { limit = MAX_FILES_PER_SCOPE } = {}) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= limit) return
      if (e.isSymbolicLink()) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== TRASH_DIR_NAME && !e.name.startsWith('.')) walk(full); continue }
      if (!INDEXABLE_EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue
      let st
      try { st = fs.lstatSync(full) } catch { continue }
      if (st.size > MAX_FILE_BYTES || st.size === 0) continue
      out.push({ path: path.relative(root, full).split(path.sep).join('/'), full, mtime: Math.floor(st.mtimeMs), size: st.size })
    }
  }
  walk(root)
  return out
}

/**
 * Bring one scope's index up to date with its folder: drop what is gone,
 * (re)chunk what is new or changed, embed chunks that have no vector yet when
 * an embedder works. Stops starting new files after `budgetMs`.
 *
 * @param {{ dir: string, scope: string, root: string,
 *           extract: (fullPath: string) => Promise<string>,
 *           embed?: (texts: string[]) => Promise<Float32Array[]|null>,
 *           budgetMs?: number, now?: () => number }} args
 * @returns {Promise<{ files: number, indexed: number, removed: number, pending: number, embedded: number, unembedded: number, errors: string[] }>}
 */
export async function syncScope({ dir, scope, root, extract, embed, budgetMs = 20000, now = Date.now }) {
  const entry = await db(dir)
  const h = entry.db
  const started = now()
  const onDisk = listIndexable(root)
  const known = new Map(rows(h, 'SELECT path, mtime, size FROM sources WHERE scope = ? AND grant_id IS NULL', [scope]).map((r) => [r.path, r]))
  const present = new Set(onDisk.map((f) => f.path))

  let removed = 0
  for (const p of known.keys()) {
    if (present.has(p)) continue
    h.run('DELETE FROM chunks WHERE scope = ? AND grant_id IS NULL AND path = ?', [scope, p])
    h.run('DELETE FROM sources WHERE scope = ? AND grant_id IS NULL AND path = ?', [scope, p])
    removed++
    entry.dirty = true
  }

  const stale = onDisk.filter((f) => { const k = known.get(f.path); return !k || k.mtime !== f.mtime || k.size !== f.size })
  let indexed = 0
  const errors = []
  for (const f of stale) {
    if (now() - started > budgetMs) break
    let chunks = []
    let error = null
    try {
      chunks = chunkText(await extract(f.full))
    } catch (err) {
      error = String(err?.message || err).slice(0, 200)
      errors.push(`${f.path}: ${error}`)
    }
    h.run('DELETE FROM chunks WHERE scope = ? AND grant_id IS NULL AND path = ?', [scope, f.path])
    h.run('DELETE FROM sources WHERE scope = ? AND grant_id IS NULL AND path = ?', [scope, f.path])
    chunks.forEach((text, ord) => h.run('INSERT INTO chunks (scope, grant_id, path, ord, text, vector) VALUES (?, NULL, ?, ?, ?, NULL)', [scope, f.path, ord, text]))
    h.run('INSERT INTO sources (scope, grant_id, path, mtime, size, chunks, indexed_at, error) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)', [scope, f.path, f.mtime, f.size, chunks.length, now(), error])
    indexed++
    entry.dirty = true
  }

  let embedded = 0
  if (embed) {
    const missing = rows(h, 'SELECT id, text FROM chunks WHERE scope = ? AND grant_id IS NULL AND vector IS NULL ORDER BY id', [scope])
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      if (now() - started > budgetMs) break
      const batch = missing.slice(i, i + EMBED_BATCH)
      const vectors = await embed(batch.map((r) => r.text))
      if (!Array.isArray(vectors) || vectors.length !== batch.length) break   // sidecar gone: words still work
      batch.forEach((r, j) => h.run('UPDATE chunks SET vector = ? WHERE id = ?', [toBlob(vectors[j]), r.id]))
      embedded += batch.length
      entry.dirty = true
    }
  }
  const unembedded = rows(h, 'SELECT COUNT(*) AS n FROM chunks WHERE scope = ? AND grant_id IS NULL AND vector IS NULL', [scope])[0]?.n ?? 0

  persist(entry)
  return { files: onDisk.length, indexed, removed, pending: stale.length - indexed, embedded, unembedded, errors }
}

/**
 * Search one scope's chunks. A query vector is used when given.
 * `pathPrefix` (e.g. "Projects/billing/") keeps only files under that folder
 * of the scope's root, for a project chat (projects-plan D14). Filtered in JS
 * rather than with LIKE, so a "%" or "_" in a folder name is not a wildcard.
 * It narrows inside the scope and can never widen it.
 */
export async function searchScope({ dir, scope, query, queryVector = null, limit = 6, pathPrefix = null }) {
  const { db: h } = await db(dir)
  let all = rows(h, 'SELECT path, ord, text, vector FROM chunks WHERE scope = ? AND grant_id IS NULL', [scope])
    .map((r) => ({ path: r.path, ord: r.ord, text: r.text, vector: fromBlob(r.vector) }))
  if (pathPrefix) all = all.filter((c) => c.path.startsWith(pathPrefix))
  return rankChunks(all, query, queryVector).slice(0, limit)
}

/** Forget one scope entirely (the manual rebuild: the next search re-indexes it). */
export async function clearScope({ dir, scope }) {
  const entry = await db(dir)
  entry.db.run('DELETE FROM chunks WHERE scope = ? AND grant_id IS NULL', [scope])
  entry.db.run('DELETE FROM sources WHERE scope = ? AND grant_id IS NULL', [scope])
  entry.dirty = true
  persist(entry)
}

export async function scopeStats({ dir, scope }) {
  const { db: h } = await db(dir)
  const s = rows(h, 'SELECT COUNT(*) AS files, SUM(chunks) AS chunks, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed FROM sources WHERE scope = ? AND grant_id IS NULL', [scope])[0]
  return { files: s?.files ?? 0, chunks: s?.chunks ?? 0, failed: s?.failed ?? 0 }
}
