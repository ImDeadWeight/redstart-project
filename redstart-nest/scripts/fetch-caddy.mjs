#!/usr/bin/env node
// =============================================================================
// Fetch the pinned Caddy build Nest bundles (TLS plan C1)
// =============================================================================
// Downloads this platform's binary from the release .github/workflows/caddy.yml
// published, refuses it unless its sha256 matches the pin below, and places it
// at redstart-nest/deps/caddy/caddy(.exe) (gitignored). daemon/caddy-server.mjs
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
export const CADDY_TAG = 'caddy-redstart-v2.11.9-1'

// From the release's SHA256SUMS, 2026-11-19 (run 44433803120).
export const CADDY_ASSETS = Object.freeze({
  'win32-x64': { file: `${CADDY_TAG}-windows-amd64.exe`, sha256: 'd6f4318520cf48c829621865d36113e3230558fa017337fb098fc41cfe10e879' },
  'darwin-arm64': { file: `${CADDY_TAG}-darwin-arm64`, sha256: '2a314c12ffebbc762a90ce4a42587202d7babce97460d4dcf3bdbcbf972d4fd6' },
  'linux-x64': { file: `${CADDY_TAG}-linux-amd64`, sha256: '26c79ab4e134f8a4bf0b54c4b92ac19b2f78d8e09a1e5973fa7997a9c8e356b7' },
})

const here = path.dirname(fileURLToPath(import.meta.url))
export const CADDY_STAGE_DIR = path.join(here, '..', 'deps', 'caddy')

export function stagedCaddyPath(platform = process.platform) {
  return path.join(CADDY_STAGE_DIR, platform === 'win32' ? 'caddy.exe' : 'caddy')
}

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
  const target = stagedCaddyPath()
  const marker = path.join(CADDY_STAGE_DIR, 'VERSION')
  const want = `${CADDY_TAG} ${spec.sha256}`

  if (fs.existsSync(target) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === want
      && sha256(fs.readFileSync(target)) === spec.sha256) {
    console.log(`Caddy ${CADDY_TAG} already staged at ${target}`)
    return
  }
  if (process.argv.includes('--check')) throw new Error(`Caddy ${CADDY_TAG} is not staged (run: node scripts/fetch-caddy.mjs)`)

  const url = `https://github.com/${CADDY_REPO}/releases/download/${CADDY_TAG}/${spec.file}`
  console.log(`Downloading ${url}`)
  const body = await download(url)
  const got = sha256(body)
  if (got !== spec.sha256) throw new Error(`sha256 mismatch for ${spec.file}: expected ${spec.sha256}, got ${got}`)

  fs.mkdirSync(CADDY_STAGE_DIR, { recursive: true })
  const tmp = `${target}.download`
  fs.writeFileSync(tmp, body)
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, target)
  fs.writeFileSync(marker, `${want}\n`)
  console.log(`Staged Caddy ${CADDY_TAG} at ${target}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stage().catch((err) => { console.error(err.message); process.exit(1) })
}
