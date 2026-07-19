import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { CapabilityConfig, LlamaConfig } from '../types'

// Folder-scoped capabilities all share one flow: pick a folder → save+enable,
// or toggle enabled. Only the IPC method and the config key differ, so one
// generic implementation replaces the per-capability choose/toggle pairs
// (mirroring the generic handler loop in electron/main/index.mjs).
export type FolderCap = 'documents' | 'sqlite' | 'vault' | 'git' | 'file_system'

function folderCapApi(cap: FolderCap) {
  const c = api().capabilities
  switch (cap) {
    case 'documents':
      return { select: c.selectDocumentsFolder, set: (p: { dir?: string; enabled?: boolean }) => c.setDocumentsFolder({ outputDir: p.dir, enabled: p.enabled }) }
    case 'sqlite':
      return { select: c.selectSqliteFolder, set: (p: { dir?: string; enabled?: boolean }) => c.setSqlite({ rootDir: p.dir, enabled: p.enabled }) }
    case 'vault':
      return { select: c.selectVaultFolder, set: (p: { dir?: string; enabled?: boolean }) => c.setVault({ rootDir: p.dir, enabled: p.enabled }) }
    case 'git':
      return { select: c.selectGitFolder, set: (p: { dir?: string; enabled?: boolean }) => c.setGit({ rootDir: p.dir, enabled: p.enabled }) }
    case 'file_system':
      return { select: c.selectFileSystemFolder, set: (p: { dir?: string; enabled?: boolean }) => c.setFileSystem({ rootDir: p.dir, enabled: p.enabled }) }
  }
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
  const [toolContextEstimate, setToolContextEstimate] = useState<{ toolCount: number; approxTokens: number } | null>(null)

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

  async function chooseFolder(cap: FolderCap) {
    const { select, set } = folderCapApi(cap)
    const dir = await select()
    if (!dir) return
    setSavingCap(cap)
    try {
      await set({ dir, enabled: true })
      await loadCapabilities()
    } finally {
      setSavingCap(null)
    }
  }

  async function toggleCapEnabled(cap: FolderCap) {
    if (!capabilityConfig) return
    await folderCapApi(cap).set({ enabled: !capabilityConfig[cap].enabled })
    await loadCapabilities()
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

  async function togglePostgresEnabled() {
    if (!capabilityConfig) return
    await api().capabilities.setPostgres({ enabled: !capabilityConfig.postgres.enabled })
    await loadCapabilities()
  }

  async function testPostgresConnection() {
    setPgTestResult(null)
    const result = await api().capabilities.testPostgres(pgConnectionString || undefined)
    setPgTestResult(result)
  }

  // --- Scholar (venue filter, no folder) ---

  async function toggleScholarEnabled() {
    if (!capabilityConfig) return
    await api().capabilities.setScholar({ enabled: !capabilityConfig.scholar.enabled })
    await loadCapabilities()
  }

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

  return {
    capabilityConfig, loadCapabilities,
    pgConnectionString, setPgConnectionString, pgMaxRows, setPgMaxRows,
    pgTestResult, pgSaving, savePostgresConfig, togglePostgresEnabled, testPostgresConnection,
    savingCap, chooseFolder, toggleCapEnabled, toggleFsPolicy,
    scholarVenueFilter, setScholarVenueFilter, toggleScholarEnabled, saveScholarVenueFilter,
    toolContextEstimate,
  }
}
