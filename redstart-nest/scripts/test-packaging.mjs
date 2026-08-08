// =============================================================================
// Packaging invariants — imports that escape the app root must be shipped
// =============================================================================
// Both Electron apps import a module that lives OUTSIDE their own app root:
//
//   redstart-nest/electron/main/filesystem-mcp-provider.mjs
//   redstart-twig/windows/electron/mcp-manager.mjs
//        -> ../../../shared/mcp-stdio-process.mjs
//
// In a dev checkout that resolves fine, because the repo has the parent
// directories. In a packaged build the app root becomes app.asar, and a
// specifier that climbs above it lands OUTSIDE the archive — where nothing was
// copied. The build still succeeds. The installer still installs. The app then
// dies at startup with ERR_MODULE_NOT_FOUND, which is exactly what shipped.
//
// The number of levels an import escapes decides where the file has to be put,
// and the two apps differ because their sources sit at different depths:
//
//   escape 1 level  -> resources/          -> electron-builder `extraResources`
//   escape 2 levels -> the app directory   -> electron-builder `extraFiles`
//
// This test derives that from the source and fails if the config does not
// place the file where the import will actually look.
//
// Reads only JSON and source text — no build, no Electron.
//
// Run:  node scripts/test-packaging.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(__dirname, '..', '..')

const results = []

function test(name, fn) {
  try {
    const detail = fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

// The two packaged Electron apps: where their config lives, which directory is
// the app root (the thing that becomes app.asar), and which trees hold their
// main-process sources.
const APPS = [
  {
    name: 'Redstart Nest',
    appRoot: path.join(REPO, 'redstart-nest'),
    config: path.join(REPO, 'redstart-nest', 'electron-builder.json'),
    sourceDirs: ['electron/main', 'electron/preload'],
  },
  {
    name: 'Redstart Twig',
    appRoot: path.join(REPO, 'redstart-twig', 'windows'),
    config: path.join(REPO, 'redstart-twig', 'windows', 'electron-builder.json'),
    sourceDirs: ['electron'],
  },
]

function walk(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      out.push(...walk(full))
    } else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

// Every static/dynamic relative import in a file, as raw specifiers.
function importSpecifiers(source) {
  const out = []
  const patterns = [
    /\bfrom\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(source)) !== null) out.push(m[1])
  }
  return out
}

// How many directory levels above the app root does this specifier land?
// 0 or less means it stays inside the app (and therefore inside app.asar).
function escapeLevels(appRoot, fileAbs, specifier) {
  const fromDir = path.dirname(fileAbs)
  const target = path.resolve(fromDir, specifier)
  const rel = path.relative(appRoot, target)
  if (!rel.startsWith('..')) return 0
  // rel looks like `..\..\shared\x.mjs` — count the leading `..` segments.
  return rel.split(path.sep).filter((s) => s === '..').length
}

// The first path segment of the escaped target, e.g. `shared`.
function escapedTopLevel(appRoot, fileAbs, specifier) {
  const target = path.resolve(path.dirname(fileAbs), specifier)
  const rel = path.relative(appRoot, target)
  const parts = rel.split(path.sep).filter((s) => s !== '..')
  return parts[0] ?? null
}

function fileSets(config, key) {
  const raw = config[key]
  if (!raw) return []
  return (Array.isArray(raw) ? raw : [raw])
    .filter((e) => typeof e === 'object' && e !== null)
}

console.log('\n-- imports that escape the app root are shipped --')

for (const app of APPS) {
  const config = JSON.parse(fs.readFileSync(app.config, 'utf8'))

  const escaping = []
  for (const dir of app.sourceDirs) {
    for (const file of walk(path.join(app.appRoot, dir))) {
      const source = fs.readFileSync(file, 'utf8')
      for (const spec of importSpecifiers(source)) {
        const levels = escapeLevels(app.appRoot, file, spec)
        if (levels > 0) escaping.push({ file, spec, levels })
      }
    }
  }

  test(`${app.name}: escaping imports resolve to a file that exists on disk`, () => {
    for (const { file, spec } of escaping) {
      const target = path.resolve(path.dirname(file), spec)
      assert(fs.existsSync(target), `${path.relative(REPO, file)} imports ${spec}, which does not exist`)
    }
    return `${escaping.length} escaping import(s)`
  })

  test(`🔍 ${app.name}: every escaping import is copied into the package`, () => {
    for (const { file, spec, levels } of escaping) {
      const top = escapedTopLevel(app.appRoot, file, spec)
      assert(top, `could not determine target directory for ${spec}`)

      // 1 level above app.asar is resources/; 2 levels is the app directory.
      const key = levels === 1 ? 'extraResources' : levels === 2 ? 'extraFiles' : null
      assert(
        key,
        `${path.relative(REPO, file)} imports ${spec}, escaping ${levels} levels — ` +
          `too deep for electron-builder to place (max 2). Move the module inside the app root.`
      )

      const covered = fileSets(config, key).some((entry) => {
        const to = String(entry.to ?? '').replace(/[\\/]+$/, '')
        if (to !== top) return false
        const from = path.resolve(path.dirname(app.config), String(entry.from ?? ''))
        return fs.existsSync(from)
      })

      assert(
        covered,
        `${path.relative(REPO, file)} imports ${spec} (escapes ${levels} level(s) -> "${top}/"), ` +
          `but ${path.basename(app.config)} has no ${key} entry with to: "${top}". ` +
          `The build will succeed and the app will die at startup with ERR_MODULE_NOT_FOUND.`
      )
    }
    return `${escaping.length} checked`
  })
}

console.log('\n-- assets that cannot run from inside an asar --')

test('🔍 Nest unpacks native .node binaries', () => {
  const config = JSON.parse(fs.readFileSync(APPS[0].config, 'utf8'))
  const unpack = config.asarUnpack ?? []
  assert(
    unpack.some((p) => p.includes('.node')),
    'no asarUnpack rule covers **/*.node — process.dlopen cannot load a native module from inside an asar, ' +
      'so any dependency with a native binary fails at runtime'
  )
  return unpack.length + ' asarUnpack rule(s)'
})

test('🔍 Nest unpacks the stdio MCP server it spawns as a child process', () => {
  const config = JSON.parse(fs.readFileSync(APPS[0].config, 'utf8'))
  const unpack = config.asarUnpack ?? []
  assert(
    unpack.some((p) => p.includes('server-filesystem')),
    'the File System capability spawns @modelcontextprotocol/server-filesystem as a child process; ' +
      'it must be unpacked so a real file path exists on disk'
  )
  return 'unpacked'
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log(`\n${failed.length} FAILED:`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}
