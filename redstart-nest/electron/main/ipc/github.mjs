// GitHub IPC namespace — release-tag lookups for the upstream engines.
//
// First seam of the electron/main IPC decomposition (see CHANGELOG). Each
// namespace module exports register<Namespace>Handlers(deps): a pure move of
// the matching handlers out of index.mjs's setupIpcHandlers(), with shared
// collaborators passed in via `deps` rather than reached for as module globals.
// This namespace has no shared state, so its deps object is empty.
//
// Handler bodies are exported as plain functions (Phase 1, §1.3 of the
// headless-admin-plane implementation plan) so an HTTP route can call them
// directly without dragging IPC registration in — importing this module never
// registers anything; only registerGithubHandlers() does that.
import { handle } from './guard.mjs'

export async function checkGithubReleases() {
  const releases = {}
  const repos = [
    { owner: 'ggerganov', repo: 'llama.cpp' },
    { owner: 'TheTom', repo: 'llama-cpp-turboquant' },
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
}

export function registerGithubHandlers() {
  // --- GitHub releases (unchanged) ---

  handle('github:check-releases', () => checkGithubReleases())
}
