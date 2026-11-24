'use strict'

// =============================================================================
// Redstart Nest — Gateway /projects routes (projects-plan Phase 2)
// =============================================================================
// Backs chat-ui's Projects (the sidebar section with chats nested under each,
// and the project page).
//
//   GET    /projects        { projects, limits } — owned and shared with me;
//                            ?all=1: every project (manageProjects only)
//   POST   /projects        create one of the caller's own
//   GET    /projects/:id
//   PUT    /projects/:id    name and/or instructions (editors and up)
//   DELETE /projects/:id    owner or admin: its chats MOVE OUT (each person's
//                           own), its memories go with it, its files folder is
//                           left on disk
//   PUT    /projects/:id/members   { members: [{ type, id, role }] } (owner, admin)
//   POST   /projects/:id/transfer  { accountId } — hand it over (owner, admin)
//   GET    /projects/:id/agents-md   the instructions as an AGENTS.md file
//   PUT    /projects/:id/agents-md   { text }: an AGENTS.md replaces them
//   GET    /directory       { accounts: [{id, username}], groups: [{id, name}] }
//                           — who a project can be shared with
//
// Every project in a response carries `access` (owner / admin / editor /
// viewer) and `folder`, the file-explorer space of its files
// ("project-<id>"); POST and GET make sure the folder exists.
//
// Access is decided only by projects-storage (accessFor and the three can*
// around it); a project the caller may not read answers 404, not 403, so ids
// cannot be probed. One they may read but not change answers 403.
//
// Not gated by a capability or role: anyone may organise their own chats.
// =============================================================================

import {
  listProjects, listAllProjects, getProject, createProject, updateProject, deleteProject, projectFolder,
  setMembers, transferProject, ensureProjectFiles, managesAllProjects,
  agentsMdFor, instructionsFromAgentsMd,
  MAX_NAME_CHARS, MAX_INSTRUCTIONS_CHARS, MAX_PROJECTS_PER_ACCOUNT, MAX_MEMBERS,
} from '../projects-storage.mjs'
import { getCapabilities } from '../tools-storage.mjs'
import { listAccounts as listAccountRecords } from '../accounts-storage.mjs'
import { listGroups } from '../groups-storage.mjs'
import { deleteProjectMemories } from '../memory-storage.mjs'
import { dropSuggestions } from '../memory-review-store.mjs'
import { detachProject } from '../conversations-storage.mjs'
import { sendJson, readJsonBody } from './http-json.mjs'
import { logEvent } from '../logger.mjs'

const ITEM = /^\/projects\/([A-Za-z0-9-]{1,64})$/
const AGENTS_MD = /^\/projects\/([A-Za-z0-9-]{1,64})\/agents-md$/
const MEMBERS = /^\/projects\/([A-Za-z0-9-]{1,64})\/members$/
const TRANSFER = /^\/projects\/([A-Za-z0-9-]{1,64})\/transfer$/
/** An AGENTS.md import's JSON body. The instructions limit applies after. */
const MAX_AGENTS_MD_BODY_BYTES = 256 * 1024

export function isProjectRoute(urlPath) {
  return urlPath === '/projects' || urlPath === '/directory' || ITEM.test(urlPath) || AGENTS_MD.test(urlPath) || MEMBERS.test(urlPath) || TRANSFER.test(urlPath)
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

// What the client sees: the record plus the file-explorer space of its files
// (plan D14), so the UI never builds a path itself, and the owner's name.
const nameOf = (key) => key === '_local' ? null : (listAccountRecords().find((a) => a.id === key)?.username ?? null)
function view(project) {
  return { ...project, folder: projectFolder(project), ownerName: nameOf(project.ownerKey) }
}

// The files folder, made when the project is. Best effort: with no Documents
// folder configured there is nowhere to put it, and a project without files is
// still a project. Never removed by us (plan D14).
function ensureFolder(project) {
  const root = getCapabilities().documents?.outputDir
  if (!root) return false
  try {
    ensureProjectFiles(root, project)
    return true
  } catch (err) {
    logEvent('project', 'folder_failed', { reason: err.message })
    return false
  }
}

function fail(res, r) {
  const status = r.code === 'not_found' ? 404 : r.code === 'conflict' ? 409 : r.code === 'forbidden' ? 403 : 400
  const type = r.code === 'not_found' ? 'not_found' : r.code === 'conflict' ? 'conflict' : r.code === 'forbidden' ? 'permission_error' : 'invalid_request_error'
  sendJson(res, status, { error: { message: r.error, type } })
}

export async function handleProjectRoute(req, res, urlPath, account) {
  try {
    if (urlPath === '/projects' && req.method === 'GET') {
      let all = false
      try { all = new URL(req.url ?? '/', 'http://x').searchParams.get('all') === '1' } catch { /* no query */ }
      if (all && !managesAllProjects(account)) {
        sendJson(res, 403, { error: { message: 'Your roles do not grant "manageProjects"', type: 'permission_error' } })
        return true
      }
      sendJson(res, 200, {
        projects: (all ? listAllProjects(account) : listProjects(account)).map(view),
        canManageAll: managesAllProjects(account),
        limits: {
          maxNameChars: MAX_NAME_CHARS,
          maxInstructionsChars: MAX_INSTRUCTIONS_CHARS,
          maxProjects: MAX_PROJECTS_PER_ACCOUNT,
          maxMembers: MAX_MEMBERS,
        },
      })
      return true
    }

    // Who a project can be shared with: names only. Any signed-in account may
    // ask, as in a document app's share box; with sign-in off there is nobody.
    if (urlPath === '/directory' && req.method === 'GET') {
      if (!account) { sendJson(res, 200, { accounts: [], groups: [] }); return true }
      sendJson(res, 200, {
        accounts: listAccountRecords().filter((a) => a.status !== 'disabled').map((a) => ({ id: a.id, username: a.username })),
        groups: listGroups().map((g) => ({ id: g.id, name: g.name, members: g.memberIds.length })),
      })
      return true
    }

    const members = MEMBERS.exec(urlPath)
    if (members && req.method === 'PUT') {
      const body = await readJsonBody(req)
      const r = setMembers(account, members[1], body?.members)
      if (!r.ok) { fail(res, r); return true }
      logEvent('project', 'shared', { account: account?.username ?? undefined, members: r.project.members.length })
      sendJson(res, 200, view(r.project))
      return true
    }
    if (members) return false

    const transfer = TRANSFER.exec(urlPath)
    if (transfer && req.method === 'POST') {
      const body = await readJsonBody(req)
      const r = transferProject(account, transfer[1], body?.accountId)
      if (!r.ok) { fail(res, r); return true }
      logEvent('project', 'transferred', { account: account?.username ?? undefined })
      sendJson(res, 200, view(r.project))
      return true
    }
    if (transfer) return false

    if (urlPath === '/projects' && req.method === 'POST') {
      const r = createProject(account, await readJsonBody(req))
      if (!r.ok) { fail(res, r); return true }
      const folderReady = ensureFolder(r.project)
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
      if (project) ensureFolder(project)
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
      if (!removed) {
        // 403 for someone who can see it but not delete it; 404 otherwise.
        sendJson(res, getProject(account, id) ? 403 : 404, getProject(account, id)
          ? { error: { message: 'Only the project\'s owner, or an admin, can delete it', type: 'permission_error' } }
          : NOT_FOUND)
        return true
      }
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
