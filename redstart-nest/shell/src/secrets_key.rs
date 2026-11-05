//! The secrets key, held by the shell and handed to the daemon in `hello`.
//! A port of `daemon/shell-secrets-key.mjs`, reading and writing the
//! same `secrets-key.json`, so an install upgraded by T1 is read here
//! unchanged.
//!
//! Order:
//!   1. `<config>/secrets-key.json` (pinned)
//!   2. Electron's `<config>/Local State` `os_crypt.encrypted_key`, checked
//!      to unwrap, then pinned. That is the key every existing secret was
//!      written under, so nothing is re-encrypted.
//!   3. a fresh random key, DPAPI-protected, pinned.
//!
//! Both files hold base64("DPAPI" + CryptProtectData(key)).

use std::fs;
use std::path::Path;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};

use crate::dpapi;

pub const SECRETS_KEY_FILE: &str = "secrets-key.json";
const LOCAL_STATE_FILE: &str = "Local State";
const DPAPI_MARKER: &[u8] = b"DPAPI";
pub const KEY_BYTES: usize = 32;

/// Function pointers rather than a trait object, so tests can swap DPAPI for
/// a reversible stand-in without touching the real one.
pub struct Dpapi {
    pub protect: fn(&[u8]) -> Result<Vec<u8>, String>,
    pub unprotect: fn(&[u8]) -> Result<Vec<u8>, String>,
}

pub const NATIVE: Dpapi = Dpapi { protect: dpapi::protect, unprotect: dpapi::unprotect };

pub fn read_wrapped(path: &Path) -> Result<Vec<u8>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let json: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let b64 = json
        .pointer("/os_crypt/encrypted_key")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{} has no os_crypt.encrypted_key", path.display()))?;
    let bytes = B64.decode(b64).map_err(|e| format!("{}: encrypted_key is not base64: {e}", path.display()))?;
    if !bytes.starts_with(DPAPI_MARKER) {
        return Err(format!("{}: encrypted_key is not DPAPI-wrapped", path.display()));
    }
    Ok(bytes[DPAPI_MARKER.len()..].to_vec())
}

fn write_key_file(path: &Path, wrapped: &[u8], source: &str) -> Result<(), String> {
    let mut marked = DPAPI_MARKER.to_vec();
    marked.extend_from_slice(wrapped);
    let body = json!({
        "os_crypt": { "encrypted_key": B64.encode(marked) },
        "source": source,
        "createdAt": crate::log::now_iso(),
        "note": "Redstart Nest secrets key, DPAPI-wrapped for this Windows account. Deleting this file makes every stored secret unreadable.",
    });
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&body).unwrap()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// The unwrapped 32-byte key and where it came from: "pinned",
/// "local-state" or "generated".
pub fn resolve(config: &Path, dpapi: &Dpapi) -> Result<(Vec<u8>, &'static str), String> {
    let unwrap = |wrapped: &[u8]| -> Result<Vec<u8>, String> {
        let key = (dpapi.unprotect)(wrapped)?;
        if key.len() != KEY_BYTES {
            return Err(format!("The secrets key unwrapped to {} bytes, not {KEY_BYTES}", key.len()));
        }
        Ok(key)
    };

    let pinned = config.join(SECRETS_KEY_FILE);
    if pinned.exists() {
        return Ok((unwrap(&read_wrapped(&pinned)?)?, "pinned"));
    }

    fs::create_dir_all(config).map_err(|e| format!("{}: {e}", config.display()))?;
    if let Ok(carried) = read_wrapped(&config.join(LOCAL_STATE_FILE)) {
        let key = unwrap(&carried)?;
        write_key_file(&pinned, &carried, "local-state")?;
        return Ok((key, "local-state"));
    }

    let mut key = vec![0u8; KEY_BYTES];
    getrandom::fill(&mut key).map_err(|e| format!("No randomness for a secrets key: {e}"))?;
    write_key_file(&pinned, &(dpapi.protect)(&key)?, "generated")?;
    Ok((key, "generated"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("redstart-shell-key-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    // Reversible stand-in: "wrapping" is XOR 0x5a, enough to tell wrapped
    // from raw and to prove the right function ran.
    fn xor(b: &[u8]) -> Result<Vec<u8>, String> {
        Ok(b.iter().map(|x| x ^ 0x5a).collect())
    }
    const FAKE: Dpapi = Dpapi { protect: xor, unprotect: xor };

    fn local_state(dir: &Path, wrapped: &[u8]) {
        let mut marked = DPAPI_MARKER.to_vec();
        marked.extend_from_slice(wrapped);
        let ls = json!({ "os_crypt": { "encrypted_key": B64.encode(marked) }, "browser": {} });
        fs::write(dir.join(LOCAL_STATE_FILE), ls.to_string()).unwrap();
    }

    #[test]
    fn carries_electrons_key_then_reads_it_pinned() {
        let dir = tmpdir("carry");
        let key: Vec<u8> = (0..32).collect();
        local_state(&dir, &xor(&key).unwrap());
        let (k1, s1) = resolve(&dir, &FAKE).unwrap();
        assert_eq!((k1.as_slice(), s1), (key.as_slice(), "local-state"));
        // Local State can change or vanish; the pin is what counts now.
        fs::remove_file(dir.join(LOCAL_STATE_FILE)).unwrap();
        let (k2, s2) = resolve(&dir, &FAKE).unwrap();
        assert_eq!((k2.as_slice(), s2), (key.as_slice(), "pinned"));
    }

    #[test]
    fn generates_when_there_is_nothing_to_carry() {
        let dir = tmpdir("gen");
        let (k1, s1) = resolve(&dir, &FAKE).unwrap();
        assert_eq!((k1.len(), s1), (KEY_BYTES, "generated"));
        let (k2, _) = resolve(&dir, &FAKE).unwrap();
        assert_eq!(k1, k2);
    }

    #[test]
    fn a_wrong_length_key_is_refused_not_used() {
        let dir = tmpdir("len");
        local_state(&dir, &xor(&[1, 2, 3]).unwrap());
        assert!(resolve(&dir, &FAKE).unwrap_err().contains("not 32"));
        assert!(!dir.join(SECRETS_KEY_FILE).exists(), "a bad key was pinned");
    }

    // The exact shape shell-secrets-key.mjs writes (T1), read here.
    #[test]
    fn reads_the_file_the_electron_shell_wrote() {
        let dir = tmpdir("t1");
        let marked = [DPAPI_MARKER, &xor(&[7u8; 32]).unwrap()[..]].concat();
        let t1 = format!(
            "{{\n  \"os_crypt\": {{\n    \"encrypted_key\": \"{}\"\n  }},\n  \"source\": \"local-state\",\n  \"createdAt\": \"2026-11-05T19:42:34.000Z\",\n  \"note\": \"x\"\n}}",
            B64.encode(marked)
        );
        fs::write(dir.join(SECRETS_KEY_FILE), t1).unwrap();
        let (k, s) = resolve(&dir, &FAKE).unwrap();
        assert_eq!((k, s), (vec![7u8; 32], "pinned"));
    }

    #[cfg(windows)]
    #[test]
    fn real_dpapi_round_trips_for_this_account() {
        let dir = tmpdir("real");
        let (k1, s1) = resolve(&dir, &NATIVE).unwrap();
        assert_eq!(s1, "generated");
        let (k2, s2) = resolve(&dir, &NATIVE).unwrap();
        assert_eq!((k1, s2), (k2, "pinned"));
    }
}

/// Manual interop check (not run by default): point REDSTART_KEY_INTEROP_DIR
/// at a directory where shell-secrets-key.mjs (PowerShell DPAPI) pinned a
/// key, and compare the hex printed here with the one Node printed.
#[cfg(all(test, windows))]
#[test]
#[ignore]
fn interop_print_key() {
    let dir = std::path::PathBuf::from(std::env::var("REDSTART_KEY_INTEROP_DIR").unwrap());
    let (k, s) = resolve(&dir, &NATIVE).unwrap();
    let hex: String = k.iter().map(|b| format!("{b:02x}")).collect();
    println!("RUST {s} {hex}");
}
