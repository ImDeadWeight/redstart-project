// =============================================================================
// Re-key stored secrets — the operator-facing driver for Phase 8B.2
// =============================================================================
// secrets-migration.mjs deliberately has no caller: the switch from a
// user-account install to a service-account one is a human's to make, not
// something a daemon does to itself on startup. This is that human's tool.
//
//   Dry run (default — writes nothing, and is not optional):
//     npx electron scripts/rekey-secrets.mjs -- --source <dir> --target <dir>
//
//   Apply, once the dry run reads correctly:
//     npx electron scripts/rekey-secrets.mjs -- --source <dir> --target <dir> --apply
//
// WHY `electron` AND NOT `node`, and this is the whole practical difficulty of
// trap 5.3: the secrets being read were encrypted with DPAPI, which only
// Electron's safeStorage can reach, and only while running AS THE ORIGINAL
// USER on the ORIGINAL MACHINE. A plain-node process cannot decrypt them — not
// slowly, not with a flag, not at all. So this refuses to pretend: run under
// plain node against a safeStorage tree and it stops and says so, rather than
// reporting every secret as unreadable and letting somebody conclude their
// credentials are already gone.
//
// It never registers a service, never repoints a running daemon, and never
// deletes the source. It produces a converted directory; the runbook in
// deploy/README.md is what points a service at it afterwards.
// =============================================================================

import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { planRekey, applyRekey, findSecrets } from '../electron/main/secrets-migration.mjs'
import { keyfileProvider } from '../electron/main/secrets-keyfile.mjs'
import { safeStorageProvider } from '../electron/main/secrets-safe-storage.mjs'

/**
 * Parse the operator's arguments.
 *
 * Exported and pure so the refusals below are testable: every one of them is a
 * way somebody loses a directory, and "it printed a usage message" is not
 * something to find out by running it against a real install.
 */
export function parseRekeyArgs(argv) {
  const out = { source: null, target: null, apply: false, from: 'safestorage' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--apply') { out.apply = true; continue }
    if (arg === '--source' || arg === '--target' || arg === '--from') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) return { error: `${arg} needs a value` }
      out[arg.slice(2)] = arg === '--from' ? value : path.resolve(value)
      i++
      continue
    }
    if (arg === '--') continue
    return { error: `Unknown argument: ${arg}` }
  }
  if (!out.source) return { error: '--source is required (the existing config directory)' }
  if (!out.target) return { error: '--target is required (the new config directory)' }
  if (out.source === out.target) return { error: '--source and --target must be different directories' }
  if (out.from !== 'safestorage' && out.from !== 'keyfile') {
    return { error: `--from must be safestorage or keyfile (got ${out.from})` }
  }
  return out
}

/**
 * Whether this process can actually read the source provider's ciphertext.
 *
 * The one refusal that matters. Reporting "0 of 12 secrets readable" from a
 * plain-node process is technically accurate and completely misleading — it
 * looks exactly like a corrupted install, and the reasonable conclusion from
 * it ("the credentials are gone, start over") is wrong and destructive.
 */
export function providerAvailability(from, hasElectron) {
  if (from === 'keyfile') return { ok: true }
  if (hasElectron) return { ok: true }
  return {
    ok: false,
    error: [
      'This tree\'s secrets were written by the OS keychain (DPAPI on Windows), which only',
      'Electron can read — and only as the user who wrote them, on the machine that wrote them.',
      '',
      'Re-run under Electron:',
      '  npx electron scripts/rekey-secrets.mjs -- --source <dir> --target <dir>',
      '',
      'Refusing rather than reporting every secret as unreadable, which would look exactly',
      'like a corrupted install and invite exactly the wrong conclusion.',
    ].join('\n'),
  }
}

export function formatPlan(plan) {
  const lines = []
  lines.push(`  secrets found:     ${plan.total}`)
  lines.push(`  readable now:      ${plan.readable}`)
  for (const [tag, count] of Object.entries(plan.byTag)) {
    lines.push(`    written by ${tag}: ${count}`)
  }
  if (plan.unreadable.length) {
    lines.push('')
    lines.push(`  CANNOT BE READ (${plan.unreadable.length}) — these will be left exactly as they are,`)
    lines.push('  and must be re-entered by hand in the new install:')
    for (const u of plan.unreadable) {
      lines.push(`    ${u.file}: ${u.pointer}  [written by ${u.tag}] ${u.reason}`)
    }
  }
  return lines.join('\n')
}

async function main() {
  const args = parseRekeyArgs(process.argv.slice(2))
  if (args.error) {
    console.error(`\n${args.error}\n`)
    console.error('Usage: rekey-secrets.mjs --source <dir> --target <dir> [--apply] [--from safestorage|keyfile]')
    process.exit(2)
  }

  // Electron, when present, has to be ready before safeStorage answers.
  let electronSafeStorage = null
  try {
    const electron = await import('electron')
    if (electron?.app?.whenReady) {
      await electron.app.whenReady()
      electronSafeStorage = electron.safeStorage
    }
  } catch {
    // Plain node. Handled by providerAvailability() below, loudly.
  }

  const availability = providerAvailability(args.from, !!electronSafeStorage)
  if (!availability.ok) {
    console.error(`\n${availability.error}\n`)
    process.exit(2)
  }

  const from = args.from === 'keyfile'
    ? keyfileProvider(args.source)
    : safeStorageProvider(electronSafeStorage)
  const to = keyfileProvider(args.target)

  console.log(`\nRedstart Nest — re-key stored secrets`)
  console.log(`  source: ${args.source}`)
  console.log(`  target: ${args.target}`)
  console.log(`  from:   ${args.from}  ->  keyfile\n`)

  const plan = planRekey({ dir: args.source, from })
  console.log(formatPlan(plan))

  if (findSecrets(args.source).length === 0) {
    console.log('\nNothing to migrate: this directory holds no encrypted values.')
    console.log('That is a normal result for an install that never configured a credential.')
  }

  if (!args.apply) {
    console.log('\nDry run — nothing was written. Re-run with --apply when the numbers above look right.')
    process.exit(0)
  }

  console.log('\nApplying...')
  const result = applyRekey({ sourceDir: args.source, targetDir: args.target, from, to })
  if (!result.ok) {
    console.error(`\nFAILED: ${result.error}`)
    console.error(`\nThe source directory is untouched. Nothing needs undoing.`)
    process.exit(1)
  }

  console.log(`  re-encrypted:      ${result.migrated}`)
  console.log(`  verified readable: ${result.verified}`)
  if (result.skipped.length) {
    console.log(`  left as they were: ${result.skipped.length} (re-enter these by hand)`)
    for (const s of result.skipped) console.log(`    ${s.file}: ${s.pointer}`)
  }
  console.log(`\nDone. The source directory is untouched — if anything is wrong with the new`)
  console.log(`install, point it back at ${args.source} and nothing has been lost.`)
  process.exit(0)
}

// Only when run directly, so the pure helpers above can be imported by tests
// without this doing anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\nFAILED: ${err.message}`)
    process.exit(1)
  })
}
