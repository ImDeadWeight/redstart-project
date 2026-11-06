//! What the page may ask of the shell: Electron's preload, rebuilt.
//!
//! `bridge.js` (an initialization script, so it runs before the page's own
//! scripts on every load) defines `window.redstartTwigAPI` with the preload's
//! exact shape, so the chat-ui's feature detection and call sites are unchanged.
//! Each call lands on one of the commands below.
//!
//! `twig` forwards to twigd, but only the methods in PAGE_METHODS. Two of
//! twigd's methods are deliberately NOT on it:
//!   fs:set-root   the folder grant. Only `twig_pick_root` sends it, after a
//!                 person chose a folder in the shell's own dialog. A script in
//!                 the page cannot grant itself a folder.
//!   update-find   the updater's, not the page's.
//! scripts/test-twigd.mjs checks this list against what twigd registers.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{log, shell, update};

pub const BRIDGE_JS: &str = include_str!("bridge.js");

/// The page-callable twigd methods (the preload's channels).
pub const PAGE_METHODS: &[&str] = &[
    "network:get-info",
    "network:scan",
    "fs:get-tools",
    "fs:execute",
    "fs:get-root",
    "fs:browse",
    "fs:preview",
    "fs:mkdir",
    "fs:move",
    "fs:trash",
    "mcp-local:list",
    "mcp-local:start",
    "mcp-local:stop",
    "mcp-local:send",
    "mcp-local:add",
    "mcp-local:remove",
];

/// Long enough for a 254-address scan or a large tool call; short enough that
/// a wedged twigd surfaces as an error rather than a call that never returns.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

pub fn page_may_call(method: &str) -> bool {
    PAGE_METHODS.contains(&method)
}

fn twigd_request(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let d = shell(app).twigd.lock().unwrap().clone().ok_or("Twig's local process is not running")?;
    d.request(method, params, CALL_TIMEOUT)
}

#[tauri::command]
pub async fn twig(app: AppHandle, method: String, params: Option<Value>) -> Result<Value, String> {
    if !page_may_call(&method) {
        log::event("security", "bridge_method_denied", json!({ "method": method }));
        return Err(format!("Not available to the page: {method}"));
    }
    let params = params.unwrap_or_else(|| json!({}));
    tauri::async_runtime::spawn_blocking(move || twigd_request(&app, &method, params))
        .await
        .map_err(|e| e.to_string())?
}

/// The folder grant: the shell's dialog, then twigd persists the choice.
/// Cancelling leaves the grant as it was.
#[tauri::command]
pub async fn twig_pick_root(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("Choose a folder Redstart Twig may read and write")
            .set_parent(&window)
            .blocking_pick_folder();
        let chosen = picked.and_then(|p| p.into_path().ok());
        match chosen {
            Some(dir) => {
                log::event("app", "folder_granted", Value::Null);
                twigd_request(&app, "fs:set-root", json!({ "rootDir": dir.to_string_lossy() }))
            }
            None => twigd_request(&app, "fs:get-root", json!({})),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The page draws its own title bar and window buttons (decorations are off).
#[tauri::command]
pub fn twig_window(window: WebviewWindow, action: String) -> Result<Value, String> {
    let r = match action.as_str() {
        "minimize" => window.minimize(),
        "toggle-maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        // Not destroy(): a close goes through on_window_event, which quits
        // gracefully (and installs a waiting update).
        "close" => window.close(),
        "start-dragging" => window.start_dragging(),
        "is-maximized" => return window.is_maximized().map(|m| json!(m)).map_err(|e| e.to_string()),
        "toggle-devtools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
            Ok(())
        }
        other => return Err(format!("Unknown window action: {other}")),
    };
    r.map(|_| Value::Null).map_err(|e| e.to_string())
}

/// Settings → Updates. `status` is cheap; `check` blocks for the download.
#[tauri::command]
pub async fn twig_update(app: AppHandle, action: String, value: Option<bool>) -> Result<Value, String> {
    match action.as_str() {
        "status" => Ok(update::page_status(&app)),
        "check" => {
            let h = app.clone();
            tauri::async_runtime::spawn_blocking(move || update::check_now(&h, true))
                .await
                .map_err(|e| e.to_string())?;
            Ok(update::page_status(&app))
        }
        "set-auto" => {
            update::set_auto(&app, value.unwrap_or(true))?;
            Ok(update::page_status(&app))
        }
        "install" => {
            if app.state::<update::Updater>().ready_version().is_none() {
                return Err("No update has downloaded yet".into());
            }
            crate::quit(&app, true);
            Ok(Value::Null)
        }
        other => Err(format!("Unknown update action: {other}")),
    }
}

/// To the page: an MCP child's output or exit, or the update status.
pub fn emit(app: &AppHandle, event: &str, payload: Value) {
    if let Err(e) = app.emit_to("main", event, payload) {
        log::event("app", "emit_failed", json!({ "event": event, "reason": e.to_string() }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grant_and_the_updater_are_not_page_methods() {
        assert!(!page_may_call("fs:set-root"));
        assert!(!page_may_call("update-find"));
        assert!(!page_may_call("trash"));
        assert!(page_may_call("fs:execute"));
        assert!(page_may_call("mcp-local:send"));
    }

    #[test]
    fn the_script_calls_only_commands_that_exist() {
        for cmd in ["'twig'", "'twig_pick_root'", "'twig_window'", "'twig_update'"] {
            assert!(BRIDGE_JS.contains(cmd), "bridge.js never calls {cmd}");
        }
    }
}
