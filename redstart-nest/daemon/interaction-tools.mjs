'use strict'

// =============================================================================
// Redstart Nest — host-resolved tools (agent-runtime plan §4, decision D4)
// =============================================================================
// ask_user and update_plan are DEFINED here and ANSWERED elsewhere. Only the
// client running the agent loop has a person to ask: chat-ui puts a card in
// the chat, the agent bench answers from the task file, and the daemon's task
// runtime (Phase 3) will park the task. The plan is conversation state the
// same loop keeps (it rides at the tail of each request). The loop core
// (shared/agent-core/tool-calls.mjs) routes both to the host's `ask` and
// `plan` ports before they ever reach tools/call.
//
// OFFERED ONLY TO A CLIENT THAT SAID IT CAN ANSWER. A client declares it at
// initialize, as an MCP experimental capability:
//
//   capabilities: { experimental: { 'redstart/hostTools': { names: ['ask_user'] } } }
//
// mcp-server.mjs records the names on the session, and toolDefs reads them
// back. Every other client — Yellowscript, Twig's own loop, a third-party MCP
// client — never sees the tool, because a tool that can only fail costs a turn
// and teaches the model that asking does not work.
//
// callTool still answers a direct call, with an error that says what happened:
// a call can arrive from a client whose loop does not route it (or a hand-made
// request), and an MCP "unknown tool" would read as a server fault.
//
// Never part of activeToolCatalog's other consumers: search_tools cannot find
// it (it is always pinned, so there is nothing to find), and the Tools tab's
// estimate leaves it out (it depends on the client, which the estimate has no
// view of).
// =============================================================================

import { ASK_USER_DEFINITION } from '../../shared/agent-core/ask-user.mjs'
import { UPDATE_PLAN_DEFINITION } from '../../shared/agent-core/update-plan.mjs'
import { HOST_RESOLVED_TOOL_NAMES } from './tools-definitions.mjs'

/** The MCP experimental capability a client declares at initialize. */
export const HOST_TOOLS_CAPABILITY = 'redstart/hostTools'

export const TOOL_NAMES = [...HOST_RESOLVED_TOOL_NAMES]

const DEFINITIONS = new Map([
  [ASK_USER_DEFINITION.name, ASK_USER_DEFINITION],
  [UPDATE_PLAN_DEFINITION.name, UPDATE_PLAN_DEFINITION],
])

/**
 * The host-resolved tool names an initialize request's client can answer.
 * Only names this server defines count; anything else is ignored.
 *
 * @param {any} initializeParams the `params` of an MCP initialize request
 * @returns {string[]}
 */
export function hostToolsDeclared(initializeParams) {
  const declared = initializeParams?.capabilities?.experimental?.[HOST_TOOLS_CAPABILITY]?.names
  if (!Array.isArray(declared)) return []
  return TOOL_NAMES.filter(name => declared.includes(name))
}

/**
 * @param {any} _cfg
 * @param {{ session?: { hostTools?: string[] } }} [ctx] the MCP session's state
 */
export function toolDefs(_cfg, ctx) {
  const answerable = ctx?.session?.hostTools ?? []
  return TOOL_NAMES
    .filter(name => answerable.includes(name))
    .map(name => {
      const def = DEFINITIONS.get(name)
      // A copy: annotateTool spreads it, but a frozen original must never be
      // handed to anything that might write to it.
      return { name: def.name, description: def.description, inputSchema: structuredClone(def.inputSchema) }
    })
}

export async function callTool(name, _args, _cfg, _ctx) {
  if (!TOOL_NAMES.includes(name)) return null
  return {
    isError: true,
    content: [{
      type: 'text',
      text: `${name} is answered by the application you are running in, not by this server, and this application did not answer it. Continue without it: make your best judgement and say what you assumed.`,
    }],
  }
}
