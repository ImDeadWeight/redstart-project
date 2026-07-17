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
}) {
  const { config, showStatus, clearStatus, onLaunchStarted } = opts

  const [serverState, setServerState] = useState<ServerState>('stopped')
  const [health, setHealth] = useState<string | null>(null)
  const [tokensPerMin, setTokensPerMin] = useState<number>(0)
  const [logLines, setLogLines] = useState<string[]>([])
  const [confirmStop, setConfirmStop] = useState(false)

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
      startStatusPoll()
    } else {
      setServerState('stopped')
      showStatus(`Launch error: ${result.error}`, 0)
      getAPI()?.events.offServerLog()
    }
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
  }
}
