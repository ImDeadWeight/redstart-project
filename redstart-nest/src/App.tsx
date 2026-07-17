// =============================================================================
// Redstart Nest — renderer UI
// =============================================================================
// This is the React app that runs inside Electron's renderer process. It's
// the control panel the user sees: scan hardware, pick a model, configure
// parameters, and launch/stop the llama-server. It communicates with the main
// process exclusively through the redstartAPI bridge defined in the preload
// script — renderer code can't directly call Node.js APIs for security reasons.
//
// I kept this as a single-file component intentionally. The app is small and
// the configuration state is all tightly related. Splitting it into many
// components would add indirection without much benefit at this scale.
// =============================================================================

import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HardwareSpecs = {
  cpu: { name: string; cores: number; threads: number; architecture: string; supportsAVX: boolean }
  gpu: { name: string; vram: number; cudaAvailable: boolean }
  memory: { total: number; available: number }
  os: { platform: string; arch: string }
}

type WebFetchTool = {
  id: string
  name: string
  baseUrl?: string
  description: string
  builtIn: boolean
  kind?: 'web' | 'capability'
}

type CapabilityConfig = {
  postgres: { enabled: boolean; hasConnectionString: boolean; maxRows: number }
  documents: { enabled: boolean; outputDir: string | null }
  sqlite: { enabled: boolean; rootDir: string | null; maxRows: number }
  vault: { enabled: boolean; rootDir: string | null }
  git: { enabled: boolean; rootDir: string | null }
  file_system: { enabled: boolean; rootDir: string | null }
  scholar: { enabled: boolean; venueFilter: string | null }
}

type ToolGroup = {
  id: string
  name: string
  description: string
  toolIds: string[]
  builtIn: boolean
}

type ExternalMcpServer = {
  id: string
  name: string
  url: string
  enabled: boolean
}

type ProfileTools = {
  enabled: boolean
  activeGroupIds: string[]
  activeToolIds: string[]
  maxFetchTokens: number
  whitelistEnabled?: boolean  // default true; false = model may fetch any public http(s) URL (LAN/private always blocked)
}

type LlamaConfig = {
  modelPath: string
  ctxSize: number
  batchSize: number
  threads: number
  gpuLayers?: number
  port: number
  host: string
  networkMode?: boolean
  nCpuMoe?: number
  priority?: 'high'
  noMmap?: boolean
  kvCache?: 'off' | 'conservative' | 'balanced' | 'aggressive'
  additionalArgs?: string
  tools?: ProfileTools
  advertisedHost?: string
}

type RedstartAPI = {
  hardware: {
    scan: () => Promise<HardwareSpecs>
    selectModel: () => Promise<string | null>
  }
  llama: {
    generateCommand: (config: LlamaConfig) => Promise<string>
    launch: (config: LlamaConfig) => Promise<{ success: boolean; error?: string; pid?: number }>
  }
  server: {
    stop: (config: LlamaConfig) => Promise<{ success: boolean }>
    status: (config: LlamaConfig) => Promise<{ running: boolean; health: string | null; pid?: number }>
    getIp: () => Promise<string>
  }
  profiles: {
    list: () => Promise<string[]>
    save: (name: string, config: LlamaConfig) => Promise<boolean>
    load: (name: string) => Promise<LlamaConfig | null>
    delete: (name: string) => Promise<boolean>
    generateDefaults: (hardware: HardwareSpecs) => Promise<LlamaConfig[]>
  }
  tools: {
    listAll: () => Promise<{ builtinTools: WebFetchTool[], builtinGroups: ToolGroup[], builtinCapabilities: WebFetchTool[], userTools: WebFetchTool[], userGroups: ToolGroup[] }>
    addTool: (tool: Omit<WebFetchTool, 'builtIn'>) => Promise<boolean>
    deleteTool: (id: string) => Promise<boolean>
    addGroup: (group: Omit<ToolGroup, 'builtIn'>) => Promise<boolean>
    deleteGroup: (id: string) => Promise<boolean>
    applyConfig: (config: LlamaConfig) => Promise<boolean>
  }
  settings: {
    getBinaryPath: () => Promise<string | null>
    setBinaryPath: (p: string | null) => Promise<boolean>
    selectBinary: () => Promise<string | null>
    getResolvedBinary: () => Promise<string | null>
  }
  github: { checkReleases: () => Promise<Record<string, string>> }
  auth: {
    getConfig: () => Promise<{ authRequired: boolean; hasOwner: boolean }>
    setRequired: (required: boolean) => Promise<boolean>
    createFirstAdmin: (username: string, password: string) => Promise<{ success: boolean; error?: string; apiKey?: string; id?: string }>
  }
  mcp: {
    listExternal: () => Promise<ExternalMcpServer[]>
    addExternal: (server: Omit<ExternalMcpServer, 'id'>) => Promise<ExternalMcpServer>
    removeExternal: (id: string) => Promise<boolean>
    testExternal: (url: string) => Promise<{ ok: boolean; message: string }>
  }
  capabilities: {
    get: () => Promise<CapabilityConfig>
    setPostgres: (config: { connectionString?: string; maxRows?: number; enabled?: boolean }) => Promise<{ ok: boolean; error?: string }>
    testPostgres: (connectionString?: string) => Promise<{ ok: boolean; message: string }>
    selectDocumentsFolder: () => Promise<string | null>
    setDocumentsFolder: (config: { outputDir?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
    selectSqliteFolder: () => Promise<string | null>
    setSqlite: (config: { rootDir?: string; maxRows?: number; enabled?: boolean }) => Promise<{ ok: boolean }>
    estimateToolContext: (config: LlamaConfig) => Promise<{ toolCount: number; approxTokens: number }>
    selectVaultFolder: () => Promise<string | null>
    setVault: (config: { rootDir?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
    selectGitFolder: () => Promise<string | null>
    setGit: (config: { rootDir?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
    selectFileSystemFolder: () => Promise<string | null>
    setFileSystem: (config: { rootDir?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
    setScholar: (config: { venueFilter?: string; enabled?: boolean }) => Promise<{ ok: boolean }>
  }
  events: {
    onTokensPerMinute: (cb: (tpm: number) => void) => void
    offTokensPerMinute: () => void
    onServerLog: (cb: (line: string) => void) => void
    offServerLog: () => void
    onServerStopped: (cb: () => void) => void
    offServerStopped: () => void
  }
}

const getAPI = (): RedstartAPI | undefined => (window as unknown as { redstartAPI?: RedstartAPI }).redstartAPI
const api = (): RedstartAPI => {
  const a = getAPI()
  if (!a) throw new Error('redstartAPI not available — preload may have failed')
  return a
}

// networkMode defaults to true because the main use case is serving other
// devices on the home network. A toggle exists to switch to localhost-only
// (useful if the user only wants to use the chat from the same PC).
const DEFAULT_CONFIG: LlamaConfig = {
  modelPath: '', ctxSize: 4096, batchSize: 256, threads: 4,
  gpuLayers: undefined, port: 19080, host: '0.0.0.0', networkMode: true,
  nCpuMoe: undefined, kvCache: 'balanced', additionalArgs: '',
}

type ServerState = 'stopped' | 'starting' | 'running' | 'stopping'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function App() {
  const [hardware, setHardware] = useState<HardwareSpecs | null>(null)
  const [config, setConfig] = useState<LlamaConfig>(DEFAULT_CONFIG)
  const [serverState, setServerState] = useState<ServerState>('stopped')
  const [health, setHealth] = useState<string | null>(null)
  const [tokensPerMin, setTokensPerMin] = useState<number>(0)
  const [generatedCommand, setGeneratedCommand] = useState('')
  const [networkMode, setNetworkMode] = useState(true)
  const [localIp, setLocalIp] = useState('')
  const [advertisedHost, setAdvertisedHost] = useState('redstart.local')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [profiles, setProfiles] = useState<string[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string>('')
  const [saveProfileName, setSaveProfileName] = useState('')
  const [showSaveInput, setShowSaveInput] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [activeTab, setActiveTab] = useState<'config' | 'tools' | 'server'>('config')
  const [logLines, setLogLines] = useState<string[]>([])
  const [confirmStop, setConfirmStop] = useState(false)
  const [binaryPath, setBinaryPath] = useState<string | null>(null)
  const [allTools, setAllTools] = useState<WebFetchTool[]>([])
  const [allGroups, setAllGroups] = useState<ToolGroup[]>([])
  const [showAddTool, setShowAddTool] = useState(false)
  const [newToolName, setNewToolName] = useState('')
  const [newToolUrl, setNewToolUrl] = useState('')
  const [newToolDesc, setNewToolDesc] = useState('')
  const [showAddGroup, setShowAddGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupDesc, setNewGroupDesc] = useState('')
  const [newGroupToolIds, setNewGroupToolIds] = useState<string[]>([])
  const [externalServers, setExternalServers] = useState<ExternalMcpServer[]>([])
  const [showAddExternal, setShowAddExternal] = useState(false)
  const [newExtName, setNewExtName] = useState('')
  const [newExtUrl, setNewExtUrl] = useState('')
  const [mcpTestResults, setMcpTestResults] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [capabilityConfig, setCapabilityConfig] = useState<CapabilityConfig | null>(null)
  const [pgConnectionString, setPgConnectionString] = useState('')
  const [pgMaxRows, setPgMaxRows] = useState(200)
  const [pgTestResult, setPgTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [pgSaving, setPgSaving] = useState(false)
  const [docsSaving, setDocsSaving] = useState(false)
  const [sqliteSaving, setSqliteSaving] = useState(false)
  const [toolContextEstimate, setToolContextEstimate] = useState<{ toolCount: number; approxTokens: number } | null>(null)
  const [scholarVenueFilter, setScholarVenueFilter] = useState('')
  const [authRequired, setAuthRequiredState] = useState(false)
  // Defaults true so the bootstrap form doesn't flash before auth:get-config
  // resolves on mount (this comes from disk, unlike networkMode's hardcoded default).
  const [hasOwnerAccount, setHasOwnerAccount] = useState(true)
  const [confirmEnableAuthNoAdmin, setConfirmEnableAuthNoAdmin] = useState(false)
  const [bootstrapUsername, setBootstrapUsername] = useState('')
  const [bootstrapPassword, setBootstrapPassword] = useState('')
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null)
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)
  const configRef = useRef(config)
  const isUserStopRef = useRef(false)

  // --- Bootstrap ---

  useEffect(() => {
    const a = getAPI()
    if (!a) {
      setStatusMsg('ERROR: redstartAPI not found — preload script may have failed to load.')
      return
    }

    loadProfiles()
    loadToolDefs()
    loadExternalServers()
    loadCapabilities()
    a.server.getIp().then(setLocalIp)
    a.settings.getResolvedBinary().then(setBinaryPath)
    a.auth.getConfig().then(({ authRequired, hasOwner }) => {
      setAuthRequiredState(authRequired)
      setHasOwnerAccount(hasOwner)
    })

    a.events.onTokensPerMinute(setTokensPerMin)
    a.events.onServerStopped(() => {
      setServerState('stopped')
      setHealth(null)
      setTokensPerMin(0)
      setConfirmStop(false)
      stopStatusPoll()
      a.events.offServerLog()
      if (isUserStopRef.current) {
        isUserStopRef.current = false
        setStatusMsg('Server stopped.')
        setTimeout(() => setStatusMsg(''), 3000)
      }
    })

    return () => {
      a.events.offTokensPerMinute()
      a.events.offServerStopped()
      a.events.offServerLog()
    }
  }, [])

  // Auto-scroll log to bottom on new lines
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [logLines])

  // --- Update QR whenever network info changes ---
  // The QR code encodes a deep link in the format redstart://connect?url=http://...
  // When an Android user scans this with their camera, the OS routes it to the
  // Redstart Twig app (because the app registers the redstart:// URI scheme in its
  // manifest). The app then reads the url parameter and auto-configures itself.
  // I chose a custom URI scheme over a plain URL because a plain http:// link
  // would just open the browser instead of the Redstart Twig app.

  // Sync advertisedHost to config whenever it changes
  useEffect(() => {
    setConfig(prev => ({ ...prev, advertisedHost }))
  }, [advertisedHost])

  useEffect(() => {
    if (!networkMode) { setQrDataUrl(''); return }
    const host = (advertisedHost || localIp || '').trim()
    if (!host) { setQrDataUrl(''); return }
    const deepLink = `redstart://connect?url=${encodeURIComponent(`http://${host}:${config.port}`)}`
    QRCode.toDataURL(deepLink, { width: 200, margin: 1 }).then(setQrDataUrl).catch(() => setQrDataUrl(''))
  }, [networkMode, advertisedHost, localIp, config.port])

  // --- Config networkMode sync ---

  useEffect(() => {
    setConfig(prev => ({ ...prev, networkMode }))
  }, [networkMode])

  // Keep configRef current so the status poll always uses the latest config
  useEffect(() => { configRef.current = config }, [config])

  // --- Profile helpers ---

  async function loadProfiles() {
    try {
      const list = await api().profiles.list()
      setProfiles(list)
    } catch {
      setStatusMsg('Failed to load profiles — settings may be corrupted.')
    }
  }

  async function selectProfile(name: string) {
    if (!name) { setSelectedProfile(''); return }
    const loaded = await api().profiles.load(name)
    if (loaded) {
      setConfig(prev => ({ ...loaded, networkMode: prev.networkMode }))
      setAdvertisedHost(loaded.advertisedHost || '')
      setSelectedProfile(name)
    }
  }

  async function saveProfile() {
    const name = saveProfileName.trim()
    if (!name) return
    await api().profiles.save(name, config)
    setSaveProfileName('')
    setShowSaveInput(false)
    setSelectedProfile(name)
    await loadProfiles()
    setStatusMsg(`Profile "${name}" saved.`)
    setTimeout(() => setStatusMsg(''), 3000)
  }

  async function generateDefaultProfiles() {
    if (!hardware) return
    await api().profiles.generateDefaults(hardware)
    await loadProfiles()
    setStatusMsg('Default profiles generated from hardware scan.')
    setTimeout(() => setStatusMsg(''), 3000)
  }

  // --- Auth / accounts ---

  async function applyAuthRequired(next: boolean) {
    await api().auth.setRequired(next)
    setAuthRequiredState(next)
    setConfirmEnableAuthNoAdmin(false)
    setStatusMsg(next ? 'Login now required for LAN/remote access.' : 'Login requirement disabled.')
    setTimeout(() => setStatusMsg(''), 3000)
  }

  function toggleAuthRequired() {
    const next = !authRequired
    if (next && !hasOwnerAccount) { setConfirmEnableAuthNoAdmin(true); return }
    applyAuthRequired(next)
  }

  async function createFirstAdmin() {
    const username = bootstrapUsername.trim()
    if (!username || !bootstrapPassword) return
    const result = await api().auth.createFirstAdmin(username, bootstrapPassword)
    if (!result.success) {
      setStatusMsg(result.error || 'Failed to create owner account.')
      setTimeout(() => setStatusMsg(''), 3000)
      return
    }
    setHasOwnerAccount(true)
    setRevealedApiKey(result.apiKey ?? null)
    setBootstrapUsername('')
    setBootstrapPassword('')
  }

  // --- Tools ---

  async function loadToolDefs() {
    try {
      const data = await api().tools.listAll()
      setAllTools([
        ...data.builtinTools.map(t => ({ ...t, builtIn: true, kind: 'web' as const })),
        ...(data.builtinCapabilities ?? []).map(c => ({ ...c, builtIn: true, kind: 'capability' as const })),
        ...data.userTools.map(t => ({ ...t, builtIn: false, kind: 'web' as const })),
      ])
      setAllGroups([
        ...data.builtinGroups.map(g => ({ ...g, builtIn: true })),
        ...data.userGroups.map(g => ({ ...g, builtIn: false })),
      ])
    } catch { /* tools unavailable */ }
  }

  async function loadCapabilities() {
    try {
      const data = await api().capabilities.get()
      setCapabilityConfig(data)
      setPgMaxRows(data.postgres.maxRows)
      setScholarVenueFilter(data.scholar.venueFilter || '')
    } catch { /* capabilities unavailable */ }
  }

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

  async function chooseDocumentsFolder() {
    const dir = await api().capabilities.selectDocumentsFolder()
    if (!dir) return
    setDocsSaving(true)
    try {
      await api().capabilities.setDocumentsFolder({ outputDir: dir, enabled: true })
      await loadCapabilities()
    } finally {
      setDocsSaving(false)
    }
  }

  async function toggleDocumentsEnabled() {
    if (!capabilityConfig) return
    await api().capabilities.setDocumentsFolder({ enabled: !capabilityConfig.documents.enabled })
    await loadCapabilities()
  }

  // Live estimate of the context-window cost of the active tool set. Every
  // active tool's JSON schema is sent with every completion request, so this
  // is a standing per-request cost — recomputed whenever the tool selection
  // or capability config changes (small debounce to avoid IPC chatter).
  useEffect(() => {
    if (!config.tools?.enabled) { setToolContextEstimate(null); return }
    const t = setTimeout(async () => {
      try {
        setToolContextEstimate(await api().capabilities.estimateToolContext(config))
      } catch { setToolContextEstimate(null) }
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(config.tools), capabilityConfig])

  async function chooseSqliteFolder() {
    const dir = await api().capabilities.selectSqliteFolder()
    if (!dir) return
    setSqliteSaving(true)
    try {
      await api().capabilities.setSqlite({ rootDir: dir, enabled: true })
      await loadCapabilities()
    } finally {
      setSqliteSaving(false)
    }
  }

  async function toggleSqliteEnabled() {
    if (!capabilityConfig) return
    await api().capabilities.setSqlite({ enabled: !capabilityConfig.sqlite.enabled })
    await loadCapabilities()
  }

  async function chooseVaultFolder() {
    const dir = await api().capabilities.selectVaultFolder()
    if (!dir) return
    await api().capabilities.setVault({ rootDir: dir, enabled: true })
    await loadCapabilities()
  }

  async function toggleVaultEnabled() {
    if (!capabilityConfig) return
    await api().capabilities.setVault({ enabled: !capabilityConfig.vault.enabled })
    await loadCapabilities()
  }

  async function toggleScholarEnabled() {
    if (!capabilityConfig) return
    await api().capabilities.setScholar({ enabled: !capabilityConfig.scholar.enabled })
    await loadCapabilities()
  }

  async function saveScholarVenueFilter() {
    await api().capabilities.setScholar({ venueFilter: scholarVenueFilter })
    await loadCapabilities()
  }

  async function chooseGitFolder() {
    const dir = await api().capabilities.selectGitFolder()
    if (!dir) return
    await api().capabilities.setGit({ rootDir: dir, enabled: true })
    await loadCapabilities()
  }

  async function toggleGitEnabled() {
    if (!capabilityConfig) return
    await api().capabilities.setGit({ enabled: !capabilityConfig.git.enabled })
    await loadCapabilities()
  }

  async function chooseFileSystemFolder() {
    const dir = await api().capabilities.selectFileSystemFolder()
    if (!dir) return
    await api().capabilities.setFileSystem({ rootDir: dir, enabled: true })
    await loadCapabilities()
  }

  async function toggleFileSystemEnabled() {
    if (!capabilityConfig) return
    await api().capabilities.setFileSystem({ enabled: !capabilityConfig.file_system.enabled })
    await loadCapabilities()
  }

  function setToolsField<K extends keyof ProfileTools>(key: K, value: ProfileTools[K]) {
    setConfig(prev => ({
      ...prev,
      tools: {
        enabled: false,
        activeGroupIds: [],
        activeToolIds: [],
        maxFetchTokens: 2000,
        ...(prev.tools || {}),
        [key]: value,
      },
    }))
  }

  function toggleGroup(groupId: string) {
    const current = config.tools?.activeGroupIds ?? []
    const next = current.includes(groupId)
      ? current.filter(id => id !== groupId)
      : [...current, groupId]
    setToolsField('activeGroupIds', next)
  }

  function toggleTool(toolId: string) {
    const current = config.tools?.activeToolIds ?? []
    const next = current.includes(toolId)
      ? current.filter(id => id !== toolId)
      : [...current, toolId]
    setToolsField('activeToolIds', next)
  }

  async function addCustomTool() {
    const name = newToolName.trim()
    const url  = newToolUrl.trim()
    if (!name || !url) return
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    await api().tools.addTool({ id, name, baseUrl: url, description: newToolDesc.trim() })
    setNewToolName(''); setNewToolUrl(''); setNewToolDesc(''); setShowAddTool(false)
    await loadToolDefs()
  }

  async function deleteCustomTool(id: string) {
    await api().tools.deleteTool(id)
    setToolsField('activeToolIds', (config.tools?.activeToolIds ?? []).filter(t => t !== id))
    await loadToolDefs()
  }

  async function addCustomGroup() {
    const name = newGroupName.trim()
    if (!name || newGroupToolIds.length === 0) return
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    await api().tools.addGroup({ id, name, description: newGroupDesc.trim(), toolIds: newGroupToolIds })
    setNewGroupName(''); setNewGroupDesc(''); setNewGroupToolIds([]); setShowAddGroup(false)
    await loadToolDefs()
  }

  async function deleteCustomGroup(id: string) {
    await api().tools.deleteGroup(id)
    setToolsField('activeGroupIds', (config.tools?.activeGroupIds ?? []).filter(g => g !== id))
    await loadToolDefs()
  }

  // --- External MCP servers ---

  async function loadExternalServers() {
    try {
      const a = getAPI()
      if (!a) return
      const servers = await a.mcp.listExternal()
      setExternalServers(servers)
    } catch { /* unavailable */ }
  }

  async function addExternalMcpServer() {
    const name = newExtName.trim()
    const url = newExtUrl.trim()
    if (!name || !url) return
    const server = await api().mcp.addExternal({ name, url, enabled: true })
    setExternalServers(prev => [...prev, server])
    setNewExtName(''); setNewExtUrl(''); setShowAddExternal(false)
  }

  async function removeExternalMcpServer(id: string) {
    await api().mcp.removeExternal(id)
    setExternalServers(prev => prev.filter(s => s.id !== id))
    setMcpTestResults(prev => { const n = { ...prev }; delete n[id]; return n })
  }

  async function testExternalMcpServer(id: string, url: string) {
    setMcpTestResults(prev => ({ ...prev, [id]: { ok: false, message: 'Testing…' } }))
    const result = await api().mcp.testExternal(url)
    setMcpTestResults(prev => ({ ...prev, [id]: result }))
  }

  // --- Hardware scan ---

  async function scanHardware() {
    const specs = await api().hardware.scan()
    setHardware(specs)
    setConfig(prev => ({
      ...prev,
      threads: specs.cpu.threads || 4,
      // gpuLayers left unset — llama-server's own --fit picks the real value
      // live against actual free VRAM and the model's tensor sizes, which a
      // flat guess here can't match.
      gpuLayers: undefined,
    }))
  }

  // --- Binary selection ---

  async function selectBinary() {
    const p = await api().settings.selectBinary()
    if (p) {
      await api().settings.setBinaryPath(p)
      setBinaryPath(p)
    }
  }

  async function clearBinaryOverride() {
    await api().settings.setBinaryPath(null)
    const resolved = await api().settings.getResolvedBinary()
    setBinaryPath(resolved)
  }

  // --- Model selection ---

  async function selectModel() {
    const p = await api().hardware.selectModel()
    if (p) setConfig(prev => ({ ...prev, modelPath: p }))
  }

  // --- Status polling ---

  // I poll the server health every 3 seconds rather than relying on an event
  // because llama-server doesn't push status updates — I have to ask. The
  // configRef pattern is needed because setInterval closes over the initial
  // config value; without the ref, the poll would always use stale config.
  function startStatusPoll() {
    stopStatusPoll()
    statusPollRef.current = setInterval(async () => {
      const s = await api().server.status(configRef.current)
      setHealth(s.health)
    }, 3000)
  }

  function stopStatusPoll() {
    if (statusPollRef.current) { clearInterval(statusPollRef.current); statusPollRef.current = null }
  }

  // --- Launch ---

  async function launchServer() {
    setServerState('starting')
    setStatusMsg('')
    setLogLines([])
    setActiveTab('server')

    {
      const a = getAPI()
      a?.events.onServerLog(line => {
        if (line.trim()) setLogLines(prev => [...prev.slice(-1000), line])
      })
    }

    const result = await api().llama.launch(config)
    if (result.success) {
      setServerState('running')
      setHealth('starting')
      startStatusPoll()
    } else {
      setServerState('stopped')
      setStatusMsg(`Launch error: ${result.error}`)
      getAPI()?.events.offServerLog()
    }
  }

  // --- Stop ---

  // I added a two-step confirmation for stopping the server because clicking
  // stop mid-generation kills the response immediately with no way to recover
  // it. The extra click is a small annoyance but prevents accidental data loss.
  function requestStopServer() {
    setConfirmStop(true)
  }

  async function confirmStopServer() {
    setConfirmStop(false)
    isUserStopRef.current = true
    setServerState('stopping')
    setStatusMsg('Stopping server…')
    await api().server.stop(config)
    // onServerStopped handles state cleanup and the "Server stopped." message
  }

  // --- Command preview ---

  async function generateCommand() {
    const cmd = await api().llama.generateCommand(config)
    setGeneratedCommand(cmd)
  }

  // --- Derived state ---

  const isRunning = serverState === 'running'
  const isStopping = serverState === 'stopping'
  const isStarting = serverState === 'starting'
  const canLaunch = serverState === 'stopped' && !!config.modelPath

  const healthColor =
    health === 'ok' ? 'text-orange-400' :
    health === 'no slot available' ? 'text-amber-400' :
    health === 'starting' ? 'text-orange-300' : 'text-zinc-500'

  const healthLabel =
    health === 'ok' ? 'Idle' :
    health === 'no slot available' ? 'Processing' :
    health === 'starting' ? 'Starting…' :
    health === 'unreachable' ? 'Unreachable' :
    health ?? '—'

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white font-mono text-sm overflow-hidden">

      {/* ── Top bar ── */}
      <header className="flex items-center justify-between px-5 py-3 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <h1 className="text-lg font-bold tracking-wide">
          Redstart <span className="text-orange-500">/ LlamaCpp Launcher</span>
        </h1>
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-orange-500' : isStopping || isStarting ? 'bg-amber-400' : 'bg-zinc-600'}`} />
            <span className="text-xs uppercase tracking-widest text-zinc-400">
              {serverState === 'running' ? healthLabel : serverState === 'stopping' ? 'Stopping…' : serverState === 'starting' ? 'Starting…' : 'Stopped'}
            </span>
          </div>
          {isRunning && (
            <div className="text-xs text-zinc-400">
              <span className="text-orange-400 font-semibold">{tokensPerMin.toLocaleString()}</span> tok/min
            </div>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">

        {/* ── Sidebar ── */}
        <aside className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col gap-5 p-4 overflow-y-auto shrink-0">

          {/* Hardware */}
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Hardware</h2>
            <button onClick={scanHardware}
              className="w-full px-3 py-2 bg-orange-500 hover:bg-orange-400 text-white rounded text-xs font-semibold transition-colors">
              Scan Hardware
            </button>
            {hardware && (
              <div className="mt-3 space-y-1 text-xs text-zinc-400">
                <div><span className="text-white">{hardware.cpu.name || 'CPU'}</span> — {hardware.cpu.cores}C / {hardware.cpu.threads}T</div>
                <div><span className="text-white">{hardware.gpu.name || 'GPU'}</span> — {hardware.gpu.vram} MB {hardware.gpu.cudaAvailable ? '· CUDA' : ''}</div>
                <div><span className="text-white">RAM</span> — {hardware.memory.total.toFixed(1)} GB</div>
              </div>
            )}
            {hardware && (
              <button onClick={generateDefaultProfiles}
                className="mt-2 w-full px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-xs transition-colors">
                Generate Default Profiles
              </button>
            )}
          </section>

          {/* Profiles */}
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Profiles</h2>
            {profiles.length > 0 ? (
              <select
                value={selectedProfile}
                onChange={e => selectProfile(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-orange-500">
                <option value="">— select profile —</option>
                {profiles.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            ) : (
              <p className="text-xs text-zinc-600">No profiles saved yet.</p>
            )}
            {!showSaveInput ? (
              <button onClick={() => { setSaveProfileName(selectedProfile); setShowSaveInput(true) }}
                className="mt-2 w-full px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-xs transition-colors">
                Save Current as Profile
              </button>
            ) : (
              <div className="mt-2 flex gap-1">
                <input
                  autoFocus
                  value={saveProfileName}
                  onChange={e => setSaveProfileName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveProfile(); if (e.key === 'Escape') setShowSaveInput(false) }}
                  placeholder="Profile name"
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-orange-500"
                />
                <button onClick={saveProfile} className="px-2 py-1 bg-orange-500 hover:bg-orange-400 rounded text-xs transition-colors">✓</button>
                <button onClick={() => setShowSaveInput(false)} className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">✕</button>
              </div>
            )}
          </section>

          {/* Server Binary */}
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Server Binary</h2>
            <button onClick={selectBinary}
              className="w-full px-3 py-2 bg-orange-500 hover:bg-orange-400 text-white rounded text-xs font-semibold transition-colors">
              Select llama-server.exe
            </button>
            {binaryPath ? (
              <div className="mt-2 space-y-1">
                <p className="text-xs text-zinc-400 break-all">{binaryPath}</p>
                <button onClick={clearBinaryOverride}
                  className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors underline">
                  Reset to auto-detect
                </button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-red-400">Not found — select binary above</p>
            )}
          </section>

          {/* Model */}
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Model</h2>
            <button onClick={selectModel}
              className="w-full px-3 py-2 bg-orange-500 hover:bg-orange-400 text-white rounded text-xs font-semibold transition-colors">
              Select .gguf File
            </button>
            {config.modelPath && (
              <p className="mt-2 text-xs text-zinc-400 break-all">{config.modelPath}</p>
            )}
          </section>

          {/* Network mode */}
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Network</h2>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <div
                onClick={() => setNetworkMode(v => !v)}
                className={`w-10 h-5 rounded-full transition-colors relative ${networkMode ? 'bg-orange-500' : 'bg-zinc-700'}`}>
                   <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${networkMode ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-xs text-zinc-300">{networkMode ? 'Local network (HTTP)' : 'Localhost only'}</span>
            </label>

            {networkMode && (
              <div className="mt-3 space-y-2">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Advertised hostname <span className="text-zinc-600">(blank = auto-detect IP)</span></label>
                  <input
                    type="text"
                    value={advertisedHost}
                    onChange={e => setAdvertisedHost(e.target.value)}
                    placeholder="e.g. redstart.local"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-600"
                  />
                  <p className="text-[10px] text-zinc-600 mt-1">Use a hostname like redstart.local for mDNS, or a custom IP. Leave blank to use the detected device IP.</p>
                </div>
                <div className="text-xs text-zinc-400">
                  Server address: <span className="text-orange-400 font-semibold">{(advertisedHost || localIp)}:{config.port}</span>
                  {advertisedHost && <span className="text-zinc-500 ml-1">(mDNS: {advertisedHost})</span>}
                </div>
                {qrDataUrl && (
                  <div>
                    <p className="text-xs text-zinc-500 mb-1">Scan with Android camera to open Redstart Twig and connect automatically:</p>
                    <img src={qrDataUrl} alt="Connection QR" className="rounded bg-white p-1" />
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Account management */}
          <section>
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Accounts</h2>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <div
                onClick={toggleAuthRequired}
                className={`w-10 h-5 rounded-full transition-colors relative ${authRequired ? 'bg-orange-500' : 'bg-zinc-700'}`}>
                   <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${authRequired ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-xs text-zinc-300">{authRequired ? 'Require login' : 'Login not required'}</span>
            </label>
            <p className="mt-1 text-xs text-zinc-600">Requests from this PC are always exempt — only LAN/remote clients are gated.</p>

            {confirmEnableAuthNoAdmin && (
              <div className="mt-2 rounded-lg border border-amber-800 bg-zinc-900 px-3 py-2 space-y-2">
                <p className="text-xs text-amber-400">No owner account exists yet — LAN/remote users won't be able to log in until you create one below. Enable anyway?</p>
                <div className="flex gap-2">
                  <button onClick={() => applyAuthRequired(true)}
                    className="flex-1 px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded text-xs font-semibold transition-colors">
                    Enable Anyway
                  </button>
                  <button onClick={() => setConfirmEnableAuthNoAdmin(false)}
                    className="flex-1 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-xs transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {!hasOwnerAccount && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-zinc-500">Create the owner account — the one sys-admin account that can create/remove Admin accounts. Admins then manage regular Users from the chat UI's Accounts tab.</p>
                <input
                  value={bootstrapUsername}
                  onChange={e => setBootstrapUsername(e.target.value)}
                  placeholder="Owner username"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-orange-500 placeholder:text-zinc-600"
                />
                <input
                  type="password"
                  value={bootstrapPassword}
                  onChange={e => setBootstrapPassword(e.target.value)}
                  placeholder="Owner password"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-orange-500 placeholder:text-zinc-600"
                />
                <button onClick={createFirstAdmin}
                  disabled={!bootstrapUsername.trim() || !bootstrapPassword}
                  className="w-full px-3 py-1.5 bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white rounded text-xs font-semibold transition-colors">
                  Create Owner Account
                </button>
              </div>
            )}

            {revealedApiKey && (
              <div className="mt-3 rounded-lg border border-orange-800 bg-zinc-900 px-3 py-2 space-y-1">
                <p className="text-xs text-orange-400">API key (also works as a Kilo Code / Continue Bearer token) — shown once, copy it now:</p>
                <div className="flex gap-1">
                  <code className="flex-1 text-xs text-zinc-200 bg-zinc-800 rounded px-2 py-1 break-all">{revealedApiKey}</code>
                  <button onClick={() => navigator.clipboard.writeText(revealedApiKey)}
                    className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">Copy</button>
                </div>
                <button onClick={() => setRevealedApiKey(null)} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors underline">Dismiss</button>
              </div>
            )}
          </section>
        </aside>

        {/* ── Main content ── */}
        <main className="flex-1 flex flex-col overflow-y-auto p-5 gap-5">

          {/* ── Tab bar (browser-style) ── */}
          <div className="flex items-end gap-1 border-b border-zinc-800 -mx-5 px-5 -mt-2 pt-2 sticky top-0 bg-zinc-950 z-10">
            {([
              ['config', 'Configuration'],
              ['tools', 'Tools'],
              ['server', 'Server'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`px-4 py-2 rounded-t-lg text-sm border border-b-0 transition-colors flex items-center gap-2 ${
                  activeTab === id
                    ? 'bg-zinc-900 border-zinc-800 text-white'
                    : 'bg-transparent border-transparent text-zinc-500 hover:text-zinc-300'
                }`}>
                {label}
                {id === 'server' && serverState !== 'stopped' && (
                  <span className={`w-1.5 h-1.5 rounded-full ${serverState === 'running' ? 'bg-green-400' : 'bg-amber-400 animate-pulse'}`} />
                )}
              </button>
            ))}
          </div>

          {/* Config grid */}
          {activeTab === 'config' && (
          <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
            <h2 className="text-xs uppercase tracking-widest text-zinc-500 mb-4">Configuration</h2>
            <div className="grid grid-cols-3 gap-4">
              {([
                ['ctxSize', 'Context Size'],
                ['batchSize', 'Batch Size'],
                ['threads', 'Threads'],
                ['port', 'Port'],
              ] as [keyof LlamaConfig, string][]).map(([field, label]) => (
                <div key={field}>
                  <label className="block text-xs text-zinc-500 mb-1">{label}</label>
                  <input
                    type="number"
                    value={config[field] as number}
                    onChange={e => setConfig(prev => ({ ...prev, [field]: parseInt(e.target.value) || 0 }))}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 transition-colors"
                  />
                </div>
              ))}
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Host</label>
                <input
                  type="text"
                  value={networkMode ? '0.0.0.0' : config.host}
                  readOnly={networkMode}
                  onChange={e => setConfig(prev => ({ ...prev, host: e.target.value }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 transition-colors read-only:opacity-50"
                />
              </div>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-4">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">GPU Layers <span className="text-zinc-600">(blank = auto)</span></label>
                <input
                  type="number"
                  value={config.gpuLayers ?? ''}
                  onChange={e => {
                    const v = parseInt(e.target.value)
                    setConfig(prev => ({ ...prev, gpuLayers: isNaN(v) || v < 0 ? undefined : v }))
                  }}
                  placeholder="Auto (recommended)"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-600"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">N-CPU-MoE <span className="text-zinc-600">(MoE models only, blank = auto)</span></label>
                <input
                  type="number"
                  value={config.nCpuMoe ?? ''}
                  onChange={e => {
                    const v = parseInt(e.target.value)
                    setConfig(prev => ({ ...prev, nCpuMoe: isNaN(v) || v < 0 ? undefined : v }))
                  }}
                  placeholder="Auto (recommended)"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-600"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Process Priority</label>
                <select
                  value={config.priority ?? 'normal'}
                  onChange={e => setConfig(prev => ({ ...prev, priority: e.target.value === 'high' ? 'high' : undefined }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 transition-colors"
                >
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Mmap</label>
                <label className="flex items-center gap-2 h-[34px] px-2 cursor-pointer select-none text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={!!config.noMmap}
                    onChange={e => setConfig(prev => ({ ...prev, noMmap: e.target.checked }))}
                    className="accent-orange-500"
                  />
                  Disable (--no-mmap)
                </label>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  KV Cache <span className="text-zinc-600">(TurboQuant)</span>
                </label>
                <select
                  value={config.kvCache ?? 'off'}
                  onChange={e => setConfig(prev => ({ ...prev, kvCache: e.target.value as LlamaConfig['kvCache'] }))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 transition-colors"
                >
                  <option value="off">Off (f16 — largest VRAM)</option>
                  <option value="conservative">Conservative — q8_0 / turbo4</option>
                  <option value="balanced">Balanced — q8_0 / turbo3 (recommended)</option>
                  <option value="aggressive">Aggressive (MoE) — q8_0 / turbo2</option>
                </select>
              </div>
              <div className="col-span-2 flex items-end">
                <p className="text-xs text-zinc-500 leading-relaxed">
                  {config.kvCache === 'off'
                    ? 'Full-precision f16 KV cache. Largest memory footprint — context is capped by VRAM.'
                    : config.kvCache === 'conservative'
                    ? 'Lightest turbo tier. Near-identical to f16; a modest KV memory win.'
                    : config.kvCache === 'aggressive'
                    ? '~2-bit V with Boundary V layer protection — best for MoE models like Qwen3.6. Fits the most context; validate quality on your model.'
                    : 'Near-lossless K, ~4.6× compressed V (<1.5% PPL loss). Total KV ~3–4× smaller than f16 — lets you roughly 3–4× the context on the same card.'}
                </p>
              </div>
            </div>

            <div className="mt-4">
              <label className="block text-xs text-zinc-500 mb-1">Additional args</label>
              <input
                type="text"
                value={config.additionalArgs ?? ''}
                onChange={e => setConfig(prev => ({ ...prev, additionalArgs: e.target.value }))}
                placeholder="Extra flags for llama-server"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 transition-colors placeholder:text-zinc-600"
              />
            </div>
          </section>

          )}

          {/* Tools (Web Sources + MCP) */}
          {activeTab === 'tools' && (
          <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs uppercase tracking-widest text-zinc-500">Tools</h2>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <span className="text-xs text-zinc-400">{config.tools?.enabled ? 'Enabled' : 'Disabled'}</span>
                <div
                  onClick={() => setToolsField('enabled', !(config.tools?.enabled))}
                  className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${config.tools?.enabled ? 'bg-orange-500' : 'bg-zinc-700'}`}>
                   <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${config.tools?.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                </div>
              </label>
            </div>

            {config.tools?.enabled ? (<>
              {/* Whitelist toggle — restriction is the default posture */}
              <div className="mb-4 flex items-center justify-between px-3 py-2 bg-zinc-800/60 rounded">
                <div>
                  <p className="text-sm text-zinc-200">Restrict to approved sources</p>
                  <p className="text-xs text-zinc-500">
                    {config.tools?.whitelistEnabled !== false
                      ? 'The model can only fetch from the sources selected below.'
                      : 'Whitelist off — the model can fetch any public website. Local network addresses are always blocked.'}
                  </p>
                </div>
                <button
                  onClick={() => setToolsField('whitelistEnabled', config.tools?.whitelistEnabled === false)}
                  className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer flex-shrink-0 ${config.tools?.whitelistEnabled !== false ? 'bg-orange-500' : 'bg-zinc-700'}`}>
                   <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${config.tools?.whitelistEnabled !== false ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {config.tools?.whitelistEnabled === false && (
                <div className="mb-4 px-3 py-2 rounded text-xs border bg-yellow-900/30 border-yellow-700 text-yellow-300">
                  ⚠ Open web access: the model can reach any public site, including ones you haven't reviewed. Fetched pages can contain wrong or manipulative content. Sources selected below still power web_search and the model's source hints.
                </div>
              )}

              {/* Performance warning */}
              <div className={`mb-4 px-3 py-2 rounded text-xs border ${
                config.ctxSize < 4096
                  ? 'bg-red-900/30 border-red-700 text-red-300'
                  : config.ctxSize < 8192
                  ? 'bg-yellow-900/30 border-yellow-700 text-yellow-300'
                  : 'bg-zinc-800 border-zinc-700 text-zinc-400'
              }`}>
                {config.ctxSize < 4096
                  ? `⚠ Context is very small (${config.ctxSize} tokens). Tool fetches may fill it completely. Increase context size or keep tools off.`
                  : config.ctxSize < 8192
                  ? `⚠ Small context (${config.ctxSize} tokens). Fetched content may use most of it. Consider 8192+ for tool use.`
                  : `ⓘ Tool calls add ~2–5 s latency per lookup. The response appears after all fetches complete.`
                }
              </div>

              <div className="grid grid-cols-2 gap-6">
                {/* Left column: Groups */}
                <div>
                  <p className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Source Groups</p>

                  <div className="space-y-2 mb-4">
                    {allGroups.filter(g => g.builtIn).map(group => {
                      const active = config.tools?.activeGroupIds?.includes(group.id) ?? false
                      return (
                        <label key={group.id} className="flex items-start gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox" checked={active}
                            onChange={() => toggleGroup(group.id)}
                            className="mt-0.5 accent-orange-500"
                          />
                          <div>
                            <span className="text-sm text-zinc-200">{group.name}</span>
                            <span className="text-xs text-zinc-500 ml-2">{group.description}</span>
                          </div>
                        </label>
                      )
                    })}
                  </div>

                  {allGroups.filter(g => !g.builtIn).length > 0 && (<>
                    <p className="text-xs text-zinc-500 mb-2">Custom groups</p>
                    <div className="space-y-1 mb-3">
                      {allGroups.filter(g => !g.builtIn).map(group => {
                        const active = config.tools?.activeGroupIds?.includes(group.id) ?? false
                        return (
                          <div key={group.id} className="flex items-center gap-2">
                            <label className="flex items-center gap-2 cursor-pointer select-none flex-1">
                              <input type="checkbox" checked={active} onChange={() => toggleGroup(group.id)} className="accent-orange-500" />
                              <span className="text-sm text-zinc-200">{group.name}</span>
                            </label>
                            <button onClick={() => deleteCustomGroup(group.id)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors px-1">✕</button>
                          </div>
                        )
                      })}
                    </div>
                  </>)}

                  {!showAddGroup ? (
                    <button onClick={() => setShowAddGroup(true)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                      + Create custom group
                    </button>
                  ) : (
                    <div className="space-y-2 bg-zinc-800/60 p-3 rounded border border-zinc-700">
                      <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
                        placeholder="Group name" className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                      <input value={newGroupDesc} onChange={e => setNewGroupDesc(e.target.value)}
                        placeholder="Description (optional)" className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                      <p className="text-xs text-zinc-500">Select sources for this group:</p>
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                         {allTools.filter(t => t.kind === 'web').map(tool => (
                           <label key={tool.id} className="flex items-center gap-2 cursor-pointer select-none">
                             <input type="checkbox" checked={newGroupToolIds.includes(tool.id)}
                               onChange={() => setNewGroupToolIds(prev => prev.includes(tool.id) ? prev.filter(id => id !== tool.id) : [...prev, tool.id])}
                               className="accent-orange-500" />
                             <span className="text-sm text-zinc-300">{tool.name}</span>
                           </label>
                         ))}
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button onClick={addCustomGroup} className="px-3 py-1.5 bg-orange-500 hover:bg-orange-400 rounded text-xs font-medium transition-colors">Save group</button>
                        <button onClick={() => { setShowAddGroup(false); setNewGroupName(''); setNewGroupToolIds([]) }} className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Right column: Individual sources */}
                <div>
                  <p className="text-xs uppercase tracking-widest text-zinc-500 mb-2">Individual Sources</p>
                  <div className="space-y-1.5 mb-4">
                    {allTools.filter(t => t.kind === 'web').map(tool => {
                      const inActiveGroup = (config.tools?.activeGroupIds ?? []).some(gid => {
                        const grp = allGroups.find(g => g.id === gid)
                        return grp?.toolIds.includes(tool.id)
                      })
                      const active = (config.tools?.activeToolIds?.includes(tool.id) ?? false) || inActiveGroup
                      return (
                        <div key={tool.id} className="flex items-center gap-2">
                          <label className={`flex items-center gap-2 cursor-pointer select-none flex-1 ${inActiveGroup ? 'opacity-50' : ''}`}>
                            <input type="checkbox" checked={active} disabled={inActiveGroup}
                              onChange={() => toggleTool(tool.id)} className="accent-orange-500" />
                            <div className="min-w-0">
                              <span className="text-sm text-zinc-200">{tool.name}</span>
                              {inActiveGroup && <span className="text-xs text-zinc-600 ml-2">(via group)</span>}
                              {tool.builtIn && !inActiveGroup && tool.kind === 'capability' &&
                                <span className="text-xs text-zinc-600 ml-2">{tool.id === 'postgres' ? 'Local database' : 'Local file output'}</span>}
                              {tool.builtIn && !inActiveGroup && tool.kind !== 'capability' && <span className="text-xs text-zinc-600 ml-2">{tool.baseUrl}</span>}
                            </div>
                          </label>
                          {!tool.builtIn && (
                            <button onClick={() => deleteCustomTool(tool.id)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors flex-shrink-0 px-1">✕</button>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {!showAddTool ? (
                    <button onClick={() => setShowAddTool(true)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-4 block">
                      + Add custom source
                    </button>
                  ) : (
                    <div className="space-y-2 bg-zinc-800/60 p-3 rounded border border-zinc-700 mb-4">
                      <input value={newToolName} onChange={e => setNewToolName(e.target.value)}
                        placeholder="Source name" className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                      <input value={newToolUrl} onChange={e => setNewToolUrl(e.target.value)}
                        placeholder="Base URL (e.g. https://example.com)" className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                      <input value={newToolDesc} onChange={e => setNewToolDesc(e.target.value)}
                        placeholder="Description (optional)" className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                      <div className="flex gap-2 pt-1">
                        <button onClick={addCustomTool} className="px-3 py-1.5 bg-orange-500 hover:bg-orange-400 rounded text-xs font-medium transition-colors">Save source</button>
                        <button onClick={() => { setShowAddTool(false); setNewToolName(''); setNewToolUrl(''); setNewToolDesc('') }} className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">Cancel</button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-3">
                    <label className="text-xs text-zinc-400 whitespace-nowrap">Max tokens per fetch</label>
                    <input
                      type="number" min={500} max={8000} step={500}
                      value={config.tools?.maxFetchTokens ?? 2000}
                      onChange={e => setToolsField('maxFetchTokens', Math.max(500, Math.min(8000, parseInt(e.target.value) || 2000)))}
                      className="w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500"
                    />
                    <span className="text-xs text-zinc-600">of {config.ctxSize} ctx tokens</span>
                  </div>

                  {toolContextEstimate && toolContextEstimate.toolCount > 0 && (
                    <p className={`text-xs mt-2 ${
                      toolContextEstimate.approxTokens > config.ctxSize * 0.25 ? 'text-amber-400' : 'text-zinc-500'
                    }`}>
                      {toolContextEstimate.toolCount} active tool{toolContextEstimate.toolCount === 1 ? '' : 's'} ≈ {toolContextEstimate.approxTokens.toLocaleString()} tokens of context on every request
                      {toolContextEstimate.approxTokens > config.ctxSize * 0.25
                        ? ` — over a quarter of your ${config.ctxSize.toLocaleString()}-token window. Consider activating fewer tools per profile.`
                        : ''}
                    </p>
                  )}
                </div>
              </div>

              {/* Capability configuration (Postgres, Documents, SQLite, Vault, Git, Scholar) — global setup, activated per-profile above */}
              <div className="mt-6 pt-4 border-t border-zinc-700">
                <p className="text-xs uppercase tracking-widest text-zinc-500 mb-3">Local Capabilities</p>

                <div className="space-y-4">
                  {/* Postgres */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">Postgres</span>
                      <span className={`text-xs ${
                        capabilityConfig?.postgres.hasConnectionString
                          ? (capabilityConfig.postgres.enabled ? 'text-green-400' : 'text-zinc-500')
                          : 'text-zinc-600'
                      }`}>
                        {capabilityConfig?.postgres.hasConnectionString
                          ? (capabilityConfig.postgres.enabled ? 'Configured · Enabled' : 'Configured · Disabled')
                          : 'Not configured'}
                      </span>
                    </div>
                    <div className="flex gap-2 mb-1.5">
                      <input
                        type="password" value={pgConnectionString} onChange={e => setPgConnectionString(e.target.value)}
                        placeholder={capabilityConfig?.postgres.hasConnectionString ? 'postgresql://... (leave blank to keep current)' : 'postgresql://user:pass@host:5432/db'}
                        className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                      <input
                        type="number" min={10} max={5000} step={10} value={pgMaxRows}
                        onChange={e => setPgMaxRows(Math.max(10, Math.min(5000, parseInt(e.target.value) || 200)))}
                        title="Max rows returned per query"
                        className="w-20 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={testPostgresConnection} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">Test connection</button>
                      <button onClick={savePostgresConfig} disabled={pgSaving} className="px-2.5 py-1 bg-orange-500 hover:bg-orange-400 disabled:opacity-50 rounded text-xs font-medium transition-colors">
                        {pgSaving ? 'Saving…' : 'Save'}
                      </button>
                      {capabilityConfig?.postgres.hasConnectionString && (
                        <button onClick={togglePostgresEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">
                          {capabilityConfig.postgres.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                      {pgTestResult && (
                        <span className={`text-xs ${pgTestResult.ok ? 'text-green-400' : 'text-red-400'}`}>{pgTestResult.message}</span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">Queries run read-only. Use a database role with read-only grants for defense in depth.</p>
                  </div>

                  {/* Documents */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">Documents</span>
                      <span className={`text-xs ${capabilityConfig?.documents.outputDir ? (capabilityConfig.documents.enabled ? 'text-green-400' : 'text-zinc-500') : 'text-zinc-600'}`}>
                        {capabilityConfig?.documents.outputDir ? (capabilityConfig.documents.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
                        {capabilityConfig?.documents.outputDir || 'No output folder chosen'}
                      </span>
                      <button onClick={chooseDocumentsFolder} disabled={docsSaving} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded text-xs transition-colors flex-shrink-0">
                        Choose folder…
                      </button>
                      {capabilityConfig?.documents.outputDir && (
                        <button onClick={toggleDocumentsEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                          {capabilityConfig.documents.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">The model can create documents in this folder and read documents and spreadsheets (.pdf, .docx, .txt, .md, .xlsx, .csv) you place in it. All extraction happens on-device.</p>
                  </div>

                  {/* SQLite */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">SQLite</span>
                      <span className={`text-xs ${capabilityConfig?.sqlite.rootDir ? (capabilityConfig.sqlite.enabled ? 'text-green-400' : 'text-zinc-500') : 'text-zinc-600'}`}>
                        {capabilityConfig?.sqlite.rootDir ? (capabilityConfig.sqlite.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
                        {capabilityConfig?.sqlite.rootDir || 'No database folder chosen'}
                      </span>
                      <button onClick={chooseSqliteFolder} disabled={sqliteSaving} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded text-xs transition-colors flex-shrink-0">
                        Choose folder…
                      </button>
                      {capabilityConfig?.sqlite.rootDir && (
                        <button onClick={toggleSqliteEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                          {capabilityConfig.sqlite.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">Read-only queries against .sqlite/.db files in the chosen folder. The files are never opened for writing.</p>
                  </div>

                  {/* Vault */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">Vault</span>
                      <span className={`text-xs ${capabilityConfig?.vault.rootDir ? (capabilityConfig.vault.enabled ? 'text-green-400' : 'text-zinc-500') : 'text-zinc-600'}`}>
                        {capabilityConfig?.vault.rootDir ? (capabilityConfig.vault.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
                        {capabilityConfig?.vault.rootDir || 'No notes folder chosen'}
                      </span>
                      <button onClick={chooseVaultFolder} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                        Choose folder…
                      </button>
                      {capabilityConfig?.vault.rootDir && (
                        <button onClick={toggleVaultEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                          {capabilityConfig.vault.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">Read-only search across markdown notes (Obsidian vault or any folder of .md files) — search, read notes, browse tags.</p>
                  </div>

                  {/* Git */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">Git</span>
                      <span className={`text-xs ${capabilityConfig?.git.rootDir ? (capabilityConfig.git.enabled ? 'text-green-400' : 'text-zinc-500') : 'text-zinc-600'}`}>
                        {capabilityConfig?.git.rootDir ? (capabilityConfig.git.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
                        {capabilityConfig?.git.rootDir || 'No repository folder chosen'}
                      </span>
                      <button onClick={chooseGitFolder} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                        Choose folder…
                      </button>
                      {capabilityConfig?.git.rootDir && (
                        <button onClick={toggleGitEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                          {capabilityConfig.git.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">Read-only repository context (status, recent commits, uncommitted diffs). Choose a repository or a folder containing repositories. Requires git on the server machine.</p>
                  </div>

                  {/* File System */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">File System</span>
                      <span className={`text-xs ${capabilityConfig?.file_system.rootDir ? (capabilityConfig.file_system.enabled ? 'text-green-400' : 'text-zinc-500') : 'text-zinc-600'}`}>
                        {capabilityConfig?.file_system.rootDir ? (capabilityConfig.file_system.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 text-xs text-zinc-400 truncate">
                        {capabilityConfig?.file_system.rootDir || 'No folder chosen'}
                      </span>
                      <button onClick={chooseFileSystemFolder} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                        Choose folder…
                      </button>
                      {capabilityConfig?.file_system.rootDir && (
                        <button onClick={toggleFileSystemEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                          {capabilityConfig.file_system.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">Read and write files within a chosen folder — read configs, write scripts, edit project files. Paths are contained to the chosen root.</p>
                  </div>

                  {/* Scholar */}
                  <div className="bg-zinc-800/40 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-zinc-200">Scholar</span>
                      <span className={`text-xs ${capabilityConfig?.scholar.enabled ? 'text-green-400' : 'text-zinc-500'}`}>
                        {capabilityConfig?.scholar.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <input
                        type="text" value={scholarVenueFilter} onChange={e => setScholarVenueFilter(e.target.value)}
                        placeholder="Optional venue whitelist: journal ISSNs and/or arXiv categories (e.g. 1932-6203, cs.CL)"
                        className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500 placeholder:text-zinc-600" />
                      <button onClick={saveScholarVenueFilter} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">Save filter</button>
                      <button onClick={toggleScholarEnabled} className="px-2.5 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors flex-shrink-0">
                        {capabilityConfig?.scholar.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                    <p className="text-xs text-zinc-600 mt-1.5">Search open academic literature (OpenAlex, arXiv, PubMed) and save open-access PDFs into the Documents folder. Leave the whitelist empty for all venues; when set, searches and downloads are restricted to those journals/categories at the API level.</p>
                  </div>
                </div>
              </div>
            </>) : (
              <p className="text-xs text-zinc-600">Enable web sources to allow the model to fetch live content from approved sites via the built-in MCP server. Settings are saved with the active profile.</p>
            )}

            {/* External MCP Servers */}
            <div className="mt-6 pt-4 border-t border-zinc-700">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs uppercase tracking-widest text-zinc-500">External MCP Servers</p>
                {!showAddExternal && (
                  <button
                    onClick={() => setShowAddExternal(true)}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                    + Add server
                  </button>
                )}
              </div>

              <div className="mb-3 px-3 py-2 bg-zinc-800/60 rounded text-xs text-zinc-400">
                <span className="text-zinc-300 font-medium">Built-in Redstart MCP:</span>{' '}
                {config.tools?.enabled
                  ? <span className="text-green-400">http://localhost:{(config.port ?? 19080) + 2}/sse</span>
                  : <span className="text-zinc-600">Starts with server (enable web sources above)</span>
                }
              </div>

              {externalServers.length === 0 && !showAddExternal && (
                <p className="text-xs text-zinc-600">No external MCP servers configured. Add a server URL to connect to an MCP server on another device.</p>
              )}

              <div className="space-y-2">
                {externalServers.map(server => (
                  <div key={server.id} className="flex items-start gap-2 bg-zinc-800/40 rounded px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-zinc-200">{server.name}</span>
                      <span className="text-xs text-zinc-500 ml-2 break-all">{server.url}</span>
                      {mcpTestResults[server.id] && (
                        <span className={`block text-xs mt-0.5 ${mcpTestResults[server.id].ok ? 'text-green-400' : 'text-red-400'}`}>
                          {mcpTestResults[server.id].message}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => testExternalMcpServer(server.id, server.url)}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-1 flex-shrink-0">
                      Test
                    </button>
                    <button
                      onClick={() => removeExternalMcpServer(server.id)}
                      className="text-xs text-zinc-600 hover:text-red-400 transition-colors px-1 flex-shrink-0">
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              {showAddExternal && (
                <div className="space-y-2 bg-zinc-800/60 p-3 rounded border border-zinc-700 mt-2">
                  <input
                    value={newExtName} onChange={e => setNewExtName(e.target.value)}
                    placeholder="Server name (e.g. Legal DB Server)"
                    className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                  <input
                    value={newExtUrl} onChange={e => setNewExtUrl(e.target.value)}
                    placeholder="SSE URL (e.g. http://10.0.0.5:9000/sse)"
                    className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500" />
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={addExternalMcpServer}
                      className="px-3 py-1.5 bg-orange-500 hover:bg-orange-400 rounded text-xs font-medium transition-colors">
                      Add server
                    </button>
                    <button
                      onClick={() => { setShowAddExternal(false); setNewExtName(''); setNewExtUrl('') }}
                      className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          )}

          {/* Command preview */}
          {activeTab === 'config' && (
          <section className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-xs uppercase tracking-widest text-zinc-500">Command Preview</h2>
              <button onClick={generateCommand}
                className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs transition-colors">
                Generate
              </button>
            </div>
            <pre className="text-xs text-orange-400 overflow-x-auto whitespace-pre-wrap break-all">
              {generatedCommand || 'Click Generate to preview the launch command'}
            </pre>
          </section>
          )}

          {/* Status message */}
          {statusMsg && (
            <div className="text-xs text-center text-zinc-400 px-4">{statusMsg}</div>
          )}

          {/* Launch / Stop */}
          <div className="flex items-center gap-3">
            {serverState === 'stopped' && (
              <button
                onClick={launchServer}
                disabled={!canLaunch}
                className="flex-1 py-3 bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed rounded-lg font-semibold text-sm transition-colors">
                {config.modelPath ? 'Launch LlamaCpp Server' : 'Select a model to launch'}
              </button>
            )}
            {serverState === 'starting' && (
              <div className="flex-1 py-3 bg-zinc-800 rounded-lg text-center text-sm text-orange-400 animate-pulse">
                Starting server…
              </div>
            )}
            {serverState === 'running' && !confirmStop && (
              <button
                onClick={requestStopServer}
                className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 hover:border-zinc-500 rounded-lg font-semibold text-sm text-white transition-colors">
                Stop Server
              </button>
            )}
            {serverState === 'running' && confirmStop && (
              <div className="flex flex-1 items-center gap-3 rounded-lg border border-amber-800 bg-zinc-900 px-4 py-2">
                <span className="flex-1 text-xs text-amber-400">Stop now? Any active generation will be interrupted.</span>
                <button
                  onClick={confirmStopServer}
                  className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded text-xs font-semibold transition-colors">
                  Stop Now
                </button>
                <button
                  onClick={() => setConfirmStop(false)}
                  className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-xs transition-colors">
                  Cancel
                </button>
              </div>
            )}
            {serverState === 'stopping' && (
              <div className="flex-1 py-3 bg-zinc-800 rounded-lg text-center text-sm text-amber-400 animate-pulse">
                Stopping server…
              </div>
            )}

          </div>

          {/* ── Server tab: health + terminal ── */}
          {activeTab === 'server' && (
            <>
              {isRunning && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex items-center justify-between">
                  <span className="text-xs text-zinc-500">Server health</span>
                  <span className={`text-xs font-semibold ${healthColor}`}>{healthLabel}</span>
                </div>
              )}

              <section className="flex flex-col flex-1 min-h-64 bg-black rounded-lg border border-zinc-800 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 shrink-0">
                  <span className="text-xs text-zinc-500 uppercase tracking-widest">Server Terminal</span>
                  <button
                    onClick={() => setLogLines([])}
                    className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
                    Clear
                  </button>
                </div>
                <div className="flex-1 min-h-56 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
                  {serverState === 'stopped' && logLines.length === 0 ? (
                    <span className="text-zinc-600">Server is not running. Launch it to see output here.</span>
                  ) : logLines.length === 0 ? (
                    <span className="text-zinc-600">Waiting for output…</span>
                  ) : (
                    logLines.map((line, i) => (
                      <div key={i} className={`whitespace-pre-wrap break-all ${
                        /error|fail|warn/i.test(line) ? 'text-red-400' :
                        /load|ready|listen/i.test(line) ? 'text-orange-400' :
                        'text-zinc-300'
                      }`}>{line}</div>
                    ))
                  )}
                  <div ref={logEndRef} />
                </div>
              </section>
            </>
          )}

        </main>
      </div>
    </div>
  )
}
