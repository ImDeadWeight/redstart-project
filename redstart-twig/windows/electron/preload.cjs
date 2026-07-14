'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('redstartTwigAPI', {
  network: {
    getLocalNetworkInfo: () => ipcRenderer.invoke('network:get-info'),
    scanForServers: (options) => ipcRenderer.invoke('network:scan', options),
  },
})
