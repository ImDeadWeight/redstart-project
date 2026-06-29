// =============================================================================
// Beaver Log (Windows) — preload script
// =============================================================================
// Electron runs the renderer (the web page) in a sandboxed context that can't
// access Node.js APIs directly. The preload script runs in a privileged context
// and uses contextBridge to selectively expose IPC calls to the renderer.
//
// I expose the network discovery calls under window.beaverLogAPI so the
// SvelteKit chat-ui can detect it's running inside Electron (via isElectronLog()
// checking for window.beaverLogAPI) and use the same scan code path as Android.
// =============================================================================

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('beaverLogAPI', {
  network: {
    getLocalNetworkInfo: () => ipcRenderer.invoke('network:get-info'),
    scanForServers: (options) => ipcRenderer.invoke('network:scan', options),
  },
})
