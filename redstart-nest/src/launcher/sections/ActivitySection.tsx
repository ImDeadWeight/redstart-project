// =============================================================================
// Activity — what is running and what was decided.
// =============================================================================
// Never what anyone's chat is about: the task list shows who and in what
// state, the decision log the account, the tool and the decision. The model's
// own output is the Terminal page.
// =============================================================================

import { PageHeader } from '../components/ui'
import { ActivityTab } from '../tabs/ActivityTab'

export function ActivitySection() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Activity">What&rsquo;s running and what was decided. Never what anyone&rsquo;s chat is about.</PageHeader>
      <ActivityTab />
    </div>
  )
}
