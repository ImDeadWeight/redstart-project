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

#[cfg(not(windows))]
pub fn is_enabled() -> bool {
    false
}

#[cfg(not(windows))]
pub fn set(_: bool, _: &[String]) -> Result<(), String> {
    Err("No login items in this shell yet".into())
}
