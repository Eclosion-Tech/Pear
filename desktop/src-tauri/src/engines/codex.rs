//! Codex CLI adapter — process-per-turn (`codex exec`, then
//! `codex exec resume <thread_id>`).
//!
//! Event shapes verified LIVE against codex 0.142.5 `--json`:
//!   {"type":"thread.started","thread_id":"<uuid>"}      ← resume id
//!   {"type":"turn.started"}
//!   {"type":"item.started","item":{"type":"mcp_tool_call","server":"pear",
//!     "tool":"remember","arguments":{…},"status":"in_progress"}}
//!   {"type":"item.completed","item":{"type":"mcp_tool_call",…,
//!     "result":{"content":[…]},"error":null,"status":"completed"}}
//!   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
//!   {"type":"turn.completed","usage":{…}}
//! Tool items map like Claude's: item.started → ToolUse, item.completed →
//! ToolResult. MCP is injected via an ephemeral `CODEX_HOME/config.toml`
//! (mcp_config.rs — which also pre-approves pear's tools and symlinks
//! auth.json), never `-c` argv overrides (a token there would be visible in
//! `ps`). The prompt is a positional argv (not stdin); stdin MUST be null or
//! codex blocks reading it.

use super::{
    adapter::{EngineAdapter, InteractionMode, SessionSpec},
    events::EngineEvent,
};

pub struct CodexAdapter;

impl CodexAdapter {
    pub fn build_args(spec: &SessionSpec, prompt: &str) -> Vec<String> {
        let mut args = if let Some(resume) = &spec.resume_engine_session_id {
            vec![
                "exec".to_string(),
                "resume".to_string(),
                resume.clone(),
                "--json".to_string(),
            ]
        } else {
            vec![
                "exec".to_string(),
                "--json".to_string(),
                "--skip-git-repo-check".to_string(),
                "-C".to_string(),
                spec.cwd.clone(),
                "-s".to_string(),
                sandbox_for(spec),
            ]
        };
        if let Some(model) = &spec.model {
            args.push("-m".to_string());
            args.push(model.clone());
        }
        args.push(prompt.to_string());
        args
    }
}

impl EngineAdapter for CodexAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn interaction(&self) -> InteractionMode {
        InteractionMode::ProcessPerTurn
    }

    fn build_command(&self, spec: &SessionSpec) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new("codex");
        cmd.args(Self::build_args(spec, &spec.prompt));
        cmd.current_dir(&spec.cwd);
        if let Some(home) = &spec.codex_home {
            cmd.env("CODEX_HOME", home);
        }
        cmd
    }

    fn stdin_message(&self, text: &str) -> String {
        // Process-per-turn: prompts go on argv, not stdin. This is only used by
        // the persistent-stdin driver, which Codex never takes.
        text.to_string()
    }

    fn extract_engine_session_id(&self, line: &serde_json::Value) -> Option<String> {
        if line.get("type").and_then(|v| v.as_str()) == Some("thread.started") {
            return line
                .get("thread_id")
                .and_then(|v| v.as_str())
                .map(String::from);
        }
        None
    }

    fn parse_events(&self, line: &serde_json::Value) -> Vec<EngineEvent> {
        match line.get("type").and_then(|v| v.as_str()) {
            Some("item.started") => item_started_events(line.get("item")),
            Some("item.completed") => item_completed_events(line.get("item")),
            Some("turn.completed") => vec![EngineEvent::TurnCompleted {
                success: line.get("error").is_none(),
                cost_usd: None,
                usage: line.get("usage").cloned(),
            }],
            _ => Vec::new(),
        }
    }
}

/// MCP + shell tool calls surface as their own item types; the exact names
/// vary across codex versions, so match structurally on a tool-ish type.
fn is_tool_item(item_type: &str) -> bool {
    item_type.contains("tool") || item_type.contains("command") || item_type.contains("mcp")
}

fn item_started_events(item: Option<&serde_json::Value>) -> Vec<EngineEvent> {
    let Some(item) = item else { return Vec::new() };
    match item.get("type").and_then(|v| v.as_str()) {
        Some(t) if is_tool_item(t) => vec![EngineEvent::ToolUse {
            id: item.get("id").and_then(|v| v.as_str()).map(String::from),
            name: item
                .get("tool")
                .or_else(|| item.get("name"))
                .or_else(|| item.get("command"))
                .and_then(|v| v.as_str())
                .unwrap_or(t)
                .to_string(),
            input: item.get("arguments").or_else(|| item.get("input")).cloned(),
        }],
        _ => Vec::new(),
    }
}

fn item_completed_events(item: Option<&serde_json::Value>) -> Vec<EngineEvent> {
    let Some(item) = item else { return Vec::new() };
    match item.get("type").and_then(|v| v.as_str()) {
        Some("agent_message") => item
            .get("text")
            .and_then(|v| v.as_str())
            .filter(|t| !t.trim().is_empty())
            .map(|t| {
                vec![EngineEvent::AssistantMessage {
                    text: t.to_string(),
                }]
            })
            .unwrap_or_default(),
        Some(t) if is_tool_item(t) => {
            let content = match item.get("result") {
                Some(r) if !r.is_null() => Some(r.clone()),
                _ => item.get("error").filter(|e| !e.is_null()).cloned(),
            };
            vec![EngineEvent::ToolResult {
                tool_use_id: item.get("id").and_then(|v| v.as_str()).map(String::from),
                content,
            }]
        }
        _ => Vec::new(),
    }
}

fn sandbox_for(spec: &SessionSpec) -> String {
    if spec.permission_mode.trim().is_empty() {
        "workspace-write".to_string()
    } else {
        spec.permission_mode.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::adapter::EngineAdapter;
    use std::path::PathBuf;

    fn spec() -> SessionSpec {
        SessionSpec {
            session_id: "session-1".to_string(),
            cwd: "/repo".to_string(),
            mcp_config_path: PathBuf::from("/unused"),
            codex_home: Some(PathBuf::from("/tmp/codex-home")),
            prompt: "list pages".to_string(),
            permission_mode: "workspace-write".to_string(),
            model: None,
            resume_engine_session_id: None,
            scribe: None,
        }
    }

    #[test]
    fn builds_initial_exec_args() {
        assert_eq!(
            CodexAdapter::build_args(&spec(), "list pages"),
            vec![
                "exec",
                "--json",
                "--skip-git-repo-check",
                "-C",
                "/repo",
                "-s",
                "workspace-write",
                "list pages"
            ]
        );
    }

    #[test]
    fn builds_resume_exec_args() {
        let mut s = spec();
        s.resume_engine_session_id = Some("thread-1".to_string());
        assert_eq!(
            CodexAdapter::build_args(&s, "continue"),
            vec!["exec", "resume", "thread-1", "--json", "continue"]
        );
    }

    #[test]
    fn extracts_thread_id_from_thread_started() {
        assert_eq!(
            CodexAdapter.extract_engine_session_id(&serde_json::json!({
                "type": "thread.started",
                "thread_id": "019f-abc"
            })),
            Some("019f-abc".to_string())
        );
        // Non-thread lines carry no id.
        assert_eq!(
            CodexAdapter.extract_engine_session_id(&serde_json::json!({ "type": "turn.started" })),
            None
        );
    }

    #[test]
    fn parses_agent_message_item() {
        let line = serde_json::json!({
            "type": "item.completed",
            "item": { "id": "item_0", "type": "agent_message", "text": "Here you go." }
        });
        assert_eq!(
            CodexAdapter.parse_events(&line),
            vec![EngineEvent::AssistantMessage {
                text: "Here you go.".to_string()
            }]
        );
    }

    // Fixture lines below captured from a live codex 0.142.5 run against the
    // pear MCP server.
    #[test]
    fn parses_mcp_tool_call_started_as_tool_use() {
        let line = serde_json::json!({
            "type": "item.started",
            "item": {
                "id": "item_1", "type": "mcp_tool_call", "server": "pear",
                "tool": "remember",
                "arguments": { "title": "note", "content": "the codex desktop engine wrote this" },
                "result": null, "error": null, "status": "in_progress"
            }
        });
        assert_eq!(
            CodexAdapter.parse_events(&line),
            vec![EngineEvent::ToolUse {
                id: Some("item_1".to_string()),
                name: "remember".to_string(),
                input: Some(serde_json::json!({
                    "title": "note", "content": "the codex desktop engine wrote this"
                })),
            }]
        );
    }

    #[test]
    fn parses_mcp_tool_call_completed_as_tool_result() {
        let result = serde_json::json!({
            "content": [{ "type": "text", "text": "{\"ok\":true,\"page_id\":4}" }],
            "structured_content": null
        });
        let line = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "item_1", "type": "mcp_tool_call", "server": "pear",
                "tool": "remember", "arguments": {},
                "result": result, "error": null, "status": "completed"
            }
        });
        assert_eq!(
            CodexAdapter.parse_events(&line),
            vec![EngineEvent::ToolResult {
                tool_use_id: Some("item_1".to_string()),
                content: Some(result),
            }]
        );
    }

    #[test]
    fn failed_mcp_tool_call_carries_error_as_result_content() {
        let line = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "item_1", "type": "mcp_tool_call", "server": "pear",
                "tool": "remember", "arguments": {},
                "result": null,
                "error": { "message": "user cancelled MCP tool call" },
                "status": "failed"
            }
        });
        assert_eq!(
            CodexAdapter.parse_events(&line),
            vec![EngineEvent::ToolResult {
                tool_use_id: Some("item_1".to_string()),
                content: Some(serde_json::json!({ "message": "user cancelled MCP tool call" })),
            }]
        );
    }

    #[test]
    fn parses_turn_completed() {
        let line = serde_json::json!({ "type": "turn.completed", "usage": { "input_tokens": 5 } });
        assert_eq!(
            CodexAdapter.parse_events(&line),
            vec![EngineEvent::TurnCompleted {
                success: true,
                cost_usd: None,
                usage: Some(serde_json::json!({ "input_tokens": 5 })),
            }]
        );
    }
}
