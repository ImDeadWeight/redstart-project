// =============================================================================
// A llama-server binary the daemon will accept, that runs a Node script
// =============================================================================
// The daemon launches whatever settings.serverBinPath names, after
// binaryPathRejection() (ipc/validate.mjs): an absolute path to a file that
// is an .exe on Windows and executable elsewhere. A test that wants the REAL
// daemon to launch a FAKE model needs such a file. This makes one in `dir`
// that runs `node <script> <the daemon's args>`:
//
//   POSIX    a shell script with the execute bit that execs node (so the
//            daemon's pid IS the node process, and its group kill reaches it)
//   Windows  a small C# program compiled with the csc.exe that ships with the
//            .NET Framework (present on every Windows 10/11), which starts
//            node with the same arguments, inherits stdio, waits, and returns
//            its exit code. The daemon's tree kill (taskkill /T) takes node
//            with it; fake-llama-server.mjs also exits when its parent does.
//
// Returns the path, or null with a reason when it cannot be built here.
// =============================================================================

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
]

/** A C# string literal. */
const cs = (s) => '@"' + s.replace(/"/g, '""') + '"'

/**
 * @param {string} dir     where to put the binary
 * @param {string} script  the .mjs to run
 * @returns {{ path: string } | { path: null, reason: string }}
 */
export function makeFakeServerBinary(dir, script) {
  fs.mkdirSync(dir, { recursive: true })
  if (process.platform !== 'win32') {
    const p = path.join(dir, 'llama-server')
    fs.writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
    fs.chmodSync(p, 0o755)
    return { path: p }
  }

  const csc = CSC_CANDIDATES.find((c) => fs.existsSync(c))
  if (!csc) return { path: null, reason: 'no csc.exe (.NET Framework 4) to build the Windows shim' }
  const src = path.join(dir, 'shim.cs')
  const exe = path.join(dir, 'llama-server.exe')
  fs.writeFileSync(src, `
using System;
using System.Diagnostics;
using System.Text;
class Shim {
  // Windows command-line quoting (CommandLineToArgvW rules).
  static string Q(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\\t', '"' }) < 0) return a;
    var sb = new StringBuilder("\\"");
    int bs = 0;
    foreach (char c in a) {
      if (c == '\\\\') { bs++; continue; }
      if (c == '"') { sb.Append('\\\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
      sb.Append('\\\\', bs); bs = 0; sb.Append(c);
    }
    sb.Append('\\\\', bs * 2); sb.Append('"');
    return sb.ToString();
  }
  static int Main(string[] args) {
    var line = new StringBuilder(Q(${cs(script)}));
    foreach (var a in args) { line.Append(' '); line.Append(Q(a)); }
    var psi = new ProcessStartInfo(${cs(process.execPath)}, line.ToString());
    psi.UseShellExecute = false;
    var p = Process.Start(psi);
    p.WaitForExit();
    return p.ExitCode;
  }
}
`)
  try {
    execFileSync(csc, ['/nologo', '/target:exe', `/out:${exe}`, src], { stdio: 'pipe' })
  } catch (err) {
    return { path: null, reason: `csc failed: ${String(err.stdout ?? err.message).slice(0, 300)}` }
  }
  return { path: exe }
}
