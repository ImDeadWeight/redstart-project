// =============================================================================
// svelte-check baseline guard
// =============================================================================
// svelte-check has no "fail above N errors" mode, and the repo is not at zero
// yet â€” the remaining errors are a real defect list (see
// redstart-typecheck-baseline-plan.md Â§2), not noise to be silenced.
//
// So this pins the count. Above the baseline fails; below it passes and tells
// you to lower the number. The point is not the number itself: the previous
// baseline reached 513 precisely because nothing was watching, and 484 lines of
// `implicit any` were hiding a genuine `parent`-typing defect.
//
// Lower BASELINE as errors are fixed. Never raise it without saying why.
//
// Run:  npm run check:baseline
// =============================================================================

import { spawnSync } from 'node:child_process'

// Zero as of 2026-08-07. It got here from 513 in two moves: scoping checkJs to
// the app rather than the Electron main process, then fixing the 29 real
// errors that were hiding underneath. Keep it at zero — the whole reason the
// old baseline grew is that a non-zero number is easy to ignore.
const BASELINE = 0

const result = spawnSync('npx svelte-check --threshold error --output human', {
  shell: true,
  encoding: 'utf8',
  cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
})

const output = `${result.stdout || ''}${result.stderr || ''}`
const match = output.match(/svelte-check found (\d+) error/)

if (!match) {
  console.error('Could not parse svelte-check output â€” did the command fail to run?')
  console.error(output.slice(-2000))
  process.exit(1)
}

const count = Number(match[1])

if (count > BASELINE) {
  console.error(`\nsvelte-check: ${count} errors, baseline is ${BASELINE} (+${count - BASELINE}).\n`)
  console.error('New type errors were introduced. Fix them, or if the increase is')
  console.error('deliberate, raise BASELINE in scripts/check-svelte-baseline.mjs')
  console.error('with a comment explaining why.\n')
  console.error(output.slice(-4000))
  process.exit(1)
}

if (count < BASELINE) {
  console.log(`\nsvelte-check: ${count} errors â€” below the ${BASELINE} baseline.`)
  console.log(`Lower BASELINE to ${count} in scripts/check-svelte-baseline.mjs to lock the gain in.\n`)
  process.exit(0)
}

console.log(`\nsvelte-check: ${count} errors, matching the baseline.\n`)
