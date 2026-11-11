'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: run_python (chat-tooling Phase 1)
// =============================================================================
// One tool. The model writes Python and gets back stdout, the repr of a
// trailing expression, and the files it changed in this conversation's
// workspace. Figures come back as images. Why one broad tool and not a
// calculator + csv + date tool each: every schema is paid for on every turn
// (plan §1 rule 1).
//
// Where it runs: python-kernel.mjs (pool) → python-child.mjs (the sandbox),
// on the Node chosen by python-runtime.mjs. Where files go:
// conversation-workspace.mjs. This module only joins them and words the result.
//
// Class 'write' (tools-definitions.mjs): it creates files, and it is the only
// built-in that executes model-written code. A role withholds it by
// capability id `python`.
// =============================================================================

import { KernelPool, DEFAULT_MAX_KERNELS } from './python-kernel.mjs'
import { runtimeReady, resolvePythonNode, PYTHON_VERSION, TOP_LEVEL_PACKAGES } from './python-runtime.mjs'
import { workspaceDir, workspaceRelative, checkCaps, changedFiles } from './conversation-workspace.mjs'
import { resolveUserScope } from './user-scope.mjs'
import { logEvent } from './logger.mjs'
import { fileLink } from './tool-result-links.mjs'

export const TOOL_NAME = 'run_python'
export const OUTPUT_CAP = 8192   // same as run_javascript's
export const DEFAULT_TIMEOUT_S = 30
export const MAX_TIMEOUT_S = 120
const MAX_LINKS = 20

let pool = new KernelPool()
const keysThatRan = new Set()

/** For tests: swap the pool (and with it every live kernel). */
export function _setPool(p) { pool.stopAll(); pool = p }
export function stopAllKernels() { pool.stopAll() }
export function dropKernel(account, conversationId) {
  try { pool.drop(`${resolveUserScope(account)}/${conversationId}`) } catch { /* malformed account */ }
}

export function toolDefs(cfg) {
  if (!cfg?.python?.enabled) return []
  return [{
    name: TOOL_NAME,
    description:
      `Run Python ${PYTHON_VERSION} code in a sandbox and get back its printed output, the value of its last expression, and any files it wrote. ` +
      `Use it for anything you would otherwise do in your head and could get wrong: arithmetic, counting, sorting, dates, unit conversion, parsing, statistics, and analysing data files. ` +
      `Installed: ${TOP_LEVEL_PACKAGES.join(', ')} and the standard library. There is no network and no pip, so code cannot fetch URLs or install packages. ` +
      `The working directory is this conversation's workspace: files the user attached are there, and files you write there (e.g. df.to_csv('out.csv')) persist and are listed in the result. ` +
      `matplotlib figures are saved and shown to the user automatically, so you don't need plt.savefig. ` +
      `Files persist; variables usually persist between calls but may not (a kernel restarts after a timeout or 10 idle minutes), so re-load data if a name is undefined. ` +
      `Do not use it for questions you can answer directly, and do not print huge outputs: summarise with pandas instead. ` +
      `Example: {"code": "import pandas as pd\\ndf = pd.read_csv('sales.csv')\\ndf.groupby('region')['amount'].sum()"}`,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source. The value of the last line is returned if it is an expression at the top level (not inside try, if, for or with). Otherwise print() what you need.' },
        timeout_s: { type: 'number', description: `Wall-clock limit in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). The kernel is restarted if it is exceeded.` },
      },
      required: ['code'],
    },
  }]
}

function clip(s, cap) {
  if (!s) return ''
  return s.length > cap ? s.slice(0, cap) + `\n[... truncated, ${s.length - cap} more characters]` : s
}

function kb(n) { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` }

/**
 * The hint for a missing file whose path started with the workspace's own
 * documents-relative folder, or null.
 *
 * list_documents and read_document name a chat's files as
 * `chats/<conversationId>/<name>`, but run_python already runs inside that
 * folder, so the same path is not found there. Qwen3-4B copied the prefix
 * into run_python three times in one run and spent all of docs-rename's turns
 * on it (agent bench, 2026-11-11), because the error never said why.
 *
 * @param {string} errorText the Python traceback
 * @param {string | undefined} code the code that ran
 * @param {string | undefined} wsRel e.g. "chats/abc"
 */
export function workspacePrefixHint(errorText, code, wsRel) {
  if (!wsRel || !/FileNotFoundError|No such file or directory/.test(errorText ?? '')) return null
  const prefix = `${wsRel}/`
  if (!(code ?? '').includes(prefix) && !(errorText ?? '').includes(prefix)) return null
  const named = new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^'"\\s]+)`).exec(`${errorText}\n${code}`)
  const example = named ? named[1] : '<name>'
  return `(run_python already runs inside ${wsRel}/, so open a file there by its bare name: "${example}", not "${prefix}${example}".)`
}

// What the model reads when its code produced nothing at all. It has to say
// what to do next. The first wording only described the state ("printed
// nothing, and its last line was not an expression"); in the agent bench of
// 2026-11-11 Qwen3-4B got it seven times in one task (multi-recover) and
// rewrote the same code each time. Its value was the last line of a `try:`
// block, which looks like "the last line" and is not a top-level expression.
export const NO_OUTPUT_TEXT =
  '(No output. The code ran without an error but showed nothing. Only an expression on the last line, at the top level, is returned: ' +
  'a value inside try, if, for, with or a function is not. Run it again with print(...) around the value you need.)'

/**
 * The hint for code whose line breaks arrived as the two characters "\n",
 * or null.
 *
 * Qwen3-4B sometimes escapes its JSON arguments twice, so the code reaches
 * Python as one line with literal backslash-n in it. Python's error, "unexpected
 * character after line continuation character", names the symptom and not
 * the cause; in the agent bench of 2026-11-11 (results T20-08-45, p4-fix-test)
 * the 4B sent the same shape eleven times and every call failed.
 *
 * Only when that SyntaxError is what happened AND the code has no real line
 * break but does have "\n": a one-liner using "\n" inside a string is fine
 * and never gets this error.
 *
 * @param {string} errorText @param {string | undefined} code
 */
export function escapedNewlineHint(errorText, code) {
  if (!/unexpected character after line continuation character/.test(errorText ?? '')) return null
  const src = code ?? ''
  if (src.includes('\n') || !src.includes('\\n')) return null
  return '(The code arrived as one line containing the two characters \\n where the line breaks should be: the argument was escaped twice. ' +
    'Send the code with real line breaks, written once in the JSON as \\n, not \\\\n.)'
}

// Python statements that are a bare word and have no value to show.
const PY_BARE_KEYWORDS = new Set(['pass', 'break', 'continue', 'return', 'raise', 'None', 'True', 'False', 'Ellipsis'])

/**
 * The hint for values the code computed on a line of their own, not the
 * last, which run_python therefore never showed; or null.
 *
 * Only the last line's value comes back. Code that ends in two values on two
 * lines gets the second one only. In the agent bench of 2026-11-11 (results
 * T20-08-45, compute-dates) the 4B put `days_difference` on its own line
 * mid-script, got back only the weekday, and then stated a day count it had
 * never seen (1031; the answer is 1000).
 *
 * Looks only at top-level lines (no indentation) that are a bare name or
 * attribute, outside brackets and triple-quoted strings. A heuristic over
 * the source, not a parse: it can miss a case, and says nothing then.
 *
 * @param {string | undefined} code
 * @returns {string | null}
 */
export function unshownValuesHint(code) {
  const lines = (code ?? '').split('\n')
  let lastIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (t && !t.startsWith('#')) { lastIdx = i; break }
  }
  const unshown = []
  let depth = 0
  let inTriple = false
  for (let i = 0; i < lastIdx; i++) {
    const line = lines[i]
    const triples = (line.match(/"""|'''/g) ?? []).length
    const wasInTriple = inTriple
    if (triples % 2 === 1) inTriple = !inTriple
    if (wasInTriple || triples > 0) continue
    const bare = line.replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""').replace(/#.*/, '')
    const startDepth = depth
    for (const ch of bare) {
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
    }
    if (startDepth > 0 || /^\s/.test(line)) continue
    const t = bare.trim()
    if (/^[A-Za-z_][\w.]*$/.test(t) && !PY_BARE_KEYWORDS.has(t)) unshown.push({ line: i + 1, name: t })
  }
  if (unshown.length === 0) return null
  const named = unshown.slice(0, 3).map((u) => `${u.name} (line ${u.line})`).join(', ')
  return `(Not shown: ${named}. A value on a line of its own is returned only when it is the last line. print() each value you need.)`
}

/**
 * Word a child reply for the model. Pure; exported for the suite.
 */
export function formatResult({ reply, error, timedOut, fresh, ranBefore, files, wsRel, capWarning, code }) {
  const parts = []
  if (fresh && ranBefore) parts.push('[A new Python kernel was started, so variables from earlier runs are gone. Files in the workspace are still there.]')
  if (timedOut) parts.push(`Error: the code ${error}. The kernel was stopped and will restart on the next call.`)
  else if (error && !reply) parts.push(`Error: ${error}`)
  if (reply) {
    const stdout = clip(reply.stdout?.replace(/\n$/, ''), OUTPUT_CAP)
    if (stdout) parts.push(stdout)
    if (reply.result !== null && reply.result !== undefined) parts.push(`Result: ${reply.result}`)
    if (reply.error) {
      parts.push(clip(reply.error.trimEnd(), 4000))
      const hint = workspacePrefixHint(reply.error, code, wsRel) ?? escapedNewlineHint(reply.error, code)
      if (hint) parts.push(hint)
    } else {
      const unshown = unshownValuesHint(code)
      if (unshown) parts.push(unshown)
    }
    const stderr = clip(reply.stderr?.trim(), 2000)
    if (stderr) parts.push(`stderr:\n${stderr}`)
  }
  if (files?.length) {
    parts.push(`Files changed: ${files.map((f) => `${f.path} (${kb(f.bytes)})`).join(', ')}`)
    parts.push(`(These are in this conversation's workspace, ${wsRel}/. read_document opens them as "${wsRel}/<name>".)`)
  }
  if (capWarning) parts.push(capWarning)
  if (!parts.length) parts.push(NO_OUTPUT_TEXT)
  return parts.join('\n')
}

export async function callTool(name, args, cfg, ctx) {
  if (name !== TOOL_NAME) return null
  const pyCfg = cfg?.python
  const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })
  if (!pyCfg?.enabled) return fail('The Python capability is not enabled.')

  const code = args?.code
  if (typeof code !== 'string' || !code.trim()) return fail('Missing required argument: code (a string of Python source).')
  const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(1, Number.isFinite(+args?.timeout_s) ? +args.timeout_s : (pyCfg.timeoutS ?? DEFAULT_TIMEOUT_S)))

  const node = resolvePythonNode()
  if (!node.ok) return fail(node.reason)
  const runtime = runtimeReady(pyCfg.runtimeDir)
  if (!runtime.ok) return fail(`The Python runtime is not installed or failed verification (${runtime.reason}). An administrator can install it from the Tools tab.`)

  const account = ctx?.account ?? null
  const conversationId = ctx?.conversationId ?? null
  let ws
  try {
    ws = workspaceDir(pyCfg.documentsRoot, account, conversationId, { create: true })
  } catch (err) {
    return fail(`Could not open this conversation's workspace: ${err.message}`)
  }
  const caps = { workspaceCapBytes: pyCfg.workspaceCapBytes, accountCapBytes: pyCfg.accountCapBytes }
  const before = checkCaps(pyCfg.documentsRoot, account, conversationId, caps)
  if (!before.ok) return fail(before.reason)

  pool.configure({ maxKernels: pyCfg.maxKernels ?? DEFAULT_MAX_KERNELS })
  const key = `${resolveUserScope(account)}/${conversationId ?? '_scratch'}`
  const startedAt = Date.now()
  let outcome
  try {
    outcome = await pool.run(key, { nodePath: node.execPath, distDir: pyCfg.runtimeDir, workspace: ws }, code, timeoutS * 1000)
  } catch (err) {
    return fail(err.message)
  }
  const ranBefore = keysThatRan.has(key)
  keysThatRan.add(key)

  const files = changedFiles(ws, startedAt)
  const after = checkCaps(pyCfg.documentsRoot, account, conversationId, caps)
  const wsRel = workspaceRelative(conversationId)
  const text = formatResult({ ...outcome, ranBefore, files, wsRel, code, capWarning: after.ok ? null : `Warning: ${after.reason}` })

  // Every changed file, figures included, as a resource link (Phase 2): the
  // chat UI draws images inline, CSVs as a table and the rest as a download,
  // and the model gets one line per file. Never the bytes, so a chart no
  // longer lands in conversations.json as base64.
  const content = [{ type: 'text', text }]
  for (const f of files.slice(0, MAX_LINKS)) content.push(fileLink(`${wsRel}/${f.path}`, { bytes: f.bytes }))

  logEvent('python', 'run', {
    durationMs: Date.now() - startedAt,
    fresh: outcome.fresh,
    timedOut: !!outcome.timedOut,
    pyError: !!outcome.reply?.error,
    files: files.length,
  })
  const isError = !!(outcome.timedOut || (outcome.error && !outcome.reply) || outcome.reply?.error)
  return { ...(isError ? { isError: true } : {}), content }
}
