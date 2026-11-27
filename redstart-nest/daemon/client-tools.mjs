'use strict'

// =============================================================================
// Redstart Nest — tools a connected client runs for a task (master plan 7.1)
// =============================================================================
// A run on the server can use tools that only the client can run: Twig's
// fs_* (a folder on the user's own computer), and MCP servers the browser
// reaches itself. The client registers them when it starts the run (or
// reconnects); a call to one is sent to it over the run's event stream and
// its result comes back by POST. Approval for a client tool is the client's
// own card (D48), as it is today.
//
// This module only checks what a client may register. The waiting is the
// runner's (task-runner.mjs), the dispatch the tools port's (task-ports.mjs).
//
// What a client registers is a DESCRIPTION, never a capability: the model is
// offered the tool, and a call is a request the client may refuse. A name
// that is one of Nest's own tools is dropped (a client cannot replace
// read_document with its own), and the admin's bans apply to client tools by
// name, as to any tool in a completion.
// =============================================================================

export const MAX_CLIENT_TOOLS = 64
const MAX_DESCRIPTION_CHARS = 2000
const MAX_SCHEMA_CHARS = 16_000
/** How long a call waits for its client before it is answered as unavailable. */
export const CLIENT_CALL_TIMEOUT_MS = 10 * 60 * 1000
/** A client's result, cut to this. */
export const MAX_CLIENT_RESULT_CHARS = 200_000

const NAME = /^[A-Za-z0-9_-]{1,64}$/

/**
 * A client's tool list, checked: names unique and tool-shaped, descriptions
 * and schemas bounded. Anything malformed refuses the whole list, so a
 * client learns at once rather than finding a tool missing later.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, tools: { name: string, description: string, inputSchema: object }[] } | { ok: false, error: string }}
 */
export function cleanClientTools(raw) {
  if (raw === undefined || raw === null) return { ok: true, tools: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'clientTools must be a list' }
  if (raw.length > MAX_CLIENT_TOOLS) return { ok: false, error: `at most ${MAX_CLIENT_TOOLS} client tools` }
  const seen = new Set()
  const tools = []
  for (const t of raw) {
    const name = t?.name
    if (typeof name !== 'string' || !NAME.test(name)) return { ok: false, error: `a client tool name must be letters, digits, "_" or "-" (at most 64): ${String(name).slice(0, 80)}` }
    if (seen.has(name)) return { ok: false, error: `client tool "${name}" is listed twice` }
    seen.add(name)
    const description = typeof t.description === 'string' ? t.description.slice(0, MAX_DESCRIPTION_CHARS) : ''
    const schema = t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema) ? t.inputSchema : { type: 'object', properties: {} }
    if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) return { ok: false, error: `client tool "${name}" has a schema over ${MAX_SCHEMA_CHARS} characters` }
    tools.push({ name, description, inputSchema: schema })
  }
  return { ok: true, tools }
}

export const MAX_EXCLUDED_TOOLS = 512

/**
 * Which of Nest's tools the client has switched off for this chat, as its
 * own loop would (master plan 7.1): `nest: false` when Nest's server is off
 * for the chat, `exclude` the tools switched off one by one. Kept on the
 * task record, so a resume after a restart honours them too. A narrowing
 * only: nothing here can add a tool. ask_user and update_plan are the
 * task's own and stay.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, limits: { nest: boolean, exclude: string[] } | null } | { ok: false, error: string }}
 */
export function cleanToolLimits(raw) {
  if (raw === undefined || raw === null) return { ok: true, limits: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'toolLimits must be an object' }
  if (raw.nest !== undefined && typeof raw.nest !== 'boolean') return { ok: false, error: 'toolLimits.nest must be true or false' }
  const exclude = raw.exclude ?? []
  if (!Array.isArray(exclude)) return { ok: false, error: 'toolLimits.exclude must be a list' }
  if (exclude.length > MAX_EXCLUDED_TOOLS) return { ok: false, error: `toolLimits.exclude: at most ${MAX_EXCLUDED_TOOLS} names` }
  for (const name of exclude) {
    if (typeof name !== 'string' || !NAME.test(name)) return { ok: false, error: `toolLimits.exclude: not a tool name: ${String(name).slice(0, 80)}` }
  }
  return { ok: true, limits: { nest: raw.nest !== false, exclude: [...new Set(exclude)] } }
}

/** What the model is told when the app that runs a tool is not there. */
export function clientUnavailable(name) {
  return `Error: ${name} runs in the user's app, which is not connected to this conversation right now, so it was not run. Tell the user, or carry on without it.`
}
