import { useState } from 'react'
import { api } from '../api/redstart'

// Phase 7 §7.5 — the one deliberate way left to stop the daemon, now that
// closing the window no longer does (§7.2). Two-step confirm, same shape as
// useServerLifecycle's requestStopServer/confirmStopServer: this stops the
// model AND takes the box off the network for every other client, and a
// remote admin cannot walk over and restart it, so an accidental single
// click must not be enough.
export function useShutdown(showStatus: (msg: string, ttlMs?: number) => void) {
  const [confirmShutdown, setConfirmShutdown] = useState(false)
  const [shuttingDown, setShuttingDown] = useState(false)

  function requestShutdown() {
    setConfirmShutdown(true)
  }

  async function confirmShutdownNow() {
    setConfirmShutdown(false)
    setShuttingDown(true)
    try {
      await api().admin.shutdown()
      showStatus('Redstart is shutting down.', 0)
    } catch {
      // The daemon answers 200 before it quits (see RedstartAPI.admin.shutdown's
      // own comment) — a network error here more likely means the connection
      // dropped mid-response than that the call never landed, but there's no
      // way to tell from here, so this stays a plain, calm message either way.
      showStatus('Redstart may already be shutting down.', 0)
    }
  }

  return { confirmShutdown, setConfirmShutdown, shuttingDown, requestShutdown, confirmShutdownNow }
}
