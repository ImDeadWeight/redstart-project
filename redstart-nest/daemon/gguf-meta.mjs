'use strict'

// =============================================================================
// Redstart Nest — GGUF header metadata (general.* keys only)
// =============================================================================
// Reads the `general.*` string keys of a GGUF file's header: architecture,
// name, basename, size label. Used to check a chat-template override against
// the model it is about to be applied to (chat-template-choice.mjs), because a
// file name or display name is not a reliable identity.
//
// GGUF layout (v2/v3): magic "GGUF", u32 version, u64 tensor count, u64 kv
// count, then kv pairs: string key, u32 value type, value. Strings are a u64
// length plus bytes. Writers (gguf-py, llama.cpp) put general.architecture
// first and the general.* block before the tokenizer arrays.
//
// BOUNDED: only the first READ_LIMIT bytes are read, and parsing stops at the
// first key outside general.* once the architecture is known. The tokenizer
// arrays that follow are tens of MB; nothing here walks them. A header that
// does not fit, is not GGUF, or is truncated yields what was read so far (or
// null), never a throw: the caller treats "unknown" as "cannot check".
// =============================================================================

import * as fs from 'fs'

const READ_LIMIT = 1024 * 1024

// Byte sizes of the fixed-width GGUF value types (spec: gguf.md).
const FIXED = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
const T_STRING = 8
const T_ARRAY = 9

/**
 * Parse general.* string keys out of a GGUF header buffer.
 *
 * @param {Buffer} buf the start of the file
 * @returns {{ version: number, architecture: string | null, name: string | null,
 *   basename: string | null, sizeLabel: string | null } | null} null when not GGUF
 */
export function parseGgufGeneral(buf) {
  if (buf.length < 24 || buf.toString('ascii', 0, 4) !== 'GGUF') return null
  let o = 4
  const need = (n) => { if (o + n > buf.length) throw new RangeError('truncated') }
  const u32 = () => { need(4); const v = buf.readUInt32LE(o); o += 4; return v }
  const u64 = () => { need(8); const v = buf.readBigUInt64LE(o); o += 8; return v }
  const str = () => {
    const n = u64()
    if (n > BigInt(buf.length)) throw new RangeError('truncated')
    need(Number(n))
    const s = buf.toString('utf8', o, o + Number(n))
    o += Number(n)
    return s
  }
  const skip = (type) => {
    if (type === T_STRING) { str(); return }
    if (type === T_ARRAY) {
      const elem = u32()
      const count = u64()
      if (elem === T_STRING) { for (let i = 0n; i < count; i++) str(); return }
      const size = FIXED[elem]
      if (!size) throw new RangeError('bad array type')
      const bytes = Number(count) * size
      need(bytes)
      o += bytes
      return
    }
    const size = FIXED[type]
    if (!size) throw new RangeError('bad type')
    need(size)
    o += size
  }

  /** @type {Record<string, string>} */
  const general = {}
  let version = 0
  try {
    version = u32()
    u64() // tensor count
    const kvCount = u64()
    for (let i = 0n; i < kvCount; i++) {
      const key = str()
      const type = u32()
      if (!key.startsWith('general.') && general['general.architecture']) break
      if (key.startsWith('general.') && type === T_STRING) general[key] = str()
      else skip(type)
    }
  } catch {
    // Truncated or unusual header: keep what was read.
  }
  return {
    version,
    architecture: general['general.architecture'] ?? null,
    name: general['general.name'] ?? null,
    basename: general['general.basename'] ?? null,
    sizeLabel: general['general.size_label'] ?? null,
  }
}

/**
 * Read a model file's general.* metadata. Null when the file cannot be read
 * or is not GGUF.
 *
 * @param {string} filePath
 */
export function readGgufGeneral(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(READ_LIMIT)
    const n = fs.readSync(fd, buf, 0, READ_LIMIT, 0)
    return parseGgufGeneral(buf.subarray(0, n))
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}
