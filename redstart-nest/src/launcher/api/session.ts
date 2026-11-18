// =============================================================================
// Redstart Nest — the control-plane session
// =============================================================================
// Used by every caller — a browser tab, and Electron's window, which is just
// another HTTP client of the admin listener now that IPC is retired.
// Not in redstart.ts because it's a detail of the one transport there is, not
// part of the RedstartAPI surface itself.
//
// localStorage, not a cookie, and the choice does real work: a bearer token the
// page attaches itself is never sent by a cross-site request, so the control
// plane needs no CSRF machinery (see admin/api-routes.mjs). The cost is the
// usual one — anything that can run script on this origin can read it — and the
// answer to that is the same as for any SPA: the origin serves only files Nest
// shipped, from an explicit allowlist, with no third-party script anywhere on it.
//
// Scoped to the origin by localStorage itself, so two Nest boxes open in one
// browser keep separate sessions without any work here.
// =============================================================================

const KEY = 'redstart.admin.session'

export function getSessionToken(): string | null {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    // Private mode, or storage disabled by policy. The session then lives only
    // as long as the page, which is a worse experience and not a broken one.
    return memoryToken
  }
}

export function setSessionToken(token: string): void {
  memoryToken = token
  try { window.localStorage.setItem(KEY, token) } catch { /* see above */ }
}

export function clearSessionToken(): void {
  memoryToken = null
  try { window.localStorage.removeItem(KEY) } catch { /* see above */ }
}

let memoryToken: string | null = null
