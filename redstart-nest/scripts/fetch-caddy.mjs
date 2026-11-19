#!/usr/bin/env node
// =============================================================================
// Fetch the pinned Caddy build Nest bundles (TLS plan C1)
// =============================================================================
// Downloads this platform's binary, and the license notices of every Go
// module inside it, from the release .github/workflows/caddy.yml published.
// Refuses either unless its sha256 matches the pin below, and places them at
// redstart-nest/deps/caddy/caddy(.exe) and caddy-NOTICES.txt (gitignored). daemon/caddy-server.mjs
// looks there in a dev checkout; stage-shell-bundle.mjs copies it from there
// into resources/bin/ for an installer. release.yml runs this too, so a dev
// build and a release carry the same bytes.
//
// PINNED BY HASH. The values below were copied from the release's SHA256SUMS
// (and match each asset's .json provenance record). To move the pin: bump
// caddy.yml, let it publish, then change TAG and all three hashes here in one
// commit. scripts/test-packaging.mjs checks TAG agrees with caddy.yml.
//
// Never fetched from Caddy's own download API: unpinned, unreproducible, and a
// binary from the network at runtime is a path this project otherwise refuses.
//
//   node scripts/fetch-caddy.mjs            stage for this platform
//   node scripts/fetch-caddy.mjs --check    exit 0 if already staged and intact
// =============================================================================

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeFetch } from '../daemon/node-fetch-transport.mjs'

export const CADDY_REPO = 'ImDeadWeight/redstart-project'
export const CADDY_TAG = 'caddy-redstart-v2.11.9-2'

// From the release's SHA256SUMS, 2026-11-19 (run 44437263497).
export const CADDY_ASSETS = Object.freeze({
  'win32-x64': {
    file: `${CADDY_TAG}-windows-amd64.exe`, sha256: '02da56cf0cdbf483a4a08c3df0250a80a0cebf7ecd659f9518a45bf8c8ede9c1',
    notices: { file: `${CADDY_TAG}-windows-amd64.exe.NOTICES.txt`, sha256: '922a0df07df97da3f797570f23536d2b8c91a449ab18f1d919593ce2e395c621' },
  },
  'darwin-arm64': {
    file: `${CADDY_TAG}-darwin-arm64`, sha256: '867dddcc549f214c246c2faf18b42362c6efa39509c51ab24001bbac489d66df',
    notices: { file: `${CADDY_TAG}-darwin-arm64.NOTICES.txt`, sha256: '122dc441e13783cf4920127ea22f94e308f7068994b8f59026baab0955249a3c' },
  },
  'linux-x64': {
    file: `${CADDY_TAG}-linux-amd64`, sha256: 'c3ada96c4ad64be5d6a54e765619a600fdbd2b247ce0e39645f0d23dd92258b6',
    notices: { file: `${CADDY_TAG}-linux-amd64.NOTICES.txt`, sha256: '6763ca72452d5a2af1222f2cca57869be10bac37e2fceddf7c73b382b1ec9fab' },
  },
})

const here = path.dirname(fileURLToPath(import.meta.url))
export const CADDY_STAGE_DIR = path.join(here, '..', 'deps', 'caddy')

export function stagedCaddyPath(platform = process.platform) {
  return path.join(CADDY_STAGE_DIR, platform === 'win32' ? 'caddy.exe' : 'caddy')
}

/** The notices for the staged binary: stage-shell-bundle ships it in licenses/. */
export const STAGED_NOTICES = path.join(CADDY_STAGE_DIR, 'caddy-NOTICES.txt')

const MAX_REDIRECTS = 5

/** GET following HTTPS-only redirects (GitHub hands release downloads to its asset host). */
async function download(url) {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (new URL(url).protocol !== 'https:') throw new Error(`refusing a non-HTTPS URL: ${url}`)
    const res = await nodeFetch(url, { headers: { 'user-agent': 'redstart-fetch-caddy' } })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).toString()
      continue
    }
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Error(`too many redirects fetching ${url}`)
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

async function stage() {
  const key = `${process.platform}-${process.arch}`
  const spec = CADDY_ASSETS[key]
  if (!spec) throw new Error(`No pinned Caddy build for ${key}`)
  const items = [
    { ...spec, target: stagedCaddyPath(), exec: true },
    { ...spec.notices, target: STAGED_NOTICES, exec: false },
  ]
  const marker = path.join(CADDY_STAGE_DIR, 'VERSION')
  const want = `${CADDY_TAG} ${spec.sha256} ${spec.notices.sha256}`

  // Re-hash what is on disk rather than trust the marker alone.
  const intact = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === want
    && items.every((i) => fs.existsSync(i.target) && sha256(fs.readFileSync(i.target)) === i.sha256)
  if (intact) {
    console.log(`Caddy ${CADDY_TAG} already staged at ${items[0].target}`)
    return
  }
  if (process.argv.includes('--check')) throw new Error(`Caddy ${CADDY_TAG} is not staged (run: node scripts/fetch-caddy.mjs)`)

  fs.mkdirSync(CADDY_STAGE_DIR, { recursive: true })
  for (const item of items) {
    const url = `https://github.com/${CADDY_REPO}/releases/download/${CADDY_TAG}/${item.file}`
    console.log(`Downloading ${url}`)
    const body = await download(url)
    const got = sha256(body)
    if (got !== item.sha256) throw new Error(`sha256 mismatch for ${item.file}: expected ${item.sha256}, got ${got}`)
    const tmp = `${item.target}.download`
    fs.writeFileSync(tmp, body)
    if (item.exec && process.platform !== 'win32') fs.chmodSync(tmp, 0o755)
    fs.renameSync(tmp, item.target)
  }
  fs.writeFileSync(marker, `${want}
`)
  console.log(`Staged Caddy ${CADDY_TAG} at ${items[0].target}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stage().catch((err) => { console.error(err.message); process.exit(1) })
}
