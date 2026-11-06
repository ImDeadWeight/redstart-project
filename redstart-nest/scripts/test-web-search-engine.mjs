// =============================================================================
// web_search source "web" — a general search engine, and OFF that is real.
// =============================================================================
// chat-tooling plan Phase 4b, decision D1: open web search ships off by
// default, and turning it off must mean the model CANNOT reach the engine,
// not that a toggle is unticked. Four places, each asserted here:
//
//   1. schema  — with no engine, "web" is absent from web_search's source enum
//   2. call    — a tools/call naming "web" anyway is refused, no request made
//   3. role    — allowWebSearchEngine:false forces it off; nothing turns it on
//   4. prompt  — no claim about the engine unless "web" survived into the schema
//
// "No request made" is measured, not inferred: a stub SearXNG counts every hit
// and global fetch is wrapped to record every outbound URL.
//
// Plus the adapters (pure request building and parsing), whitelist filtering,
// and that the Brave key never appears in anything the model or /egress sees.
//
// Run:  node scripts/test-web-search-engine.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-websearch-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const engines = await import('../daemon/web-search-engines.mjs')
const webTool = await import('../daemon/web-fetch-tool.mjs')
const { narrowConfig, DENY_ALL } = await import('../daemon/permissions.mjs')
const { composePrompt, deriveEgressFacts } = await import('../daemon/system-prompt.mjs')
const { BUILTIN_ROLES } = await import('../daemon/roles-storage.mjs')

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

// Every http(s) URL in a block of text, parsed. Assertions compare parsed
// hosts and hrefs, never substrings: "contains en.wikipedia.org" is also true
// of en.wikipedia.org.evil.example.
function urlsIn(text) {
  return [...String(text).matchAll(/https?:\/\/[^\s)\]>"']+/g)]
    .map((m) => { try { return new URL(m[0]) } catch { return null } })
    .filter(Boolean)
}
const hostOf = (u) => { try { return new URL(u).hostname } catch { return null } }
function assert(cond, message) { if (!cond) throw new Error(message) }

// ---------------------------------------------------------------------------
// Stub SearXNG — counts hits, serves a fixed mixed-domain result list
// ---------------------------------------------------------------------------

let stubHits = 0
let stubStatus = 200
const STUB_RESULTS = [
  { title: 'Wiki <b>page</b>', url: 'https://en.wikipedia.org/wiki/Redstart', content: 'A small <em>bird</em> &amp; more' },
  { title: 'Random blog', url: 'https://blog.example.net/post', content: 'x'.repeat(1000) },
  { title: 'Evil link', url: 'javascript:alert(1)', content: 'should be dropped' },
  { title: 'MDN', url: 'https://developer.mozilla.org/en-US/docs/Web', content: 'Docs' },
  ...Array.from({ length: 12 }, (_, i) => ({ title: `Filler ${i}`, url: `https://filler${i}.example.org/`, content: '' })),
]
const stub = http.createServer((req, res) => {
  stubHits++
  const u = new URL(req.url, 'http://x')
  res.writeHead(stubStatus, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ query: u.searchParams.get('q'), results: STUB_RESULTS }))
})
await new Promise(r => stub.listen(0, '127.0.0.1', r))
const SEARXNG_URL = `http://127.0.0.1:${stub.address().port}/`

// Every outbound fetch, recorded. Brave's endpoint is hardcoded, so its case
// is answered here rather than by the network.
const realFetch = globalThis.fetch
const outbound = []
globalThis.fetch = async (url, init) => {
  outbound.push({ url: String(url), headers: init?.headers || {} })
  if (String(url).startsWith('https://api.search.brave.com/')) {
    return new Response(JSON.stringify({ web: { results: [
      { title: 'Brave hit', url: 'https://en.wikipedia.org/wiki/Brave', description: '<strong>bold</strong> text' },
    ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return realFetch(url, init)
}

const SEARXNG = { kind: 'searxng', url: SEARXNG_URL }
const BRAVE_KEY = 'BSA-secret-key-do-not-leak'
const BRAVE = { kind: 'brave', apiKey: BRAVE_KEY }

function cfg({ engine = { kind: 'none' }, whitelistEnabled = false, allowed = [] } = {}) {
  return {
    webFetch: {
      enabled: true,
      whitelistEnabled,
      allowedBaseUrls: allowed,
      activeTools: allowed.map((baseUrl, i) => ({ id: `src${i}`, name: `src${i}`, baseUrl, description: '' })),
      maxFetchTokens: 500,
      searchEngine: engine,
    },
  }
}

function sourceEnum(config) {
  const def = webTool.toolDefs(config).find(d => d.name === 'web_search')
  return def ? def.inputSchema.properties.source.enum : []
}
const callWeb = (config, query = 'redstart bird') =>
  webTool.callTool('web_search', { source: 'web', query }, config, { account: null })
const textOf = r => r?.content?.[0]?.text ?? ''

// ---------------------------------------------------------------------------
// Adapters — pure
// ---------------------------------------------------------------------------

console.log('\n-- adapters --')

await test('resolveEngine: unchosen, unknown, or unconfigured all resolve to none', async () => {
  const none = (c, conn) => engines.resolveEngine(c, conn).kind === 'none'
  assert(none(undefined, {}), 'absent choice was not none')
  assert(none('google', { searxngUrl: SEARXNG_URL }), 'an unknown engine name resolved')
  assert(none('searxng', {}), 'SearXNG with no URL resolved')
  assert(none('searxng', { searxngUrl: 'file:///etc/passwd' }), 'a non-http SearXNG URL resolved')
  assert(none('brave', { braveApiKey: '' }), 'Brave with no key resolved')
  assert(engines.resolveEngine('searxng', { searxngUrl: SEARXNG_URL }).kind === 'searxng', 'configured SearXNG did not resolve')
  return 'off is the fail direction'
})

await test('SearXNG request: /search under the base path, format=json, query encoded', async () => {
  const { url } = engines.buildRequest({ kind: 'searxng', url: 'http://search.lan/searx' }, 'a&b c', 8)
  const u = new URL(url)
  assert(u.pathname === '/searx/search', `path was ${u.pathname}`)
  assert(u.searchParams.get('format') === 'json', 'format=json missing')
  assert(u.searchParams.get('q') === 'a&b c', 'query not round-tripped intact')
})

await test('Brave request: fixed endpoint, key in the header only, count clamped to 1..20', async () => {
  const { url, headers } = engines.buildRequest(BRAVE, 'q', 99)
  assert(url.startsWith('https://api.search.brave.com/res/v1/web/search?'), 'endpoint moved')
  assert(new URL(url).searchParams.get('count') === '20', 'count not clamped')
  assert(headers['X-Subscription-Token'] === BRAVE_KEY, 'key not sent')
  assert(!url.includes(BRAVE_KEY), 'key leaked into the URL')
})

await test('🔍 parsing: non-http URLs dropped, tags stripped, snippets capped', async () => {
  const parsed = engines.parseResults(SEARXNG, { results: STUB_RESULTS })
  assert(parsed.every(r => ['http:', 'https:'].includes(new URL(r.url).protocol)), 'a non-http(s) URL survived')
  // The two ways a strip-then-decode, single-pass cleaner hands back a tag.
  for (const hostile of ['&lt;script&gt;alert(1)&lt;/script&gt;', '<scr<b>ipt>alert(1)</scr</b>ipt>', '<<b>img src=x onerror=alert(1)>']) {
    const out = engines.cleanSnippet(hostile)
    assert(!/[<>]/.test(out), `markup survived cleanSnippet(${JSON.stringify(hostile)}): ${JSON.stringify(out)}`)
  }
  assert(parsed[0].title === 'Wiki page' && parsed[0].snippet === 'A small bird & more', `tags/entities not cleaned: ${JSON.stringify(parsed[0])}`)
  assert(parsed[1].snippet.length <= engines.SNIPPET_MAX_CHARS, `snippet not capped: ${parsed[1].snippet.length}`)
  return `${parsed.length} kept of ${STUB_RESULTS.length}`
})

// ---------------------------------------------------------------------------
// D1.1 — schema
// ---------------------------------------------------------------------------

console.log('\n-- D1.1 off strips "web" from the schema --')

await test('🔍 no engine: "web" is absent from the source enum and the description', async () => {
  for (const config of [cfg(), cfg({ whitelistEnabled: true, allowed: ['https://en.wikipedia.org'] }), { webFetch: { ...cfg().webFetch, searchEngine: undefined } }]) {
    assert(!sourceEnum(config).includes('web'), 'web advertised with no engine')
    const def = webTool.toolDefs(config).find(d => d.name === 'web_search')
    assert(!def || !/general web search/.test(def.description), 'description mentions an engine that is off')
  }
  return 'stripped, not refused'
})

await test('engine on: "web" is in the enum, and the description says to fetch before quoting', async () => {
  const def = webTool.toolDefs(cfg({ engine: SEARXNG })).find(d => d.name === 'web_search')
  assert(def.inputSchema.properties.source.enum.includes('web'), 'web missing with an engine on')
  assert(/web_fetch a result before quoting/.test(def.description), 'no fetch-before-quoting guidance')
})

await test('Web Access disabled: no web_search at all, engine or not', async () => {
  const config = cfg({ engine: SEARXNG })
  config.webFetch.enabled = false
  assert(webTool.toolDefs(config).length === 0, 'web tools served with Web Access off')
})

// ---------------------------------------------------------------------------
// D1.2 — call path
// ---------------------------------------------------------------------------

console.log('\n-- D1.2 off is refused on the call path --')

await test('🔍 a call naming "web" with no engine is refused and makes NO request', async () => {
  const hits = stubHits, sent = outbound.length
  const r = await callWeb(cfg())
  assert(r.isError === true, 'a call to an off engine was not refused')
  assert(/Unknown or unavailable search source/.test(textOf(r)), `unexpected refusal: ${textOf(r)}`)
  assert(stubHits === hits && outbound.length === sent, 'a request left the server for an off engine')
  return 'refused, zero requests'
})

await test('engine on: the query reaches the stub and results come back with URLs + snippets', async () => {
  const hits = stubHits
  const r = await callWeb(cfg({ engine: SEARXNG }))
  assert(!r.isError, textOf(r))
  assert(stubHits === hits + 1, 'stub not called exactly once')
  assert(urlsIn(textOf(r)).some((u) => u.href === 'https://en.wikipedia.org/wiki/Redstart'), 'result URL missing')
  assert(/Use web_fetch on a URL to read the page before quoting it/.test(textOf(r)), 'trailer guidance missing')
})

await test('whitelist off: results capped at 8', async () => {
  const r = await callWeb(cfg({ engine: SEARXNG }))
  const count = (textOf(r).match(/ — https?:\/\//g) || []).length
  assert(count === 8, `expected 8 results, got ${count}`)
})

await test('🔍 whitelist on: only approved domains survive', async () => {
  const r = await callWeb(cfg({ engine: SEARXNG, whitelistEnabled: true, allowed: ['https://en.wikipedia.org'] }))
  const text = textOf(r)
  assert(urlsIn(text).some((u) => u.hostname === 'en.wikipedia.org'), 'the approved result was filtered out')
  assert(!/blog\.example\.net|developer\.mozilla\.org|filler/.test(text), 'a non-approved domain survived the whitelist')
  return 'a search across the whitelist'
})

await test('SearXNG without JSON enabled gets an error that says how to fix it', async () => {
  stubStatus = 403
  try {
    const r = await callWeb(cfg({ engine: SEARXNG }))
    assert(r.isError && /search\.formats/.test(textOf(r)), textOf(r))
  } finally { stubStatus = 200 }
})

await test('🔍 Brave: key goes in the header, never into the result text', async () => {
  const before = outbound.length
  const r = await callWeb(cfg({ engine: BRAVE }))
  const call = outbound.slice(before).find(o => hostOf(o.url) === 'api.search.brave.com')
  assert(call && call.headers['X-Subscription-Token'] === BRAVE_KEY, 'Brave not called with the key')
  assert(!textOf(r).includes(BRAVE_KEY), 'the API key reached the model')
  assert(textOf(r).includes('bold text'), 'Brave snippet not cleaned')
})

// ---------------------------------------------------------------------------
// D1.3 — role
// ---------------------------------------------------------------------------

console.log('\n-- D1.3 a role can turn it off, never on --')

await test('🔍 allowWebSearchEngine:false under an engine-on profile: stripped AND refused, zero requests', async () => {
  const narrowed = narrowConfig(cfg({ engine: SEARXNG }), { allowWebSearchEngine: false })
  assert(narrowed.webFetch.searchEngine.kind === 'none', 'role did not switch the engine off')
  assert(!sourceEnum(narrowed).includes('web'), 'web still in the schema after the role')
  const hits = stubHits, sent = outbound.length
  const r = await callWeb(narrowed)
  assert(r.isError === true, 'call not refused under the role')
  assert(stubHits === hits && outbound.length === sent, 'a request reached the engine under a role that forbids it')
})

await test('🔍 no role value turns an off engine on', async () => {
  for (const p of [{ allowWebSearchEngine: true }, { allowWebSearchEngine: 'searxng' }, { searchEngine: SEARXNG }, {}]) {
    assert(narrowConfig(cfg(), p).webFetch.searchEngine.kind === 'none', `role ${JSON.stringify(p)} enabled the engine`)
  }
})

await test('DENY_ALL and the built-in Restricted role both withhold the engine', async () => {
  assert(narrowConfig(cfg({ engine: BRAVE }), DENY_ALL).webFetch.searchEngine.kind === 'none', 'DENY_ALL left the engine on')
  const restricted = BUILTIN_ROLES.find(r => r.id === 'restricted')
  assert(narrowConfig(cfg({ engine: BRAVE }), restricted.permissions).webFetch.searchEngine.kind === 'none', 'Restricted left the engine on')
})

// ---------------------------------------------------------------------------
// D1.4 — prompt and egress agree with the schema
// ---------------------------------------------------------------------------

console.log('\n-- D1.4 prompt and /egress agree --')

const NOW = new Date('2026-11-05T12:00:00Z')

await test('🔍 engine off: no claim, no egress entry', async () => {
  const { prompt } = composePrompt({ config: cfg(), hasTools: true, toolNames: ['web_fetch', 'web_search'], now: NOW })
  assert(!/SearXNG|Brave|"web" source/.test(prompt), 'prompt mentions an engine that is off')
  assert(deriveEgressFacts(cfg(), [], true).webSearchEngine === null, 'egress reports an off engine')
})

await test('engine on: the claim names the engine and host; SearXNG on localhost is still egress', async () => {
  const config = cfg({ engine: SEARXNG })
  const { prompt } = composePrompt({ config, hasTools: true, toolNames: ['web_fetch', 'web_search'], now: NOW })
  assert(prompt.includes(`sends the query to SearXNG (127.0.0.1:${stub.address().port})`), 'claim does not name the engine')
  assert(/forwards them to the public search engines/.test(prompt), 'data_handling missing the upstream disclosure')
  const facts = deriveEgressFacts(config, [], true)
  assert(facts.hasEgress === true, 'a localhost SearXNG was reported as no egress')
})

await test('engine on but web_search not in this request: no capability claim', async () => {
  const { prompt } = composePrompt({ config: cfg({ engine: SEARXNG }), hasTools: true, toolNames: ['web_fetch'], now: NOW })
  assert(!/web_search's "web" source/.test(prompt), 'claimed a tool the request did not carry')
})

await test('🔍 the Brave key never appears in the prompt or the egress facts', async () => {
  const config = cfg({ engine: BRAVE })
  const { prompt } = composePrompt({ config, hasTools: true, toolNames: ['web_fetch', 'web_search'], now: NOW })
  assert(!prompt.includes(BRAVE_KEY), 'key in the prompt')
  assert(!JSON.stringify(deriveEgressFacts(config, [], true)).includes(BRAVE_KEY), 'key in /egress facts')
  // The prompt names the host in parentheses (system-prompt.mjs); matched as
  // that exact token, not as a substring of whatever host might contain it.
  assert(/\(api\.search\.brave\.com\)/.test(prompt), 'Brave host not disclosed')
})

// ---------------------------------------------------------------------------
// Config resolution — profile choice × global connection
// ---------------------------------------------------------------------------

console.log('\n-- buildGatewayConfig resolves the engine --')

const { buildGatewayConfig } = await import('../daemon/gateway-config.mjs')
const { setCapabilityConfig } = await import('../daemon/tools-storage.mjs')

await test('🔍 absent choice is off even with a connection configured; a chosen, configured engine is on', async () => {
  setCapabilityConfig('web_search', { searxngUrl: SEARXNG_URL })
  const base = { tools: { enabled: true, activeToolIds: [], activeGroupIds: [] } }
  assert(buildGatewayConfig(base).webFetch.searchEngine.kind === 'none', 'an engine came on with no profile choice')
  assert(buildGatewayConfig({ tools: { ...base.tools, webSearchEngine: 'brave' } }).webFetch.searchEngine.kind === 'none', 'Brave on with no key')
  const on = buildGatewayConfig({ tools: { ...base.tools, webSearchEngine: 'searxng' } }).webFetch.searchEngine
  assert(on.kind === 'searxng' && on.url === SEARXNG_URL, `SearXNG not resolved: ${JSON.stringify(on)}`)
  assert(buildGatewayConfig({ tools: { enabled: false, webSearchEngine: 'searxng' } }).webFetch.searchEngine.kind === 'none', 'tools-off profile had an engine')
})

console.log('\n-- admin config handler --')

const { setWebSearchConfig, getCapabilitiesConfig } = await import('../daemon/ipc/capabilities.mjs')
const noRefresh = { refreshLiveToolsConfig: () => {} }

await test('🔍 the SearXNG URL must be http(s); the Brave key is stored encrypted and never returned', async () => {
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
    assert(setWebSearchConfig({ searxngUrl: bad }, noRefresh).ok === false, `accepted ${bad}`)
  }
  assert(setWebSearchConfig({ searxngUrl: SEARXNG_URL, braveApiKey: BRAVE_KEY }, noRefresh).ok, 'valid config refused')
  const view = getCapabilitiesConfig().web_search
  assert(view.searxngUrl === SEARXNG_URL && view.hasBraveApiKey === true, `unexpected view ${JSON.stringify(view)}`)
  assert(!JSON.stringify(getCapabilitiesConfig()).includes(BRAVE_KEY), 'the key round-tripped to the renderer')
  const stored = fs.readFileSync(path.join(tmpDir, 'tools.json'), 'utf8')
  assert(!stored.includes(BRAVE_KEY), 'the key is stored in plaintext')
  const brave = buildGatewayConfig({ tools: { enabled: true, activeToolIds: [], activeGroupIds: [], webSearchEngine: 'brave' } }).webFetch.searchEngine
  assert(brave.kind === 'brave' && brave.apiKey === BRAVE_KEY, 'stored key did not decrypt into the resolved engine')
  // The re-key driver finds secrets by the `…Enc` naming convention. A key it
  // cannot see is a key a provider change silently destroys.
  const { findSecrets } = await import('../daemon/secrets-migration.mjs')
  const found = JSON.stringify(findSecrets(tmpDir))
  assert(found.includes('braveApiKeyEnc'), `the re-key walk does not see the Brave key: ${found.slice(0, 200)}`)
  assert(setWebSearchConfig({ clearBraveApiKey: true }, noRefresh).ok && getCapabilitiesConfig().web_search.hasBraveApiKey === false, 'key not cleared')
})

// ---------------------------------------------------------------------------

globalThis.fetch = realFetch
await new Promise(r => stub.close(r))
fs.rmSync(tmpDir, { recursive: true, force: true })

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed\n`)
if (passed !== results.length) process.exit(1)
