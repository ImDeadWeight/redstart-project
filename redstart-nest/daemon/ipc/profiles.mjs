// Profiles IPC namespace — named llama-server config presets (list/save/load/
// delete) plus hardware-derived default generation.
//
// readProfiles/writeProfiles still live in index.mjs and are threaded via deps.
//
// Handler bodies are exported as plain functions so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerProfilesHandlers() does that.

export function listProfiles({ readProfiles }) {
  const data = readProfiles()
  return Object.keys(data.profiles)
}

export function saveProfile(name, config, { readProfiles, writeProfiles }) {
  const data = readProfiles()
  data.profiles[name] = config
  writeProfiles(data)
  return true
}

export function loadProfile(name, { readProfiles }) {
  const data = readProfiles()
  return data.profiles[name] || null
}

export function deleteProfile(name, { readProfiles, writeProfiles }) {
  const data = readProfiles()
  delete data.profiles[name]
  // The working settings stay; only the claim that they came from this
  // profile goes, so the next open does not name a profile that is gone.
  if (data.last?.profile === name) data.last.profile = null
  writeProfiles(data)
  return true
}

// The launcher's working settings, kept beside the profiles so closing Nest
// (or the browser tab) never loses them. `profile` is the one they were last
// loaded from or saved to, or null; whether they still match it is the
// launcher's to work out, against the profile's own saved copy.
export function getLastSettings({ readProfiles }) {
  const last = readProfiles().last
  if (!last || typeof last !== 'object' || !last.config || typeof last.config !== 'object') return null
  return { profile: typeof last.profile === 'string' ? last.profile : null, config: last.config }
}

export function setLastSettings(profile, config, { readProfiles, writeProfiles }) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false
  const data = readProfiles()
  data.last = { profile: typeof profile === 'string' && profile ? profile : null, config }
  writeProfiles(data)
  return true
}

export function generateDefaultProfiles(hardware, { readProfiles, writeProfiles }) {
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
  }

  const data = readProfiles()
  // Remove old profile names from previous versions so users don't accidentally
  // load a stale entry with gpuLayers:99
  delete data.profiles['Agent / Productivity']
  data.profiles['Assistant']    = assistant
  data.profiles['Productivity'] = productivity
  writeProfiles(data)
  return [assistant, productivity]
}

export function profilesHandlers(deps) {
  return {
    'profiles:list': () => listProfiles(deps),
    'profiles:save': (name, config) => saveProfile(name, config, deps),
    'profiles:load': (name) => loadProfile(name, deps),
    'profiles:delete': (name) => deleteProfile(name, deps),
    'profiles:generate-defaults': (hardware) => generateDefaultProfiles(hardware, deps),
    'profiles:get-last': () => getLastSettings(deps),
    'profiles:set-last': (profile, config) => setLastSettings(profile, config, deps),
  }
}
