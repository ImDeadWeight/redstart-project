import { useEffect, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { HardwareSpecs, LlamaConfig } from '../types'

// Saved launch profiles: list/load/save + hardware-derived defaults.
//
// Loading a profile changes MODEL configuration and nothing else. It used to
// also rebind the admin listener (via a saved exposeControlPlane field), so
// picking "Office" from a dropdown could put the control plane on the LAN —
// a network-exposure change with no confirmation, behind a label that promised
// a model configuration. Exposure is machine state now and lives only in
// useControlPlaneExposure.
export function useProfiles(
  config: LlamaConfig,
  setConfig: React.Dispatch<React.SetStateAction<LlamaConfig>>,
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
      // networkMode and exposeControlPlane are both machine state. The latter
      // is no longer part of LlamaConfig, but profiles.json files written
      // before that still carry one — stripped here rather than ignored, so a
      // stale value cannot be written back out by the next "Save as Profile".
      const { exposeControlPlane: _machineState, ...modelConfig } =
        loaded as LlamaConfig & { exposeControlPlane?: boolean }
      setConfig(prev => ({ ...modelConfig, networkMode: prev.networkMode }))
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
