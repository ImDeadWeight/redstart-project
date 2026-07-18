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
  },
})
