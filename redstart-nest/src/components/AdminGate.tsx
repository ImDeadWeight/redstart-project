// =============================================================================
// Redstart Nest — the control plane's front door
// =============================================================================
// Wraps the launcher for EVERY caller alike — a browser tab, and the
// Electron window itself (Phase 6 §6.2 retired the IPC bridge that used to
// let Electron skip this; see decision 6, "the Electron UI is a client of
// the daemon, like Twig"). Nobody gets to App.tsx without a real session.
//
// Two screens, and which one appears is the daemon's answer to
// GET /admin/auth/config, never a guess:
//
//   SIGN IN     an owner exists. Username and password, nothing else.
//   SET UP      no owner exists yet. The box's bootstrap token, plus the
//               credential to create. The token is what stops the first
//               stranger to find the port from owning the box — see
//               electron/main/bootstrap-token.mjs for why that route can
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
// is its own feature with its own storage decisions (plan decision 11).
// =============================================================================

import { useEffect, useState } from 'react'
import { useWindowControlsOverlay, DRAG_REGION } from '../hooks/useWindowControlsOverlay'
import type { RedstartAPI } from '../api/redstart'
import { setHttpAPI } from '../api/redstart'
import { createHttpAPI } from '../api/http'
import { getSessionToken, setSessionToken, clearSessionToken } from '../api/session'
import { btnCls, inputCls } from './ui'

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

function Shell({ title, subtitle, children }: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  const overlay = useWindowControlsOverlay()

  return (
    <div className="flex items-center justify-center h-screen bg-zinc-950 text-white font-mono text-sm px-4">
      {/* The sign-in and first-run screens are a different tree from App.tsx
          and have no header, so without this the Electron window could not be
          MOVED until after signing in — the native title bar is hidden and
          nothing else here is draggable. Fixed rather than in the flow so it
          costs no layout: the card below is vertically centred and never
          reaches the top edge. Inert in a browser, where the hook is
          inactive. */}
      {overlay.active && (
        <div className="fixed top-0 left-0 right-0 h-12 z-50" style={DRAG_REGION} />
      )}
      <div className="w-full max-w-sm">
        <h1 className="text-lg font-bold tracking-wide mb-1">
          <span className="text-orange-500">Redstart Nest</span>
        </h1>
        <p className="text-xs uppercase tracking-widest text-zinc-500 mb-1">{title}</p>
        <p className="text-xs text-zinc-500 mb-5 leading-relaxed">{subtitle}</p>
        {children}
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
    return <Shell title="Control plane" subtitle="Connecting…"><div /></Shell>
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
      <input
        value={username}
        onChange={e => setUsername(e.target.value)}
        placeholder="Owner username"
        autoComplete="username"
        className={inputCls.sm}
      />
      <input
        type="password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder="Owner password"
        autoComplete={phase === 'setup' ? 'new-password' : 'current-password'}
        className={inputCls.sm}
      />
    </>
  )

  if (phase === 'setup') {
    return (
      <Shell
        title="Set up this box"
        subtitle="No owner account exists yet. Enter the setup code printed on this machine, then choose the credential you will sign in with."
      >
        <form onSubmit={setUp} className="space-y-2">
          <input
            value={token}
            onChange={e => setToken(e.target.value.toUpperCase())}
            placeholder="Setup code"
            spellCheck={false}
            className={`${inputCls.sm} tracking-widest`}
          />
          {fields}
          {error && <p className="text-xs text-red-400 leading-relaxed">{error}</p>}
          <button type="submit" disabled={busy || !token.trim() || !username.trim() || !password} className={btnCls.primaryBlock}>
            {busy ? 'Setting up…' : 'Create owner account'}
          </button>
          <p className="text-[11px] text-zinc-600 leading-relaxed pt-1">
            The setup code lives in Redstart Nest&rsquo;s data folder on the machine itself, in
            <span className="font-mono"> bootstrap-token.txt</span>. It is also how you recover this box if the
            owner password is ever lost.
          </p>
        </form>
      </Shell>
    )
  }

  return (
    <Shell title="Sign in" subtitle="This is the Redstart Nest control plane. Only the owner account can sign in here.">
      <form onSubmit={signIn} className="space-y-2">
        {fields}
        {error && <p className="text-xs text-red-400 leading-relaxed">{error}</p>}
        <button type="submit" disabled={busy || !username.trim() || !password} className={btnCls.primaryBlock}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </Shell>
  )
}
