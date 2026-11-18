//! The one window: the chat UI, from the `twig` protocol.
//!
//! Windows: no OS frame. The page draws the title bar and its minimise /
//! maximise / close buttons (the `twig-desktop` styles in the chat-ui's
//! app.css), which call `twig_window`. Electron had Windows draw those buttons
//! as an overlay. Tauri has no overlay, so the page draws them, and the old
//! height and colour agreement between two codebases is gone with it.
//! macOS: native traffic lights over the page's top bar.
//!
//! Containment: navigation off the `twig` origin is denied. A link the page
//! opens in a new window (a chat answer's citation, say) goes to the system
//! browser if it is http(s) or mailto, and is dropped otherwise. Electron let
//! those open as new app windows with the preload in them.

use serde_json::json;
use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::bridge::BRIDGE_JS;
use crate::{log, protocol};

pub const LABEL: &str = "main";

/// The chat-ui renders a little large for a desktop window at 100%, so the
/// whole page is zoomed, as Electron Twig did (UI_ZOOM 0.8). Uniformly, so
/// spacing and hit targets scale with the text.
const UI_ZOOM: f64 = 0.8;

/// oklch(0.12 0 0), the chat-ui's background, so the first frame is not white.
const BACKGROUND: Color = Color(6, 6, 6, 255);

pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Which links leave for the system browser.
pub fn opens_externally(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

pub fn open_or_focus(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let origin = Url::parse(protocol::origin_url()).expect("origin URL");
    let nav_origin = origin.clone();
    let opener = app.clone();
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::CustomProtocol(origin))
        .title("Redstart Twig")
        .inner_size(1280.0, 860.0)
        .min_inner_size(480.0, 360.0);
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false).shadow(true);
    let built = builder
        .background_color(BACKGROUND)
        .initialization_script(BRIDGE_JS)
        .on_new_window(move |url, _| {
            if opens_externally(&url) {
                if let Err(e) = opener.opener().open_url(url.as_str(), None::<&str>) {
                    log::event("app", "open_external_failed", json!({ "reason": e.to_string() }));
                }
            } else {
                log::event("security", "window_open_denied", json!({ "scheme": url.scheme() }));
            }
            NewWindowResponse::Deny
        })
        .on_navigation(move |to| {
            let ok = same_origin(to, &nav_origin);
            if !ok {
                log::event("security", "navigation_denied", json!({ "scheme": to.scheme() }));
            }
            ok
        })
        .build();
    match built {
        Ok(w) => {
            if let Err(e) = w.set_zoom(UI_ZOOM) {
                log::event("app", "zoom_failed", json!({ "reason": e.to_string() }));
            }
        }
        Err(e) => log::event("app", "window_failed", json!({ "reason": e.to_string() })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_twig_origin_is_navigable() {
        let o = Url::parse(protocol::origin_url()).unwrap();
        assert!(same_origin(&o.join("/settings?x=1").unwrap(), &o));
        assert!(!same_origin(&Url::parse("http://192.168.1.20:19080/").unwrap(), &o));
        assert!(!same_origin(&Url::parse("https://example.com/").unwrap(), &o));
    }

    #[test]
    fn only_web_and_mail_links_leave_for_the_browser() {
        assert!(opens_externally(&Url::parse("https://example.com/a").unwrap()));
        assert!(opens_externally(&Url::parse("mailto:a@b.c").unwrap()));
        assert!(!opens_externally(&Url::parse("file:///C:/Windows/win.ini").unwrap()));
        assert!(!opens_externally(&Url::parse("javascript:alert(1)").unwrap()));
    }
}
