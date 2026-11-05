//! Redstart Nest's desktop shell (daemon split T2).
//!
//! The daemon is `nestd` on a bundled Node 26, a separate process this shell
//! owns (plan D2) and talks to over the shell pipe (D3). This process is only
//! the desktop around it: one window onto the admin listener, the tray, the
//! login item, the recycle bin, notifications, and the secrets key's DPAPI
//! unwrap. Its behaviour matches the T1 Electron shell (`daemon/index.mjs`,
//! split path), which stays the shipping shell until T3's bridge release.
//!
//! Startup: single-instance check → paths → Beaver migration → secrets key →
//! spawn nestd → `ready` → tray, then the window (not on `--background`, the
//! login item's start). Closing the window stops nothing. Quitting (tray
//! Quit, or admin Shut down) stops the daemon and waits for it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;
mod dpapi;
mod job;
mod keychain;
mod log;
mod login_item;
mod paths;
mod pipe;
mod secrets_key;
mod tray;
mod update;
mod window;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

use daemon::{DaemonEvent, DaemonHost, Hello, Ready};
use paths::Layout;

pub struct Shell {
    pub layout: Layout,
    pub daemon: Mutex<Option<Arc<DaemonHost>>>,
    pub ready: Mutex<Option<Ready>>,
    pub quitting: AtomicBool,
    pub model_running: AtomicBool,
    pub background: bool,
}

pub fn shell(app: &AppHandle) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}

static APP: OnceLock<AppHandle> = OnceLock::new();

/// For pipe requests answered off any app context (update-check).
pub fn app_handle() -> Option<&'static AppHandle> {
    APP.get()
}

fn main() {
    let background = std::env::args().any(|a| a == "--background");

    let app = tauri::Builder::default()
        // First, so a second launch exits before touching anything the first
        // one owns (ports, pid files, the tray). It brings the window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::event("app", "second_instance", serde_json::Value::Null);
            window::open_or_focus(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = APP.set(handle.clone());
            let layout = match paths::resolve(&handle) {
                Ok(l) => l,
                Err(e) => {
                    fatal(&handle, &format!("Redstart could not find its folders.\n\n{e}"));
                    return Ok(());
                }
            };
            log::init(&layout.shell_dir);
            app.manage(Shell {
                layout,
                daemon: Mutex::new(None),
                ready: Mutex::new(None),
                quitting: AtomicBool::new(false),
                model_running: AtomicBool::new(false),
                background,
            });
            // A release build on Windows updates itself. A dev run doesn't, and
            // the admin UI then says so instead of offering a dead switch.
            let packaged = shell(&handle).layout.packaged;
            app.manage(update::Updater::new(packaged && (cfg!(windows) || cfg!(target_os = "macos"))));
            start_daemon(&handle);
            Ok(())
        })
        .on_window_event(window::on_window_event)
        .build(tauri::generate_context!())
        .expect("Redstart Nest shell failed to build");

    app.run(|app, event| match event {
        // The last window closing is not a quit: the daemon, the tray and a
        // loaded model all keep running. Only our own app.exit() carries a code.
        RunEvent::ExitRequested { code: None, api, .. } => {
            log::event("app", "window_closed", serde_json::Value::Null);
            api.prevent_exit();
        }
        // However the exit came about, the daemon goes with it, gracefully if
        // it still can. deliberate_quit has normally done this already.
        RunEvent::Exit => {
            if let Some(d) = shell(app).daemon.lock().unwrap().clone() {
                if !d.has_exited() {
                    d.stop_with(Duration::from_secs(5));
                }
            }
        }
        _ => {}
    });
}

fn start_daemon(app: &AppHandle) {
    let s = shell(app);
    paths::migrate_from_beaver(&s.layout.config);

    // The key: DPAPI-unwrapped here, in the shell, natively. The daemon only
    // ever receives the unwrapped key, in hello.
    // Windows: DPAPI (secrets-key.json / Local State). macOS: the Keychain
    // password Electron's safeStorage created.
    let key_format = if cfg!(target_os = "macos") { Some("oscrypt-mac") } else { None };
    let resolved = if cfg!(target_os = "macos") {
        keychain::resolve()
    } else {
        secrets_key::resolve(&s.layout.config, &secrets_key::NATIVE)
    };
    let (mut key, source) = match resolved {
        Ok(k) => k,
        Err(e) => {
            fatal(app, &format!("Redstart could not open its secrets key.\n\n{e}"));
            return;
        }
    };
    log::event("app", "secrets_key", json!({ "source": source }));

    // A dev build never writes the Run key: it would point Windows at a
    // target/debug exe. The daemon then reports start-at-login unsupported.
    let login_item = if s.layout.packaged { Some(login_item::is_enabled()) } else { None };

    let handle = app.clone();
    let u = app.state::<update::Updater>();
    let updater = if u.active { json!({ "active": true, "status": u.status() }) } else { serde_json::Value::Null };
    let started = DaemonHost::start(&s.layout, Hello { key: key.clone(), key_format, login_item, updater }, move |ev| {
        on_daemon_event(&handle, ev)
    });
    key.iter_mut().for_each(|b| *b = 0);
    match started {
        Ok(host) => {
            log::event("app", "daemon_spawned", json!({ "pid": host.pid }));
            *s.daemon.lock().unwrap() = Some(host);
        }
        Err(e) => {
            fatal(app, &format!("Redstart could not start its server process.\n\n{e}"));
            return;
        }
    }

    // ready, or a box saying why not.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(daemon::READY_TIMEOUT);
        let s = shell(&handle);
        if s.ready.lock().unwrap().is_none() && !s.quitting.load(Ordering::SeqCst) {
            if let Some(d) = s.daemon.lock().unwrap().clone() {
                d.kill();
            }
            fatal(&handle, "Redstart's server process did not finish starting within a minute.");
        }
    });
}

fn on_daemon_event(app: &AppHandle, ev: DaemonEvent) {
    let s = shell(app);
    match ev {
        DaemonEvent::Ready(ready) => {
            let pid = s.daemon.lock().unwrap().as_ref().map(|d| d.pid);
            log::event("app", "daemon_ready", json!({ "pid": pid }));
            s.model_running.store(ready.model_running, Ordering::SeqCst);
            *s.ready.lock().unwrap() = Some(ready);
            let h = app.clone();
            let _ = app.run_on_main_thread(move || {
                tray::start(&h);
                // A login-triggered start is windowless until the user opens it.
                if !shell(&h).background {
                    window::open_or_focus(&h);
                }
            });
            update::start(app);
        }
        DaemonEvent::Event(channel) => {
            let running = match channel.as_str() {
                "server:started" => true,
                "server:stopped" => false,
                _ => return,
            };
            s.model_running.store(running, Ordering::SeqCst);
            tray::refresh(app);
        }
        DaemonEvent::Notify { title, body } => notify(app, &title, &body),
        DaemonEvent::QuitRequested => deliberate_quit(app),
        DaemonEvent::InstallUpdate => {
            if app.state::<update::Updater>().ready_version().is_some() {
                deliberate_quit_with(app, true);
            }
        }
        DaemonEvent::Exit(info) => {
            log::event("app", "daemon_exited", json!({ "code": info.code, "expected": info.expected }));
            if info.expected || s.quitting.load(Ordering::SeqCst) {
                return;
            }
            if info.before_ready {
                fatal(
                    app,
                    &format!(
                        "The Redstart server process exited during startup (code {}).\n\n{}",
                        info.code.map(|c| c.to_string()).unwrap_or_else(|| "none".into()),
                        info.stderr_tail
                    ),
                );
                return;
            }
            // Exit 0 is the daemon stopping itself (admin Shut down's
            // fallback): leave with it. Anything else warns only (settled Q3).
            s.quitting.store(true, Ordering::SeqCst);
            if info.code == Some(0) {
                app.exit(0);
                return;
            }
            notify(
                app,
                "Redstart stopped unexpectedly",
                "The Redstart server process exited. Start Redstart again from the Start menu.",
            );
            // Long enough for the toast to be handed to Windows.
            std::thread::sleep(Duration::from_millis(500));
            app.exit(1);
        }
    }
}

/// Every deliberate quit: tray Quit and admin Shut down. Stops the daemon
/// (it stops llama-server first), waits for it, then exits. A downloaded
/// update installs here and nowhere else (update.rs).
pub fn deliberate_quit(app: &AppHandle) {
    deliberate_quit_with(app, false)
}

/// `relaunch`: Restart to update, from the tray or the admin UI.
pub fn deliberate_quit_with(app: &AppHandle, relaunch: bool) {
    let s = shell(app);
    if s.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    log::event("app", "quit", serde_json::Value::Null);
    let daemon = s.daemon.lock().unwrap().clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        // Ends the process itself when it installs. When it returns, the
        // install was abandoned or there was none, and this is a plain quit.
        if app_updater_ready(&handle) && update::install_and_quit(&handle, relaunch) {
            return;
        }
        if let Some(d) = daemon {
            let pids = d.stop();
            log::event("app", "daemon_stopped", json!({ "pids": pids.len() }));
        }
        handle.exit(0);
    });
}

fn app_updater_ready(app: &AppHandle) -> bool {
    app.try_state::<update::Updater>().map(|u| u.ready_version().is_some()).unwrap_or(false)
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::event("app", "notify_failed", json!({ "reason": e.to_string() }));
    }
}

/// Startup failed: say why, in a box, and leave. There is no window to fall
/// back to and nothing for a tray to control.
pub fn fatal(app: &AppHandle, message: &str) {
    let first = message.lines().next().unwrap_or("").to_string();
    log::event("app", "daemon_start_failed", json!({ "reason": first }));
    if let Some(s) = app.try_state::<Shell>() {
        s.quitting.store(true, Ordering::SeqCst);
    }
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("Redstart could not start")
        .kind(MessageDialogKind::Error)
        .show(move |_| handle.exit(1));
}
