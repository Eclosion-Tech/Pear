//! Engine session manager: spawn, stream, steer, cancel — for both
//! interaction models.
//!
//! PersistentStdin (Claude Code): one long-lived process; follow-up turns are
//! written to its stdin. ProcessPerTurn (Codex): each turn is a fresh
//! `codex exec [resume <thread_id>]` process; the session stays alive between
//! turns and `send` spawns the next one, streaming to the same channel.
//!
//! One reader task per process fans each stdout line to (a) the frontend
//! `Channel` (normalized `parse_events` + the verbatim `Raw` line), and
//! (b) `sessions/{id}/raw.jsonl`. Processes spawn into their own process group
//! (unix) so cancel kills the engine *and* its MCP child.

pub mod store;

use crate::engines::adapter::{InteractionMode, ScribeSpec, SessionSpec};
use crate::engines::events::EngineEvent;
use crate::mcp_config;
use crate::paths::AppPaths;
use std::collections::HashMap;
use std::io::Write as _;
use std::sync::{Arc, Mutex};
use store::{DesktopState, SessionMeta};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// Everything needed to spawn another turn of a ProcessPerTurn session.
#[derive(Clone)]
struct TurnContext {
    engine: String,
    cwd: String,
    codex_home: Option<std::path::PathBuf>,
    permission_mode: String,
    model: Option<String>,
    channel: Channel<EngineEvent>,
}

enum Driver {
    Stdin(mpsc::UnboundedSender<String>),
    PerTurn(TurnContext),
}

pub struct RunningSession {
    driver: Driver,
    /// PID of the current process (updated per turn for ProcessPerTurn).
    pid: Arc<Mutex<Option<u32>>>,
    /// Stdin feed of the transcript scribe sidecar. Dropping it (session end,
    /// cancel) closes the scribe's stdin → final flush + exit.
    scribe_tx: Option<mpsc::UnboundedSender<String>>,
}

pub struct SessionManager {
    pub running: Mutex<HashMap<String, RunningSession>>,
    pub state: Mutex<DesktopState>,
    pub paths: AppPaths,
}

impl SessionManager {
    pub fn new(paths: AppPaths) -> Self {
        let state = store::load(&paths.state_file());
        Self {
            running: Mutex::new(HashMap::new()),
            state: Mutex::new(state),
            paths,
        }
    }

    pub fn persist(&self) {
        let state = self.state.lock().unwrap();
        if let Err(err) = store::save(&self.paths.state_file(), &state) {
            eprintln!("[sessions] state save failed: {err}");
        }
    }

    pub fn update_session<F: FnOnce(&mut SessionMeta)>(&self, id: &str, f: F) {
        {
            let mut state = self.state.lock().unwrap();
            if let Some(meta) = state.sessions.iter_mut().find(|s| s.id == id) {
                f(meta);
            }
        }
        self.persist();
    }

    fn engine_session_id(&self, id: &str) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .sessions
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| s.engine_session_id.clone())
    }

    /// Start a session's first turn (or re-establish + resume an existing one).
    /// Records `meta` and wires the appropriate driver.
    pub fn start(
        self: &Arc<Self>,
        spec: SessionSpec,
        engine: String,
        meta: SessionMeta,
        channel: Channel<EngineEvent>,
    ) -> Result<(), String> {
        let adapter = crate::engines::adapter_for(&engine).ok_or("unknown engine")?;
        let session_id = spec.session_id.clone();

        // Record/refresh meta.
        let title = meta.title.clone();
        {
            let mut state = self.state.lock().unwrap();
            if let Some(existing) = state.sessions.iter_mut().find(|s| s.id == session_id) {
                existing.status = "running".to_string();
            } else {
                state.sessions.push(meta);
            }
        }
        self.persist();

        let _ = channel.send(EngineEvent::Started {
            session_id: session_id.clone(),
        });

        // Transcript scribe sidecar: one per session, fed the init header, the
        // first user turn, and every normalized engine event.
        let scribe_tx = spec
            .scribe
            .as_ref()
            .and_then(|s| self.spawn_scribe(s, &spec, &engine, &title, channel.clone()));
        if let Some(tx) = &scribe_tx {
            let _ = tx.send(
                serde_json::json!({ "type": "user", "text": spec.prompt }).to_string(),
            );
        }

        let pid_cell = Arc::new(Mutex::new(None));

        match adapter.interaction() {
            InteractionMode::PersistentStdin => {
                let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<String>();
                // Seed the first turn onto stdin.
                let _ = stdin_tx.send(adapter.stdin_message(&spec.prompt));
                self.running.lock().unwrap().insert(
                    session_id.clone(),
                    RunningSession {
                        driver: Driver::Stdin(stdin_tx),
                        pid: pid_cell.clone(),
                        scribe_tx: scribe_tx.clone(),
                    },
                );
                self.run_process(&spec, &engine, channel, pid_cell, Some(stdin_rx), true, scribe_tx);
            }
            InteractionMode::ProcessPerTurn => {
                self.running.lock().unwrap().insert(
                    session_id.clone(),
                    RunningSession {
                        driver: Driver::PerTurn(TurnContext {
                            engine: engine.clone(),
                            cwd: spec.cwd.clone(),
                            codex_home: spec.codex_home.clone(),
                            permission_mode: spec.permission_mode.clone(),
                            model: spec.model.clone(),
                            channel: channel.clone(),
                        }),
                        pid: pid_cell.clone(),
                        scribe_tx: scribe_tx.clone(),
                    },
                );
                // Turn process exit is NOT terminal — the session idles.
                self.run_process(&spec, &engine, channel, pid_cell, None, false, scribe_tx);
            }
        }
        Ok(())
    }

    /// Spawn the transcript scribe (`worker/src/scribe/stdio.ts`) for a
    /// session and hand back its stdin feed. Best-effort: on failure the
    /// session runs untranscribed (raw.jsonl still has everything).
    fn spawn_scribe(
        self: &Arc<Self>,
        scribe: &ScribeSpec,
        spec: &SessionSpec,
        engine: &str,
        title: &str,
        channel: Channel<EngineEvent>,
    ) -> Option<mpsc::UnboundedSender<String>> {
        let repo = crate::paths::pear_repo_dir();
        let tsx_loader = repo.join("worker/node_modules/tsx/dist/esm/index.mjs");
        let host = repo.join("worker/src/scribe/stdio.ts");

        let mut cmd = tokio::process::Command::new("node");
        cmd.arg("--import")
            .arg(&tsx_loader)
            .arg(&host)
            .env("SPACETIMEDB_URI", &scribe.spacetimedb_uri)
            .env("SPACETIMEDB_DB_NAME", &scribe.db_name)
            // Token env-only, matching the MCP config hygiene.
            .env("PEAR_MCP_TOKEN", &scribe.token)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[scribe {}] spawn failed: {e}", spec.session_id);
                return None;
            }
        };

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();

        // stdin pump — closes the pipe (EOF → final flush) when tx drops.
        let mut stdin = child.stdin.take();
        tauri::async_runtime::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let Some(pipe) = stdin.as_mut() {
                    if pipe.write_all(format!("{msg}\n").as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = pipe.flush().await;
                }
            }
        });

        // stdout: exactly one {"transcript_page_id": N} line.
        if let Some(stdout) = child.stdout.take() {
            let mgr = Arc::clone(self);
            let sid = spec.session_id.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                        continue;
                    };
                    if let Some(page_id) =
                        value.get("transcript_page_id").and_then(|v| v.as_u64())
                    {
                        mgr.update_session(&sid, move |m| {
                            m.transcript_page_id = Some(page_id);
                        });
                        let _ = channel.send(EngineEvent::TranscriptPage { page_id });
                    }
                }
            });
        }

        // stderr → app log only (transcription noise shouldn't hit the UI).
        if let Some(stderr) = child.stderr.take() {
            let sid = spec.session_id.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        eprintln!("[scribe {sid}] {line}");
                    }
                }
            });
        }

        // Reap the scribe when it exits so it never zombies.
        tauri::async_runtime::spawn(async move {
            let _ = child.wait().await;
        });

        let mut init = serde_json::json!({
            "type": "init",
            "engine": engine,
            "sessionId": spec.session_id,
            "title": title,
            "cwd": spec.cwd,
        });
        // Resume: continue the existing transcript page.
        if let Some(page_id) = self
            .state
            .lock()
            .unwrap()
            .sessions
            .iter()
            .find(|s| s.id == spec.session_id)
            .and_then(|s| s.transcript_page_id)
        {
            init["transcriptPageId"] = serde_json::json!(page_id);
        }
        let _ = tx.send(init.to_string());
        Some(tx)
    }

    /// Spawn one engine process and wire stdout/stderr/exit. `stdin_rx`
    /// present ⇒ persistent-stdin driver (pump follow-ups). `terminal_on_exit`
    /// controls whether process exit ends the session.
    #[allow(clippy::too_many_arguments)]
    fn run_process(
        self: &Arc<Self>,
        spec: &SessionSpec,
        engine: &str,
        channel: Channel<EngineEvent>,
        pid_cell: Arc<Mutex<Option<u32>>>,
        stdin_rx: Option<mpsc::UnboundedReceiver<String>>,
        terminal_on_exit: bool,
        scribe_tx: Option<mpsc::UnboundedSender<String>>,
    ) {
        let adapter = match crate::engines::adapter_for(engine) {
            Some(a) => a,
            None => {
                let _ = channel.send(EngineEvent::Error {
                    message: format!("unknown engine {engine}"),
                });
                return;
            }
        };
        let session_id = spec.session_id.clone();
        let session_dir = self.paths.session_dir(&session_id);
        if let Err(e) = std::fs::create_dir_all(&session_dir) {
            let _ = channel.send(EngineEvent::Error {
                message: e.to_string(),
            });
            return;
        }

        let mut cmd = adapter.build_command(spec);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if stdin_rx.is_some() {
            cmd.stdin(std::process::Stdio::piped());
        } else {
            cmd.stdin(std::process::Stdio::null());
        }
        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = channel.send(EngineEvent::Error {
                    message: format!("spawn {engine}: {e}"),
                });
                if terminal_on_exit {
                    self.update_session(&session_id, |m| m.status = "crashed".to_string());
                    let _ = channel.send(EngineEvent::Exited { code: None });
                }
                return;
            }
        };
        *pid_cell.lock().unwrap() = child.id();

        // stdin pump (persistent driver only).
        if let Some(mut rx) = stdin_rx {
            let mut stdin = child.stdin.take();
            tauri::async_runtime::spawn(async move {
                while let Some(msg) = rx.recv().await {
                    if let Some(pipe) = stdin.as_mut() {
                        if pipe.write_all(msg.as_bytes()).await.is_err() {
                            break;
                        }
                        let _ = pipe.flush().await;
                    }
                }
            });
        }

        // stdout reader.
        if let Some(stdout) = child.stdout.take() {
            let raw_path = session_dir.join("raw.jsonl");
            let ch = channel.clone();
            let sid = session_id.clone();
            let mgr = Arc::clone(self);
            let engine_id = engine.to_string();
            let scribe = scribe_tx.clone();
            tauri::async_runtime::spawn(async move {
                let adapter = crate::engines::adapter_for(&engine_id).expect("adapter");
                let mut lines = BufReader::new(stdout).lines();
                let mut raw = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&raw_path)
                    .ok();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(f) = raw.as_mut() {
                        let _ = writeln!(f, "{line}");
                    }
                    match serde_json::from_str::<serde_json::Value>(&line) {
                        Ok(value) => {
                            if mgr.engine_session_id(&sid).is_none() {
                                if let Some(esid) = adapter.extract_engine_session_id(&value) {
                                    mgr.update_session(&sid, move |m| {
                                        m.engine_session_id = Some(esid);
                                    });
                                }
                            }
                            for ev in adapter.parse_events(&value) {
                                if let Some(stx) = &scribe {
                                    let _ = stx.send(
                                        serde_json::json!({ "type": "event", "event": &ev })
                                            .to_string(),
                                    );
                                }
                                let _ = ch.send(ev);
                            }
                            let _ = ch.send(EngineEvent::Raw { line: value });
                        }
                        Err(_) if !line.trim().is_empty() => {
                            let _ = ch.send(EngineEvent::Stderr { line });
                        }
                        Err(_) => {}
                    }
                }
            });
        }

        // stderr reader.
        if let Some(stderr) = child.stderr.take() {
            let ch = channel.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        let _ = ch.send(EngineEvent::Stderr { line });
                    }
                }
            });
        }

        // Exit watcher.
        {
            let ch = channel;
            let sid = session_id;
            let mgr = Arc::clone(self);
            let scribe = scribe_tx;
            tauri::async_runtime::spawn(async move {
                let code = child.wait().await.ok().and_then(|s| s.code());
                *pid_cell.lock().unwrap() = None;
                if terminal_on_exit {
                    if let Some(stx) = &scribe {
                        let _ = stx.send(
                            serde_json::json!({
                                "type": "event",
                                "event": EngineEvent::Exited { code }
                            })
                            .to_string(),
                        );
                    }
                    mcp_config::cleanup(&mgr.paths.session_dir(&sid));
                    // Dropping the RunningSession drops scribe_tx → the scribe
                    // sees EOF and checkpoints the transcript.
                    mgr.running.lock().unwrap().remove(&sid);
                    mgr.update_session(&sid, move |m| {
                        if m.status == "running" {
                            m.status = match code {
                                Some(0) => "exited".to_string(),
                                _ => "crashed".to_string(),
                            };
                        }
                    });
                    let _ = ch.send(EngineEvent::Exited { code });
                } else {
                    // ProcessPerTurn: a turn ended, the session idles awaiting
                    // the next `send`. Keep the running entry + channel.
                    mgr.update_session(&sid, |m| {
                        if m.status == "running" {
                            m.status = "idle".to_string();
                        }
                    });
                }
            });
        }
    }

    /// Add a follow-up turn to a running session.
    pub fn send(self: &Arc<Self>, session_id: &str, text: &str) -> Result<(), String> {
        // Snapshot the driver info under the lock, then act.
        enum Action {
            Stdin(mpsc::UnboundedSender<String>, String),
            Turn(TurnContext, Arc<Mutex<Option<u32>>>),
        }
        let (action, scribe_tx) = {
            let running = self.running.lock().unwrap();
            let session = running.get(session_id).ok_or("session not running")?;
            let action = match &session.driver {
                Driver::Stdin(tx) => {
                    let adapter_id = self
                        .state
                        .lock()
                        .unwrap()
                        .sessions
                        .iter()
                        .find(|s| s.id == session_id)
                        .map(|s| s.engine.clone())
                        .ok_or("session meta missing")?;
                    let adapter =
                        crate::engines::adapter_for(&adapter_id).ok_or("unknown engine")?;
                    Action::Stdin(tx.clone(), adapter.stdin_message(text))
                }
                Driver::PerTurn(ctx) => Action::Turn(ctx.clone(), session.pid.clone()),
            };
            (action, session.scribe_tx.clone())
        };

        if let Some(stx) = &scribe_tx {
            let _ = stx.send(serde_json::json!({ "type": "user", "text": text }).to_string());
        }

        match action {
            Action::Stdin(tx, msg) => tx
                .send(msg)
                .map_err(|_| "engine stdin closed".to_string()),
            Action::Turn(ctx, pid_cell) => {
                let thread_id = self
                    .engine_session_id(session_id)
                    .ok_or("no engine session id yet — wait for the first turn to finish")?;
                self.update_session(session_id, |m| m.status = "running".to_string());
                let spec = SessionSpec {
                    session_id: session_id.to_string(),
                    cwd: ctx.cwd.clone(),
                    mcp_config_path: Default::default(),
                    codex_home: ctx.codex_home.clone(),
                    prompt: text.to_string(),
                    permission_mode: ctx.permission_mode.clone(),
                    model: ctx.model.clone(),
                    resume_engine_session_id: Some(thread_id),
                    scribe: None, // the session's scribe is already running
                };
                self.run_process(&spec, &ctx.engine, ctx.channel, pid_cell, None, false, scribe_tx);
                Ok(())
            }
        }
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), String> {
        let pid = {
            let running = self.running.lock().unwrap();
            running
                .get(session_id)
                .and_then(|s| *s.pid.lock().unwrap())
        };
        // A ProcessPerTurn session can be idle (no live process) but still
        // "running" as a session — cancelling just closes it out.
        self.update_session(session_id, |m| m.status = "cancelled".to_string());
        self.running.lock().unwrap().remove(session_id);
        mcp_config::cleanup(&self.paths.session_dir(session_id));

        let Some(pid) = pid else {
            return Ok(());
        };
        #[cfg(unix)]
        {
            let pgid = pid as i32;
            unsafe {
                libc::kill(-pgid, libc::SIGTERM);
            }
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                unsafe {
                    libc::kill(-pgid, libc::SIGKILL);
                }
            });
            Ok(())
        }
        #[cfg(not(unix))]
        {
            Err("cancel not implemented on this platform yet".to_string())
        }
    }
}
