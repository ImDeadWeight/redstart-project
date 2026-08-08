// =============================================================================
// Redstart Twig (Windows) — preload script
// =============================================================================
// Electron runs the renderer (the web page) in a sandboxed context that can't
// access Node.js APIs directly. The preload script runs in a privileged context
// and uses contextBridge to selectively expose IPC calls to the renderer.
//
// I expose the network discovery calls under window.redstartTwigAPI so the
// SvelteKit chat-ui can detect it's running inside Electron (via isElectronLog()
// checking for window.redstartTwigAPI) and use the same scan code path as Android.
// =============================================================================

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('redstartTwigAPI', {
  network: {
    getLocalNetworkInfo: () => ipcRenderer.invoke('network:get-info'),
    scanForServers: (options) => ipcRenderer.invoke('network:scan', options),
  },
  // Local file system tools — the chat-ui routes fs_* tool calls here (instead
  // of to the remote server) when running inside Twig, so files are written to
  // THIS machine's disk. getTools() returns OpenAI-shaped tool definitions and
  // is empty until the user grants a folder via pickRoot().
  fs: {
    getTools: () => ipcRenderer.invoke('fs:get-tools'),
    execute: (name, args) => ipcRenderer.invoke('fs:execute', { name, args }),
    pickRoot: () => ipcRenderer.invoke('fs:pick-root'),
    getRoot: () => ipcRenderer.invoke('fs:get-root'),

    // Structured explorer API for the Files tab — data, not the model-shaped
    // text fs:execute returns. Mirrors Redstart Nest's /files/* shapes so one
    // component can browse either machine. Not exposed to the model.
    browse: (path) => ipcRenderer.invoke('fs:browse', { path }),
    preview: (path) => ipcRenderer.invoke('fs:preview', { path }),
    mkdir: (path) => ipcRenderer.invoke('fs:mkdir', { path }),
    move: (from, to) => ipcRenderer.invoke('fs:move', { from, to }),
    trash: (path) => ipcRenderer.invoke('fs:trash', { path }),
  },
  // Shell chrome — lets the chat-ui keep the native window frame (Windows 11
  // title bar) in step with its own light/dark theme.
  shell: {
    // `background` is the colour the app is actually painting, so the overlay
    // behind the window buttons can match it exactly instead of relying on a
    // hardcoded hex here agreeing with a CSS variable over there.
    setTheme: (theme, background) => ipcRenderer.invoke('shell:set-theme', { theme, background }),
  },
  // Local stdio MCP servers (Claude Desktop model). The main process spawns
  // servers from <userData>/twig-mcp.json and pipes newline-framed JSON-RPC;
  // the chat-ui's MCP SDK client speaks the protocol over this surface. Both
  // onMessage and onExit return an unsubscribe so the renderer transport can
  // detach cleanly on close() — otherwise listeners leak across reconnects.
  mcp: {
    list: () => ipcRenderer.invoke('mcp-local:list'),
    start: (id) => ipcRenderer.invoke('mcp-local:start', { id }),
    stop: (id) => ipcRenderer.invoke('mcp-local:stop', { id }),
    send: (id, line) => ipcRenderer.invoke('mcp-local:send', { id, line }),
    add: (id, config) => ipcRenderer.invoke('mcp-local:add', { id, ...config }),
    remove: (id) => ipcRenderer.invoke('mcp-local:remove', { id }),
    onMessage: (id, callback) => {
      const channel = `mcp-local:message:${id}`
      const handler = (_event, line) => callback(line)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onExit: (id, callback) => {
      const channel = `mcp-local:exit:${id}`
      const handler = (_event, info) => callback(info)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
  },
})
