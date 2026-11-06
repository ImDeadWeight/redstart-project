// =============================================================================
// twigd's stdout belongs to the shell pipe. Console output goes to stderr.
// =============================================================================
// Imported FIRST by bin/twigd.mjs. ES modules evaluate imports depth-first, in
// order, so this runs before any other module can print at load time. Nest's
// bin/stdout-guard.mjs is the same idea; twigd always runs under its shell, so
// this one is unconditional. A dependency that writes to process.stdout
// directly still lands on the protocol stream, and shell-pipe.mjs treats such
// a line as noise: it costs a log line, not the channel.
// =============================================================================
import { format } from 'node:util'

const toStderr = (...args) => { process.stderr.write(format(...args) + '\n') }
console.log = toStderr
console.info = toStderr
console.debug = toStderr
