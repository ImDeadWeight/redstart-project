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
    getCertFingerprint: () => ipcRenderer.invoke('server:get-cert-fingerprint'),
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
    removeExternal: (id) => ipcRenderer.invoke('mcp:remove-external', id),
    testExternal: (url) => ipcRenderer.invoke('mcp:test-external', url),
  },

  capabilities: {
    get: () => ipcRenderer.invoke('capabilities:get'),
    setPostgres: (config) => ipcRenderer.invoke('capabilities:set-postgres', config),
    testPostgres: (connectionString) => ipcRenderer.invoke('capabilities:test-postgres', connectionString),
    selectDocumentsFolder: () => ipcRenderer.invoke('capabilities:select-documents-folder'),
    setDocumentsFolder: (config) => ipcRenderer.invoke('capabilities:set-documents-folder', config),
  },

  chat: {
    open: (port, ssl) => ipcRenderer.invoke('chat:open', port, ssl),
  },

  settings: {
    getBinaryPath: () => ipcRenderer.invoke('settings:get-binary-path'),
    setBinaryPath: (p) => ipcRenderer.invoke('settings:set-binary-path', p),
    selectBinary: () => ipcRenderer.invoke('settings:select-binary'),
    getResolvedBinary: () => ipcRenderer.invoke('settings:get-resolved-binary'),
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
  },
})
