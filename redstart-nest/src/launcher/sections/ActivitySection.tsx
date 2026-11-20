// =============================================================================
// Activity — what is running and what was decided, and the server's own log.
// =============================================================================
// Never what anyone's chat is about: the task list shows who and in what
// state, the decision log the account, the tool and the decision.
// =============================================================================

import type { useServerLifecycle } from '../hooks/useServerLifecycle'
import { PageHeader, Segmented } from '../components/ui'
import { ActivityTab } from '../tabs/ActivityTab'
import { ServerTab } from '../tabs/ServerTab'

export type ActivityView = 'activity' | 'log'

export function ActivitySection({ server, view, onView }: {
  server: ReturnType<typeof useServerLifecycle>
  view: ActivityView
  onView: (v: ActivityView) => void
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Activity">What&rsquo;s running and what was decided. Never what anyone&rsquo;s chat is about.</PageHeader>
      <Segmented
        label="Activity views"
        value={view}
        onChange={onView}
        options={[
          { id: 'activity', label: 'Tasks and approvals' },
          { id: 'log', label: <>Server log{server.serverState !== 'stopped' && <span className={`ml-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${server.serverState === 'running' ? 'bg-green-400' : 'bg-amber-400 animate-pulse'}`} />}</> },
        ]}
      />
      {view === 'activity' ? <div className="flex flex-col gap-6"><ActivityTab /></div> : <ServerTab server={server} />}
    </div>
  )
}
