'use strict'

// =============================================================================
// Where the nest lives — one definition, shared by everything that needs it
// =============================================================================
// bin/nestd.mjs starts the daemon in a directory; scripts/daemon-stop.mjs has
// to find the SAME directory to read the pid file out of it. Two copies of
// this resolution order would eventually disagree, and the failure would look
// like "stop says the daemon is not running" while it plainly is.
//
// The flag names the NEST directory, not the config directory, because design
// section 3.5 requires two subtrees under it and they must not collapse into
// one (platform-paths.mjs refuses at startup if they overlap):
//
//   <nest dir>/config    Nest's own state, including the secret key
//   <nest dir>/data      user content: the folder-scoped capabilities
// =============================================================================

import * as os from 'node:os'
import * as path from 'node:path'

/**
 * A flag, then the environment, then a home-directory default. No platform
 * magic and no /var/lib guess: a service install passes the directory it wants
 * explicitly (deploy/ does exactly that), and a developer or a single-user box
 * gets something predictable without arguments.
 *
 * @param {string[]} argv  process.argv.slice(2)
 * @param {Record<string,string|undefined>} [env]
 */
export function resolveNestDir(argv, env = process.env) {
  const flagIndex = argv.indexOf('--dir')
  if (flagIndex !== -1) {
    const value = argv[flagIndex + 1]
    if (!value || value.startsWith('--')) {
      throw new Error('--dir needs a directory path')
    }
    return path.resolve(value)
  }
  if (env.REDSTART_DIR) return path.resolve(env.REDSTART_DIR)
  return path.join(os.homedir(), '.redstart')
}

/** Nest's own state directory, derived from the nest directory. */
export function configDirFor(nestDir) {
  return path.join(nestDir, 'config')
}
