//! Claude Code adapter — persistent-stdin headless mode.
//!
//! Flags verified against claude 2.1.201. The process stays alive across
//! turns: user messages are written to stdin as stream-json lines and the
//! reply stream arrives on stdout as JSONL. `--strict-mcp-config` isolates
//! the session from the user's global MCP config so pear is the only server;
//! `--allowedTools mcp__pear` pre-approves every pear tool (headless mode
//! cannot prompt).

use super::{
    adapter::{EngineAdapter, InteractionMode, SessionSpec},
    events::EngineEvent,
};

pub struct ClaudeCodeAdapter;

impl EngineAdapter for ClaudeCodeAdapter {
    fn id(&self) -> &'static str {
        "claude-code"
    }

    fn interaction(&self) -> InteractionMode {
        InteractionMode::PersistentStdin
    }

    fn build_command(&self, spec: &SessionSpec) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new("claude");
        cmd.arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--mcp-config")
            .arg(&spec.mcp_config_path)
            .arg("--strict-mcp-config")
            .arg("--allowedTools")
            .arg("mcp__pear")
            .arg("--permission-mode")
            .arg(&spec.permission_mode);
        if let Some(model) = &spec.model {
            cmd.arg("--model").arg(model);
        }
        if let Some(resume) = &spec.resume_engine_session_id {
            cmd.arg("--resume").arg(resume);
        } else {
            cmd.arg("--session-id").arg(&spec.session_id);
        }
        cmd.current_dir(&spec.cwd);
        cmd
    }

    fn stdin_message(&self, text: &str) -> String {
        serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
        })
        .to_string()
            + "\n"
    }

    fn extract_engine_session_id(&self, line: &serde_json::Value) -> Option<String> {
        line.get("session_id")
            .and_then(|v| v.as_str())
            .map(String::from)
    }

    fn parse_events(&self, line: &serde_json::Value) -> Vec<EngineEvent> {
        match line.get("type").and_then(|v| v.as_str()) {
            Some("assistant") => assistant_events(line),
            Some("user") => tool_result_events(line),
            Some("result") => vec![EngineEvent::TurnCompleted {
                success: line.get("subtype").and_then(|v| v.as_str()) == Some("success"),
                cost_usd: line.get("total_cost_usd").and_then(|v| v.as_f64()),
                usage: line.get("usage").cloned(),
            }],
            _ => Vec::new(),
        }
    }
}

fn assistant_events(line: &serde_json::Value) -> Vec<EngineEvent> {
    let Some(content) = line
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };

    content
        .iter()
        .filter_map(|block| match block.get("type").and_then(|v| v.as_str()) {
            Some("text") => block
                .get("text")
                .and_then(|v| v.as_str())
                .filter(|text| !text.trim().is_empty())
                .map(|text| EngineEvent::AssistantMessage {
                    text: text.to_string(),
                }),
            Some("tool_use") => Some(EngineEvent::ToolUse {
                id: block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                name: block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string(),
                input: block.get("input").cloned(),
            }),
            _ => None,
        })
        .collect()
}

fn tool_result_events(line: &serde_json::Value) -> Vec<EngineEvent> {
    let Some(content) = line
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };

    content
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                return None;
            }
            Some(EngineEvent::ToolResult {
                tool_use_id: block
                    .get("tool_use_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                content: block.get("content").cloned(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engines::adapter::EngineAdapter;

    #[test]
    fn parses_assistant_text_and_tool_use() {
        let line = serde_json::json!({
            "type": "assistant",
            "message": {
                "content": [
                    { "type": "text", "text": "I will look that up." },
                    {
                        "type": "tool_use",
                        "id": "toolu_123",
                        "name": "mcp__pear__search_pages",
                        "input": { "query": "Notes" }
                    }
                ]
            }
        });

        let events = ClaudeCodeAdapter.parse_events(&line);

        assert_eq!(
            events,
            vec![
                EngineEvent::AssistantMessage {
                    text: "I will look that up.".to_string(),
                },
                EngineEvent::ToolUse {
                    id: Some("toolu_123".to_string()),
                    name: "mcp__pear__search_pages".to_string(),
                    input: Some(serde_json::json!({ "query": "Notes" })),
                },
            ]
        );
    }

    #[test]
    fn parses_tool_result_blocks_from_user_messages() {
        let line = serde_json::json!({
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_123",
                        "content": [{ "type": "text", "text": "{\"ok\":true}" }]
                    }
                ]
            }
        });

        let events = ClaudeCodeAdapter.parse_events(&line);

        assert_eq!(
            events,
            vec![EngineEvent::ToolResult {
                tool_use_id: Some("toolu_123".to_string()),
                content: Some(serde_json::json!([{ "type": "text", "text": "{\"ok\":true}" }])),
            }]
        );
    }

    #[test]
    fn parses_turn_completion_cost_and_usage() {
        let line = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "total_cost_usd": 0.0123,
            "usage": { "input_tokens": 10, "output_tokens": 20 }
        });

        let events = ClaudeCodeAdapter.parse_events(&line);

        assert_eq!(
            events,
            vec![EngineEvent::TurnCompleted {
                success: true,
                cost_usd: Some(0.0123),
                usage: Some(serde_json::json!({ "input_tokens": 10, "output_tokens": 20 })),
            }]
        );
    }

    #[test]
    fn extracts_engine_session_id() {
        let line = serde_json::json!({
            "type": "system",
            "subtype": "init",
            "session_id": "claude-session-1"
        });

        assert_eq!(
            ClaudeCodeAdapter.extract_engine_session_id(&line),
            Some("claude-session-1".to_string())
        );
    }
}
