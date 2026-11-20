import type { useProfiles } from '../hooks/useProfiles'
import type { HardwareSpecs } from '../types'
import { Card, Chip, SectionTitle, btnCls, inputCls } from '../components/ui'

// Profiles, managed: the list, Use, Delete, Save current settings as…, and
// starting profiles sized from the hardware scan. Switching also lives in the
// top bar; this is where profiles are kept.
//
// What a profile holds is the MODEL configuration and the tools (useProfiles
// strips machine state on load). Who can connect and whether the admin panel
// is reachable belong to the computer, and the copy says so, because a label
// that promised more is how a profile once changed network exposure.
export function ProfilesPanel({ profilesHook, hardware }: {
  profilesHook: ReturnType<typeof useProfiles>
  hardware: HardwareSpecs | null
}) {
  const {
    profiles, selectedProfile, saveProfileName, setSaveProfileName,
    showSaveInput, setShowSaveInput, selectProfile, saveProfile,
    generateDefaultProfiles, deleteProfile,
  } = profilesHook
  const trimmed = saveProfileName.trim()
  const overwrites = !!trimmed && profiles.includes(trimmed)

  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <SectionTitle className="flex-1">Profiles</SectionTitle>
        {!showSaveInput && (
          <button type="button" onClick={() => { setSaveProfileName(selectedProfile); setShowSaveInput(true) }} className={btnCls.secondary}>
            Save current settings as…
          </button>
        )}
      </div>
      <p className="mb-3 text-sm text-zinc-400">
        A profile remembers the model, how it runs, and which tools are on. Switch from the top bar.
        Who can connect belongs to this computer, so switching never changes it.
      </p>

      {showSaveInput && (
        <div className="flex flex-wrap items-end gap-2 border-t border-zinc-800 py-3">
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1.5 text-[13px] text-zinc-400">
            Profile name
            <input
              autoFocus
              value={saveProfileName}
              onChange={e => setSaveProfileName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveProfile(); if (e.key === 'Escape') setShowSaveInput(false) }}
              placeholder="e.g. Long documents"
              className={inputCls.sm}
            />
          </label>
          <button type="button" onClick={saveProfile} disabled={!trimmed} className={btnCls.primary}>Save</button>
          <button type="button" onClick={() => setShowSaveInput(false)} className={btnCls.secondary}>Cancel</button>
          {overwrites && <p className="w-full text-[13px] text-amber-300">A profile with this name exists. Saving replaces it.</p>}
        </div>
      )}

      {profiles.length > 0 ? (
        <ul className="max-h-80 overflow-y-auto">
          {profiles.map(name => {
            const inUse = name === selectedProfile
            return (
              <li key={name} className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-1 py-2.5 text-sm">
                <span className="min-w-0 flex-1 break-all text-zinc-100">{name}</span>
                {inUse
                  ? <Chip tone="ok">In use</Chip>
                  : <button type="button" onClick={() => selectProfile(name)} className={btnCls.chip}>Use</button>}
                <button type="button" onClick={() => deleteProfile(name)} className={btnCls.subtle} data-tip-end=""
                  data-tip={inUse ? 'Delete the saved profile. Your current settings stay as they are.' : 'Delete this profile'}>
                  Delete
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="border-t border-zinc-800 py-3 text-sm text-zinc-500">
          No profiles saved yet. Save your current settings, or start from profiles sized for this computer.
        </p>
      )}

      <div className="border-t border-zinc-800 pt-3">
        <button type="button" onClick={() => generateDefaultProfiles(hardware)} disabled={!hardware} className={btnCls.subtle}
          data-tip={hardware ? `Sized for ${hardware.gpu.name || 'this GPU'} and ${hardware.memory.total.toFixed(0)} GB of memory` : 'Check the hardware on the Model page first'}>
          Add starting profiles for this computer
        </button>
      </div>
    </Card>
  )
}
