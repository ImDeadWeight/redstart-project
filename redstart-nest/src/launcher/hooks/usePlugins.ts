// Plugin management state for the Plugins tab.
// See docs/notes/mcp-plugin-system-tasks.md task T20.
//
// Mirrors useCapabilities.ts: hold the server-side config, expose loaders and
// mutators, keep the tab component free of IPC detail.

import { useEffect, useRef, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { PluginSummary, PluginToolInfo, PluginInstallProgress, RegistrySearchResult } from '../api/redstart'

export type { PluginSummary, PluginToolInfo as PluginTool, PluginInstallProgress as InstallProgress, RegistrySearchResult as RegistryResult }

export function usePlugins() {
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [installProgress, setInstallProgress] = useState<PluginInstallProgress | null>(null)
  const [searchResults, setSearchResults] = useState<RegistrySearchResult[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  // Typing searches as the term settles, so an older search can answer after
  // a newer one; only the newest is kept.
  const searchSeq = useRef(0)
  const lastQuery = useRef('')

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
  async function setDisplayName(id: string, displayName: string): Promise<void> {
    await api().plugins.setDisplayName(id, displayName)
    await loadPlugins()
  }

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

  /** Bulk classify — one write, one reload, instead of N of each. Still
   *  requires the admin to name which tools and which class explicitly;
   *  nothing here changes what a fresh install starts at (D-b). */
  async function setToolClasses(id: string, toolNames: string[], cls: PluginToolInfo['class']): Promise<{ ok: boolean; error?: string }> {
    const result = await api().plugins.setClasses(id, toolNames, cls)
    await loadPlugins()
    return result
  }

  /** Search the MCP registry. Keeps EVERY result, including unsupported ones —
   *  the verdict is shown, never used to filter. `more` appends the next page
   *  of the last search. */
  async function search(query: string, opts: { more?: boolean } = {}): Promise<void> {
    const more = !!opts.more && !!nextCursor
    const seq = ++searchSeq.current
    if (!more) lastQuery.current = query
    setSearchError(null)
    setSearching(true)
    try {
      const result = await api().plugins.search({ query: lastQuery.current, cursor: more ? nextCursor! : undefined })
      if (seq !== searchSeq.current) return
      if (!result.ok) {
        setSearchError(result.error)
        if (!more) setSearchResults([])
        setNextCursor(null)
        return
      }
      setSearchResults((prev) => (more ? [...prev, ...result.entries] : result.entries))
      setNextCursor(result.nextCursor)
    } catch (err) {
      if (seq === searchSeq.current) setSearchError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === searchSeq.current) setSearching(false)
    }
  }

  /** Forget the last search (the dialog closed). */
  function clearSearch(): void {
    searchSeq.current++
    lastQuery.current = ''
    setSearchResults([])
    setSearchError(null)
    setNextCursor(null)
    setSearching(false)
  }

  return {
    plugins, setPlugins, loading,
    installProgress, setInstallProgress,
    searchResults, setSearchResults, searchError, searching, hasMoreResults: !!nextCursor,
    loadPlugins, setEnabled, setDisplayName, uninstall, testPlugin, setToolClass, setToolClasses, search, clearSearch,
  }
}
