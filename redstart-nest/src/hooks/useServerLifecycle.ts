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

    a.events.onTokensPerMinute(setTokensPerMin)
    a.events.onServerStopped(() => {
      setServerState('stopped')
      setHealth(null)
      setTokensPerMin(0)
      setConfirmStop(false)
      setRunningProfileName(null)
      stopStatusPoll()
      a.events.offServerLog()
      if (isUserStopRef.current) {
        isUserStopRef.current = false
        showStatus('Server stopped.')
      }
    })

    return () => {
      a.events.offTokensPerMinute()
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

    getAPI()?.events.onServerLog(line => {
      if (line.trim()) setLogLines(prev => [...prev.slice(-1000), line])
    })

    const result = await api().llama.launch(config)
    if (result.success) {
      setServerState('running')
      setHealth('starting')
      setRunningProfileName(selectedProfile || null)
      startStatusPoll()
    } else {
      setServerState('stopped')
      showStatus(`Launch error: ${result.error}`, 0)
      getAPI()?.events.offServerLog()
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
