import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'

// The "Require login" switch (sidebar Accounts section) — data-plane state,
// ongoing rather than one-time. Owner bootstrap used to live here too
// (createFirstAdmin, hasOwnerAccount, the confirm-enable-with-no-admin
// guard); Phase 6 §6.2 deleted it — AdminGate.tsx now gates every caller,
// Electron included, before App.tsx (and this hook) can ever render, so an
// owner always already exists by the time this runs. POST /admin/bootstrap
// is the one door onto owner creation now, for every caller.
export function useAuthSetup(showStatus: (msg: string, ttlMs?: number) => void) {
  const [authRequired, setAuthRequired] = useState(false)

  useEffect(() => {
    getAPI()?.auth.getConfig().then(({ authRequired }) => {
      setAuthRequired(authRequired)
    })
  }, [])

  async function applyAuthRequired(next: boolean) {
    await api().auth.setRequired(next)
    setAuthRequired(next)
    showStatus(next ? 'Login now required for LAN/remote access.' : 'Login requirement disabled.')
  }

  function toggleAuthRequired() {
    applyAuthRequired(!authRequired)
  }

  return { authRequired, applyAuthRequired, toggleAuthRequired }
}
