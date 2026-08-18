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

import {
  classifyTool,
  TOOL_CLASSES,
  CAPABILITY_TOOL_NAMES,
  CLIENT_APP_TOOL_NAMES,
  expandDisabledToolIds,
  capabilityForTool,
  setPluginCapabilityProvider,
} from '../electron/main/tools-definitions.mjs'

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

await test('🔍 the File System delete tool is classified destructive — this is what arms the gate', async () => {
  // This assertion replaces its own opposite. It previously read "the File
  // System provider exposes no destructive tool", which was true while
  // allowDestructive gated nothing: @modelcontextprotocol/server-filesystem
  // ships no delete, so the policy flag was reserved rather than load-bearing.
  // Deletion is now Redstart-owned (fs-delete-tool.mjs), and THIS
  // classification is the single line that makes evaluateToolPolicy refuse it
  // unless an admin has opted in. Mis-classify it and the gate silently opens.
  const destructive = CAPABILITY_TOOL_NAMES.file_system.filter(t => classifyTool(t) === 'destructive')
  assert(destructive.length === 1, `expected exactly one destructive fs tool, got ${JSON.stringify(destructive)}`)
  assert(destructive[0] === 'delete_file', `unexpected destructive tool: ${destructive[0]}`)
})

await test('destructive is the ONLY class the delete tool can have', async () => {
  // Belt and braces: 'write' would put it behind allowWrite (on by default),
  // and 'read' would let it past the gate entirely.
  assert(classifyTool('delete_file') === 'destructive', `delete_file is classified ${classifyTool('delete_file')}`)
})

await test('the known write ops are classified write', async () => {
  for (const t of ['write_file', 'edit_file', 'create_directory', 'move_file', 'create_document', 'scholar_save_pdf']) {
    assert(classifyTool(t) === 'write', `${t} classified ${classifyTool(t)}, expected write`)
  }
})

await test('read-only tools are classified read (not accidentally elevated)', async () => {
  for (const t of ['read_text_file', 'list_directory', 'sqlite_query', 'postgres_query', 'vault_get', 'git_diff']) {
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
// Plugin classification (plan decisions D3/D-b) — the admin-assigned class
// from the registry, looked up BEFORE the built-in fallback, and the child's
// own opinion about itself never enters this at all.
// ---------------------------------------------------------------------------

console.log('\n-- plugin classification (D3/D-b) --')

await test('🔍 a plugin tool takes its class from the registry, not the read default', async () => {
  setPluginCapabilityProvider(() => ({
    memoryplugin: {
      toolNames: ['memoryplugin__create_entities', 'memoryplugin__read_graph'],
      classes: { memoryplugin__create_entities: 'destructive' },
    },
  }))
  try {
    assert(capabilityForTool('memoryplugin__create_entities') === 'memoryplugin', 'provenance lookup did not resolve the injected plugin')
    assert(
      classifyTool('memoryplugin__create_entities') === 'destructive',
      `expected the registry-assigned class "destructive", got "${classifyTool('memoryplugin__create_entities')}"`,
    )
  } finally {
    setPluginCapabilityProvider(null)
  }
})

await test('an unclassified plugin tool (belongs to a capability, but the registry names no class) falls back to read, the most restrictive default for the gate', async () => {
  // "most restrictive default" per §7 means the gate can never treat it as
  // write/destructive by ACCIDENT — 'read' is that floor (see the note above
  // TOOL_CLASSES). A real install can't actually produce this shape (every
  // discovered tool is written 'destructive' at install time, D-b), so this
  // pins the fallback path itself, independent of what the install pipeline
  // happens to do today.
  setPluginCapabilityProvider(() => ({
    bareplugin: { toolNames: ['bareplugin__mystery_tool'], classes: {} },
  }))
  try {
    assert(classifyTool('bareplugin__mystery_tool') === 'read', `expected fallback "read", got "${classifyTool('bareplugin__mystery_tool')}"`)
  } finally {
    setPluginCapabilityProvider(null)
  }
})

await test('a plugin tool name that happens to match a BUILT-IN tool name still gets the built-in\'s classification, not the plugin\'s', async () => {
  // classifyTool() checks TOOL_CLASSES[name] first. This is defence in depth —
  // plugin-registry.mjs's own validator already refuses an id that collides
  // with a built-in tool name, so this shape shouldn't reach classifyTool at
  // all — but pin the lookup ORDER itself in case that guarantee ever moves.
  setPluginCapabilityProvider(() => ({
    imposter: { toolNames: ['delete_file'], classes: { delete_file: 'read' } },
  }))
  try {
    assert(classifyTool('delete_file') === 'destructive', 'a plugin\'s classification for a built-in tool name overrode the built-in\'s own — privilege escalation')
  } finally {
    setPluginCapabilityProvider(null)
  }
})

// ---------------------------------------------------------------------------
// Ban expansion — what an admin's disabledToolIds actually strips.
//
// The gateway bans by function name, so every entry has to resolve to concrete
// names. Unknown ids used to be DROPPED, which meant the mechanism built to
// moderate client apps could not name a single client-app tool: putting
// 'fs_delete_file' in disabledToolIds expanded to nothing, silently, and the
// ban simply did not exist.
// ---------------------------------------------------------------------------

console.log('\n-- ban expansion --')

await test('a capability id expands to all of its tool names', async () => {
  const names = expandDisabledToolIds(['file_system'])
  for (const t of CAPABILITY_TOOL_NAMES.file_system) {
    assert(names.includes(t), `expanding file_system did not yield ${t}`)
  }
  return `${names.length} names`
})

await test('a client-app id expands to all of that app\'s tool names', async () => {
  const names = expandDisabledToolIds(['twig'])
  for (const t of CLIENT_APP_TOOL_NAMES.twig) {
    assert(names.includes(t), `expanding twig did not yield ${t}`)
  }
  return `${names.length} names`
})

await test('🔍 an unknown id passes through as a LITERAL tool name', async () => {
  // The case the whole mechanism exists for: banning one client-app tool by
  // name. Previously expanded to [] with no warning.
  assert(
    expandDisabledToolIds(['fs_delete_file']).includes('fs_delete_file'),
    'banning an individual tool by name still expands to nothing — a ban on a client-app tool cannot be expressed',
  )
})

await test('mixed ids expand together without losing any', async () => {
  const names = expandDisabledToolIds(['file_system', 'fs_delete_file', 'web_fetch'])
  assert(names.includes('write_file'), 'lost the capability expansion')
  assert(names.includes('fs_delete_file'), 'lost the literal name')
  assert(names.includes('web_fetch'), 'lost the second literal name')
})

await test('expansion is duplicate-free and ignores junk entries', async () => {
  const names = expandDisabledToolIds(['file_system', 'file_system', '', null, undefined, 'write_file'])
  assert(names.length === new Set(names).size, `duplicates present: ${names.join(', ')}`)
  assert(!names.includes(''), 'an empty id became a ban entry')
  assert(!names.some(n => n == null), 'a null id became a ban entry')
})

await test('🔍 a plugin id expands to all of its namespaced tool names (ban propagation)', async () => {
  setPluginCapabilityProvider(() => ({
    banme: { toolNames: ['banme__do_a', 'banme__do_b'], classes: {} },
  }))
  try {
    const names = expandDisabledToolIds(['banme'])
    assert(names.includes('banme__do_a') && names.includes('banme__do_b'), `expanding "banme" did not yield both of its tools: ${names.join(', ')}`)
  } finally {
    setPluginCapabilityProvider(null)
  }
})

await test('an empty or missing ban list expands to nothing', async () => {
  assert(expandDisabledToolIds([]).length === 0, 'empty list produced bans')
  assert(expandDisabledToolIds().length === 0, 'missing list produced bans')
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
