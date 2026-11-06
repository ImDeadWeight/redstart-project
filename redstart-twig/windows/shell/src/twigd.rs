//! Hosting twigd: `node twigd.mjs --shell-pipe --config <dir>`.
//!
//! The shell owns twigd's lifetime. It is spawned into a Job Object (Windows),
//! so if the shell dies, twigd and every MCP server it started die with it. A
//! deliberate stop sends `shutdown` and waits: twigd stops its MCP children,
//! reports their pids (`stopping`) and exits 0.
//!
//! What twigd asks of the shell (`trash`) is answered here, on its own thread,
//! so a slow recycle-bin move never holds up the pipe.

use std::io::Read;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::job::Job;
use crate::log;
use crate::paths::Layout;
use crate::pipe::{Incoming, Peer};

const STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// From spawn to `ready`. twigd loads nothing heavy; this is about a second.
pub const READY_TIMEOUT: Duration = Duration::from_secs(30);
const STDERR_TAIL: usize = 4096;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub expected: bool,
    pub before_ready: bool,
    pub stderr_tail: String,
}

pub enum TwigdEvent {
    Ready,
    /// A local MCP server wrote a line, or exited: for the page.
    Mcp { event: &'static str, payload: Value },
    Exit(ExitInfo),
}

pub struct Twigd {
    peer: Arc<Peer>,
    job: Job,
    pub pid: u32,
    stop_requested: AtomicBool,
    ready: AtomicBool,
    exited: Arc<(Mutex<Option<ExitInfo>>, Condvar)>,
    stopping_pids: Mutex<Vec<u32>>,
}

impl Twigd {
    pub fn start(layout: &Layout, on_event: impl Fn(TwigdEvent) + Send + Sync + 'static) -> Result<Arc<Twigd>, String> {
        let mut cmd = Command::new(&layout.node);
        cmd.arg("--no-experimental-webstorage")
            .arg(&layout.twigd)
            .arg("--shell-pipe")
            .arg("--config")
            .arg(&layout.config)
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let job = Job::new()?;
        let mut child = cmd.spawn().map_err(|e| format!("Could not start {}: {e}", layout.node.display()))?;
        // Before twigd can start an MCP server: everything it spawns is in the job.
        #[cfg(windows)]
        if let Err(e) = job.assign(child.as_raw_handle()) {
            log::event("app", "job_assign_failed", json!({ "reason": e }));
        }
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut stderr = child.stderr.take().ok_or("no stderr")?;

        let host = Arc::new(Twigd {
            peer: Arc::new(Peer::new(Box::new(stdin))),
            job,
            pid,
            stop_requested: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            exited: Arc::new((Mutex::new(None), Condvar::new())),
            stopping_pids: Mutex::new(Vec::new()),
        });
        let on_event = Arc::new(on_event);

        // stderr: twigd's console. Kept as a tail for a startup failure, and in
        // a debug run echoed here.
        let tail = Arc::new(Mutex::new(String::new()));
        let (stderr_done_tx, stderr_done) = mpsc::channel::<()>();
        {
            let tail = tail.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let text = String::from_utf8_lossy(&buf[..n]);
                    if cfg!(debug_assertions) {
                        eprint!("{text}");
                    }
                    let mut t = tail.lock().unwrap();
                    t.push_str(&text);
                    if t.len() > STDERR_TAIL {
                        let cut = t.len() - STDERR_TAIL;
                        let cut = (cut..t.len()).find(|i| t.is_char_boundary(*i)).unwrap_or(t.len());
                        t.drain(..cut);
                    }
                }
                let _ = stderr_done_tx.send(());
            });
        }

        {
            let host = host.clone();
            let on_event = on_event.clone();
            std::thread::spawn(move || {
                let peer = host.peer.clone();
                peer.read_loop(
                    stdout,
                    |incoming| host.dispatch(incoming, on_event.as_ref()),
                    |line| {
                        let short: String = line.chars().take(200).collect();
                        log::event("app", "shell_pipe_noise", json!({ "line": short }));
                    },
                );
            });
        }

        {
            let host = host.clone();
            let on_event = on_event.clone();
            std::thread::spawn(move || {
                let status = child.wait();
                let _ = stderr_done.recv_timeout(Duration::from_secs(1));
                let info = ExitInfo {
                    code: status.ok().and_then(|s| s.code()),
                    expected: host.stop_requested.load(Ordering::SeqCst),
                    before_ready: !host.ready.load(Ordering::SeqCst),
                    stderr_tail: tail.lock().unwrap().trim().to_string(),
                };
                let (lock, cv) = &*host.exited;
                *lock.lock().unwrap() = Some(info.clone());
                cv.notify_all();
                on_event(TwigdEvent::Exit(info));
            });
        }
        Ok(host)
    }

    fn dispatch(self: &Arc<Self>, incoming: Incoming, on_event: &(dyn Fn(TwigdEvent) + Send + Sync)) {
        match incoming {
            Incoming::Message(msg) => match msg["type"].as_str().unwrap_or("") {
                "ready" => {
                    self.ready.store(true, Ordering::SeqCst);
                    on_event(TwigdEvent::Ready);
                }
                "mcp-message" => on_event(TwigdEvent::Mcp { event: "message", payload: msg }),
                "mcp-exit" => on_event(TwigdEvent::Mcp { event: "exit", payload: msg }),
                "stopping" => {
                    let pids = msg["pids"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|p| p.as_u64().map(|p| p as u32)).collect())
                        .unwrap_or_default();
                    *self.stopping_pids.lock().unwrap() = pids;
                }
                "crash" => log::event("app", "twigd_crash", json!({ "message": msg["message"] })),
                other => log::event("app", "shell_pipe_unknown_message", json!({ "type": other })),
            },
            Incoming::Request { id, method, params } => {
                let host = self.clone();
                std::thread::spawn(move || {
                    let result = handle_request(&method, &params);
                    host.peer.respond(id, result);
                });
            }
        }
    }

    /// One request to twigd. Blocks: call it off the main thread.
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.peer.request(method, params, timeout)
    }

    pub fn has_exited(&self) -> bool {
        self.exited.0.lock().unwrap().is_some()
    }

    /// Ask twigd to stop and wait for it, then end the job, which takes any MCP
    /// grandchild a server left behind (an `npx` tree, say). Returns the pids
    /// that had to go: twigd's reported children, then twigd.
    pub fn stop(&self) -> Vec<u32> {
        let (lock, cv) = &*self.exited;
        if lock.lock().unwrap().is_none() {
            self.stop_requested.store(true, Ordering::SeqCst);
            self.peer.send(json!({ "type": "shutdown" }));
            let guard = lock.lock().unwrap();
            let (guard, waited) = cv.wait_timeout_while(guard, STOP_TIMEOUT, |e| e.is_none()).unwrap();
            drop(guard);
            if waited.timed_out() {
                log::event("app", "twigd_stop_timeout", json!({ "pid": self.pid }));
            }
        }
        self.job.terminate();
        let mut pids = self.stopping_pids.lock().unwrap().clone();
        pids.push(self.pid);
        pids
    }

    /// Ends the whole tree now. Used when startup has already failed.
    pub fn kill(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
        self.job.terminate();
    }
}

fn handle_request(method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "trash" => {
            let path = params["path"].as_str().ok_or("trash: no path")?;
            trash::delete(path).map_err(|e| format!("Could not move to the Recycle Bin: {e}"))?;
            Ok(json!(true))
        }
        other => Err(format!("Unknown method: {other}")),
    }
}
