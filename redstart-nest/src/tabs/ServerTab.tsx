import { useEffect, useRef, useState } from 'react'
import type { useServerLifecycle } from '../hooks/useServerLifecycle'
import { api, getAPI } from '../api/redstart'

/** m:ss for under an hour, h:mm above it — a status line, not a stopwatch. */
function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(s).padStart(2, '0')}`
}

// Health text/color for the current /health poll result — also used by the
// top bar in App, so it's exported rather than inlined.
export function healthDisplay(health: string | null): { color: string; label: string } {
  const color =
    health === 'ok' ? 'text-orange-400' :
    health === 'no slot available' ? 'text-amber-400' :
    health === 'starting' ? 'text-orange-300' : 'text-zinc-500'
  const label =
    health === 'ok' ? 'Idle' :
    health === 'no slot available' ? 'Processing' :
    health === 'starting' ? 'Starting…' :
    health === 'unreachable' ? 'Unreachable' :
    health ?? '—'
  return { color, label }
}

export function ServerTab({ server }: { server: ReturnType<typeof useServerLifecycle> }) {
  const { serverState, health, logLines, clearLog } = server
  const logEndRef = useRef<HTMLDivElement>(null)
  const { color: healthColor, label: healthLabel } = healthDisplay(health)

  // Auto-scroll log to bottom on new lines. Living here means only this tab
  // re-renders per log line, not the whole app.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [logLines])

  // The full status endpoint (Phase 5 §5.4) — uptime and bindings, the two
  // fields worth a glance that server:status's plain running/health does not
  // carry. Polled independently of the health check above rather than
  // folded into it: this is admin-only, cross-transport information
  // (gateway/MCP ports, the process uptime), not a per-config health probe.
  const [uptimeMs, setUptimeMs] = useState<number | null>(null)
  const [bindings, setBindings] = useState<{ gatewayPort: number | null; mcpRunning: boolean } | null>(null)
  useEffect(() => {
    if (serverState !== 'running' || !getAPI()) { setUptimeMs(null); setBindings(null); return }
    let cancelled = false
    const poll = async () => {
      try {
        const s = await api().admin.getStatus()
        if (cancelled) return
        setUptimeMs(s.uptimeMs)
        setBindings({ gatewayPort: s.gateway.port, mcpRunning: s.mcp.running })
      } catch { /* transient — the next tick tries again */ }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [serverState])

  return (
    <>
      {serverState === 'running' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex items-center justify-between text-xs">
          <span className="text-zinc-500">Server health</span>
          <span className="flex items-center gap-3">
            {uptimeMs !== null && <span className="text-zinc-500">Up {formatUptime(uptimeMs)}</span>}
            {bindings?.gatewayPort && <span className="text-zinc-500">Gateway :{bindings.gatewayPort}</span>}
            <span className={`font-semibold ${healthColor}`}>{healthLabel}</span>
          </span>
        </div>
      )}

      <section className="flex flex-col flex-1 min-h-64 bg-black rounded-lg border border-zinc-800 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 shrink-0">
          <span className="text-xs text-zinc-500 uppercase tracking-widest">Server Terminal</span>
          <button onClick={clearLog} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
            Clear
          </button>
        </div>
        <div className="flex-1 min-h-56 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
          {serverState === 'stopped' && logLines.length === 0 ? (
            <span className="text-zinc-600">Server is not running. Launch it to see output here.</span>
          ) : logLines.length === 0 ? (
            <span className="text-zinc-600">Waiting for output…</span>
          ) : (
            logLines.map((line, i) => (
              <div key={i} className={`whitespace-pre-wrap break-all ${
                /error|fail|warn/i.test(line) ? 'text-red-400' :
                /load|ready|listen/i.test(line) ? 'text-orange-400' :
                'text-zinc-300'
              }`}>{line}</div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </section>
    </>
  )
}
