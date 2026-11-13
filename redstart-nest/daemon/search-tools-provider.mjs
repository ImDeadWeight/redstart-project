'use strict'

import { keywordSearch, rankForSearch, resolveRetrievalSettings, SEARCH_RESULT_LIMIT } from './tool-filter.mjs'
import { DISCOVERY_TOOL_NAMES, toolSearchResult } from './tool-retrieval.mjs'
import { toolMetadata } from './tool-metadata.mjs'
import { approvalRule, HOST_RESOLVED_TOOL_NAMES } from './tools-definitions.mjs'

// =============================================================================
// Redstart Nest — the search_tools capability
// =============================================================================
// The other half of retrieval: when the filter has narrowed the tool list, this
// is how the model asks for something it cannot see. It returns NAMES AND
// DESCRIPTIONS ONLY. A result is an index, not a definition — the names it
// surfaces become pins on the next turn (pinsFromMessages), and the tool then
// arrives with its real schema through the ordinary path. Returning schemas
// here would spend exactly the context the filter exists to save.
//
// INVARIANT — it searches the POST-POLICY catalog and nothing else. A banned
// tool must not be reachable by describing it: a search that could name one
// would turn a ban into a speed bump, and the model would then ask for a tool
// the gateway will strip on every subsequent turn. The catalog is supplied by
// mcp-server.mjs, which is the component that applies the bans, rather than
// assembled here from the raw registry.
//
// Advertised only while retrieval is enabled. With the filter off the model can
// already see every tool, so a search over them is a tool call that can only
// waste a turn.
//
// IT SEARCHES THIS SERVER'S CATALOG, WHICH IS NOT THE WHOLE PAYLOAD. The
// completions request is assembled client-side and can carry tools Nest never
// served — a client app's own local tools (Twig's fs_*), or an MCP server the
// client connects to directly. Retrieval can drop those, and a search cannot
// bring them back, because mcp-server.mjs has no view of the payload and
// deliberately does not get one.
//
// That asymmetry cannot be fixed from here, so it is at least made LEGIBLE: the
// tool says what it indexes, and a no-match answer says what it did not look
// at. A model told "no tools match" by an index it believes is complete will
// report the capability as non-existent — the same failure the retrieval block
// in system-prompt.mjs exists to prevent, arriving through the remedy instead
// of through the narrowed list.
// =============================================================================

/**
 * The post-policy tool catalog, injected by mcp-server.mjs at import time.
 *
 * A setter rather than an import because the dependency runs the other way:
 * mcp-server.mjs owns the provider registry and this is one of the providers in
 * it. Same shape as tools-definitions.mjs's setPluginCapabilityProvider, for
 * the same reason.
 *
 * @type {((config: any) => any[])|null}
 */
let catalogProvider = null

/** @param {(config: any) => any[]} fn */
export function setToolCatalogProvider(fn) {
  catalogProvider = fn
}

/**
 * The policy-checked caller for call_tool: mcp-server.mjs callToolAs, injected
 * for the same reason as the catalog (the dependency runs the other way).
 *
 * @type {((account: any, name: string, args: any, opts: { conversationId?: string, session?: object }) => Promise<any>)|null}
 */
let toolCaller = null

/** @param {(account: any, name: string, args: any, opts: object) => Promise<any>} fn */
export function setToolCaller(fn) {
  toolCaller = typeof fn === 'function' ? fn : null
}

export const TOOL_NAMES = ['search_tools', 'describe_tool', 'call_tool']

const NAME_SCHEMA = { type: 'string', description: 'The tool\'s exact name, as search_tools returned it' }

/** call_tool is offered only when an admin turns it on (second pass 5.5, U4). */
function callToolEnabled(cfg) {
  return cfg?.toolRetrieval?.enabled === true && cfg?.toolRetrieval?.callTool === true
}

export function toolDefs(cfg) {
  if (cfg?.toolRetrieval?.enabled !== true) return []
  const defs = [{
    name: 'search_tools',
    description:
      'Find tools THIS SERVER offers that are not currently listed. Describe what you are trying to do in your own words — for example "read a spreadsheet" or "look at recent commits" — and this returns the names, categories and descriptions of the closest matches. Call a returned tool by name on your next turn and it will be available. It indexes this server\'s own tools only: tools your application supplies itself, such as file tools that run on the user\'s computer, are not searchable here and a nil result says nothing about them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are trying to do, in your own words' },
      },
      required: ['query'],
    },
  }, {
    name: 'describe_tool',
    description:
      'Get the full definition of one of this server\'s tools by name — what it does, where it acts and its parameters — for a tool search_tools found. The tool is then in your list from your next turn.',
    inputSchema: { type: 'object', properties: { name: NAME_SCHEMA }, required: ['name'] },
  }]
  if (callToolEnabled(cfg)) {
    defs.push({
      name: 'call_tool',
      description:
        'Call one of this server\'s tools that is not in your list, by name, with the arguments its describe_tool definition asks for. For tools that read or look things up; a tool that changes or deletes something must be called directly once it is in your list.',
      inputSchema: {
        type: 'object',
        properties: {
          name: NAME_SCHEMA,
          arguments: { type: 'object', description: 'The tool\'s arguments, as its definition describes them' },
        },
        required: ['name'],
      },
    })
  }
  return defs
}

export async function callTool(name, args, cfg, ctx) {
  if (!TOOL_NAMES.includes(name)) return null
  if (name === 'call_tool' && !callToolEnabled(cfg)) return null
  if (cfg?.toolRetrieval?.enabled !== true) {
    return errorResult('Tool retrieval is not enabled on this server, so there are no hidden tools to search for.')
  }
  if (!catalogProvider) {
    return errorResult('The tool catalog is unavailable.')
  }

  let catalog
  try {
    catalog = catalogProvider(cfg)
  } catch (err) {
    return errorResult(`The tool catalog could not be read: ${err.message}`)
  }
  // Never offer a discovery tool as a result of discovery.
  const searchable = (catalog ?? []).filter(t => t && !DISCOVERY_TOOL_NAMES.includes(t.name))

  if (name === 'search_tools') return searchCatalog(searchable, args, cfg)
  if (name === 'describe_tool') return describe(searchable, args, cfg)
  return proxyCall(searchable, args, ctx)
}

// ---------------------------------------------------------------------------
// search_tools: widening the search until something answers (5.3)
// ---------------------------------------------------------------------------
// 1. the configured scorer with its floors          match: "close"
// 2. the same ranking with no floors, the top few    match: "nearest"
// 3. keywords alone on names and tags (no embedder)  match: "keyword"
// 4. every category with its tool names              match: "categories"
// The reply says which step answered, so a model can weigh a "nearest" list
// as the guess it is. Only an empty catalog says there is no such tool.

/** How many results step 2 shows when nothing cleared the floors. */
export const NEAREST_LIMIT = 5

async function searchCatalog(searchable, args, cfg) {
  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  if (!query) {
    return errorResult('Describe what you are trying to do — search_tools takes a `query` string.')
  }
  if (searchable.length === 0) {
    // Says what was searched, not just that nothing was found. "No tools match"
    // from an index the model believes is complete becomes "this deployment
    // cannot do that" in the answer to the user.
    return textResult('No other tools on this server match that description. This index covers this server\'s own tools only, so it says nothing about tools your application provides itself.')
  }

  const settings = cfg?.toolRetrieval ?? {}
  const ranked = await rankForSearch({ tools: searchable, query, settings })
  if (ranked && ranked.length > 0) {
    const config = resolveRetrievalSettings(settings)
    const best = ranked[0].score
    const cut = config.relativeFloor > 0 && best > 0 ? Math.max(config.floor, best * config.relativeFloor) : config.floor
    const close = ranked.filter((e) => e.score >= cut && e.score > 0).slice(0, SEARCH_RESULT_LIMIT)
    if (close.length > 0) return rows('close', close)
    return rows('nearest', ranked.slice(0, NEAREST_LIMIT),
      'Nothing matched closely. These are the nearest by score; check a description before relying on one.')
  }

  const keyword = keywordSearch({ tools: searchable, query })
  if (keyword.length > 0) {
    return rows('keyword', keyword.slice(0, SEARCH_RESULT_LIMIT),
      'Matched by name and keywords only: the semantic search is unavailable right now.')
  }

  /** @type {Map<string, string[]>} */
  const byCategory = new Map()
  for (const t of searchable) {
    const c = toolMetadata(t.name).category
    if (!byCategory.has(c)) byCategory.set(c, [])
    byCategory.get(c).push(t.name)
  }
  return textResult(JSON.stringify({
    match: 'categories',
    note: 'Nothing matched by name or keyword. These are all of this server\'s tools, by category: call describe_tool on one that fits. If none fits, this server has no such tool; tools your application provides itself are not indexed here, so this says nothing about them.',
    categories: [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([category, tools]) => ({ category, tools: tools.sort() })),
  }))
}

function rows(match, entries, note) {
  return textResult(JSON.stringify({
    match,
    ...(note ? { note } : {}),
    tools: entries.map((e) => toolSearchResult(e.tool)),
  }))
}

// ---------------------------------------------------------------------------
// describe_tool (5.2)
// ---------------------------------------------------------------------------

// The same words for a banned tool and a tool that does not exist: the catalog
// is post-policy, so a ban is simply absence, and the answer must not tell
// the two apart.
function notFound(name) {
  const shown = String(name).slice(0, 128)
  return errorResult(`No tool named "${shown}" on this server. search_tools lists what there is.`)
}

function lookup(searchable, args) {
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  if (!name) return { error: errorResult('Name the tool — this takes a `name` string.') }
  const tool = searchable.find((t) => t.name === name)
  return tool ? { tool } : { error: notFound(name) }
}

function describe(searchable, args, cfg) {
  const { tool, error } = lookup(searchable, args)
  if (error) return error
  const row = toolSearchResult(tool)
  const m = toolMetadata(tool.name)
  return textResult(JSON.stringify({
    ...row,
    ...(m.useWhen ? { useWhen: m.useWhen } : {}),
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    note: callToolEnabled(cfg)
      ? 'It is in your tool list from your next turn. To use it now, call call_tool with this name and arguments.'
      : 'It is in your tool list from your next turn.',
  }))
}

// ---------------------------------------------------------------------------
// call_tool (5.5 b): a call that does not change the tool list
// ---------------------------------------------------------------------------
// Through callToolAs, so policy, the approval gate, the verified conversation
// and logging are what a direct call gets. Only tools that need no approval:
// the client asks the user about a call by the name it sees, which here is
// call_tool, so a write or a delete through it would skip that question.

async function proxyCall(searchable, args, ctx) {
  const { tool, error } = lookup(searchable, args)
  if (error) return error
  if (HOST_RESOLVED_TOOL_NAMES.includes(tool.name)) {
    return errorResult(`${tool.name} is answered by your application, not this server: call it directly.`)
  }
  if (approvalRule(tool.name) !== 'none') {
    return errorResult(`${tool.name} changes or deletes something, so it cannot go through call_tool. It is in your tool list from your next turn (call describe_tool on it); call it directly then.`)
  }
  if (!toolCaller) return errorResult('Calling tools by name is unavailable.')
  const inner = args?.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {}
  const result = await toolCaller(ctx?.account ?? null, tool.name, inner, { conversationId: ctx?.conversationId, session: ctx?.session })
  return result ?? notFound(tool.name)
}

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text) {
  return { isError: true, content: [{ type: 'text', text }] }
}
