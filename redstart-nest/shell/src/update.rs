//! The shell's auto-updater: `electron/main/auto-update.mjs`'s behaviour on
//! Tauri's signed updater (plan D6). Release builds on Windows only.
//!
//! The split of work:
//!   the daemon (update-feed.mjs, asked over the pipe: `update-find`)
//!                 which GitHub release is the update. The same tested
//!                 logic electron-updater used, so prerelease handling
//!                 doesn't fork.
//!   tauri-plugin-updater
//!                 read that release's nest-latest.json, download the
//!                 installer, VERIFY ITS SIGNATURE against the public key
//!                 compiled into this binary, run it
//!   this module   when to check, and the one moment it is safe to install
//!
//! When it installs. Only on a DELIBERATE quit (tray Quit, tray Restart to
//! update, admin Shut down / Restart to update). Never on an OS shutdown, a
//! logoff or a crash. Nest is a server other machines use, so it doesn't
//! restart because a download finished.
//!
//! Before the installer runs, the daemon is stopped and every pid it reported
//! (llama-server, the embed server) must be gone within 15 s, or the install
//! is abandoned for this quit. The installer overwrites resources/bin, which
//! a dying llama-server still has mapped.
//!
//! Integrity: unlike electron-updater's sha512 from the same release, the
//! signature here is checked against a key that isn't in the release, so a
//! release alone can't ship code. Whoever holds the signing key can.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{log, notify, shell, tray};

/// The Tauri manifest the release workflow publishes beside the installer.
pub const MANIFEST: &str = "nest-latest.json";
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
/// Four a day. GitHub allows 60 unauthenticated API calls an hour per IP.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(15);

pub struct Updater {
    pub active: bool,
    status: Mutex<Value>,
    pending: Mutex<Option<(Update, PathBuf)>>,
    checking: AtomicBool,
    notified: Mutex<Option<String>>,
}

impl Updater {
    pub fn new(active: bool) -> Updater {
        Updater {
            active,
            status: Mutex::new(json!({ "state": "idle", "version": null, "error": null, "checkedAt": null })),
            pending: Mutex::new(None),
            checking: AtomicBool::new(false),
            notified: Mutex::new(None),
        }
    }

    pub fn status(&self) -> Value {
        self.status.lock().unwrap().clone()
    }

    fn state(&self) -> String {
        self.status.lock().unwrap()["state"].as_str().unwrap_or("idle").to_string()
    }

    /// The version of a downloaded update waiting for a deliberate quit.
    pub fn ready_version(&self) -> Option<String> {
        if self.state() != "ready" {
            return None;
        }
        self.status.lock().unwrap()["version"].as_str().map(str::to_string)
    }
}

pub fn is_active(app: &AppHandle) -> bool {
    app.try_state::<Updater>().map(|u| u.active).unwrap_or(false)
}

fn updater(app: &AppHandle) -> tauri::State<'_, Updater> {
    app.state::<Updater>()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn set_status(app: &AppHandle, patch: Value) {
    let u = updater(app);
    let status = {
        let mut s = u.status.lock().unwrap();
        if let (Value::Object(cur), Value::Object(p)) = (&mut *s, patch) {
            for (k, v) in p {
                cur.insert(k, v);
            }
        }
        s.clone()
    };
    // To every admin UI, through the daemon's SSE feed. A remote admin has
    // no tray to read.
    if let Some(d) = shell(app).daemon.lock().unwrap().clone() {
        d.push_update_status(&status);
    }
    tray::refresh(app);
    if status["state"] == "ready" {
        let version = status["version"].as_str().unwrap_or("").to_string();
        let mut n = u.notified.lock().unwrap();
        if n.as_deref() != Some(version.as_str()) {
            *n = Some(version.clone());
            notify(
                app,
                "Redstart update ready",
                &format!("Version {version} has downloaded. It installs the next time you quit Redstart, or choose \"Restart to update\" from the tray."),
            );
        }
    }
}

/// settings.json's autoUpdate, read before every automatic check (the
/// daemon owns the file; the shell only reads it). Absent means on.
fn auto_enabled(app: &AppHandle) -> bool {
    let path = shell(app).layout.config.join("settings.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| v["autoUpdate"] != json!(false))
        .unwrap_or(true)
}

/// The timers. Does nothing when the updater is inactive.
pub fn start(app: &AppHandle) {
    if !updater(app).active {
        return;
    }
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            check_now(&h, false);
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

/// One check, and the download if it finds something. `manual` is an admin
/// pressing Check now, which runs even with automatic checks off. Blocks:
/// call it off the main thread.
pub fn check_now(app: &AppHandle, manual: bool) {
    let u = updater(app);
    if !u.active {
        return;
    }
    // A ready update stays the update: replacing it mid-session would be a
    // second large download for an install that hasn't happened yet.
    let state = u.state();
    if state == "downloading" || state == "ready" {
        return;
    }
    if !manual && !auto_enabled(app) {
        return;
    }
    if u.checking.swap(true, Ordering::SeqCst) {
        return;
    }
    set_status(app, json!({ "state": "checking", "error": null }));
    let outcome = tauri::async_runtime::block_on(check_and_download(app));
    let patch = match outcome {
        Ok(Some(version)) => json!({ "state": "ready", "version": version, "error": null }),
        Ok(None) => json!({ "state": "idle", "error": null }),
        Err(e) => {
            log::event("update", "check_failed", json!({ "message": e }));
            json!({ "state": "error", "error": e })
        }
    };
    let mut patch = patch;
    patch["checkedAt"] = json!(now_ms());
    set_status(app, patch);
    u.checking.store(false, Ordering::SeqCst);
}

async fn check_and_download(app: &AppHandle) -> Result<Option<String>, String> {
    let current = app.package_info().version.to_string();
    let daemon = shell(app).daemon.lock().unwrap().clone().ok_or("The server process is not running")?;
    let Some(found) = daemon.find_update(&current, MANIFEST)? else { return Ok(None) };
    let manifest_url = found["manifestUrl"].as_str().ok_or("update-find: no manifestUrl")?;
    log::event("update", "found", json!({ "version": found["version"], "from": current }));

    let url = manifest_url.parse().map_err(|e| format!("Bad manifest URL: {e}"))?;
    let update = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    // The manifest may not be newer after all (the plugin compares again).
    let Some(update) = update else { return Ok(None) };

    set_status(app, json!({ "state": "downloading", "version": update.version, "error": null }));
    log::event("update", "download_started", json!({ "version": update.version }));
    // download() verifies the signature before it returns the bytes.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let dir = shell(app).layout.shell_dir.join("update");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("pending-installer.bin");
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    log::event("update", "downloaded", json!({ "version": update.version }));
    let version = update.version.clone();
    *updater(app).pending.lock().unwrap() = Some((update, path));
    Ok(Some(version))
}

/// Called on a deliberate quit when an update is ready. Stops the daemon,
/// waits for its children, then hands over to the installer, which ends this
/// process. Returns false (and the caller exits normally) when there was
/// nothing to install or the install had to be abandoned.
pub fn install_and_quit(app: &AppHandle, relaunch: bool) -> bool {
    let Some((update, path)) = updater(app).pending.lock().unwrap().take() else { return false };
    log::event("update", "install_requested", json!({ "version": update.version, "relaunch": relaunch }));
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            log::event("update", "install_failed", json!({ "message": e.to_string() }));
            return false;
        }
    };
    let pids = match shell(app).daemon.lock().unwrap().clone() {
        Some(d) => d.stop(),
        None => Vec::new(),
    };
    let still = wait_pids_gone(&pids, CHILD_EXIT_TIMEOUT);
    if !still.is_empty() {
        log::event("update", "install_abandoned", json!({ "stillRunning": still }));
        return false;
    }
    // Runs the NSIS installer (passive: a progress bar, no questions) and
    // exits this process. On failure it returns, and we quit normally.
    if let Err(e) = update.restart_after_install(relaunch).install(bytes) {
        log::event("update", "install_failed", json!({ "message": e.to_string() }));
    }
    false
}

/// The pids still running after `timeout`.
#[cfg(windows)]
fn wait_pids_gone(pids: &[u32], timeout: Duration) -> Vec<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
    let deadline = std::time::Instant::now() + timeout;
    let mut still = Vec::new();
    for &pid in pids {
        let h = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if h.is_null() {
            continue; // already gone
        }
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let r = unsafe { WaitForSingleObject(h, left.as_millis() as u32) };
        unsafe { CloseHandle(h) };
        if r == WAIT_TIMEOUT {
            still.push(pid);
        }
    }
    still
}

#[cfg(not(windows))]
fn wait_pids_gone(_: &[u32], _: Duration) -> Vec<u32> {
    Vec::new()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn waits_for_a_real_child_and_reports_one_that_outlives_the_timeout() {
        let mut quick = std::process::Command::new("cmd").args(["/c", "exit 0"]).spawn().unwrap();
        let mut slow = std::process::Command::new("cmd").args(["/c", "ping -n 6 127.0.0.1 >nul"]).spawn().unwrap();
        let still = wait_pids_gone(&[quick.id(), slow.id()], Duration::from_millis(1500));
        assert_eq!(still, vec![slow.id()]);
        let _ = slow.kill();
        let _ = quick.wait();
        let _ = slow.wait();
        assert!(wait_pids_gone(&[slow.id()], Duration::from_millis(500)).is_empty());
    }
}
