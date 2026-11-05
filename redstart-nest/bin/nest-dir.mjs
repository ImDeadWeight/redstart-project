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

// A flag that takes a directory. Absent → undefined; present without a value
// (or followed straight by another flag) is an error, never a silent default.
function dirFlag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  const value = argv[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a directory path`)
  return path.resolve(value)
}

/**
 * Every path the daemon needs from its command line.
 *
 * Two shapes, never mixed:
 *   --dir <nest>                         headless: <nest>/config + <nest>/data
 *   --config <dir> --capability-base <dir>   a desktop shell naming an existing
 *                                        install's directories, which never had
 *                                        the nest layout (%APPDATA%\redstart and
 *                                        Documents\Redstart)
 * Mixing them is refused: two answers to "where does state live" is the
 * split-state failure platform-paths.mjs exists to prevent.
 *
 * --resources <dir> (either shape) is the packaged resources directory: the
 * bundled llama-server, chat-ui and elevate.exe. Its presence is what makes
 * the daemon run as a packaged build.
 *
 * @returns {{ config: string, capabilityBase: string, resources: string|null, label: string }}
 */
export function resolveDaemonPaths(argv, env = process.env) {
  const config = dirFlag(argv, '--config')
  const capabilityBase = dirFlag(argv, '--capability-base')
  const resources = dirFlag(argv, '--resources') ?? null
  if ((config === undefined) !== (capabilityBase === undefined)) {
    throw new Error('--config and --capability-base must be given together')
  }
  if (config !== undefined) {
    if (argv.includes('--dir')) throw new Error('--dir cannot be combined with --config/--capability-base')
    return { config, capabilityBase, resources, label: config }
  }
  const nestDir = resolveNestDir(argv, env)
  return { config: configDirFor(nestDir), capabilityBase: path.join(nestDir, 'data'), resources, label: nestDir }
}
