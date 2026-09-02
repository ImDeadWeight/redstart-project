import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { HardwareSpecs, LlamaConfig } from '../types'

// Saved launch profiles: list/load/save + hardware-derived defaults.
// advertisedHost is owned by the network section in App, but a loaded profile
// carries one — onAdvertisedHostLoaded pushes it back up. onExposeControlPlaneLoaded
// does the same for the control plane's own exposure (LlamaConfig.exposeControlPlane)
// — a separate callback rather than folding into setConfig because applying it
// means an actual rebind (useControlPlaneExposure.setExposure), not just a
// state update.
export function useProfiles(
  config: LlamaConfig,
  setConfig: React.Dispatch<React.SetStateAction<LlamaConfig>>,
  onAdvertisedHostLoaded: (host: string) => void,
  onExposeControlPlaneLoaded: (expose: boolean) => void,
  showStatus: (msg: string, ttlMs?: number) => void,
) {
  const [profiles, setProfiles] = useState<string[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string>('')
  const [saveProfileName, setSaveProfileName] = useState('')
  const [showSaveInput, setShowSaveInput] = useState(false)

  async function loadProfiles() {
    try {
      const list = await api().profiles.list()
      setProfiles(list)
    } catch {
      showStatus('Failed to load profiles — settings may be corrupted.', 0)
    }
  }

  useEffect(() => {
    if (getAPI()) loadProfiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function selectProfile(name: string) {
    if (!name) { setSelectedProfile(''); return }
    const loaded = await api().profiles.load(name)
    if (loaded) {
      setConfig(prev => ({ ...loaded, networkMode: prev.networkMode }))
      // A loaded profile may omit advertisedHost; default to redstart.local in
      // network mode so mDNS keeps advertising a resolvable .local name.
      const safeNetworkMode = loaded.networkMode ?? true
      onAdvertisedHostLoaded(loaded.advertisedHost || (safeNetworkMode ? 'redstart.local' : ''))
      // Undefined means this profile never recorded an opinion (saved before
      // the field existed, or saved without ever touching the toggle) —
      // leave the control plane's current exposure exactly as it is.
      if (loaded.exposeControlPlane !== undefined) onExposeControlPlaneLoaded(loaded.exposeControlPlane)
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
    showStatus(`Profile "${name}" saved.`)
  }

  async function generateDefaultProfiles(hardware: HardwareSpecs | null) {
    if (!hardware) return
    await api().profiles.generateDefaults(hardware)
    await loadProfiles()
    showStatus('Default profiles generated from hardware scan.')
  }

  return {
    profiles, selectedProfile, saveProfileName, setSaveProfileName,
    showSaveInput, setShowSaveInput,
    selectProfile, saveProfile, generateDefaultProfiles,
  }
}
