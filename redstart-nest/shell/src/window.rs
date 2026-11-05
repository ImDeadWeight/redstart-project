//! The one window: the admin listener's own page, as a browser would load it.
//!
//! No OS title bar (`decorations: false`). The page draws its own (TopBar in
//! src/components/ui.tsx) and, inside this shell only, its own minimise /
//! maximise / close. Those call Tauri's window API, which the
//! `window-controls` capability allows for this window at the admin origin
//! and nothing else.
//!
//! Containment, as in Electron: new windows are denied and logged. Stricter
//! than Electron: navigation off the admin origin is denied too, which also
//! keeps the capability's origin the only one this window ever shows.

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{log, shell};

const LABEL: &str = "main";
// WebView2's defaults (wry's) plus --disable-gpu: Electron ran with hardware
// acceleration off so the window never competes with llama-server for the
// GPU. Passing any args replaces wry's, hence repeating them.
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu";

static NOTICE_OPEN: AtomicBool = AtomicBool::new(false);

fn admin_base(app: &AppHandle) -> Option<String> {
    let s = shell(app);
    if let Some(dev) = &s.layout.dev_url {
        return Some(dev.clone());
    }
    let ready = s.ready.lock().unwrap();
    ready.as_ref().map(|r| format!("http://127.0.0.1:{}/", r.admin_port))
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Bring the window forward, creating it if it was closed. Before the
/// daemon is ready there is nothing to show; `ready` opens it.
pub fn open_or_focus(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let Some(base) = admin_base(app) else { return };
    let Ok(base_url) = Url::parse(&base) else { return };
    let mut url = base_url.clone();
    // The bootstrap-token handoff, as Electron did it: no owner exists yet,
    // so the page gets the setup code as a URL parameter. AdminGate.tsx reads
    // it once and clears it from the address bar.
    let token = shell(app).ready.lock().unwrap().as_ref().and_then(|r| r.setup_token.clone());
    if let Some(t) = token {
        url.set_query(Some(&format!("setupToken={}", encode(&t))));
    }

    let origin = base_url.clone();
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("Redstart Nest")
        .inner_size(1100.0, 800.0)
        .decorations(false)
        .shadow(true)
        // zinc-950 from the first frame, so the window never flashes white.
        .background_color(Color(9, 9, 11, 255))
        .additional_browser_args(BROWSER_ARGS)
        .devtools(cfg!(debug_assertions))
        .on_new_window(|url, _| {
            log::event("security", "window_open_denied", json!({ "host": url.host_str().unwrap_or("") }));
            NewWindowResponse::Deny
        })
        .on_navigation(move |to| {
            let ok = same_origin(to, &origin);
            if !ok {
                log::event("security", "navigation_denied", json!({ "host": to.host_str().unwrap_or("") }));
            }
            ok
        })
        .build();
    if let Err(e) = built {
        log::event("app", "window_failed", json!({ "reason": e.to_string() }));
    }
}

// ---- the first-close notice ----
// "Closing the window stops the server" was true for years, so the first
// close says plainly that it no longer does. Once ever: recorded in the
// shell's own file. settings.json is the daemon's, and is only read, to
// honour a notice shown before the split.

fn shell_state_path(app: &AppHandle) -> std::path::PathBuf {
    shell(app).layout.shell_dir.join("shell-state.json")
}

fn notice_shown(app: &AppHandle) -> bool {
    let read = |p: std::path::PathBuf| -> bool {
        fs::read_to_string(p)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["closeNoticeShown"].as_bool())
            .unwrap_or(false)
    };
    read(shell(app).layout.config.join("settings.json")) || read(shell_state_path(app))
}

fn mark_notice_shown(app: &AppHandle) {
    let path = shell_state_path(app);
    let mut state = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    state["closeNoticeShown"] = json!(true);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&path, serde_json::to_string_pretty(&state).unwrap());
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != LABEL {
        return;
    }
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    let app = window.app_handle();
    if shell(app).quitting.load(Ordering::SeqCst) || notice_shown(app) {
        return; // close normally; the app keeps running (ExitRequested is prevented)
    }
    api.prevent_close();
    if NOTICE_OPEN.swap(true, Ordering::SeqCst) {
        return;
    }
    let w = window.clone();
    let h = app.clone();
    app.dialog()
        .message("Redstart keeps running in the notification area.\n\nThe model stays loaded. Quit from the tray icon to stop it.")
        .title("Redstart keeps running")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCustom("Got it".into()))
        .parent(window)
        .show(move |_| {
            mark_notice_shown(&h);
            NOTICE_OPEN.store(false, Ordering::SeqCst);
            // Re-fires CloseRequested, which now lets the close through.
            let _ = w.close();
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_check_is_scheme_host_and_port() {
        let admin = Url::parse("http://127.0.0.1:19083/").unwrap();
        assert!(same_origin(&Url::parse("http://127.0.0.1:19083/admin/x?y=1").unwrap(), &admin));
        assert!(!same_origin(&Url::parse("http://127.0.0.1:19080/").unwrap(), &admin));
        assert!(!same_origin(&Url::parse("http://localhost:19083/").unwrap(), &admin));
        assert!(!same_origin(&Url::parse("https://127.0.0.1:19083/").unwrap(), &admin));
        assert!(!same_origin(&Url::parse("https://example.com/").unwrap(), &admin));
    }

    #[test]
    fn setup_token_is_query_safe() {
        assert_eq!(encode("ab-_.~09"), "ab-_.~09");
        assert_eq!(encode("a+b/c=&"), "a%2Bb%2Fc%3D%26");
    }
}
