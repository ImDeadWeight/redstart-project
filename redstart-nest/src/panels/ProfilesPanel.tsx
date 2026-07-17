import type { useProfiles } from '../hooks/useProfiles'
import { SectionTitle } from '../components/ui'

export function ProfilesPanel({ profilesHook }: { profilesHook: ReturnType<typeof useProfiles> }) {
  const {
    profiles, selectedProfile, saveProfileName, setSaveProfileName,
    showSaveInput, setShowSaveInput, selectProfile, saveProfile,
  } = profilesHook

  return (
    <section>
      <SectionTitle>Profiles</SectionTitle>
      {profiles.length > 0 ? (
        <select
          value={selectedProfile}
          onChange={e => selectProfile(e.target.value)}
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-orange-500">
          <option value="">— select profile —</option>
          {profiles.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      ) : (
        <p className="text-xs text-zinc-600">No profiles saved yet.</p>
      )}
      {!showSaveInput ? (
        <button onClick={() => { setSaveProfileName(selectedProfile); setShowSaveInput(true) }}
          className="mt-2 w-full px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-xs transition-colors">
          Save Current as Profile
        </button>
      ) : (
        <div className="mt-2 flex gap-1">
          <input
            autoFocus
            value={saveProfileName}
            onChange={e => setSaveProfileName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveProfile(); if (e.key === 'Escape') setShowSaveInput(false) }}
            placeholder="Profile name"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-orange-500"
          />
          <button onClick={saveProfile} className="px-2 py-1 bg-orange-500 hover:bg-orange-400 rounded text-xs transition-colors">✓</button>
          <button onClick={() => setShowSaveInput(false)} className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors">✕</button>
        </div>
      )}
    </section>
  )
}
