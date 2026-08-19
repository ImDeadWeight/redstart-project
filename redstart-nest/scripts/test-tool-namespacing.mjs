// =============================================================================
// Enforces the tool-namespacing contract — docs/tool-namespacing.md
// =============================================================================
// The gateway bans tools by FUNCTION NAME, flat, across every source at once
// (enforceToolAllowList sees parsed.tools[].function.name and nothing else).
// So if a client app ships a tool whose name matches one of Nest's, an admin
// banning the app's tool also strips Nest's — for every client on the profile —
// and there is no way to express "ban theirs, keep ours".
//
// The namespace is the only thing keeping bans targetable. This suite is what
// stops that from being a convention someone breaks by accident, since the
// breakage is otherwise completely silent: no error, no failing request, just a
// ban that quietly does more (or less) than it says.
//
// The precedent is real — Nest's file tools were once named fs_*, exactly like
// Twig's, and the chat-ui depended on that collision for filesystem precedence.
// Renaming Nest's side dissolved the protection without a single test failing.
//
// Pure module (tools-definitions.mjs imports nothing electron), no server.
//
// Run:  node scripts/test-tool-namespacing.mjs
// =============================================================================

import {
  CAPABILITY_TOOL_NAMES,
  CLIENT_APPS,
  CLIENT_APP_TOOL_NAMES,
  TOOL_CLASSES,
  capabilityForTool,
  capabilityToolNames,
  setPluginCapabilityProvider,
} from '../electron/main/tools-definitions.mjs'

// ---------------------------------------------------------------------------
// Harness (mirrors scripts/test-tool-policy.mjs)
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

// Prefixes reserved for client applications (docs/tool-namespacing.md). A Nest
// capability tool must never take one of these.
const APP_PREFIXES = ['fs_', 'twig_', 'ys_', 'bp_', 'gh_']

const nestToolNames = new Set(Object.values(CAPABILITY_TOOL_NAMES).flat())
const clientToolNames = Object.values(CLIENT_APP_TOOL_NAMES).flat()

console.log('\n-- tool namespacing (ban targetability) --')

await test('🔍 no client-app tool name collides with a Nest capability tool name', async () => {
  const collisions = clientToolNames.filter((n) => nestToolNames.has(n))
  assert(
    collisions.length === 0,
    `${collisions.join(', ')} exist(s) on BOTH a client app and a Nest capability — a ban on either would strip both, and precedence between them is undefined`,
  )
  return `${clientToolNames.length} client tools vs ${nestToolNames.size} Nest tools`
})

await test('every client-app tool carries a reserved app prefix', async () => {
  for (const app of CLIENT_APPS) {
    for (const name of app.toolNames) {
      assert(
        APP_PREFIXES.some((p) => name.startsWith(p)),
        `"${name}" (app: ${app.id}) has no app prefix — a ban on it cannot be distinguished from a ban on a Nest tool of the same name`,
      )
    }
  }
})

await test('no Nest capability tool takes a reserved app prefix', async () => {
  for (const name of nestToolNames) {
    const stolen = APP_PREFIXES.find((p) => name.startsWith(p))
    assert(
      !stolen,
      `Nest tool "${name}" uses the client-app prefix "${stolen}" — that prefix is reserved so bans stay targetable`,
    )
  }
})

await test('client-app tool names are unique across apps', async () => {
  const seen = new Map()
  for (const app of CLIENT_APPS) {
    for (const name of app.toolNames) {
      const owner = seen.get(name)
      assert(!owner, `"${name}" is claimed by both ${owner} and ${app.id}`)
      seen.set(name, app.id)
    }
  }
})

await test('every registered client app has an id, a name, a description and at least one tool', async () => {
  for (const app of CLIENT_APPS) {
    assert(typeof app.id === 'string' && app.id, 'a client app is missing an id')
    assert(typeof app.name === 'string' && app.name, `${app.id} is missing a display name`)
    assert(typeof app.description === 'string' && app.description, `${app.id} is missing a description`)
    assert(Array.isArray(app.toolNames) && app.toolNames.length > 0, `${app.id} registers no tools`)
  }
  return `${CLIENT_APPS.length} app(s)`
})

await test('a client-app id does not shadow a capability id', async () => {
  for (const app of CLIENT_APPS) {
    assert(
      !CAPABILITY_TOOL_NAMES[app.id],
      `client app id "${app.id}" is also a capability id — expandDisabledToolIds resolves capabilities first, so the app could never be banned`,
    )
  }
})

console.log('\n-- installed plugins (T21 / plan Test plan: "namespace collision does not displace a built-in") --')

// plugin-registry.mjs owns this constant (it imports `app` from electron, so
// this pure suite cannot import it directly) — mirrored here as a literal.
// If the two ever drift, test-plugin-registry.mjs's namespacing assertions
// would catch it independently.
const NAMESPACE_SEPARATOR = '__'

await test('🔍 a plugin capability injected via setPluginCapabilityProvider is namespaced and collides with nothing', async () => {
  // Mirrors what plugin-registry.mjs's pluginCapabilities() hands to this
  // module at runtime: { [pluginId]: { toolNames, classes } }. Exercising the
  // injection point directly (rather than going through the registry) keeps
  // this suite electron-free while still proving the real collision surface —
  // capabilityToolNames() merging plugin names in beside the built-ins.
  setPluginCapabilityProvider(() => ({
    memory: {
      toolNames: [`memory${NAMESPACE_SEPARATOR}create_entities`, `memory${NAMESPACE_SEPARATOR}read_graph`],
      classes: { [`memory${NAMESPACE_SEPARATOR}create_entities`]: 'write' },
    },
  }))
  try {
    const merged = capabilityToolNames()
    assert(Array.isArray(merged.memory), 'the injected plugin is missing from capabilityToolNames()')
    for (const name of merged.memory) {
      assert(!nestToolNames.has(name), `plugin tool "${name}" collides with a built-in Nest tool name`)
      assert(!clientToolNames.includes(name), `plugin tool "${name}" collides with a client-app tool name`)
      assert(capabilityForTool(name) === 'memory', `capabilityForTool("${name}") did not resolve back to "memory"`)
    }
    return `${merged.memory.length} namespaced tool(s), no collision`
  } finally {
    setPluginCapabilityProvider(null) // restore the no-plugins default
  }
})

await test('a plugin id equal to a reserved client-app prefix stem still produces tool names outside that prefix\'s literal set', async () => {
  // "fs" is not itself a reserved id anywhere in the registry validator, but
  // "fs__read_file" *starts with* the reserved "fs_" prefix (single
  // underscore) — because "fs__" begins with "fs_". Ban targetability is only
  // actually at risk if that produces a NAME COLLISION with a real fs_* tool,
  // which double-underscore namespacing prevents: no fs_* client tool contains
  // "__", so no plugin tool can ever equal one exactly.
  setPluginCapabilityProvider(() => ({
    fs: { toolNames: [`fs${NAMESPACE_SEPARATOR}read_file`], classes: {} },
  }))
  try {
    const merged = capabilityToolNames()
    assert(!clientToolNames.includes(merged.fs[0]), `"${merged.fs[0]}" exactly collided with a client-app tool name`)
  } finally {
    setPluginCapabilityProvider(null)
  }
})

console.log('\n-- provenance lookup --')

await test('every Nest capability tool resolves to its capability', async () => {
  for (const [capability, names] of Object.entries(CAPABILITY_TOOL_NAMES)) {
    for (const name of names) {
      assert(
        capabilityForTool(name) === capability,
        `capabilityForTool("${name}") returned ${capabilityForTool(name)}, expected ${capability}`,
      )
    }
  }
})

await test('client-app tools resolve to NO capability', async () => {
  // The chat-ui suppresses server-side file tools by capability id. If a Twig
  // tool claimed the file_system capability, Twig's own tools would suppress
  // themselves and the local filesystem would silently stop working.
  for (const name of clientToolNames) {
    assert(
      capabilityForTool(name) === null,
      `client-app tool "${name}" resolves to capability ${capabilityForTool(name)}`,
    )
  }
})

await test('the web tools belong to no capability (the whitelist governs them)', async () => {
  for (const name of ['web_fetch', 'web_search']) {
    assert(capabilityForTool(name) === null, `${name} unexpectedly maps to a capability`)
  }
  // They are still classified, since the class annotation covers every tool.
  assert(TOOL_CLASSES.web_fetch === 'network', 'web_fetch lost its network classification')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
