//! Hosting nestd: the Rust counterpart of `electron/main/daemon-host.mjs`.
//!
//! Spawns `node nestd.mjs --shell-pipe --config … --capability-base …
//! [--resources …]`, puts it in the Job Object, says hello with the
//! unwrapped key, and turns what the daemon says into `DaemonEvent`s for the
//! app. Requests the daemon makes (trash, login-item-set, update-check) are
//! answered here, each on its own thread so a slow recycle-bin move never
//! holds up the pipe.
//!
//! LIFETIME (plan D2): `stop()` asks for a shutdown and waits, ending the
//! job after the timeout. If the shell dies, the job ends the tree.

use std::io::Read;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};

use crate::job::Job;
use crate::log;
use crate::login_item;
use crate::paths::Layout;
use crate::pipe::{Incoming, Peer};

/// A graceful stop (the daemon stops llama-server, then exits) gets this long.
const STOP_TIMEOUT: Duration = Duration::from_secs(20);
/// From spawn to `ready`. Normally about a second.
pub const READY_TIMEOUT: Duration = Duration::from_secs(60);
const STDERR_TAIL: usize = 4096;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug)]
pub struct Ready {
    pub admin_port: u16,
    pub model_running: bool,
    pub setup_token: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ExitInfo {
    pub code: Option<i32>,
    /// The shell asked for it (stop()).
    pub expected: bool,
    pub before_ready: bool,
    pub stderr_tail: String,
}

pub enum DaemonEvent {
    Ready(Ready),
    /// A broker channel the tray reflects (server:started / server:stopped).
    Event(String),
    Notify { title: String, body: String },
    /// admin Shut down: the shell runs its deliberate quit.
    QuitRequested,
    /// admin Restart to update: a deliberate quit that installs and relaunches.
    InstallUpdate,
    Exit(ExitInfo),
}

pub struct DaemonHost {
    peer: Arc<Peer>,
    job: Job,
    pub pid: u32,
    stop_requested: AtomicBool,
    ready: AtomicBool,
    exited: Arc<(Mutex<Option<ExitInfo>>, Condvar)>,
    stopping_pids: Mutex<Vec<u32>>,
}

pub struct Hello {
    pub key: Vec<u8>,
    /// None where the shell does not own the login item (a dev build).
    pub login_item: Option<bool>,
    /// { active, status } when this shell updates itself, else null.
    pub updater: Value,
}

impl DaemonHost {
    pub fn start(
        layout: &Layout,
        hello: Hello,
        on_event: impl Fn(DaemonEvent) + Send + Sync + 'static,
    ) -> Result<Arc<DaemonHost>, String> {
        let mut cmd = Command::new(&layout.node);
        // Node 26 defines a localStorage global that warns when touched
        // without a backing file. Something in the dependency tree probes it.
        // Off, it is simply absent, as it was on Node 20.
        cmd.arg("--no-experimental-webstorage")
            .arg(&layout.nestd)
            .arg("--shell-pipe")
            .arg("--config")
            .arg(&layout.config)
            .arg("--capability-base")
            .arg(&layout.capability_base);
        if let Some(r) = &layout.resources {
            cmd.arg("--resources").arg(r);
        }
        // Inherited from a VS Code terminal, it would turn any Electron the
        // daemon starts into plain Node.
        cmd.env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let job = Job::new()?;
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", layout.node.display()))?;
        // Before nestd has had time to start anything of its own: everything
        // it spawns from here on is in the job too.
        #[cfg(windows)]
        if let Err(e) = job.assign(child.as_raw_handle()) {
            log::event("app", "job_assign_failed", json!({ "reason": e }));
        }
        let pid = child.id();

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut stderr = child.stderr.take().ok_or("no stderr")?;

        let host = Arc::new(DaemonHost {
            peer: Arc::new(Peer::new(Box::new(stdin))),
            job,
            pid,
            stop_requested: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            exited: Arc::new((Mutex::new(None), Condvar::new())),
            stopping_pids: Mutex::new(Vec::new()),
        });
        let on_event = Arc::new(on_event);

        // stderr: kept as a tail for the startup-failure message. The daemon
        // logs properly to its own redstart.log; this is what it said before
        // or instead of that.
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

        // The pipe.
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

        // Exit.
        {
            let host = host.clone();
            let on_event = on_event.clone();
            std::thread::spawn(move || {
                let status = child.wait();
                // Let the last of stderr arrive, but never hang on a
                // grandchild that inherited it.
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
                on_event(DaemonEvent::Exit(info));
            });
        }

        host.peer.send(json!({
            "type": "hello",
            "key": B64.encode(&hello.key),
            "loginItem": hello.login_item.map(|enabled| json!({ "enabled": enabled })),
            "updater": hello.updater,
        }));
        Ok(host)
    }

    fn dispatch(self: &Arc<Self>, incoming: Incoming, on_event: &(dyn Fn(DaemonEvent) + Send + Sync)) {
        match incoming {
            Incoming::Message(msg) => match msg["type"].as_str().unwrap_or("") {
                "ready" => {
                    self.ready.store(true, Ordering::SeqCst);
                    on_event(DaemonEvent::Ready(Ready {
                        admin_port: msg["adminPort"].as_u64().unwrap_or(19083) as u16,
                        model_running: msg["modelRunning"].as_bool().unwrap_or(false),
                        setup_token: msg["setupToken"].as_str().map(str::to_string),
                    }));
                }
                "event" => {
                    if let Some(c) = msg["channel"].as_str() {
                        on_event(DaemonEvent::Event(c.to_string()));
                    }
                }
                "notify" => on_event(DaemonEvent::Notify {
                    title: msg["title"].as_str().unwrap_or("Redstart").to_string(),
                    body: msg["body"].as_str().unwrap_or("").to_string(),
                }),
                "quit-requested" => on_event(DaemonEvent::QuitRequested),
                "stopping" => {
                    let pids = msg["pids"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|p| p.as_u64().map(|p| p as u32)).collect())
                        .unwrap_or_default();
                    *self.stopping_pids.lock().unwrap() = pids;
                }
                "install-update" => on_event(DaemonEvent::InstallUpdate),
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

    pub fn stop_model(&self) -> Result<Value, String> {
        self.peer.request("stop-model", json!({}), Duration::from_secs(30))
    }

    pub fn has_exited(&self) -> bool {
        self.exited.0.lock().unwrap().is_some()
    }

    /// Ask the daemon to stop and wait for it. After STOP_TIMEOUT the job is
    /// ended. Returns the pids that had to go: the daemon's reported
    /// children, then the daemon.
    pub fn stop(&self) -> Vec<u32> {
        self.stop_with(STOP_TIMEOUT)
    }

    pub fn stop_with(&self, timeout: Duration) -> Vec<u32> {
        let (lock, cv) = &*self.exited;
        if lock.lock().unwrap().is_some() {
            return Vec::new();
        }
        self.stop_requested.store(true, Ordering::SeqCst);
        self.peer.send(json!({ "type": "shutdown" }));
        let guard = lock.lock().unwrap();
        let (guard, timed_out) = cv.wait_timeout_while(guard, timeout, |e| e.is_none()).unwrap();
        drop(guard);
        if timed_out.timed_out() {
            log::event("app", "daemon_stop_timeout", json!({ "pid": self.pid }));
            self.job.terminate();
            let guard = lock.lock().unwrap();
            let _ = cv.wait_timeout_while(guard, Duration::from_secs(5), |e| e.is_none());
        }
        let mut pids = self.stopping_pids.lock().unwrap().clone();
        pids.push(self.pid);
        pids
    }

    /// Ends the whole tree now. Used when startup has already failed.
    pub fn kill(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
        self.job.terminate();
    }

    /// Which release is the update (update-feed.mjs, in the daemon).
    pub fn find_update(&self, current_version: &str, manifest: &str) -> Result<Option<Value>, String> {
        let v = self.peer.request(
            "update-find",
            json!({ "currentVersion": current_version, "manifest": manifest }),
            Duration::from_secs(30),
        )?;
        Ok(if v.is_null() { None } else { Some(v) })
    }

    pub fn push_update_status(&self, status: &Value) {
        self.peer.send(json!({ "type": "update-status", "status": status }));
    }

    #[allow(dead_code)] // the login item only changes through the daemon today
    pub fn push_login_item(&self, enabled: bool) {
        self.peer.send(json!({ "type": "login-item", "enabled": enabled }));
    }
}

fn handle_request(method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "trash" => {
            let path = params["path"].as_str().ok_or("trash: no path")?;
            trash::delete(path).map_err(|e| format!("Could not move to the Recycle Bin: {e}"))?;
            Ok(json!(true))
        }
        "login-item-set" => {
            let enabled = params["openAtLogin"].as_bool().unwrap_or(false);
            let args: Vec<String> = params["args"]
                .as_array()
                .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            login_item::set(enabled, &args)?;
            log::event("app", "login_item_set", json!({ "enabled": enabled }));
            Ok(json!(true))
        }
        "update-check" => {
            let app = crate::app_handle().ok_or("No updater in this shell")?;
            if !crate::update::is_active(app) {
                return Err("No updater in this shell".into());
            }
            crate::update::check_now(app, params["manual"].as_bool().unwrap_or(true));
            Ok(json!(true))
        }
        other => Err(format!("Unknown method: {other}")),
    }
}
