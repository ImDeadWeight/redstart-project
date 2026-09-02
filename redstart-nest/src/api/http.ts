// =============================================================================
// Redstart Nest — RedstartAPI over HTTP
// =============================================================================
// The second implementation of the same type the preload bridge satisfies. The
// launcher's components do not know which one they are holding, and that is the
// point: the design already had zero Electron references across the renderer, so
// swapping the transport is a change to this directory and nowhere else.
//
// WHY A PROXY RATHER THAN 74 HAND-WRITTEN METHODS. The channel behind every
// bridge method is mechanically `namespace:kebab-case(method)` —
// `settings.getBinaryPath` is `settings:get-binary-path`, all 74 of them. Writing
// them out again would be 74 more places for a typo that typecheck cannot see,
// which is the exact failure test-ipc-contract.mjs exists because of. So the
// rule is implemented once here, with its exceptions written down beside it, and
// scripts/test-admin-api.mjs asserts the two together reproduce every channel
// the preload actually invokes. A future channel that breaks the rule fails that
// test by name rather than 404ing in a browser six months later — which is how
// the one exception below was found.
//
// EVENTS ARE NO-OPS, DELIBERATELY AND VISIBLY. The four event streams are a
// window push (`webContents.send`) with no HTTP equivalent until Phase 5 builds
// the broker. A remote admin therefore sees no live log lines, no tokens/minute
// and no download progress — the operations still work, they just report only
// when they finish. Subscribing throws nothing and silently does nothing, which
// is the only shape that keeps the components transport-blind; the gap is named
// here and in the plan rather than papered over with a fake stream.
// =============================================================================

import type { RedstartAPI } from './redstart'

/** `getBinaryPath` -> `get-binary-path`. The whole channel-naming rule. */
export function kebab(method: string): string {
  return method.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)
}

// THE EXCEPTIONS, ALL OF THEM. One binding does not follow the rule, because the
// bridge groups it by which TAB shows it while the handler lives with the state
// it reads. Written down rather than smoothed over: 73 of 74 following a rule is
// what makes the Proxy worth having, and the 74th is what makes a silent 404 in
// a browser possible. scripts/test-admin-api.mjs checks this map plus the rule
// reproduces the preload exactly, so an exception added later fails a test
// instead of one method.
const CHANNEL_OVERRIDES: Record<string, string> = {
  // Shown on the Capabilities tab; counts the tool list, which tools owns.
  'capabilities:estimate-tool-context': 'tools:estimate-context',
}

export function channelFor(namespace: string, method: string): string {
  const derived = `${namespace}:${kebab(method)}`
  return CHANNEL_OVERRIDES[derived] ?? derived
}

export function pathFor(channel: string): string {
  return `/admin/api/${channel.replace(':', '/')}`
}

/** Thrown for a route that only the local launcher can serve (a native picker). */
export class LocalOnlyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalOnlyError'
  }
}

export type HttpApiOptions = {
  /** Origin to talk to. Defaults to wherever this page was served from. */
  baseUrl?: string
  /** Read the current session token. Read per call, never captured. */
  getToken: () => string | null
  /** Called when the daemon rejects the session, so the shell can re-show login. */
  onUnauthorized?: () => void
}

const EVENT_NAMESPACE = 'events'

const NAMESPACES = [
  'hardware', 'llama', 'server', 'profiles', 'tools', 'mcp',
  'capabilities', 'settings', 'models', 'github', 'auth', 'admin', 'plugins',
  'browse',
] as const

export function createHttpAPI(options: HttpApiOptions): RedstartAPI {
  const base = options.baseUrl ?? window.location.origin

  async function call(channel: string, args: unknown[]): Promise<unknown> {
    const token = options.getToken()
    const res = await fetch(`${base}${pathFor(channel)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ args }),
    })

    if (res.status === 401) {
      // The session is gone — expired, revoked, or the daemon restarted with a
      // different account. Tell the shell once and then throw; a caller that
      // retried on its own would loop.
      options.onUnauthorized?.()
      throw new Error('Your session has ended. Sign in again.')
    }

    const body = await res.json().catch(() => null) as { result?: unknown; error?: string } | null

    if (res.status === 501) throw new LocalOnlyError(body?.error ?? 'Not available remotely')
    if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)

    return body?.result ?? null
  }

  const namespaces: Record<string, unknown> = {}

  for (const namespace of NAMESPACES) {
    namespaces[namespace] = new Proxy({}, {
      get(_target, method) {
        // Symbols and the odd `then` probe (anything that awaits the namespace
        // object itself) must not turn into a request for a channel named
        // `hardware:then`.
        if (typeof method !== 'string') return undefined
        return (...args: unknown[]) => call(channelFor(namespace, method), args)
      },
    })
  }

  // See the module header: nothing to subscribe to until Phase 5's broker.
  namespaces[EVENT_NAMESPACE] = new Proxy({}, {
    get(_target, method) {
      if (typeof method !== 'string') return undefined
      return () => undefined
    },
  })

  return namespaces as unknown as RedstartAPI
}
