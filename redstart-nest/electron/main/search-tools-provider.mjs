'use strict'

import { searchTools, SEARCH_RESULT_LIMIT } from './tool-filter.mjs'

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

export const TOOL_NAMES = ['search_tools']

export function toolDefs(cfg) {
  if (cfg?.toolRetrieval?.enabled !== true) return []
  return [{
    name: 'search_tools',
    description:
      'Find tools THIS SERVER offers that are not currently listed. Describe what you are trying to do in your own words — for example "read a spreadsheet" or "look at recent commits" — and this returns the names and descriptions of the closest matches. Call a returned tool by name on your next turn and it will be available. It indexes this server\'s own tools only: tools your application supplies itself, such as file tools that run on the user\'s computer, are not searchable here and a nil result says nothing about them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are trying to do, in your own words' },
      },
      required: ['query'],
    },
  }]
}

export async function callTool(name, args, cfg, _ctx) {
  if (name !== 'search_tools') return null
  if (cfg?.toolRetrieval?.enabled !== true) {
    return errorResult('Tool retrieval is not enabled on this server, so there are no hidden tools to search for.')
  }

  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  if (!query) {
    return errorResult('Describe what you are trying to do — search_tools takes a `query` string.')
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

  // Never offer search_tools as a result of a search.
  const searchable = (catalog ?? []).filter(t => t?.name !== 'search_tools')
  const matches = await searchTools({ tools: searchable, query, limit: SEARCH_RESULT_LIMIT })

  // null is "the scorer is down", which is a different answer from "nothing
  // matched" and must not be flattened into it — a model told there are no
  // matching tools will stop looking.
  if (matches === null) {
    return errorResult('Tool search is temporarily unavailable. The tools you can already see are still the ones you can use.')
  }
  if (matches.length === 0) {
    // Says what was searched, not just that nothing was found. "No tools match"
    // from an index the model believes is complete becomes "this deployment
    // cannot do that" in the answer to the user.
    return textResult('No other tools on this server match that description. This index covers this server\'s own tools only, so it says nothing about tools your application provides itself.')
  }

  return textResult(JSON.stringify(matches))
}

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text) {
  return { isError: true, content: [{ type: 'text', text }] }
}
