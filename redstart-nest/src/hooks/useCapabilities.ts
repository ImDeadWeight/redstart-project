import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { CapabilityConfig, LlamaConfig, ToolContextEstimate, RetrievalStatus } from '../types'

// Folder-scoped capabilities all share one flow: pick a folder → save+enable,
// or toggle enabled. Only the IPC method and the config key differ, so one
// generic implementation replaces the per-capability choose/toggle pairs
// (mirroring the generic handler loop in electron/main/index.mjs).
export type FolderCap = 'documents' | 'sqlite' | 'vault' | 'git' | 'file_system'

// The picking itself (native dialog or the remote browser) lives in
// FolderPicker.tsx now — this only knows how to APPLY a chosen
// path to the right config setter. `allowCreate` mirrors what each capability
// used to pass to dialog.showOpenDialog: Documents and SQLite offered *New
// Folder*, Vault/Git/File System could only select something that exists.
function folderCapApi(cap: FolderCap) {
  const c = api().capabilities
  switch (cap) {
    case 'documents':
      return { allowCreate: true, set: (p: { dir?: string; enabled?: boolean }) => c.setDocumentsFolder({ outputDir: p.dir, enabled: p.enabled }) }
    case 'sqlite':
      return { allowCreate: true, set: (p: { dir?: string; enabled?: boolean }) => c.setSqlite({ rootDir: p.dir, enabled: p.enabled }) }
    case 'vault':
      return { allowCreate: false, set: (p: { dir?: string; enabled?: boolean }) => c.setVault({ rootDir: p.dir, enabled: p.enabled }) }
    case 'git':
      return { allowCreate: false, set: (p: { dir?: string; enabled?: boolean }) => c.setGit({ rootDir: p.dir, enabled: p.enabled }) }
    case 'file_system':
      return { allowCreate: false, set: (p: { dir?: string; enabled?: boolean }) => c.setFileSystem({ rootDir: p.dir, enabled: p.enabled }) }
  }
}

export function folderCapAllowCreate(cap: FolderCap): boolean {
  return folderCapApi(cap).allowCreate
}

// Global capability configuration (Postgres, Documents, SQLite, Vault, Git,
// File System, Scholar) + the live tool-context estimate for the active
// profile's tool selection.
export function useCapabilities(config: LlamaConfig) {
  const [capabilityConfig, setCapabilityConfig] = useState<CapabilityConfig | null>(null)
  const [pgConnectionString, setPgConnectionString] = useState('')
  const [pgMaxRows, setPgMaxRows] = useState(200)
  const [pgTestResult, setPgTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [pgSaving, setPgSaving] = useState(false)
  const [savingCap, setSavingCap] = useState<FolderCap | null>(null)
  const [scholarVenueFilter, setScholarVenueFilter] = useState('')
  const [toolContextEstimate, setToolContextEstimate] = useState<ToolContextEstimate | null>(null)
  const [retrievalStatus, setRetrievalStatus] = useState<RetrievalStatus | null>(null)

  async function loadCapabilities() {
    try {
      const data = await api().capabilities.get()
      setCapabilityConfig(data)
      setPgMaxRows(data.postgres.maxRows)
      setScholarVenueFilter(data.scholar.venueFilter || '')
    } catch { /* capabilities unavailable */ }
  }

  useEffect(() => {
    if (getAPI()) loadCapabilities()
  }, [])

  // --- Folder-scoped capabilities (generic) ---

  // NOTE: the per-capability Enable/Disable used to live here
  // (toggleCapEnabled / togglePostgresEnabled / toggleScholarEnabled). Each
  // card's button now calls toggleTool(id) from useToolsCatalog instead, so the
  // toggle is per-profile. The `enabled: true` written below is the vestigial
  // storage flag — see tools-storage.mjs.
  async function applyFolder(cap: FolderCap, dir: string) {
    const { set } = folderCapApi(cap)
    setSavingCap(cap)
    try {
      await set({ dir, enabled: true })
      await loadCapabilities()
    } finally {
      setSavingCap(null)
    }
  }

  // File System permission policy (writes / destructive). Server-enforced at the
  // MCP tools/call gate; this just flips the stored flag. Deletes default off.
  async function toggleFsPolicy(field: 'allowWrite' | 'allowDestructive') {
    if (!capabilityConfig) return
    await api().capabilities.setFileSystem({ [field]: !capabilityConfig.file_system[field] })
    await loadCapabilities()
  }

  // --- Postgres (connection string + row cap) ---

  async function savePostgresConfig() {
    setPgSaving(true)
    try {
      const result = await api().capabilities.setPostgres({
        connectionString: pgConnectionString || undefined,
        maxRows: pgMaxRows,
        enabled: true,
      })
      if (!result.ok) {
        setPgTestResult({ ok: false, message: result.error || 'Failed to save' })
        return
      }
      setPgConnectionString('')
      setPgTestResult(null)
      await loadCapabilities()
    } finally {
      setPgSaving(false)
    }
  }

  async function testPostgresConnection() {
    setPgTestResult(null)
    const result = await api().capabilities.testPostgres(pgConnectionString || undefined)
    setPgTestResult(result)
  }

  // --- Scholar (venue filter, no folder) ---

  async function saveScholarVenueFilter() {
    await api().capabilities.setScholar({ venueFilter: scholarVenueFilter })
    await loadCapabilities()
  }

  // --- Tool-context estimate ---
  // Every active tool's JSON schema is sent with every completion request, so
  // this is a standing per-request cost — recomputed whenever the tool
  // selection or capability config changes (small debounce to avoid IPC
  // chatter). The stringified signature makes deep tools-object changes
  // visible to the effect without an object-identity dependency.
  const toolsSignature = JSON.stringify(config.tools ?? null)
  const toolsEnabled = !!config.tools?.enabled
  useEffect(() => {
    if (!toolsEnabled) { setToolContextEstimate(null); return }
    const t = setTimeout(async () => {
      try {
        setToolContextEstimate(await api().capabilities.estimateToolContext(config))
      } catch { setToolContextEstimate(null) }
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolsSignature, toolsEnabled, capabilityConfig])

  // Retrieval has a 67 MB download and a child process behind its switch, so the
  // switch cannot report its own state — it polls while something is in flight
  // and then stops. Every failure reads as "no status", which the tab renders as
  // the honest "not running" rather than as an error nobody can act on.
  const retrievalOn = config.tools?.retrieval?.enabled === true
  useEffect(() => {
    if (!toolsEnabled) { setRetrievalStatus(null); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const status = await api().tools.retrievalStatus(config)
        if (cancelled) return
        setRetrievalStatus(status)
        // Keep polling only while there is something to watch change.
        if (status.enabled && (status.model.download.state === 'downloading' || !status.model.present)) {
          timer = setTimeout(poll, 1000)
        }
      } catch { if (!cancelled) setRetrievalStatus(null) }
    }
    poll()
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolsEnabled, retrievalOn])

  return {
    retrievalStatus,
    capabilityConfig, loadCapabilities,
    pgConnectionString, setPgConnectionString, pgMaxRows, setPgMaxRows,
    pgTestResult, pgSaving, savePostgresConfig, testPostgresConnection,
    savingCap, applyFolder, toggleFsPolicy,
    scholarVenueFilter, setScholarVenueFilter, saveScholarVenueFilter,
    toolContextEstimate,
  }
}
