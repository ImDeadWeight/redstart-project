import { useCallback, useEffect, useRef, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { TlsPatch, TlsStatus } from '../types'

// The "Secure address" section's state (TLS plan C8). Polls tls:get while the
// Network panel shows, faster while something is in progress (a certificate
// being issued, a switch), because nothing pushes these changes yet.
export function useTls(showStatus: (msg: string, ttlMs?: number) => void) {
  const [status, setStatus] = useState<TlsStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await getAPI()?.tls.get()
      if (s) setStatus(s)
    } catch { /* the control plane went away; the next poll tries again */ }
  }, [])

  // Re-arm after each poll, so the interval follows what is happening now.
  useEffect(() => {
    let alive = true
    const tick = async () => {
      await refresh()
      if (!alive) return
      const busy = status?.settings?.mode === 'own' && status.state === 'lan-https' && (!status.serving || !!status.switching)
      timer.current = setTimeout(tick, busy ? 3000 : 15000)
    }
    void tick()
    return () => { alive = false; if (timer.current) clearTimeout(timer.current) }
    // status is read inside tick for the next interval only; refresh is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, status?.state, status?.serving, status?.switching?.name, status?.settings?.mode])

  async function save(patch: TlsPatch): Promise<boolean> {
    setSaving(true)
    try {
      const r = await api().tls.set(patch)
      setStatus(r.status)
      if (!r.ok) { showStatus(r.error); return false }
      showStatus(patch.mode === 'off' ? 'HTTPS turned off.' : 'Saved. Setting up HTTPS…')
      return true
    } catch (err) {
      showStatus(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function checkNow() {
    try { setStatus(await api().tls.check()) } catch { /* shown on the next poll */ }
  }

  async function retry() {
    try { setStatus(await api().tls.retry()); showStatus('Trying HTTPS again…') } catch { /* next poll */ }
  }

  return { status, saving, save, checkNow, retry, refresh }
}
