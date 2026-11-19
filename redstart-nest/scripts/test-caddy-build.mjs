// =============================================================================
// The bundled Caddy's build: pinned, reproducible, never mistaken for an update
// =============================================================================
// TLS plan C1. .github/workflows/caddy.yml builds the Caddy binary Nest ships
// as its TLS front door. That binary holds the DNS token and terminates every
// LAN connection, so what goes into it is checked here rather than trusted:
//
//   - every input is an exact version (no @latest, no floating Go);
//   - the three plugins are the ones the plan names, each pinned;
//   - the build is pure Go (CGO_ENABLED=0) with -trimpath;
//   - a published tag is never replaced;
//   - the release can never look like an app update to either updater;
//   - the provenance parser reads `go version -m` correctly.
//
// Reads only source text: no build, no network.
//
// Run:  node scripts/test-caddy-build.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVersion, pickUpdateRelease } from '../../shared/update-feed.mjs'
import { parseGoVersionM, provenanceRecord, CADDY_MODULE } from './caddy-provenance.mjs'
import { buildNotices, escapeModulePath } from './caddy-notices.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(__dirname, '..', '..')
const WORKFLOW = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'caddy.yml'), 'utf8')

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

/** A top-level `env:` value from the workflow (two-space indent). */
function envValue(name) {
  const m = new RegExp(`^  ${name}: *(\\S+) *$`, 'm').exec(WORKFLOW)
  return m ? m[1] : null
}

console.log('\n-- .github/workflows/caddy.yml --')

test('🔍 Go, xcaddy and Caddy are exact versions', () => {
  const go = envValue('GO_VERSION')
  const xcaddy = envValue('XCADDY_VERSION')
  const caddy = envValue('CADDY_VERSION')
  assert(/^\d+\.\d+\.\d+$/.test(go ?? ''), `GO_VERSION must be x.y.z, got ${go}`)
  assert(/^v\d+\.\d+\.\d+$/.test(xcaddy ?? ''), `XCADDY_VERSION must be vX.Y.Z, got ${xcaddy}`)
  assert(/^v2\.\d+\.\d+$/.test(caddy ?? ''), `CADDY_VERSION must be v2.Y.Z, got ${caddy}`)
  assert(/^\d+$/.test(envValue('BUILD') ?? ''), 'BUILD must be a plain integer')
  return `go ${go}, xcaddy ${xcaddy}, caddy ${caddy}`
})

test('🔍 nothing is installed or built @latest', () => {
  assert(!/@latest\b/.test(WORKFLOW), 'an @latest reference makes the build unreproducible')
  assert(/go install "github\.com\/caddyserver\/xcaddy\/cmd\/xcaddy@\$\{XCADDY_VERSION\}"/.test(WORKFLOW),
    'xcaddy must be installed at ${XCADDY_VERSION} (review R7)')
  assert(/xcaddy build "\$CADDY_VERSION"/.test(WORKFLOW), 'xcaddy build must name $CADDY_VERSION')
  assert(/go-version: \$\{\{ env\.GO_VERSION \}\}/.test(WORKFLOW), 'setup-go must use GO_VERSION')
})

test('🔍 exactly the planned DNS modules: two pinned plugins + Redstart\'s own duckdns', () => {
  const plugins = {
    PLUGIN_DESEC: 'github.com/caddy-dns/desec',
    PLUGIN_ACMEDNS: 'github.com/caddy-dns/acmedns',
  }
  for (const [name, mod] of Object.entries(plugins)) {
    const v = envValue(name)
    assert(v && v.startsWith(`${mod}@`), `${name} must be ${mod}@<version>, got ${v}`)
    assert(/@v\d+\.\d+\.\d+$/.test(v), `${name} must pin an exact tag, got ${v}`)
    assert(WORKFLOW.includes(`--with "$${name}"`), `${name} is defined but not built in`)
  }
  // Redstart's own modules are built from this checkout, never fetched.
  const local = envValue('LOCAL_DUCKDNS')
  assert(local === 'github.com/ImDeadWeight/redstart-project/infra/caddy-dns-duckdns=./infra/caddy-dns-duckdns',
    `LOCAL_DUCKDNS must replace the module with ./infra/caddy-dns-duckdns, got ${local}`)
  const withs = [...WORKFLOW.matchAll(/--with "\$(\w+)"/g)].map((m) => m[1]).sort()
  const expected = [...Object.keys(plugins), 'LOCAL_DUCKDNS'].sort()
  assert(JSON.stringify(withs) === JSON.stringify(expected),
    `a plugin was added without this test knowing (every plugin is code beside the DNS token): ${withs.join(', ')}`)
})

test('🔍 the unlicensed community duckdns plugin is never built in again', () => {
  // caddy-dns/duckdns publishes no license (found 2026-11-19); BUILD 1 carried it.
  assert(!/github\.com\/caddy-dns\/duckdns/.test(WORKFLOW.replace(/^\s*#.*$/gm, '')), 'caddy-dns/duckdns is back in caddy.yml')
  const goMod = fs.readFileSync(path.join(REPO, 'infra', 'caddy-dns-duckdns', 'go.mod'), 'utf8')
  assert(!/caddy-dns\/duckdns/.test(goMod), 'infra/caddy-dns-duckdns depends on caddy-dns/duckdns')
  assert(/^\s*github\.com\/libdns\/duckdns v\d+\.\d+\.\d+$/m.test(goMod), 'infra/caddy-dns-duckdns must pin libdns/duckdns (MIT)')
  assert(fs.existsSync(path.join(REPO, 'infra', 'caddy-dns-duckdns', 'go.sum')), 'infra/caddy-dns-duckdns has no go.sum')
})

test("🔍 Redstart's own module is verified, vetted and tested before the build", () => {
  const t = WORKFLOW.indexOf('working-directory: infra/caddy-dns-duckdns')
  const b = WORKFLOW.indexOf('xcaddy build')
  assert(t > 0 && t < b, 'no test step before the build')
  const step = WORKFLOW.slice(t, b)
  for (const cmd of ['go mod verify', 'go vet ./...', 'go test ./...']) assert(step.includes(cmd), `missing ${cmd}`)
  assert(/- infra\/caddy-dns-\*\/\*\*/.test(WORKFLOW), 'a change to the module does not trigger a build')
})

test('🔍 license notices are generated for every binary, and the build fails without them', () => {
  assert(/caddy-notices\.mjs --modcache "\$\(go env GOMODCACHE\)"/.test(WORKFLOW), 'no notices step')
  assert(/--commit "\$GITHUB_SHA" out\/\*\.json/.test(WORKFLOW), 'notices are not generated for every binary')
  const notices = WORKFLOW.indexOf('caddy-notices.mjs')
  const sums = WORKFLOW.indexOf('> SHA256SUMS')
  assert(notices > 0 && notices < sums, 'notices must exist before SHA256SUMS is written, so they are hashed too')
})

test('🔍 pure Go, trimmed paths, the three shipped targets', () => {
  assert(/CGO_ENABLED: '0'/.test(WORKFLOW), 'CGO_ENABLED must be 0')
  assert(/XCADDY_GO_BUILD_FLAGS: "-trimpath /.test(WORKFLOW), 'the build must pass -trimpath')
  for (const t of ['windows/amd64', 'darwin/arm64', 'linux/amd64']) {
    assert(WORKFLOW.includes(t), `target ${t} is not built`)
  }
})

test('🔍 the build is smoke-tested for its plugins before publishing', () => {
  for (const m of ['dns.providers.duckdns', 'dns.providers.desec', 'dns.providers.acmedns']) {
    assert(WORKFLOW.includes(m), `list-modules check does not look for ${m}`)
  }
  assert(/list-modules/.test(WORKFLOW), 'no list-modules smoke')
  assert(/caddy-provenance\.mjs --xcaddy "\$XCADDY_VERSION"/.test(WORKFLOW), 'no provenance step')
  assert(/SHA256SUMS/.test(WORKFLOW), 'no SHA256SUMS')
})

test('🔍 a published tag is never replaced', () => {
  const publish = WORKFLOW.slice(WORKFLOW.indexOf('\n  publish:'))
  const view = publish.indexOf('gh release view "$TAG"')
  const create = publish.indexOf('gh release create "$TAG"')
  assert(view > 0 && create > view, 'publish must check for the tag before creating it')
  assert(/exit 0\n\s+fi/.test(publish.slice(view, create)), 'an existing tag must stop the job')
  assert(!/--clobber|gh release (upload|delete|edit)/.test(publish), 'publish must not overwrite or edit a release')
})

test('🔍 contents: write is granted only to the publish job', () => {
  const head = WORKFLOW.slice(0, WORKFLOW.indexOf('\njobs:'))
  assert(/permissions:\n  contents: read/.test(head), 'the workflow default must be contents: read')
  const build = WORKFLOW.slice(WORKFLOW.indexOf('\n  build:'), WORKFLOW.indexOf('\n  publish:'))
  assert(!/contents: write/.test(build), 'the build job must not be able to write to the repo')
})

console.log('\n-- the release never looks like an app update --')

test('🔍 the tag is not a version, so update-feed skips it', () => {
  const tag = `caddy-redstart-${envValue('CADDY_VERSION')}-${envValue('BUILD')}`
  assert(/tag=caddy-redstart-\$\{CADDY_VERSION\}-\$\{BUILD\}/.test(WORKFLOW), 'the tag format changed without this test')
  assert(parseVersion(tag) === null, `parseVersion accepts ${tag}`)
  // Even carrying a manifest by accident, it is never chosen.
  const releases = [{ tag_name: tag, draft: false, assets: [{ name: 'nest-latest.json' }, { name: 'twig-latest.json' }] }]
  assert(pickUpdateRelease(releases, { currentVersion: '0.1.0-alpha.1', manifest: 'nest-latest.json' }) === null, 'Nest would update to it')
  assert(pickUpdateRelease(releases, { currentVersion: '0.1.0-alpha.1', manifest: 'twig-latest.json' }) === null, 'Twig would update to it')
  return tag
})

test('🔍 published as a prerelease, never "latest"', () => {
  assert(/--prerelease --latest=false/.test(WORKFLOW), 'gh release create must pass --prerelease --latest=false')
})

console.log('\n-- caddy-provenance.mjs --')

const SAMPLE = [
  'out/caddy-redstart-v2.11.9-1-windows-amd64.exe: go1.27.4',
  '\tpath\tcaddy',
  '\tmod\tcaddy\t(devel)\t',
  `\tdep\t${CADDY_MODULE}\tv2.11.9\th1:abc=`,
  '\tdep\tgithub.com/caddy-dns/duckdns\tv0.5.0\th1:def=',
  '\tdep\tgithub.com/libdns/libdns\tv1.1.1\th1:ghi=',
  '\t=>\tgithub.com/example/libdns\tv1.1.2\th1:jkl=',
  '\tbuild\t-buildmode=exe',
  '\tbuild\t-trimpath=true',
  '\tbuild\tCGO_ENABLED=0',
  '\tbuild\tGOARCH=amd64',
  '\tbuild\tGOOS=windows',
  '\tbuild\t-ldflags=-w -s',
  '',
].join('\n')

test('parses the head line, modules, replacements and settings', () => {
  const info = parseGoVersionM(SAMPLE)
  assert(info.go === 'go1.27.4', `go: ${info.go}`)
  assert(info.path === 'caddy', `path: ${info.path}`)
  assert(info.deps.length === 3, `deps: ${info.deps.length}`)
  assert(info.deps[1].sum === 'h1:def=', 'go.sum hash not kept')
  assert(info.deps[2].replacedBy?.path === 'github.com/example/libdns', 'replacement not attached to the module before it')
  assert(info.settings.CGO_ENABLED === '0' && info.settings.GOOS === 'windows', 'settings')
  assert(info.settings['-ldflags'] === '-w -s', 'a setting with spaces must survive')
})

test('the record names Caddy, the target and the hash', () => {
  const r = provenanceRecord({ info: parseGoVersionM(SAMPLE), xcaddy: 'v0.4.7', file: 'x.exe', sha256: 'ff' })
  assert(r.caddy === 'v2.11.9' && r.xcaddy === 'v0.4.7' && r.go === 'go1.27.4', 'versions')
  assert(r.target.os === 'windows' && r.target.arch === 'amd64' && r.cgo === '0', 'target')
  assert(r.sha256 === 'ff' && r.modules.length === 3, 'hash / modules')
})

test('refuses a binary that is not a Caddy build, and text that is not go version -m', () => {
  const notCaddy = SAMPLE.replace(CADDY_MODULE, 'github.com/other/server')
  let threw = false
  try { provenanceRecord({ info: parseGoVersionM(notCaddy), xcaddy: 'v0', file: 'x', sha256: '' }) } catch { threw = true }
  assert(threw, 'a non-Caddy binary got a provenance record')
  threw = false
  try { parseGoVersionM('go: no such file') } catch { threw = true }
  assert(threw, 'an error message parsed as build info')
  threw = false
  try { parseGoVersionM(SAMPLE.replace('\tbuild\tGOOS', '\tweird\tGOOS')) } catch { threw = true }
  assert(threw, 'an unknown line kind was silently dropped')
})

console.log('\n-- caddy-notices.mjs --')

/** A fake module cache: { '<dir>': { '<file>': '<text>' } }. */
function fakeFs(tree) {
  return {
    readdir: (dir) => { const d = tree[path.normalize(dir)]; if (!d) throw new Error('ENOENT'); return Object.keys(d) },
    readFile: (file) => tree[path.dirname(path.normalize(file))][path.basename(file)],
  }
}

const MC = path.join('mc')
const RECORD = {
  file: 'caddy.exe', caddy: 'v2.11.9', go: 'go1.27.4', xcaddy: 'v0.4.7',
  modules: [
    { path: 'github.com/caddyserver/caddy/v2', version: 'v2.11.9' },
    { path: 'github.com/BurntSushi/toml', version: 'v1.5.0' },
    { path: 'github.com/ImDeadWeight/redstart-project/infra/caddy-dns-duckdns', version: 'v0.0.0', replacedBy: { path: path.resolve('repo', 'infra', 'caddy-dns-duckdns'), version: '(devel)' } },
  ],
}
const TREE = {
  [path.join(MC, 'github.com', 'caddyserver', 'caddy', 'v2@v2.11.9')]: { LICENSE: 'Apache License 2.0', 'go.mod': '' },
  [path.join(MC, 'github.com', '!burnt!sushi', 'toml@v1.5.0')]: { COPYING: 'MIT', 'decode.go': '' },
}

test('module paths use the cache\'s case encoding', () => {
  assert(escapeModulePath('github.com/BurntSushi/toml') === 'github.com/!burnt!sushi/toml', escapeModulePath('github.com/BurntSushi/toml'))
})

test('every module gets its license files; a module in this repo is covered by its LICENSE', () => {
  const { text, missing, count } = buildNotices({ record: RECORD, modcache: MC, repoRoot: 'repo', commit: 'abc', ...fakeFs(TREE) })
  assert(missing.length === 0, `missing: ${missing.join(', ')}`)
  assert(count === 3, `count ${count}`)
  assert(text.includes('Apache License 2.0') && text.includes('--- COPYING ---\nMIT'), 'license text not copied')
  assert(/infra\/caddy-dns-duckdns\), covered by the repository's LICENSE/.test(text), 'local module not attributed to the repo')
  assert(text.includes('/tree/abc/infra/caddy-dns-duckdns'), 'local module source link has no commit')
  assert(!text.includes('decode.go'), 'a non-license file was copied')
})

test('🔍 a module with no license file is reported, so the build fails', () => {
  const rec = { ...RECORD, modules: [...RECORD.modules, { path: 'github.com/caddy-dns/duckdns', version: 'v0.5.0' }] }
  const tree = { ...TREE, [path.join(MC, 'github.com', 'caddy-dns', 'duckdns@v0.5.0')]: { 'duckdns.go': '', 'README.md': '' } }
  const { missing } = buildNotices({ record: rec, modcache: MC, repoRoot: 'repo', commit: 'abc', ...fakeFs(tree) })
  assert(JSON.stringify(missing) === JSON.stringify(['github.com/caddy-dns/duckdns v0.5.0']), JSON.stringify(missing))
})

test('🔍 a module replaced by a directory outside this repo is not waved through', () => {
  const rec = { ...RECORD, modules: [{ path: 'x/y', version: 'v1', replacedBy: { path: path.resolve('elsewhere', 'y'), version: '(devel)' } }] }
  const { missing } = buildNotices({ record: rec, modcache: MC, repoRoot: 'repo', commit: 'abc', ...fakeFs(TREE) })
  assert(missing.length === 1 && /outside this repository/.test(missing[0]), JSON.stringify(missing))
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
