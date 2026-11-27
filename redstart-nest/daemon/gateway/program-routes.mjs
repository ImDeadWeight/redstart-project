'use strict'

// =============================================================================
// Redstart Nest — Gateway /programs routes (tasks plan Phase 4)
// =============================================================================
// Groups of projects (programs-storage.mjs). A program gives no access: its
// page lists only the projects in it the caller can already open.
//
//   GET    /programs                    the caller's programs
//   POST   /programs                    { name, description? }
//   GET    /programs/:id
//   PUT    /programs/:id                { name?, description? }       editors and up
//   DELETE /programs/:id                                              owner, admin
//   PUT    /programs/:id/members        { members: [{ type, id, role }] } owner, admin
//   PUT    /programs/:id/projects       { projectIds }   adding one needs managing it too
//
// The combined task list is /assignments?programId= (assignment-routes.mjs).
// A program the caller cannot open is 404; one they can open but not change, 403.
// =============================================================================

import {
  listPrograms, getProgram, createProgram, updateProgram, deleteProgram, setProgramMembers, setProgramProjects,
  MAX_NAME_CHARS, MAX_DESCRIPTION_CHARS, MAX_PROGRAMS_PER_ACCOUNT, MAX_PROJECTS_PER_PROGRAM,
} from '../programs-storage.mjs'
import { sendJson, readJsonBody } from './http-json.mjs'
import { logEvent } from '../logger.mjs'

const ITEM = /^\/programs\/([0-9a-f-]{36})$/
const SUB = /^\/programs\/([0-9a-f-]{36})\/(members|projects)$/

export function isProgramRoute(urlPath) {
  return urlPath === '/programs' || ITEM.test(urlPath) || SUB.test(urlPath)
}

function fail(res, r) {
  const status = r.code === 'not_found' ? 404 : r.code === 'conflict' ? 409 : r.code === 'forbidden' ? 403 : 400
  const type = r.code === 'not_found' ? 'not_found' : r.code === 'forbidden' ? 'permission_error' : 'invalid_request_error'
  sendJson(res, status, { error: { message: r.code === 'not_found' ? 'Not found' : r.error, type } })
}

const LIMITS = Object.freeze({ maxNameChars: MAX_NAME_CHARS, maxDescriptionChars: MAX_DESCRIPTION_CHARS, maxPrograms: MAX_PROGRAMS_PER_ACCOUNT, maxProjects: MAX_PROJECTS_PER_PROGRAM })
const who = (account) => account?.username ?? undefined

export async function handleProgramRoute(req, res, urlPath, account) {
  try {
    if (urlPath === '/programs') {
      if (req.method === 'GET') { sendJson(res, 200, { programs: listPrograms(account), limits: LIMITS }); return true }
      if (req.method === 'POST') {
        const r = createProgram(account, await readJsonBody(req))
        if (!r.ok) { fail(res, r); return true }
        logEvent('program', 'created', { account: who(account) })
        sendJson(res, 201, r.program)
        return true
      }
      return false
    }
    const sub = SUB.exec(urlPath)
    if (sub) {
      if (req.method !== 'PUT') return false
      const body = await readJsonBody(req)
      const r = sub[2] === 'members' ? setProgramMembers(account, sub[1], body?.members) : setProgramProjects(account, sub[1], body?.projectIds)
      if (!r.ok) { fail(res, r); return true }
      logEvent('program', sub[2] === 'members' ? 'shared' : 'projects_set', { account: who(account) })
      sendJson(res, 200, r.program)
      return true
    }
    const item = ITEM.exec(urlPath)
    if (!item) return false
    if (req.method === 'GET') {
      const r = getProgram(account, item[1])
      if (!r.ok) { fail(res, r); return true }
      sendJson(res, 200, r.program)
      return true
    }
    if (req.method === 'PUT') {
      const r = updateProgram(account, item[1], await readJsonBody(req))
      if (!r.ok) { fail(res, r); return true }
      sendJson(res, 200, r.program)
      return true
    }
    if (req.method === 'DELETE') {
      const r = deleteProgram(account, item[1])
      if (!r.ok) { fail(res, r); return true }
      logEvent('program', 'deleted', { account: who(account) })
      sendJson(res, 200, { deleted: true })
      return true
    }
    return false
  } catch (err) {
    sendJson(res, 500, { error: { message: err.message, type: 'internal_error' } })
    return true
  }
}
