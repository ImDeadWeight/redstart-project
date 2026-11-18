import { useCallback, useRef, useState } from 'react'

// Single owner of the transient status line at the bottom of the main pane.
// Replaces the scattered `setStatusMsg(x); setTimeout(() => setStatusMsg(''), 3000)`
// pattern, whose timers could overlap: an earlier message's timeout would
// clear a later message ahead of schedule. Every show() cancels the previous
// timer first, so a message always gets its full display time.
//
// ttlMs = 0 makes the message sticky (errors, in-progress states) — it stays
// until the next show() or clear().
export function useStatusMessage() {
  const [statusMsg, setStatusMsg] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback((msg: string, ttlMs = 3000) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    setStatusMsg(msg)
    if (msg && ttlMs > 0) {
      timerRef.current = setTimeout(() => setStatusMsg(''), ttlMs)
    }
  }, [])

  const clear = useCallback(() => show('', 0), [show])

  return { statusMsg, show, clear }
}
