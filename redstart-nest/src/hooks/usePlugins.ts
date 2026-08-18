// Plugin management state for the Plugins tab.
// SKELETON — see docs/notes/mcp-plugin-system-tasks.md task T20.
//
// Mirrors useCapabilities.ts: hold the server-side config, expose loaders and
// mutators, keep the tab component free of IPC detail.
//
// The API surface (`api().plugins`) does not exist until T19 wires the preload
// bridge, so the calls below are TODOs rather than broken references. Add the
// types to src/types.ts and the methods to src/api/redstart.ts as part of T19,
// then fill these in.

import { useState } from 'react'

/** One plugin as the Plugins tab sees it. Never carries a credential — the
 *  main process projects `hasSecret` and nothing else (T19). */
export type PluginSummary = {
  id: string
  displayName: string
  source: { kind: 'npm' | 'path' | 'command'; package?: string; version?: string; path?: string }
  resolvedVersion: string | null
  enabled: boolean            // registry master switch (Plugins tab), NOT activeToolIds
  toolCount: number
  hasSecret: boolean
  lastError: string | null
  lastErrorAt: string | null
}

export type PluginTool = {
  name: string
  description: string
  cls: 'read' | 'write' | 'destructive' | 'network'
}

/** Progress pushed from the main process during an install (T19 event channel). */
export type InstallProgress = {
  phase: 'resolving' | 'downloading' | 'installing' | 'probing' | 'done' | 'error'
  message?: string
  percent?: number
}

/** A search result plus the verdict that decides how it renders. */
export type RegistryResult = {
  name: string
  description: string
  packageName?: string
  version?: string
  verdict: { state: 'installable' | 'needs-setup' | 'needs-runtime' | 'unsupported'; reason?: string }
}

export function usePlugins() {
  const [plugins, setPlugins] = useState<PluginSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null)
  const [searchResults, setSearchResults] = useState<RegistryResult[]>([])

  /** TODO(T20): api().plugins.list() -> setPlugins. */
  async function loadPlugins(): Promise<void> {
    throw new Error('TODO(T20): loadPlugins not implemented')
  }

  /** TODO(T20): the registry master switch, then reload. Does NOT touch activeToolIds. */
  async function setEnabled(_id: string, _enabled: boolean): Promise<void> {
    throw new Error('TODO(T20): setEnabled not implemented')
  }

  /** TODO(T20): uninstall, then reload. */
  async function uninstall(_id: string): Promise<void> {
    throw new Error('TODO(T20): uninstall not implemented')
  }

  /** TODO(T20): re-probe. Surface the message verbatim — it says what was
   *  actually verified, and a handshake does NOT verify credentials. */
  async function testPlugin(_id: string): Promise<{ ok: boolean; message: string }> {
    throw new Error('TODO(T20): testPlugin not implemented')
  }

  /** TODO(T20): edit one tool's admin-assigned class. */
  async function setToolClass(_id: string, _tool: string, _cls: PluginTool['cls']): Promise<void> {
    throw new Error('TODO(T20): setToolClass not implemented')
  }

  /** TODO(T20): search the MCP registry. Keep EVERY result, including
   *  unsupported ones — the verdict is shown, never used to filter. */
  async function search(_query: string): Promise<void> {
    throw new Error('TODO(T20): search not implemented')
  }

  /** TODO(T20): subscribe to onPluginInstallProgress in a useEffect and feed
   *  setInstallProgress. Unsubscribe on unmount. */

  return {
    plugins, setPlugins,
    loading, setLoading,
    installProgress, setInstallProgress,
    searchResults, setSearchResults,
    loadPlugins, setEnabled, uninstall, testPlugin, setToolClass, search,
  }
}
