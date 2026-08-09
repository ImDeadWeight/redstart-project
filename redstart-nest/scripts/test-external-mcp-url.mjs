// =============================================================================
// External MCP endpoint validation — the registry's only entry point.
// =============================================================================
// An external MCP server is a weaker trust boundary than a built-in provider:
// its tools are executed by CLIENTS, so the MCP-side permission gate never sees
// them, and it is trusted to describe its own tools to the model.
//
// Registration is IPC-only, so adding one already requires physical access to
// the host. That is the real control, and it is why this validator refuses only
// what is incoherent or self-defeating and WARNS about the rest — an admin at
// the console is allowed to point Nest at a plaintext LAN appliance, which is a
// documented use case. A validator that refused it would block the feature.
//
// The distinction under test is therefore refuse-vs-warn, not just reject.
//
// Run:  node scripts/test-external-mcp-url.mjs
// =============================================================================

import { validateExternalMcpUrl } from '../electron/main/external-mcp-url.mjs'

const GATEWAY_PORT = 19080

const results = []

function test(name, fn) {
  try {
    const detail = fn()
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

const check = (url) => validateExternalMcpUrl(url, GATEWAY_PORT)

// ---------------------------------------------------------------------------

console.log('\n-- refusals --')

test('🔍 non-http(s) schemes are refused', () => {
  const schemes = [
    'file:///C:/Windows/win.ini',
    'ftp://example.com/sse',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'ws://example.com/sse',
  ]
  for (const url of schemes) {
    const v = check(url)
    assert(!v.ok, `accepted: ${url}`)
  }
  return `${schemes.length} schemes`
})

test('malformed input is refused rather than thrown on', () => {
  for (const url of ['', '   ', 'not a url', 'http://', null, undefined, 42, {}]) {
    const v = validateExternalMcpUrl(url, GATEWAY_PORT)
    assert(v && v.ok === false, `did not refuse: ${JSON.stringify(url)}`)
    assert(typeof v.error === 'string' && v.error.length > 0, `no error message for ${JSON.stringify(url)}`)
  }
  return 'empty / garbage / non-string'
})

test("🔍 Nest's own ports are refused — no self-referential tool source", () => {
  const own = [
    `http://127.0.0.1:${GATEWAY_PORT}/sse`,      // the gateway
    `http://localhost:${GATEWAY_PORT + 1}/sse`,  // llama-server
    `http://127.0.0.1:${GATEWAY_PORT + 2}/sse`,  // the built-in MCP server
  ]
  for (const url of own) {
    const v = check(url)
    assert(!v.ok, `accepted our own port: ${url}`)
    assert(/Redstart Nest's own/.test(v.error), `unhelpful error for ${url}: ${v.error}`)
  }
  return '3 own ports'
})

test('the port check follows the configured port, not a hardcoded one', () => {
  const v = validateExternalMcpUrl('http://127.0.0.1:9002/sse', 9000)
  assert(!v.ok, 'a shifted MCP port (configured+2) was not recognised as ours')
  const stillFine = validateExternalMcpUrl('http://127.0.0.1:19082/sse', 9000)
  assert(stillFine.ok, 'a port that is NOT ours under this config was wrongly refused')
  return 'derived from gatewayPort'
})

// ---------------------------------------------------------------------------

console.log('\n-- accepted, with warnings --')

test('🔍 a LAN appliance over plaintext HTTP is ALLOWED — it is the documented use case', () => {
  const v = check('http://10.0.0.5:9000/sse')
  assert(v.ok, `refused a documented configuration: ${v.error}`)
  assert(!v.warnings.some(w => /unencrypted/i.test(w)),
    'a private-network host should not draw a plaintext warning')
  return 'no refusal, no plaintext warning'
})

test('🔍 a REMOTE plaintext endpoint is allowed but warns about both egress and encryption', () => {
  const v = check('http://tools.example.com/sse')
  assert(v.ok, 'an admin at the console may register a remote server')
  assert(v.isRemote === true, 'not flagged as remote')
  assert(v.warnings.some(w => /unencrypted/i.test(w)), 'no plaintext warning')
  assert(v.warnings.some(w => /egress/i.test(w)), 'no egress warning')
  return `${v.warnings.length} warnings`
})

test('a remote HTTPS endpoint warns about egress but not encryption', () => {
  const v = check('https://tools.example.com/sse')
  assert(v.ok, 'refused a valid HTTPS endpoint')
  assert(!v.warnings.some(w => /unencrypted/i.test(w)), 'warned about plaintext on an HTTPS URL')
  assert(v.warnings.some(w => /egress/i.test(w)), 'no egress warning for a remote host')
  return 'egress only'
})

test('a path that is not /sse draws a hint, not a refusal', () => {
  const v = check('http://10.0.0.5:9000/mcp')
  assert(v.ok, 'refused on path alone')
  assert(v.warnings.some(w => /\/sse/.test(w)), 'no hint about the SSE path')
  return 'hint offered'
})

test('a loopback endpoint on a NON-Nest port is allowed', () => {
  const v = check('http://127.0.0.1:9000/sse')
  assert(v.ok, `refused a legitimate local MCP server: ${v.error}`)
  assert(v.isRemote === false, 'loopback should not count as remote egress')
  return 'local tool servers still work'
})

// ---------------------------------------------------------------------------

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
