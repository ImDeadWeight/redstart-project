// =============================================================================
// network-mode.mjs — the LAN state machine (TLS plan C2b)
// =============================================================================
// Tables of (inputs) → state and (state, state) → steps, plus an exhaustive
// check over EVERY pair of states that simulates the steps one at a time and
// asserts nothing unsafe is ever true in between:
//
//   - Caddy and the port-80 proxy never run at once (both want :80);
//   - Caddy never runs while the gateway is on 0.0.0.0 (a LAN client could
//     go around it in the clear);
//   - a firewall rule is never added before its listener is up, except
//     Caddy's program-scoped rule, which is always added BEFORE Caddy first
//     starts (so Windows never shows its own alert for caddy.exe);
//   - stopping never binds or starts anything.
//
// Run:  node scripts/test-network-mode.mjs
// =============================================================================

import {
  targetState, factsFor, planSteps, appliedFacts, next, INITIAL_FACTS, STATES, LOOPBACK, WILDCARD, LEADING_RULES,
} from '../daemon/network-mode.mjs'

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

const BASE = Object.freeze({
  networkMode: true, tlsMode: 'own', caddyFailed: false, requireHttps: false, serving: false,
  caddyKey: 'k1', stopping: false, platform: 'win32', gatewayPort: 19080,
})
const inp = (over = {}) => ({ ...BASE, ...over })
const ops = (steps) => steps.map((s) => s.op + (s.host ? `(${s.host})` : '') + (s.rule ? `(${s.rule})` : '') + ('serving' in s ? `(serving=${s.serving})` : '')).join(' → ')

console.log('\n-- inputs → state --')

test('🔍 the target-state table', () => {
  const rows = [
    [{ networkMode: false }, 'local'],
    [{ networkMode: false, tlsMode: 'redstart' }, 'local'],
    [{ tlsMode: 'off' }, 'lan-http'],
    [{ tlsMode: 'bogus' }, 'lan-http'],
    [{ tlsMode: 'own' }, 'lan-https'],
    [{ tlsMode: 'redstart' }, 'lan-https'],
    [{ tlsMode: 'own', caddyFailed: true }, 'lan-https-fallback'],
    [{ tlsMode: 'own', caddyFailed: true, requireHttps: true }, 'lan-https'],
    [{ tlsMode: 'off', caddyFailed: true }, 'lan-http'],
    [{ stopping: true }, 'stopping'],
    [{ stopping: true, networkMode: false }, 'stopping'],
    [{ stopping: true, caddyFailed: true }, 'stopping'],
  ]
  for (const [over, want] of rows) {
    const got = targetState(inp(over))
    assert(got === want, `${JSON.stringify(over)} → ${got}, want ${want}`)
  }
  return `${rows.length} rows`
})

console.log('\n-- facts per state --')

test('🔍 lan-https puts the data plane on loopback, with Caddy and no port-80 proxy', () => {
  const f = factsFor('lan-https', inp({ serving: true }))
  assert(f.host === LOOPBACK && !f.port80Proxy && f.caddy?.serving === true, JSON.stringify(f))
  assert(JSON.stringify(f.firewall) === '["caddy"]', `firewall ${f.firewall}`)
})

test('lan-http is today\'s behaviour: wildcard, port-80 proxy on Windows only, never on port 80', () => {
  assert(factsFor('lan-http', inp()).port80Proxy === true, 'win32')
  assert(factsFor('lan-http', inp({ platform: 'linux' })).port80Proxy === false, 'linux')
  assert(factsFor('lan-http', inp({ gatewayPort: 80 })).port80Proxy === false, 'gateway on 80')
  assert(factsFor('lan-http', inp()).host === WILDCARD, 'host')
})

test('fallback: wildcard, no Caddy, no port-80 proxy', () => {
  const f = factsFor('lan-https-fallback', inp())
  assert(f.host === WILDCARD && !f.caddy && !f.port80Proxy, JSON.stringify(f))
})

console.log('\n-- specific transitions --')

const at = (state, over = {}) => appliedFacts(INITIAL_FACTS, factsFor(state, inp(over)))

test('🔍 lan-http → lan-https: proxy stops, data plane narrows, then the Caddy rule, THEN Caddy starts', () => {
  const got = ops(next(at('lan-http'), inp()).steps)
  assert(got === 'port80:stop → dataplane:bind(127.0.0.1) → firewall:ensure(caddy) → caddy:start(serving=false)', got)
})

test('🔍 lan-https → lan-http: Caddy stops, THEN the data plane widens, then the proxy', () => {
  const got = ops(next(at('lan-https'), inp({ tlsMode: 'off' })).steps)
  assert(got === 'caddy:stop → dataplane:bind(0.0.0.0) → port80:start → firewall:ensure(gateway) → firewall:ensure(mcp) → firewall:ensure(port80)', got)
})

test('🔍 Caddy gives up: lan-https → fallback stops it and widens; the rules were already ensured once', () => {
  const from = appliedFacts(at('lan-http'), factsFor('lan-https', inp()))   // came via lan-http
  const got = ops(next(from, inp({ caddyFailed: true })).steps)
  assert(got === 'caddy:stop → dataplane:bind(0.0.0.0)', got)
})

test('🔍 the failed latch under requireHttps does not thrash: no steps at all', () => {
  const from = at('lan-https')
  const r = next(from, inp({ caddyFailed: true, requireHttps: true }))
  assert(r.state === 'lan-https' && r.steps.length === 0, ops(r.steps))
})

test('a retry (new caddyKey) from fallback narrows and starts Caddy again', () => {
  const got = ops(next(at('lan-https-fallback'), inp({ caddyKey: 'k2' })).steps)
  assert(got === 'dataplane:bind(127.0.0.1) → firewall:ensure(caddy) → caddy:start(serving=false)', got)
})

test('🔍 HTTPS starts serving: only Caddy is reconfigured (:80 becomes the redirect)', () => {
  const got = ops(next(at('lan-https'), inp({ serving: true })).steps)
  assert(got === 'caddy:start(serving=true)', got)
})

test('a Caddy config change (new name, provider) restarts Caddy and nothing else', () => {
  const got = ops(next(at('lan-https'), inp({ caddyKey: 'k9' })).steps)
  assert(got === 'caddy:start(serving=false)', got)
})

test('local → lan-https never binds wide, never starts the port-80 proxy', () => {
  const got = ops(next(INITIAL_FACTS, inp()).steps)
  assert(got === 'firewall:ensure(caddy) → caddy:start(serving=false)', got)
})

test('🔍 stopping from every state: releases only, no bind, no start, no firewall', () => {
  for (const s of STATES) {
    const steps = next(at(s), inp({ stopping: true })).steps
    assert(steps.every((x) => x.op === 'caddy:stop' || x.op === 'port80:stop'), `${s}: ${ops(steps)}`)
  }
})

test('idempotent: the same inputs twice give no steps the second time', () => {
  for (const over of [{ networkMode: false }, { tlsMode: 'off' }, {}, { caddyFailed: true }, { serving: true }]) {
    const first = next(INITIAL_FACTS, inp(over))
    const again = next(appliedFacts(INITIAL_FACTS, first.facts), inp(over))
    assert(again.steps.length === 0, `${JSON.stringify(over)}: ${ops(again.steps)}`)
  }
})

console.log('\n-- every pair of states, simulated step by step --')

/** Variants of each state, so pairs cover serving/key differences too. */
const VARIANTS = {
  local: [{ networkMode: false }],
  'lan-http': [{ tlsMode: 'off' }, { tlsMode: 'off', platform: 'linux' }],
  'lan-https': [{}, { serving: true }, { caddyKey: 'k2' }],
  'lan-https-fallback': [{ caddyFailed: true }],
  stopping: [{ stopping: true }],
}
const ALL = Object.entries(VARIANTS).flatMap(([s, vs]) => vs.map((v) => ({ s, v })))

function simulate(from, steps) {
  const w = { host: from.host, port80: from.port80Proxy, caddy: !!from.caddy, rules: new Set(from.firewall) }
  const listening = { gateway: () => w.host === WILDCARD, mcp: () => w.host === WILDCARD, port80: () => w.port80, caddy: () => w.caddy }
  const check = (where) => {
    assert(!(w.caddy && w.port80), `${where}: Caddy and the port-80 proxy both running (both want :80)`)
    assert(!(w.caddy && w.host === WILDCARD), `${where}: Caddy running while the gateway is on 0.0.0.0 (LAN can go around it)`)
  }
  check('start')
  steps.forEach((st, n) => {
    const where = `step ${n + 1} ${st.op}`
    if (st.op === 'caddy:stop') w.caddy = false
    else if (st.op === 'port80:stop') w.port80 = false
    else if (st.op === 'dataplane:bind') w.host = st.host
    else if (st.op === 'port80:start') w.port80 = true
    else if (st.op === 'caddy:start') {
      assert(w.rules.has('caddy'), `${where}: Caddy started before its firewall rule (Windows would raise its own alert)`)
      w.caddy = true
    } else if (st.op === 'firewall:ensure') {
      if (LEADING_RULES.has(st.rule)) assert(!w.caddy, `${where}: rule ${st.rule} added after Caddy was already up`)
      else assert(listening[st.rule]?.(), `${where}: rule ${st.rule} added before its listener is up`)
      w.rules.add(st.rule)
    } else throw new Error(`unknown op ${st.op}`)
    check(where)
  })
  return w
}

test('🔍 no unsafe moment in any transition between any two states', () => {
  let pairs = 0
  for (const a of ALL) {
    // Every "from" is reached the way the daemon reaches it: from boot.
    const fromFacts = appliedFacts(INITIAL_FACTS, factsFor(a.s, inp(a.v)))
    for (const b of ALL) {
      const r = next(fromFacts, inp(b.v))
      try {
        const w = simulate(fromFacts, r.steps)
        const want = r.facts
        if (want.host) assert(w.host === want.host, `ended on host ${w.host}, want ${want.host}`)
        assert(w.port80 === want.port80Proxy && w.caddy === !!want.caddy, 'did not end in the target facts')
      } catch (err) {
        throw new Error(`${a.s} ${JSON.stringify(a.v)} → ${b.s} ${JSON.stringify(b.v)}: ${err.message} [${ops(r.steps)}]`)
      }
      pairs++
    }
  }
  return `${pairs} transitions`
})

test('🔍 every step list is releases → bind → starts → firewall, in that order (the Caddy rule just ahead of Caddy)', () => {
  const rank = { 'caddy:stop': 0, 'port80:stop': 0, 'dataplane:bind': 1, 'port80:start': 2, 'caddy:start': 2.5, 'firewall:ensure': 3 }
  const rankOf = (st) => (st.op === 'firewall:ensure' && LEADING_RULES.has(st.rule) ? 2.4 : rank[st.op])
  for (const a of ALL) for (const b of ALL) {
    const steps = next(appliedFacts(INITIAL_FACTS, factsFor(a.s, inp(a.v))), inp(b.v)).steps
    for (let i = 1; i < steps.length; i++) {
      assert(rankOf(steps[i - 1]) <= rankOf(steps[i]), `${a.s} → ${b.s}: ${ops(steps)}`)
    }
  }
})

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
