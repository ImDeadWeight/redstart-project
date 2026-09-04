'use strict'

// =============================================================================
// Redstart Nest — what this build is
// =============================================================================
// Phase 8A.6, for trap 5.7: "client and daemon can now differ in version."
// Until 8A there was one process, so the question could not arise; the browser
// admin panel is still served BY the daemon and therefore always matches. What
// changes is that a daemon can now run somewhere else entirely, and a client
// pointed at it has no way to know whether they agree.
//
// TWO numbers, and the second is the one that matters:
//
//   app          the human-facing release, from package.json. Good for a
//                support conversation, useless for compatibility — two builds
//                can share a version and differ in what they serve.
//
//   apiRevision  a digest of the control-plane method names the daemon
//                actually registered. THIS is what a client's expectations
//                are against: a method added to ipc/transport.mjs's table is
//                exactly what an older client will call and get a 404 for, and
//                a method removed is what a newer client will call on an older
//                daemon. Derived from the live table rather than hand-bumped,
//                because a version number someone has to remember to increment
//                is a version number that silently stops being true.
//
// Deliberately NOT a build hash or a timestamp: those change on every rebuild
// and would report skew between two daemons that behave identically, which
// trains people to ignore the warning.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let cachedVersion = null

/**
 * The release version, from package.json.
 *
 * Read lazily and cached. Never throws: a status readout that 500s because it
 * could not find its own package.json would take out the endpoint an admin
 * uses to find out what is wrong.
 */
export function appVersion() {
  if (cachedVersion !== null) return cachedVersion
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'))
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    cachedVersion = 'unknown'
  }
  return cachedVersion
}

/**
 * A stable digest of a control-plane API surface.
 *
 * Sorted, so the order handlers happen to be spread into the table cannot
 * change it — only the SET of methods can. Short because it is an identity to
 * compare, not a checksum to verify: two daemons either report the same string
 * or they do not.
 *
 * @param {string[]} channels the registered method names
 */
export function apiRevisionOf(channels) {
  const sorted = [...channels].sort()
  return crypto.createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 12)
}
