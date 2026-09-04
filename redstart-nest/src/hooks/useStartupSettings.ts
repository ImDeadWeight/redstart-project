import { useCallback, useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { StartupState } from '../types'

// Phase 7 §7.4 — start Redstart at login, windowless (--background), with a
// tray icon as the only affordance until the admin opens it. Reconciled
// against the OS's own login-item record on every read (StartupState's own
// comment explains why), so this hook always shows what Windows will
// actually do, not merely what was last requested here.
export function useStartupSettings(showStatus: (msg: string, ttlMs?: number) => void) {
  const [state, setState] = useState<StartupState | null>(null)

  const refresh = useCallback(() => {
    getAPI()?.admin.getStartup().then(setState).catch(() => setState(null))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function toggle() {
    const next = !state?.startAtLogin
    const result = await api().admin.setStartup(next)
    setState(result)
    if (!result.supported) {
      showStatus(result.error ?? 'Start at login is not available on this platform.')
      return
    }
    showStatus(result.startAtLogin
      ? 'Redstart will start at login (in the tray, no window).'
      : 'Redstart will no longer start at login.')
  }

  return { startup: state, toggleStartup: toggle }
}
