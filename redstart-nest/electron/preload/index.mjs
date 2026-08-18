const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('redstartAPI', {
  hardware: {
    scan: () => ipcRenderer.invoke('hardware:scan'),
    selectModel: () => ipcRenderer.invoke('hardware:select-model'),
  },

  llama: {
    generateCommand: (config) => ipcRenderer.invoke('llama:generate-command', config),
    launch: (config, showTerminal, openChat) => ipcRenderer.invoke('llama:launch', config, showTerminal, openChat),
  },

  server: {
    stop: (config) => ipcRenderer.invoke('server:stop', config),
    status: (config) => ipcRenderer.invoke('server:status', config),
    getIp: () => ipcRenderer.invoke('server:get-ip'),
  },

  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (name, config) => ipcRenderer.invoke('profiles:save', name, config),
    load: (name) => ipcRenderer.invoke('profiles:load', name),
    delete: (name) => ipcRenderer.invoke('profiles:delete', name),
    generateDefaults: (hardware) => ipcRenderer.invoke('profiles:generate-defaults', hardware),
  },

  tools: {
    listAll: () => ipcRenderer.invoke('tools:list-all'),
    addTool: (tool) => ipcRenderer.invoke('tools:add-tool', tool),
    deleteTool: (id) => ipcRenderer.invoke('tools:delete-tool', id),
    addGroup: (group) => ipcRenderer.invoke('tools:add-group', group),
    deleteGroup: (id) => ipcRenderer.invoke('tools:delete-group', id),
    applyConfig: (config) => ipcRenderer.invoke('tools:apply-config', config),
  },

  mcp: {
    listExternal: () => ipcRenderer.invoke('mcp:list-external'),
    addExternal: (server) => ipcRenderer.invoke('mcp:add-external', server),
    validateExternal: (url) => ipcRenderer.invoke('mcp:validate-external', url),
    removeExternal: (id) => ipcRenderer.invoke('mcp:remove-external', id),
    testExternal: (server) => ipcRenderer.invoke('mcp:test-external', server),
  },

  capabilities: {
    get: () => ipcRenderer.invoke('capabilities:get'),
    setPostgres: (config) => ipcRenderer.invoke('capabilities:set-postgres', config),
    testPostgres: (connectionString) => ipcRenderer.invoke('capabilities:test-postgres', connectionString),
    selectDocumentsFolder: () => ipcRenderer.invoke('capabilities:select-documents-folder'),
    setDocumentsFolder: (config) => ipcRenderer.invoke('capabilities:set-documents-folder', config),
    selectSqliteFolder: () => ipcRenderer.invoke('capabilities:select-sqlite-folder'),
    setSqlite: (config) => ipcRenderer.invoke('capabilities:set-sqlite', config),
    estimateToolContext: (config) => ipcRenderer.invoke('tools:estimate-context', config),
    selectVaultFolder: () => ipcRenderer.invoke('capabilities:select-vault-folder'),
    setVault: (config) => ipcRenderer.invoke('capabilities:set-vault', config),
    selectGitFolder: () => ipcRenderer.invoke('capabilities:select-git-folder'),
    setGit: (config) => ipcRenderer.invoke('capabilities:set-git', config),
    selectFileSystemFolder: () => ipcRenderer.invoke('capabilities:select-file-system-folder'),
    setFileSystem: (config) => ipcRenderer.invoke('capabilities:set-file-system', config),
    setScholar: (config) => ipcRenderer.invoke('capabilities:set-scholar', config),
  },

  settings: {
    getBinaryPath: () => ipcRenderer.invoke('settings:get-binary-path'),
    setBinaryPath: (p) => ipcRenderer.invoke('settings:set-binary-path', p),
    selectBinary: () => ipcRenderer.invoke('settings:select-binary'),
    getResolvedBinary: () => ipcRenderer.invoke('settings:get-resolved-binary'),
    getModelsDir: () => ipcRenderer.invoke('settings:get-models-dir'),
    setModelsDir: (p) => ipcRenderer.invoke('settings:set-models-dir', p),
    selectModelsDir: () => ipcRenderer.invoke('settings:select-models-dir'),
  },

  models: {
    publishers: () => ipcRenderer.invoke('models:publishers'),
    search: (opts) => ipcRenderer.invoke('models:search', opts),
    detail: (repoId) => ipcRenderer.invoke('models:detail', repoId),
    local: () => ipcRenderer.invoke('models:local'),
    diskSpace: () => ipcRenderer.invoke('models:disk-space'),
    revealFolder: () => ipcRenderer.invoke('models:reveal-folder'),
    deleteLocal: (name) => ipcRenderer.invoke('models:delete-local', name),
    download: (req) => ipcRenderer.invoke('models:download', req),
    cancelDownload: () => ipcRenderer.invoke('models:cancel-download'),
    downloadStatus: () => ipcRenderer.invoke('models:download-status'),
  },

  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    get: (id) => ipcRenderer.invoke('plugins:get', id),
    install: (req) => ipcRenderer.invoke('plugins:install', req),
    cancelInstall: () => ipcRenderer.invoke('plugins:cancel-install'),
    installStatus: () => ipcRenderer.invoke('plugins:install-status'),
    confirmInstall: (entry) => ipcRenderer.invoke('plugins:confirm-install', entry),
    setEnabled: (id, enabled) => ipcRenderer.invoke('plugins:set-enabled', id, enabled),
    setClass: (id, toolName, cls) => ipcRenderer.invoke('plugins:set-class', id, toolName, cls),
    uninstall: (id) => ipcRenderer.invoke('plugins:uninstall', id),
    test: (id) => ipcRenderer.invoke('plugins:test', id),
    search: (opts) => ipcRenderer.invoke('plugins:search', opts),
    pickFolder: () => ipcRenderer.invoke('plugins:pick-folder'),
  },

  github: {
    checkReleases: () => ipcRenderer.invoke('github:check-releases'),
  },

  auth: {
    getConfig: () => ipcRenderer.invoke('auth:get-config'),
    setRequired: (required) => ipcRenderer.invoke('auth:set-required', required),
    createFirstAdmin: (username, password) => ipcRenderer.invoke('auth:create-first-admin', username, password),
  },

  // Event subscriptions — separate on/off to avoid returning functions across contextBridge
  events: {
    onTokensPerMinute: (cb) => ipcRenderer.on('server:tpm', (_, value) => cb(value)),
    offTokensPerMinute: () => ipcRenderer.removeAllListeners('server:tpm'),
    onServerLog: (cb) => ipcRenderer.on('server:log', (_, line) => cb(line)),
    offServerLog: () => ipcRenderer.removeAllListeners('server:log'),
    onServerStopped: (cb) => ipcRenderer.on('server:stopped', () => cb()),
    offServerStopped: () => ipcRenderer.removeAllListeners('server:stopped'),
    onModelDownloadProgress: (cb) => ipcRenderer.on('models:download-progress', (_, p) => cb(p)),
    offModelDownloadProgress: () => ipcRenderer.removeAllListeners('models:download-progress'),
    onPluginInstallProgress: (cb) => ipcRenderer.on('plugins:install-progress', (_, p) => cb(p)),
    offPluginInstallProgress: () => ipcRenderer.removeAllListeners('plugins:install-progress'),
  },
})
