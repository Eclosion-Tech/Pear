//! Normalized session events streamed to the frontend over a
//! `tauri::ipc::Channel`. `Raw` carries the engine's verbatim stream-json
//! line so the UI can render engine-specific detail; the other variants are
//! lifecycle events the session manager synthesizes.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EngineEvent {
    Started {
        session_id: String,
    },
    /// The scribe created (or re-opened) this session's transcript page.
    TranscriptPage {
        page_id: u64,
    },
    AssistantMessage {
        text: String,
    },
    ToolUse {
        id: Option<String>,
        name: String,
        input: Option<serde_json::Value>,
    },
    ToolResult {
        tool_use_id: Option<String>,
        content: Option<serde_json::Value>,
    },
    TurnCompleted {
        success: bool,
        cost_usd: Option<f64>,
        usage: Option<serde_json::Value>,
    },
    /// One parsed line of the engine's JSONL stream, verbatim.
    Raw {
        line: serde_json::Value,
    },
    Stderr {
        line: String,
    },
    Exited {
        code: Option<i32>,
    },
    #[allow(dead_code)]
    Error {
        message: String,
    },
}
