// Profiles IPC namespace — named llama-server config presets (list/save/load/
// delete) plus hardware-derived default generation.
//
// readProfiles/writeProfiles still live in index.mjs and are threaded via deps.
import { ipcMain } from 'electron'

export function registerProfilesHandlers({ readProfiles, writeProfiles }) {
  // --- Profiles ---

  ipcMain.handle('profiles:list', () => {
    const data = readProfiles()
    return Object.keys(data.profiles)
  })

  ipcMain.handle('profiles:save', (_, name, config) => {
    const data = readProfiles()
    data.profiles[name] = config
    writeProfiles(data)
    return true
  })

  ipcMain.handle('profiles:load', (_, name) => {
    const data = readProfiles()
    return data.profiles[name] || null
  })

  ipcMain.handle('profiles:delete', (_, name) => {
    const data = readProfiles()
    delete data.profiles[name]
    writeProfiles(data)
    return true
  })

  ipcMain.handle('profiles:generate-defaults', (_, hardware) => {
    const { cpu } = hardware

    // Physical cores give better LLM throughput than logical (hyperthreads
    // fight each other for cache on inference workloads)
    const physCores    = cpu.cores   || Math.ceil((cpu.threads || 4) / 2)
    const inferThreads = Math.max(4, Math.min(physCores, 12))

    // gpuLayers/nCpuMoe are left undefined here on purpose — omitting -ngl and
    // --n-cpu-moe lets llama-server's own --fit (on by default) decide both,
    // live against actual free VRAM and the model's real tensor sizes at load
    // time. That's strictly better than a JS estimate computed once from total
    // VRAM at hardware-scan time. Users who want a fixed value can still set
    // one manually in the UI — buildArgs() only omits the flag when unset.
    const assistant = {
      name: 'Assistant',
      modelPath: '',
      ctxSize: 4096,
      batchSize: 256,
      threads: inferThreads,
      port: 19080,
      host: '127.0.0.1',
      kvCache: 'balanced',
      additionalArgs: '',
      advertisedHost: 'redstart.local',
    }

    const productivity = {
      name: 'Productivity',
      modelPath: '',
      ctxSize: 16384,
      batchSize: 512,
      threads: inferThreads,
      port: 19080,
      host: '127.0.0.1',
      kvCache: 'balanced',
      additionalArgs: '',
      advertisedHost: 'redstart.local',
    }

    const data = readProfiles()
    // Remove old profile names from previous versions so users don't accidentally
    // load a stale entry with gpuLayers:99
    delete data.profiles['Agent / Productivity']
    data.profiles['Assistant']    = assistant
    data.profiles['Productivity'] = productivity
    writeProfiles(data)
    return [assistant, productivity]
  })
}
