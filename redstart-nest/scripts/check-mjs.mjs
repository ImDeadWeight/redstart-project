// Syntax-check every electron/main .mjs (including ipc/) with `node --check`.
//
// A standalone script rather than an inline `node -e` one-liner: the inline
// form needed backtick template literals, which Windows cmd ignores but POSIX
// sh evaluates as command substitution — so it worked locally and broke in CI.
// execFileSync with an args array invokes node directly, no shell involved, so
// it behaves identically on every platform.
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import * as path from 'node:path'

const base = 'electron/main'
const dirs = [base, path.join(base, 'ipc')]

let count = 0
for (const dir of dirs) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.mjs')) continue
    execFileSync(process.execPath, ['--check', path.join(dir, file)], { stdio: 'pipe' })
    count++
  }
}

console.log(`node --check clean: ${count} files under electron/main`)
