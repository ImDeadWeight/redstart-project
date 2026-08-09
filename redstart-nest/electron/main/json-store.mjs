'use strict'

// =============================================================================
// Redstart Nest — Durable JSON writes
// =============================================================================
// Every piece of Redstart's persistent state is a JSON file in %APPDATA%:
// accounts.json, tools.json, profiles.json, conversations.json, prompt blocks.
// That is a deliberate scope decision for a single-user local appliance and is
// not what this module changes.
//
// What it changes is DURABILITY. Each of those files was written with a bare
// fs.writeFileSync, which truncates the target and then streams the new bytes
// in. Interrupt it — power loss, a forced process kill, a full disk — and the
// file on disk is a prefix of the intended content, i.e. invalid JSON. Every
// reader here is a `try { JSON.parse } catch { return <empty> }`, so the
// failure mode is not an error: it is a silent reset to defaults.
//
// For accounts.json that means the Owner record disappears and, since login is
// required by default and owner bootstrap is launcher-only, the appliance
// becomes unusable until someone re-bootstraps at the physical machine.
//
// The fix is the standard one: serialize to a sibling temp file, fsync it, then
// rename over the target. Rename is atomic within a volume on NTFS and POSIX
// alike, so a reader sees either the whole old file or the whole new one, never
// a torn prefix.
//
// NOT addressed here, because it is not a problem for this design: concurrent
// writers. All of these files are written from the single Electron main
// process, and writeFileSync/renameSync are synchronous, so there is no
// interleaving to guard against. If state ever moves out of process, this is
// the module that would grow locking.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'

/**
 * Write `data` as pretty-printed JSON to `filePath`, atomically.
 *
 * The temp file is a sibling of the target, never the OS temp directory:
 * rename is only atomic within a filesystem, and %APPDATA% and %TEMP% are
 * routinely on different volumes.
 */
export function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  // Unique per call so two writes to the same file can never share a temp name.
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  const payload = JSON.stringify(data, null, 2)

  let fd
  try {
    fd = fs.openSync(tmpPath, 'w')
    fs.writeFileSync(fd, payload, 'utf8')
    // Push the bytes to the device before the rename. Without this the rename
    // can land while the content is still only in the page cache, which on a
    // hard power loss yields an atomically-renamed EMPTY file — a tidier
    // version of the same data loss.
    try { fs.fsyncSync(fd) } catch { /* not all filesystems support it; the rename is still ordered */ }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }

  // Atomic within the volume, and overwrites on win32 as well as POSIX.
  fs.renameSync(tmpPath, filePath)
}

/**
 * Read and parse JSON, returning `fallback` when the file is absent, empty or
 * unparseable.
 *
 * The fallback is deliberate rather than a throw: a missing state file is the
 * normal first-run case. It does mean a CORRUPT file also reads as empty, which
 * is exactly the silent-reset hazard writeJsonAtomic exists to prevent — so a
 * file that exists but does not parse is preserved as `<name>.corrupt` before
 * the fallback is returned, giving a human something to recover from instead of
 * a folder where the data used to be.
 */
export function readJsonOr(filePath, fallback) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return fallback // absent — the normal first-run case
  }

  try {
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch {
    try {
      // Keep only the most recent corruption; a rescue copy per start would
      // otherwise pile up unbounded next to the real file.
      fs.writeFileSync(`${filePath}.corrupt`, raw, 'utf8')
      console.warn(`[json-store] ${path.basename(filePath)} did not parse; original preserved as ${path.basename(filePath)}.corrupt`)
    } catch { /* best effort — never let the rescue copy break startup */ }
    return fallback
  }
}
