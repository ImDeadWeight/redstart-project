//! Windows Firewall rules, added by this program running elevated.
//!
//! Adding an inbound rule needs admin; Nest runs unelevated. The daemon used
//! to run `elevate.exe netsh …` once per rule, so UAC asked about "Network
//! Shell" (netsh.exe, Microsoft's) several times and never named Redstart.
//! Now the daemon asks the shell over the pipe (`firewall-add`), and the shell
//! starts ITSELF elevated with `--add-firewall-rules <rules>`: one UAC prompt
//! for every missing rule, naming Redstart Nest. Once the exe is
//! Authenticode-signed, the prompt also shows a verified publisher. Until
//! then Windows shows "Publisher: Unknown".
//!
//! The elevated half trusts nothing it is given. The rules arrive as
//! base64url JSON from an unelevated caller, so each one is validated again
//! here before netsh sees it. The rule name must be one of Nest's. The
//! direction, action and remote scope (`localsubnet`, the LAN only) are
//! fixed here and not passed in. netsh is run by its full System32 path,
//! never looked up on PATH.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use serde_json::{json, Value};

/// The argument that selects the elevated mode (main.rs checks it first).
pub const ELEVATED_FLAG: &str = "--add-firewall-rules";
const NAME_PREFIX: &str = "RedstartNest ";
const MAX_RULES: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub name: String,
    pub protocol: String,
    pub port: String,
    pub program: Option<String>,
}

/// One rule from the daemon's JSON, or why it is refused.
pub fn parse_rule(v: &Value) -> Result<Rule, String> {
    let name = v["name"].as_str().ok_or("rule: no name")?;
    if !name.starts_with(NAME_PREFIX)
        || name.len() > 100
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || " +()._-".contains(c))
    {
        return Err(format!("rule: refused name {name:?}"));
    }
    let protocol = v["protocol"].as_str().ok_or("rule: no protocol")?;
    if protocol != "TCP" && protocol != "UDP" {
        return Err(format!("rule: refused protocol {protocol:?}"));
    }
    let port = match &v["port"] {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return Err("rule: no port".into()),
    };
    let ports_ok = !port.is_empty()
        && port.split(',').all(|p| {
            !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()) && matches!(p.parse::<u32>(), Ok(1..=65535))
        });
    if !ports_ok {
        return Err(format!("rule: refused port {port:?}"));
    }
    let program = match &v["program"] {
        Value::Null => None,
        Value::String(p) => {
            if !is_windows_absolute(p) || p.contains('"') || !p.to_ascii_lowercase().ends_with(".exe") {
                return Err(format!("rule: refused program {p:?}"));
            }
            Some(p.clone())
        }
        _ => return Err("rule: program must be a path".into()),
    };
    Ok(Rule { name: name.to_string(), protocol: protocol.to_string(), port, program })
}

/// `C:\...` or `\\server\share\...`. The path is always for Windows netsh, so
/// this judges it by Windows rules on every host. `Path::is_absolute` uses the
/// host's rules and calls `C:\...` relative on macOS and Linux.
fn is_windows_absolute(p: &str) -> bool {
    let b = p.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\') || p.starts_with("\\\\")
}

pub fn parse_rules(v: &Value) -> Result<Vec<Rule>, String> {
    let list = v.as_array().ok_or("rules must be a list")?;
    if list.is_empty() || list.len() > MAX_RULES {
        return Err(format!("between 1 and {MAX_RULES} rules, got {}", list.len()));
    }
    list.iter().map(parse_rule).collect()
}

pub fn encode_rules(rules: &[Rule]) -> String {
    let v: Vec<Value> = rules
        .iter()
        .map(|r| json!({ "name": r.name, "protocol": r.protocol, "port": r.port, "program": r.program }))
        .collect();
    B64URL.encode(serde_json::to_vec(&v).unwrap_or_default())
}

pub fn decode_rules(arg: &str) -> Result<Vec<Rule>, String> {
    let bytes = B64URL.decode(arg).map_err(|e| format!("rules: {e}"))?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("rules: {e}"))?;
    parse_rules(&v)
}

/// netsh's arguments for one rule. Direction, action and scope are fixed.
pub fn netsh_add_args(r: &Rule) -> Vec<String> {
    let mut a = vec![
        "advfirewall".into(),
        "firewall".into(),
        "add".into(),
        "rule".into(),
        format!("name={}", r.name),
        "dir=in".into(),
        "action=allow".into(),
        format!("protocol={}", r.protocol),
        format!("localport={}", r.port),
    ];
    if let Some(p) = &r.program {
        a.push(format!("program={p}"));
    }
    a.push("remoteip=localsubnet".into());
    a
}

/// main.rs calls this before anything else. `Some(exit code)` means this
/// process is the elevated helper and must exit without starting the app.
pub fn elevated_entry() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(ELEVATED_FLAG) {
        return None;
    }
    let Some(arg) = args.get(2) else { return Some(2) };
    let rules = match decode_rules(arg) {
        Ok(r) => r,
        Err(_) => return Some(2),
    };
    Some(imp::add_all(&rules))
}

/// The `firewall-add` pipe request: validate, elevate this exe once for all
/// the rules, wait for it. Err when the prompt is declined or cannot be shown.
/// The daemon checks afterwards which rules exist, so the exit code is only
/// reported back, never trusted for anything.
pub fn request(params: &Value) -> Result<Value, String> {
    let rules = parse_rules(&params["rules"])?;
    let code = imp::run_elevated(&encode_rules(&rules))?;
    Ok(json!({ "exitCode": code }))
}

#[cfg(windows)]
mod imp {
    use super::{netsh_add_args, Rule, ELEVATED_FLAG};
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const ERROR_CANCELLED: u32 = 1223;
    const WAIT_MS: u32 = 120_000;

    fn netsh() -> std::path::PathBuf {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        std::path::Path::new(&root).join("System32").join("netsh.exe")
    }

    fn exists(name: &str) -> bool {
        Command::new(netsh())
            .args(["advfirewall", "firewall", "show", "rule", &format!("name={name}"), "dir=in"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains(name))
            .unwrap_or(false)
    }

    /// Elevated: add each rule not already there. 0 when all are present.
    pub fn add_all(rules: &[Rule]) -> i32 {
        let mut failed = 0;
        for r in rules {
            if exists(&r.name) {
                continue;
            }
            let ok = Command::new(netsh())
                .args(netsh_add_args(r))
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok {
                failed += 1;
            }
        }
        if failed == 0 { 0 } else { 1 }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Start this exe elevated ("runas") and wait. The UAC prompt names
    /// this program, which is the point of the module.
    pub fn run_elevated(encoded: &str) -> Result<u32, String> {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

        let exe = std::env::current_exe().map_err(|e| format!("Could not find this program: {e}"))?;
        let file = wide(&exe.to_string_lossy());
        let verb = wide("runas");
        // base64url has no spaces or quotes, so no quoting is needed.
        let params = wide(&format!("{ELEVATED_FLAG} {encoded}"));

        // SAFETY: a zeroed SHELLEXECUTEINFOW is its documented empty state;
        // every pointer set below outlives the call.
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = params.as_ptr();
        info.nShow = SW_HIDE;

        // SAFETY: info is initialised above; hProcess is ours to close.
        unsafe {
            if ShellExecuteExW(&mut info) == 0 {
                let err = GetLastError();
                return Err(if err == ERROR_CANCELLED {
                    "The administrator prompt was declined".into()
                } else {
                    format!("Could not ask for administrator rights (error {err})")
                });
            }
            if info.hProcess.is_null() {
                return Err("The elevated helper did not start".into());
            }
            WaitForSingleObject(info.hProcess, WAIT_MS);
            let mut code: u32 = 259; // STILL_ACTIVE, if the wait timed out
            GetExitCodeProcess(info.hProcess, &mut code);
            CloseHandle(info.hProcess);
            Ok(code)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Rule;
    pub fn add_all(_rules: &[Rule]) -> i32 {
        2
    }
    pub fn run_elevated(_encoded: &str) -> Result<u32, String> {
        Err("Firewall rules are only added on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(v: Value) -> Result<Rule, String> {
        parse_rule(&v)
    }

    #[test]
    fn accepts_nests_own_rules() {
        let r = rule(json!({ "name": "RedstartNest Gateway 19080 (LAN only)", "protocol": "TCP", "port": 19080 })).unwrap();
        assert_eq!(r.port, "19080");
        assert!(rule(json!({ "name": "RedstartNest Caddy HTTPS+admin (LAN only)", "protocol": "TCP", "port": "80,443,8443", "program": "C:\\Program Files\\Redstart Nest\\resources\\bin\\caddy.exe" })).is_ok());
    }

    #[test]
    fn refuses_anything_else() {
        // Not Nest's name: an unelevated caller cannot use the helper to edit other rules.
        assert!(rule(json!({ "name": "Remote Desktop", "protocol": "TCP", "port": 3389 })).is_err());
        // An injected netsh argument rides in the name.
        assert!(rule(json!({ "name": "RedstartNest x remoteip=any", "protocol": "TCP", "port": 1 })).is_err());
        assert!(rule(json!({ "name": "RedstartNest x", "protocol": "ANY", "port": 1 })).is_err());
        for port in [json!(0), json!(70000), json!("80,"), json!("1-65535"), json!("80 remoteip=any")] {
            assert!(rule(json!({ "name": "RedstartNest x", "protocol": "TCP", "port": port })).is_err(), "{port}");
        }
        for program in ["caddy.exe", "C:caddy.exe", "/usr/bin/caddy.exe","C:\\x\\caddy.exe\" remoteip=any", "C:\\x\\script.ps1"] {
            assert!(rule(json!({ "name": "RedstartNest x", "protocol": "TCP", "port": 80, "program": program })).is_err(), "{program}");
        }
        assert!(parse_rules(&json!([])).is_err());
    }

    #[test]
    fn scope_is_fixed_by_the_helper() {
        let r = rule(json!({ "name": "RedstartNest Gateway 80 (LAN only)", "protocol": "TCP", "port": 80, "remoteip": "any", "action": "block" })).unwrap();
        let args = netsh_add_args(&r);
        assert_eq!(args.last().unwrap(), "remoteip=localsubnet");
        assert!(args.contains(&"dir=in".to_string()) && args.contains(&"action=allow".to_string()));
        assert_eq!(args.iter().filter(|a| a.starts_with("remoteip=")).count(), 1);
    }

    #[test]
    fn round_trips_through_the_command_line() {
        let rules = parse_rules(&json!([
            { "name": "RedstartNest Gateway 19080 (LAN only)", "protocol": "TCP", "port": 19080 },
            { "name": "RedstartNest Caddy HTTPS+admin (LAN only)", "protocol": "TCP", "port": "80,443,8443", "program": "C:\\a b\\caddy.exe" },
        ]))
        .unwrap();
        let enc = encode_rules(&rules);
        assert!(enc.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(decode_rules(&enc).unwrap(), rules);
    }
}
