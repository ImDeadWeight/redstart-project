#!/usr/bin/env node
// =============================================================================
// Build provenance for the bundled Caddy (TLS plan C1, review R7)
// =============================================================================
// .github/workflows/caddy.yml builds Caddy with three third-party DNS plugins.
// This writes `<binary>.json` beside each binary it is given: what is inside
// it, read back OUT OF THE BINARY rather than from the workflow's inputs.
// `go version -m` reads the build info the Go linker embeds (it survives
// -ldflags '-w -s'), and it reads any platform's binary, so the Windows and
// macOS builds are described on the Linux runner that cross-compiled them.
//
// The record: Go version, xcaddy version (the one input the binary does not
// carry), Caddy's version, every module with its version and go.sum hash,
// the build settings (CGO_ENABLED, GOOS, GOARCH, -trimpath, ldflags), and the
// file's own sha256.
//
//   node scripts/caddy-provenance.mjs --xcaddy v0.4.7 <binary>...
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const CADDY_MODULE = 'github.com/caddyserver/caddy/v2'

/**
 * Parse `go version -m <file>` output. Lines after the first are
 * tab-separated: `path`, `mod`, `dep`, `=>` (a replacement of the line
 * before it) and `build` (key=value settings).
 *
 * @param {string} text
 * @returns {{ go: string, path: string|null, main: object|null, deps: object[], settings: Record<string,string> }}
 */
export function parseGoVersionM(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '')
  const head = /^.*?:\s+(go\S+)\s*$/.exec(lines[0] ?? '')
  if (!head) throw new Error(`not go version -m output: ${JSON.stringify(lines[0] ?? '')}`)
  const out = { go: head[1], path: null, main: null, deps: [], settings: {} }
  const mod = (f) => ({ path: f[0], version: f[1] ?? null, sum: f[2] || null })
  let last = null
  for (const line of lines.slice(1)) {
    const [kind, ...f] = line.replace(/^\t/, '').split('\t')
    if (kind === 'path') out.path = f[0]
    else if (kind === 'mod') out.main = mod(f)
    else if (kind === 'dep') { last = mod(f); out.deps.push(last) }
    else if (kind === '=>') {
      if (!last) throw new Error(`replacement with no module before it: ${line}`)
      last.replacedBy = mod(f)
    } else if (kind === 'build') {
      const eq = f[0].indexOf('=')
      if (eq > 0) out.settings[f[0].slice(0, eq)] = f[0].slice(eq + 1)
    } else {
      throw new Error(`unknown go version -m line: ${line}`)
    }
  }
  return out
}

/**
 * The provenance record for one binary.
 * @param {{ info: ReturnType<typeof parseGoVersionM>, xcaddy: string, file: string, sha256: string }} p
 */
export function provenanceRecord({ info, xcaddy, file, sha256 }) {
  const caddy = info.deps.find((d) => d.path === CADDY_MODULE)
  if (!caddy) throw new Error(`${file}: ${CADDY_MODULE} is not among its modules; not a Caddy build`)
  return {
    file,
    sha256,
    go: info.go,
    xcaddy,
    caddy: caddy.version,
    target: { os: info.settings.GOOS ?? null, arch: info.settings.GOARCH ?? null },
    cgo: info.settings.CGO_ENABLED ?? null,
    settings: info.settings,
    modules: info.deps,
  }
}

function main(argv) {
  const i = argv.indexOf('--xcaddy')
  if (i < 0 || !argv[i + 1]) throw new Error('usage: caddy-provenance.mjs --xcaddy <version> <binary>...')
  const xcaddy = argv[i + 1]
  const files = argv.filter((_, j) => j !== i && j !== i + 1)
  if (!files.length) throw new Error('no binaries given')
  for (const bin of files) {
    const info = parseGoVersionM(execFileSync('go', ['version', '-m', bin], { encoding: 'utf8' }))
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(bin)).digest('hex')
    const record = provenanceRecord({ info, xcaddy, file: path.basename(bin), sha256 })
    fs.writeFileSync(`${bin}.json`, JSON.stringify(record, null, 2) + '\n')
    console.log(`${path.basename(bin)}  caddy ${record.caddy}  ${info.go}  ${record.target.os}/${record.target.arch}  ${sha256}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (err) { console.error(err.message); process.exit(1) }
}
