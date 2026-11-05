//! Start at login: one value under HKCU\...\CurrentVersion\Run.
//!
//! The daemon decides whether it should be on (settings.json, through
//! `reconcileStartupSetting`) and asks over the pipe (`login-item-set`). The
//! shell only reports and writes the OS state, as Electron's
//! `app.setLoginItemSettings` did.
//!
//! The value is named `Redstart Nest`. Electron wrote
//! `electron.app.Redstart Nest`, and T3's bridge installer removes that one.

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE: &str = "Redstart Nest";

#[cfg(windows)]
pub fn is_enabled() -> bool {
    windows_registry::CURRENT_USER
        .open(RUN_KEY)
        .and_then(|k| k.get_string(VALUE))
        .is_ok()
}

#[cfg(windows)]
pub fn set(enabled: bool, args: &[String]) -> Result<(), String> {
    let key = windows_registry::CURRENT_USER
        .create(RUN_KEY)
        .map_err(|e| format!("Run key: {e}"))?;
    if !enabled {
        // Absent already is fine: that is the state being asked for.
        let _ = key.remove_value(VALUE);
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let mut command = format!("\"{}\"", exe.display());
    for a in args {
        // The daemon only ever passes `--background`. Anything with a quote or
        // a space is refused rather than escaped into a command line.
        if a.is_empty() || a.contains('"') || a.contains(' ') {
            return Err(format!("Refusing login-item argument {a:?}"));
        }
        command.push(' ');
        command.push_str(a);
    }
    key.set_string(VALUE, &command).map_err(|e| format!("Run value: {e}"))
}

// macOS: a per-user LaunchAgent, ~/Library/LaunchAgents/com.redstart.nest.plist,
// RunAtLoad. Electron used the deprecated shared Login Items list instead;
// an entry it left there points at the same /Applications/Redstart Nest.app,
// so it starts this app too, just without --background.
#[cfg(target_os = "macos")]
fn agent_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(std::path::PathBuf::from(home).join("Library/LaunchAgents/com.redstart.nest.plist"))
}

#[cfg(target_os = "macos")]
pub fn is_enabled() -> bool {
    agent_path().map(|p| p.exists()).unwrap_or(false)
}

#[cfg(target_os = "macos")]
pub fn set(enabled: bool, args: &[String]) -> Result<(), String> {
    let path = agent_path()?;
    if !enabled {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let mut program = format!("    <string>{}</string>\n", esc(&exe.to_string_lossy()));
    for a in args {
        program.push_str(&format!("    <string>{}</string>\n", esc(a)));
    }
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>com.redstart.nest</string>\n  <key>ProgramArguments</key>\n  <array>\n{program}  </array>\n  <key>RunAtLoad</key>\n  <true/>\n</dict>\n</plist>\n"
    );
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, plist).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn is_enabled() -> bool {
    false
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn set(_: bool, _: &[String]) -> Result<(), String> {
    Err("No login items in this shell yet".into())
}
