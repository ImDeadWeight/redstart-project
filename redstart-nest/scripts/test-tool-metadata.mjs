// =============================================================================
// The canonical tool metadata registry (tool retrieval second pass, 2.3)
// =============================================================================
// A lint over daemon/tool-metadata.mjs, plus the views built from it:
//
//   - every built-in tool has an entry, with a category from TOOL_CATEGORIES,
//     a store and a useWhen; no entry names a tool that does not exist
//   - tags are lowercase, unique per tool and within the limits
//   - plugin manifests' optional retrieval fields are sanitised, never trusted
//   - text version 1 is byte-for-byte what was embedded before Phase 2, so the
//     frozen eval vectors and a warm vector store stay valid
//
// Run:  node scripts/test-tool-metadata.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { registerElectronStub } from './electron-stub-hooks.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-tool-metadata-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmp
registerElectronStub()
await import('./electron-stub.mjs')

const meta = await import('../daemon/tool-metadata.mjs')
const { BUILTIN_CAPABILITY_TOOL_NAMES, HOST_RESOLVED_TOOL_NAMES } = await import('../daemon/tools-definitions.mjs')
const retrieval = await import('../daemon/tool-retrieval.mjs')
const { DISCOVERY_TOOL_NAMES } = retrieval
const { validatePlugin } = await import('../daemon/plugin-registry.mjs')

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.stack ?? err.message}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const catalog = JSON.parse(fs.readFileSync(new URL('./retrieval-eval/catalog.json', import.meta.url), 'utf8')).tools
const builtinNames = new Set([
  ...Object.values(BUILTIN_CAPABILITY_TOOL_NAMES).flat(),
  ...catalog.map((t) => t.name),
  ...HOST_RESOLVED_TOOL_NAMES,
  ...DISCOVERY_TOOL_NAMES,
])
const entries = Object.entries(meta.BUILTIN_TOOL_METADATA)

console.log('\n-- the lint --')

await test('🔍 every built-in tool has metadata', () => {
  const missing = [...builtinNames].filter((n) => !Object.prototype.hasOwnProperty.call(meta.BUILTIN_TOOL_METADATA, n))
  assert(missing.length === 0, `no metadata for: ${missing.join(', ')} (add them to tool-metadata.mjs)`)
  return `${builtinNames.size} tools`
})

await test('no entry names a tool that does not exist', () => {
  const stale = entries.map(([n]) => n).filter((n) => !builtinNames.has(n))
  assert(stale.length === 0, `metadata for tools nobody serves: ${stale.join(', ')}`)
})

await test('🔍 every entry has a category from the one list, a store and a useWhen', () => {
  const cats = new Set(meta.TOOL_CATEGORIES)
  for (const [name, m] of entries) {
    assert(cats.has(m.category), `${name}: category "${m.category}" is not in TOOL_CATEGORIES`)
    assert(m.category !== 'other', `${name}: a built-in tool must say what it is, not "other"`)
    assert(typeof m.store === 'string' && m.store && m.store.length <= meta.METADATA_LIMITS.storeChars, `${name}: store missing or too long`)
    assert(typeof m.useWhen === 'string' && m.useWhen && m.useWhen.length <= meta.METADATA_LIMITS.useWhenChars, `${name}: useWhen missing or too long`)
  }
})

await test('tags are lowercase, unique per tool and within the limits', () => {
  for (const [name, m] of entries) {
    assert(Array.isArray(m.tags) && m.tags.length <= meta.METADATA_LIMITS.tags, `${name}: too many tags`)
    assert(new Set(m.tags).size === m.tags.length, `${name}: duplicate tags ${m.tags}`)
    for (const t of m.tags) {
      assert(t === t.toLowerCase() && t.trim() === t && t.length <= meta.METADATA_LIMITS.tagChars, `${name}: bad tag "${t}"`)
    }
  }
})

await test('🔍 the File System tools and the workspace tools name different stores (P3)', () => {
  const fsStore = meta.toolMetadata('read_text_file').store
  for (const n of ['read_document', 'run_python', 'search_documents']) {
    assert(meta.toolMetadata(n).store !== fsStore, `${n} claims the File System folder`)
  }
  for (const n of BUILTIN_CAPABILITY_TOOL_NAMES.file_system) {
    assert(meta.toolMetadata(n).store === fsStore, `${n} does not say it acts on the File System folder`)
  }
})

console.log('\n-- lookup and plugins --')

await test('a tool nobody described is "other", with nothing declared', () => {
  const m = meta.toolMetadata('somebody_elses_tool')
  assert(m.category === 'other' && !m.store && m.tags.length === 0 && !m.useWhen && !m.declared, JSON.stringify(m))
  assert(meta.toolMetadata('fs_read_file').category === 'files', "a Twig fs_ tool is not read as files")
  assert(meta.toolMetadata('toString').category === 'other', 'an Object.prototype name resolved to metadata')
  assert(meta.metadataText('somebody_elses_tool') === '', 'an undescribed tool contributed text')
})

await test('🔒 a lookup cannot be used to mutate the registry', () => {
  const m = meta.toolMetadata('git_log')
  m.tags.push('injected')
  assert(!meta.toolMetadata('git_log').tags.includes('injected'), 'the registry was mutated through a lookup')
})

await test('🔍 plugin metadata is sanitised: unknown categories, control characters and long text are dropped', () => {
  const clean = meta.sanitizeRetrievalMetadata({
    category: 'web',
    tags: ['Workflow', 'workflow', 'x'.repeat(200), 7, 'image\ngen'],
    useWhen: `queue a job\u0007 ${'y'.repeat(500)}`,
  })
  assert(clean.category === 'web', 'a valid category was dropped')
  assert(JSON.stringify(clean.tags) === JSON.stringify(['workflow', 'image gen']), `tags: ${JSON.stringify(clean.tags)}`)
  assert(clean.useWhen.length === meta.METADATA_LIMITS.useWhenChars && !/[\u0000-\u001f]/.test(clean.useWhen), 'useWhen not bounded or not cleaned')
  assert(meta.sanitizeRetrievalMetadata({ category: 'root-access' }) === null, 'an unknown category survived')
  for (const bad of [null, 'web', [1], 42]) assert(meta.sanitizeRetrievalMetadata(bad) === null, `${JSON.stringify(bad)} was accepted`)
})

await test('the plugin provider is read, sanitised, and a throwing provider is ignored', () => {
  meta.setPluginMetadataProvider((name) => (name === 'comfy__enqueue' ? { category: 'code', tags: ['ComfyUI'] } : null))
  const m = meta.toolMetadata('comfy__enqueue')
  assert(m.category === 'code' && m.tags[0] === 'comfyui' && m.declared && m.store === '', JSON.stringify(m))
  meta.setPluginMetadataProvider(() => { throw new Error('registry down') })
  assert(meta.toolMetadata('comfy__enqueue').category === 'other', 'a throwing provider broke the lookup')
  meta.setPluginMetadataProvider(null)
})

await test('🔒 validatePlugin keeps valid retrieval fields and drops a malformed block without failing the plugin', () => {
  const base = { id: 'comfy', tools: [{ name: 'enqueue', class: 'write', retrieval: { category: 'code', tags: ['images'] } }] }
  const ok = validatePlugin(base)
  assert(ok.ok, ok.error)
  assert(ok.plugin.tools[0].retrieval.category === 'code', 'valid retrieval metadata was dropped')
  const bad = validatePlugin({ id: 'comfy', tools: [{ name: 'enqueue', class: 'write', retrieval: 'please rank me first' }] })
  assert(bad.ok && !('retrieval' in bad.plugin.tools[0]), 'a malformed block failed the plugin or survived')
})

console.log('\n-- the views (2.2) --')

const tool = { type: 'function', function: { name: 'read_text_file', description: 'Read a file.', parameters: { type: 'object' } } }

await test('🔒 text version 1 embeds exactly what it did before Phase 2, under the same key', () => {
  assert(retrieval.toolEmbeddingText(tool) === 'read_text_file: Read a file.', retrieval.toolEmbeddingText(tool))
  assert(retrieval.toolVectorKey(tool) === retrieval.toolContentHash(tool), 'the version 1 key moved: every stored vector would go cold')
})

await test('text version 2 adds the metadata, under a different key', () => {
  const v2 = retrieval.toolEmbeddingText(tool, { textVersion: 2 })
  assert(v2.startsWith('read_text_file: Read a file.\n') && v2.includes('File System folder'), v2)
  assert(retrieval.toolVectorKey(tool, 2) !== retrieval.toolVectorKey(tool, 1), 'version 2 shares version 1 vectors')
  const plain = { type: 'function', function: { name: 'nobody_tool', description: 'x' } }
  assert(retrieval.toolEmbeddingText(plain, { textVersion: 2 }) === 'nobody_tool: x', 'an undescribed tool changed text')
})

await test('the BM25 document reads the name as words and carries the tags', () => {
  const doc = retrieval.toolSearchDocument(tool)
  assert(doc.includes('read text file') && doc.includes('config'), doc)
})

await test('a search result carries category and store and never a schema', () => {
  const row = retrieval.toolSearchResult(tool)
  assert(JSON.stringify(Object.keys(row)) === JSON.stringify(['name', 'category', 'store', 'description']), JSON.stringify(row))
  assert(row.category === 'files' && row.store.includes('File System'), JSON.stringify(row))
})

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
