// =============================================================================
// One side of test-task-runtime.mjs's restart tests (agent-runtime 3.7)
// =============================================================================
// Run as a separate process against the data folder in
// REDSTART_TEST_USERDATA_DIR, so a "restart" is a real one: the first process
// is killed outright (SIGKILL, no exit handlers) and a second one starts from
// what is on disk.
//
//   node task-restart-child.mjs start <scenario>   start a task; prints
//        READY <taskId> once it is where the scenario kills it, then hangs
//   node task-restart-child.mjs resume <scenario> [answer]
//        resumeTasks(); prints RESULT <json> when the task has ended, or
//        WAITING <json> when it is waiting for the person
//
// Scenarios:
//   in-flight  the model asks for two reads; the first is still running
//              when the process dies
//   question   the model asks the person something
// =============================================================================

import { register } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scripts = path.join(here, '..')
register(pathToFileURL(path.join(scripts, 'auth-test-loader.mjs')).href)
await import(pathToFileURL(path.join(scripts, 'electron-stub.mjs')).href)

const [mode, scenario, answer] = process.argv.slice(2)
const accounts = await import('../../daemon/accounts-storage.mjs')
const convs = await import('../../daemon/conversations-storage.mjs')
const store = await import('../../daemon/task-store.mjs')
const runner = await import('../../daemon/task-runner.mjs')
const { currentBranch } = await import('../../../shared/agent-core/stored-messages.mjs')
accounts.setAuthRequired(false)

const SCOPE = 'restart-device'
const CONV = 'restart-conv'
const TOOLS = ['read_document', 'ask_user', 'update_plan'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }))
const calls = []

function sse(delta) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }], model: 'fake' })}\n\ndata: [DONE]\n\n`)
}
const toolCalls = (...list) => ({ tool_calls: list.map(([id, name, args], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) })

let turn = 0
function seams(script, onCall) {
  runner._setTestSeams({
    prepareCompletion: async (parsed) => ({ parsed, wire: {} }),
    effectiveConfigFor: async () => ({}),
    toolCatalogFor: async () => TOOLS,
    callToolAs: async (_a, name, args) => onCall(name, args),
    // TASK_CHILD_NO_MODEL: this "daemon" came up with no model loaded.
    upstreamPort: () => (process.env.TASK_CHILD_NO_MODEL ? null : 1),
    completionsInFlight: () => 0,
    fetchCompletion: async () => sse(script[turn++] ?? { content: '(no more script)' }),
    modelPollMs: 20,
  })
}

const out = (tag, obj) => process.stdout.write(`${tag} ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`)

if (mode === 'start') {
  convs.createConversation(SCOPE, { id: CONV, name: 'restart', currNode: '', messages: [] })
  let taskId = null
  if (scenario === 'in-flight') {
    seams([toolCalls(['c1', 'read_document', { path: 'one' }], ['c2', 'read_document', { path: 'two' }])], () => {
      out('READY', taskId)
      return new Promise(() => {}) // still running when the process is killed
    })
  } else {
    seams([toolCalls(['q1', 'ask_user', { question: 'Which colour?' }])], () => ({ content: [] }))
  }
  const r = runner.startTask({ account: null, storeAccountId: SCOPE, conversationId: CONV, content: 'go' })
  taskId = r.task.id
  if (scenario === 'question') {
    while (store.getTask(taskId).status !== 'waiting_user') await new Promise((res) => setTimeout(res, 10))
    out('READY', taskId)
  }
  setInterval(() => {}, 1000) // hang until killed
} else {
  seams([{ content: 'Finished after the restart.' }], (name, args) => {
    calls.push({ name, path: args.path })
    return { content: [{ type: 'text', text: `${name} ${args.path} ran` }] }
  })
  const resumed = runner.resumeTasks()
  const [task] = store.listTasks()
  const report = () => {
    const t = store.getTask(task.id)
    const branch = currentBranch(convs.getConversation(SCOPE, CONV)).map((m) => ({ role: m.role, content: m.content, toolCallId: m.toolCallId }))
    return { resumed, status: t.status, waiting: t.waiting, branch, calls, activeTaskId: convs.getConversation(SCOPE, CONV).activeTaskId ?? null }
  }
  let answered = false
  for (;;) {
    const t = store.getTask(task.id)
    if (store.TERMINAL_STATES.includes(t.status)) { out('RESULT', report()); process.exit(0) }
    // The record says waiting_user from before the restart until the resumed
    // run asks again; only then does an answer land (answerTask is ok).
    if (t.status === 'waiting_user' && !answered) {
      if (!answer) { out('WAITING', report()); process.exit(0) }
      answered = runner.answerTask(task.id, { text: answer }).ok
    }
    await new Promise((res) => setTimeout(res, 10))
  }
}
