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
// EVENTS, OVER ONE SHARED SSE CONNECTION (Phase 5 §5.3-5.5). Not the browser's
// native EventSource — it cannot attach an Authorization header, and this
// listener sends no cookie for it to ride on instead. `fetch()` plus a
// ReadableStream reader gets the same server-sent-events framing back while
// still carrying the bearer token every other call uses. One connection is
// opened lazily on the first `on*` subscription and demultiplexed by channel,
// mirroring what `ipcRenderer.on`/`off` already were: a single event firehose
// per channel with one live callback at a time. See admin/events-routes.mjs
// for the wire format.
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

// preload/index.mjs's `on<Event>` method name -> the broker channel it
// subscribes to (event-broker.mjs / ipc/server.mjs, models.mjs, plugins.mjs).
// Not the namespace.method -> channel RULE above — these never went through
// a channel-per-method IPC binding, they were always ipcRenderer.on(literal).
const EVENT_CHANNELS: Record<string, string> = {
  onTokensPerMinute: 'server:tpm',
  onServerLog: 'server:log',
  onServerStopped: 'server:stopped',
  onServerStarted: 'server:started',
  onModelDownloadProgress: 'models:download-progress',
  onPluginInstallProgress: 'plugins:install-progress',
}

type SseMessage =
  | { type: 'replay'; channel: string; lines: string[] }
  | { type: 'event'; channel: string; payload: unknown }

/**
 * One shared SSE connection, demultiplexed by channel. `on(method, cb)`
 * registers the single live callback for that method's channel (replacing
 * any previous one, matching ipcRenderer.on's own replace-not-stack
 * semantics) and opens the connection if it is not already open; `off`
 * clears the callback. The connection itself is never torn down once opened
 * — cheap to hold for the page's lifetime, and simpler than reference-
 * counting subscribers across every hook that might (un)mount.
 */
function createEventStream(options: HttpApiOptions, base: string) {
  const callbacks = new Map<string, (payload: unknown) => void>()
  let connecting = false

  function dispatch(channel: string, payload: unknown) {
    callbacks.get(channel)?.(payload)
  }

  async function connectOnce(): Promise<'stop' | 'retry'> {
    const token = options.getToken()
    const res = await fetch(`${base}/admin/events`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (res.status === 401) {
      options.onUnauthorized?.()
      return 'stop'
    }
    if (!res.ok || !res.body) return 'retry'

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        const dataLine = frame.split('\n').find(l => l.startsWith('data: '))
        if (!dataLine) continue // a keep-alive comment (": ...") or blank frame
        let msg: SseMessage
        try { msg = JSON.parse(dataLine.slice('data: '.length)) } catch { continue }
        if (msg.type === 'replay') {
          for (const line of msg.lines) dispatch(msg.channel, line)
        } else if (msg.type === 'event') {
          dispatch(msg.channel, msg.payload)
        }
      }
    }
    return 'retry' // the daemon closed the stream (restart, network blip) — reconnect
  }

  async function run() {
    for (;;) {
      let outcome: 'stop' | 'retry' = 'retry'
      try {
        outcome = await connectOnce()
      } catch {
        // network error / aborted fetch — fall through to the retry delay
      }
      if (outcome === 'stop') return
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }

  function ensureConnected() {
    if (connecting) return
    connecting = true
    run() // never resolves under normal operation; errors are swallowed above
  }

  return {
    on(method: string, cb: (payload: unknown) => void) {
      const channel = EVENT_CHANNELS[method]
      if (!channel) return
      callbacks.set(channel, cb)
      ensureConnected()
    },
    off(offMethod: string) {
      const onMethod = `on${offMethod.slice('off'.length)}`
      const channel = EVENT_CHANNELS[onMethod]
      if (channel) callbacks.delete(channel)
    },
  }
}

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

  const eventStream = createEventStream(options, base)
  namespaces[EVENT_NAMESPACE] = new Proxy({}, {
    get(_target, method) {
      if (typeof method !== 'string') return undefined
      if (method.startsWith('on')) return (cb: (payload: unknown) => void) => eventStream.on(method, cb)
      if (method.startsWith('off')) return () => eventStream.off(method)
      return undefined
    },
  })

  return namespaces as unknown as RedstartAPI
}
