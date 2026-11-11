// =============================================================================
// run_python's sandbox — every escape Phase 1.0 tried, against the real thing
// =============================================================================
// chat-tooling Phase 1. This suite runs REAL Pyodide in the REAL child
// (daemon/python-child.mjs), spawned by the real pool with the real argv
// (python-kernel.mjs childArgs), on the Node python-runtime.mjs resolves. Nothing
// here is a mock of the sandbox, because a mock of a sandbox proves nothing.
//
// The network assertion is measured, not inferred: a stub server on 127.0.0.1
// counts every TCP connection, and the suite ends by asserting the count is
// ZERO across every attempt. The file-system assertion is the same: a
// directory outside the workspace is checked, at the end, to hold exactly
// what the suite put there.
//
// MUST RE-RUN ON EVERY PYODIDE BUMP. Phase 1.0's escape #2 was a Pyodide
// internal (initializeNodeSockFS); a new release can add another.
//
// The runtime (≈30 MB) lives in $REDSTART_PYODIDE_DIR, or a cache under the OS
// temp dir. Whatever is missing or fails its hash is installed through
// installRuntime() first, so a cold CI cache also exercises the pinned
// download and every hash check.
//
// Run:  node scripts/test-python-sandbox.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-python-test-'))
process.env.REDSTART_TEST_USERDATA_DIR = tmpDir
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const runtime = await import('../daemon/python-runtime.mjs')
const { KernelPool } = await import('../daemon/python-kernel.mjs')
const pythonTool = await import('../daemon/python-tool.mjs')
const { workspaceDir } = await import('../daemon/conversation-workspace.mjs')

const results = []
async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}
function assert(cond, message) { if (!cond) throw new Error(message) }

// ---------------------------------------------------------------------------
// The runtime and the Node it runs on
// ---------------------------------------------------------------------------

const node = runtime.resolvePythonNode()
if (!node.ok) {
  console.log(`FAIL  - no Node with a network permission to run the sandbox on: ${node.reason}`)
  console.log('        Stage one with: node scripts/stage-node.mjs')
  process.exit(1)
}
console.log(`# sandbox Node ${node.version} (${node.source})`)

const distDir = process.env.REDSTART_PYODIDE_DIR || path.join(os.tmpdir(), `redstart-pyodide-cache-${runtime.PYODIDE_VERSION}`)
if (!runtime.verifyRuntime(distDir).ok) {
  console.log(`# installing Pyodide ${runtime.PYODIDE_VERSION} into ${distDir}`)
  await runtime.installRuntime(distDir)
}

await test('the installed runtime matches every pin', () => {
  const v = runtime.verifyRuntime(distDir)
  assert(v.ok, `verifyRuntime: ${v.reason}`)
})

await test('INSTALLED_PACKAGES is exactly the lock closure of the top-level packages', () => {
  const lock = runtime.readVerifiedLock(distDir)
  const seen = new Set()
  const walk = (n) => { const k = n.toLowerCase(); if (seen.has(k)) return; seen.add(k); (lock.packages[k]?.depends || []).forEach(walk) }
  runtime.TOP_LEVEL_PACKAGES.forEach(walk)
  const want = [...seen].sort().join(',')
  const have = [...runtime.INSTALLED_PACKAGES].sort().join(',')
  assert(want === have, `closure ${want} != installed ${have}`)
})

await test('a tampered runtime file fails verification', () => {
  const copy = fs.mkdtempSync(path.join(tmpDir, 'tamper-'))
  for (const f of fs.readdirSync(distDir)) fs.copyFileSync(path.join(distDir, f), path.join(copy, f))
  const wasm = path.join(copy, 'pyodide.asm.wasm')
  const bytes = fs.readFileSync(wasm); bytes[100] ^= 0xff; fs.writeFileSync(wasm, bytes)
  const v = runtime.verifyRuntime(copy)
  assert(!v.ok && /pyodide\.asm\.wasm/.test(v.reason), `expected a wasm mismatch, got ${JSON.stringify(v)}`)
})

await test('the runtime install may fetch only this version on the pinned CDN', () => {
  const ok = `https://cdn.jsdelivr.net/pyodide/v${runtime.PYODIDE_VERSION}/full/pyodide.asm.wasm`
  assert(runtime.isPyodideCdnUrl(ok), 'the real address was refused')
  for (const bad of [
    ok.replace('https:', 'http:'),
    ok.replace('cdn.jsdelivr.net', 'cdn.jsdelivr.net.evil.example'),
    ok.replace(runtime.PYODIDE_VERSION, '0.0.1'),
    `https://cdn.jsdelivr.net/pyodide/v${runtime.PYODIDE_VERSION}/full/../../npm/x.js`,
    'https://user:pw@cdn.jsdelivr.net/pyodide/v' + runtime.PYODIDE_VERSION + '/full/a',
    'https://huggingface.co/x',
  ]) assert(!runtime.isPyodideCdnUrl(bad), `allowed ${bad}`)
})

await test('a Node without the network permission is refused, never used', () => {
  const r = runtime.resolvePythonNode({ version: 'v24.14.1', staged: path.join(tmpDir, 'no-such-node'), refresh: true })
  assert(!r.ok && /Node 25 or newer/.test(r.reason), JSON.stringify(r))
  runtime.resolvePythonNode({ refresh: true })
})

// ---------------------------------------------------------------------------
// The stub that counts connections, and the outside directory
// ---------------------------------------------------------------------------

let connections = 0
const stub = net.createServer((sock) => { connections++; sock.end('HTTP/1.1 200 OK\r\n\r\nhi') })
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
const PORT = stub.address().port

const workspace = fs.mkdtempSync(path.join(tmpDir, 'ws-'))
const outside = fs.mkdtempSync(path.join(tmpDir, 'outside-'))
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret')
let prelink = 'none'
try { fs.symlinkSync(outside, path.join(workspace, 'prelink'), process.platform === 'win32' ? 'junction' : 'dir'); prelink = 'yes' } catch (e) { prelink = e.code }

const pool = new KernelPool({ maxKernels: 2 })
const spec = { nodePath: node.execPath, distDir, workspace }
const KEY = 'test/escapes'
async function run(code, timeoutMs = 60000) {
  return pool.run(KEY, spec, code, timeoutMs)
}
const OUT = JSON.stringify(outside.replace(/\\/g, '/'))
const ROOT = JSON.stringify(process.platform === 'win32' ? 'C:/Windows' : '/etc')

await test('the kernel boots and computes under the full sandbox', async () => {
  const t0 = Date.now()
  const r = await run('import numpy as np\nint(np.arange(10).sum())')
  assert(r.reply?.result === '45', JSON.stringify(r))
  return `${Date.now() - t0} ms cold, numpy`
})

// Each attempt must FAIL. 'ESCAPED' as a result, a file outside, or any
// connection to the stub is a failure of the sandbox, whatever else happened.
const ESCAPES = [
  ['NODEFS-mount a directory outside the workspace and write', `
import pyodide_js
pyodide_js.FS.mkdir('/out'); pyodide_js.FS.mount(pyodide_js.FS.filesystems.NODEFS, {'root': ${OUT}}, '/out')
open('/out/pwned.txt','w').write('x'); 'ESCAPED'`],
  ['NODEFS-mount a system directory and list it', `
import pyodide_js, os
pyodide_js.FS.mkdir('/sys2'); pyodide_js.FS.mount(pyodide_js.FS.filesystems.NODEFS, {'root': ${ROOT}}, '/sys2')
os.listdir('/sys2')[:1] and 'ESCAPED'`],
  ['create a symlink out of the workspace', `
import os
os.symlink(${OUT}, '/work/link-out'); os.listdir('/work/link-out') and 'ESCAPED'`],
  ['read through a pre-existing link in the workspace', `
import os
open('/work/prelink/secret.txt').read() == 'outside secret' and 'ESCAPED'`],
  ['write through a pre-existing link in the workspace', `
open('/work/prelink/via-link.txt','w').write('x'); 'ESCAPED'`],
  ['walk out with ..', `
import os
('secret.txt' in os.listdir('/work/../')) and 'ESCAPED'`],
  ['js.process.getBuiltinModule("fs")', `
import js
js.process.getBuiltinModule('fs').writeFileSync(${OUT} + '/direct.txt', 'x'); 'ESCAPED'`],
  ['js.process.getBuiltinModule("child_process")', `
import js
js.process.getBuiltinModule('child_process').execSync('whoami'); 'ESCAPED'`],
  ['js.require', `import js\njs.require('child_process'); 'ESCAPED'`],
  ['js.eval', `import js\njs.eval('1+1'); 'ESCAPED'`],
  ['js.Function', `import js\njs.Function.new('return 1')(); 'ESCAPED'`],
  ['Function via Object.constructor', `import js\njs.Object.constructor.new('return 7')(); 'ESCAPED'`],
  ['dynamic import through eval', `import js\nawait js.eval("import('node:net')"); 'ESCAPED'`],
  ['process.dlopen', `import js\njs.process.dlopen(js.Object.new(), 'x.node'); 'ESCAPED'`],
  ['process.binding("tcp_wrap")', `import js\njs.process.binding('tcp_wrap'); 'ESCAPED'`],
  ['process._linkedBinding', `import js\njs.process._linkedBinding('x'); 'ESCAPED'`],
  ['worker_threads', `import js\njs.process.getBuiltinModule('worker_threads'); 'ESCAPED'`],
  ['js.fetch', `import js\nawait js.fetch('http://127.0.0.1:${PORT}/fetch'); 'ESCAPED'`],
  ['js.WebSocket', `import js\njs.WebSocket.new('ws://127.0.0.1:${PORT}/ws'); 'ESCAPED'`],
  ['pyodide.http.pyfetch', `from pyodide.http import pyfetch\nawait pyfetch('http://127.0.0.1:${PORT}/pyfetch'); 'ESCAPED'`],
  ['Python socket', `import socket\nsocket.create_connection(('127.0.0.1', ${PORT}), timeout=2); 'ESCAPED'`],
  ['urllib', `import urllib.request\nurllib.request.urlopen('http://127.0.0.1:${PORT}/u', timeout=2); 'ESCAPED'`],
  ['SockFS init, then a socket (1.0 escape #2)', `
import pyodide_js, socket
r = pyodide_js._api.initializeNodeSockFS()
try:
    await r
except Exception:
    pass
socket.create_connection(('127.0.0.1', ${PORT}), timeout=2); 'ESCAPED'`],
  ['loadPackage from a URL', `import pyodide_js\nawait pyodide_js.loadPackage('http://127.0.0.1:${PORT}/x-1.0-py3-none-any.whl'); 'ESCAPED'`],
  ['loadPackage micropip (not installed)', `import pyodide_js\nawait pyodide_js.loadPackage('micropip'); 'ESCAPED'`],
  ['import a lock package that is not installed', `import scipy\n'ESCAPED'`],
]

for (const [name, code] of ESCAPES) {
  await test(`blocked: ${name}`, async () => {
    const r = await run(code)
    const escaped = r.reply?.result === "'ESCAPED'" || r.reply?.result === 'ESCAPED'
    assert(!escaped, `the attempt succeeded: ${JSON.stringify(r.reply)}`)
    const why = (r.reply?.error || r.error || '').trim().split('\n').pop()
    return why.slice(0, 90)
  })
}

await test('the environment carries nothing of the host (JS and Python views)', async () => {
  // JS: empty. Python: exactly the in-memory defaults python-child.mjs sets,
  // and no host VALUE anywhere (Windows' libuv re-adds USERNAME, USERPROFILE,
  // PATH... to a spawned child, which is why the child clears them itself).
  const js = await run(`import js\nlen(list(js.Object.keys(js.process.env)))`)
  assert(js.reply?.result === '0', `process.env is not empty: ${JSON.stringify(js.reply)}`)
  const py = await run(`import os\nrepr(sorted(os.environ.items()))`)
  const env = py.reply?.result || ''
  const keys = [...env.matchAll(/\('([A-Z_]+)'/g)].map((m) => m[1]).sort().join(',')
  assert(keys === 'HOME,LANG,MPLBACKEND,MPLCONFIGDIR,USER', `os.environ keys: ${keys}`)
  for (const v of [os.userInfo().username, os.homedir(), process.env.PATH?.split(path.delimiter)[0]].filter((x) => x && x.length > 2)) {
    assert(!env.includes(v.replace(/\\/g, '\\\\')) && !env.includes(v), `host value visible: ${v}`)
  }
  return keys
})

await test('numpy still works after every attempt (codegen off spares wasm)', async () => {
  const r = await run('import numpy as np\nint(np.ones(5).sum())')
  assert(r.reply?.result === '5', JSON.stringify(r))
})

await test('ZERO connections reached the stub across every attempt', async () => {
  await new Promise((r) => setTimeout(r, 1500)) // let any stray connection land
  assert(connections === 0, `${connections} connection(s) reached the stub`)
})

await test('nothing was written outside the workspace', () => {
  const listing = fs.readdirSync(outside).sort().join(',')
  assert(listing === 'secret.txt', `outside now holds: ${listing}`)
})

// ---------------------------------------------------------------------------
// Lifecycle: timeout, restart, cap
// ---------------------------------------------------------------------------

await test('a run over its wall clock is killed, and the next call gets a fresh kernel', async () => {
  await run('kept = 1')
  const r = await run('while True: pass', 2000)
  assert(r.timedOut, `expected a timeout, got ${JSON.stringify(r)}`)
  const after = await run('kept')
  assert(after.fresh, 'the next run reused a killed kernel')
  assert(/NameError/.test(after.reply?.error || ''), `variables survived a restart: ${JSON.stringify(after.reply)}`)
})

await test('the pool evicts the least recently used idle kernel at its cap', async () => {
  const small = new KernelPool({ maxKernels: 1 })
  const a = await small.run('a', spec, 'x = 1', 60000)
  assert(a.reply && !a.reply.error, JSON.stringify(a))
  const b = await small.run('b', spec, '2', 60000)
  assert(b.reply?.result === '2' && small.size === 1, `size ${small.size}`)
  const again = await small.run('a', spec, 'x', 60000)
  assert(again.fresh && /NameError/.test(again.reply?.error || ''), 'kernel a was not evicted')
  small.stopAll()
})

pool.stopAll()

// ---------------------------------------------------------------------------
// The tool end to end: workspace, figures, files changed, caps
// ---------------------------------------------------------------------------

const docsRoot = fs.mkdtempSync(path.join(tmpDir, 'docs-'))
pythonTool._setPool(new KernelPool({ maxKernels: 2 }))
const cfg = { python: { enabled: true, runtimeDir: distDir, documentsRoot: docsRoot, maxKernels: 2, timeoutS: 30, workspaceCapBytes: 200 * 1048576, accountCapBytes: 2048 * 1048576 } }
const account = { id: 'acct-python-1', username: 'pat' }
const ctx = { account, conversationId: 'conv-abc' }

await test('run_python writes a figure and a CSV into the conversation workspace and reports both', async () => {
  const res = await pythonTool.callTool('run_python', { code: "import pandas as pd, matplotlib.pyplot as plt\ndf = pd.DataFrame({'x':[1,2,3],'y':[2,4,8]})\ndf.to_csv('out.csv', index=False)\nplt.plot(df.x, df.y)\nprint('rows', len(df))\ndf.y.sum()" }, cfg, ctx)
  const text = res.content[0].text
  assert(!res.isError, text)
  assert(/rows 3/.test(text) && /Result: (np\.int64\()?14/.test(text), text)
  assert(/Files changed: .*fig-1\.png.*out\.csv/.test(text), text)
  // Phase 2: files come back as resource links into the workspace, never as bytes.
  assert(!res.content.some((c) => c.type === 'image'), 'a figure came back as base64 image content')
  const links = res.content.filter((c) => c.type === 'resource_link')
  const fig = links.find((l) => l.mimeType === 'image/png')
  assert(fig && fig.uri === '/files/download?path=' + encodeURIComponent('chats/conv-abc/fig-1.png') && fig.size > 0, JSON.stringify(links))
  assert(links.some((l) => l.mimeType === 'text/csv' && l.name === 'out.csv'), JSON.stringify(links))
  const ws = workspaceDir(docsRoot, account, 'conv-abc')
  assert(fs.existsSync(path.join(ws, 'out.csv')) && fs.existsSync(path.join(ws, 'fig-1.png')), 'files not in the workspace')
  assert(ws.includes(path.join('user_files', 'pat-')) && ws.endsWith(path.join('chats', 'conv-abc')), ws)
})

await test('pandas .plot() without importing matplotlib loads it and saves the figure', async () => {
  // The agent bench's Qwen3-4B wrote exactly this shape (2026-11-11) and got
  // "matplotlib is required for plotting": find_imports sees only pandas.
  // A conversation of its own, so its kernel has never loaded matplotlib.
  const res = await pythonTool.callTool('run_python', { code: "import pandas as pd\ndf = pd.DataFrame({'region':['North','South'],'total':[3,5]})\ndf.plot(kind='bar', x='region', y='total')\n'drawn'" }, cfg, { account, conversationId: 'conv-plot' })
  const text = res.content[0].text
  assert(!res.isError, text)
  assert(/drawn/.test(text) && /fig-1\.png/.test(text), text)
})

await test('a missing file opened with the chats/<id>/ prefix says to use the bare name', async () => {
  // list_documents shows "chats/conv-abc/report_jan.txt"; run_python already
  // runs in that folder. Qwen3-4B spent docs-rename's 10 turns on this
  // (agent bench, 2026-11-11) because the error never said why.
  const res = await pythonTool.callTool('run_python', { code: "open('chats/conv-abc/report_jan.txt').read()" }, cfg, ctx)
  const text = res.content[0].text
  assert(res.isError && /FileNotFoundError/.test(text), text)
  assert(text.includes('run_python already runs inside chats/conv-abc/, so open a file there by its bare name: "report_jan.txt", not "chats/conv-abc/report_jan.txt".'), text)
  const plain = await pythonTool.callTool('run_python', { code: "open('nowhere.txt').read()" }, cfg, ctx)
  assert(plain.isError && !/already runs inside/.test(plain.content[0].text), 'hint on a missing file that had no prefix')
  const { workspacePrefixHint } = pythonTool
  assert(workspacePrefixHint('ZeroDivisionError', "x = 'chats/conv-abc/a'", 'chats/conv-abc') === null, 'hint on an unrelated error')
})

await test('code that shows nothing is told to print, and the same value at the top level is returned', async () => {
  // Qwen3-4B's multi-recover code (agent bench, 2026-11-11): the value is the
  // last line of a try block. Seven runs, seven "no output", no print added.
  const inTry = "try:\n    total = sum([64, 78, 65])\n    total\nexcept Exception as e:\n    print(f'Error: {e}')"
  const res = await pythonTool.callTool('run_python', { code: inTry }, cfg, ctx)
  const text = res.content[0].text
  assert(!res.isError, text)
  assert(text === pythonTool.NO_OUTPUT_TEXT, text)
  assert(/print\(/.test(text) && /inside try/.test(text), `does not say what to do: ${text}`)
  const top = await pythonTool.callTool('run_python', { code: 'total = sum([64, 78, 65])\ntotal' }, cfg, ctx)
  assert(/Result: 207/.test(top.content[0].text) && !top.content[0].text.includes('No output'), top.content[0].text)
})

await test('a Python exception comes back as an error with only the user\'s frames', async () => {
  const res = await pythonTool.callTool('run_python', { code: 'def f():\n    return 1/0\nf()' }, cfg, ctx)
  const text = res.content[0].text
  assert(res.isError && /ZeroDivisionError/.test(text), text)
  assert(!/_rs_run|eval_code_async|_base\.py/.test(text), `internal frames leaked: ${text}`)
})

await test('no conversation id → the account scratch workspace', async () => {
  const res = await pythonTool.callTool('run_python', { code: "open('s.txt','w').write('x')" }, cfg, { account, conversationId: null })
  assert(!res.isError, res.content[0].text)
  assert(fs.existsSync(path.join(workspaceDir(docsRoot, account, null), 's.txt')), 'not in _scratch')
})

await test('a workspace over its cap refuses the next run, saying how to fix it', async () => {
  const tight = { python: { ...cfg.python, workspaceCapBytes: 1024 } }
  await pythonTool.callTool('run_python', { code: "open('big.bin','wb').write(b'0'*4096)" }, tight, { account, conversationId: 'conv-cap' })
  const res = await pythonTool.callTool('run_python', { code: '1' }, tight, { account, conversationId: 'conv-cap' })
  assert(res.isError && /over its .* limit/.test(res.content[0].text), res.content[0].text)
})

await test('a disabled capability serves no tool and refuses a call', async () => {
  assert(pythonTool.toolDefs({ python: { enabled: false } }).length === 0, 'tool advertised while disabled')
  const res = await pythonTool.callTool('run_python', { code: '1' }, { python: { enabled: false } }, ctx)
  assert(res.isError, 'call ran while disabled')
})

pythonTool.stopAllKernels()
stub.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed  (prelink: ${prelink})`)
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
process.exit(failed.length ? 1 : 0)
