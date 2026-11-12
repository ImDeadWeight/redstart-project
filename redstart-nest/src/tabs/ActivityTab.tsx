// Activity tab — background tasks, what approval policy decided, and who
// always allows what (agent-runtime plan Phase 2, D13/D14; Phase 3).
//
//   Background tasks — every account's tasks (daemon/ipc/tasks.mjs): state
//                   and owner only, and Cancel.
//   Decision log  — logger.mjs logPolicy() lines, newest first: a denial (on
//                   the chat app's card or sent by a client), an approval
//                   presented for the wrong call, a standing grant added or
//                   revoked. It never holds arguments, paths or summaries, so
//                   neither does this view.
//   Standing grants — one account's "Always allow" list, looked up by
//                   username, each revocable (logged with by: owner).
//
// Read-mostly by design: the only change made here is revoking a grant. An
// account's own grants are also in its chat Settings → Tools.

import { useEffect, useState } from 'react'
import { api } from '../api/redstart'
import type { PolicyRecord, StandingGrant, TaskSummary } from '../api/redstart'
import { SectionTitle, btnCls, inputCls } from '../components/ui'

const PAGE = 50

const EVENT_LABEL: Record<PolicyRecord['event'], string> = {
  'approval.denied': 'Denied',
  'approval.refused': 'Approval refused',
  'grant.added': 'Always allow on',
  'grant.revoked': 'Always allow off',
}

const EVENT_TONE: Record<PolicyRecord['event'], string> = {
  'approval.denied': 'text-amber-400',
  'approval.refused': 'text-red-400',
  'grant.added': 'text-green-400',
  'grant.revoked': 'text-zinc-400',
}

function when(t: string): string {
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? t : d.toLocaleString()
}

/** The small print after the tool: how it happened, and who did it. */
function detail(r: PolicyRecord): string {
  const bits: string[] = []
  if (r.event === 'approval.denied' && r.source === 'card') bits.push('on the approval card')
  if (r.event === 'approval.refused') bits.push('an approval for a different call, or expired')
  if (r.event === 'grant.added' && r.source === 'import') bits.push('imported from the browser')
  if (r.by && r.by !== r.account) bits.push(`by ${r.by}`)
  return bits.join(' · ')
}

const TASK_LABEL: Record<TaskSummary['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_user: 'Waiting for an answer',
  waiting_approval: 'Waiting for approval',
  waiting_model: 'Waiting for a model',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const TASK_TONE: Record<TaskSummary['status'], string> = {
  queued: 'text-zinc-300',
  running: 'text-sky-400',
  waiting_user: 'text-amber-400',
  waiting_approval: 'text-amber-400',
  waiting_model: 'text-amber-400',
  done: 'text-green-400',
  failed: 'text-red-400',
  cancelled: 'text-zinc-500',
}

const LIVE = new Set<TaskSummary['status']>(['queued', 'running', 'waiting_user', 'waiting_approval', 'waiting_model'])

/**
 * Background tasks (agent-runtime Phase 3): what is running for whom, and a
 * way to stop one. The record only: never the conversation, the question or
 * what an approval is for, which are the account's own.
 */
function TasksSection() {
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setTasks((await api().tasks.list()).tasks)
    } catch {
      setError('Could not read the task list.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function cancel(t: TaskSummary) {
    setCancelling(t.id)
    try {
      const r = await api().tasks.cancel(t.id)
      if (!r.ok) setError(r.error)
      // The run stops at its next step; give it a moment before re-reading.
      setTimeout(() => void load(), 500)
    } finally {
      setCancelling(null)
    }
  }

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <SectionTitle className="">Background tasks</SectionTitle>
        <button className={btnCls.subtle} onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>
      <p className="text-xs text-zinc-500 mb-3">
        Chats running in the background on this server, newest first. The list shows who and in what state, never
        what the chat is about. Cancelling keeps what the task wrote so far.
      </p>

      {error && <div className="text-xs text-red-400 mb-2">{error}</div>}

      {!error && tasks.length === 0 && !loading && (
        <div className="text-xs text-zinc-500 italic">No background tasks.</div>
      )}

      {tasks.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-zinc-500">
              <th className="font-normal py-1 pr-3">Started</th>
              <th className="font-normal py-1 pr-3">Account</th>
              <th className="font-normal py-1 pr-3">State</th>
              <th className="font-normal py-1 pr-3">Details</th>
              <th className="font-normal py-1" />
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className="border-t border-zinc-800 align-top">
                <td className="py-1.5 pr-3 text-zinc-400 whitespace-nowrap">{new Date(t.createdAt).toLocaleString()}</td>
                <td className="py-1.5 pr-3 text-zinc-300">{t.account ?? '(login off)'}</td>
                <td className={`py-1.5 pr-3 whitespace-nowrap ${TASK_TONE[t.status] ?? 'text-zinc-300'}`}>
                  {TASK_LABEL[t.status] ?? t.status}
                </td>
                <td className="py-1.5 pr-3 text-zinc-500">
                  {t.tool ? <span className="font-mono text-zinc-300">{t.tool}</span> : null}
                  {t.error ? <span>{t.error}</span> : null}
                </td>
                <td className="py-1.5 text-right">
                  {LIVE.has(t.status) && (
                    <button className={btnCls.subtle} disabled={cancelling === t.id} onClick={() => void cancel(t)}>
                      {cancelling === t.id ? 'Cancelling…' : 'Cancel'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function ActivityTab() {
  const [records, setRecords] = useState<PolicyRecord[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [username, setUsername] = useState('')
  const [lookedUp, setLookedUp] = useState<string | null>(null)
  const [grants, setGrants] = useState<StandingGrant[] | null>(null)
  const [grantError, setGrantError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  async function load(before?: string) {
    setLoading(true)
    setError(null)
    try {
      const page = await api().audit.list({ limit: PAGE, before })
      setRecords((prev) => (before ? [...prev, ...page.records] : page.records))
      setMore(page.more)
    } catch {
      setError('Could not read the decision log.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function lookUp() {
    const name = username.trim()
    setGrantError(null)
    setGrants(null)
    const r = await api().approvals.listGrants(name || null).catch(() => ({ ok: false as const, error: 'request failed' }))
    if (!r.ok) {
      setGrantError(r.error === 'no such account' ? `No account called "${name}".` : 'Could not list the grants.')
      return
    }
    setLookedUp(name || null)
    setGrants(r.grants)
  }

  async function revoke(g: StandingGrant) {
    setRevoking(g.id)
    try {
      const r = await api().approvals.revokeGrant(g.id)
      if (r.ok) {
        setGrants((prev) => (prev ?? []).filter((x) => x.id !== g.id))
        void load()
      } else {
        setGrantError('That grant was already gone.')
      }
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <TasksSection />

      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <SectionTitle className="">Decision log</SectionTitle>
          <button className={btnCls.subtle} onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-3">
          What approval policy decided: denials, approvals presented for the wrong call, and "Always allow"
          turned on or off. It records the account, the tool and the decision, never what the call was about.
        </p>

        {error && <div className="text-xs text-red-400 mb-2">{error}</div>}

        {!error && records.length === 0 && !loading && (
          <div className="text-xs text-zinc-500 italic">Nothing recorded yet.</div>
        )}

        {records.length > 0 && (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="font-normal py-1 pr-3">When</th>
                <th className="font-normal py-1 pr-3">What</th>
                <th className="font-normal py-1 pr-3">Account</th>
                <th className="font-normal py-1 pr-3">Tool</th>
                <th className="font-normal py-1">Details</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={`${r.t}-${i}`} className="border-t border-zinc-800 align-top">
                  <td className="py-1.5 pr-3 text-zinc-400 whitespace-nowrap">{when(r.t)}</td>
                  <td className={`py-1.5 pr-3 whitespace-nowrap ${EVENT_TONE[r.event] ?? 'text-zinc-300'}`}>
                    {EVENT_LABEL[r.event] ?? r.event}
                  </td>
                  <td className="py-1.5 pr-3 text-zinc-300">{r.account ?? '—'}</td>
                  <td className="py-1.5 pr-3 font-mono text-zinc-200">{r.tool ?? '—'}</td>
                  <td className="py-1.5 text-zinc-500">{detail(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {more && (
          <button
            className={`${btnCls.secondary} mt-3`}
            disabled={loading}
            onClick={() => void load(records.at(-1)?.t)}>
            {loading ? 'Loading…' : 'Load older'}
          </button>
        )}
      </section>

      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <SectionTitle>Standing grants</SectionTitle>
        <p className="text-xs text-zinc-500 mb-3">
          The tools an account runs without the approval card ("Always allow"). Deletes and memory removals can
          never be on this list. Leave the name empty to see the shared list used while login is off.
        </p>
        <div className="flex gap-2 mb-3">
          <input
            className={inputCls.sm}
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void lookUp()}
          />
          <button className={btnCls.secondary} onClick={() => void lookUp()}>
            Show
          </button>
        </div>

        {grantError && <div className="text-xs text-red-400 mb-2">{grantError}</div>}

        {grants && grants.length === 0 && (
          <div className="text-xs text-zinc-500 italic">
            {lookedUp ? `${lookedUp} always allows nothing.` : 'The shared list is empty.'}
          </div>
        )}

        {grants && grants.length > 0 && (
          <ul className="flex flex-col gap-1">
            {grants.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-1.5">
                <span className="font-mono text-xs text-zinc-200">{g.tool}</span>
                <span className="text-xs text-zinc-500 flex-1">
                  since {new Date(g.createdAt).toLocaleDateString()}
                  {g.source === 'import' ? ' · imported from the browser' : ''}
                </span>
                <button className={btnCls.subtle} disabled={revoking === g.id} onClick={() => void revoke(g)}>
                  {revoking === g.id ? 'Revoking…' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
