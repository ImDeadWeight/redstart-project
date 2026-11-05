'use strict'

// =============================================================================
// Redstart Nest: the Windows auto-updater
// =============================================================================
// Desktop entrypoint only. bin/nestd.mjs runs from a source checkout (see
// deploy/windows-service.md), so there is no installer for it to update.
// Windows only for now. macOS needs a Developer ID-signed app before
// Squirrel.Mac will apply anything, and these builds are ad-hoc signed.
//
// The split of work:
//   update-feed.mjs   which release is the update (GitHub API, no Electron)
//   electron-updater  fetch nest.yml from it, download the installer (only
//                     the changed blocks, when the old release has a
//                     blockmap), check its sha512, run it
//   this module       when to check, and the one moment it is safe to
//                     install
//
// When it installs. Only on a DELIBERATE quit: the tray's "Quit Redstart",
// its "Restart to update", or the admin API's shutdown route. Never on an OS
// shutdown or logoff, a crash, or anything else that ends the process. So
// autoInstallOnAppQuit is off, and index.mjs routes its two deliberate-quit
// paths through installAndQuit(). Nest is a server other machines are using.
// It does not restart itself because a download finished.
//
// Why installAndQuit() waits. The installer overwrites resources/bin, which a
// dying llama-server.exe still has mapped. Before the installer starts,
// installAndQuit() stops the daemon itself and waits for the children it
// names to be gone (waitForPidsExit in process-supervision.mjs has the full
// account). If they are not gone in time it does NOT install. It quits
// normally, and the downloaded update installs on the next deliberate quit.
// A late update is better than a half-written install.
//
// Integrity. The installer is unsigned, so electron-updater's publisher check
// is skipped (it only runs when app-update.yml names a publisher). What
// remains is the sha512 in nest.yml, and nest.yml comes from the same GitHub
// release as the installer. Whoever can publish a release on the repository
// can ship code to every install. docs/security.md → Known gaps.
// =============================================================================

import electronUpdater from 'electron-updater'
import { findUpdateRelease, shouldAutoUpdate, UPDATE_CHANNEL } from './update-feed.mjs'
import { waitForPidsExit } from './process-supervision.mjs'
import { logEvent } from './logger.mjs'

const { autoUpdater } = electronUpdater

/** The first check waits until startup has settled and a model has had time to load. */
const FIRST_CHECK_DELAY_MS = 60_000
/** Four checks a day. The API allows 60 an hour per IP. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** How long the install path waits for llama-server and the embed server. */
const CHILD_EXIT_TIMEOUT_MS = 15_000

/**
 * @typedef {{ state: 'idle'|'checking'|'downloading'|'ready'|'error',
 *             version: string|null, error: string|null,
 *             checkedAt: number|null }} UpdateStatus
 *   version: the update's version once one is found (downloading or ready).
 *   checkedAt: when the last check finished, whatever it found.
 */

/**
 * Start checking for updates. Returns the controller index.mjs uses for its
 * deliberate-quit paths. When the updater is off for this process, the
 * controller it returns does nothing, so callers never have to branch.
 *
 * @param {{
 *   app: import('electron').App,
 *   readSettings: () => object,
 *   stopForInstall: () => { childPids: number[] },
 *   onStatus?: (status: UpdateStatus) => void,
 * }} deps
 *   stopForInstall: tear down the tray and the daemon (the same work
 *   before-quit does), returning the child pids it signalled.
 *   onStatus: called on every state change, for the tray and the notification.
 */
export function startAutoUpdate({ app, readSettings, stopForInstall, onStatus = () => {} }) {
  /** @type {UpdateStatus} */
  let status = { state: 'idle', version: null, error: null, checkedAt: null }
  const setStatus = (next) => {
    status = { ...status, ...next }
    onStatus(status)
  }

  const enabledNow = () => shouldAutoUpdate({
    isPackaged: app.isPackaged,
    platform: process.platform,
    settings: safeRead(readSettings),
  })

  const inert = {
    active: false,
    status: () => status,
    hasPendingUpdate: () => false,
    installAndQuit: async () => false,
    checkNow: async () => {},
    stop: () => {},
  }
  // Packaging and platform cannot change while the process runs, so they are
  // read once here. The setting can, so it is read again before every check.
  if (!app.isPackaged || process.platform !== 'win32') return inert

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  // electron-updater's own log is verbose (every download percent). Warnings
  // and errors go to Nest's log, and the rest stays out of it.
  autoUpdater.logger = {
    info: () => {},
    debug: () => {},
    warn: (msg) => logEvent('update', 'updater_warning', { message: String(msg) }),
    error: (msg) => logEvent('update', 'updater_error', { message: String(msg?.message ?? msg) }),
  }

  autoUpdater.on('update-available', (info) => {
    setStatus({ state: 'downloading', version: info?.version ?? null, error: null })
    logEvent('update', 'download_started', { version: info?.version })
  })
  autoUpdater.on('update-not-available', () => {
    setStatus({ state: 'idle', error: null })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setStatus({ state: 'ready', version: info?.version ?? status.version, error: null })
    logEvent('update', 'downloaded', { version: info?.version })
  })
  autoUpdater.on('error', (err) => {
    // A failure mid-download drops back to "no update". The next check
    // starts it again, and electron-updater resumes from what it cached.
    if (status.state !== 'ready') setStatus({ state: 'error', error: err?.message ?? String(err) })
    logEvent('update', 'error', { message: err?.message ?? String(err) })
  })

  let checking = false
  /**
   * @param {{ manual?: boolean }} [opts] manual: an admin pressed "Check
   *   now". That runs even with autoUpdate off, since the setting turns off
   *   the automatic checks and the button is an explicit request. The timers
   *   call this with no argument.
   */
  async function checkNow({ manual = false } = {}) {
    // A ready update stays the update. Replacing it with a newer one
    // mid-session is a second large download for an install that has not
    // happened yet, and the next check after the install finds the newer one
    // anyway.
    if (checking || status.state === 'downloading' || status.state === 'ready') return
    if (!manual && !enabledNow()) return
    checking = true
    setStatus({ state: 'checking', error: null })
    try {
      const currentVersion = app.getVersion()
      const { release, error } = await findUpdateRelease({
        currentVersion,
        userAgent: `Redstart-Nest/${currentVersion}`,
      })
      if (!release) {
        setStatus({ state: error ? 'error' : 'idle', error: error ?? null })
        if (error) logEvent('update', 'check_failed', { message: error })
        return
      }
      logEvent('update', 'found', { version: release.version, from: currentVersion })
      autoUpdater.setFeedURL({ provider: 'generic', url: release.feedUrl, channel: UPDATE_CHANNEL })
      // Reads nest.yml, re-checks the version (no downgrade, no reinstall of
      // the running one), and starts the download. The events above carry
      // the outcome.
      await autoUpdater.checkForUpdates()
    } catch (err) {
      setStatus({ state: 'error', error: err?.message ?? String(err) })
      logEvent('update', 'check_failed', { message: err?.message ?? String(err) })
    } finally {
      checking = false
      setStatus({ state: status.state === 'checking' ? 'idle' : status.state, checkedAt: Date.now() })
    }
  }

  const first = setTimeout(() => checkNow(), FIRST_CHECK_DELAY_MS)
  const every = setInterval(() => checkNow(), CHECK_INTERVAL_MS)
  // Neither timer should be what keeps the process alive.
  first.unref?.()
  every.unref?.()

  let installing = false
  /**
   * Install the downloaded update and quit. The caller uses this for its
   * deliberate quit when hasPendingUpdate() is true.
   *
   * @param {{ relaunch: boolean }} opts
   * @returns {Promise<boolean>} false when there was nothing to install, or
   *   the install was abandoned. The caller then quits the ordinary way.
   */
  async function installAndQuit({ relaunch }) {
    if (status.state !== 'ready' || installing) return false
    installing = true
    logEvent('update', 'install_requested', { version: status.version, relaunch })
    clearTimeout(first)
    clearInterval(every)
    // After this the logger is closed. Anything left to report goes to the
    // console, which a packaged build discards. The pid wait is the reason
    // for doing this stop here rather than leaving it to before-quit.
    const { childPids } = await stopForInstall()
    const { stillRunning } = await waitForPidsExit(childPids, { timeoutMs: CHILD_EXIT_TIMEOUT_MS })
    if (stillRunning.length > 0) {
      console.warn(`Update not installed: pid(s) ${stillRunning.join(', ')} still running after ${CHILD_EXIT_TIMEOUT_MS}ms`)
      return false
    }
    // Silent: the user already chose this from the tray, and the installer's
    // --updated mode reuses the existing install directory and scope. A
    // per-machine install still raises UAC. electron-updater calls
    // app.quit() itself, and before-quit's second stopDaemon() is a no-op.
    autoUpdater.quitAndInstall(true, relaunch)
    return true
  }

  return {
    // True only here: a packaged Windows build. index.mjs registers the
    // controller with the admin API only when it is, so everywhere else the
    // Updates control reads as unsupported rather than as a switch that does
    // nothing.
    active: true,
    status: () => status,
    hasPendingUpdate: () => status.state === 'ready' && !installing,
    installAndQuit,
    checkNow,
    stop: () => {
      clearTimeout(first)
      clearInterval(every)
    },
  }
}

function safeRead(readSettings) {
  try {
    return readSettings()
  } catch {
    return null
  }
}
