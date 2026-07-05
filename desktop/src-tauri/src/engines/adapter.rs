//! Engine adapter abstraction — one implementation per agent CLI.

use std::path::PathBuf;

use super::events::EngineEvent;

pub struct SessionSpec {
    pub session_id: String,
    pub cwd: String,
    /// Claude Code: path to the per-session `mcp.json`. Unused by Codex, which
    /// injects MCP via `codex_home`'s config.toml instead.
    pub mcp_config_path: PathBuf,
    /// Codex: ephemeral `CODEX_HOME` dir holding a 0600 config.toml with the
    /// pear MCP server. `None` for Claude.
    pub codex_home: Option<PathBuf>,
    /// The prompt for the CURRENT turn. Claude writes it to stdin (persistent
    /// process); Codex passes it on argv (process-per-turn).
    pub prompt: String,
    /// Claude Code permission mode ("acceptEdits", "plan", …) or Codex sandbox
    /// mode ("workspace-write", …).
    pub permission_mode: String,
    /// Optional model override for the engine (`--model` / `-m`). `None` uses
    /// the engine's own default.
    pub model: Option<String>,
    /// Engine-native session id to resume, when reattaching / continuing.
    pub resume_engine_session_id: Option<String>,
    /// Workspace connection for the transcript scribe sidecar. `None`
    /// disables transcription (per-turn resume spawns reuse the session's
    /// already-running scribe).
    pub scribe: Option<ScribeSpec>,
}

/// Connection the scribe needs to write pages as the engine's AI user. The
/// token lives here only for the spawn (env-only, like the MCP config).
#[derive(Clone)]
pub struct ScribeSpec {
    pub spacetimedb_uri: String,
    pub db_name: String,
    pub token: String,
}

#[derive(PartialEq, Eq, Clone, Copy)]
pub enum InteractionMode {
    /// One long-lived process; follow-up turns are written to stdin.
    PersistentStdin,
    /// One process per turn; follow-ups spawn `resume`-style invocations.
    ProcessPerTurn,
}

pub trait EngineAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn interaction(&self) -> InteractionMode;
    fn build_command(&self, spec: &SessionSpec) -> tokio::process::Command;
    /// Serialize a user turn for the engine's stdin (PersistentStdin mode).
    fn stdin_message(&self, text: &str) -> String;
    /// Pull the engine-native session id out of a stream line, when present.
    fn extract_engine_session_id(&self, line: &serde_json::Value) -> Option<String>;
    /// Convert one engine-native stream line into normalized UI/scribe events.
    fn parse_events(&self, line: &serde_json::Value) -> Vec<EngineEvent>;
}
