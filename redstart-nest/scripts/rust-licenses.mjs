#!/usr/bin/env node
// =============================================================================
// Licences of the Rust crates compiled into the Tauri shell
// =============================================================================
// The npm side has license:gen (licenses/npm-licenses.json). The shell exe is
// built from ~300 crates, and their licences ship with it the same way:
// licenses/rust-licenses.json, one entry per crate that is actually compiled
// for this platform's build (the resolved dependency graph for TARGET below,
// normal dependencies only, not build or dev dependencies). The licence field is the crate's own SPDX expression, as
// published.
//
//   node scripts/rust-licenses.mjs      (run before stage-shell-bundle.mjs)
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const NEST = path.join(here, '..')
const OUT = path.join(NEST, 'licenses', 'rust-licenses.json')
// The crates differ by platform (DPAPI vs Keychain, WebView2 vs WKWebView).
const TARGET = process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-pc-windows-msvc'

export function compiledCrates(metadata) {
  const byId = new Map(metadata.packages.map((p) => [p.id, p]))
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]))
  const root = metadata.resolve.root
  const seen = new Set()
  const stack = [root]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    for (const dep of nodes.get(id)?.deps ?? []) {
      // dep_kinds: kind null = normal. With --filter-platform, cargo has
      // already dropped what this target never compiles.
      if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg)
    }
  }
  seen.delete(root)
  return [...seen]
    .map((id) => byId.get(id))
    .map((p) => ({ name: p.name, version: p.version, license: p.license ?? (p.license_file ? `see ${p.license_file}` : 'UNKNOWN'), repository: p.repository ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raw = execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', TARGET], {
    cwd: path.join(NEST, 'shell'),
    maxBuffer: 256 * 1024 * 1024,
  })
  const crates = compiledCrates(JSON.parse(raw.toString()))
  const unknown = crates.filter((c) => c.license === 'UNKNOWN')
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ target: TARGET, crates }, null, 2) + '\n')
  console.log(`Wrote ${crates.length} crates to ${path.relative(NEST, OUT)}${unknown.length ? `; no licence field: ${unknown.map((c) => c.name).join(', ')}` : ''}`)
}
