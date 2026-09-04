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
// ../shared holds repo-level modules (stdio MCP supervisor) imported by both
// nest's main process and twig's — checked here since nest's CI runs this.
// 'bin' is the headless daemon entrypoint (Phase 8A.2). It is the one file in
// the tree that no test imports and no bundler compiles, so a syntax error in
// it would otherwise surface only when someone actually ran the daemon.
const dirs = [base, path.join(base, 'ipc'), path.join(base, 'gateway'), path.join(base, 'admin'), '../shared', 'bin']

let count = 0
for (const dir of dirs) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.mjs')) continue
    execFileSync(process.execPath, ['--check', path.join(dir, file)], { stdio: 'pipe' })
    count++
  }
}

console.log(`node --check clean: ${count} files under electron/main + shared + bin`)
