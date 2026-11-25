'use strict'

// =============================================================================
// Redstart Nest — composing a completion's system prompt
// =============================================================================
// The gateway's half of prompt assembly: resolve the live facts the composer
// needs (the caller's project, their memories, the admin's blocks, which tools
// the request really carries) and put the composed prompt ahead of the
// messages. Assembly itself is system-prompt.mjs — pure, synchronous, and
// testable without a server (spec §11). Split out of tools-gateway.mjs's
// prepareCompletion in master plan Phase 4; it re-exports what it exported.
//
// `hasTools` = the request actually carries tool definitions, and gates every
// capability claim; see the substantiation rule in system-prompt.mjs.
// =============================================================================

import { getExternalServers } from './tools-storage.mjs'
import { CLIENT_APP_TOOL_NAMES } from './tools-definitions.mjs'
import { memoriesFor } from './memory-storage.mjs'
import { composePrompt } from './system-prompt.mjs'
import { getPromptBlocks } from './prompt-storage.mjs'
import { getProject } from './projects-storage.mjs'
import { skillsForPrompt } from './skills-tool.mjs'
import { getArtifact, isArtifactId } from './artifacts-storage.mjs'

// The request's `redstart_project`, as a project this caller may read, or
// null. Only name, id and instructions travel on: the composer has no use
// for the owner or members, and a smaller object is a smaller surface.
export function resolveProject(account, claimed) {
  if (typeof claimed !== 'string' || !claimed) return null
  let project = null
  try { project = getProject(account, claimed) } catch { return null }
  return project ? { id: project.id, name: project.name, instructions: project.instructions } : null
}

// The request's `redstart_artifact` (artifacts plan §10: the artifact open
// beside the chat), as one this caller may read, or null. An id, never text:
// the title comes from the store, and the composer quotes it as data.
export function resolveArtifact(account, claimed) {
  if (!isArtifactId(claimed)) return null
  let art = null
  try { art = getArtifact(account, claimed) } catch { return null }
  return art ? { id: art.id, title: art.title, kind: art.kind, head: art.head } : null
}

// The FIRST user message's text, which picks the most relevant memories for
// the chat (memory-storage selectForPrompt). Content may be a string or an
// OpenAI parts array; only text parts count, and only the first 2000 chars.
//
// The first, not the latest (agent-runtime D40): the memory block sits in the
// system prompt, ahead of the whole chat, and picking by the latest message
// changed it on most turns. measure-memory-cache.mjs on Ornith 9B, an 8k-token
// chat: 0 tokens reused from the cache on every turn and 5.5 s of prefill each
// (a hybrid model reuses no partial prefix at all), against ~7700 reused and
// 0.2 s with the selection pinned. The request carries the whole chat, so its
// first user message is the same on every turn: the block now changes only
// when a memory does, with no state kept here. What a later question needs
// and the first did not pull in is one memory_search away (the block says so
// when memories are left out).
export function firstUserText(messages) {
  const first = (messages || []).find((m) => m?.role === 'user')
  if (!first) return ''
  const c = first.content
  const text = typeof c === 'string'
    ? c
    : Array.isArray(c) ? c.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join(' ') : ''
  return text.slice(0, 2000)
}

function buildSystemContext(config, facts, query = '') {
  const { prompt } = composePrompt({
    config,
    externalServers: getExternalServers(),
    admin: getPromptBlocks(),
    // facts.project is already resolved against the caller (resolveProject).
    ...memoriesFor(config, facts.account, { projectId: facts.project?.id ?? null, query }),
    // Names and descriptions only (master plan Phase 5); the composer shows
    // them only when the request carries use_skill.
    ...skillsForPrompt(facts.account ?? null),
    ...facts,
  })
  return prompt
}

// Tool names in this request that execute on the CLIENT'S machine — Redstart
// Twig's fs_* file tools, which act on a folder the user granted on their own
// PC. Read from the payload rather than inferred from the surface: a Twig user
// who has granted no folder sends none of them, and for that session there is
// only one machine to talk about.
//
// This is the same rule the rest of the prompt follows: a claim is made only
// when the request substantiates it.
export function clientToolNamesIn(parsed) {
  const present = new Set(toolNamesIn(parsed))
  const local = []
  for (const names of Object.values(CLIENT_APP_TOOL_NAMES)) {
    for (const name of names) if (present.has(name)) local.push(name)
  }
  return local
}

// Every tool name in the payload, in both shapes the gateway sees: OpenAI's
// { function: { name } } on the wire and MCP's flat { name }.
//
// This is what the capability claims are substantiated against. It must be read
// AFTER bans and the catalog have both run — config says what an admin enabled,
// and since the catalog can narrow a payload without changing any config,
// config is no longer evidence that the model received anything in particular.
export function toolNamesIn(parsed) {
  if (!Array.isArray(parsed?.tools)) return []
  const names = []
  for (const tool of parsed.tools) {
    const name = typeof tool === 'object' && tool !== null ? tool.function?.name : tool?.name
    if (typeof name === 'string' && name) names.push(name)
  }
  return names
}

// The composed prompt is PREPENDED to any client-supplied system message, so
// client text lands after the precedence clause and is thereby subordinated to
// admin policy (spec §4). Phase 7 stops accepting client system prose
// altogether; until then this ordering is what makes the floor hold.
export function injectSystemContext(messages, config, facts) {
  const context = buildSystemContext(config, facts, firstUserText(messages))
  const sysIdx = messages.findIndex(m => m.role === 'system')
  if (sysIdx >= 0) {
    messages[sysIdx] = { ...messages[sysIdx], content: `${context}\n\n${messages[sysIdx].content}` }
  } else {
    messages.unshift({ role: 'system', content: context })
  }
  return messages
}
