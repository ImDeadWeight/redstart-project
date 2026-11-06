//! The chat UI's origin: the `twig` custom protocol.
//!
//! `http://twig.localhost/` on Windows, `twig://localhost/` on macOS. Tauri
//! counts a registered custom protocol as a LOCAL origin, so the page reaches
//! the shell's commands with no `remote` capability, and the origin is the same
//! on every launch.
//!
//! That last part is a fix. Electron Twig served the UI from 127.0.0.1 on a
//! random port, so each launch was a new origin and localStorage / IndexedDB
//! started empty every time.
//!
//! The rules are Electron's file server's, unchanged:
//!   - a path that resolves outside the chat-ui folder is 403
//!   - an extensionless path other than `/` is an API call that should have
//!     gone to the configured Nest: a JSON 503 saying so, not index.html
//!     (which the UI would try to parse as JSON)
//!   - a missing file falls back to index.html (the SPA's routes)
//!   - every response carries the CSP below
//! Added: `Cache-Control: no-store`, because Electron purged the HTTP cache and
//! any service worker at every start to stop a stale UI shadowing a new one.

use std::fs;
use std::path::{Component, Path, PathBuf};

use percent_encoding::percent_decode_str;
use tauri::http::{header, Response, StatusCode};

pub const SCHEME: &str = "twig";

/// Electron Twig's CSP, as it was. connect-src stays open to any http/ws
/// address, because the user can point Twig at any machine on their network
/// and that address is unknown at build time.
pub const CSP: &str = "default-src 'self'; \
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; \
connect-src 'self' http: https: ws: wss: ipc: http://ipc.localhost; \
font-src 'self' data:; \
worker-src 'self' blob:";

/// The URL the window opens.
pub fn origin_url() -> &'static str {
    if cfg!(windows) {
        "http://twig.localhost/"
    } else {
        "twig://localhost/"
    }
}

fn mime(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// What to answer, decided without touching a Response type (unit-tested).
#[derive(Debug, PartialEq)]
pub enum Answer {
    File(PathBuf),
    Forbidden,
    BadRequest,
    NoServer,
}

/// `uri_path` is the request's path, still percent-encoded, without the query.
pub fn decide(root: &Path, uri_path: &str) -> Answer {
    let Ok(decoded) = percent_decode_str(uri_path).decode_utf8() else { return Answer::BadRequest };
    let rel = decoded.trim_start_matches('/');

    // Containment, lexically first: no parent segments, no absolute or
    // drive-qualified pieces, no backslashes smuggling a Windows separator. A
    // colon is refused outright, so `C:` means the same on every platform.
    if rel.contains('\\') || rel.contains('\0') || rel.contains(':') {
        return Answer::Forbidden;
    }
    let mut joined = root.to_path_buf();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(part) => joined.push(part),
            Component::CurDir => {}
            _ => return Answer::Forbidden,
        }
    }

    let ext = Path::new(rel).extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext.is_empty() && !rel.is_empty() {
        return Answer::NoServer;
    }
    if !ext.is_empty() && joined.is_file() {
        // And by the real path: a link inside the dist must not lead out of it.
        return match (fs::canonicalize(&joined), fs::canonicalize(root)) {
            (Ok(real), Ok(real_root)) if real.starts_with(&real_root) => Answer::File(joined),
            _ => Answer::Forbidden,
        };
    }
    Answer::File(root.join("index.html"))
}

pub fn respond(root: &Path, uri_path: &str) -> Response<Vec<u8>> {
    let base = |status: StatusCode, ctype: &str, body: Vec<u8>| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, ctype)
            .header(header::CONTENT_SECURITY_POLICY, CSP)
            .header(header::CACHE_CONTROL, "no-store")
            .body(body)
            .unwrap()
    };
    match decide(root, uri_path) {
        Answer::BadRequest => base(StatusCode::BAD_REQUEST, "text/plain", b"Bad request".to_vec()),
        Answer::Forbidden => base(StatusCode::FORBIDDEN, "text/plain", b"Forbidden".to_vec()),
        Answer::NoServer => base(
            StatusCode::SERVICE_UNAVAILABLE,
            "application/json",
            r#"{"error":"No server configured. Go to Settings → Server to enter your Redstart Nest address."}"#.as_bytes().to_vec(),
        ),
        Answer::File(path) => match fs::read(&path) {
            Ok(bytes) => {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                base(StatusCode::OK, mime(ext), bytes)
            }
            Err(_) => base(StatusCode::NOT_FOUND, "text/plain", b"Not found".to_vec()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dist(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("twig-protocol-{}-{name}", std::process::id()));
        let root = base.join("dist");
        fs::create_dir_all(root.join("_app")).unwrap();
        fs::write(root.join("index.html"), "<html>").unwrap();
        fs::write(root.join("_app").join("start.js"), "x").unwrap();
        fs::write(base.join("secret.txt"), "outside").unwrap();
        (base, root)
    }

    #[test]
    fn the_rules_electron_twig_had() {
        let (base, root) = dist("rules");
        assert_eq!(decide(&root, "/"), Answer::File(root.join("index.html")));
        assert_eq!(decide(&root, "/_app/start.js"), Answer::File(root.join("_app").join("start.js")));
        // a missing asset: the SPA fallback
        assert_eq!(decide(&root, "/_app/gone.js"), Answer::File(root.join("index.html")));
        // an API call with no server configured
        assert_eq!(decide(&root, "/props"), Answer::NoServer);
        assert_eq!(decide(&root, "/v1/chat/completions"), Answer::NoServer);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn nothing_outside_the_dist_is_served() {
        let (base, root) = dist("outside");
        for p in ["/../secret.txt", "/%2e%2e/secret.txt", "/_app/..%2f..%2fsecret.txt", "/..%5csecret.txt", "/C:/Windows/win.ini", "/%00.js"] {
            assert_eq!(decide(&root, p), Answer::Forbidden, "{p}");
        }
        assert_eq!(decide(&root, "/%ff.js"), Answer::BadRequest);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn responses_carry_the_csp_and_no_store() {
        let (base, root) = dist("headers");
        let r = respond(&root, "/props");
        assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(r.headers()[header::CONTENT_SECURITY_POLICY], CSP);
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
        let ok = respond(&root, "/_app/start.js");
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "application/javascript");
        fs::remove_dir_all(base).unwrap();
    }
}
