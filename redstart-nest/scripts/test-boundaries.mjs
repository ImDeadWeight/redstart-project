// =============================================================================
// App boundaries — each app imports only itself and shared/ (Phase 7b)
// =============================================================================
// The repo holds three apps and two libraries:
//
//   chat-ui/        the chat app both Nest and Twig ship
//   redstart-nest/  Nest (daemon, launcher, shell)
//   redstart-twig/  Twig (twigd, shell)
//   shared/         modules more than one app imports
//   tooling/        build tools both apps run
//
// The rule (docs/development.md, "Which app owns what"):
//
//   code in          may import                   takes as a build artifact
//   chat-ui/         itself, shared/              —
//   redstart-nest/   itself, shared/, tooling/    chat-ui/dist
//   redstart-twig/   itself, shared/, tooling/    chat-ui/dist
//   shared/          itself                       —
//   tooling/         itself, shared/              —
//
// "Takes as a build artifact" means: a path into chat-ui/dist, or running
// chat-ui's own npm scripts (`npm --prefix ../chat-ui run build`). Never a
// path into chat-ui's source.
//
// Before Phase 7b, chat-ui lived inside Nest and Twig built it by reaching
// into Nest's tree, so a folder move in Nest could break Twig. This suite is
// what keeps that from creeping back.
//
// What is scanned, with comments stripped first (a comment naming the other
// half of a contract is documentation, not a dependency):
//   - IMPORTS, everywhere, tests included: relative import / export-from /
//     require() / import() specifiers in .mjs .js .cjs .ts .svelte, resolved
//     against the file. No app's code may import another app's code.
//   - PATHS, in app code only: path.join / path.resolve calls and Rust
//     .join("…") chains that start at the repo root (a `repo`/`REPO`/`root`
//     base, or a '..' climb) and name another area. Two kinds of file are
//     exempt, by design:
//       * tests (test-*.mjs, tests/, *.test.ts) may READ another app's files
//         as text to check a cross-app contract (one signing key, one
//         version, the installer layout), as test-packaging.mjs does;
//       * tooling/ WRITES into each app's build folder (make-icon's
//         per-variant output map) — producing an app's input is not
//         depending on its code.
//   - package.json scripts: `npm --prefix <dir>` and `node <path>` arguments
//
// ALLOWED below lists the remaining exceptions, each with its reason.
//
// Run:  node scripts/test-boundaries.mjs
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '..', '..')

const AREAS = ['chat-ui', 'redstart-nest', 'redstart-twig', 'shared', 'tooling']
const MAY_IMPORT = {
  'chat-ui': ['chat-ui', 'shared'],
  'redstart-nest': ['redstart-nest', 'shared', 'tooling'],
  'redstart-twig': ['redstart-twig', 'shared', 'tooling'],
  shared: ['shared'],
  tooling: ['tooling', 'shared'],
}
// The one artifact edge: the two shells ship chat-ui's build output.
const TAKES_CHAT_UI_DIST = new Set(['redstart-nest', 'redstart-twig'])

// Exceptions to the path rule, by file and the area it names. Keep this short;
// every entry says why it is not a dependency.
const ALLOWED = [
  {
    file: 'redstart-nest/scripts/dev-shell.mjs',
    area: 'chat-ui',
    why: "`npm run dev` compares chat-ui/dist's mtime with chat-ui/src's to warn that the bundle is stale; it reads timestamps only",
  },
]
const isAllowed = (rel, area) => ALLOWED.some(a => a.file === rel && a.area === area)

/** Tests may read other apps' files as text (contract checks); see the header. */
export function isTestFile(rel) {
  const base = rel.split('/').pop()
  return base.startsWith('test-') || /\.(test|spec)\.[cm]?[jt]s$/.test(base) || rel.split('/').includes('tests')
}

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dev-dist', 'build', 'target', 'bundle', 'gen', '.svelte-kit',
  'licenses', 'deps', 'llama-cpp', 'llama-cpp-turboquant', 'android', 'static', 'test-results',
  '.git', '.claude', '.idea', '.redstart-daemon',
])
const CODE_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.svelte', '.rs'])

// ── pure part: everything below up to the scan is testable in memory ───────

/** Which area an absolute path is in, or null for anywhere else. */
export function areaOf(abs) {
  const rel = path.relative(REPO, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  const top = rel.split(path.sep)[0]
  return AREAS.includes(top) ? top : null
}

/** Is `abs` inside chat-ui/dist? */
function inChatUiDist(abs) {
  const rel = path.relative(path.join(REPO, 'chat-ui', 'dist'), abs)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Strip // and /* *\/ comments, keeping string and template literals (so
 * 'http://x' survives) and newlines (so line numbers stay right).
 */
export function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += next ?? ''; i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++ }
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length

/**
 * Every place a code file reaches outside itself: { line, what, target }
 * where target is an absolute path when it could be resolved, or an area
 * name when only a path.join literal named one.
 */
export function references(file, src) {
  const code = stripComments(src)
  const dir = path.dirname(file)
  const refs = []

  // import x from '…' / export … from '…' / import '…' / import('…') / require('…')
  const spec = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]*)\1/g
  for (const m of code.matchAll(spec)) {
    refs.push({ line: lineOf(code, m.index), what: m[2], target: path.resolve(dir, m[2]) })
  }

  // Paths built from the repo root that name another area. Rust: a
  // `<base>.join("…").join("…")` chain; JS: path.join/resolve(<base>, '…').
  if (file.endsWith('.rs')) {
    const rustChain = /\b(\w+)((?:\s*\.join\(\s*"[^"]*"\s*\))+)/g
    for (const m of code.matchAll(rustChain)) {
      const literals = [...m[2].matchAll(/"([^"]*)"/g)].map(x => x[1])
      refs.push(...namedAreas(m[1], literals, `${m[1]}${m[2].replace(/\s+/g, '')}`, lineOf(code, m.index)))
    }
  } else {
    const joinCall = /\b(?:path\.)?(?:join|resolve)\s*\(\s*([\w.]+)?\s*,?([^()]*)\)/g
    for (const m of code.matchAll(joinCall)) {
      const literals = [...m[2].matchAll(/(['"])([^'"]*)\1/g)].map(x => x[2])
      refs.push(...namedAreas(m[1] ?? '', literals, m[0], lineOf(code, m.index)))
    }
  }
  return refs
}

const ROOT_BASE = /^(?:repo|REPO|root|ROOT|REPO_ROOT|repoRoot)$/

/**
 * A join's literals that name another area, if the join is rooted at the repo
 * (a repo-root base, or a '..' climb before the name). A join off any other
 * base — `resources.join("chat-ui")`, `out('chat-ui')` — is a folder in some
 * other tree that merely shares the name. chat-ui followed by dist is the
 * artifact.
 */
function namedAreas(base, literals, what, line) {
  const refs = []
  let climbed = ROOT_BASE.test(base)
  literals.forEach((lit, i) => {
    const parts = lit.split(/[\\/]/).filter(Boolean)
    parts.forEach((part, j) => {
      if (part === '..') { climbed = true; return }
      if (!climbed || !AREAS.includes(part)) return
      const after = parts[j + 1] ?? literals[i + 1]
      refs.push({ line, what, area: part, dist: part === 'chat-ui' && after === 'dist' })
    })
  })
  return refs
}

/** package.json scripts: npm --prefix <dir> and node <path> arguments. */
export function scriptReferences(pkgDir, scripts) {
  const refs = []
  for (const [name, cmd] of Object.entries(scripts ?? {})) {
    for (const m of cmd.matchAll(/--prefix\s+(\S+)\s+run\s+(\S+)/g)) {
      refs.push({ what: `${name}: npm --prefix ${m[1]} run ${m[2]}`, target: path.resolve(pkgDir, m[1]), npmRun: true })
    }
    for (const m of cmd.matchAll(/\bnode\s+(\.{1,2}\/\S+)/g)) {
      refs.push({ what: `${name}: node ${m[1]}`, target: path.resolve(pkgDir, m[1]) })
    }
  }
  return refs
}

/**
 * The verdict for one reference made from `from` (an area) in the file `rel`
 * (repo-relative, forward slashes). null = allowed.
 */
export function violation(from, ref, rel = '') {
  if (ref.area) {
    if (MAY_IMPORT[from].includes(ref.area)) return null
    if (from === 'tooling' || isTestFile(rel) || isAllowed(rel, ref.area)) return null
    if (ref.area === 'chat-ui' && ref.dist && TAKES_CHAT_UI_DIST.has(from)) return null
    return `${from} names ${ref.area}/ in a path`
  }
  const to = areaOf(ref.target)
  if (to === null || MAY_IMPORT[from].includes(to)) return null
  if (to === 'chat-ui' && TAKES_CHAT_UI_DIST.has(from)) {
    if (inChatUiDist(ref.target)) return null
    // Running chat-ui's own npm scripts at its root is how the artifact is made.
    if (ref.npmRun && ref.target === path.join(REPO, 'chat-ui')) return null
  }
  return `${from} reaches into ${to}/ (${path.relative(REPO, ref.target).split(path.sep).join('/')})`
}

// ── harness ─────────────────────────────────────────────────────────────────

const results = []
function test(name, fn) {
  try {
    const detail = fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

// A fixture file in `area`: does `src` break the rule?
function verdicts(area, rel, src) {
  const file = path.join(REPO, area, rel)
  return references(file, src).map(r => violation(area, r, `${area}/${rel}`)).filter(Boolean)
}

console.log('\n-- the checker itself (synthetic cases) --')

test('🔍 chat-ui importing daemon code is caught', () => {
  const v = verdicts('chat-ui', 'src/lib/x.ts', "import { a } from '../../../redstart-nest/daemon/auth.mjs'")
  assert(v.length === 1, `expected 1 violation, got ${JSON.stringify(v)}`)
})

test('🔍 Twig importing Nest via a dynamic import and require is caught', () => {
  const v = verdicts('redstart-twig', 'desktop/scripts/x.mjs',
    "const m = await import('../../../redstart-nest/scripts/x.mjs')\nconst n = require('../../../redstart-nest/daemon/y.mjs')")
  assert(v.length === 2, `expected 2 violations, got ${JSON.stringify(v)}`)
})

test('🔍 a path.join naming another app is caught; chat-ui/dist is not', () => {
  const bad = verdicts('redstart-twig', 'desktop/scripts/x.mjs', "path.join(REPO, 'redstart-nest', 'scripts', 'stage-node.mjs')")
  assert(bad.length === 1, `expected 1 violation, got ${JSON.stringify(bad)}`)
  const ok = verdicts('redstart-twig', 'desktop/scripts/x.mjs', "path.join(REPO, 'chat-ui', 'dist')")
  assert(ok.length === 0, `chat-ui/dist was refused: ${JSON.stringify(ok)}`)
  const src = verdicts('redstart-nest', 'scripts/x.mjs', "path.join(REPO, 'chat-ui', 'src', 'lib')")
  assert(src.length === 1, `chat-ui source was allowed: ${JSON.stringify(src)}`)
})

test('🔍 a Rust .join chain naming another app is caught', () => {
  const v = verdicts('redstart-twig', 'desktop/shell/src/paths.rs', 'let p = twig.join("..").join("redstart-nest").join("deps");')
  assert(v.length === 1, `expected 1 violation, got ${JSON.stringify(v)}`)
  const ok = verdicts('redstart-twig', 'desktop/shell/src/paths.rs', 'let a = repo.join("chat-ui").join("dist");')
  assert(ok.length === 0, `chat-ui/dist from the repo root was refused: ${JSON.stringify(ok)}`)
})

test('a folder that only shares an app\'s name is not that app', () => {
  const v = verdicts('redstart-twig', 'desktop/shell/src/paths.rs', 'chat_ui: resources.join("chat-ui"),')
  assert(v.length === 0, `resources/chat-ui counted as the repo's chat-ui: ${JSON.stringify(v)}`)
  const w = verdicts('redstart-nest', 'scripts/stage-shell-bundle.mjs', "copyDir(x, out('chat-ui'))")
  assert(w.length === 0, `out('chat-ui') counted: ${JSON.stringify(w)}`)
})

test('tests may read another app\'s files as text; they still may not import its code', () => {
  assert(verdicts('redstart-nest', 'scripts/test-x.mjs', "path.join(REPO, 'redstart-twig', 'desktop')").length === 0,
    'a contract test reading Twig was refused')
  assert(verdicts('redstart-nest', 'scripts/test-x.mjs', "import '../../redstart-twig/desktop/daemon/x.mjs'").length === 1,
    'a test importing Twig code was allowed')
})

test('🔍 shared/ importing an app is caught; tooling/ importing shared/ is not', () => {
  assert(verdicts('shared', 'x.mjs', "import '../redstart-nest/daemon/x.mjs'").length === 1, 'shared -> nest allowed')
  assert(verdicts('tooling', 'x.mjs', "import { a } from '../shared/update-feed.mjs'").length === 0, 'tooling -> shared refused')
  assert(verdicts('shared', 'x.mjs', "import '../tooling/x.mjs'").length === 1, 'shared -> tooling allowed')
})

test('comments are skipped, strings that look like comments are not', () => {
  const v = verdicts('chat-ui', 'src/x.ts',
    "// see '../../redstart-nest/daemon/x.mjs'\n/* import '../../redstart-twig/y.mjs' */\nconst u = 'http://x'; import a from '../src/ok.ts'")
  assert(v.length === 0, `a comment counted: ${JSON.stringify(v)}`)
  const s = stripComments("const u = 'http://x' // tail\n")
  assert(s.includes("'http://x'") && !s.includes('tail'), `stripComments mangled: ${s}`)
})

test('🔍 package scripts: npm --prefix into another app is caught; running chat-ui is not', () => {
  const nestDir = path.join(REPO, 'redstart-nest')
  const twigRefs = scriptReferences(path.join(REPO, 'redstart-twig', 'desktop'), {
    build: 'npm --prefix ../../redstart-nest run build && node ../../redstart-nest/scripts/x.mjs',
  })
  assert(twigRefs.map(r => violation('redstart-twig', r)).filter(Boolean).length === 2, 'Twig scripts into Nest allowed')
  const nestRefs = scriptReferences(nestDir, { 'build:chat': 'npm --prefix ../chat-ui run build', i: 'node ../tooling/make-icon.mjs' })
  const v = nestRefs.map(r => violation('redstart-nest', r)).filter(Boolean)
  assert(v.length === 0, `allowed script refs refused: ${v.join('; ')}`)
})

// ── the real tree ───────────────────────────────────────────────────────────

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name))
    } else if (CODE_EXT.has(path.extname(e.name)) && !e.name.endsWith('.d.ts')) {
      yield path.join(dir, e.name)
    } else if (e.name === 'package.json') {
      yield path.join(dir, e.name)
    }
  }
}

console.log('\n-- the repo --')

const self = fileURLToPath(import.meta.url)
const found = []
let scanned = 0
for (const area of AREAS) {
  for (const file of walk(path.join(REPO, area))) {
    if (file === self) continue // its fixtures are violations on purpose
    scanned++
    const rel = path.relative(REPO, file).split(path.sep).join('/')
    if (path.basename(file) === 'package.json') {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const r of scriptReferences(path.dirname(file), pkg.scripts)) {
        const v = violation(area, r, rel)
        if (v) found.push(`${rel}: ${r.what} — ${v}`)
      }
      continue
    }
    for (const r of references(file, fs.readFileSync(file, 'utf8'))) {
      const v = violation(area, r, rel)
      if (v) found.push(`${rel}:${r.line}: ${r.what} — ${v}`)
    }
  }
}

test('every ALLOWED exception is still needed (a stale one hides nothing, but rots)', () => {
  const stale = ALLOWED.filter(a => {
    const file = path.join(REPO, a.file)
    if (!fs.existsSync(file)) return true
    return !references(file, fs.readFileSync(file, 'utf8')).some(r => r.area === a.area)
  })
  assert(stale.length === 0, `no longer needed: ${stale.map(a => `${a.file} -> ${a.area}`).join(', ')}`)
})

test('🔍 no app reaches into another app\'s source (the §3 table)', () => {
  assert(scanned > 500, `scanned only ${scanned} files — has the layout changed?`)
  assert(found.length === 0, `${found.length} boundary violation(s):\n        ${found.join('\n        ')}`)
  return `${scanned} files`
})

test('every area exists where this check expects it', () => {
  const missing = AREAS.filter(a => !fs.existsSync(path.join(REPO, a)))
  assert(missing.length === 0, `missing: ${missing.join(', ')}`)
})

const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
