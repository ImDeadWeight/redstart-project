//! Where everything is.
//!
//!   config     %APPDATA%\redstart-twig-windows   Electron Twig's userData (its
//!              ~/Library/Application Support/…   name came from package.json
//!                                                `name`), so twig-fs-config.json
//!                                                and twig-mcp.json are found
//!                                                unchanged
//!   shell dir  <config>/shell                    this process's own files
//!
//! Packaged, under `<resource_dir>/resources`:
//!
//!   node/node(.exe)                 the pinned Node 26 (Nest's stage-node.mjs)
//!   app/twigd/{bin,daemon}          twigd, at the depth the checkout has it,
//!   shared/*.mjs                    so its `../../../shared` imports resolve here
//!   chat-ui/                        what the `twig` protocol serves
//!
//! A debug build runs the checkout: bin/twigd.mjs on REDSTART_NODE or the Node
//! Nest stages (redstart-nest/deps/node), and Nest's chat-ui dist.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Electron's userData folder name, kept so an existing install's state is found.
pub const CONFIG_DIR_NAME: &str = "redstart-twig-windows";

pub struct Layout {
    pub config: PathBuf,
    pub shell_dir: PathBuf,
    pub node: PathBuf,
    pub twigd: PathBuf,
    pub chat_ui: PathBuf,
    /// A release build: only then does the shell update itself.
    pub packaged: bool,
}

fn dev_override(name: &str) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        std::env::var_os(name).map(PathBuf::from)
    } else {
        None
    }
}

pub fn resolve(app: &AppHandle) -> Result<Layout, String> {
    let appdata = app.path().data_dir().map_err(|e| format!("No app data folder: {e}"))?;
    let config = dev_override("TWIG_CONFIG_DIR").unwrap_or_else(|| appdata.join(CONFIG_DIR_NAME));
    let shell_dir = config.join("shell");

    if cfg!(debug_assertions) {
        // shell/ sits inside redstart-twig/windows/, the checkout twigd runs from.
        let twig = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .ok_or("No checkout above the shell crate")?;
        let nest = twig.join("..").join("..").join("redstart-nest");
        let node = std::env::var_os("REDSTART_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| nest.join("deps").join("node").join(node_exe()));
        return Ok(Layout {
            config,
            shell_dir,
            node,
            twigd: twig.join("bin").join("twigd.mjs"),
            chat_ui: nest.join("src").join("chat-ui").join("dist"),
            packaged: false,
        });
    }

    let resources = plain_path(
        app.path()
            .resource_dir()
            .map_err(|e| format!("No resource directory: {e}"))?
            .join("resources"),
    );
    Ok(packaged_layout(config, shell_dir, &resources))
}

fn packaged_layout(config: PathBuf, shell_dir: PathBuf, resources: &Path) -> Layout {
    Layout {
        config,
        shell_dir,
        node: resources.join("node").join(node_exe()),
        twigd: resources.join("app").join("twigd").join("bin").join("twigd.mjs"),
        chat_ui: resources.join("chat-ui"),
        packaged: true,
    }
}

/// `\\?\C:\…` → `C:\…`. Tauri's resource_dir is a verbatim path, and twigd
/// shows paths derived from it to the user. UNC (`\\?\UNC\…`) is left alone.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefix_is_dropped_but_unc_is_kept() {
        assert_eq!(plain_path(PathBuf::from(r"\\?\C:\Apps\Twig\resources")), PathBuf::from(r"C:\Apps\Twig\resources"));
        assert_eq!(plain_path(PathBuf::from(r"\\?\UNC\srv\share")), PathBuf::from(r"\\?\UNC\srv\share"));
    }

    /// twigd imports `../../../shared/…` from bin/ and daemon/. In the checkout
    /// that is the repo's shared/; packaged it must be resources/shared, which is
    /// where stage-shell-bundle.mjs puts it.
    #[test]
    fn packaged_twigd_sits_three_levels_below_resources() {
        let res = PathBuf::from("R");
        let l = packaged_layout(PathBuf::from("C"), PathBuf::from("C/shell"), &res);
        let shared = l.twigd.parent().unwrap().join("..").join("..").join("..").join("shared");
        let normal: PathBuf = shared.components().fold(PathBuf::new(), |mut acc, c| {
            match c {
                std::path::Component::ParentDir => {
                    acc.pop();
                }
                other => acc.push(other),
            }
            acc
        });
        assert_eq!(normal, res.join("shared"));
    }
}
