// =============================================================================
// Redstart Nest — the control plane's front door
// =============================================================================
// Wraps the launcher for EVERY caller alike — a browser tab, and the
// Electron window itself (the IPC bridge that used to let Electron skip this
// is retired — "the Electron UI is a client of the daemon, like Twig").
// Nobody gets to App.tsx without a real session.
//
// Two screens, and which one appears is the daemon's answer to
// GET /admin/auth/config, never a guess:
//
//   SIGN IN     an owner exists. Username and password, nothing else.
//   SET UP      no owner exists yet. The box's bootstrap token, plus the
//               credential to create. The token is what stops the first
//               stranger to find the port from owning the box — see
//               daemon/bootstrap-token.mjs for why that route can
//               never be anonymous.
//
// The set-up screen is also the RECOVERY screen, because they are the same
// route: an admin who has lost the owner password reads the token off the box
// and re-keys it. Nothing else here needs to know that.
//
// THE ELECTRON TOKEN HANDOFF. index.mjs's createWindow() reads the box's
// token itself (it already has filesystem access) and appends it to the URL
// it loads — `?setupToken=...` — when no owner exists yet. Read once below,
// on mount, and immediately stripped from the address bar via
// history.replaceState so it does not linger in the location bar, a
// screenshot, or navigation history. A browser admin typing the setup
// screen's token field by hand gets exactly the same form either way.
//
// A NOTE ON WHAT THIS IS NOT. There is no "remember me" checkbox: the session
// is remembered, for twelve sliding hours, and a longer-lived persistent token
// is its own feature with its own storage decisions.
// =============================================================================

import { useEffect, useState } from 'react'
import { useWindowControlsOverlay } from '../hooks/useWindowControlsOverlay'
import type { RedstartAPI } from '../api/redstart'
import { setHttpAPI } from '../api/redstart'
import { createHttpAPI } from '../api/http'
import { getSessionToken, setSessionToken, clearSessionToken } from '../api/session'
import { btnCls, inputCls, TopBar, StatusPill } from './ui'

/** The setupToken query param, read once — see "THE ELECTRON TOKEN HANDOFF" above. */
function consumeSetupToken(): string {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('setupToken') ?? ''
  if (token) {
    params.delete('setupToken')
    const rest = params.toString()
    const clean = window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash
    window.history.replaceState(null, '', clean)
  }
  return token
}

type Phase = 'checking' | 'signin' | 'setup' | 'ready'

async function postJson(urlPath: string, body: unknown) {
  const res = await fetch(urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, body: json as Record<string, unknown> | null }
}

function Shell({ title, subtitle, status, children }: {
  title: string
  subtitle: string
  status: string
  children: React.ReactNode
}) {
  const overlay = useWindowControlsOverlay()

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 text-sm">
      {/* The same bar App.tsx renders, not a stand-in for it. This screen used
          to cover the whole window and lay an invisible drag strip over the top
          48px, so the strip that everywhere else reads "Redstart Nest" was
          simply absent until you signed in — the window buttons floated over a
          bare background with nothing beside them. Sharing the component also
          means the bar's h-12 (the window's title bar in the desktop shell)
          is stated in exactly one place.

          The right-hand slot is filled, but not with the server state: whether
          a model is running is not a claim to make to a caller who has not
          authenticated, and `server:status` will not answer one either. What
          goes there is something true of THIS screen — connecting, signed out,
          first run — so the bar keeps its shape without inventing a fact. */}
      <TopBar overlay={overlay} right={<StatusPill tone="off" label={status} />} />
      <div className="flex flex-1 items-center justify-center px-4 overflow-y-auto">
        <div className="w-full max-w-md py-8">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-7">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-50 mb-1.5">{title}</h1>
            <p className="text-sm text-zinc-400 mb-6 leading-relaxed">{subtitle}</p>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

export function AdminGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState(consumeSetupToken)

  // Install the HTTP transport before anything else can call api(). Done here
  // rather than at module load so the unauthorized callback can reach this
  // component's state — a 401 from any later call drops the whole app back to
  // the sign-in screen instead of leaving a dead UI behind.
  useEffect(() => {
    const impl: RedstartAPI = createHttpAPI({
      getToken: getSessionToken,
      onUnauthorized: () => {
        clearSessionToken()
        setPhase('signin')
        setError('Your session has ended. Sign in again.')
      },
    })
    setHttpAPI(impl)
  }, [])

  // Ask the daemon which screen this is, then whether the stored session is
  // still good. Both answers come from the daemon; neither is inferred from
  // what happens to be in localStorage.
  useEffect(() => {
    let stale = false

    void (async () => {
      try {
        const config = await fetch('/admin/auth/config').then(r => r.json())
        if (stale) return
        if (!config?.hasOwner) { setPhase('setup'); return }

        const stored = getSessionToken()
        if (!stored) { setPhase('signin'); return }

        const me = await fetch('/admin/auth/me', { headers: { Authorization: `Bearer ${stored}` } })
        if (stale) return
        if (me.ok) { setPhase('ready'); return }
        clearSessionToken()
        setPhase('signin')
      } catch {
        if (!stale) {
          setPhase('signin')
          setError('Could not reach Redstart Nest.')
        }
      }
    })()

    return () => { stale = true }
  }, [])

  if (phase === 'ready') return <>{children}</>

  if (phase === 'checking') {
    return <Shell title="Redstart Nest" subtitle="Connecting…" status="Connecting…"><div /></Shell>
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await postJson('/admin/auth/login', { username, password })
      if (!result.ok) {
        setError(String(result.body?.error ?? 'Sign in failed.'))
        return
      }
      setSessionToken(String(result.body?.token))
      setPassword('')
      setPhase('ready')
    } catch {
      setError('Could not reach Redstart Nest.')
    } finally {
      setBusy(false)
    }
  }

  async function setUp(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await postJson('/admin/bootstrap', { token, username, password })
      if (!result.ok) {
        setError(String(result.body?.error ?? 'Setup failed.'))
        return
      }
      // Straight into a session, so the person who just set the password does
      // not immediately have to type it again.
      const login = await postJson('/admin/auth/login', { username, password })
      if (!login.ok) {
        setError('The owner account was created. Sign in to continue.')
        setPhase('signin')
        return
      }
      setSessionToken(String(login.body?.token))
      setPassword('')
      setToken('')
      setPhase('ready')
    } catch {
      setError('Could not reach Redstart Nest.')
    } finally {
      setBusy(false)
    }
  }

  const fields = (
    <>
      <label className="flex flex-col gap-1.5 text-[13px] text-zinc-400">
        {phase === 'setup' ? 'Choose a username' : 'Username'}
        <input
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="owner"
          autoComplete="username"
          className={inputCls.sm}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-[13px] text-zinc-400">
        {phase === 'setup' ? 'Choose a password' : 'Password'}
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete={phase === 'setup' ? 'new-password' : 'current-password'}
          className={inputCls.sm}
        />
      </label>
    </>
  )

  if (phase === 'setup') {
    return (
      <Shell
        title="Set up this Nest"
        subtitle="Create the Owner account. It is the only account that can manage this panel; people who chat get their own accounts later, in the chat’s Settings."
        status="First run"
      >
        <form onSubmit={setUp} className="space-y-4">
          <label className="flex flex-col gap-1.5 text-[13px] text-zinc-400">
            Setup code
            <input
              value={token}
              onChange={e => setToken(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX"
              spellCheck={false}
              autoComplete="off"
              className={`${inputCls.sm} font-mono tracking-widest`}
            />
          </label>
          {fields}
          {error && <p role="alert" className="rounded-lg bg-red-950/60 px-3 py-2 text-[13px] text-red-300 leading-relaxed">{error}</p>}
          <button type="submit" disabled={busy || !token.trim() || !username.trim() || !password} className={btnCls.primaryBlock}>
            {busy ? 'Setting up…' : 'Create owner account'}
          </button>
          <p className="text-[13px] text-zinc-500 leading-relaxed">
            The setup code lives in Redstart Nest&rsquo;s data folder on the machine itself, in
            <span className="font-mono"> bootstrap-token.txt</span>. It is also how you recover this box if the
            owner password is ever lost.
          </p>
        </form>
      </Shell>
    )
  }

  return (
    <Shell title="Sign in to Nest" subtitle="Owner account only. Chat accounts can’t sign in here." status="Signed out">
      <form onSubmit={signIn} className="space-y-4">
        {fields}
        {error && <p role="alert" className="rounded-lg bg-red-950/60 px-3 py-2 text-[13px] text-red-300 leading-relaxed">{error}</p>}
        <button type="submit" disabled={busy || !username.trim() || !password} className={btnCls.primaryBlock}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </Shell>
  )
}
