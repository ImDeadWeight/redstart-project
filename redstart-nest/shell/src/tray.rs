//! The notification-area icon: the same items the Electron shell's tray had.
//! Open Redstart, a model status line, Stop model (while one runs), and
//! Quit Redstart. The update items return with T3's updater.
//!
//! It holds no state of its own. Whether a model runs comes from the
//! daemon's `server:started` / `server:stopped` events (through the pipe), so
//! the tray agrees with every admin UI by construction.

use std::sync::atomic::Ordering;

use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::update::Updater;
use crate::{deliberate_quit, deliberate_quit_with, log, shell, window};
use tauri::Manager;

const TRAY_ID: &str = "main";

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let running = shell(app).model_running.load(Ordering::SeqCst);
    let open = MenuItem::with_id(app, "open", "Open Redstart", true, None::<&str>)?;
    let status = MenuItem::with_id(
        app,
        "status",
        if running { "Model: running" } else { "Model: stopped" },
        false,
        None::<&str>,
    )?;
    let stop = MenuItem::with_id(app, "stop-model", "Stop model", true, None::<&str>)?;
    let ready = app.try_state::<Updater>().and_then(|u| u.ready_version());
    // Quitting also installs a downloaded update, and the label says so: a
    // quit is never an install the user didn't see coming.
    let quit_label = if ready.is_some() { "Quit Redstart and install update" } else { "Quit Redstart" };
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep1, &status])?;
    if running {
        menu.append(&stop)?;
    }
    menu.append(&sep2)?;
    if let Some(v) = ready {
        menu.append(&MenuItem::with_id(app, "install-update", format!("Restart to update to {v}"), true, None::<&str>)?)?;
    }
    menu.append(&quit)?;
    Ok(menu)
}

fn tooltip(app: &AppHandle) -> String {
    let running = shell(app).model_running.load(Ordering::SeqCst);
    format!("Redstart — {}", if running { "model running" } else { "model stopped" })
}

/// Main thread only (called from the `ready` handler's run_on_main_thread).
pub fn start(app: &AppHandle) {
    let result = (|| -> tauri::Result<()> {
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip(tooltip(app))
            .menu(&menu(app)?)
            // Windows convention: left-click opens, right-click shows the menu.
            .show_menu_on_left_click(false)
            .on_menu_event(|app, e| match e.id.as_ref() {
                "open" => window::open_or_focus(app),
                "stop-model" => {
                    log::event("app", "tray_stop_model", Value::Null);
                    let daemon = shell(app).daemon.lock().unwrap().clone();
                    std::thread::spawn(move || {
                        if let Some(Err(err)) = daemon.map(|d| d.stop_model()) {
                            log::event("app", "tray_stop_model_failed", serde_json::json!({ "reason": err }));
                        }
                    });
                }
                "quit" => {
                    log::event("app", "tray_quit", Value::Null);
                    deliberate_quit(app);
                }
                "install-update" => {
                    log::event("app", "tray_install_update", Value::Null);
                    deliberate_quit_with(app, true);
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, e| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                    window::open_or_focus(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    })();
    match result {
        Ok(()) => log::event("app", "tray_started", Value::Null),
        // No tray means no tray affordance, not no daemon.
        Err(e) => log::event("app", "tray_start_failed", serde_json::json!({ "reason": e.to_string() })),
    }
}

/// Rebuild the menu and tooltip for the current model state. Any thread.
pub fn refresh(app: &AppHandle) {
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(tray) = h.tray_by_id(TRAY_ID) else { return };
        if let Ok(m) = menu(&h) {
            let _ = tray.set_menu(Some(m));
        }
        let _ = tray.set_tooltip(Some(tooltip(&h)));
    });
}
