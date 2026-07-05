//! App-data layout for the desktop shell.
//!
//! ~/Library/Application Support/tech.eclosion.pear/ (macOS; platform
//! equivalents elsewhere):
//!   desktop-state.json          engine bindings + session metadata
//!   sessions/{id}/raw.jsonl     verbatim engine stream (replay source)
//!   sessions/{id}/mcp.json      per-session MCP config (0600, token inside;
//!                               deleted when the session ends)

use std::path::PathBuf;
use tauri::Manager;

pub struct AppPaths {
    pub data_dir: PathBuf,
}

impl AppPaths {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("no app data dir: {e}"))?;
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        Ok(Self { data_dir })
    }

    pub fn state_file(&self) -> PathBuf {
        self.data_dir.join("desktop-state.json")
    }

    pub fn session_dir(&self, session_id: &str) -> PathBuf {
        self.data_dir.join("sessions").join(session_id)
    }
}

/// The pear repo checkout hosting the Node MCP stdio server. Dev builds
/// resolve it from the crate location; packaged builds will ship bundled
/// hosts instead (M3) — until then an env override is available.
pub fn pear_repo_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PEAR_REPO_DIR") {
        return PathBuf::from(dir);
    }
    // desktop/src-tauri → pear repo root.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}
