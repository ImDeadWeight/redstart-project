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

// The packaged ELECTRON app (Twig): where its config lives, which directory is
// the app root (the thing that becomes app.asar), and which trees hold its
// main-process sources. Nest is no longer an Electron app (daemon split T4):
// its package is shell/bundle/resources, built by stage-shell-bundle.mjs, and
// its checks follow that script below.
const APPS = [
  {
    name: 'Redstart Twig',
    appRoot: path.join(REPO, 'redstart-twig', 'windows'),
    config: path.join(REPO, 'redstart-twig', 'windows', 'electron-builder.json'),
    sourceDirs: ['electron'],
  },
]

const NEST = path.join(REPO, 'redstart-nest')
const STAGE_SRC = fs.readFileSync(path.join(NEST, 'scripts', 'stage-shell-bundle.mjs'), 'utf8')

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

// Nest: the daemon runs from resources/app, so an import escaping
// redstart-nest/ by one level lands in resources/<top>. stage-shell-bundle
// must copy exactly that directory there, or nestd dies at startup with
// ERR_MODULE_NOT_FOUND.
{
  const escaping = []
  for (const dir of ['electron/main', 'bin']) {
    for (const file of walk(path.join(NEST, dir))) {
      for (const spec of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
        const levels = escapeLevels(NEST, file, spec)
        if (levels > 0) escaping.push({ file, spec, levels, top: escapedTopLevel(NEST, file, spec) })
      }
    }
  }
  test('🔍 Redstart Nest: every escaping import is staged where the daemon will look', () => {
    assert(escaping.length > 0, 'expected at least the ../../../shared import')
    for (const { file, spec, levels, top } of escaping) {
      assert(levels === 1, `${path.relative(REPO, file)} imports ${spec}, escaping ${levels} levels; only resources/<dir> is staged`)
      assert(fs.existsSync(path.resolve(path.dirname(file), spec)), `${spec} does not exist`)
      assert(STAGE_SRC.includes(`out('${top}')`), `${spec} lands in resources/${top}, which stage-shell-bundle.mjs never writes`)
    }
    return `${escaping.length} escaping import(s)`
  })
}

console.log('\n-- the launcher title bar --')

// TopBar is the window's title bar in the Tauri shell (Windows: it carries the
// page-drawn buttons at full height; macOS: the traffic lights sit over it),
// and index.html draws the same bar before React has loaded. If the two
// heights differ the bar jumps the moment the app mounts.
test('🔍 the title bar is the same height in React and in index.html', () => {
  const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')
  // Tailwind's h-12 is 3rem — 48px at the browser default root size.
  const ui = read('redstart-nest/src/components/ui.tsx')
  // A plain string or a template literal (TopBar's padding differs by platform).
  assert(/className=(?:"|\{`)[^"`]*\bh-12[ "`]/.test(ui), 'TopBar no longer uses h-12')
  const bootHeight = Number(/height:\s*(\d+)px/.exec(read('redstart-nest/index.html'))?.[1])
  assert(bootHeight === 48, `index.html's pre-mount bar is ${bootHeight}px but TopBar is h-12 (48px)`)
  return '48px, both ways'
})

console.log('\n-- what the daemon needs at runtime is staged --')

test('🔍 Nest stages its production dependencies from the lockfile, including the MCP server it spawns', () => {
  assert(/npm ci --omit=dev/.test(STAGE_SRC), 'stage-shell-bundle.mjs must install from package-lock.json with --omit=dev')
  const pkg = JSON.parse(fs.readFileSync(path.join(NEST, 'package.json'), 'utf8'))
  // The File System capability spawns it as a child process from a real path.
  assert(pkg.dependencies?.['@modelcontextprotocol/server-filesystem'], 'server-filesystem must be a production dependency or it is not staged')
  assert(!pkg.dependencies?.electron && !pkg.devDependencies?.electron, 'Nest no longer ships Electron')
  return 'npm ci --omit=dev'
})

test('🔍 Nest stages bin/ and the daemon tree, where the shell spawns nestd', () => {
  for (const d of ["out('app', 'bin')", "out('app', 'electron', 'main')", "out('app', 'dist')"]) {
    assert(STAGE_SRC.includes(d), `stage-shell-bundle.mjs no longer writes ${d}`)
  }
  for (const f of ['nestd.mjs', 'shell-mode.mjs', 'stdout-guard.mjs', 'nest-dir.mjs']) {
    assert(fs.existsSync(path.join(NEST, 'bin', f)), `bin/${f} is missing`)
  }
})

test('🔍 Nest stages the pinned Node runtime with its licence', () => {
  assert(/stagedBinaryPath\(process\.platform\)/.test(STAGE_SRC), 'the staged Node is not the one stage-node.mjs pinned')
  assert(STAGE_SRC.includes("out('node', 'LICENSE')"), "Node's LICENSE travels with the binary it covers")
})

console.log('\n-- the Tauri shell and its installer (daemon split T2/T3) --')

const SHELL = path.join(REPO, 'redstart-nest', 'shell')
const readShell = (rel) => fs.readFileSync(path.join(SHELL, rel), 'utf8')

test('🔍 the window-controls capability covers the admin origin and nothing but window chrome', () => {
  const cap = JSON.parse(readShell('capabilities/window-controls.json'))
  const ports = fs.readFileSync(path.join(REPO, 'redstart-nest', 'electron', 'main', 'ports.mjs'), 'utf8')
  const adminPort = /ADMIN_PORT\s*=\s*(\d+)/.exec(ports)?.[1]
  assert(adminPort, 'could not read ADMIN_PORT from ports.mjs')
  assert(cap.remote?.urls?.includes(`http://127.0.0.1:${adminPort}/*`),
    `the capability's origin must be the admin listener (127.0.0.1:${adminPort}), or the page's window buttons stop working`)
  assert(cap.windows?.length === 1 && cap.windows[0] === 'main', 'granted to a window other than main')
  const bad = (cap.permissions ?? []).filter((p) => !/^core:(window|event):allow-/.test(p))
  assert(bad.length === 0, `the admin page must get window chrome only, not: ${bad.join(', ')}`)
  return `${cap.permissions.length} permissions`
})

test('🔍 the shell is the same app (identifier) at the same version, with an updater key', () => {
  const conf = JSON.parse(readShell('tauri.conf.json'))
  assert(conf.identifier === 'com.redstart.nest', `identifier ${conf.identifier}`)
  assert(conf.version === '../package.json', 'version must come from package.json, which the release job bumps')
  const pub = Buffer.from(conf.plugins?.updater?.pubkey ?? '', 'base64').toString('utf8')
  assert(pub.startsWith('untrusted comment: minisign public key'), 'plugins.updater.pubkey is not a minisign public key')
})

test('🔍 the installer ships the staged layout paths.rs reads, signed for the updater', () => {
  const b = JSON.parse(readShell('tauri.bundle.conf.json')).bundle
  assert(b.resources?.['bundle/resources/'] === 'resources/', 'bundle/resources/ must land at <resource_dir>/resources/')
  assert(b.createUpdaterArtifacts === true, 'no .sig, no update')
  assert(b.windows?.nsis?.installMode === 'currentUser', 'per-user, like the Electron install it replaces')
  assert(fs.existsSync(path.join(SHELL, b.windows.nsis.installerHooks)), 'installerHooks file missing')
  const paths = readShell('src/paths.rs')
  assert(paths.includes('.join("node").join(node_exe())') && paths.includes('.join("app").join("bin").join("nestd.mjs")'),
    'paths.rs no longer reads resources/node and resources/app/bin/nestd.mjs')
  const stage = fs.readFileSync(path.join(REPO, 'redstart-nest', 'scripts', 'stage-shell-bundle.mjs'), 'utf8')
  assert(stage.includes("out('node', win ? 'node.exe' : 'node')") && stage.includes("out('app', 'bin')"), 'stage-shell-bundle.mjs no longer writes that layout')
})

test('🔍 the bridge replaces the Electron install it updates from', () => {
  const hooks = readShell(JSON.parse(readShell('tauri.bundle.conf.json')).bundle.windows.nsis.installerHooks)
  // electron-builder's per-user uninstall key: a UUID v5 of the appId.
  assert(hooks.includes('09e3ae85-f70e-5de1-8268-af6ccbf16b9b'), 'the Electron uninstall key GUID is missing')
  assert(hooks.includes('_?='), 'without _?= the uninstaller returns at once and ExecWait does not wait')
  assert(hooks.includes('"electron.app.Redstart Nest"'), "Electron's login item would survive the bridge")
  assert(hooks.includes('--force-run'), "electron-updater's Restart to update would leave the app stopped")
})

console.log('\n-- resources the daemon reaches for at runtime --')

// Each of these shipped broken once and failed nothing: the app starts fine
// without them and only degrades. They read stage-shell-bundle.mjs
// statically, so they hold in CI where deps/ and llama-cpp-turboquant/ do
// not exist.

test('🔍 Nest stages elevate.exe, which firewall.mjs resolves from the resources dir', () => {
  assert(STAGE_SRC.includes("out('elevate.exe')"),
    'firewall.mjs looks for <resources>/elevate.exe to add inbound rules with UAC. It fails SOFT when the ' +
      'file is absent (logs a warning, skips the rule), so LAN mode would appear broken for no visible reason.')
  return 'staged'
})

test('🔍 the DLL filter is case-insensitive, or uppercase .DLL files are dropped', () => {
  assert(/\/\\\.dll\$\/i/.test(STAGE_SRC),
    'stage-shell-bundle.mjs must match DLLs case-insensitively: the VC++ redistributable ships VCOMP140.DLL in ' +
      'uppercase, llama-server is built with OPENMP=1 and links it, and a case-sensitive filter silently dropped it once.')
  return '/\\.dll$/i'
})

test("🔍 Nest's mac build stages llama-server and its dylibs where daemon.mjs looks", () => {
  // resolveBinary() checks <resources>/bin/<serverBinaryName()> and nothing
  // else when packaged.
  assert(/path\.basename\(p\) === 'llama-server'/.test(STAGE_SRC), 'no mac llama-server (no .exe) staged into bin/')
  assert(/\\\.dylib\$/.test(STAGE_SRC),
    'llama-server on macOS loads libllama/libggml*.dylib beside it; the executable alone dies with "Library not loaded"')
})

test('🔍 every mac build is ad-hoc signed, or Apple Silicon calls it damaged', () => {
  // Twig (electron-builder 24 skips signing without a certificate, and its own
  // edits invalidate Electron's signature): an afterPack hook signs.
  for (const app of APPS) {
    const config = JSON.parse(fs.readFileSync(app.config, 'utf8'))
    if (!config.mac) continue
    assert(config.afterPack, `${app.name}: mac target declared but no afterPack hook signs the bundle`)
    const hook = path.resolve(path.dirname(app.config), config.afterPack)
    assert(fs.existsSync(hook), `${app.name}: afterPack points at ${config.afterPack}, which does not exist`)
    assert(/codesign/.test(fs.readFileSync(hook, 'utf8')), `${app.name}: afterPack hook ${config.afterPack} never calls codesign`)
  }
  // Nest (Tauri): every staged Mach-O is signed, and the .app ad-hoc.
  assert(/adhocSignMachO\(BUNDLE_DIR\)/.test(STAGE_SRC) && /'codesign'/.test(STAGE_SRC), 'Nest: staged Mach-O files are not signed')
  const mac = JSON.parse(fs.readFileSync(path.join(NEST, 'shell', 'tauri.bundle.conf.json'), 'utf8')).bundle.macOS
  assert(mac?.signingIdentity === '-', 'Nest: bundle.macOS.signingIdentity must be "-" (ad-hoc)')
  return 'Twig hooked, Nest staged + ad-hoc'
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
