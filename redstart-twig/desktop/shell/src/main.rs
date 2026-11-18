//! Redstart Twig's desktop shell.
//!
//! Twig is a chat client for a Redstart Nest elsewhere on the network. This
//! process is the window, the chat UI's origin (the `twig` protocol), the
//! folder dialog, the recycle bin and the updater. Everything the page does on
//! this machine (the granted folder's tools, local MCP servers, the LAN scan)
//! runs in twigd, a Node 26 child this shell owns, over the shell pipe.
//! Replaced Electron Twig, whose behaviour it keeps (bridge.rs has the surface).
//!
//! Startup: single-instance check → paths → log → spawn twigd → `ready` →
//! the window, and the update timers.
//! Quitting: closing the window IS quitting (Twig has no tray). Every quit
//! goes through `quit`: stop twigd and its MCP servers, wait for them, install
//! a downloaded update if there is one, exit.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod job;
mod log;
mod paths;
mod pipe;
mod protocol;
mod twigd;
mod update;
mod window;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

use paths::Layout;
use twigd::{Twigd, TwigdEvent};

pub struct Shell {
    pub layout: Layout,
    pub twigd: Mutex<Option<Arc<Twigd>>>,
    pub ready: AtomicBool,
    pub quitting: AtomicBool,
}

pub fn shell(app: &AppHandle) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}

fn main() {
    let app = tauri::Builder::default()
        // First, so a second launch exits before touching anything the first owns.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::event("app", "second_instance", serde_json::Value::Null);
            window::open_or_focus(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, |ctx, request, responder| {
            let root = shell(ctx.app_handle()).layout.chat_ui.clone();
            let path = request.uri().path().to_string();
            // Off the main thread: the read is a file from disk.
            std::thread::spawn(move || responder.respond(protocol::respond(&root, &path)));
        })
        .invoke_handler(tauri::generate_handler![
            bridge::twig,
            bridge::twig_pick_root,
            bridge::twig_window,
            bridge::twig_update
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let layout = match paths::resolve(&handle) {
                Ok(l) => l,
                Err(e) => {
                    fatal(&handle, &format!("Redstart Twig could not find its folders.\n\n{e}"));
                    return Ok(());
                }
            };
            log::init(&layout.shell_dir);
            let packaged = layout.packaged;
            app.manage(Shell { layout, twigd: Mutex::new(None), ready: AtomicBool::new(false), quitting: AtomicBool::new(false) });
            // A release build on Windows or macOS updates itself; a dev run doesn't.
            app.manage(update::Updater::new(packaged && (cfg!(windows) || cfg!(target_os = "macos"))));
            start_twigd(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != window::LABEL {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if !shell(app).quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    quit(app, false);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Redstart Twig shell failed to build");

    app.run(|app, event| match event {
        // Cmd+Q, or the last window going some other way: the same graceful quit.
        RunEvent::ExitRequested { code: None, api, .. } => {
            if !shell(app).quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                quit(app, false);
            }
        }
        RunEvent::Exit => {
            if let Some(d) = shell(app).twigd.lock().unwrap().clone() {
                if !d.has_exited() {
                    d.stop();
                }
            }
        }
        _ => {}
    });
}

fn start_twigd(app: &AppHandle) {
    let s = shell(app);
    let handle = app.clone();
    let started = Twigd::start(&s.layout, move |ev| on_twigd_event(&handle, ev));
    match started {
        Ok(host) => {
            log::event("app", "twigd_spawned", json!({ "pid": host.pid }));
            *s.twigd.lock().unwrap() = Some(host);
        }
        Err(e) => {
            fatal(app, &format!("Redstart Twig could not start its local process.\n\n{e}"));
            return;
        }
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(twigd::READY_TIMEOUT);
        let s = shell(&handle);
        if !s.ready.load(Ordering::SeqCst) && !s.quitting.load(Ordering::SeqCst) {
            if let Some(d) = s.twigd.lock().unwrap().clone() {
                d.kill();
            }
            fatal(&handle, "Redstart Twig's local process did not start within 30 seconds.");
        }
    });
}

fn on_twigd_event(app: &AppHandle, ev: TwigdEvent) {
    let s = shell(app);
    match ev {
        TwigdEvent::Ready => {
            s.ready.store(true, Ordering::SeqCst);
            log::event("app", "twigd_ready", serde_json::Value::Null);
            let h = app.clone();
            let _ = app.run_on_main_thread(move || window::open_or_focus(&h));
            update::start(app);
        }
        TwigdEvent::Mcp { event, payload } => {
            let name = if event == "message" { "twig://mcp-message" } else { "twig://mcp-exit" };
            bridge::emit(app, name, payload);
        }
        TwigdEvent::Exit(info) => {
            log::event("app", "twigd_exited", json!({ "code": info.code, "expected": info.expected }));
            if info.expected || s.quitting.load(Ordering::SeqCst) {
                return;
            }
            let reason = if info.before_ready { "exited while starting" } else { "stopped unexpectedly" };
            fatal(
                app,
                &format!(
                    "Redstart Twig's local process {reason} (code {}).\n\nLocal folder tools and local MCP servers are unavailable until Twig is restarted.\n\n{}",
                    info.code.map(|c| c.to_string()).unwrap_or_else(|| "none".into()),
                    info.stderr_tail
                ),
            );
        }
    }
}

/// Every quit: the window's close button, Cmd+Q, Restart to update. Stops twigd
/// (which stops its MCP servers), then installs a waiting update or exits.
pub fn quit(app: &AppHandle, relaunch: bool) {
    let s = shell(app);
    if s.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    log::event("app", "quit", json!({ "relaunch": relaunch }));
    // The window goes at once, so closing feels like closing; the rest is
    // invisible (or the installer's own progress bar).
    if let Some(w) = app.get_webview_window(window::LABEL) {
        let _ = w.hide();
    }
    let twigd = s.twigd.lock().unwrap().clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        let pids = twigd.map(|d| d.stop()).unwrap_or_default();
        log::event("app", "twigd_stopped", json!({ "pids": pids.len() }));
        if handle.state::<update::Updater>().ready_version().is_some() && update::install(&handle, &pids, relaunch) {
            // Windows never gets here (the installer ended this process).
            handle.exit(0);
            return;
        }
        if relaunch {
            handle.restart();
        }
        handle.exit(0);
    });
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::event("app", "notify_failed", json!({ "reason": e.to_string() }));
    }
}

/// Startup (or twigd) failed: say why, in a box, and leave.
pub fn fatal(app: &AppHandle, message: &str) {
    let first = message.lines().next().unwrap_or("").to_string();
    log::event("app", "fatal", json!({ "reason": first }));
    if let Some(s) = app.try_state::<Shell>() {
        s.quitting.store(true, Ordering::SeqCst);
        if let Some(d) = s.twigd.lock().unwrap().clone() {
            d.kill();
        }
    }
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("Redstart Twig could not continue")
        .kind(MessageDialogKind::Error)
        .show(move |_| {
            std::thread::sleep(Duration::from_millis(50));
            handle.exit(1)
        });
}
