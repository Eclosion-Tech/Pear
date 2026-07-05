//! JSON persistence for engine bindings + session metadata
//! (`desktop-state.json`, atomic-rename writes). Deliberately not SQLite —
//! v1 has no queries a serde round-trip can't do.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineBinding {
    pub engine: String,
    /// Workspace key — the SpacetimeDB URI + db name pair the binding is for.
    pub workspace_key: String,
    pub ai_user_hex: String,
    pub ai_user_id: u64,
    pub display_name: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub engine: String,
    pub cwd: String,
    pub workspace_key: String,
    pub title: String,
    pub status: String, // "running" | "exited" | "crashed" | "cancelled"
    pub engine_session_id: Option<String>,
    pub created_at_ms: u64,
    /// Per-session model override; sticks across resumes.
    #[serde(default)]
    pub model: Option<String>,
    /// Pear page holding this session's transcript (set by the scribe).
    #[serde(default)]
    pub transcript_page_id: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    #[serde(default)]
    pub engines: Vec<EngineBinding>,
    #[serde(default)]
    pub sessions: Vec<SessionMeta>,
}

pub fn load(path: &Path) -> DesktopState {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, state: &DesktopState) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(state).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn upsert_session(state: &mut DesktopState, meta: SessionMeta) {
    if let Some(existing) = state.sessions.iter_mut().find(|s| s.id == meta.id) {
        *existing = meta;
    } else {
        state.sessions.push(meta);
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, status: &str, title: &str) -> SessionMeta {
        SessionMeta {
            id: id.to_string(),
            engine: "claude-code".to_string(),
            cwd: "/tmp".to_string(),
            workspace_key: "ws://localhost:3000::pear-dev".to_string(),
            title: title.to_string(),
            status: status.to_string(),
            engine_session_id: Some("engine-session".to_string()),
            created_at_ms: 1,
            model: None,
            transcript_page_id: None,
        }
    }

    fn temp_state_file() -> std::path::PathBuf {
        std::env::temp_dir()
            .join("pear-desktop-tests")
            .join(format!("{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn upsert_session_replaces_existing_row() {
        let mut state = DesktopState::default();
        upsert_session(&mut state, meta("s1", "running", "first"));
        upsert_session(&mut state, meta("s1", "exited", "updated"));

        assert_eq!(state.sessions.len(), 1);
        assert_eq!(state.sessions[0].status, "exited");
        assert_eq!(state.sessions[0].title, "updated");
    }

    #[test]
    fn save_and_load_round_trip_state() {
        let path = temp_state_file();
        std::fs::create_dir_all(path.parent().unwrap()).expect("create parent");
        let mut state = DesktopState::default();
        state.engines.push(EngineBinding {
            engine: "claude-code".to_string(),
            workspace_key: "ws://localhost:3000::pear-dev".to_string(),
            ai_user_hex: "abc".to_string(),
            ai_user_id: 42,
            display_name: "Claude".to_string(),
        });
        state.sessions.push(meta("s1", "running", "first"));

        save(&path, &state).expect("save state");
        let loaded = load(&path);

        assert_eq!(loaded.engines.len(), 1);
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].id, "s1");

        let _ = std::fs::remove_file(&path);
    }
}
