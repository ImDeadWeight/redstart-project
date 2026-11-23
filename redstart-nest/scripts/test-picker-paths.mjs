// =============================================================================
// Unit tests for src/launcher/components/pickerPaths.ts — the path arithmetic
// behind the file picker (breadcrumbs, joins, sizes, dates).
// =============================================================================
// The paths are the DAEMON's: a Windows Nest may be driven from a Mac browser
// and the reverse, so every case runs with Windows and POSIX paths alike,
// whatever this machine is.
//
// Run:  node scripts/test-picker-paths.mjs
// =============================================================================

import {
  crumbsFor, joinPath, splitFilePath, samePath, isUnder, formatSize, formatDate, baseName, isWindowsPath,
} from '../src/launcher/components/pickerPaths.ts'

let failed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ok  - ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${what}expected ${e}, got ${a}`)
}

const winRoots = [
  { path: 'C:\\Users\\you', label: 'Home', group: 'quick' },
  { path: 'C:\\', label: 'C: drive', group: 'drive' },
  { path: 'E:\\', label: 'E: drive', group: 'drive' },
]
const macRoots = [
  { path: '/Users/you', label: 'Home', group: 'quick' },
  { path: '/', label: 'Macintosh HD', group: 'drive' },
  { path: '/Volumes/USB Stick', label: 'USB Stick', group: 'drive' },
]

console.log('\n--- crumbsFor ---')

test('Windows: the drive from the sidebar starts the trail, by its own name', () => {
  eq(crumbsFor('E:\\Models\\flux', winRoots), [
    { label: 'E: drive', path: 'E:\\' },
    { label: 'Models', path: 'E:\\Models' },
    { label: 'flux', path: 'E:\\Models\\flux' },
  ])
})

test('Windows: a drive root is one crumb', () => {
  eq(crumbsFor('C:\\', winRoots), [{ label: 'C: drive', path: 'C:\\' }])
})

test('Windows: drive letters compare case-insensitively', () => {
  eq(crumbsFor('e:\\Models', winRoots)[0].label, 'E: drive')
})

test('Windows: a drive the sidebar does not know falls back to its letter', () => {
  eq(crumbsFor('Z:\\share\\x', winRoots), [
    { label: 'Z:', path: 'Z:\\' }, { label: 'share', path: 'Z:\\share' }, { label: 'x', path: 'Z:\\share\\x' },
  ])
})

test('Windows: a UNC path starts at its share', () => {
  eq(crumbsFor('\\\\nas\\models\\gguf', winRoots), [
    { label: 'nas\\models', path: '\\\\nas\\models\\' }, { label: 'gguf', path: '\\\\nas\\models\\gguf' },
  ])
})

test('Mac: the startup disk is "Macintosh HD", not a bare slash', () => {
  eq(crumbsFor('/Users/you/Models', macRoots), [
    { label: 'Macintosh HD', path: '/' },
    { label: 'Users', path: '/Users' },
    { label: 'you', path: '/Users/you' },
    { label: 'Models', path: '/Users/you/Models' },
  ])
})

test('Mac: a path on an external volume starts at that volume (longest match)', () => {
  eq(crumbsFor('/Volumes/USB Stick/models', macRoots), [
    { label: 'USB Stick', path: '/Volumes/USB Stick' },
    { label: 'models', path: '/Volumes/USB Stick/models' },
  ])
})

test('Mac: a volume name prefix is not a match ("/Volumes/USB Stick 2")', () => {
  eq(crumbsFor('/Volumes/USB Stick 2/x', macRoots)[0].label, 'Macintosh HD')
})

test('POSIX with no roots at all falls back to /', () => {
  eq(crumbsFor('/home/you', []), [
    { label: '/', path: '/' }, { label: 'home', path: '/home' }, { label: 'you', path: '/home/you' },
  ])
})

test('an empty path has no crumbs', () => {
  eq(crumbsFor('', winRoots), [])
})

console.log('\n--- joins and splits ---')

test('joinPath uses the separator the path already has', () => {
  eq(joinPath('E:\\Models', 'a.gguf'), 'E:\\Models\\a.gguf')
  eq(joinPath('C:\\', 'x'), 'C:\\x')
  eq(joinPath('/Users/you', 'a.gguf'), '/Users/you/a.gguf')
  eq(joinPath('/', 'Volumes'), '/Volumes')
})

test('splitFilePath keeps a root-level file\'s trailing separator', () => {
  eq(splitFilePath('C:\\model.gguf'), { dir: 'C:\\', name: 'model.gguf' })
  eq(splitFilePath('/model.gguf'), { dir: '/', name: 'model.gguf' })
  eq(splitFilePath('/Users/you/Models/a.gguf'), { dir: '/Users/you/Models', name: 'a.gguf' })
  eq(splitFilePath('E:\\Models\\'), { dir: 'E:\\Models', name: '' })
})

test('samePath: Windows case-insensitive and trailing-slash tolerant, POSIX exact', () => {
  eq(samePath('E:\\Models', 'e:\\models\\'), true)
  eq(samePath('C:\\', 'c:\\'), true)
  eq(samePath('/Users/You', '/Users/you'), false)
  eq(samePath('/Users/you/', '/Users/you'), true)
})

test('isUnder respects separator boundaries', () => {
  eq(isUnder('E:\\Models\\flux', 'E:\\Models'), true)
  eq(isUnder('E:\\Models2', 'E:\\Models'), false)
  eq(isUnder('/anything', '/'), true)
})

test('isWindowsPath reads the path, not the platform', () => {
  eq(isWindowsPath('C:\\x'), true)
  eq(isWindowsPath('\\\\nas\\x'), true)
  eq(isWindowsPath('/Users/you'), false)
})

test('baseName', () => {
  eq(baseName('E:\\Models\\flux'), 'flux')
  eq(baseName('/Users/you/Models/'), 'Models')
  eq(baseName('C:\\'), 'C:')
})

console.log('\n--- formatting ---')

test('formatSize: decimal units, one decimal under 100', () => {
  eq(formatSize(4), '4 B')
  eq(formatSize(2000), '2.0 KB')
  eq(formatSize(7.3e9), '7.3 GB')
  eq(formatSize(212e9), '212 GB')
  eq(formatSize(1.1e12), '1.1 TB')
  eq(formatSize(undefined), '')
  eq(formatSize(-1), '')
})

test('formatDate: no year this year, a year otherwise, empty for nothing', () => {
  const now = new Date(2026, 10, 23).getTime()
  const thisYear = formatDate(new Date(2026, 10, 12).getTime(), now)
  const lastYear = formatDate(new Date(2025, 10, 12).getTime(), now)
  if (/2026/.test(thisYear)) throw new Error(`this year's date carried a year: ${thisYear}`)
  if (!/2025/.test(lastYear)) throw new Error(`last year's date had no year: ${lastYear}`)
  eq(formatDate(undefined), '')
})

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
