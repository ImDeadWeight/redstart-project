import { useEffect, useRef, useState } from 'react'
import { api, getAPI } from '../api/redstart'
import type { HardwareSpecs, LlamaConfig } from '../types'

// Saved launch profiles: list/load/save + hardware-derived defaults, and the
// working settings that survive closing Nest.
//
// Loading a profile changes MODEL configuration and nothing else. It used to
// also rebind the admin listener (via a saved exposeControlPlane field), so
// picking "Office" from a dropdown could put the control plane on the LAN —
// a network-exposure change with no confirmation, behind a label that promised
// a model configuration. Exposure is machine state now and lives only in
// useControlPlaneExposure.
//
// THE WORKING SETTINGS. Whatever is on screen is written to profiles.json
// (`last`) shortly after every change, with the profile it came from, and put
// back when the launcher next opens. Saved as it changes rather than on close:
// a desktop window, a browser tab and a killed process all "close" differently,
// and only the first one reliably says so. A profile is a named copy the user
// keeps on purpose; the working settings are never written into one by
// themselves. `unsaved` is the gap between the two, shown in the top bar.

const AUTOSAVE_MS = 400

// networkMode is machine state (App owns it); exposeControlPlane is a field old
// profiles.json files still carry. Neither is part of what a profile means.
function modelConfigOf(c: LlamaConfig): LlamaConfig {
  const { networkMode: _n, exposeControlPlane: _e, ...rest } = c as LlamaConfig & { exposeControlPlane?: boolean }
  return rest
}

// Key order and absent-vs-undefined must not count as a change: a profile
// written by an older build, or a field set back to "auto", is still the same.
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort()
      .filter(k => (v as Record<string, unknown>)[k] !== undefined)
      .map(k => [k, canonical((v as Record<string, unknown>)[k])]))
  }
  return v
}

export function sameModelConfig(a: LlamaConfig, b: LlamaConfig): boolean {
  return JSON.stringify(canonical(modelConfigOf(a))) === JSON.stringify(canonical(modelConfigOf(b)))
}

export function useProfiles(
  config: LlamaConfig,
  setConfig: React.Dispatch<React.SetStateAction<LlamaConfig>>,
  showStatus: (msg: string, ttlMs?: number) => void,
) {
  const [profiles, setProfiles] = useState<string[]>([])
  const [selectedProfile, setSelectedProfile] = useState<string>('')
  // The selected profile's saved copy, to tell whether the screen still matches it.
  const [profileConfig, setProfileConfig] = useState<LlamaConfig | null>(null)
  const [saveProfileName, setSaveProfileName] = useState('')
  const [showSaveInput, setShowSaveInput] = useState(false)
  // Autosave stays off until the restore has run, or the defaults App starts
  // with would overwrite the settings it is about to restore.
  const [restored, setRestored] = useState(false)
  const pending = useRef<{ profile: string | null; config: LlamaConfig } | null>(null)

  async function loadProfiles() {
    try {
      const list = await api().profiles.list()
      setProfiles(list)
      return list
    } catch {
      showStatus('Failed to load profiles — settings may be corrupted.', 0)
      return null
    }
  }

  async function restoreLast(list: string[] | null) {
    try {
      const last = await api().profiles.getLast()
      if (!last) return
      setConfig(prev => ({ ...modelConfigOf(last.config), networkMode: prev.networkMode }))
      const name = last.profile && list?.includes(last.profile) ? last.profile : ''
      const saved = name ? await api().profiles.load(name) : null
      setSelectedProfile(saved ? name : '')
      setProfileConfig(saved)
      if (!saved) {
        showStatus('Restored your last settings. They are not saved to a profile.', 8000)
      } else if (!sameModelConfig(last.config, saved)) {
        showStatus(`Restored your last settings, from profile "${name}" with unsaved changes.`, 8000)
      } else {
        showStatus(`Restored profile "${name}".`, 5000)
      }
    } catch {
      // Nothing to restore from is the same as a first run.
    } finally {
      setRestored(true)
    }
  }

  useEffect(() => {
    if (!getAPI()) return
    loadProfiles().then(restoreLast)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Write the working settings shortly after they change. The pending copy is
  // also flushed when the page goes away, so a change made in the last
  // AUTOSAVE_MS before closing is not the one that is lost.
  useEffect(() => {
    if (!restored) return
    pending.current = { profile: selectedProfile || null, config: modelConfigOf(config) }
    const t = setTimeout(flushLast, AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [config, selectedProfile, restored])

  useEffect(() => {
    window.addEventListener('pagehide', flushLast)
    return () => window.removeEventListener('pagehide', flushLast)
  }, [])

  function flushLast() {
    const p = pending.current
    if (!p) return
    pending.current = null
    api().profiles.setLast(p.profile, p.config).catch(() => { pending.current ??= p })
  }

  async function selectProfile(name: string) {
    if (!name) { setSelectedProfile(''); setProfileConfig(null); return }
    const loaded = await api().profiles.load(name)
    if (loaded) {
      // networkMode and exposeControlPlane are both machine state. The latter
      // is no longer part of LlamaConfig, but profiles.json files written
      // before that still carry one — stripped here rather than ignored, so a
      // stale value cannot be written back out by the next "Save as Profile".
      setConfig(prev => ({ ...modelConfigOf(loaded), networkMode: prev.networkMode }))
      setSelectedProfile(name)
      setProfileConfig(loaded)
    }
  }

  async function saveProfileAs(name: string) {
    const saved = modelConfigOf(config)
    await api().profiles.save(name, saved)
    setSelectedProfile(name)
    setProfileConfig(saved)
    await loadProfiles()
    showStatus(`Profile "${name}" saved.`)
  }

  async function saveProfile() {
    const name = saveProfileName.trim()
    if (!name) return
    await saveProfileAs(name)
    setSaveProfileName('')
    setShowSaveInput(false)
  }

  // Write the current settings over the selected profile ("Save changes").
  async function saveToSelected() {
    if (selectedProfile) await saveProfileAs(selectedProfile)
  }

  async function generateDefaultProfiles(hardware: HardwareSpecs | null) {
    if (!hardware) return
    await api().profiles.generateDefaults(hardware)
    await loadProfiles()
    // The two defaults are rewritten in place; the one in use may have changed.
    if (selectedProfile) setProfileConfig(await api().profiles.load(selectedProfile))
    showStatus('Default profiles generated from hardware scan.')
  }

  // Deleting the profile in use leaves the current settings exactly as they
  // are; only the saved copy goes. The selection clears so the header does not
  // name a profile that no longer exists.
  async function deleteProfile(name: string) {
    const ok = await api().profiles.delete(name)
    if (!ok) { showStatus(`Could not delete "${name}".`); return }
    if (selectedProfile === name) { setSelectedProfile(''); setProfileConfig(null) }
    await loadProfiles()
    showStatus(`Deleted "${name}".`)
  }

  // Not saved anywhere but the working settings, or different from the
  // profile they came from. Only meaningful once the restore has run.
  const notInProfile = restored && !selectedProfile
  const unsaved = restored && !!selectedProfile && !!profileConfig && !sameModelConfig(config, profileConfig)

  return {
    profiles, selectedProfile, saveProfileName, setSaveProfileName,
    showSaveInput, setShowSaveInput,
    selectProfile, saveProfile, saveToSelected, generateDefaultProfiles, deleteProfile,
    notInProfile, unsaved,
  }
}
