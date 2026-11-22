//! Where everything is: the same locations the Electron shell used, passed
//! to nestd explicitly (plan D4), so an existing install's state is found
//! unchanged.
//!
//!   config           %APPDATA%\redstart          (Electron's userData)
//!   capability base  Documents\Redstart (Windows); ~/Redstart (macOS, see
//!                    default_capability_base)
//!   shell dir        <config>\shell              (this process's own files)
//!
//! Packaged, the daemon and its runtime sit under `<resource_dir>/resources`,
//! the layout Electron's `resources/` had, so the daemon's own lookups
//! (resources/bin, resources/chat-ui, resources/elevate.exe, and
//! `../../../shared` from resources/app/daemon) stay as they are:
//!
//!   resources/node/node.exe
//!   resources/app/{bin,daemon,dist,node_modules,package.json}
//!   resources/{shared,bin,chat-ui,elevate.exe}
//!
//! A debug build runs the checkout instead: `bin/nestd.mjs` on
//! REDSTART_NODE or the staged deps/node at the repo root, with no resources directory.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

pub struct Layout {
    pub config: PathBuf,
    pub capability_base: PathBuf,
    pub shell_dir: PathBuf,
    pub node: PathBuf,
    pub nestd: PathBuf,
    /// `--resources` for nestd. None on a dev run (the daemon then uses the
    /// checkout's own trees).
    pub resources: Option<PathBuf>,
    /// A release build. Only then does the shell own the login item.
    pub packaged: bool,
    /// The admin UI to load instead of the listener (dev only), e.g. Vite.
    pub dev_url: Option<String>,
}

fn dev_override(name: &str) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        std::env::var_os(name).map(PathBuf::from)
    } else {
        None
    }
}

/// Where the models folder and the Documents, SQLite and Vault folders live.
///
/// macOS guards ~/Documents (and Desktop, Downloads) behind a per-app privacy
/// prompt. Answering "Don't Allow" once, or the prompt going to the
/// background daemon rather than the window, left every model download and
/// tool folder failing with EPERM. Because the builds are only ad-hoc signed,
/// macOS can also treat an update as a new app and ask again. ~/Redstart is
/// visible in Finder like Documents is, and nothing guards it.
///
/// An install that already has ~/Documents/Redstart keeps it, so nobody's
/// models or files move out from under them.
pub fn default_capability_base(documents: &Path, home: Option<&Path>, is_macos: bool) -> PathBuf {
    let in_documents = documents.join("Redstart");
    match home {
        Some(home) if is_macos && !in_documents.exists() => home.join("Redstart"),
        _ => in_documents,
    }
}

pub fn resolve(app: &AppHandle) -> Result<Layout, String> {
    // %APPDATA% on Windows, ~/Library/Application Support on macOS: where
    // Electron's userData lived (app name "redstart").
    let appdata = app.path().data_dir().map_err(|e| format!("No app data folder: {e}"))?;
    let documents = app
        .path()
        .document_dir()
        .map_err(|e| format!("No Documents folder: {e}"))?;

    let config = dev_override("REDSTART_CONFIG_DIR").unwrap_or_else(|| appdata.join("redstart"));
    let home = app.path().home_dir().ok();
    let capability_base = dev_override("REDSTART_CAPABILITY_BASE")
        .unwrap_or_else(|| default_capability_base(&documents, home.as_deref(), cfg!(target_os = "macos")));
    let shell_dir = config.join("shell");

    if cfg!(debug_assertions) {
        // shell/ sits inside redstart-nest/, the checkout nestd runs from.
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .ok_or("No checkout above the shell crate")?;
        // tooling/stage-node.mjs stages one Node for both apps at the repo root.
        let node = std::env::var_os("REDSTART_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| repo.join("..").join("deps").join("node").join(node_exe()));
        return Ok(Layout {
            config,
            capability_base,
            shell_dir,
            node,
            nestd: repo.join("bin").join("nestd.mjs"),
            resources: None,
            packaged: false,
            dev_url: std::env::var("REDSTART_DEV_URL").ok(),
        });
    }

    let resources = plain_path(
        app.path()
            .resource_dir()
            .map_err(|e| format!("No resource directory: {e}"))?
            .join("resources"),
    );
    Ok(Layout {
        config,
        capability_base,
        shell_dir,
        node: resources.join("node").join(node_exe()),
        nestd: resources.join("app").join("bin").join("nestd.mjs"),
        resources: Some(resources),
        packaged: true,
        dev_url: None,
    })
}

/// `\\?\C:\…` → `C:\…`. Tauri's resource_dir is a verbatim path, and the
/// daemon derives every resource path from `--resources`: llama-server's
/// command line, firewall rules, messages to the user. A verbatim prefix in
/// those is at best noise. UNC (`\\?\UNC\…`) is left alone.
pub fn plain_path(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with(r"UNC\") => PathBuf::from(rest),
        _ => p,
    }
}

fn node_exe() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// One-time glue from the 2026-07 rebrand, ported from index.mjs: copy the
/// four state files from the old Beaver userData if this install has none.
pub fn migrate_from_beaver(config: &std::path::Path) {
    let Some(old) = config.parent().map(|p| p.join("beaver")) else { return };
    if old == config || !old.exists() {
        return;
    }
    for file in ["profiles.json", "accounts.json", "tools.json", "settings.json"] {
        let from = old.join(file);
        let to = config.join(file);
        if from.exists() && !to.exists() {
            let _ = std::fs::create_dir_all(config);
            if std::fs::copy(&from, &to).is_ok() {
                crate::log::event("app", "migrated_from_beaver", serde_json::json!({ "file": file }));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefix_is_dropped_but_unc_is_kept() {
        assert_eq!(plain_path(PathBuf::from(r"\\?\C:\Apps\Nest\resources")), PathBuf::from(r"C:\Apps\Nest\resources"));
        assert_eq!(plain_path(PathBuf::from(r"C:\Apps")), PathBuf::from(r"C:\Apps"));
        assert_eq!(plain_path(PathBuf::from(r"\\?\UNC\srv\share")), PathBuf::from(r"\\?\UNC\srv\share"));
    }
}

#[cfg(test)]
mod capability_base_tests {
    use super::default_capability_base;

    #[test]
    fn windows_and_linux_keep_documents() {
        let d = std::env::temp_dir().join("redstart-paths-test-none");
        let home = std::env::temp_dir();
        assert_eq!(default_capability_base(&d, Some(&home), false), d.join("Redstart"));
    }

    #[test]
    fn macos_defaults_to_home_when_documents_has_nothing() {
        let d = std::env::temp_dir().join("redstart-paths-test-empty-docs");
        let home = std::env::temp_dir().join("redstart-paths-test-home");
        assert_eq!(default_capability_base(&d, Some(&home), true), home.join("Redstart"));
    }

    #[test]
    fn macos_keeps_an_existing_documents_folder() {
        let d = std::env::temp_dir().join("redstart-paths-test-existing");
        std::fs::create_dir_all(d.join("Redstart")).unwrap();
        let home = std::env::temp_dir().join("redstart-paths-test-home2");
        assert_eq!(default_capability_base(&d, Some(&home), true), d.join("Redstart"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
