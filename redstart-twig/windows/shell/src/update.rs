//! Twig's auto-updater: Nest's (redstart-nest/shell/src/update.rs) for a client app.
//!
//!   twigd (shared/update-feed.mjs, asked over the pipe: `update-find`)
//!                 which GitHub release carries twig-latest.json
//!   tauri-plugin-updater
//!                 read that manifest, download the installer, VERIFY ITS
//!                 SIGNATURE against the public key compiled into this binary
//!   this module   when to check, the status Settings → Updates shows, and
//!                 the one moment it is safe to install
//!
//! When it installs: when Twig closes (the window's close button, Cmd+Q), or
//! straight away from Settings' "Restart to update". Never because a download
//! finished: that is a toast and a button, and the user's open chat is left
//! alone. Before the installer runs, twigd stops its MCP servers and every pid
//! it reported must be gone within 15 s, or the install waits for the next
//! close.
//!
//! Signed with the same key as Nest (one secret pair in CI). Whoever holds that
//! key can ship code to both apps. A release alone cannot.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{bridge, log, notify, shell};

/// The Tauri manifest the release workflow publishes beside the installer.
pub const MANIFEST: &str = "twig-latest.json";
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
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

    fn state(&self) -> String {
        self.status.lock().unwrap()["state"].as_str().unwrap_or("idle").to_string()
    }

    pub fn ready_version(&self) -> Option<String> {
        if self.state() != "ready" {
            return None;
        }
        self.status.lock().unwrap()["version"].as_str().map(str::to_string)
    }
}

fn updater(app: &AppHandle) -> tauri::State<'_, Updater> {
    app.state::<Updater>()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---- the auto-update setting: <config>/shell/shell-state.json ----

fn state_path(app: &AppHandle) -> PathBuf {
    shell(app).layout.shell_dir.join("shell-state.json")
}

/// On unless the file says `"autoUpdate": false`. Missing or unreadable is on.
pub fn auto_enabled_in(text: Option<&str>) -> bool {
    text.and_then(|t| serde_json::from_str::<Value>(t).ok())
        .map(|v| v["autoUpdate"] != json!(false))
        .unwrap_or(true)
}

fn auto_enabled(app: &AppHandle) -> bool {
    auto_enabled_in(fs::read_to_string(state_path(app)).ok().as_deref())
}

pub fn set_auto(app: &AppHandle, on: bool) -> Result<(), String> {
    let path = state_path(app);
    let mut state = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    state["autoUpdate"] = json!(on);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, serde_json::to_string_pretty(&state).unwrap()).map_err(|e| e.to_string())?;
    log::event("update", "auto_set", json!({ "enabled": on }));
    let status = page_status(app);
    bridge::emit(app, "twig://update-status", status);
    Ok(())
}

/// What Settings → Updates shows. `supported` false on a dev run, where the
/// page says so instead of offering a dead switch.
pub fn page_status(app: &AppHandle) -> Value {
    let u = updater(app);
    let mut s = u.status.lock().unwrap().clone();
    s["supported"] = json!(u.active);
    s["auto"] = json!(auto_enabled(app));
    s["current"] = json!(app.package_info().version.to_string());
    s
}

fn set_status(app: &AppHandle, patch: Value) {
    let u = updater(app);
    {
        let mut s = u.status.lock().unwrap();
        if let (Value::Object(cur), Value::Object(p)) = (&mut *s, patch) {
            for (k, v) in p {
                cur.insert(k, v);
            }
        }
    }
    let status = page_status(app);
    bridge::emit(app, "twig://update-status", status.clone());
    if status["state"] == "ready" {
        let version = status["version"].as_str().unwrap_or("").to_string();
        let mut n = u.notified.lock().unwrap();
        if n.as_deref() != Some(version.as_str()) {
            *n = Some(version.clone());
            notify(
                app,
                "Redstart Twig update ready",
                &format!("Version {version} has downloaded. It installs when you close Twig, or choose Restart to update in Settings."),
            );
        }
    }
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

/// One check, and the download if it finds something. `manual` (Check now)
/// runs even with automatic checks off. Blocks: call it off the main thread.
pub fn check_now(app: &AppHandle, manual: bool) {
    let u = updater(app);
    if !u.active {
        return;
    }
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
    let mut patch = match outcome {
        Ok(Some(version)) => json!({ "state": "ready", "version": version, "error": null }),
        Ok(None) => json!({ "state": "idle", "error": null }),
        Err(e) => {
            log::event("update", "check_failed", json!({ "message": e }));
            json!({ "state": "error", "error": e })
        }
    };
    patch["checkedAt"] = json!(now_ms());
    set_status(app, patch);
    u.checking.store(false, Ordering::SeqCst);
}

async fn check_and_download(app: &AppHandle) -> Result<Option<String>, String> {
    let current = app.package_info().version.to_string();
    let twigd = shell(app).twigd.lock().unwrap().clone().ok_or("Twig's local process is not running")?;
    let found = twigd.request("update-find", json!({ "currentVersion": current }), Duration::from_secs(30))?;
    if found.is_null() {
        return Ok(None);
    }
    let manifest_url = found["manifestUrl"].as_str().ok_or("update-find: no manifestUrl")?;
    if !manifest_url.ends_with(MANIFEST) {
        return Err(format!("update-find pointed at {manifest_url}, not {MANIFEST}"));
    }
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

/// On a deliberate quit, after twigd has been stopped. `pids` are what it
/// reported (its MCP children, then twigd). Returns false, and the caller
/// exits normally, when there was nothing to install or it was abandoned.
pub fn install(app: &AppHandle, pids: &[u32], relaunch: bool) -> bool {
    let Some((update, path)) = updater(app).pending.lock().unwrap().take() else { return false };
    log::event("update", "install_requested", json!({ "version": update.version, "relaunch": relaunch }));
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            log::event("update", "install_failed", json!({ "message": e.to_string() }));
            return false;
        }
    };
    let still = wait_pids_gone(pids, CHILD_EXIT_TIMEOUT);
    if !still.is_empty() {
        log::event("update", "install_abandoned", json!({ "stillRunning": still }));
        return false;
    }
    // Windows: the NSIS installer (passive: a progress bar, no questions)
    // takes over and this process ends. macOS: the .app is replaced in place
    // and this returns, so the restart is ours.
    match update.restart_after_install(relaunch).install(bytes) {
        Ok(()) => {
            log::event("update", "installed", json!({ "relaunch": relaunch }));
            let _ = fs::remove_file(&path);
            if cfg!(target_os = "macos") && relaunch {
                app.restart();
            }
            true
        }
        Err(e) => {
            log::event("update", "install_failed", json!({ "message": e.to_string() }));
            false
        }
    }
}

/// The pids still running after `timeout`.
#[cfg(windows)]
pub fn wait_pids_gone(pids: &[u32], timeout: Duration) -> Vec<u32> {
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

#[cfg(unix)]
pub fn wait_pids_gone(pids: &[u32], timeout: Duration) -> Vec<u32> {
    let deadline = std::time::Instant::now() + timeout;
    let alive = |pid: u32| unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
    loop {
        let still: Vec<u32> = pids.iter().copied().filter(|p| alive(*p)).collect();
        if still.is_empty() || std::time::Instant::now() >= deadline {
            return still;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_unless_the_shell_state_says_off() {
        assert!(!auto_enabled_in(Some(r#"{"autoUpdate":false}"#)));
        assert!(auto_enabled_in(Some(r#"{"autoUpdate":true}"#)));
        assert!(auto_enabled_in(Some("{}")), "a file from before the setting");
        assert!(auto_enabled_in(None), "no file");
        assert!(auto_enabled_in(Some("{not json")), "unreadable");
    }

    #[cfg(windows)]
    #[test]
    fn waits_for_a_real_child_and_reports_one_that_outlives_the_timeout() {
        let mut quick = std::process::Command::new("cmd").args(["/c", "exit 0"]).spawn().unwrap();
        let mut slow = std::process::Command::new("cmd").args(["/c", "ping -n 6 127.0.0.1 >nul"]).spawn().unwrap();
        let still = wait_pids_gone(&[quick.id(), slow.id()], Duration::from_millis(1500));
        assert_eq!(still, vec![slow.id()]);
        let _ = slow.kill();
        let _ = quick.wait();
        let _ = slow.wait();
    }
}
