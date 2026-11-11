// =============================================================================
// Tests for daemon/gguf-meta.mjs and daemon/chat-template-choice.mjs — a
// bundled chat-template override is only applied to the model family it was
// written for.
// =============================================================================
// Found by the agent bench, 2026-11-11: picking a different model kept the
// profile's chatTemplateFile, so Qwen3-4B (architecture qwen3) ran under
// qwen3.6-tools.jinja (the Qwen 3.5/3.6 XML tool format) and llama-server
// parsed 34 of its 109 tool calls. These tests pin the check that prevents
// that, against synthesized GGUF headers written to a temp folder, and that
// the command preview and the launch make the same choice.
//
// Run:  node scripts/test-chat-template-choice.mjs
// =============================================================================

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { initPaths } from '../daemon/platform-paths.mjs'

initPaths({ config: 'unused-by-this-suite/config', capabilityBase: 'unused-by-this-suite/data', isPackaged: false })

const { parseGgufGeneral, readGgufGeneral } = await import('../daemon/gguf-meta.mjs')
const { chooseChatTemplate, BUNDLED_TEMPLATES } = await import('../daemon/chat-template-choice.mjs')
const { buildArgs } = await import('../daemon/llama-args.mjs')
const { generateLlamaCommand } = await import('../daemon/ipc/server.mjs')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }
function eq(a, b, message) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`)
}

// ---------------------------------------------------------------------------
// A GGUF header writer, just enough of the format for these tests.
// ---------------------------------------------------------------------------

const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b }
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
const gstr = (s) => { const bytes = Buffer.from(s, 'utf8'); return Buffer.concat([u64(bytes.length), bytes]) }

/** kv entries: [key, 'str', value] | [key, 'u32', n] | [key, 'strarr', string[]] | [key, 'f32arr', n] */
function gguf(kvs) {
  const parts = [Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(kvs.length)]
  for (const [key, type, value] of kvs) {
    parts.push(gstr(key))
    if (type === 'str') parts.push(u32(8), gstr(value))
    else if (type === 'u32') parts.push(u32(4), u32(value))
    else if (type === 'strarr') parts.push(u32(9), u32(8), u64(value.length), ...value.map(gstr))
    else if (type === 'f32arr') parts.push(u32(9), u32(6), u64(value), Buffer.alloc(value * 4))
  }
  return Buffer.concat(parts)
}

const QWEN3_4B = gguf([
  ['general.architecture', 'str', 'qwen3'],
  ['general.name', 'str', 'Qwen3-4B-Instruct-2507'],
  ['general.basename', 'str', 'Qwen3-4B-Instruct-2507'],
  ['general.size_label', 'str', '4B'],
  ['qwen3.context_length', 'u32', 262144],
  ['tokenizer.ggml.tokens', 'strarr', ['a', 'b', 'c']],
])
const QWEN36_MOE = gguf([
  ['general.architecture', 'str', 'qwen35moe'],
  ['general.name', 'str', 'Qwen3.6-35B-A3B'],
])

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-chat-template-'))
const write = (name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p }
const model4b = write('Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf', QWEN3_4B)
const model36 = write('Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf', QWEN36_MOE)
const notGguf = write('broken.gguf', Buffer.from('not a model at all, just text'))
const BUNDLED = path.join(__dirname, '..', 'chat-templates', 'qwen3.6-tools.jinja')

const base = { ctxSize: 8192, batchSize: 512, threads: 8, port: 19080 }

// ---------------------------------------------------------------------------
// gguf-meta
// ---------------------------------------------------------------------------

await test('reads the general.* keys of a GGUF header', async () => {
  const meta = parseGgufGeneral(QWEN3_4B)
  eq([meta.version, meta.architecture, meta.name, meta.basename, meta.sizeLabel],
    [3, 'qwen3', 'Qwen3-4B-Instruct-2507', 'Qwen3-4B-Instruct-2507', '4B'], 'fields')
})

await test('skips non-string values and arrays that come before the architecture', async () => {
  const meta = parseGgufGeneral(gguf([
    ['general.file_type', 'u32', 15],
    ['general.tags', 'strarr', ['x', 'y']],
    ['general.weights', 'f32arr', 10],
    ['general.architecture', 'str', 'llama'],
  ]))
  eq(meta.architecture, 'llama', 'architecture after a skipped array')
})

await test('a truncated header keeps what was read, and does not throw', async () => {
  const meta = parseGgufGeneral(QWEN3_4B.subarray(0, QWEN3_4B.length - 5))
  eq(meta.architecture, 'qwen3', 'architecture survives a cut inside a later array')
  const early = parseGgufGeneral(QWEN3_4B.subarray(0, 30))
  eq(early.architecture, null, 'cut before the architecture')
})

await test('a file that is not GGUF, or does not exist, is null', async () => {
  eq(parseGgufGeneral(Buffer.from('nope')), null, 'short buffer')
  eq(readGgufGeneral(notGguf), null, 'text file')
  eq(readGgufGeneral(path.join(dir, 'missing.gguf')), null, 'missing file')
  eq(readGgufGeneral(model36)?.architecture, 'qwen35moe', 'a real file on disk')
})

await test('a string length larger than the buffer is a stop, not an allocation', async () => {
  const bad = Buffer.concat([Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(1), u64(2n ** 60n)])
  eq(parseGgufGeneral(bad)?.architecture, null, 'no architecture')
})

// ---------------------------------------------------------------------------
// chat-template-choice
// ---------------------------------------------------------------------------

await test('no override: the embedded template', async () => {
  const r = chooseChatTemplate({ ...base, modelPath: model4b })
  eq(r.decision.source, 'embedded', 'source')
  assert(r.logLine.includes('embedded'), r.logLine)
})

await test('THE BUG: the Qwen3.6 override on a qwen3 model is skipped', async () => {
  const config = { ...base, modelPath: model4b, chatTemplateFile: BUNDLED }
  const r = chooseChatTemplate(config)
  eq([r.decision.source, r.decision.architecture], ['skipped', 'qwen3'], 'decision')
  assert(!('chatTemplateFile' in r.config) && !('chatTemplate' in r.config), 'override fields removed from the effective config')
  assert(config.chatTemplateFile === BUNDLED, 'the profile config itself is not modified')
  assert(!buildArgs(r.config, true).includes('--chat-template-file'), 'no --chat-template-file in the launch args')
  assert(/skipped/.test(r.logLine) && /qwen3\b/.test(r.logLine), r.logLine)
})

await test('the Qwen3.6 override on a qwen35moe model is applied', async () => {
  const r = chooseChatTemplate({ ...base, modelPath: model36, chatTemplateFile: BUNDLED })
  eq([r.decision.source, r.decision.architecture, r.decision.warning], ['override', 'qwen35moe', null], 'decision')
  const args = buildArgs(r.config, true)
  eq(args[args.indexOf('--chat-template-file') + 1], BUNDLED, 'template path passed')
})

await test('a bundled override is matched by file name, from either slash style', async () => {
  const r = chooseChatTemplate({ ...base, modelPath: model4b, chatTemplateFile: 'E:\\some\\copy\\qwen3.6-tools.jinja' })
  eq(r.decision.source, 'skipped', 'Windows path')
})

await test('an unreadable model applies a bundled override, with a warning (the old behaviour)', async () => {
  const r = chooseChatTemplate({ ...base, modelPath: notGguf, chatTemplateFile: BUNDLED })
  eq(r.decision.source, 'override', 'source')
  assert(r.decision.warning && /unchecked/.test(r.decision.warning), 'warning says unchecked')
  assert(buildArgs(r.config, true).includes('--chat-template-file'), 'still applied')
})

await test('a template that is not bundled is a user override, applied unchecked', async () => {
  const r = chooseChatTemplate({ ...base, modelPath: model4b, chatTemplateFile: 'C:\\mine\\custom.jinja' })
  eq(r.decision.source, 'user-override', 'source')
  assert(buildArgs(r.config, true).includes('--chat-template-file'), 'applied')
  const named = chooseChatTemplate({ ...base, modelPath: model4b, chatTemplate: 'chatml' })
  eq(named.decision.source, 'user-override', 'chatTemplate field')
  assert(buildArgs(named.config, true).includes('--chat-template'), 'applied')
})

await test('the readMeta port is used when given (no disk read)', async () => {
  const r = chooseChatTemplate({ ...base, modelPath: 'X:\\nowhere.gguf', chatTemplateFile: BUNDLED }, { readMeta: () => ({ architecture: 'qwen35' }) })
  eq(r.decision.source, 'override', 'qwen35 matches')
})

await test('every .jinja in chat-templates/ has a BUNDLED_TEMPLATES entry', async () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'chat-templates')).filter((f) => f.endsWith('.jinja'))
  assert(files.length > 0, 'no templates found')
  for (const f of files) {
    assert(Object.hasOwn(BUNDLED_TEMPLATES, f), `${f} has no entry, so it would be applied to any model unchecked`)
    assert(BUNDLED_TEMPLATES[f].architectures.length > 0, `${f} lists no architectures`)
  }
  return files.join(', ')
})

// ---------------------------------------------------------------------------
// ipc/server.mjs: the preview and the launch make the same choice
// ---------------------------------------------------------------------------

await test('the command preview omits a skipped override', async () => {
  const cmd = generateLlamaCommand({ ...base, modelPath: model4b, chatTemplateFile: BUNDLED }, { buildArgs })
  assert(!cmd.includes('--chat-template-file'), cmd)
  const ok = generateLlamaCommand({ ...base, modelPath: model36, chatTemplateFile: BUNDLED }, { buildArgs })
  assert(ok.includes('--chat-template-file'), ok)
})

await test('the launch builds its args from the chosen config, never the raw profile', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'ipc', 'server.mjs'), 'utf8')
  assert(!/buildArgs\(config\b/.test(src), 'server.mjs calls buildArgs(config...) directly, bypassing chooseChatTemplate')
  assert(/buildArgs\(template\.config, true\)/.test(src), 'the launch does not use template.config')
  assert(/appendLine\(template\.logLine\)/.test(src), 'the decision is not written to the run log')
})

// ---------------------------------------------------------------------------

fs.rmSync(dir, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
