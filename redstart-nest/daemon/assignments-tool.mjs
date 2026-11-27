'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: tasks people give each other (tasks plan Phase 2)
// =============================================================================
// Three tools over assignments-storage.mjs, capability id `assignments`:
//
//   assignment_list(...)    read   — the person's tasks, a project's, or the
//                                    ones they gave out
//   assignment_create(...)  write  — one or more tasks (up to 20 per call, so
//                                    "the action items from these notes" is
//                                    one approval, not twenty)
//   assignment_update(...)  write  — status, title, notes, due date, assignee
//
// People see these as "tasks". The model sees "assignment" because "task"
// already means the work in front of it in every prompt, and its own plan
// steps are update_plan's: a small model given task_create was expected to
// file its plan as the team's to-do list. Each description says so.
//
// THE MODEL CAN DO NO MORE THAN THE PERSON. Every call goes through the same
// functions as the /assignments routes, with the caller's account, so the
// access rules there (accessOf) decide everything. The project comes from the
// VERIFIED conversation, never from an argument, as memory_save's does.
//
// THE WRITES ASK FIRST. Both are write-class, so the person approves each call
// (or a standing grant covers it), whoever the task is for: approval is per
// tool, and giving someone work is not a thing to do unasked. Every change
// the assistant makes is marked in the task's history (via: 'assistant').
// =============================================================================

import * as store from './assignments-storage.mjs'
import { projectForCall } from './projects-storage.mjs'
import { logEvent } from './logger.mjs'

export const TOOL_NAMES = ['assignment_list', 'assignment_create', 'assignment_update']
export const MAX_CREATE = 20
export const MAX_LISTED = 25
const NOTES_PREVIEW = 200

const err = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const ok = (text) => ({ content: [{ type: 'text', text }] })

const ASSIGNEE_ARG = {
  type: 'string',
  description: 'Who does it: "me", a person\'s username, or a group\'s name. Leave it out for no one yet.',
}
const STATUS_ARG = { type: 'string', enum: store.STATUSES, description: '"open", "in_progress", "blocked" or "done".' }
const DUE_ARG = { type: 'string', description: 'Due date as YYYY-MM-DD.' }

export function toolDefs(cfg) {
  if (!cfg?.assignments?.enabled) return []
  return [
    {
      name: 'assignment_list',
      description:
        'List assignments: the team\'s tasks for people to do, as the user sees them on their task list. ' +
        '"mine" (default) is what the user or their groups have to do; "project" is this chat\'s project; "given" is what the user gave out with no project. ' +
        `Returns up to ${MAX_LISTED}, soonest due first, each with its id for assignment_update.`,
      inputSchema: {
        type: 'object',
        properties: {
          which: { type: 'string', enum: ['mine', 'project', 'given'], description: 'Whose list (default "mine").' },
          overdue: { type: 'boolean', description: 'Only ones past their due date.' },
          include_done: { type: 'boolean', description: 'Include finished ones.' },
          search: { type: 'string', description: 'Only ones whose title or notes contain this.' },
        },
      },
    },
    {
      name: 'assignment_create',
      description:
        'Add assignments to the team\'s task list: work for a person or group to do, which they see under My tasks. ' +
        'Use it when the user asks you to add, assign or track tasks, or to turn notes into action items. ' +
        'NOT for your own steps while you work: use update_plan for those. ' +
        `Send every task in one call (up to ${MAX_CREATE}). In a project chat they go in the project unless "in_project" is false. The user approves before anything is added.`,
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            maxItems: MAX_CREATE,
            description: 'The tasks, e.g. [{"title": "Book the interpreter", "assignee": "sam", "due": "2026-12-04"}].',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'What needs doing, as a short line.' },
                notes: { type: 'string', description: 'Details, if any.' },
                assignee: ASSIGNEE_ARG,
                due: DUE_ARG,
              },
              required: ['title'],
            },
          },
          in_project: { type: 'boolean', description: 'false to add them outside this chat\'s project.' },
        },
        required: ['items'],
      },
    },
    {
      name: 'assignment_update',
      description:
        'Change one assignment on the team\'s task list: mark it done or in progress, reword it, move its due date or give it to someone else. ' +
        'Get its id from assignment_list. Not for your own plan steps (update_plan). The user approves before it changes.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The assignment id, from assignment_list.' },
          status: STATUS_ARG,
          title: { type: 'string' },
          notes: { type: 'string' },
          due: { type: 'string', description: 'New due date as YYYY-MM-DD, or "none" to clear it.' },
          assignee: { type: 'string', description: 'Give it to "me", a username or a group name, or "none" for no one.' },
        },
        required: ['id'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Reading names the model writes
// ---------------------------------------------------------------------------

/**
 * "me", a username or a group name → { type, id }, among the people and
 * groups this task could go to (a project's members, or the directory).
 * Exact, case-insensitive; a name that is both a person and a group is
 * refused rather than guessed.
 */
function resolveAssignee(account, name, projectId) {
  if (name === undefined) return { ok: true, assignee: undefined }
  const n = String(name ?? '').trim()
  if (!n || /^(none|no one|nobody|null)$/i.test(n)) return { ok: true, assignee: null }
  if (!account) return { ok: false, error: 'With sign-in off there is nobody to give tasks to. Leave "assignee" out.' }
  if (/^(me|myself)$/i.test(n)) return { ok: true, assignee: { type: 'account', id: account.id } }
  const choices = store.listAssignees(account, projectId)
  if (!choices.ok) return { ok: false, error: 'That project is not available.' }
  const lower = n.replace(/^@/, '').toLowerCase()
  const people = choices.accounts.filter((a) => a.username.toLowerCase() === lower)
  const groups = choices.groups.filter((g) => g.name.toLowerCase() === lower)
  if (people.length + groups.length === 1) {
    return { ok: true, assignee: people.length ? { type: 'account', id: people[0].id } : { type: 'group', id: groups[0].id } }
  }
  if (people.length && groups.length) return { ok: false, error: `"${n}" is both a person and a group. Ask the user which.` }
  const names = [...choices.groups.map((g) => g.name), ...choices.accounts.map((a) => a.username)].slice(0, 30)
  const where = projectId ? 'in this project' : 'here'
  return { ok: false, error: `No person or group named "${n}" ${where}. Choose from: ${names.join(', ') || '(nobody)'}. Or ask the user.` }
}

function readDue(due) {
  if (due === undefined) return { ok: true, value: undefined }
  const d = String(due ?? '').trim()
  if (!d || /^(none|no date|null)$/i.test(d)) return { ok: true, value: null }
  if (!store.isDate(d)) return { ok: false, error: `"${due}" is not a date. Use YYYY-MM-DD.` }
  return { ok: true, value: d }
}

/** One line per task, what the model needs to talk about it and change it. */
function line(t) {
  const parts = [t.title, `id ${t.id}`, t.status.replace('_', ' ')]
  if (t.dueDate) parts.push(`due ${t.dueDate}`)
  if (t.assigneeName) parts.push(`${t.assignee?.type === 'group' ? 'group ' : ''}${t.assigneeName}`)
  else if (!t.assignee) parts.push('no one')
  if (t.projectName) parts.push(`project ${t.projectName}`)
  let out = `- ${parts.join(' · ')}`
  if (t.notes) out += `\n  ${t.notes.length > NOTES_PREVIEW ? `${t.notes.slice(0, NOTES_PREVIEW)}…` : t.notes}`.replace(/\n(?!  )/g, ' ')
  return out
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export async function callTool(name, args, cfg, ctx) {
  if (!TOOL_NAMES.includes(name)) return null
  if (!cfg?.assignments?.enabled) return err('Tasks are not enabled on this server.')
  const account = ctx?.account ?? null
  const project = projectForCall(account, ctx)

  try {
    if (name === 'assignment_list') {
      const which = args?.which ?? 'mine'
      const includeDone = args?.include_done === true
      let items
      if (which === 'project') {
        if (!project) return err('This chat is not in a project. Use which "mine" or "given".')
        const r = store.listForProject(account, project.id, { includeDone })
        if (!r.ok) return err('This chat\'s project is not available.')
        items = r.items
      } else if (which === 'given') {
        items = store.listCreated(account, { includeDone }).items
      } else if (which === 'mine') {
        items = store.listMine(account, { includeDone }).items
      } else {
        return err('which is "mine", "project" or "given".')
      }
      const today = store.serverToday()
      if (args?.overdue === true) items = items.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < today)
      const q = typeof args?.search === 'string' ? args.search.trim().toLowerCase() : ''
      if (q) items = items.filter((t) => `${t.title}\n${t.notes}`.toLowerCase().includes(q))
      if (items.length === 0) return ok(`No assignments match. (Today is ${today}.)`)
      const shown = items.slice(0, MAX_LISTED)
      const more = items.length > shown.length ? `\n(${items.length - shown.length} more not shown; narrow with "search" or "overdue".)` : ''
      return ok(`Today is ${today}. ${items.length} assignment${items.length === 1 ? '' : 's'}:\n${shown.map(line).join('\n')}${more}`)
    }

    if (name === 'assignment_create') {
      const list = Array.isArray(args?.items) ? args.items : null
      if (!list || list.length === 0) return err('Nothing added: send "items", a list of tasks, each with a "title".')
      if (list.length > MAX_CREATE) return err(`Nothing added: at most ${MAX_CREATE} per call. Send the rest in another call.`)
      const projectId = args?.in_project === false ? null : project?.id ?? null
      // Check every item before adding any, so a bad name in item 7 does not
      // leave six added and the model unsure which.
      const bodies = []
      for (const [i, it] of list.entries()) {
        const who = resolveAssignee(account, it?.assignee, projectId)
        if (!who.ok) return err(`Nothing added: item ${i + 1}: ${who.error}`)
        const due = readDue(it?.due)
        if (!due.ok) return err(`Nothing added: item ${i + 1}: ${due.error}`)
        const body = { title: it?.title, projectId }
        if (typeof it?.notes === 'string') body.notes = it.notes
        if (who.assignee !== undefined) body.assignee = who.assignee
        if (due.value !== undefined) body.dueDate = due.value
        const v = store.validateAssignment(body)
        if (!v.ok) return err(`Nothing added: item ${i + 1}: ${v.error}`)
        bodies.push(body)
      }
      const made = []
      for (const body of bodies) {
        const r = store.createAssignment(account, body, { via: 'assistant' })
        if (!r.ok) {
          const done = made.length ? ` ${made.length} were added before it:\n${made.map(line).join('\n')}` : ''
          return err(`Stopped at "${body.title}": ${r.error}.${done}`)
        }
        made.push(r.item)
      }
      logEvent('assignment', 'created_by_assistant', { count: made.length, project: !!projectId })
      const where = projectId ? ` in the project "${project.name}"` : ''
      return ok(`Added ${made.length} task${made.length === 1 ? '' : 's'}${where}. The user sees them under My tasks.\n${made.map(line).join('\n')}`)
    }

    if (name === 'assignment_update') {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      const found = store.getAssignment(account, id)
      if (!found.ok) return err('No assignment with that id. Use assignment_list to find it.')
      const body = {}
      for (const k of ['status', 'title', 'notes']) if (args?.[k] !== undefined) body[k] = args[k]
      const due = readDue(args?.due)
      if (!due.ok) return err(`Not changed: ${due.error}`)
      if (due.value !== undefined) body.dueDate = due.value
      const who = resolveAssignee(account, args?.assignee, found.item.projectId)
      if (!who.ok) return err(`Not changed: ${who.error}`)
      if (who.assignee !== undefined) body.assignee = who.assignee
      if (Object.keys(body).length === 0) return err('Nothing to change: send status, title, notes, due or assignee.')
      const r = store.updateAssignment(account, id, body, { via: 'assistant' })
      if (!r.ok) return err(`Not changed: ${r.error}`)
      logEvent('assignment', 'updated_by_assistant', { fields: Object.keys(body).join(',') })
      return ok(`Updated.\n${line(r.item)}`)
    }
  } catch (e) {
    return err(`That did not work: ${e?.message ?? e}`)
  }
  return null
}
