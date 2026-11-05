//! DPAPI, CurrentUser scope, no extra entropy: the calls Chromium's OSCrypt
//! makes, which is what lets a key copied out of Electron's `Local State` be
//! unwrapped here (plan D1a). This replaces T1's PowerShell
//! `ProtectedData` round trip, and with it the Constrained Language Mode gap.

#[cfg(windows)]
mod imp {
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    /// Copies DPAPI's LocalAlloc'd output into a Vec, then frees it.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        v
    }

    pub fn unprotect(wrapped: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(wrapped);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        let ok = unsafe {
            CryptUnprotectData(&input, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            return Err(format!(
                "Windows could not unwrap the secrets key for this account (DPAPI error {code}). \
                 It was wrapped by another Windows account or on another machine."
            ));
        }
        Ok(unsafe { take(out) })
    }

    pub fn protect(raw: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(raw);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        let ok = unsafe {
            CryptProtectData(&input, null(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            return Err(format!("Windows could not protect the secrets key (DPAPI error {code})"));
        }
        Ok(unsafe { take(out) })
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("DPAPI exists only on Windows; the macOS shell needs a Keychain key source".into())
    }
    pub fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("DPAPI exists only on Windows; the macOS shell needs a Keychain key source".into())
    }
}

pub use imp::{protect, unprotect};
