import { useEffect, useRef, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { LlamaConfig, ServerState } from '../types'

// The llama-server process lifecycle as seen from the renderer: launch/stop,
// health polling, the tok/min meter, and the log buffer. Owns every event
// subscription to the main process (server:log / server:stopped / server:tpm).
export function useServerLifecycle(opts: {
  config: LlamaConfig
  showStatus: (msg: string, ttlMs?: number) => void
  clearStatus: () => void
  onLaunchStarted?: () => void
  selectedProfile?: string
}) {
  const { config, showStatus, clearStatus, onLaunchStarted, selectedProfile } = opts

  const [serverState, setServerState] = useState<ServerState>('stopped')
  const [health, setHealth] = useState<string | null>(null)
  const [tokensPerMin, setTokensPerMin] = useState<number>(0)
  const [logLines, setLogLines] = useState<string[]>([])
  const [confirmStop, setConfirmStop] = useState(false)
  // Which profile NAME actually launched the running server — captured once
  // at launch, deliberately NOT kept in sync with selectedProfile afterward.
  // The admin can switch the profile selector to a different profile while
  // this one keeps running (nothing in the UI stops them); comparing this
  // against the live selectedProfile is what tells syncToolsIfLive() whether
  // config.tools still describes the server that's actually up, or describes
  // some other profile the admin has since switched to editing.
  const [runningProfileName, setRunningProfileName] = useState<string | null>(null)

  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const configRef = useRef(config)
  const isUserStopRef = useRef(false)

  // Keep configRef current so the status poll always uses the latest config
  useEffect(() => { configRef.current = config }, [config])

  // I poll the server health every 3 seconds rather than relying on an event
  // because llama-server doesn't push status updates — I have to ask. The
  // configRef pattern is needed because setInterval closes over the initial
  // config value; without the ref, the poll would always use stale config.
  function startStatusPoll() {
    stopStatusPoll()
    statusPollRef.current = setInterval(async () => {
      const s = await api().server.status(configRef.current)
      setHealth(s.health)
    }, 3000)
  }

  function stopStatusPoll() {
    if (statusPollRef.current) { clearInterval(statusPollRef.current); statusPollRef.current = null }
  }

  useEffect(() => {
    const a = getAPI()
    if (!a) return

    // Seed real state on mount instead of assuming 'stopped' — covers a
    // client that opens AFTER another client already launched the server.
    // onServerStarted (below) covers the other half: a client that was
    // already open when a DIFFERENT client launches it live. Without both,
    // only the client that actually clicked Launch ever learns the server
    // is running — everyone else's Stop button never appears and the
    // top-bar status sits on "Stopped" over a live log replay that says
    // otherwise.
    let cancelled = false
    api().admin.getStatus().then(s => {
      if (cancelled || !s.running) return
      setServerState('running')
      setHealth('starting')
      startStatusPoll()
    }).catch(() => { /* daemon unreachable — leave as 'stopped', the poll will surface it once running */ })

    a.events.onTokensPerMinute(setTokensPerMin)
    // Subscribed for the component's whole lifetime, not just from
    // launchServer() onward — a reconnecting SSE client
    // replays the daemon's ring buffer on connect, so an admin who opens
    // this tab while the server is already running (or just crashed) sees
    // that history immediately rather than an empty terminal that only
    // starts filling in from the next line they personally launch.
    a.events.onServerLog(line => {
      if (line.trim()) setLogLines(prev => [...prev.slice(-1000), line])
    })
    // Fires for every client on a successful launch, including the one that
    // triggered it (launchServer() below sets this state locally too, so
    // this is a harmless redundant set in that case) — this is what lets an
    // already-open second client pick up a launch triggered elsewhere
    // without waiting for a remount.
    a.events.onServerStarted(() => {
      setServerState('running')
      setHealth('starting')
      startStatusPoll()
    })
    a.events.onServerStopped(() => {
      setServerState('stopped')
      setHealth(null)
      setTokensPerMin(0)
      setConfirmStop(false)
      setRunningProfileName(null)
      stopStatusPoll()
      if (isUserStopRef.current) {
        isUserStopRef.current = false
        showStatus('Server stopped.')
      }
    })

    return () => {
      cancelled = true
      a.events.offTokensPerMinute()
      a.events.offServerStarted()
      a.events.offServerStopped()
      a.events.offServerLog()
      stopStatusPoll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function launchServer() {
    setServerState('starting')
    clearStatus()
    setLogLines([])
    onLaunchStarted?.()

    const result = await api().llama.launch(config)
    if (result.success) {
      setServerState('running')
      setHealth('starting')
      setRunningProfileName(selectedProfile || null)
      startStatusPoll()
    } else {
      setServerState('stopped')
      showStatus(`Launch error: ${result.error}`, 0)
    }
  }

  // Pushes updated tools settings to the already-running server WITHOUT a
  // restart — mirrors how capability/plugin toggles already take effect live
  // (see server:sync-tools in ipc/server.mjs for why activeToolIds etc. did
  // NOT already work this way). Silently skipped, not merely inert, when
  // config.tools no longer describes the profile that's actually running: the
  // admin can switch the profile selector to a DIFFERENT profile without
  // stopping this one, and pushing that other profile's tools into this
  // server would silently reconfigure the wrong thing.
  function syncToolsIfLive(tools: LlamaConfig['tools']) {
    if (serverState !== 'running') return
    if (!runningProfileName || runningProfileName !== selectedProfile) return
    api().server.syncTools(tools)
  }

  // Two-step confirmation for stopping: clicking stop mid-generation kills
  // the response immediately with no way to recover it. The extra click is a
  // small annoyance but prevents accidental data loss.
  function requestStopServer() {
    setConfirmStop(true)
  }

  async function confirmStopServer() {
    setConfirmStop(false)
    isUserStopRef.current = true
    setServerState('stopping')
    showStatus('Stopping server…', 0)
    await api().server.stop(config)
    // onServerStopped handles state cleanup and the "Server stopped." message
  }

  function clearLog() {
    setLogLines([])
  }

  return {
    serverState, health, tokensPerMin, logLines, clearLog,
    confirmStop, setConfirmStop,
    launchServer, requestStopServer, confirmStopServer,
    runningProfileName, syncToolsIfLive,
  }
}
