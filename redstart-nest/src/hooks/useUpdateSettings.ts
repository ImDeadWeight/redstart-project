import { useCallback, useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { UpdateState } from '../types'

// The Windows auto-updater (daemon/auto-update.mjs): the automatic-check
// switch, "Check now", and "Restart to update". State is read once, then kept
// current by update:status events, so a remote admin sees a download finish
// without reloading the page.
//
// Restarting goes through a two-step confirm, the same as Shut down
// (useShutdown). It restarts the daemon for every client, and a per-machine
// install raises UAC on the server's own desktop, which a remote admin cannot
// see or answer.
export function useUpdateSettings(showStatus: (msg: string, ttlMs?: number) => void) {
  const [state, setState] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [installing, setInstalling] = useState(false)

  const refresh = useCallback(() => {
    getAPI()?.admin.getUpdate().then(setState).catch(() => setState(null))
  }, [])

  useEffect(() => {
    refresh()
    const a = getAPI()
    if (!a) return
    // The event carries the updater's status only. The setting and the
    // running version cannot change through it, so they are kept from the
    // last read.
    a.events.onUpdateStatus((status) => {
      setState((prev) => (prev ? { ...prev, ...status } : prev))
    })
    return () => a.events.offUpdateStatus()
  }, [refresh])

  async function toggle() {
    const next = !state?.enabled
    const result = await api().admin.setUpdate(next)
    setState(result)
    if (!result.supported) {
      showStatus(result.error ?? 'This install does not update itself.')
      return
    }
    showStatus(result.enabled
      ? 'Redstart will check for updates and download them in the background.'
      : 'Redstart will not check for updates on its own.')
  }

  async function checkNow() {
    setChecking(true)
    try {
      const result = await api().admin.checkUpdate()
      setState(result)
      if (result.state === 'idle') showStatus(`Redstart ${result.currentVersion} is the latest version.`)
      else if (result.state === 'error') showStatus(`Could not check for updates: ${result.error ?? 'unknown error'}`)
    } catch {
      showStatus('Could not check for updates.')
    } finally {
      setChecking(false)
    }
  }

  async function confirmInstallNow() {
    setConfirmInstall(false)
    setInstalling(true)
    try {
      const result = await api().admin.installUpdate()
      if (!result.ok) {
        setInstalling(false)
        showStatus(result.error ?? 'No update is ready to install.')
        return
      }
      showStatus('Redstart is restarting to install the update.', 0)
    } catch {
      // Answered before the daemon stops (RedstartAPI.admin.installUpdate), so
      // a dropped connection most likely means the restart has begun.
      showStatus('Redstart may already be restarting.', 0)
    }
  }

  return {
    update: state,
    toggleUpdate: toggle,
    checkNow,
    checking,
    confirmInstall,
    setConfirmInstall,
    installing,
    requestInstall: () => setConfirmInstall(true),
    confirmInstallNow,
  }
}
