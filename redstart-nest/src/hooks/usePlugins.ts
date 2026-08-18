// Plugin management state for the Plugins tab.
// See docs/notes/mcp-plugin-system-tasks.md task T20.
//
// Mirrors useCapabilities.ts: hold the server-side config, expose loaders and
// mutators, keep the tab component free of IPC detail.

import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { PluginSummary, PluginToolInfo, PluginInstallProgress, RegistrySearchResult } from '../api/redstart'

export type { PluginSummary, PluginToolInfo as PluginTool, PluginInstallProgress as InstallProgress, RegistrySearchResult as RegistryResult }

export function usePlugins() {
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [installProgress, setInstallProgress] = useState<PluginInstallProgress | null>(null)
  const [searchResults, setSearchResults] = useState<RegistrySearchResult[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)

  async function loadPlugins(): Promise<void> {
    setLoading(true)
    try {
      setPlugins(await api().plugins.list())
    } catch {
      // Plugins tab degrades to an empty list rather than throwing — same
      // posture as useCapabilities.loadCapabilities.
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (getAPI()) loadPlugins()
  }, [])

  // Subscribes once for the lifetime of the tab; the install dialog reads
  // installProgress from this same hook rather than opening a second listener.
  useEffect(() => {
    const a = getAPI()
    if (!a) return
    a.events.onPluginInstallProgress(setInstallProgress)
    return () => a.events.offPluginInstallProgress()
  }, [])

  /** The registry master switch (Plugins tab). Does NOT touch activeToolIds. */
  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    await api().plugins.setEnabled(id, enabled)
    await loadPlugins()
  }

  async function uninstall(id: string): Promise<void> {
    await api().plugins.uninstall(id)
    await loadPlugins()
  }

  /** Re-probe. Surface the message verbatim — it says what was actually
   *  verified, and a handshake does NOT verify credentials. */
  async function testPlugin(id: string): Promise<{ ok: boolean; message: string }> {
    const result = await api().plugins.test(id)
    await loadPlugins() // health (lastError/lastErrorAt) may have changed
    return result
  }

  async function setToolClass(id: string, tool: string, cls: PluginToolInfo['class']): Promise<void> {
    await api().plugins.setClass(id, tool, cls)
    await loadPlugins()
  }

  /** Search the MCP registry. Keeps EVERY result, including unsupported ones —
   *  the verdict is shown, never used to filter. */
  async function search(query: string): Promise<void> {
    setSearchError(null)
    const result = await api().plugins.search({ query })
    if (!result.ok) {
      setSearchError(result.error)
      setSearchResults([])
      return
    }
    setSearchResults(result.entries)
  }

  return {
    plugins, setPlugins, loading,
    installProgress, setInstallProgress,
    searchResults, setSearchResults, searchError,
    loadPlugins, setEnabled, uninstall, testPlugin, setToolClass, search,
  }
}
