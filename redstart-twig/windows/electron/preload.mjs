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
})
