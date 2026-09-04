import { useCallback, useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { ControlPlaneState } from '../types'

// The control plane's own bind address — a separate axis from the data
// plane's "Local network" toggle (plan decision 4). Read on mount so
// ControlPlaneNotice can warn immediately if settings.json was hand-edited
// to something exposed before this toggle existed; `toggle()` is the one
// write path, rebinding immediately (decision 4 again — an admin flipping
// this may be doing it to recover access, not to schedule a future change).
export function useControlPlaneExposure(showStatus: (msg: string, ttlMs?: number) => void) {
  const [state, setState] = useState<ControlPlaneState | null>(null)

  const refresh = useCallback(() => {
    getAPI()?.admin.getControlPlane().then(setState).catch(() => setState(null))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Boolean in the UI; a bind address underneath (loopback vs the wildcard
  // that answers on every interface) — the same two values the data plane's
  // own toggle picks between in ipc/server.mjs.
  //
  // Internal, and deliberately no longer returned: this used to be handed to
  // useProfiles so a profile load could request a specific exposure, which
  // made selecting a profile rebind the control plane. Exposure changes now
  // have exactly one entry point, the toggle a person clicks.
  async function setExposure(next: boolean) {
    if (state?.exposed === next) return
    const result = await api().admin.setBindHost(next ? '0.0.0.0' : '127.0.0.1')
    setState(result.state)
    if (!result.ok) {
      showStatus(result.error || 'Could not change the admin panel’s network exposure.')
      return
    }
    showStatus(result.state.exposed
      ? `Admin panel now reachable on the network at port ${result.state.port}.`
      : 'Admin panel back to this machine only.')
  }

  async function toggle() {
    await setExposure(!state?.exposed)
  }

  return { controlPlane: state, toggleExposure: toggle }
}
