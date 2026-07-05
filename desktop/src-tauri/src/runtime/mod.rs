//! Local workspace runtime — standalone pear.
//!
//! Provisions and supervises, under app data:
//!   local-workspace/stdb/     SpacetimeDB data dir (persists across runs)
//!   local-workspace/logs/     stdb.log + web.log
//!
//! Processes: `spacetime start` (binary located on PATH — NOT bundled, see the
//! plan's licensing note) and the Next standalone web server run with system
//! Node. The module is published on every start (idempotent update; dev builds
//! publish from the repo checkout). Attachments (S3) are not available in
//! local mode v1 — the launcher says so.

pub mod ports;
pub mod spacetime;
pub mod webserver;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

pub const LOCAL_DB_NAME: &str = "pear-local";

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalWorkspaceInfo {
    /// "stopped" | "starting" | "running" | "error"
    pub status: String,
    /// Human-readable progress / error detail.
    pub message: String,
    pub stdb_port: Option<u16>,
    pub web_port: Option<u16>,
    /// URL the launcher should navigate to (workspace bootstrap params baked
    /// in) once status == "running".
    pub web_url: Option<String>,
    pub db_name: String,
}

struct Children {
    stdb_pid: Option<u32>,
    web_pid: Option<u32>,
}

pub struct LocalRuntime {
    info: Mutex<LocalWorkspaceInfo>,
    children: Mutex<Children>,
    root: PathBuf,
}

impl LocalRuntime {
    pub fn new(app_data_dir: &std::path::Path) -> Self {
        Self {
            info: Mutex::new(LocalWorkspaceInfo {
                status: "stopped".into(),
                db_name: LOCAL_DB_NAME.into(),
                ..Default::default()
            }),
            children: Mutex::new(Children {
                stdb_pid: None,
                web_pid: None,
            }),
            root: app_data_dir.join("local-workspace"),
        }
    }

    pub fn status(&self) -> LocalWorkspaceInfo {
        self.info.lock().unwrap().clone()
    }

    fn set(&self, status: &str, message: impl Into<String>) {
        let mut info = self.info.lock().unwrap();
        info.status = status.into();
        info.message = message.into();
    }

    /// Bring the whole local stack up. Synchronous & long-running — call from
    /// an async command via spawn_blocking. Idempotent: returns current info
    /// if already running.
    pub fn start(&self) -> Result<LocalWorkspaceInfo, String> {
        {
            let info = self.info.lock().unwrap();
            if info.status == "running" || info.status == "starting" {
                return Ok(info.clone());
            }
        }
        self.set("starting", "allocating ports");
        match self.start_inner() {
            Ok(info) => Ok(info),
            Err(e) => {
                self.stop();
                self.set("error", e.clone());
                Err(e)
            }
        }
    }

    fn start_inner(&self) -> Result<LocalWorkspaceInfo, String> {
        let logs = self.root.join("logs");
        std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;

        let stdb_port = ports::free_port(3300)?;
        let web_port = ports::free_port(3311)?;

        self.set("starting", "starting SpacetimeDB");
        let stdb = spacetime::start(&self.root.join("stdb"), &logs, stdb_port)?;
        self.children.lock().unwrap().stdb_pid = Some(stdb);

        self.set("starting", "waiting for SpacetimeDB");
        http_wait(stdb_port, "/v1/ping", 30)?;

        self.set("starting", "publishing pear module (first run can take a while)");
        spacetime::publish(stdb_port, LOCAL_DB_NAME, &logs)?;

        self.set("starting", "starting web server");
        let web = webserver::start(&logs, web_port, stdb_port)?;
        self.children.lock().unwrap().web_pid = Some(web);

        self.set("starting", "waiting for web server");
        http_wait(web_port, "/", 60)?;

        let web_url = format!(
            "http://127.0.0.1:{web_port}/?ws=ws%3A%2F%2F127.0.0.1%3A{stdb_port}&db={LOCAL_DB_NAME}&wsname=Local%20workspace",
        );
        let info = {
            let mut info = self.info.lock().unwrap();
            info.status = "running".into();
            info.message = "local workspace is up".into();
            info.stdb_port = Some(stdb_port);
            info.web_port = Some(web_port);
            info.web_url = Some(web_url);
            info.clone()
        };
        Ok(info)
    }

    /// Stop both processes (TERM to their process groups). Data persists.
    pub fn stop(&self) {
        let mut children = self.children.lock().unwrap();
        for pid in [children.stdb_pid.take(), children.web_pid.take()]
            .into_iter()
            .flatten()
        {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
        }
        let mut info = self.info.lock().unwrap();
        info.status = "stopped".into();
        info.message = "stopped".into();
        info.stdb_port = None;
        info.web_port = None;
        info.web_url = None;
    }
}

/// Minimal HTTP readiness probe (no HTTP client dependency): GET `path`,
/// success = any HTTP response line (the web root may 200/307/404 — a
/// response at all means the server is up).
fn http_ok(port: u16, path: &str) -> bool {
    use std::io::{Read, Write};
    let Ok(mut s) = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_secs(2),
    ) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(2)));
    if s.write_all(
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 32];
    matches!(s.read(&mut buf), Ok(n) if n > 0 && buf.starts_with(b"HTTP/"))
}

fn http_wait(port: u16, path: &str, timeout_secs: u64) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        if http_ok(port, path) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    Err(format!("service on 127.0.0.1:{port} not ready after {timeout_secs}s"))
}
