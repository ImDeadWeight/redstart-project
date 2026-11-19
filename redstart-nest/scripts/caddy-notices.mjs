#!/usr/bin/env node
// =============================================================================
// License notices for every Go module inside the bundled Caddy (TLS plan C1)
// =============================================================================
// Reads a binary's provenance record (caddy-provenance.mjs) and, for every
// module in it, copies that module's LICENSE / NOTICE / COPYING / PATENTS
// files out of the Go module cache the build just filled. Writes one text
// file of notices per binary, shipped beside it in the installer.
//
// A module with no license file FAILS the build. The first Caddy build
// shipped caddy-dns/duckdns, whose repository has no license at all. Nothing
// noticed until a person looked, so this check exists to notice instead.
//
// Modules replaced by a directory inside this repository (Redstart's own
// Caddy modules under infra/) are covered by the repository's LICENSE, and
// are listed as such rather than searched for.
//
//   node scripts/caddy-notices.mjs --modcache "$(go env GOMODCACHE)" \
//     --repo-root . --commit "$GITHUB_SHA" <binary>.json...
//   → writes <binary>.NOTICES.txt beside each
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const LICENSE_FILE = /^(licen[cs]e|copying|notice|patents|unlicense)([-._].*)?$/i

/** The module cache's case encoding: every upper-case letter becomes '!' + lower case. */
export function escapeModulePath(p) {
  return p.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)
}

/** The directory a module's source lives in, in the cache or (replaced) on disk. */
export function moduleDir(mod, modcache) {
  const target = mod.replacedBy ?? mod
  if (target.version == null || target.version === '(devel)') return { local: target.path }
  return { cached: path.join(modcache, ...escapeModulePath(target.path).split('/').slice(0, -1), `${escapeModulePath(target.path).split('/').pop()}@${target.version}`) }
}

export function licenseFiles(dir, readdir = fs.readdirSync) {
  let entries
  try { entries = readdir(dir) } catch { return [] }
  return entries.filter((n) => LICENSE_FILE.test(n)).sort()
}

/**
 * @param {{ record: object, modcache: string, repoRoot: string, commit: string, readFile?: Function, readdir?: Function }} p
 * @returns {{ text: string, missing: string[], count: number }}
 */
export function buildNotices({ record, modcache, repoRoot, commit, readFile = fs.readFileSync, readdir = fs.readdirSync }) {
  const parts = [
    `Third-party notices for ${record.file}`,
    `Caddy ${record.caddy}, built with ${record.go} and xcaddy ${record.xcaddy} from commit ${commit}.`,
    `Every Go module compiled into this binary, with the license files its source carries.`,
    '',
  ]
  const missing = []
  let count = 0
  const root = path.resolve(repoRoot)
  for (const mod of record.modules) {
    const where = moduleDir(mod, modcache)
    const heading = `${mod.path} ${mod.version ?? ''}${mod.replacedBy ? ` => ${mod.replacedBy.path} ${mod.replacedBy.version ?? ''}` : ''}`.trim()
    if (where.local) {
      const abs = path.resolve(where.local)
      if (abs === root || abs.startsWith(root + path.sep)) {
        parts.push('='.repeat(78), heading, '-'.repeat(78),
          `Part of Redstart (${path.relative(root, abs).split(path.sep).join('/')}), covered by the repository's LICENSE (AGPL-3.0-only).`,
          `Source: https://github.com/ImDeadWeight/redstart-project/tree/${commit}/${path.relative(root, abs).split(path.sep).join('/')}`, '')
        count++
        continue
      }
      missing.push(`${heading} (replaced by a directory outside this repository)`)
      continue
    }
    const files = licenseFiles(where.cached, readdir)
    if (!files.length) { missing.push(heading); continue }
    parts.push('='.repeat(78), heading, '-'.repeat(78))
    for (const f of files) parts.push(`--- ${f} ---`, String(readFile(path.join(where.cached, f), 'utf8')).trimEnd(), '')
    count++
  }
  return { text: parts.join('\n') + '\n', missing, count }
}

function main(argv) {
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
  const modcache = opt('--modcache')
  const repoRoot = opt('--repo-root')
  const commit = opt('--commit')
  if (!modcache || !repoRoot || !commit) throw new Error('usage: caddy-notices.mjs --modcache <dir> --repo-root <dir> --commit <sha> <provenance.json>...')
  const flags = new Set(['--modcache', '--repo-root', '--commit'])
  const files = argv.filter((a, i) => !flags.has(a) && !flags.has(argv[i - 1]))
  let failed = false
  for (const file of files) {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    const { text, missing, count } = buildNotices({ record, modcache, repoRoot, commit })
    if (missing.length) {
      failed = true
      console.error(`${record.file}: ${missing.length} module(s) carry no license file — not redistributable as-is:\n  ${missing.join('\n  ')}`)
      continue
    }
    const out = file.replace(/\.json$/, '.NOTICES.txt')
    fs.writeFileSync(out, text)
    console.log(`${path.basename(out)}: ${count} modules`)
  }
  if (failed) process.exit(1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (err) { console.error(err.message); process.exit(1) }
}
