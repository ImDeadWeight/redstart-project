import { useEffect, useRef } from 'react'
import type { useServerLifecycle } from '../hooks/useServerLifecycle'

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

  return (
    <>
      {serverState === 'running' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex items-center justify-between">
          <span className="text-xs text-zinc-500">Server health</span>
          <span className={`text-xs font-semibold ${healthColor}`}>{healthLabel}</span>
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
