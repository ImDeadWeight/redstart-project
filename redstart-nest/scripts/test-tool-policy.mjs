// =============================================================================
// Invariant tests for electron/main/tools-definitions.mjs — the tool
// classification that the permission gate is built on.
// =============================================================================
// Priority 4/5 (permission escalation). The MCP server's non-bypassable gate
// (mcp-server.mjs -> evaluateToolPolicy) decides whether a write/destructive
// call is allowed by asking classifyTool() what CLASS a tool is. That map is
// therefore the foundation of the whole permission model: if a mutating tool is
// mis-classified as 'read', the gate waves it through even when writes/deletes
// are disabled — a silent privilege escalation.
//
// classifyTool() defaults an UNKNOWN name to 'read'. That is safe for a tool the
// gate doesn't govern, but it is exactly why the File System capability — the
// only read/write/destructive capability — must never rely on the default: a
// future fs_* tool added to the capability but forgotten in TOOL_CLASSES would
// fail OPEN. This suite locks that down.
//
// Pure module (tools-definitions.mjs imports nothing electron), no server.
//
// Run:  node scripts/test-tool-policy.mjs
// =============================================================================

import { classifyTool, TOOL_CLASSES, CAPABILITY_TOOL_NAMES } from '../electron/main/tools-definitions.mjs'

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-path-scope.mjs)
// ---------------------------------------------------------------------------

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

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// The gate mirrors evaluateToolPolicy: a class other than write/destructive is
// ungoverned by the fs policy toggles.
const MUTATING = new Set(['write', 'destructive'])

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n-- tool classification (permission-gate foundation) --')

await test('the known destructive op (fs_delete_file) is classified destructive', async () => {
  assert(classifyTool('fs_delete_file') === 'destructive', `got ${classifyTool('fs_delete_file')}`)
})

await test('the known write ops are classified write', async () => {
  for (const t of ['fs_write_file', 'fs_edit_file', 'fs_create_directory', 'create_document', 'scholar_save_pdf']) {
    assert(classifyTool(t) === 'write', `${t} classified ${classifyTool(t)}, expected write`)
  }
})

await test('read-only tools are classified read (not accidentally elevated)', async () => {
  for (const t of ['fs_read_file', 'fs_list_directory', 'sqlite_query', 'postgres_query', 'vault_get', 'git_diff']) {
    assert(classifyTool(t) === 'read', `${t} classified ${classifyTool(t)}, expected read`)
  }
})

await test('network egress tools are classified network', async () => {
  for (const t of ['web_fetch', 'web_search', 'scholar_search', 'scholar_get']) {
    assert(classifyTool(t) === 'network', `${t} classified ${classifyTool(t)}, expected network`)
  }
})

await test('unknown tool names default to the least-privileged bucket, read', async () => {
  assert(classifyTool('totally_made_up_tool') === 'read', `got ${classifyTool('totally_made_up_tool')}`)
  assert(classifyTool('') === 'read', 'empty name did not default to read')
  assert(classifyTool(undefined) === 'read', 'undefined name did not default to read')
})

await test('🔍 every File System tool is EXPLICITLY classified — the governed capability never rides the read default', async () => {
  // If a new fs_* mutating tool is added to the capability but not to
  // TOOL_CLASSES, classifyTool() returns 'read' and the write/destructive gate
  // fails open. Requiring an explicit entry for every fs tool makes that
  // omission fail loudly here instead of silently in production.
  for (const t of CAPABILITY_TOOL_NAMES.file_system) {
    assert(Object.prototype.hasOwnProperty.call(TOOL_CLASSES, t), `fs tool "${t}" is not explicitly classified — the gate would fail open (default 'read')`)
  }
})

await test('🔍 no File System write/delete tool is classified read', async () => {
  // Belt-and-braces against a mutating fs tool being tagged read (which would
  // sail past the policy gate). Any fs tool whose name implies mutation must be
  // write or destructive.
  const mutatingByName = CAPABILITY_TOOL_NAMES.file_system.filter(t => /write|edit|create|delete|remove|move|rename/.test(t))
  for (const t of mutatingByName) {
    assert(MUTATING.has(classifyTool(t)), `mutating fs tool "${t}" is classified ${classifyTool(t)} — must be write/destructive`)
  }
})

await test('every capability tool name across all capabilities has an explicit classification', async () => {
  for (const [cap, names] of Object.entries(CAPABILITY_TOOL_NAMES)) {
    for (const t of names) {
      assert(Object.prototype.hasOwnProperty.call(TOOL_CLASSES, t), `${cap} tool "${t}" missing from TOOL_CLASSES`)
    }
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
