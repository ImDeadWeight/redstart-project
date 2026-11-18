'use strict'

// =============================================================================
// Redstart Nest — Gateway /projects routes (projects-plan Phase 2)
// =============================================================================
// Backs chat-ui's Projects (the sidebar section with chats nested under each,
// and the project page).
//
//   GET    /projects        { projects, limits }
//   POST   /projects        create one of the caller's own
//   GET    /projects/:id
//   PUT    /projects/:id    name and/or instructions
//   DELETE /projects/:id    its chats MOVE OUT (user decision), its memories
//                           go with it, its files folder is left on disk
//   GET    /projects/:id/agents-md   the instructions as an AGENTS.md file
//   PUT    /projects/:id/agents-md   { text }: an AGENTS.md replaces them
//                                    (master plan Phase 5)
//
// Every project in a response carries `folder` ("Projects/<slug>/"), relative
// to the user's Documents space; POST and GET make sure it exists.
//
// Scoped to the authenticated account (or the shared auth-off scope), never to
// an id the client names, the same rule as /memories and /workflows. Access is
// decided only by projects-storage canRead / canWrite (owner-only until
// sharing lands, plan D7); a project the caller may not read answers 404, not
// 403, so ids cannot be probed.
//
// Not gated by a capability or role: anyone may organise their own chats.
// =============================================================================

import * as fs from 'fs'
import {
  listProjects, getProject, createProject, updateProject, deleteProject, projectFolder,
  agentsMdFor, instructionsFromAgentsMd,
  MAX_NAME_CHARS, MAX_INSTRUCTIONS_CHARS, MAX_PROJECTS_PER_ACCOUNT,
} from '../projects-storage.mjs'
import { getCapabilities } from '../tools-storage.mjs'
import { resolveUserPath } from '../user-scope.mjs'
import { deleteProjectMemories } from '../memory-storage.mjs'
import { dropSuggestions } from '../memory-review-store.mjs'
import { detachProject } from '../conversations-storage.mjs'
import { sendJson, readJsonBody } from './http-json.mjs'
import { logEvent } from '../logger.mjs'

const ITEM = /^\/projects\/([A-Za-z0-9-]{1,64})$/
const AGENTS_MD = /^\/projects\/([A-Za-z0-9-]{1,64})\/agents-md$/
/** An AGENTS.md import's JSON body. The instructions limit applies after. */
const MAX_AGENTS_MD_BODY_BYTES = 256 * 1024

export function isProjectRoute(urlPath) {
  return urlPath === '/projects' || ITEM.test(urlPath) || AGENTS_MD.test(urlPath)
}

/** The body, or null when it is over `max` bytes or not JSON. Stops reading at the cap. */
async function readCappedJson(req, max) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) return null
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return null }
}

const NOT_FOUND = { error: { message: 'Not found', type: 'not_found' } }

// What the client sees: the record plus its files folder, relative to the
// user's Documents space (plan D14), so the UI never builds the path itself.
function view(project) {
  return { ...project, folder: projectFolder(project) }
}

// The files folder, made when the project is. Best effort: with no Documents
// folder configured there is nowhere to put it, and a project without files is
// still a project. Through resolveUserPath, so it lands in the caller's own
// storage and nowhere else. Never removed by us (plan D14).
function ensureFolder(account, project) {
  const root = getCapabilities().documents?.outputDir
  if (!root) return false
  try {
    fs.mkdirSync(resolveUserPath(root, account, projectFolder(project), { create: true }), { recursive: true })
    return true
  } catch (err) {
    logEvent('project', 'folder_failed', { reason: err.message })
    return false
  }
}

function fail(res, r) {
  const status = r.code === 'not_found' ? 404 : r.code === 'conflict' ? 409 : 400
  const type = r.code === 'not_found' ? 'not_found' : r.code === 'conflict' ? 'conflict' : 'invalid_request_error'
  sendJson(res, status, { error: { message: r.error, type } })
}

export async function handleProjectRoute(req, res, urlPath, account) {
  try {
    if (urlPath === '/projects' && req.method === 'GET') {
      sendJson(res, 200, {
        projects: listProjects(account).map(view),
        limits: {
          maxNameChars: MAX_NAME_CHARS,
          maxInstructionsChars: MAX_INSTRUCTIONS_CHARS,
          maxProjects: MAX_PROJECTS_PER_ACCOUNT,
        },
      })
      return true
    }

    if (urlPath === '/projects' && req.method === 'POST') {
      const r = createProject(account, await readJsonBody(req))
      if (!r.ok) { fail(res, r); return true }
      const folderReady = ensureFolder(account, r.project)
      logEvent('project', 'created', { account: account?.username ?? undefined, folderReady })
      sendJson(res, 201, view(r.project))
      return true
    }

    const agents = AGENTS_MD.exec(urlPath)
    if (agents && req.method === 'GET') {
      const project = getProject(account, agents[1])
      if (!project) { sendJson(res, 404, NOT_FOUND); return true }
      const body = Buffer.from(agentsMdFor(project))
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="AGENTS.md"',
        'Content-Length': body.length,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Disposition',
      })
      res.end(body)
      return true
    }
    if (agents && req.method === 'PUT') {
      const body = await readCappedJson(req, MAX_AGENTS_MD_BODY_BYTES)
      if (!body || typeof body.text !== 'string') {
        sendJson(res, 400, { error: { message: 'Expected { text: <the AGENTS.md file> }', type: 'invalid_request_error' } })
        return true
      }
      const r = updateProject(account, agents[1], { instructions: instructionsFromAgentsMd(body.text) })
      if (!r.ok) { fail(res, r); return true }
      logEvent('project', 'agents_md_imported', { account: account?.username ?? undefined })
      sendJson(res, 200, view(r.project))
      return true
    }
    if (agents) return false

    const item = ITEM.exec(urlPath)
    if (!item) return false
    const id = item[1]

    if (req.method === 'GET') {
      const project = getProject(account, id)
      if (project) ensureFolder(account, project)
      sendJson(res, project ? 200 : 404, project ? view(project) : NOT_FOUND)
      return true
    }

    if (req.method === 'PUT') {
      const r = updateProject(account, id, await readJsonBody(req))
      if (!r.ok) { fail(res, r); return true }
      logEvent('project', 'updated', { account: account?.username ?? undefined })
      sendJson(res, 200, view(r.project))
      return true
    }

    if (req.method === 'DELETE') {
      const removed = deleteProject(account, id)
      if (!removed) { sendJson(res, 404, NOT_FOUND); return true }
      // Record first, then what hung off it: a crash between the two leaves
      // chats pointing at a project that no longer resolves, which every
      // reader already treats as "not in a project". The reverse order could
      // leave a live project with its chats silently moved out.
      const chatsMovedOut = detachProject(id)
      const memoriesDeleted = deleteProjectMemories(account, id)
      dropSuggestions(account, (s) => s.projectId === id)
      logEvent('project', 'deleted', { account: account?.username ?? undefined, chatsMovedOut, memoriesDeleted })
      sendJson(res, 200, { deleted: true, chatsMovedOut, memoriesDeleted })
      return true
    }

    return false
  } catch (err) {
    sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } })
    return true
  }
}
