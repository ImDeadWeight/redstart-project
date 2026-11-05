// =============================================================================
// Update feed: which release Nest updates to
// =============================================================================
// update-feed.mjs replaces electron-updater's GitHub release discovery (see
// its header for why that cannot tell Nest from Twig). Getting the choice
// wrong costs in two directions. Too eager means a downgrade, a stable
// install pulled onto an alpha, or a release that has no Nest manifest. Too
// strict means installs that never update. Both are tested here, along with
// the one piece of config the module has to agree with: the channel name
// electron-builder writes the manifest under.
//
// No network: findUpdateRelease takes a fetch stub.
//
// Run:  node scripts/test-update-feed.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  UPDATE_CHANNEL,
  compareVersions,
  feedUrlForTag,
  findUpdateRelease,
  parseVersion,
  pickUpdateRelease,
  shouldAutoUpdate,
} from '../electron/main/update-feed.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
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

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const cmp = (a, b) => Math.sign(compareVersions(parseVersion(a), parseVersion(b)))

/** A GitHub release as the list endpoint returns it, trimmed to what is read. */
function release(tag, { draft = false, assets = ['nest.yml', 'twig.yml'] } = {}) {
  return { tag_name: tag, draft, prerelease: true, assets: assets.map((name) => ({ name })) }
}

console.log('\n-- version precedence --')

await test('🔍 alpha.10 outranks alpha.9 (numeric, not string, comparison)', () => {
  assert(cmp('1.0.0-alpha.10', '1.0.0-alpha.9') === 1, 'alpha.10 should be newer')
})

await test('a release outranks every prerelease of the same core', () => {
  assert(cmp('1.0.0', '1.0.0-alpha.99') === 1, '1.0.0 > 1.0.0-alpha.99')
  assert(cmp('1.0.0-rc.1', '1.0.0') === -1, '1.0.0-rc.1 < 1.0.0')
})

await test('the core version decides before the prerelease does', () => {
  assert(cmp('1.0.1-alpha.1', '1.0.0') === 1, '1.0.1-alpha.1 > 1.0.0')
  assert(cmp('1.2.0', '1.10.0') === -1, '1.2.0 < 1.10.0')
})

await test('semver §11 identifier rules: numeric below alphanumeric, shorter below longer', () => {
  assert(cmp('1.0.0-alpha.1', '1.0.0-alpha.beta') === -1, 'numeric id ranks below alphanumeric')
  assert(cmp('1.0.0-alpha', '1.0.0-alpha.1') === -1, 'fewer ids ranks lower')
  assert(cmp('1.0.0-alpha.5', '1.0.0-beta.1') === -1, 'alpha < beta')
  assert(cmp('1.0.0-alpha.5', 'v1.0.0-alpha.5') === 0, 'a leading v is the same version')
})

await test('what parseVersion will not read', () => {
  for (const bad of ['', 'latest', '1.0', '1.0.0-', '1.0.0-alpha..1', '1.0.0+build.1', null, 5]) {
    assert(parseVersion(bad) === null, `${JSON.stringify(bad)} should not parse`)
  }
})

console.log('\n-- 🔍 picking the release --')

await test('the newest qualifying release wins, whatever order the list is in', () => {
  const picked = pickUpdateRelease(
    [release('1.0.0-alpha.7'), release('1.0.0-alpha.9'), release('1.0.0-alpha.8')],
    { currentVersion: '1.0.0-alpha.5' },
  )
  assert(picked?.tag === '1.0.0-alpha.9', `picked ${JSON.stringify(picked)}`)
  assert(picked.version === '1.0.0-alpha.9', 'version is reported without decoration')
})

await test('🔍 a release with no Nest manifest is skipped, not chosen with nothing to read', () => {
  // The release that predates the updater, and one carrying only Twig's manifest.
  const picked = pickUpdateRelease(
    [release('1.0.0-alpha.9', { assets: ['twig.yml'] }), release('1.0.0-alpha.8', { assets: [] }), release('1.0.0-alpha.7')],
    { currentVersion: '1.0.0-alpha.5' },
  )
  assert(picked?.tag === '1.0.0-alpha.7', `picked ${JSON.stringify(picked)}`)
})

await test('🔍 the same version, or an older one, is never an update (no downgrades)', () => {
  const releases = [release('1.0.0-alpha.5'), release('1.0.0-alpha.4'), release('0.9.0')]
  assert(pickUpdateRelease(releases, { currentVersion: '1.0.0-alpha.5' }) === null, 'nothing newer than alpha.5')
})

await test('🔍 a stable install never moves onto a prerelease', () => {
  const releases = [release('1.1.0-alpha.1'), release('1.0.1')]
  const picked = pickUpdateRelease(releases, { currentVersion: '1.0.0' })
  assert(picked?.tag === '1.0.1', `picked ${JSON.stringify(picked)}`)
  assert(pickUpdateRelease([release('1.1.0-alpha.1')], { currentVersion: '1.0.0' }) === null, 'no stable candidate means no update')
})

await test('an alpha install does move onto the stable release', () => {
  const picked = pickUpdateRelease([release('1.0.0')], { currentVersion: '1.0.0-alpha.12' })
  assert(picked?.tag === '1.0.0', `picked ${JSON.stringify(picked)}`)
})

await test('drafts and unparseable tags are skipped', () => {
  const releases = [release('1.0.0-alpha.9', { draft: true }), release('nightly'), release('tqp-v0.4.0'), release('1.0.0-alpha.6')]
  const picked = pickUpdateRelease(releases, { currentVersion: '1.0.0-alpha.5' })
  assert(picked?.tag === '1.0.0-alpha.6', `picked ${JSON.stringify(picked)}`)
})

await test('a garbage response, or a running version that will not parse, picks nothing', () => {
  assert(pickUpdateRelease({ message: 'API rate limit exceeded' }, { currentVersion: '1.0.0-alpha.5' }) === null, 'object, not array')
  assert(pickUpdateRelease([null, 42, {}], { currentVersion: '1.0.0-alpha.5' }) === null, 'junk entries')
  assert(pickUpdateRelease([release('1.0.0-alpha.9')], { currentVersion: 'dev' }) === null, 'unparseable current')
})

await test('the channel decides which manifest is required', () => {
  const releases = [release('1.0.0-alpha.9', { assets: ['twig.yml'] })]
  assert(pickUpdateRelease(releases, { currentVersion: '1.0.0-alpha.5', channel: 'twig' })?.tag === '1.0.0-alpha.9', 'twig finds twig.yml')
  assert(pickUpdateRelease(releases, { currentVersion: '1.0.0-alpha.5' }) === null, 'nest does not')
})

console.log('\n-- findUpdateRelease: one fetch, never a throw --')

await test('a successful lookup returns the release and its feed directory', async () => {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return { ok: true, status: 200, json: async () => [release('1.0.0-alpha.6')] }
  }
  const { release: found, error } = await findUpdateRelease({ currentVersion: '1.0.0-alpha.5', userAgent: 'Redstart-Nest/test', fetchImpl })
  assert(!error, `unexpected error ${error}`)
  assert(found?.feedUrl === 'https://github.com/ImDeadWeight/redstart-project/releases/download/1.0.0-alpha.6/', `feedUrl ${found?.feedUrl}`)
  assert(seen.url.startsWith('https://api.github.com/repos/ImDeadWeight/redstart-project/releases'), `asked ${seen.url}`)
  assert(seen.init.headers['User-Agent'] === 'Redstart-Nest/test', 'GitHub requires a User-Agent')
})

await test('a rate limit, a network failure or bad JSON all come back as "no update" with a reason', async () => {
  const cases = [
    async () => ({ ok: false, status: 403, json: async () => ({}) }),
    async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com') },
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }),
  ]
  for (const fetchImpl of cases) {
    const result = await findUpdateRelease({ currentVersion: '1.0.0-alpha.5', userAgent: 'x', fetchImpl })
    assert(result.release === null && typeof result.error === 'string' && result.error.length > 0, `got ${JSON.stringify(result)}`)
  }
})

await test('a tag is URL-encoded into the feed path', () => {
  assert(feedUrlForTag('a b/c').endsWith('/download/a%20b%2Fc/'), feedUrlForTag('a b/c'))
})

console.log('\n-- 🔍 the manifest name agrees with the build config --')

await test('electron-builder writes the manifest this module looks for', () => {
  const config = JSON.parse(fs.readFileSync(path.join(here, '..', 'electron-builder.json'), 'utf8'))
  const publish = config.win?.publish
  assert(publish && !Array.isArray(publish), 'electron-builder.json needs a single win.publish entry')
  assert(publish.provider === 'generic', `win.publish.provider is ${publish.provider}; the GitHub provider cannot tell Nest from Twig`)
  assert(publish.channel === UPDATE_CHANNEL, `win.publish.channel is ${publish.channel}, update-feed.mjs reads ${UPDATE_CHANNEL}.yml`)
  // A top-level publish would also emit nest-mac.yml, and nothing reads that yet.
  assert(config.publish == null, 'publish belongs under win only until macOS updates exist')
  return `${UPDATE_CHANNEL}.yml`
})

await test('🔍 the installer name has no spaces, so the manifest URL matches the uploaded asset', () => {
  // GitHub rewrites spaces in asset names when they are uploaded. The generic
  // provider resolves the manifest's path verbatim, unlike the GitHub
  // provider, which rewrites spaces as well. A space would mean a 404 on
  // every download.
  const config = JSON.parse(fs.readFileSync(path.join(here, '..', 'electron-builder.json'), 'utf8'))
  const name = config.nsis?.artifactName
  assert(typeof name === 'string', 'nsis.artifactName must be set (the default contains spaces)')
  // ${productName} is "Redstart Nest", so the name has to be spelled out.
  const expanded = name.replaceAll('${productName}', config.productName)
  assert(!/\s/.test(expanded), `"${name}" expands to "${expanded}", which contains a space`)
  return expanded
})

console.log('\n-- 🔍 when the updater runs, and when it installs --')

await test('only a packaged Windows build checks for updates', () => {
  assert(shouldAutoUpdate({ isPackaged: true, platform: 'win32', settings: {} }) === true, 'packaged Windows')
  assert(shouldAutoUpdate({ isPackaged: false, platform: 'win32', settings: {} }) === false, 'a dev run must never update itself')
  assert(shouldAutoUpdate({ isPackaged: true, platform: 'darwin', settings: {} }) === false, 'macOS needs a Developer ID first')
  assert(shouldAutoUpdate({ isPackaged: true, platform: 'linux', settings: {} }) === false, 'linux has no installer')
})

await test('on unless settings say autoUpdate: false; a missing or unreadable file is "on"', () => {
  assert(shouldAutoUpdate({ isPackaged: true, platform: 'win32', settings: { autoUpdate: false } }) === false, 'switched off')
  assert(shouldAutoUpdate({ isPackaged: true, platform: 'win32', settings: { autoUpdate: true } }) === true, 'switched on')
  assert(shouldAutoUpdate({ isPackaged: true, platform: 'win32', settings: null }) === true, 'no settings file')
})

// auto-update.mjs imports electron-updater, which cannot load under plain
// Node. So the invariant "an update installs only on a deliberate quit" is
// checked in the source, which is where it would be broken.
await test('🔍 an update never installs on an ordinary app quit (OS shutdown, logoff, crash)', () => {
  const src = fs.readFileSync(path.join(here, '..', 'electron', 'main', 'auto-update.mjs'), 'utf8')
  assert(/autoUpdater\.autoInstallOnAppQuit\s*=\s*false/.test(src), 'auto-update.mjs must set autoInstallOnAppQuit = false')
  assert(/await waitForPidsExit\(/.test(src) && src.indexOf('await waitForPidsExit(') < src.indexOf('autoUpdater.quitAndInstall('),
    'installAndQuit must wait for the children before it starts the installer')
  const index = fs.readFileSync(path.join(here, '..', 'electron', 'main', 'index.mjs'), 'utf8')
  assert(!/quitAndInstall|electron-updater/.test(index), 'index.mjs must go through auto-update.mjs, not drive electron-updater itself')
  return 'autoInstallOnAppQuit off, children awaited before NSIS'
})

console.log('\n' + '='.repeat(60))
const passed = results.filter((r) => r.pass).length
console.log(`${passed}/${results.length} passed`)
console.log('='.repeat(60) + '\n')
if (passed !== results.length) process.exit(1)
