'use strict'
// =============================================================================
// In --shell-pipe mode, stdout belongs to the protocol. Console output goes to stderr.
// =============================================================================
// Imported FIRST by bin/nestd.mjs. ES modules evaluate imports depth-first, in
// order, so this runs before any other module can print at load time.
//
// Only console.log/info/debug are rerouted (warn and error already go to
// stderr). A dependency that writes to process.stdout directly still lands on
// the protocol stream; shell-pipe.mjs treats such a line as noise, so it costs
// a log line rather than the channel.
// =============================================================================
import { format } from 'node:util'

export const SHELL_PIPE = process.argv.includes('--shell-pipe')

if (SHELL_PIPE) {
  const toStderr = (...args) => { process.stderr.write(format(...args) + '\n') }
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
}
