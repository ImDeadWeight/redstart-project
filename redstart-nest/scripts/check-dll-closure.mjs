#!/usr/bin/env node
// Proves a staged Windows binary set is closed under its own imports: every
// DLL that llama-server.exe (transitively) imports is either in the staged
// directories, part of base Windows, or provided by the NVIDIA driver.
//
//   node scripts/check-dll-closure.mjs <entry.exe> <dir> [<dir> ...]
//
// Why a static check rather than running the binary: ggml-cuda.dll imports
// nvcuda.dll, which only an installed NVIDIA driver provides. A GPU-less CI
// runner cannot load llama-server.exe at all, so "does it start" is not a
// question CI can ask — but "would every import resolve on a user's machine"
// is, and it is the question that matters. A DLL missing from the installer
// fails on every machine that lacks it system-wide, which is how VCOMP140.DLL
// shipped absent (see test-packaging.mjs).
//
// Runs on the Windows release job; pure Node, no dependencies.

import fs from 'node:fs'
import path from 'node:path'

// Supplied by the GPU driver, never redistributable — correct to leave out.
const DRIVER_PROVIDED = new Set(['nvcuda.dll'])

// Redistributables the installer MUST carry. A match in System32 does not
// count for these: the runner has them installed, a user's machine may not.
const MUST_SHIP = /^(msvcp|vcruntime|vcomp|concrt|cublas|cudart)/i

/** Import-table DLL names of one PE file (PE32 and PE32+). */
function peImports(file) {
  const d = fs.readFileSync(file)
  if (d.readUInt16LE(0) !== 0x5a4d) throw new Error(`${file}: not a PE file`)
  const pe = d.readUInt32LE(0x3c)
  const sections = d.readUInt16LE(pe + 6)
  const optSize = d.readUInt16LE(pe + 20)
  const opt = pe + 24
  const isPE32Plus = d.readUInt16LE(opt) === 0x20b
  const importDir = opt + (isPE32Plus ? 112 : 96) + 8 // data directory #1
  const importRva = d.readUInt32LE(importDir)
  if (importRva === 0) return []

  const table = opt + optSize
  const toOffset = (rva) => {
    for (let i = 0; i < sections; i++) {
      const s = table + i * 40
      const vsize = d.readUInt32LE(s + 8), va = d.readUInt32LE(s + 12), raw = d.readUInt32LE(s + 20)
      if (rva >= va && rva < va + Math.max(vsize, 1)) return rva - va + raw
    }
    throw new Error(`${file}: RVA 0x${rva.toString(16)} is in no section`)
  }

  const names = []
  for (let p = toOffset(importRva); ; p += 20) {
    const nameRva = d.readUInt32LE(p + 12)
    if (nameRva === 0) break
    const o = toOffset(nameRva)
    names.push(d.toString('latin1', o, d.indexOf(0, o)))
  }
  return names
}

function main() {
  const [entry, ...dirs] = process.argv.slice(2)
  if (!entry || dirs.length === 0) {
    console.error('usage: check-dll-closure.mjs <entry.exe> <dir> [<dir> ...]')
    process.exit(2)
  }

  const staged = new Map() // lowercased name -> path
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) staged.set(name.toLowerCase(), path.join(dir, name))
  }
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

  const missing = []
  const seen = new Set()
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()
    for (const dll of peImports(file)) {
      const key = dll.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (staged.has(key)) {
        queue.push(staged.get(key))
      } else if (DRIVER_PROVIDED.has(key)) {
        console.log(`  driver   ${dll}`)
      } else if (MUST_SHIP.test(key)) {
        missing.push(`${dll} (imported by ${path.basename(file)}; a redistributable — must be staged)`)
      } else if (/^(api|ext)-ms-/.test(key) || fs.existsSync(path.join(system32, dll))) {
        // Base Windows: API sets and OS DLLs every supported install has.
      } else {
        missing.push(`${dll} (imported by ${path.basename(file)})`)
      }
    }
  }

  const shipped = [...seen].filter((k) => staged.has(k))
  console.log(`  staged   ${shipped.length} DLL(s) reached from ${path.basename(entry)}: ${shipped.join(', ')}`)
  if (missing.length) {
    console.error(`\n${missing.length} import(s) would not resolve on a clean machine:`)
    for (const m of missing) console.error(`  - ${m}`)
    process.exit(1)
  }
  console.log('  ok — every import resolves')
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check-dll-closure.mjs')) main()
