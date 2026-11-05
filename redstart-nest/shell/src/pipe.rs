//! The shell's end of the shell pipe: `daemon/shell-pipe.mjs`'s
//! framing in Rust. One JSON object per line, each carrying `"rs": 1`:
//!
//!   { rs:1, type:'request',  id, method, params }    either direction
//!   { rs:1, type:'response', id, ok, value | error } answers a request
//!   { rs:1, type:<anything else>, ... }              a one-way message
//!
//! Any other line is noise: logged, never fatal. Each side numbers its own
//! requests and matches only responses to them, so the two id spaces never
//! meet.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

pub const PROTOCOL_VERSION: u64 = 1;

type Pending = HashMap<u64, mpsc::Sender<Result<Value, String>>>;

pub struct Peer {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    next_id: AtomicU64,
    pending: Mutex<Pending>,
    closed: AtomicBool,
}

/// What the read loop hands to its owner.
pub enum Incoming {
    /// A one-way message (its `type` is neither request nor response).
    Message(Value),
    /// The other side asks for something. Answer with `Peer::respond`.
    Request { id: Value, method: String, params: Value },
}

impl Peer {
    pub fn new(writer: Box<dyn Write + Send>) -> Peer {
        Peer {
            writer: Mutex::new(Some(writer)),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        }
    }

    /// Writes one message. False when the pipe is gone.
    pub fn send(&self, mut msg: Value) -> bool {
        if let Value::Object(m) = &mut msg {
            m.insert("rs".into(), json!(PROTOCOL_VERSION));
        }
        let mut line = msg.to_string();
        line.push('\n');
        let mut w = self.writer.lock().unwrap();
        match w.as_mut() {
            Some(out) => out.write_all(line.as_bytes()).and_then(|_| out.flush()).is_ok(),
            None => false,
        }
    }

    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("shell pipe closed".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if !self.send(json!({ "type": "request", "id": id, "method": method, "params": params })) {
            self.pending.lock().unwrap().remove(&id);
            return Err("shell pipe closed".into());
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("{method}: no answer within {} s", timeout.as_secs()))
            }
        }
    }

    pub fn respond(&self, id: Value, result: Result<Value, String>) {
        let msg = match result {
            Ok(value) => json!({ "type": "response", "id": id, "ok": true, "value": value }),
            Err(error) => json!({ "type": "response", "id": id, "ok": false, "error": error }),
        };
        self.send(msg);
    }

    fn settle(&self, msg: &Value) {
        let Some(id) = msg.get("id").and_then(Value::as_u64) else { return };
        let Some(tx) = self.pending.lock().unwrap().remove(&id) else { return };
        let result = if msg.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(msg.get("value").cloned().unwrap_or(Value::Null))
        } else {
            Err(msg.get("error").and_then(Value::as_str).unwrap_or("request failed").to_string())
        };
        let _ = tx.send(result);
    }

    /// Reads until EOF, dispatching each protocol line. Blocks: run it on its
    /// own thread. On EOF every pending request fails, then it returns.
    pub fn read_loop(
        &self,
        input: impl Read,
        on_message: impl Fn(Incoming),
        on_noise: impl Fn(&str),
    ) {
        for line in BufReader::new(input).lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let msg: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => {
                    on_noise(trimmed);
                    continue;
                }
            };
            let kind = msg.get("type").and_then(Value::as_str).map(str::to_string);
            if msg.get("rs").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) || kind.is_none() {
                on_noise(trimmed);
                continue;
            }
            match kind.as_deref() {
                Some("response") => self.settle(&msg),
                Some("request") => {
                    let id = msg.get("id").cloned().unwrap_or(Value::Null);
                    let method = msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
                    let params = msg.get("params").cloned().unwrap_or(Value::Null);
                    on_message(Incoming::Request { id, method, params });
                }
                _ => on_message(Incoming::Message(msg)),
            }
        }
        self.closed.store(true, Ordering::SeqCst);
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err("shell pipe closed".into()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    #[derive(Clone, Default)]
    struct Sink(Arc<StdMutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn frames_carry_rs_and_one_line_each() {
        let sink = Sink::default();
        let peer = Peer::new(Box::new(sink.clone()));
        assert!(peer.send(json!({ "type": "hello", "key": "abc" })));
        let out = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        assert!(out.ends_with('\n') && out.matches('\n').count() == 1);
        let v: Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(v["rs"], 1);
        assert_eq!(v["type"], "hello");
    }

    #[test]
    fn noise_is_reported_and_messages_and_requests_dispatch() {
        let peer = Peer::new(Box::new(Sink::default()));
        let input = concat!(
            "plain text from a dependency\n",
            "{\"type\":\"ready\"}\n",
            "{\"rs\":1,\"type\":\"ready\",\"adminPort\":19083}\n",
            "{\"rs\":1,\"type\":\"request\",\"id\":7,\"method\":\"trash\",\"params\":{\"path\":\"x\"}}\n",
        );
        let seen = StdMutex::new(Vec::new());
        let noise = StdMutex::new(0);
        peer.read_loop(
            input.as_bytes(),
            |m| match m {
                Incoming::Message(v) => seen.lock().unwrap().push(format!("msg:{}", v["adminPort"])),
                Incoming::Request { id, method, .. } => seen.lock().unwrap().push(format!("req:{id}:{method}")),
            },
            |_| *noise.lock().unwrap() += 1,
        );
        assert_eq!(*noise.lock().unwrap(), 2, "plain text and an rs-less object are noise");
        assert_eq!(*seen.lock().unwrap(), vec!["msg:19083", "req:7:trash"]);
    }

    #[test]
    fn eof_fails_a_pending_request_instead_of_hanging() {
        let peer = Arc::new(Peer::new(Box::new(Sink::default())));
        let p = peer.clone();
        let t = std::thread::spawn(move || p.request("stop-model", json!({}), Duration::from_secs(10)));
        std::thread::sleep(Duration::from_millis(100));
        peer.read_loop("".as_bytes(), |_| {}, |_| {});
        assert_eq!(t.join().unwrap().unwrap_err(), "shell pipe closed");
    }

    #[test]
    fn a_response_settles_its_request() {
        let peer = Arc::new(Peer::new(Box::new(Sink::default())));
        let p = peer.clone();
        let t = std::thread::spawn(move || p.request("stop-model", json!({}), Duration::from_secs(10)));
        std::thread::sleep(Duration::from_millis(100));
        peer.read_loop("{\"rs\":1,\"type\":\"response\",\"id\":1,\"ok\":true,\"value\":true}\n".as_bytes(), |_| {}, |_| {});
        assert_eq!(t.join().unwrap().unwrap(), json!(true));
    }
}
