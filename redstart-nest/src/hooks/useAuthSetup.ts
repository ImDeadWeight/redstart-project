import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'

// Owner-account bootstrap + the "require login" switch (sidebar Accounts
// section). Self-contained: loads auth config on mount, exposes the toggle
// flow (with the no-owner-yet confirmation step) and first-owner creation.
export function useAuthSetup(showStatus: (msg: string, ttlMs?: number) => void) {
  const [authRequired, setAuthRequired] = useState(false)
  // Defaults true so the bootstrap form doesn't flash before auth:get-config
  // resolves on mount (this comes from disk, unlike networkMode's hardcoded default).
  const [hasOwnerAccount, setHasOwnerAccount] = useState(true)
  const [confirmEnableAuthNoAdmin, setConfirmEnableAuthNoAdmin] = useState(false)
  const [bootstrapUsername, setBootstrapUsername] = useState('')
  const [bootstrapPassword, setBootstrapPassword] = useState('')
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null)

  useEffect(() => {
    getAPI()?.auth.getConfig().then(({ authRequired, hasOwner }) => {
      setAuthRequired(authRequired)
      setHasOwnerAccount(hasOwner)
    })
  }, [])

  async function applyAuthRequired(next: boolean) {
    await api().auth.setRequired(next)
    setAuthRequired(next)
    setConfirmEnableAuthNoAdmin(false)
    showStatus(next ? 'Login now required for LAN/remote access.' : 'Login requirement disabled.')
  }

  function toggleAuthRequired() {
    const next = !authRequired
    if (next && !hasOwnerAccount) { setConfirmEnableAuthNoAdmin(true); return }
    applyAuthRequired(next)
  }

  async function createFirstAdmin() {
    const username = bootstrapUsername.trim()
    if (!username || !bootstrapPassword) return
    const result = await api().auth.createFirstAdmin(username, bootstrapPassword)
    if (!result.success) {
      showStatus(result.error || 'Failed to create owner account.')
      return
    }
    setHasOwnerAccount(true)
    setRevealedApiKey(result.apiKey ?? null)
    setBootstrapUsername('')
    setBootstrapPassword('')
  }

  return {
    authRequired, hasOwnerAccount, confirmEnableAuthNoAdmin, setConfirmEnableAuthNoAdmin,
    bootstrapUsername, setBootstrapUsername, bootstrapPassword, setBootstrapPassword,
    revealedApiKey, setRevealedApiKey,
    applyAuthRequired, toggleAuthRequired, createFirstAdmin,
  }
}
