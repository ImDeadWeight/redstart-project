// GitHub IPC namespace — release-tag lookups for the upstream engines.
//
// First seam of the electron/main IPC decomposition (see CHANGELOG). Each
// namespace module exports register<Namespace>Handlers(deps): a pure move of
// the matching handlers out of index.mjs's setupIpcHandlers(), with shared
// collaborators passed in via `deps` rather than reached for as module globals.
// This namespace has no shared state, so its deps object is empty.
import { ipcMain } from 'electron'

export function registerGithubHandlers() {
  // --- GitHub releases (unchanged) ---

  ipcMain.handle('github:check-releases', async () => {
    const releases = {}
    const repos = [
      { owner: 'ggerganov', repo: 'llama.cpp' },
      { owner: 'turboderp', repo: 'llama.cpp' },
      { owner: 'tiannml', repo: 'TurboQuant' },
    ]
    for (const { owner, repo } of repos) {
      try {
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`)
        if (res.ok) {
          const data = await res.json()
          releases[`${owner}/${repo}`] = data.tag_name
        }
      } catch {
        releases[`${owner}/${repo}`] = 'unavailable'
      }
    }
    return releases
  })
}
