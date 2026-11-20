// =============================================================================
// Terminal — llama-server's own output, live.
// =============================================================================
// Its own page, so the log can take the window's full height. Opened by
// itself when a model starts, since a failed start explains itself here.
// =============================================================================

import type { useServerLifecycle } from '../hooks/useServerLifecycle'
import { ServerTab } from '../tabs/ServerTab'

export function TerminalSection({ server }: { server: ReturnType<typeof useServerLifecycle> }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Terminal</h1>
        <p className="mt-1.5 text-[15px] text-zinc-400">The model server&rsquo;s own output, as it happens.</p>
      </div>
      <ServerTab server={server} />
    </div>
  )
}
