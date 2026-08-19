'use strict'

// =============================================================================
// Redstart Nest — Gateway prompt & egress routes
// =============================================================================
// The three read-mostly policy surfaces that let a client inspect — and an
// admin edit — what the system prompt will say:
//
//   GET  /egress         the data-handling audit (spec §7)
//   GET  /prompt-modes   the mode registry clients pick an ID from (spec §9)
//   GET  /prompt-blocks  admin blocks + a live composed preview (spec §3)
//   PUT  /prompt-blocks  admin-tier write — the floor, not a preference (§4)
//
// The caller has already been authenticated by the gateway; the account is
// handed in, and the admin check for the write path happens here because it is
// a per-route rule rather than a gate over everything that follows.
//
// This module knows nothing about the proxy or llama-server. It reads the live
// config it is given and asks system-prompt.mjs to compose.
// =============================================================================

import { canDo } from '../auth.mjs'
import { logEvent } from '../logger.mjs'
import { getExternalServers } from '../tools-storage.mjs'
import { composePrompt, deriveEgressFacts, DEFAULT_TOKEN_BUDGET, listModes } from '../system-prompt.mjs'
import { getPromptBlocks, getPromptBlocksMeta, setPromptBlocks, MAX_BLOCK_CHARS } from '../prompt-storage.mjs'
import { sendJson, readJsonBody } from './http-json.mjs'

// Returns true when the request was handled (a response has been written),
// false when the path is not ours and the gateway should keep dispatching.
export async function handlePromptRoute(req, res, urlPath, config, account) {
  // Egress audit (spec §7). The same facts the data_handling block is
  // built from, served as data so "where does my data go?" is a question
  // with a checkable answer rather than a sentence the model paraphrases.
  //
  // hasTools is TRUE here on purpose: the prompt describes only egress the
  // current request can actually reach, but an audit must report every
  // path the deployment is CONFIGURED for, whether or not this particular
  // client sent tool definitions. Understating configured egress to an
  // auditor is the same failure as overstating privacy to a user.
  if (req.method === 'GET' && urlPath === '/egress') {
    const facts = deriveEgressFacts(config, getExternalServers(), true)
    sendJson(res, 200, {
      inference: facts.inference,
      webDomains: facts.webDomains,
      remoteToolServers: facts.remoteToolServers,
      credentialPlugins: facts.credentialPlugins,
      localStores: facts.localStores,
      hasEgress: facts.hasEgress,
      // Redstart records no retention/training terms for third parties.
      // Reporting the absence is the point — see spec §7.
      externalTermsKnown: false,
    })
    return true
  }

  // Available task modes (spec §9). Clients send the ID, so they need to
  // know which IDs exist; the preset text is returned for display only —
  // sending it back has no effect, since the composer resolves IDs.
  if (req.method === 'GET' && urlPath === '/prompt-modes') {
    sendJson(res, 200, { modes: listModes() })
    return true
  }

  // Admin-owned prompt blocks (spec §3).
  //
  // READ is open to any authenticated user, deliberately: the policy block
  // governs how the assistant treats them, and a rule you are subject to
  // but cannot read is not a policy the user can hold the deployment to.
  // WRITE is admin-tier, which is what makes it a floor rather than a
  // preference (spec §4).
  if (req.method === 'GET' && urlPath === '/prompt-blocks') {
    const meta = getPromptBlocksMeta()
    const preview = composePrompt({
      config,
      hasTools: true,
      externalServers: getExternalServers(),
      account,
      admin: getPromptBlocks(),
    })
    sendJson(res, 200, {
      blocks: meta,
      limits: { maxBlockChars: MAX_BLOCK_CHARS, tokenBudget: DEFAULT_TOKEN_BUDGET },
      // Live budget feedback for the Settings UI (spec §10). Advisory:
      // overBudget is surfaced to the admin, never enforced on the request.
      composed: {
        tokens: preview.tokens,
        overBudget: preview.overBudget,
        blocks: preview.blocks,
        prompt: preview.prompt,
      },
      canEdit: canDo(account, 'managePromptBlocks'),
    })
    return true
  }

  if (req.method === 'PUT' && urlPath === '/prompt-blocks') {
    // Admin tier is the ceiling, the account's role can withhold it — an admin
    // who manages accounts but must not rewrite the assistant's policy floor is
    // a real configuration. See permissions.mjs ADMIN_PERMISSIONS.
    if (!canDo(account, 'managePromptBlocks')) {
      sendJson(res, 403, { error: 'Admin role required' })
      return true
    }
    const body = await readJsonBody(req)
    if (!body) {
      sendJson(res, 400, { error: 'Invalid JSON' })
      return true
    }
    const result = setPromptBlocks(body, account?.username)
    if (!result.ok) {
      sendJson(res, 400, { error: result.error })
      return true
    }
    logEvent('prompt', 'blocks_updated', {
      username: account?.username,
      keys: Object.keys(body).filter(k => typeof body[k] === 'string'),
    })
    sendJson(res, 200, { blocks: result.blocks })
    return true
  }

  return false
}
