//! macOS: the secrets key's source is a password in the login Keychain, the
//! one Electron's safeStorage created (Chromium's os_crypt_mac). The daemon
//! derives the AES key from it (secrets-dpapi.mjs, oscryptMacProvider). The
//! shell only fetches it, as the Windows shell only unwraps.
//!
//! Electron names the item after the app name, which for Nest is the package
//! name `redstart` (it is also why userData is "…/Application Support/redstart"):
//! service "redstart Safe Storage", account "redstart". The product name is
//! tried too, in case a build ever carried it.
//!
//! The item's ACL trusts the Electron app that made it. The first time the
//! Tauri app reads it, macOS asks the user to allow it ("Always Allow"
//! makes that the last time). The release notes say so.
//!
//! UNTESTED ON A MAC from the author's machine: compiled and unit-tested on CI's
//! macos runner only. See the implementation notes.

#[cfg(target_os = "macos")]
mod imp {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    use security_framework::passwords::{get_generic_password, set_generic_password};

    const CANDIDATES: [(&str, &str); 3] = [
        ("redstart Safe Storage", "redstart"),
        ("Redstart Nest Safe Storage", "Redstart Nest"),
        ("Redstart Nest Safe Storage", "Redstart Nest Key"),
    ];

    /// The password's bytes and where they came from: "keychain" or
    /// "keychain-generated".
    pub fn resolve() -> Result<(Vec<u8>, &'static str), String> {
        for (service, account) in CANDIDATES {
            if let Ok(pw) = get_generic_password(service, account) {
                if !pw.is_empty() {
                    return Ok((pw, "keychain"));
                }
            }
        }
        // None yet: create one the way Electron does (16 random bytes,
        // base64), under the name Electron would have used, so a later
        // Electron build of the same app reads the same secrets.
        let mut raw = [0u8; 16];
        getrandom::fill(&mut raw).map_err(|e| format!("No randomness for a secrets key: {e}"))?;
        let pw = B64.encode(raw).into_bytes();
        let (service, account) = CANDIDATES[0];
        set_generic_password(service, account, &pw)
            .map_err(|e| format!("Could not save the secrets key to the Keychain: {e}"))?;
        Ok((pw, "keychain-generated"))
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn resolve() -> Result<(Vec<u8>, &'static str), String> {
        Err("The Keychain exists only on macOS".into())
    }
}

pub use imp::resolve;
