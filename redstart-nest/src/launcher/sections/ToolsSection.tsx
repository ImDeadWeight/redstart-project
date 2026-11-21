// =============================================================================
// Tools — what the assistant can use.
// =============================================================================
// Two views, kept apart on purpose (plugin plan decision D-a). A plugin has two
// switches: "allowed on this server" (Plugins) and "on for this profile" (For
// this profile, beside the built-in capabilities). Side by side they read as
// redundancy someone will try to collapse, and collapsing them breaks the
// model. Same page, separate views. External MCP (tool servers on other
// computers) is a third view: reached over the network, never installed here.
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
import { ExternalMcpTab } from '../tabs/ExternalMcpTab'

export function ToolsSection({ config, toolsCatalog, caps, mcp, plugins, onOpenImages }: {
  config: LlamaConfig
  /** The Images page, where image generation is set up (its row here links there). */
  onOpenImages: () => void
  toolsCatalog: ReturnType<typeof useToolsCatalog>
  caps: ReturnType<typeof useCapabilities>
  mcp: ReturnType<typeof useExternalMcp>
  plugins: ReturnType<typeof usePlugins>
}) {
  const [view, setView] = useState<'profile' | 'plugins' | 'external'>('profile')
  const pluginCount = plugins.plugins.length
  const externalCount = mcp.externalServers.length

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
          { id: 'external', label: <>External MCP{externalCount ? <span className="ml-1.5 text-zinc-500">{externalCount}</span> : null}</> },
        ]}
      />
      {view === 'profile' && <ToolsTab config={config} toolsCatalog={toolsCatalog} caps={caps} plugins={plugins} onOpenImages={onOpenImages} />}
      {view === 'plugins' && <PluginsTab plugins={plugins} />}
      {view === 'external' && <ExternalMcpTab config={config} mcp={mcp} />}
    </div>
  )
}
