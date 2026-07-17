import type { useServerLifecycle } from '../hooks/useServerLifecycle'

// The always-visible launch/stop bar below the tab content, including the
// two-step stop confirmation.
export function LaunchControls({ server, modelPath }: {
  server: ReturnType<typeof useServerLifecycle>
  modelPath: string
}) {
  const { serverState, confirmStop, setConfirmStop, launchServer, requestStopServer, confirmStopServer } = server
  const canLaunch = serverState === 'stopped' && !!modelPath

  return (
    <div className="flex items-center gap-3">
      {serverState === 'stopped' && (
        <button
          onClick={launchServer}
          disabled={!canLaunch}
          className="flex-1 py-3 bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed rounded-lg font-semibold text-sm transition-colors">
          {modelPath ? 'Launch LlamaCpp Server' : 'Select a model to launch'}
        </button>
      )}
      {serverState === 'starting' && (
        <div className="flex-1 py-3 bg-zinc-800 rounded-lg text-center text-sm text-orange-400 animate-pulse">
          Starting server…
        </div>
      )}
      {serverState === 'running' && !confirmStop && (
        <button
          onClick={requestStopServer}
          className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 hover:border-zinc-500 rounded-lg font-semibold text-sm text-white transition-colors">
          Stop Server
        </button>
      )}
      {serverState === 'running' && confirmStop && (
        <div className="flex flex-1 items-center gap-3 rounded-lg border border-amber-800 bg-zinc-900 px-4 py-2">
          <span className="flex-1 text-xs text-amber-400">Stop now? Any active generation will be interrupted.</span>
          <button
            onClick={confirmStopServer}
            className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded text-xs font-semibold transition-colors">
            Stop Now
          </button>
          <button
            onClick={() => setConfirmStop(false)}
            className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-xs transition-colors">
            Cancel
          </button>
        </div>
      )}
      {serverState === 'stopping' && (
        <div className="flex-1 py-3 bg-zinc-800 rounded-lg text-center text-sm text-amber-400 animate-pulse">
          Stopping server…
        </div>
      )}
    </div>
  )
}
