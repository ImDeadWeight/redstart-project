#!/usr/bin/env node
// Makes a staged macOS binary set self-contained, then proves it is: every
// dylib that llama-server (transitively) links is either part of macOS or a
// file in the staged directory, reached through @loader_path / @rpath.
//
//   node scripts/bundle-mac-dylibs.mjs <entry> <dir>
//
// Why: TurboQuant+'s prebuilt macos-arm64-metal llama-server links Homebrew's
// OpenSSL by absolute path (/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib and
// libcrypto.3.dylib). The hosted macOS runner has Homebrew, so `--version`
// starts fine in CI. A Mac without Homebrew aborts at launch with "Library not
// loaded" (SIGABRT), which is how it reached the first Mac tester.
//
// The fix copies each such library in beside llama-server, rewrites the load
// command to @loader_path/<name>, and re-signs what it touched (any edit to a
// Mach-O invalidates its signature, and Apple Silicon will not load an
// invalidly signed file). stage-shell-bundle.mjs then carries the new *.dylib
// files like the archive's own and signs them again with the rest.
//
// The closure check runs last and is the part that guards the next pin move:
// a dependency that points anywhere but macOS or the staged dir fails the job.
//
// Runs on the macOS release job; needs otool, install_name_tool and codesign
// (Xcode command-line tools). Pure Node otherwise.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** Load-command paths a dyld on any supported macOS resolves on its own. */
export function isSystemPath(dep) {
  return dep.startsWith('/usr/lib/') || dep.startsWith('/System/Library/')
}

/** @loader_path / @rpath / @executable_path: resolved relative to the bundle. */
export function isRelativePath(dep) {
  return /^@(loader_path|rpath|executable_path)\//.test(dep)
}

/**
 * Dependency paths from `otool -L` output, without the file's own install
 * name (a dylib's LC_ID_DYLIB is printed as its first entry).
 */
export function parseOtoolL(text, ownId = null) {
  const deps = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+(.+?) \(compatibility version /.exec(line)
    if (m && m[1] !== ownId) deps.push(m[1])
  }
  return deps
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })

function installId(file) {
  // `otool -D` prints "<file>:" and then the id, or nothing for an executable.
  const lines = run('otool', ['-D', file]).trim().split('\n')
  return lines.length > 1 ? lines[1].trim() : null
}

const depsOf = (file) => parseOtoolL(run('otool', ['-L', file]), installId(file))

function machOFiles(dir, entry) {
  return [entry, ...fs.readdirSync(dir).filter((n) => n.endsWith('.dylib')).map((n) => path.join(dir, n))]
}

/** Copy every non-system absolute dependency into dir and relink to it. */
function relocate(entry, dir) {
  const touched = new Set()
  const queue = machOFiles(dir, entry)
  const done = new Set()
  while (queue.length) {
    const file = queue.shift()
    if (done.has(file)) continue
    done.add(file)
    for (const dep of depsOf(file)) {
      if (isSystemPath(dep) || isRelativePath(dep)) continue
      const name = path.basename(dep)
      const dest = path.join(dir, name)
      if (!fs.existsSync(dest)) {
        if (!fs.existsSync(dep)) throw new Error(`${path.basename(file)} links ${dep}, which is not on this machine to copy`)
        // realpath: Homebrew's opt/ path is a symlink into Cellar/.
        fs.copyFileSync(fs.realpathSync(dep), dest)
        fs.chmodSync(dest, 0o755) // Homebrew installs its dylibs read-only
        run('install_name_tool', ['-id', `@loader_path/${name}`, dest])
        touched.add(dest)
        queue.push(dest)
        console.log(`  bundled  ${name}  (from ${dep})`)
      }
      run('install_name_tool', ['-change', dep, `@loader_path/${name}`, file])
      touched.add(file)
    }
  }
  for (const file of touched) run('codesign', ['--force', '--sign', '-', file])
  return touched.size
}

/** Every dependency of every staged Mach-O resolves inside dir or to macOS. */
function checkClosure(entry, dir) {
  const missing = []
  for (const file of machOFiles(dir, entry)) {
    for (const dep of depsOf(file)) {
      if (isSystemPath(dep)) continue
      if (isRelativePath(dep) && fs.existsSync(path.join(dir, path.basename(dep)))) continue
      missing.push(`${dep} (linked by ${path.basename(file)})`)
    }
  }
  return missing
}

function main() {
  const [entry, dir] = process.argv.slice(2)
  if (!entry || !dir) {
    console.error('usage: bundle-mac-dylibs.mjs <entry> <dir>')
    process.exit(2)
  }
  const touched = relocate(entry, dir)
  console.log(`  relinked ${touched} file(s)`)
  const missing = checkClosure(entry, dir)
  if (missing.length) {
    console.error(`\n${missing.length} dependency(s) would not resolve on a clean Mac:`)
    for (const m of missing) console.error(`  - ${m}`)
    process.exit(1)
  }
  console.log('  ok — every dependency is macOS or staged')
}

if (process.argv[1]?.endsWith('bundle-mac-dylibs.mjs')) main()
