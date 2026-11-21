// =============================================================================
// firewall.mjs — one UAC prompt for every rule a launch needs, and it names
// Redstart (2026-11-20)
// =============================================================================
// The daemon used to elevate netsh once per rule, so UAC asked about "Network
// Shell" several times and never named Redstart. Under the desktop shell the
// missing rules now go to the shell in ONE request, and the shell elevates
// itself (shell/src/firewall.rs, whose own unit tests pin what the elevated
// side accepts). This suite pins the daemon's half, on any OS, with the
// existence check faked:
//
//   - requests made together go to the elevator together, once;
//   - a rule that already exists is never sent (no prompt on a normal start);
//   - each request resolves to whether the rule exists AFTERWARDS, checked
//     again here rather than taken from the elevated side's word;
//   - a declined prompt resolves false and never rejects;
//   - off Windows nothing is asked for at all.
//
// Run:  node scripts/test-firewall.mjs
// =============================================================================

import {
  ensureInboundRule, ensureFirewallRule, ensureCaddyFirewallRule, setFirewallElevator, _setFirewallTestHooks, RULE_SUFFIX,
} from '../daemon/firewall.mjs'

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

/** A fake firewall: a set of rule names, and an elevator that may add to it. */
function world({ present = [], decline = false } = {}) {
  const rules = new Set(present)
  const calls = []
  _setFirewallTestHooks({ platform: 'win32', exists: async (name) => rules.has(name) })
  setFirewallElevator(async (batch) => {
    calls.push(batch.map((r) => r.name))
    if (decline) throw new Error('The administrator prompt was declined')
    for (const r of batch) rules.add(r.name)
    return { exitCode: 0 }
  })
  return { rules, calls }
}

const gw = (port) => `RedstartNest Gateway ${port}${RULE_SUFFIX}`
const CADDY = `RedstartNest Caddy HTTPS+admin${RULE_SUFFIX}`

await test('🔍 a launch\'s rules, requested together, reach the shell as ONE request', async () => {
  const w = world()
  const got = await Promise.all([ensureFirewallRule(19080), ensureFirewallRule(19082), ensureFirewallRule(80)])
  assert(got.every((x) => x === true), JSON.stringify(got))
  assert(w.calls.length === 1 && w.calls[0].length === 3, JSON.stringify(w.calls))
  return `${w.calls[0].length} rules, 1 prompt`
})

await test('🔍 a rule that already exists is never sent: a normal start prompts for nothing', async () => {
  const w = world({ present: [gw(19080), gw(19082)] })
  const got = await Promise.all([ensureFirewallRule(19080), ensureFirewallRule(19082)])
  assert(got.every((x) => x === true) && w.calls.length === 0, JSON.stringify(w.calls))
})

await test('only the missing rules are sent', async () => {
  const w = world({ present: [gw(19080)] })
  await Promise.all([ensureFirewallRule(19080), ensureFirewallRule(19082)])
  assert(JSON.stringify(w.calls) === JSON.stringify([[gw(19082)]]), JSON.stringify(w.calls))
})

await test('the same rule asked for twice is sent once, and both callers get the answer', async () => {
  const w = world()
  const got = await Promise.all([ensureFirewallRule(19080), ensureFirewallRule(19080)])
  assert(got.every((x) => x === true) && w.calls.length === 1 && w.calls[0].length === 1, JSON.stringify(w.calls))
})

await test('🔍 a declined prompt resolves false and never rejects', async () => {
  const w = world({ decline: true })
  const got = await ensureCaddyFirewallRule('C:\\Nest\\resources\\bin\\caddy.exe')
  assert(got === false && w.calls.length === 1 && !w.rules.has(CADDY), String(got))
})

await test('🔍 the answer is re-checked, not taken from the elevated side', async () => {
  const w = world()
  // The helper "succeeds" but the rule never appears (netsh refused it).
  setFirewallElevator(async (batch) => { w.calls.push(batch.map((r) => r.name)); return { exitCode: 0 } })
  const got = await ensureFirewallRule(19080)
  assert(got === false && w.calls.length === 1, String(got))
})

await test('Caddy\'s rule names caddy.exe and its three ports', async () => {
  let sent = null
  _setFirewallTestHooks({ platform: 'win32', exists: async () => false })
  setFirewallElevator(async (batch) => { sent = batch })
  await ensureCaddyFirewallRule('C:\\Nest\\resources\\bin\\caddy.exe')
  assert(sent?.length === 1 && sent[0].name === CADDY && sent[0].port === '80,443,8443' && sent[0].program === 'C:\\Nest\\resources\\bin\\caddy.exe', JSON.stringify(sent))
})

await test('🔍 off Windows nothing is checked or asked for', async () => {
  let asked = 0
  _setFirewallTestHooks({ platform: 'linux', exists: async () => { asked++; return false } })
  setFirewallElevator(async () => { asked++ })
  const got = await ensureInboundRule({ name: gw(19080), protocol: 'TCP', port: 19080 })
  assert(got === false && asked === 0, `asked ${asked}`)
})

_setFirewallTestHooks()
setFirewallElevator(null)

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
