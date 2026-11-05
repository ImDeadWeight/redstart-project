'use strict'

// =============================================================================
// Redstart Nest: which release, if any, is the update
// =============================================================================
// electron-updater ships a GitHub provider. It cannot be used here, for two
// reasons, both read from its source (electron-updater 6.8.9,
// providers/GitHubProvider.js):
//
//   1. Nest and Twig publish into ONE GitHub release. Each app needs its own
//      update manifest (nest.yml, twig.yml). With a custom channel name the
//      provider's tag scan matches only tags whose prerelease id is "alpha",
//      "beta" or the channel itself. Every tag here is X.Y.Z-alpha.N, so
//      channel "nest" never finds a release.
//   2. Even when it does find a tag, it replaces the channel with the tag's
//      own prerelease id and fetches alpha.yml. Both apps would write that.
//
// So this module chooses the release, and electron-updater's generic provider
// is pointed at that release's download directory. Everything after the
// choice is still electron-updater's: fetching nest.yml, the sha512 check,
// the blockmap differential download, and running the installer.
//
// No Electron import. This file is pure selection logic plus one fetch, and
// scripts/test-update-feed.mjs runs it under plain Node.
// =============================================================================

/** Where releases are published. .github/workflows/release.yml cuts them. */
export const UPDATE_REPO = Object.freeze({ owner: 'ImDeadWeight', repo: 'redstart-project' })

/**
 * The update manifest's base name for this app. The release writes
 * `${UPDATE_CHANNEL}.yml` (scripts/make-shell-manifests.mjs) for Electron-era
 * installs, and scripts/test-update-feed.mjs checks the two agree.
 */
export const UPDATE_CHANNEL = 'nest'

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/**
 * Parse a semver version (a tag may carry a leading "v"). Build metadata is
 * not accepted. No tag in this repo has ever carried any, and a version this
 * parser does not understand is one an update should skip, not guess at.
 *
 * @param {string} text
 * @returns {{ core: number[], pre: Array<string|number>, text: string } | null}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const m = VERSION_RE.exec(text.trim())
  if (!m) return null
  const pre = m[4] == null
    ? []
    : m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
  if (pre.some((id) => id === '')) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre, text: text.trim().replace(/^v/, '') }
}

/**
 * Semver precedence (semver.org §11). Negative, zero or positive, like a
 * sort comparator. Takes parseVersion() results.
 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  }
  // A release outranks every prerelease of the same core: 1.0.0 > 1.0.0-alpha.9.
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === y) continue
    const xNum = typeof x === 'number'
    const yNum = typeof y === 'number'
    // Numeric identifiers compare numerically, which is the reason this is not
    // a string compare: alpha.10 must outrank alpha.9.
    if (xNum && yNum) return x - y
    if (xNum) return -1
    if (yNum) return 1
    return x < y ? -1 : 1
  }
  return a.pre.length - b.pre.length
}

/**
 * Pick the release to update to from a GitHub "list releases" response.
 *
 * A release qualifies when:
 *   - it is not a draft;
 *   - its tag is a version parseVersion() understands;
 *   - it carries this app's manifest: `${channel}.yml` for electron-updater,
 *     or the name the caller passes (the Tauri shell asks for
 *     `nest-latest.json`). Releases cut before the updater existed have
 *     none, and neither does one that is still uploading;
 *   - it is newer than the running version. A stable install never moves to
 *     a prerelease. Every release so far is an alpha, so that rule only
 *     matters once one is not.
 *
 * GitHub's own "prerelease" flag is ignored. The version is the authority,
 * because the release workflow marks every alpha as a prerelease and that
 * flag would otherwise hide all of them.
 *
 * @param {Array<{ tag_name?: string, draft?: boolean, assets?: Array<{ name?: string }> }>} releases
 * @param {{ currentVersion: string, channel?: string, manifest?: string }} opts
 * @returns {{ tag: string, version: string } | null}
 */
export function pickUpdateRelease(releases, { currentVersion, channel = UPDATE_CHANNEL, manifest = `${channel}.yml` }) {
  const current = parseVersion(currentVersion)
  if (!current || !Array.isArray(releases)) return null
  let best = null
  for (const release of releases) {
    if (!release || release.draft) continue
    const version = parseVersion(release.tag_name)
    if (!version) continue
    if (!(release.assets ?? []).some((asset) => asset?.name === manifest)) continue
    if (current.pre.length === 0 && version.pre.length > 0) continue
    if (compareVersions(version, current) <= 0) continue
    if (best && compareVersions(version, best.version) <= 0) continue
    best = { tag: release.tag_name, version }
  }
  return best ? { tag: best.tag, version: best.version.text } : null
}

/**
 * The directory electron-updater's generic provider reads `${channel}.yml`
 * from, and resolves the installer and blockmap against. GitHub redirects
 * each download to its asset store, and electron-updater follows the redirect.
 */
export function feedUrlForTag(tag, repo = UPDATE_REPO) {
  return `https://github.com/${repo.owner}/${repo.repo}/releases/download/${encodeURIComponent(tag)}/`
}

/** Newest first, which is GitHub's own order for this endpoint. */
export function releasesApiUrl(repo = UPDATE_REPO) {
  return `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=30`
}

/**
 * Ask GitHub which release is the update. One unauthenticated API call. The
 * limit is 60 an hour per IP, and Nest checks a few times a day.
 *
 * Never throws: an unreachable network, a rate limit or a malformed response
 * all mean "no update this time", and the reason comes back for the log.
 *
 * @param {{ currentVersion: string, channel?: string, manifest?: string, userAgent: string,
 *           fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<{ release: { tag: string, version: string, feedUrl: string } | null, error?: string }>}
 */
export async function findUpdateRelease({
  currentVersion, channel = UPDATE_CHANNEL, manifest = `${channel}.yml`, userAgent, fetchImpl = fetch, timeoutMs = 15_000,
}) {
  try {
    const res = await fetchImpl(releasesApiUrl(), {
      // GitHub rejects API requests without a User-Agent.
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { release: null, error: `GitHub answered ${res.status}` }
    const picked = pickUpdateRelease(await res.json(), { currentVersion, channel, manifest })
    return { release: picked ? { ...picked, feedUrl: feedUrlForTag(picked.tag) } : null }
  } catch (err) {
    return { release: null, error: err?.message ?? String(err) }
  }
}
