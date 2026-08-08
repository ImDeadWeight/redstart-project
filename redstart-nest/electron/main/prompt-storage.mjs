'use strict'

// =============================================================================
// Redstart Nest — Admin-owned system prompt blocks (spec §3)
// =============================================================================
// Stores the three admin-authored blocks — context, policy, style — that
// composePrompt() assembles alongside the derived ones. Mirrors the
// tools-storage.mjs pattern: a single JSON file under userData, read on
// demand, no caching.
//
// Deliberately server-side. The client's own `systemMessage` (browser
// localStorage) is per-user preference text and remains a USER-tier input,
// subordinated by the precedence clause. Nothing here migrates it: the two
// live at different tiers by design, so admin blocks are additive and no
// existing user setting is rewritten or lost.
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

// The block contract. Order is spec §3's; composePrompt owns placement.
export const PROMPT_BLOCK_KEYS = ['context', 'policy', 'style']

// Guards against a single paste turning every request into a context-budget
// problem (spec §10 is a SOFT budget, but storage still needs an upper bound).
// Generous enough that no legitimate deployment text hits it.
export const MAX_BLOCK_CHARS = 8000

const EMPTY = { context: '', policy: '', style: '', updatedAt: null, updatedBy: null }

function getPath() {
  return path.join(app.getPath('userData'), 'prompt-blocks.json')
}

function read() {
  const p = getPath()
  if (!fs.existsSync(p)) return { ...EMPTY }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { ...EMPTY, ...parsed }
  } catch {
    // A corrupt file must not take the gateway down or, worse, silently
    // drop admin policy while continuing to serve completions. Fall back to
    // empty blocks — the derived blocks (identity, data_handling) still
    // compose, so the model stays truthful even with no admin text.
    return { ...EMPTY }
  }
}

function write(data) {
  fs.writeFileSync(getPath(), JSON.stringify(data, null, 2), 'utf8')
}

/** The three admin blocks, as composePrompt's `admin` input. */
export function getPromptBlocks() {
  const data = read()
  return {
    context: data.context || '',
    policy: data.policy || '',
    style: data.style || '',
  }
}

/** Blocks plus provenance, for the Settings UI. */
export function getPromptBlocksMeta() {
  const data = read()
  return {
    ...getPromptBlocks(),
    updatedAt: data.updatedAt,
    updatedBy: data.updatedBy,
  }
}

/**
 * Replace one or more blocks. Only known keys are accepted — an unrecognised
 * key is dropped rather than stored, so a client cannot invent a block the
 * composer never emits and believe it took effect.
 *
 * @param {object} partial  any subset of PROMPT_BLOCK_KEYS
 * @param {string} [actor]  username, recorded for provenance only
 */
export function setPromptBlocks(partial, actor) {
  if (!partial || typeof partial !== 'object') return { ok: false, error: 'No blocks supplied' }

  const next = read()
  let touched = false

  for (const key of PROMPT_BLOCK_KEYS) {
    if (!(key in partial)) continue
    const value = partial[key]
    if (typeof value !== 'string') return { ok: false, error: `Block "${key}" must be a string` }
    if (value.length > MAX_BLOCK_CHARS) {
      return { ok: false, error: `Block "${key}" exceeds ${MAX_BLOCK_CHARS} characters` }
    }
    next[key] = value
    touched = true
  }

  if (!touched) return { ok: false, error: 'No recognised blocks supplied' }

  next.updatedAt = new Date().toISOString()
  next.updatedBy = typeof actor === 'string' ? actor : null
  write(next)
  return { ok: true, blocks: getPromptBlocksMeta() }
}
