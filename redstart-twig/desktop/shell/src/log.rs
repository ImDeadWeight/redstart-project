//! The shell's own event log: `<config>/shell/redstart.log`, one JSON object
//! per line, the same shape `daemon/logger.mjs` writes, so one reader
//! handles both. Copied from Nest's shell (redstart-nest/shell/src/log.rs)
//! and kept in step by hand, as pipe.rs and job.rs are. twigd itself writes
//! only to stderr, which the shell keeps as a tail for startup failures.
//!
//! Fields are passed in by the caller and must already be safe to log. Like
//! the JS logger, this never sees a secret, a token or a path under the
//! user's documents.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

/// Rotate at start-up past this size, keeping one previous generation (as
/// logger.mjs does).
const MAX_BYTES: u64 = 5 * 1024 * 1024;

static LOG: Mutex<Option<File>> = Mutex::new(None);

pub fn init(dir: &Path) {
    if let Err(err) = fs::create_dir_all(dir) {
        eprintln!("[logger] file logging disabled: {err}");
        return;
    }
    let path = dir.join("redstart.log");
    if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("redstart.log.1"));
    }
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => *LOG.lock().unwrap() = Some(f),
        Err(err) => eprintln!("[logger] file logging disabled: {err}"),
    }
    event("app", "logger_started", Value::Null);
}

/// `fields` is a JSON object (or Null for none).
pub fn event(cat: &str, event: &str, fields: Value) {
    let mut record = Map::new();
    record.insert("t".into(), Value::String(now_iso()));
    record.insert("cat".into(), Value::String(cat.into()));
    record.insert("event".into(), Value::String(event.into()));
    if let Value::Object(extra) = fields {
        for (k, v) in extra {
            record.insert(k, v);
        }
    }
    let line = Value::Object(record).to_string();
    if cfg!(debug_assertions) {
        eprintln!("[{cat}] {event}");
    }
    if let Some(f) = LOG.lock().unwrap().as_mut() {
        let _ = writeln!(f, "{line}");
    }
}

/// `2026-11-05T19:42:35.075Z`, UTC, from the system clock. No date crate for
/// one format: the civil-from-days conversion is Howard Hinnant's.
pub fn now_iso() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    iso_from_millis(d.as_millis() as i64)
}

pub fn iso_from_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_known_instants() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        // Date.parse('2026-11-05T19:42:35.075Z')
        assert_eq!(iso_from_millis(1_793_907_755_075), "2026-11-05T19:42:35.075Z");
        // A leap day.
        assert_eq!(iso_from_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
