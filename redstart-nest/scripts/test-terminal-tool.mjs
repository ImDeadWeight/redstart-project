// =============================================================================
// run_command, the terminal provider (agent-runtime plan Phase 4: D15, D18,
// D19; U3; P4-c, P4-d)
// =============================================================================
// The provider is called directly, the way mcp-server's callToolAs calls it
// once the policy and approval gates have passed, so each refusal here is the
// provider's OWN check, the one that still holds if a config path forgets the
// owner-only rule. One test at the end goes through callToolAs to show the
// server refuses an unapproved command (ENFORCED_TOOLS).
//
// The program is this machine's node, listed as the only executable.
//
// Run:  node scripts/test-terminal-tool.mjs
// =============================================================================

import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redstart-terminal-tool-'))
process.env.REDSTART_TEST_USERDATA_DIR = path.join(tmp, 'userdata')
fs.mkdirSync(process.env.REDSTART_TEST_USERDATA_DIR, { recursive: true })
register('./auth-test-loader.mjs', import.meta.url)
await import('./electron-stub.mjs')

const terminal = await import('../daemon/terminal-tool.mjs')
const { setAuthRequired } = await import('../daemon/auth.mjs')
const { workspaceDir } = await import('../daemon/conversation-workspace.mjs')
const { callToolAs, updateMcpConfig, toolCatalogFor } = await import('../daemon/mcp-server.mjs')

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

const docs = path.join(tmp, 'Documents')
const outside = path.join(tmp, 'outside')
const extra = path.join(tmp, 'extra')
for (const d of [docs, outside, extra]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours')

const NODE = { name: 'node', file: process.execPath, prefixArgs: [], dir: path.dirname(process.execPath) }
const cfg = (over = {}) => ({
  terminal: {
    enabled: true, executables: [NODE], documentsRoot: docs, defaultTimeoutS: 20, maxTimeoutS: 30,
    outputCapBytes: 16384, extraDirs: [extra], networkExposed: false, ...over,
  },
})
const OWNER = { id: 'owner-0001', username: 'owner', tier: 'owner' }
const ADMIN = { id: 'admin-0002', username: 'admin', tier: 'admin' }
const USER = { id: 'user-0003', username: 'user', tier: 'user' }
const CONV = 'conv-terminal-1'
const ws = workspaceDir(docs, OWNER, CONV, { create: true })

const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
const call = (args, { account = OWNER, conversationId = CONV, config = cfg() } = {}) =>
  terminal.callTool('run_command', args, config, { account, conversationId })

fs.writeFileSync(path.join(ws, 'hello.mjs'), "import fs from 'node:fs'\nconsole.log('hello ' + process.argv.slice(2).join(','))\nfs.writeFileSync('made.txt', 'x')\n")
fs.writeFileSync(path.join(ws, 'fail.mjs'), "console.error('config missing: app.config.json'); process.exit(3)\n")
fs.writeFileSync(path.join(ws, 'sleep.mjs'), 'setTimeout(() => {}, 60_000)\n')
fs.writeFileSync(path.join(ws, 'cwd.mjs'), 'console.log(process.cwd())\n')
fs.writeFileSync(path.join(ws, 'home.mjs'), "import fs from 'node:fs'\nimport os from 'node:os'\nfs.writeFileSync(os.homedir() + '/cfg', 'x')\nconsole.log(os.homedir())\n")
fs.mkdirSync(path.join(ws, 'sub'), { recursive: true })

setAuthRequired(true)
console.log('\nrun_command\n')

await test('not advertised when disabled; advertised with the allowed names as an enum', () => {
  assert(terminal.toolDefs(cfg({ enabled: false })).length === 0, 'advertised while disabled')
  assert(terminal.toolDefs(cfg({ executables: [] })).length === 0, 'advertised with no programs')
  const [def] = terminal.toolDefs(cfg())
  assert(def.name === 'run_command' && def.inputSchema.properties.command.enum.join() === 'node', JSON.stringify(def.inputSchema.properties.command))
  assert(/no shell/i.test(def.description) && /Allowed programs: node/.test(def.description), def.description)
})

await test('the owner runs a program; the exit code is the first line (D15)', async () => {
  const r = await call({ command: 'node', args: ['hello.mjs', 'a b', '&& echo x'] })
  const t = text(r)
  assert(!r.isError, t)
  assert(t.split('\n')[0] === 'Exit code 0', `first line: ${t.split('\n')[0]}`)
  assert(t.includes('hello a b,&& echo x'), `args changed: ${t}`)
  assert(/Files changed in the workspace: made\.txt/.test(t), `files: ${t}`)
  assert(r.content.some((c) => c.type === 'resource_link' || c.type === 'resource'), 'no link for made.txt')
  return t.split('\n')[1]
})

await test('a non-zero exit is an error whose first line says so, with stderr', async () => {
  const r = await call({ command: 'node', args: ['fail.mjs'] })
  const t = text(r)
  assert(r.isError && t.startsWith('Exit code 3 (failed)'), t)
  assert(t.includes('stderr:\nconfig missing: app.config.json'), t)
})

await test('🔒 an admin and a user are refused by the provider itself (U3)', async () => {
  for (const account of [ADMIN, USER]) {
    const r = await call({ command: 'node', args: ['hello.mjs'] }, { account })
    assert(r.isError && /only available to the owner/.test(text(r)), `${account.tier}: ${text(r)}`)
  }
})

await test('🔒 a null account with auth on is refused (a plumbing fault, not the owner)', async () => {
  const r = await call({ command: 'node', args: ['hello.mjs'] }, { account: null })
  assert(r.isError && /owner/.test(text(r)), text(r))
})

await test('🔒 auth off: allowed on loopback, refused when the LAN is let in (P4-c)', async () => {
  setAuthRequired(false)
  try {
    const lan = await call({ command: 'node', args: ['hello.mjs'] }, { account: null, config: cfg({ networkExposed: true }) })
    assert(lan.isError && /open to the local network/.test(text(lan)), text(lan))
    const local = await call({ command: 'node', args: [path.join(ws, 'hello.mjs')] }, { account: null })
    assert(!local.isError, text(local))
  } finally {
    setAuthRequired(true)
  }
})

await test('a program that is not listed is refused, naming the allowed ones (D16)', async () => {
  for (const command of ['git', 'cmd', 'powershell', process.execPath, '../node', undefined]) {
    const r = await call({ command, args: ['-v'] })
    assert(r.isError && /not a program this server allows\. Allowed: node/.test(text(r)), `${command}: ${text(r)}`)
  }
})

await test('args must be a list of strings', async () => {
  for (const args of ['hello.mjs', [1], [null], { 0: 'x' }, ['a\0b']]) {
    const r = await call({ command: 'node', args })
    assert(r.isError, `accepted ${JSON.stringify(args)}`)
  }
})

await test('🔒 cwd cannot leave the workspace: .., absolute, and a link that points out (D18)', async () => {
  const link = path.join(ws, 'escape')
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  for (const cwd of ['..', '../..', outside, path.parse(tmp).root, 'escape', 'escape/.', 'sub/../../..']) {
    const r = await call({ command: 'node', args: ['-e', 'console.log(1)'], cwd })
    assert(r.isError && /outside this conversation's workspace/.test(text(r)), `${cwd}: ${text(r)}`)
  }
  const missing = await call({ command: 'node', args: ['-v'], cwd: 'nope' })
  assert(missing.isError && /not a folder/.test(text(missing)), text(missing))
  fs.rmSync(link, { recursive: false, force: true })
})

await test('cwd: a subfolder of the workspace and an admin-listed extra folder', async () => {
  const sub = await call({ command: 'node', args: [path.join(ws, 'cwd.mjs')], cwd: 'sub' })
  assert(!sub.isError && text(sub).includes(fs.realpathSync(path.join(ws, 'sub'))), text(sub))
  assert(/in chats\/conv-terminal-1\/sub/.test(text(sub)), text(sub))
  const ex = await call({ command: 'node', args: [path.join(ws, 'cwd.mjs')], cwd: extra })
  assert(!ex.isError && text(ex).includes(fs.realpathSync(extra)), text(ex))
})

await test('HOME is the workspace\'s .home, and nothing under it is reported (P4-d)', async () => {
  const r = await call({ command: 'node', args: ['home.mjs'] })
  const t = text(r)
  assert(!r.isError && t.includes(path.join(ws, '.home')), t)
  assert(fs.existsSync(path.join(ws, '.home', 'cfg')), 'the program could not write its HOME')
  assert(!/\.home/.test(t.split('Files changed')[1] ?? ''), `.home reported: ${t}`)
})

await test('one command at a time per conversation; another conversation is not blocked', async () => {
  const first = call({ command: 'node', args: ['-e', 'setTimeout(() => {}, 1500)'] })
  await new Promise((r) => setTimeout(r, 200))
  const second = await call({ command: 'node', args: ['-v'] })
  assert(second.isError && /still running/.test(text(second)), text(second))
  const other = await call({ command: 'node', args: ['-v'] }, { conversationId: 'conv-terminal-2' })
  assert(!other.isError, text(other))
  const r = await first
  assert(!r.isError, text(r))
  assert(terminal.runningCount() === 0, 'a finished command is still counted')
})

await test('a timeout kills the command and says so on the first line', async () => {
  const r = await call({ command: 'node', args: ['sleep.mjs'], timeout_s: 1 })
  const t = text(r)
  assert(r.isError && /^Timed out after 1 s/.test(t), t)
})

await test('timeout_s is bounded by the admin\'s maximum', async () => {
  const r = await call({ command: 'node', args: ['-e', 'console.log(1)'], timeout_s: 99999 })
  assert(!r.isError, text(r))
})

await test('stopAllCommands stops a running command (the MCP server stopping)', async () => {
  const p = call({ command: 'node', args: [path.join(ws, 'sleep.mjs')] }, { conversationId: 'conv-terminal-3' })
  await new Promise((r) => setTimeout(r, 300))
  terminal.stopAllCommands()
  const r = await p
  assert(r.isError && /^Stopped before it finished/.test(text(r)), text(r))
})

await test('🔒 through callToolAs: the owner\'s unapproved command is refused at the gate (ENFORCED_TOOLS)', async () => {
  updateMcpConfig(cfg())
  const r = await callToolAs(OWNER, 'run_command', { command: 'node', args: ['-v'] }, { conversationId: CONV })
  assert(r?.isError && r._meta?.['redstart/approval']?.tool === 'run_command', JSON.stringify(r))
  const userTools = toolCatalogFor(USER).map((t) => t.name)
  assert(!userTools.includes('run_command'), 'a user is offered run_command')
  const ownerTools = toolCatalogFor(OWNER)
  const def = ownerTools.find((t) => t.name === 'run_command')
  assert(def && def._meta['redstart/class'] === 'execute' && def.annotations.destructiveHint === true, JSON.stringify(def?._meta))
})

console.log('\n' + '='.repeat(60))
const passed = results.filter((r) => r.pass).length
console.log(`${passed}/${results.length} passed`)
console.log('='.repeat(60) + '\n')
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* a junction on Windows */ }
if (passed !== results.length) process.exit(1)
