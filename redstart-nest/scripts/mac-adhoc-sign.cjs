// electron-builder afterPack hook — ad-hoc signs the macOS .app.
//
// Shared by both apps (Twig's electron-builder.json points here too). CommonJS
// because electron-builder 24 loads hooks with require(), and this package is
// "type": "module".
//
// Why it exists: with no Developer ID certificate, electron-builder 24 skips
// signing entirely (mac.identity: null makes that explicit rather than a
// keychain search that happens to find nothing). On Apple Silicon an unsigned
// — or signed-then-modified — bundle is not merely untrusted, it is refused
// outright as "damaged", and electron-builder's own edits (Info.plist, the
// renamed executable, the added resources) invalidate the ad-hoc signature
// Electron's prebuilt binary arrives with. Re-signing ad-hoc after packing
// makes the bundle internally consistent again.
//
// What it does NOT do: an ad-hoc signature carries no identity and is not
// notarized, so Gatekeeper still blocks the first launch of a downloaded copy.
// The user clears that once (Privacy & Security → Open Anyway, or
// `xattr -dr com.apple.quarantine`). The real fix is a Developer ID
// certificate plus notarization, tracked in docs/roadmap.md → Signed installers.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function codesign(target, extra = []) {
  execFileSync('codesign', ['--force', '--sign', '-', ...extra, target], { stdio: 'inherit' })
}

// By magic number rather than extension or mode bit: llama-server has no
// extension, and an executable-bit check would also catch shell scripts, which
// codesign would "sign" into an extended attribute instead of failing.
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca])
function isMachO(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(4)
    return fs.readSync(fd, head, 0, 4, 0) === 4 && MACHO_MAGIC.has(head.readUInt32BE(0))
  } finally {
    fs.closeSync(fd)
  }
}

// `codesign --deep` only descends into the standard nested-code locations
// (Frameworks, Helpers, MacOS) — never into Resources. Nest's llama-server and
// its dylibs live in Resources/bin and are spawned as separate processes, so
// they are signed individually, inside-out, before the bundle itself.
function looseMachO(dir) {
  if (!fs.existsSync(dir)) return []
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue // signing the target covers it
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app') || entry.name === 'app.asar') continue
      found.push(...looseMachO(full))
    } else if (isMachO(full)) {
      found.push(full)
    }
  }
  return found
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  for (const file of looseMachO(path.join(app, 'Contents', 'Resources'))) codesign(file)
  codesign(app, ['--deep'])

  // Fail the build here, not on a user's machine: a bundle that does not
  // verify is exactly the "damaged" dialog this hook exists to prevent.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
}
