// =============================================================================
// Redstart Nest — the run_python sandbox child (one Pyodide kernel)
// =============================================================================
// Spawned by python-kernel.mjs as
//
//   <node ≥ 25> --permission
//               --allow-fs-read=<dist>/*  --allow-fs-read=<this file>
//               --allow-fs-read=<workspace>/*  --allow-fs-write=<workspace>/*
//               --disallow-code-generation-from-strings
//               python-child.mjs <dist> <workspace>
//
// with an empty environment (SYSTEMROOT alone on Windows). Model-written code is
// attacker-influenced code, so what contains it, in order of strength:
//
//   1. WebAssembly. CPython here has no syscalls; its reach is whatever JS
//      objects the host exposes (`import js`, `import pyodide_js`).
//   2. Node's permission model. No --allow-net, --allow-child-process,
//      --allow-worker or --allow-addons, so the runtime refuses every socket,
//      spawn, worker and native addon from ANY code path, including Pyodide's
//      own NodeSockFS. That is what Phase 1.0's escape #2 needed (it came from
//      inside Pyodide, where nothing in this file could intercept it). fs is
//      limited to the distribution, this script and the workspace.
//   3. Codegen off. `js.eval("import('node:http')")` was escape #1 under Node
//      20. The runtime denies the connection now as well, but there's no
//      reason to hand the sandbox an eval.
//   4. Deletions and refusals below: process.binding answers one question,
//      getBuiltinModule/dlopen/require are gone, fetch/WebSocket are gone,
//      loadPackage refuses anything outside the installed set.
//
// Layers 3 and 4 are defence in depth; scripts/test-python-sandbox.mjs proves
// layer 2 alone holds the network (zero connections reach its stub).
//
// Protocol: one JSON object per line on stdin; every reply is one line on
// stdout starting with REPLY_MARK, so a stray print from Emscripten can never
// be read as a reply. Python's own stdout/stderr go to callbacks, not here.
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

const REPLY_MARK = '\u001eRS '
const STREAM_CAP = 64 * 1024

const [dist, workspace] = process.argv.slice(2)

function reply(obj) {
  process.stdout.write(REPLY_MARK + JSON.stringify(obj) + '\n')
}

// An async permission denial (a socket the runtime refused) surfaces as an
// unhandled 'error' event. Without this the kernel dies and takes the
// conversation's variables with it, for something the sandbox did right.
process.on('uncaughtException', (err) => { reply({ type: 'log', message: `uncaught: ${err?.code || ''} ${err?.message || err}` }) })
process.on('unhandledRejection', (err) => { reply({ type: 'log', message: `unhandled: ${err?.code || ''} ${err?.message || err}` }) })

// Emscripten's NODEFS asks process.binding('constants') for open() flags, and
// the permission model refuses process.binding outright. Answer that one
// question and nothing else.
process.binding = (name) => {
  if (name === 'constants') return { fs: fs.constants, os: {} }
  throw new Error(`process.binding(${name}) is not available in the sandbox`)
}

const lock = JSON.parse(fs.readFileSync(path.join(dist, 'pyodide-lock.json'), 'utf8'))
const installed = new Set(fs.readdirSync(dist).filter((f) => f.endsWith('.whl')))
// Packages whose wheel is actually present, and the import names each provides.
const available = new Map()
const importToPackage = new Map()
for (const [name, entry] of Object.entries(lock.packages || {})) {
  for (const imp of entry.imports || []) importToPackage.set(imp, name)
  if (installed.has(entry.file_name)) available.set(name, entry)
}

let stdoutBuf = ''
let stderrBuf = ''
const capped = (buf, s) => (buf.length >= STREAM_CAP ? buf : (buf + s + '\n').slice(0, STREAM_CAP))

const { loadPyodide } = await import(pathToFileURL(path.join(dist, 'pyodide.mjs')).href)
const py = await loadPyodide({
  indexURL: dist + path.sep,
  stdout: (s) => { stdoutBuf = capped(stdoutBuf, s) },
  stderr: (s) => { stderrBuf = capped(stderrBuf, s) },
  // No `packages`: everything loads lazily from each run's imports (cold
  // numpy-only ≈ 2.3 s vs ≈ 4.8 s for all three, measured in 1.0).
})

py.FS.mkdir('/work')
py.FS.mount(py.FS.filesystems.NODEFS, { root: workspace }, '/work')
// Plan: "the NODEFS symlink op is overridden to throw". Node's permission
// model follows symlinks out of allowed paths (a documented caveat), so a link
// created inside the workspace must never exist in the first place. Windows
// refuses unprivileged symlinks anyway; Linux does not.
// And a link that is already there (put by someone on the host) must not be
// followable: refusing readlink makes every path through it fail, on every OS,
// rather than relying on Windows' junction behaviour.
const nodefsOps = py.FS.filesystems.NODEFS.node_ops
nodefsOps.symlink = () => { throw new py.FS.ErrnoError(63 /* EPERM */) }
nodefsOps.readlink = () => { throw new py.FS.ErrnoError(63 /* EPERM */) }

// Only names from the installed set, never a URL or a path, and no micropip.
// Without this a request for something absent was a silent no-op that looked
// like success (1.0: loadPackage('micropip') "loaded").
const realLoadPackage = py.loadPackage.bind(py)
async function guardedLoadPackage(names) {
  const list = (Array.isArray(names) ? names : [names]).map((n) => (typeof n === 'string' ? n : String(n)))
  for (const n of list) {
    if (!available.has(n.toLowerCase())) throw new Error(`Package "${n}" is not available in this sandbox. Available: ${[...available.keys()].sort().join(', ')}`)
  }
  return realLoadPackage(list.map((n) => n.toLowerCase()), { messageCallback: () => {}, errorCallback: () => {} })
}
py.loadPackage = guardedLoadPackage
py.loadPackagesFromImports = async () => { throw new Error('loadPackagesFromImports is not available in the sandbox') }

// Hardening that has to wait until Pyodide has booted and the mount exists.

// The spawn env is already empty, but on Windows libuv adds its "required"
// variables back (USERNAME, USERPROFILE, PATH, TEMP, ...: measured). Booting
// with them removed kills the child, so they go now, and Python's copy
// (os.environ, taken at boot) is cleared in the setup code below.
for (const k of Object.keys(process.env)) delete process.env[k]
for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'require', 'module', 'exports']) {
  try { delete globalThis[k] } catch {}
  if (k in globalThis) { try { globalThis[k] = undefined } catch {} }
}
for (const k of ['getBuiltinModule', 'dlopen', '_linkedBinding', 'mainModule', 'kill', 'chdir', 'setuid', 'setgid']) {
  try { delete process[k] } catch {}
  if (k in process) { try { process[k] = undefined } catch {} }
}

await py.runPythonAsync(`
import os, sys, warnings
os.environ.clear()
# Pyodide's own in-memory defaults, nothing of the host's. matplotlib needs a
# HOME to find a config dir; /home/pyodide lives in MEMFS, not on disk.
os.environ.update({'HOME': '/home/pyodide', 'USER': 'pyodide', 'LANG': 'C.UTF-8', 'MPLCONFIGDIR': '/tmp/matplotlib'})
os.environ['MPLBACKEND'] = 'Agg'
os.chdir('/work')
warnings.filterwarnings('ignore', message='.*non-interactive.*')
warnings.filterwarnings('ignore', message='.*FigureCanvasAgg.*')

_rs_ns = {'__name__': '__main__'}

def _rs_next_fig():
    n = 1
    while os.path.exists(f'/work/fig-{n}.png'):
        n += 1
    return f'fig-{n}.png'

async def _rs_run(code):
    import traceback
    from pyodide.code import eval_code_async
    rep = None
    err = None
    try:
        r = await eval_code_async(code, _rs_ns, return_mode='last_expr', filename='<cell>')
        if r is not None:
            rep = repr(r)
            if len(rep) > 4000:
                rep = rep[:4000] + '...'
    except BaseException as e:
        te = traceback.TracebackException.from_exception(e)
        te.stack = traceback.StackSummary.from_list([f for f in te.stack if f.filename == '<cell>'])
        err = ''.join(te.format())
    figs = []
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is not None:
        for num in plt.get_fignums():
            name = _rs_next_fig()
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore')
                    plt.figure(num).savefig('/work/' + name, dpi=100, bbox_inches='tight')
                figs.append(name)
            except Exception as e:
                err = (err or '') + f'Could not save figure {num}: {e}\\n'
        plt.close('all')
    return [rep, err, figs]
`)
const pyRun = py.globals.get('_rs_run')
const findImports = py.pyimport('pyodide.code').find_imports

// Packages a run needs that its own imports do not name. pandas' plotting
// (df.plot(), .hist(), .boxplot(), pandas.plotting) imports matplotlib inside
// pandas, where find_imports cannot see it, so `df.plot(kind='bar')` without
// `import matplotlib` failed with "matplotlib is required for plotting"
// (agent bench, 2026-11-11, Qwen3-4B). Matched on the call, not on a pandas
// import: the DataFrame may come from an earlier cell in this kernel. A false
// match on some other .plot( only loads an installed package.
const PANDAS_PLOTTING_RE = /\.(plot|hist|boxplot)\s*[.(]|\bpandas\.plotting\b|\bscatter_matrix\s*\(/

// Packages this run's imports need that are not loaded yet. A stdlib import has
// no lock entry and is fine. A lock package we did not install is refused with
// the list, so the model can rewrite instead of retrying the same import.
function packagesFor(code) {
  let imports
  try { imports = findImports(code).toJs() } catch { return { need: [] } } // a syntax error reports itself on run
  const need = new Set()
  for (const imp of imports) {
    const top = String(imp).split('.')[0]
    const pkg = importToPackage.get(top)
    if (!pkg) continue
    if (!available.has(pkg)) return { refused: top }
    need.add(pkg)
  }
  if (available.has('matplotlib') && PANDAS_PLOTTING_RE.test(code)) need.add('matplotlib')
  return { need: [...need] }
}

reply({ type: 'ready', python: lock.info?.python, packages: [...available.keys()].sort() })

const rl = readline.createInterface({ input: process.stdin })
let queue = Promise.resolve()
rl.on('line', (line) => {
  queue = queue.then(() => handle(line)).catch((err) => reply({ type: 'log', message: String(err?.message || err) }))
})
rl.on('close', () => process.exit(0))

async function handle(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg?.op !== 'run' || typeof msg.code !== 'string') return
  stdoutBuf = ''
  stderrBuf = ''
  const { need, refused } = packagesFor(msg.code)
  if (refused) {
    reply({ type: 'result', id: msg.id, stdout: '', stderr: '', result: null, error: `ModuleNotFoundError: "${refused}" is not available in this sandbox. Installed: ${[...available.keys()].sort().join(', ')} and the Python standard library (no network, so no pip).`, figures: [] })
    return
  }
  try {
    if (need.length) await realLoadPackage(need, { messageCallback: () => {}, errorCallback: () => {} })
  } catch (err) {
    reply({ type: 'result', id: msg.id, stdout: '', stderr: '', result: null, error: `Could not load ${need.join(', ')}: ${err?.message || err}`, figures: [] })
    return
  }
  let out
  try {
    const proxy = await pyRun(msg.code)
    out = proxy.toJs()
    proxy.destroy?.()
  } catch (err) {
    out = [null, String(err?.message || err), []]
  }
  const [result, error, figures] = out
  reply({ type: 'result', id: msg.id, stdout: stdoutBuf, stderr: stderrBuf, result: result ?? null, error: error ?? null, figures: Array.from(figures || []) })
}
