// =============================================================================
// Tools — what the assistant can use.
// =============================================================================
// Two views, kept apart on purpose (plugin plan decision D-a). A plugin has two
// switches: "allowed on this server" (Plugins) and "on for this profile" (For
// this profile, beside the built-in capabilities). Side by side they read as
// redundancy someone will try to collapse, and collapsing them breaks the
// model. Same page, separate views.
// =============================================================================

import { useState } from 'react'
import type { LlamaConfig } from '../types'
import type { useToolsCatalog } from '../hooks/useToolsCatalog'
import type { useCapabilities } from '../hooks/useCapabilities'
import type { useExternalMcp } from '../hooks/useExternalMcp'
import type { usePlugins } from '../hooks/usePlugins'
import { PageHeader, Segmented } from '../components/ui'
import { ToolsTab } from '../tabs/ToolsTab'
import { PluginsTab } from '../tabs/PluginsTab'

export function ToolsSection({ config, toolsCatalog, caps, mcp, plugins, onOpenImages }: {
  config: LlamaConfig
  /** The Images page, where image generation is set up (its row here links there). */
  onOpenImages: () => void
  toolsCatalog: ReturnType<typeof useToolsCatalog>
  caps: ReturnType<typeof useCapabilities>
  mcp: ReturnType<typeof useExternalMcp>
  plugins: ReturnType<typeof usePlugins>
}) {
  const [view, setView] = useState<'profile' | 'plugins'>('profile')
  const pluginCount = plugins.plugins.length

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Tools">
        What the assistant can use. Every tool is off until you turn it on, and a role can still take it away from someone.
      </PageHeader>
      <Segmented
        label="Tools views"
        value={view}
        onChange={setView}
        options={[
          { id: 'profile', label: 'For this profile' },
          { id: 'plugins', label: <>Plugins{pluginCount ? <span className="ml-1.5 text-zinc-500">{pluginCount}</span> : null}</> },
        ]}
      />
      {view === 'profile'
        ? <ToolsTab config={config} toolsCatalog={toolsCatalog} caps={caps} mcp={mcp} plugins={plugins} onOpenImages={onOpenImages} />
        : <PluginsTab plugins={plugins} />}
    </div>
  )
}
