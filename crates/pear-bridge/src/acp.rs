//! Agent Client Protocol harness transport (ticket 14602, Phases 1/2a).
//!
//! This module is deliberately behind the harness seam: the cwd has already
//! passed the bridge's `allowed_directories` jail before [`run_turn`] can
//! spawn anything. It owns a small newline-delimited JSON-RPC pump instead of
//! the ACP SDK connection runner so timeout cancellation, disabled client
//! capabilities, chunk-envelope compatibility, and subprocess lifetime stay
//! explicit at this security boundary.
//!
//! In particular, agent stdin remains open until the child is killed. The
//! codex adapter does not exit on stdin EOF, and `npx`-launched adapters must
//! never outlive a completed or failed harness turn. Advertised auth methods
//! are intentionally ignored: ambient CLI login is sufficient for the known
//! adapters, and only a failing `session/new` is treated as an auth symptom.

use std::collections::BTreeMap;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::str::FromStr;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, ClientCapabilities, ContentBlock, FileSystemCapabilities, Implementation,
    InitializeRequest, InitializeResponse, LoadSessionRequest, LoadSessionResponse,
    NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, SetSessionModeRequest,
    SetSessionModeResponse, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, AcpAgentConfig};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::daemon::{
    ApprovalDecision, ApprovalDiff, ApprovalFramePayload, ApprovalOption, ApprovalPort,
};
use crate::providers::{ChunkOut, ChunkSender};

const CLIENT_NAME: &str = "pear-bridge";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const CLAUDE_COMMAND: &str = "npx -y @agentclientprotocol/claude-agent-acp";
const CODEX_COMMAND: &str = "npx -y @agentclientprotocol/codex-acp";
const SESSION_MAP_FILE: &str = "acp-sessions.json";
const DEFAULT_APPROVAL_TIMEOUT_SECS: u64 = 300;

tokio::task_local! {
    static TURN_APPROVAL_PORT: Option<ApprovalPort>;
}

/// Carry the relay-only port across the existing harness seam. Direct harness
/// and desktop callers never enter this scope, so their Phase 1 default-deny
/// behavior remains unchanged.
pub(crate) async fn with_approval_port<F>(approvals: Option<ApprovalPort>, future: F) -> F::Output
where
    F: Future,
{
    TURN_APPROVAL_PORT.scope(approvals, future).await
}

/// One already-jailed harness turn. Callers may add environment entries, but
/// the child still inherits the daemon's ordinary environment by default.
pub(crate) struct TurnRequest<'a> {
    pub provider: &'a str,
    pub worker_session_id: &'a str,
    pub prompt: &'a str,
    pub cwd: &'a Path,
    pub mode: Option<&'a str>,
    pub timeout: Duration,
    pub chunks: Option<ChunkSender>,
    pub extra_env: &'a BTreeMap<String, String>,
}

/// Result data that the existing harness envelope needs from the ACP path.
pub(crate) struct TurnOutcome {
    pub output: String,
    pub resumed: bool,
}

/// Whether a harness provider has a Phase 1 ACP adapter mapping.
pub(crate) fn supports_provider(provider: &str) -> bool {
    matches!(provider, "claude-code" | "claude" | "codex")
}

/// Map Pear's bounded permission modes to each adapter's ACP mode IDs. Direct
/// safe codex IDs are also accepted for local testing; modes that remove the
/// remaining adapter guard are rejected explicitly.
pub(crate) fn permission_mode(provider: &str, requested: &str) -> Result<String, String> {
    if requested == "bypassPermissions" {
        return Err("permission_mode \"bypassPermissions\" is refused over the bridge".to_string());
    }
    match provider {
        "claude-code" | "claude" => match requested {
            "default" | "acceptEdits" | "plan" => Ok(requested.to_string()),
            _ => Err(format!(
                "permission_mode \"{requested}\" is not allowed for the Claude ACP adapter \
                 (allowed: default, acceptEdits, plan)"
            )),
        },
        "codex" => match requested {
            // Codex does not surface permission requests reliably. Map the
            // conservative Pear modes to read-only and edit-enabled mode only.
            "default" | "plan" | "read-only" => Ok("read-only".to_string()),
            "acceptEdits" | "agent" => Ok("agent".to_string()),
            "agent-full-access" => {
                Err("permission_mode \"agent-full-access\" is refused over the bridge".to_string())
            }
            _ => Err(format!(
                "permission_mode \"{requested}\" is not allowed for the Codex ACP adapter \
                 (allowed: default, acceptEdits, plan, read-only, agent)"
            )),
        },
        _ => Err(format!(
            "harness provider \"{provider}\" is not supported over ACP"
        )),
    }
}

/// Run one ACP subprocess for one harness turn.
pub(crate) async fn run_turn(request: TurnRequest<'_>) -> Result<TurnOutcome, String> {
    validate_extra_env(request.extra_env)?;
    let command = agent_command(request.provider)?;
    let map_path = session_map_path()?;
    let mut session_map = SessionMap::load(&map_path)?;
    let mapped_session = session_map
        .get(request.worker_session_id)
        .map(str::to_string);

    let approvals = TURN_APPROVAL_PORT.try_with(Clone::clone).ok().flatten();
    let mut process = AgentProcess::spawn(&command, request.cwd, request.extra_env, approvals)?;
    let protocol_result = drive_protocol(
        &mut process.connection,
        request.worker_session_id,
        mapped_session.as_deref(),
        request.prompt,
        request.cwd,
        request.mode,
        request.timeout,
        request.chunks,
        &mut session_map,
        &map_path,
    )
    .await;

    // Kill before dropping RpcConnection so stdin remains open for the entire
    // child lifetime. `kill_on_drop` is the fallback for cancellation/panics.
    let shutdown_result = process.shutdown().await;
    match (protocol_result, shutdown_result) {
        (Ok(outcome), Ok(())) => Ok(outcome),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), _) => Err(error),
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive_protocol(
    connection: &mut RpcConnection,
    worker_session_id: &str,
    mapped_session: Option<&str>,
    prompt: &str,
    cwd: &Path,
    mode: Option<&str>,
    timeout: Duration,
    chunks: Option<ChunkSender>,
    session_map: &mut SessionMap,
    map_path: &Path,
) -> Result<TurnOutcome, String> {
    let capabilities = ClientCapabilities::new()
        .fs(FileSystemCapabilities::new()
            .read_text_file(false)
            .write_text_file(false))
        .terminal(false);
    let initialize = InitializeRequest::new(ProtocolVersion::V1)
        .client_capabilities(capabilities)
        .client_info(Implementation::new(CLIENT_NAME, CLIENT_VERSION));
    let initialize_result = connection.request("initialize", &initialize, false).await?;
    let _: InitializeResponse = serde_json::from_value(initialize_result)
        .map_err(|error| format!("invalid initialize response: {error}"))?;

    let (session_id, resumed) = if let Some(mapped) = mapped_session {
        let load = LoadSessionRequest::new(mapped.to_string(), cwd.to_path_buf());
        match connection.request("session/load", &load, false).await {
            Ok(result) => {
                let _: LoadSessionResponse = serde_json::from_value(result)
                    .map_err(|error| format!("invalid session/load response: {error}"))?;
                (mapped.to_string(), true)
            }
            Err(_) => {
                connection.translator.reset();
                let session_id = new_session(connection, cwd).await?;
                session_map.insert(worker_session_id, &session_id);
                session_map.save(map_path)?;
                (session_id, false)
            }
        }
    } else {
        let session_id = new_session(connection, cwd).await?;
        session_map.insert(worker_session_id, &session_id);
        session_map.save(map_path)?;
        (session_id, false)
    };

    if let Some(mode_id) = mode {
        let set_mode = SetSessionModeRequest::new(session_id.clone(), mode_id.to_string());
        let result = connection
            .request("session/set_mode", &set_mode, false)
            .await?;
        let _: SetSessionModeResponse = serde_json::from_value(result)
            .map_err(|error| format!("invalid session/set_mode response: {error}"))?;
    }

    connection.translator.begin_turn(chunks);
    let prompt_request = PromptRequest::new(
        session_id.clone(),
        vec![ContentBlock::Text(TextContent::new(prompt.to_string()))],
    );
    let prompt_result = tokio::time::timeout(
        timeout,
        connection.request("session/prompt", &prompt_request, true),
    )
    .await;
    let result = match prompt_result {
        Ok(result) => result?,
        Err(_) => {
            let cancel = CancelNotification::new(session_id);
            let cancel_error = connection
                .notification("session/cancel", &cancel)
                .await
                .err();
            let suffix = cancel_error
                .map(|error| format!("; session/cancel failed: {error}"))
                .unwrap_or_default();
            return Err(format!(
                "ACP harness turn timed out after {}s; session/cancel sent{suffix}",
                timeout.as_secs()
            ));
        }
    };
    let _: PromptResponse = serde_json::from_value(result)
        .map_err(|error| format!("invalid session/prompt response: {error}"))?;

    Ok(TurnOutcome {
        output: connection.translator.take_output(),
        resumed,
    })
}

async fn new_session(connection: &mut RpcConnection, cwd: &Path) -> Result<String, String> {
    let request = NewSessionRequest::new(cwd.to_path_buf());
    let result = connection
        .request("session/new", &request, false)
        .await
        .map_err(|error| format!("session/new failed (authentication may be required): {error}"))?;
    let response: NewSessionResponse = serde_json::from_value(result)
        .map_err(|error| format!("invalid session/new response: {error}"))?;
    Ok(response.session_id.to_string())
}

fn agent_command(provider: &str) -> Result<AcpAgentConfig, String> {
    let (env_name, default) = agent_command_setting(provider)?;
    let configured = std::env::var(env_name).unwrap_or_else(|_| default.to_string());
    parse_agent_command(&configured)
        .map_err(|error| format!("invalid {env_name} ACP command: {error}"))
}

fn agent_command_setting(provider: &str) -> Result<(&'static str, &'static str), String> {
    let setting = match provider {
        "claude-code" | "claude" => ("PEAR_BRIDGE_ACP_CLAUDE_CMD", CLAUDE_COMMAND),
        "codex" => ("PEAR_BRIDGE_ACP_CODEX_CMD", CODEX_COMMAND),
        _ => {
            return Err(format!(
                "harness provider \"{provider}\" is not supported over ACP"
            ))
        }
    };
    Ok(setting)
}

fn parse_agent_command(command: &str) -> Result<AcpAgentConfig, String> {
    let agent = AcpAgent::from_str(command).map_err(|error| error.to_string())?;
    let config = agent.into_config();
    if config.command().as_os_str().is_empty() {
        return Err("agent command is empty".to_string());
    }
    Ok(config)
}

fn validate_extra_env(env: &BTreeMap<String, String>) -> Result<(), String> {
    for key in env.keys() {
        let valid = !key.is_empty()
            && key.chars().enumerate().all(|(index, character)| {
                character == '_'
                    || character.is_ascii_alphabetic()
                    || (index > 0 && character.is_ascii_digit())
            });
        if !valid {
            return Err(format!("invalid ACP environment variable name: {key}"));
        }
    }
    Ok(())
}

/// Child is declared before the connection so drop kills it before closing
/// the stdin owned by the connection. This matters for codex-acp, which hangs
/// after EOF instead of exiting.
struct AgentProcess {
    child: Child,
    connection: RpcConnection,
}

impl AgentProcess {
    fn spawn(
        config: &AcpAgentConfig,
        cwd: &Path,
        extra_env: &BTreeMap<String, String>,
        approvals: Option<ApprovalPort>,
    ) -> Result<Self, String> {
        let mut command = Command::new(config.command());
        command
            .args(config.arguments())
            .envs(config.environment())
            .envs(extra_env)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Drain-free and bounded: adapter diagnostics cannot block the
            // JSON-RPC pump or become part of the worker-visible envelope.
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
            format!(
                "failed to launch ACP agent {}: {error}",
                config.command().display()
            )
        })?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open ACP agent stdin".to_string())?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| "failed to open ACP agent stdout".to_string())?;
        Ok(Self {
            child,
            connection: RpcConnection::new(input, output, approvals),
        })
    }

    async fn shutdown(&mut self) -> Result<(), String> {
        if self
            .child
            .try_wait()
            .map_err(|error| format!("failed to inspect ACP agent process: {error}"))?
            .is_none()
        {
            self.child
                .kill()
                .await
                .map_err(|error| format!("failed to terminate ACP agent process: {error}"))?;
        }
        Ok(())
    }
}

struct RpcConnection {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
    translator: UpdateTranslator,
    approvals: Option<ApprovalPort>,
}

impl RpcConnection {
    fn new(input: ChildStdin, output: ChildStdout, approvals: Option<ApprovalPort>) -> Self {
        Self {
            input,
            output: BufReader::new(output),
            next_id: 1,
            translator: UpdateTranslator::default(),
            approvals,
        }
    }

    async fn request<T: Serialize>(
        &mut self,
        method: &str,
        params: &T,
        emit_updates: bool,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| "ACP JSON-RPC request id overflow".to_string())?;
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": serde_json::to_value(params)
                .map_err(|error| format!("failed to serialize {method} request: {error}"))?,
        }))
        .await?;
        self.wait_for_response(id, method, emit_updates).await
    }

    async fn notification<T: Serialize>(&mut self, method: &str, params: &T) -> Result<(), String> {
        self.send(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": serde_json::to_value(params)
                .map_err(|error| format!("failed to serialize {method} notification: {error}"))?,
        }))
        .await
    }

    async fn wait_for_response(
        &mut self,
        expected_id: u64,
        request_method: &str,
        emit_updates: bool,
    ) -> Result<Value, String> {
        loop {
            let message = self.read().await?;
            if message.get("method").is_some() {
                self.handle_agent_message(&message, emit_updates).await?;
                continue;
            }
            if message.get("id") != Some(&Value::from(expected_id)) {
                return Err(format!(
                    "ACP agent returned a response with an unexpected id while waiting for {request_method}"
                ));
            }
            if let Some(error) = message.get("error") {
                return Err(format!("{request_method} returned JSON-RPC error: {error}"));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| format!("{request_method} response has neither result nor error"));
        }
    }

    async fn handle_agent_message(
        &mut self,
        message: &Value,
        emit_updates: bool,
    ) -> Result<(), String> {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| "ACP JSON-RPC method is not a string".to_string())?;

        if method == "session/update" {
            if message.get("id").is_some() {
                return Err("ACP session/update unexpectedly carried a request id".to_string());
            }
            let envelope = self.translator.translate_message(message)?;
            if emit_updates {
                self.translator.emit(envelope)?;
            }
            return Ok(());
        }

        let Some(id) = message.get("id").cloned() else {
            return Err(format!("ACP agent sent unsupported notification: {method}"));
        };

        if method == "session/request_permission" {
            let params = message.get("params");
            let response = match resolve_permission(params, self.approvals.as_ref()).await {
                Ok(resolution) => {
                    if emit_updates {
                        self.translator
                            .emit(Some(permission_chunk(params, &resolution.decision)))?;
                    }
                    json!({"jsonrpc": "2.0", "id": id, "result": resolution.result})
                }
                Err(error) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": -32602, "message": error},
                }),
            };
            return self.send(&response).await;
        }

        // fs/* and terminal/* arrive here, along with any future request we
        // did not advertise. Reject cleanly rather than entering an impossible
        // capability branch or panicking on its params.
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("client capability disabled; method is not supported: {method}"),
            },
        }))
        .await
    }

    async fn read(&mut self) -> Result<Value, String> {
        let mut raw = String::new();
        let bytes = self
            .output
            .read_line(&mut raw)
            .await
            .map_err(|error| format!("failed to read ACP agent stdout: {error}"))?;
        if bytes == 0 {
            return Err("ACP agent closed stdout before completing the request".to_string());
        }
        let message: Value = serde_json::from_str(raw.trim_end_matches(['\r', '\n']))
            .map_err(|error| format!("ACP agent emitted invalid JSON-RPC: {error}"))?;
        let object = message
            .as_object()
            .ok_or_else(|| "ACP agent emitted a non-object JSON-RPC message".to_string())?;
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err("ACP agent emitted a message without jsonrpc=2.0".to_string());
        }
        Ok(message)
    }

    async fn send(&mut self, value: &Value) -> Result<(), String> {
        let raw = serde_json::to_string(value)
            .map_err(|error| format!("failed to serialize ACP JSON-RPC message: {error}"))?;
        self.input
            .write_all(raw.as_bytes())
            .await
            .map_err(|error| format!("failed to write ACP agent stdin: {error}"))?;
        self.input
            .write_all(b"\n")
            .await
            .map_err(|error| format!("failed to write ACP agent stdin: {error}"))?;
        self.input
            .flush()
            .await
            .map_err(|error| format!("failed to flush ACP agent stdin: {error}"))
    }
}

/// Whether this daemon auto-approves agent permission requests. This opt-in
/// short-circuits the relay round-trip and exists for local adapter testing.
///
/// Rationale (14602 Phase 0 finding): auto-allowing is strictly wider than the
/// legacy path, where headless `claude -p` simply cannot answer a prompt and
/// the tool call fails. Those same prompts were measured to be what stops an
/// agent writing outside its workspace — rejecting them blocked the escape in
/// testing, so silently allowing them here would remove a guard the bridge
/// currently has. The opt-in exists for local adapter testing only.
fn auto_approve_enabled() -> bool {
    std::env::var("PEAR_BRIDGE_ACP_AUTO_APPROVE").as_deref() == Ok("1")
}

fn approval_timeout() -> Duration {
    std::env::var("PEAR_BRIDGE_ACP_APPROVAL_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_APPROVAL_TIMEOUT_SECS))
}

/// Decide a `session/request_permission` without a human in the loop.
///
/// Deny by default. Even under the testing opt-in only `allow_once` is ever
/// selected: `allow_always` is a *session-scoped mode escalation* on the Claude
/// adapter, which no unattended policy should be able to trigger.
fn permission_result(params: Option<&Value>) -> Result<Value, String> {
    permission_result_for_policy(params, auto_approve_enabled())
}

struct PermissionResolution {
    result: Value,
    decision: String,
}

/// Resolve a permission request without ending the ACP turn. The adapter is
/// blocked on this JSON-RPC response and may already have edited files, so the
/// request must stay in flight while the relay obtains a human decision;
/// returning a turn-terminal AwaitingConfirmation result would abandon that
/// state and make a retry non-deterministic.
async fn resolve_permission(
    params: Option<&Value>,
    approvals: Option<&ApprovalPort>,
) -> Result<PermissionResolution, String> {
    resolve_permission_with(
        params,
        approvals,
        auto_approve_enabled(),
        approval_timeout(),
    )
    .await
}

async fn resolve_permission_with(
    params: Option<&Value>,
    approvals: Option<&ApprovalPort>,
    auto_approve: bool,
    timeout: Duration,
) -> Result<PermissionResolution, String> {
    // The testing opt-in keeps its Phase 1 semantics and never reaches a relay.
    // Its allow_once-only selection also preserves the hard prohibition on
    // unattended allow_always escalation.
    if auto_approve {
        let result = permission_result_for_policy(params, true)?;
        let decision =
            if result.pointer("/outcome/outcome").and_then(Value::as_str) == Some("selected") {
                "auto_allowed"
            } else {
                "cancelled"
            };
        return Ok(PermissionResolution {
            result,
            decision: decision.to_string(),
        });
    }

    let Some(approvals) = approvals else {
        let result = permission_result(params)?;
        let decision = permission_result_label(params, &result);
        return Ok(PermissionResolution { result, decision });
    };

    let payload = approval_frame_payload(params)?;
    let options = payload.options.clone();
    let decision = match approvals.request(payload) {
        Ok(decision) => decision,
        Err(_) => return Ok(denied_resolution(&options, "unavailable")),
    };

    match tokio::time::timeout(timeout, decision).await {
        Ok(Ok(decision)) => Ok(resolution_from_relay_decision(&options, decision)),
        Ok(Err(_)) => Ok(denied_resolution(&options, "unavailable")),
        Err(_) => Ok(denied_resolution(&options, "timeout")),
    }
}

fn permission_result_for_policy(
    params: Option<&Value>,
    auto_approve: bool,
) -> Result<Value, String> {
    let options = params
        .and_then(|value| value.get("options"))
        .and_then(Value::as_array)
        .ok_or_else(|| "session/request_permission params.options must be an array".to_string())?;

    let wanted: &[&str] = if auto_approve {
        &["allow_once"]
    } else {
        &["reject_once", "reject_always"]
    };
    let option_id = wanted.iter().find_map(|kind| {
        options.iter().find_map(|option| {
            (option.get("kind")?.as_str()? == *kind)
                .then(|| option.get("optionId")?.as_str())
                .flatten()
        })
    });

    // No option of the intended kind: cancel rather than fall back to whatever
    // the agent listed first — a wrong pick here is an unattended approval.
    Ok(match option_id {
        Some(option_id) => json!({
            "outcome": {"outcome": "selected", "optionId": option_id},
        }),
        None => json!({"outcome": {"outcome": "cancelled"}}),
    })
}

fn approval_frame_payload(params: Option<&Value>) -> Result<ApprovalFramePayload, String> {
    let params = params
        .and_then(Value::as_object)
        .ok_or_else(|| "session/request_permission params must be an object".to_string())?;
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| "session/request_permission params.options must be an array".to_string())?
        .iter()
        .map(|option| {
            let option = option
                .as_object()
                .ok_or_else(|| "session/request_permission option must be an object".to_string())?;
            Ok(ApprovalOption {
                option_id: required_string(option, "optionId")?.to_string(),
                name: required_string(option, "name")?.to_string(),
                kind: required_string(option, "kind")?.to_string(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let tool_call = match params.get("toolCall") {
        None => None,
        Some(value) => Some(value.as_object().ok_or_else(|| {
            "session/request_permission params.toolCall must be an object".to_string()
        })?),
    };
    let tool_call_id = approval_optional_string(tool_call, "toolCallId")?;
    let title = approval_optional_string(tool_call, "title")?;
    let kind = approval_optional_string(tool_call, "kind")?;
    let diffs = approval_diffs(tool_call)?;

    Ok(ApprovalFramePayload {
        tool_call_id,
        title,
        kind,
        options,
        diffs,
    })
}

fn approval_optional_string(
    object: Option<&serde_json::Map<String, Value>>,
    key: &str,
) -> Result<Option<String>, String> {
    match object.and_then(|object| object.get(key)) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| {
                format!("session/request_permission params.toolCall.{key} must be a string")
            }),
    }
}

fn approval_diffs(
    tool_call: Option<&serde_json::Map<String, Value>>,
) -> Result<Option<Vec<ApprovalDiff>>, String> {
    let Some(content) = tool_call.and_then(|tool_call| tool_call.get("content")) else {
        return Ok(None);
    };
    let content = content.as_array().ok_or_else(|| {
        "session/request_permission params.toolCall.content must be an array".to_string()
    })?;
    let mut diffs = Vec::new();
    for item in content {
        let item = item.as_object().ok_or_else(|| {
            "session/request_permission tool content must be an object".to_string()
        })?;
        if item.get("type").and_then(Value::as_str) != Some("diff") {
            continue;
        }
        diffs.push(ApprovalDiff {
            path: required_string(item, "path")?.to_string(),
            old_text: nullable_string(item, "oldText")?,
            new_text: nullable_string(item, "newText")?,
        });
    }
    Ok((!diffs.is_empty()).then_some(diffs))
}

fn nullable_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| format!("ACP diff {key} must be string or null")),
    }
}

fn resolution_from_relay_decision(
    options: &[ApprovalOption],
    decision: ApprovalDecision,
) -> PermissionResolution {
    if decision.outcome == "cancelled" {
        return PermissionResolution {
            result: json!({"outcome": {"outcome": "cancelled"}}),
            decision: "cancelled".to_string(),
        };
    }
    if decision.outcome == "selected" {
        if let Some(option) = decision
            .option_id
            .as_deref()
            .and_then(|id| options.iter().find(|option| option.option_id == id))
        {
            let label = if option.kind.starts_with("allow_") {
                "allowed"
            } else if option.kind.starts_with("reject_") {
                "denied"
            } else {
                "selected"
            };
            return PermissionResolution {
                result: json!({
                    "outcome": {"outcome": "selected", "optionId": option.option_id},
                }),
                decision: label.to_string(),
            };
        }
    }

    // Malformed, stale, or unsupported relay decisions never broaden access.
    denied_resolution(options, "denied")
}

fn denied_resolution(options: &[ApprovalOption], decision: &str) -> PermissionResolution {
    let reject = options
        .iter()
        .find(|option| matches!(option.kind.as_str(), "reject_once" | "reject_always"));
    PermissionResolution {
        result: match reject {
            Some(option) => json!({
                "outcome": {"outcome": "selected", "optionId": option.option_id},
            }),
            None => json!({"outcome": {"outcome": "cancelled"}}),
        },
        decision: decision.to_string(),
    }
}

fn permission_result_label(params: Option<&Value>, outcome: &Value) -> String {
    let selected = outcome.pointer("/outcome/optionId").and_then(Value::as_str);
    let kind = selected.and_then(|selected| {
        params
            .and_then(|params| params.get("options"))
            .and_then(Value::as_array)?
            .iter()
            .find(|option| option.get("optionId").and_then(Value::as_str) == Some(selected))?
            .get("kind")?
            .as_str()
    });
    match kind {
        Some(kind) if kind.starts_with("reject_") => "denied",
        Some(kind) if kind.starts_with("allow_") => "allowed",
        Some(_) => "selected",
        None => "cancelled",
    }
    .to_string()
}

/// Summarize a permission request and its final decision for the chunk stream,
/// so a denied or timed-out turn is explainable instead of a silent stall.
fn permission_chunk(params: Option<&Value>, decision: &str) -> ChunkEnvelope {
    let tool_call = params.and_then(|value| value.get("toolCall"));
    ChunkEnvelope::Permission {
        perm: PermissionChunk {
            tool_call_id: tool_call
                .and_then(|call| call.get("toolCallId"))
                .and_then(Value::as_str)
                .map(str::to_string),
            title: tool_call
                .and_then(|call| call.get("title"))
                .and_then(Value::as_str)
                .map(str::to_string),
            decision: decision.to_string(),
        },
    }
}

#[derive(Default)]
struct UpdateTranslator {
    tools: BTreeMap<String, ToolChunk>,
    output: String,
    seq: u32,
    chunks: Option<ChunkSender>,
}

impl UpdateTranslator {
    fn reset(&mut self) {
        self.tools.clear();
        self.output.clear();
        self.seq = 0;
        self.chunks = None;
    }

    fn begin_turn(&mut self, chunks: Option<ChunkSender>) {
        self.reset();
        self.chunks = chunks;
    }

    fn take_output(&mut self) -> String {
        std::mem::take(&mut self.output)
    }

    fn translate_message(&mut self, message: &Value) -> Result<Option<ChunkEnvelope>, String> {
        let params = message
            .get("params")
            .and_then(Value::as_object)
            .ok_or_else(|| "session/update params must be an object".to_string())?;
        params
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "session/update params.sessionId must be a string".to_string())?;
        let update = params
            .get("update")
            .and_then(Value::as_object)
            .ok_or_else(|| "session/update params.update must be an object".to_string())?;
        let update_type = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .ok_or_else(|| "session/update discriminator must be a string".to_string())?;

        match update_type {
            "agent_message_chunk" => Ok(Some(ChunkEnvelope::Text {
                d: text_content(update)?.to_string(),
            })),
            "agent_thought_chunk" => Ok(Some(ChunkEnvelope::Think {
                d: text_content(update)?.to_string(),
            })),
            "user_message_chunk" => {
                text_content(update)?;
                Ok(None)
            }
            "tool_call" => self
                .tool_call(update)
                .map(|tool| Some(ChunkEnvelope::Tool { tc: tool })),
            "tool_call_update" => self
                .tool_call_update(update)
                .map(|tool| Some(ChunkEnvelope::Tool { tc: tool })),
            "plan" => parse_plan(update).map(|entries| Some(ChunkEnvelope::Plan { entries })),
            "available_commands_update"
            | "current_mode_update"
            | "config_option_update"
            | "session_info_update"
            | "usage_update" => Ok(None),
            other => Err(format!("unsupported ACP session update: {other}")),
        }
    }

    fn emit(&mut self, envelope: Option<ChunkEnvelope>) -> Result<(), String> {
        let Some(envelope) = envelope else {
            return Ok(());
        };
        if let ChunkEnvelope::Text { d } = &envelope {
            self.output.push_str(d);
        }
        if let Some(tx) = &self.chunks {
            let content = serde_json::to_string(&envelope)
                .map_err(|error| format!("failed to serialize ACP chunk: {error}"))?;
            let _ = tx.send(ChunkOut {
                seq: self.seq,
                content,
            });
            self.seq = self
                .seq
                .checked_add(1)
                .ok_or_else(|| "ACP chunk sequence overflow".to_string())?;
        }
        Ok(())
    }

    fn tool_call(&mut self, update: &serde_json::Map<String, Value>) -> Result<ToolChunk, String> {
        let id = required_string(update, "toolCallId")?.to_string();
        if self.tools.contains_key(&id) {
            return Err(format!("duplicate ACP tool_call id: {id}"));
        }
        let content = parse_tool_content(update)?.unwrap_or_default();
        let locations = parse_locations(update)?.unwrap_or_default();
        let tool = ToolChunk {
            id: id.clone(),
            kind: optional_string(update, "kind")?
                .unwrap_or("other")
                .to_string(),
            status: optional_string(update, "status")?
                .unwrap_or("pending")
                .to_string(),
            title: required_string(update, "title")?.to_string(),
            locations: (!locations.is_empty()).then_some(locations),
            diffs: (!content.diffs.is_empty()).then_some(content.diffs),
            terminal_id: content
                .terminal_id
                .or_else(|| meta_terminal_id(update).map(str::to_string)),
        };
        self.tools.insert(id, tool.clone());
        Ok(tool)
    }

    fn tool_call_update(
        &mut self,
        update: &serde_json::Map<String, Value>,
    ) -> Result<ToolChunk, String> {
        let id = required_string(update, "toolCallId")?;
        let kind = optional_string(update, "kind")?.map(str::to_string);
        let status = optional_string(update, "status")?.map(str::to_string);
        let title = optional_string(update, "title")?.map(str::to_string);
        let locations = parse_locations(update)?;
        let content = parse_tool_content(update)?;
        let meta_terminal = meta_terminal_id(update).map(str::to_string);
        let tool = self
            .tools
            .get_mut(id)
            .ok_or_else(|| format!("ACP tool_call_update referenced unknown id: {id}"))?;
        if let Some(kind) = kind {
            tool.kind = kind;
        }
        if let Some(status) = status {
            tool.status = status;
        }
        if let Some(title) = title {
            tool.title = title;
        }
        if let Some(locations) = locations {
            tool.locations = (!locations.is_empty()).then_some(locations);
        }
        if let Some(content) = content {
            tool.diffs = (!content.diffs.is_empty()).then_some(content.diffs);
            tool.terminal_id = content.terminal_id;
        }
        if tool.terminal_id.is_none() {
            tool.terminal_id = meta_terminal;
        }
        Ok(tool.clone())
    }
}

fn text_content(update: &serde_json::Map<String, Value>) -> Result<&str, String> {
    let content = update
        .get("content")
        .and_then(Value::as_object)
        .ok_or_else(|| "ACP content chunk is missing an object content field".to_string())?;
    if content.get("type").and_then(Value::as_str) != Some("text") {
        return Err("ACP content chunk is not text".to_string());
    }
    content
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "ACP text content is missing string text".to_string())
}

fn required_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("ACP update field {key} must be a string"))
}

fn optional_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, String> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_str()
            .map(Some)
            .ok_or_else(|| format!("ACP update field {key} must be a string")),
    }
}

fn parse_locations(
    update: &serde_json::Map<String, Value>,
) -> Result<Option<Vec<ToolLocation>>, String> {
    let Some(value) = update.get("locations") else {
        return Ok(None);
    };
    let values = value
        .as_array()
        .ok_or_else(|| "ACP tool locations must be an array".to_string())?;
    let mut locations = Vec::with_capacity(values.len());
    for value in values {
        let object = value
            .as_object()
            .ok_or_else(|| "ACP tool location must be an object".to_string())?;
        let path = required_string(object, "path")?.to_string();
        let line = match object.get("line") {
            None => None,
            Some(value) => Some(
                value
                    .as_u64()
                    .ok_or_else(|| "ACP tool location line must be an integer".to_string())?,
            ),
        };
        locations.push(ToolLocation { path, line });
    }
    Ok(Some(locations))
}

#[derive(Default)]
struct ParsedToolContent {
    diffs: Vec<ToolDiff>,
    terminal_id: Option<String>,
}

fn parse_tool_content(
    update: &serde_json::Map<String, Value>,
) -> Result<Option<ParsedToolContent>, String> {
    let Some(value) = update.get("content") else {
        return Ok(None);
    };
    let values = value
        .as_array()
        .ok_or_else(|| "ACP tool content must be an array".to_string())?;
    let mut parsed = ParsedToolContent::default();
    for value in values {
        let object = value
            .as_object()
            .ok_or_else(|| "ACP tool content item must be an object".to_string())?;
        match object.get("type").and_then(Value::as_str) {
            Some("diff") => {
                let old_text = match object.get("oldText") {
                    None | Some(Value::Null) => None,
                    Some(value) => Some(
                        value
                            .as_str()
                            .ok_or_else(|| "ACP diff oldText must be string or null".to_string())?
                            .to_string(),
                    ),
                };
                parsed.diffs.push(ToolDiff {
                    path: required_string(object, "path")?.to_string(),
                    old_text,
                    new_text: required_string(object, "newText")?.to_string(),
                });
            }
            Some("terminal") => {
                parsed.terminal_id = Some(required_string(object, "terminalId")?.to_string());
            }
            Some("content") => {}
            Some(other) => return Err(format!("unsupported ACP tool content type: {other}")),
            None => return Err("ACP tool content item is missing string type".to_string()),
        }
    }
    Ok(Some(parsed))
}

fn meta_terminal_id(update: &serde_json::Map<String, Value>) -> Option<&str> {
    update
        .get("_meta")?
        .pointer("/terminal_info/terminal_id")
        .or_else(|| {
            update
                .get("_meta")?
                .pointer("/terminal_output_delta/terminal_id")
        })?
        .as_str()
}

fn parse_plan(update: &serde_json::Map<String, Value>) -> Result<Vec<PlanEntry>, String> {
    let entries = update
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| "ACP plan entries must be an array".to_string())?;
    entries
        .iter()
        .map(|entry| {
            let entry = entry
                .as_object()
                .ok_or_else(|| "ACP plan entry must be an object".to_string())?;
            Ok(PlanEntry {
                content: required_string(entry, "content")?.to_string(),
                priority: required_string(entry, "priority")?.to_string(),
                status: required_string(entry, "status")?.to_string(),
            })
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "t")]
enum ChunkEnvelope {
    #[serde(rename = "text")]
    Text { d: String },
    #[serde(rename = "think")]
    Think { d: String },
    #[serde(rename = "tool")]
    Tool { tc: ToolChunk },
    #[serde(rename = "plan")]
    Plan { entries: Vec<PlanEntry> },
    /// An agent permission request and the daemon's final decision.
    #[serde(rename = "perm")]
    Permission { perm: PermissionChunk },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionChunk {
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    /// "allowed" | "denied" | "selected" | "auto_allowed" | "cancelled" |
    /// "timeout" | "unavailable".
    decision: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolChunk {
    id: String,
    kind: String,
    status: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    locations: Option<Vec<ToolLocation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diffs: Option<Vec<ToolDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct ToolLocation {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolDiff {
    path: String,
    old_text: Option<String>,
    new_text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct PlanEntry {
    content: String,
    priority: String,
    status: String,
}

#[derive(Default)]
struct SessionMap(BTreeMap<String, String>);

impl SessionMap {
    fn load(path: &Path) -> Result<Self, String> {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default())
            }
            Err(error) => {
                return Err(format!(
                    "failed to read ACP session map {}: {error}",
                    path.display()
                ))
            }
        };
        let sessions = serde_json::from_str(&text).map_err(|error| {
            format!(
                "failed to parse ACP session map {}: {error}",
                path.display()
            )
        })?;
        Ok(Self(sessions))
    }

    fn get(&self, worker_session_id: &str) -> Option<&str> {
        self.0.get(worker_session_id).map(String::as_str)
    }

    fn insert(&mut self, worker_session_id: &str, acp_session_id: &str) {
        self.0
            .insert(worker_session_id.to_string(), acp_session_id.to_string());
    }

    /// Persist the map, re-reading first so a concurrent turn's mapping is not
    /// clobbered. Turns for different conversations run in parallel and each
    /// holds its own snapshot; a blind write would drop the other's entry and
    /// silently reset that conversation to a fresh session. Our own entries win
    /// on conflict — they are the ones just confirmed with the agent.
    fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "failed to create ACP session-map directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let mut merged = Self::load(path).unwrap_or_default();
        merged.0.extend(self.0.clone());
        let json = serde_json::to_string(&merged.0)
            .map_err(|error| format!("failed to serialize ACP session map: {error}"))?;
        // Write-then-rename so a crash mid-write cannot leave a half-written map
        // that fails to parse on the next turn.
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, json).map_err(|error| {
            format!(
                "failed to write ACP session map {}: {error}",
                temporary.display()
            )
        })?;
        fs::rename(&temporary, path).map_err(|error| {
            format!(
                "failed to replace ACP session map {}: {error}",
                path.display()
            )
        })
    }
}

fn session_map_path() -> Result<PathBuf, String> {
    let config_path = crate::config::default_path();
    let parent = config_path
        .parent()
        .ok_or_else(|| "pear-bridge config path has no parent directory".to_string())?;
    Ok(parent.join(SESSION_MAP_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exact protocol messages lifted from the Phase 0 adapter fixtures. Tests
    // embed them so the read-only spike is never a runtime dependency.
    const CLAUDE_TEXT: &str = r#"{"ts_ms":13406,"dir":"agent->client","msg":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"d3ead989-bfa2-4235-b273-180aef8296a3","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done"},"messageId":"msg_011CdoKWmyhf6WDa7wzKDVs1"}}}}"#;
    const CODEX_THOUGHT: &str = r#"{"ts_ms":11629,"dir":"agent->client","msg":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"019fdc04-2749-7ee3-850b-047868e16fc9","update":{"sessionUpdate":"agent_thought_chunk","messageId":"rs_0aed5b94bb65a179016a75c3a856308194a8b78c92240c91a3","content":{"type":"text","text":"**Writing patch summary for Pear Bridge daemon**"}}}}}"#;
    const CODEX_TOOL: &str = r#"{"ts_ms":8952,"dir":"agent->client","msg":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"019fdc04-2749-7ee3-850b-047868e16fc9","update":{"sessionUpdate":"tool_call","toolCallId":"exec-d860f35a-092f-4736-818a-7714c5fba53d","status":"in_progress","kind":"execute","title":"pwd && if [ -f AGENTS.md ]; then printf '%s\\n' AGENTS.md; fi && if [ -f notes.txt ]; then sed -n '1,200p' notes.txt; else printf '%s\\n' 'notes.txt not found'; fi","content":[{"type":"terminal","terminalId":"exec-d860f35a-092f-4736-818a-7714c5fba53d"}],"rawInput":{"command":"pwd && if [ -f AGENTS.md ]; then printf '%s\\n' AGENTS.md; fi && if [ -f notes.txt ]; then sed -n '1,200p' notes.txt; else printf '%s\\n' 'notes.txt not found'; fi","cwd":"/private/tmp/claude-501/-Users-kara-Projects-EclosionTech-pear-cloud/867f5aca-b6af-48fe-98ae-372e5fffb7a6/scratchpad/acp-live-codex"},"_meta":{"terminal_info":{"cwd":"/private/tmp/claude-501/-Users-kara-Projects-EclosionTech-pear-cloud/867f5aca-b6af-48fe-98ae-372e5fffb7a6/scratchpad/acp-live-codex","terminal_id":"exec-d860f35a-092f-4736-818a-7714c5fba53d"}}}}}}"#;
    const CODEX_TOOL_UPDATE: &str = r#"{"ts_ms":8953,"dir":"agent->client","msg":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"019fdc04-2749-7ee3-850b-047868e16fc9","update":{"sessionUpdate":"tool_call_update","toolCallId":"exec-d860f35a-092f-4736-818a-7714c5fba53d","status":"completed","rawOutput":{"formatted_output":"/private/tmp/claude-501/-Users-kara-Projects-EclosionTech-pear-cloud/867f5aca-b6af-48fe-98ae-372e5fffb7a6/scratchpad/acp-live-codex\nPear Bridge is a native daemon giving Pear AI users governed access to a local shell.\nThe harness feature runs headless coding agents through it.\n","exit_code":0},"_meta":{"terminal_output_delta":{"data":"/private/tmp/claude-501/-Users-kara-Projects-EclosionTech-pear-cloud/867f5aca-b6af-48fe-98ae-372e5fffb7a6/scratchpad/acp-live-codex\nPear Bridge is a native daemon giving Pear AI users governed access to a local shell.\nThe harness feature runs headless coding agents through it.\n","terminal_id":"exec-d860f35a-092f-4736-818a-7714c5fba53d"},"terminal_exit":{"exit_code":0,"signal":null,"terminal_id":"exec-d860f35a-092f-4736-818a-7714c5fba53d"}}}}}}"#;
    const CODEX_DIFF: &str = r#"{"ts_ms":12403,"dir":"agent->client","msg":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"019fdc04-2749-7ee3-850b-047868e16fc9","update":{"sessionUpdate":"tool_call","toolCallId":"exec-0b60c707-84ab-4214-b69b-96f4aaec740b","title":"Editing files","kind":"edit","status":"in_progress","content":[{"type":"diff","oldText":null,"newText":"Pear Bridge is a native daemon that gives Pear AI users governed local-shell access and supports running headless coding agents through its harness.\n","path":"/private/tmp/claude-501/-Users-kara-Projects-EclosionTech-pear-cloud/867f5aca-b6af-48fe-98ae-372e5fffb7a6/scratchpad/acp-live-codex/summary.txt","_meta":{"kind":"add"}}]}}}}"#;

    fn translate(translator: &mut UpdateTranslator, line: &str) -> ChunkEnvelope {
        let fixture: Value = serde_json::from_str(line).unwrap();
        let message = &fixture["msg"];
        translator.translate_message(message).unwrap().unwrap()
    }

    #[test]
    fn real_text_and_thought_updates_keep_v1_envelopes() {
        let mut translator = UpdateTranslator::default();
        assert_eq!(
            serde_json::to_string(&translate(&mut translator, CLAUDE_TEXT)).unwrap(),
            r#"{"t":"text","d":"Done"}"#
        );
        assert_eq!(
            serde_json::to_string(&translate(&mut translator, CODEX_THOUGHT)).unwrap(),
            r#"{"t":"think","d":"**Writing patch summary for Pear Bridge daemon**"}"#
        );
    }

    #[test]
    fn real_tool_updates_emit_separately_with_merged_stable_fields() {
        let mut translator = UpdateTranslator::default();
        let started = translate(&mut translator, CODEX_TOOL);
        let completed = translate(&mut translator, CODEX_TOOL_UPDATE);
        let started = serde_json::to_value(started).unwrap();
        let completed = serde_json::to_value(completed).unwrap();
        assert_eq!(started["tc"]["status"], "in_progress");
        assert_eq!(completed["tc"]["status"], "completed");
        assert_eq!(started["tc"]["id"], completed["tc"]["id"]);
        assert_eq!(completed["tc"]["kind"], "execute");
        assert!(completed["tc"]["title"]
            .as_str()
            .unwrap()
            .starts_with("pwd &&"));
        assert_eq!(
            completed["tc"]["terminalId"],
            "exec-d860f35a-092f-4736-818a-7714c5fba53d"
        );
    }

    #[test]
    fn real_diff_update_maps_structured_diff() {
        let mut translator = UpdateTranslator::default();
        let value = serde_json::to_value(translate(&mut translator, CODEX_DIFF)).unwrap();
        assert!(value["tc"]["diffs"][0]["path"]
            .as_str()
            .unwrap()
            .ends_with("/acp-live-codex/summary.txt"));
        assert!(value["tc"]["diffs"][0]["oldText"].is_null());
        assert_eq!(
            value["tc"]["diffs"][0]["newText"],
            "Pear Bridge is a native daemon that gives Pear AI users governed local-shell access and supports running headless coding agents through its harness.\n"
        );
    }

    #[test]
    fn structured_chunks_never_serialize_a_legacy_d_key() {
        let mut translator = UpdateTranslator::default();
        let tool = serde_json::to_value(translate(&mut translator, CODEX_DIFF)).unwrap();
        // Phase 0 produced no plan update, so this one follows the ACP v1
        // schema while the other translation fixtures remain exact captures.
        let plan_message = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "session",
                "update": {
                    "sessionUpdate": "plan",
                    "entries": [{
                        "content": "Inspect fixtures",
                        "priority": "high",
                        "status": "pending"
                    }]
                }
            }
        });
        let plan = translator
            .translate_message(&plan_message)
            .unwrap()
            .unwrap();
        let plan = serde_json::to_value(plan).unwrap();
        assert_eq!(plan["entries"][0]["content"], "Inspect fixtures");
        for structured in [tool, plan] {
            assert!(structured.get("d").is_none(), "{structured}");
        }
    }

    #[test]
    fn provider_commands_use_verified_adapter_defaults() {
        assert_eq!(
            agent_command_setting("claude-code").unwrap(),
            ("PEAR_BRIDGE_ACP_CLAUDE_CMD", CLAUDE_COMMAND)
        );
        assert_eq!(
            agent_command_setting("claude").unwrap(),
            ("PEAR_BRIDGE_ACP_CLAUDE_CMD", CLAUDE_COMMAND)
        );
        assert_eq!(
            agent_command_setting("codex").unwrap(),
            ("PEAR_BRIDGE_ACP_CODEX_CMD", CODEX_COMMAND)
        );
        let claude = parse_agent_command(CLAUDE_COMMAND).unwrap();
        assert_eq!(claude.command(), Path::new("npx"));
        assert_eq!(
            claude.arguments(),
            ["-y", "@agentclientprotocol/claude-agent-acp"]
        );
        let codex = parse_agent_command(CODEX_COMMAND).unwrap();
        assert_eq!(codex.command(), Path::new("npx"));
        assert_eq!(codex.arguments(), ["-y", "@agentclientprotocol/codex-acp"]);
        assert!(supports_provider("claude-code"));
        assert!(supports_provider("claude"));
        assert!(supports_provider("codex"));
        assert!(!supports_provider("ollama"));
    }

    #[test]
    fn unsafe_permission_modes_are_refused() {
        assert!(permission_mode("claude", "bypassPermissions")
            .unwrap_err()
            .contains("bypassPermissions"));
        assert!(permission_mode("codex", "agent-full-access")
            .unwrap_err()
            .contains("agent-full-access"));
        assert_eq!(permission_mode("codex", "acceptEdits").unwrap(), "agent");
        assert_eq!(permission_mode("codex", "plan").unwrap(), "read-only");
    }

    #[test]
    fn session_map_round_trips() {
        let dir = std::env::temp_dir().join(format!(
            "pear-bridge-acp-session-map-{}",
            std::process::id()
        ));
        let path = dir.join("sessions.json");
        let _ = fs::remove_dir_all(&dir);
        let mut map = SessionMap::default();
        map.insert("worker-session", "agent-session");
        map.save(&path).unwrap();
        let loaded = SessionMap::load(&path).unwrap();
        assert_eq!(loaded.get("worker-session"), Some("agent-session"));

        // A turn holding an older snapshot must not erase another turn's entry.
        let mut concurrent = SessionMap::default();
        concurrent.insert("other-session", "other-agent-session");
        concurrent.save(&path).unwrap();
        let merged = SessionMap::load(&path).unwrap();
        assert_eq!(merged.get("worker-session"), Some("agent-session"));
        assert_eq!(merged.get("other-session"), Some("other-agent-session"));

        fs::remove_dir_all(dir).unwrap();
    }

    fn all_options() -> Value {
        json!({
            "toolCall": {"toolCallId": "call-1", "title": "Write outside workspace"},
            "options": [
                {"kind": "allow_always", "optionId": "always", "name": "Always allow"},
                {"kind": "allow_once", "optionId": "allow", "name": "Allow once"},
                {"kind": "reject_once", "optionId": "reject", "name": "Reject"}
            ]
        })
    }

    /// Without a relay approval port, the unattended default must deny.
    /// Auto-allowing would be strictly wider than the legacy CLI path.
    #[test]
    fn permission_denies_by_default() {
        temp_env_var("PEAR_BRIDGE_ACP_AUTO_APPROVE", None, || {
            let params = all_options();
            let result = permission_result(Some(&params)).unwrap();
            assert_eq!(result["outcome"]["outcome"], "selected");
            assert_eq!(result["outcome"]["optionId"], "reject");
        });
    }

    /// `allow_always` is a session-scoped mode escalation on the Claude
    /// adapter — never selectable by an unattended policy, even opted in.
    #[test]
    fn permission_opt_in_selects_allow_once_never_always() {
        temp_env_var("PEAR_BRIDGE_ACP_AUTO_APPROVE", Some("1"), || {
            let params = all_options();
            let result = permission_result(Some(&params)).unwrap();
            assert_eq!(result["outcome"]["optionId"], "allow");

            // Only allow_always on offer → cancel rather than escalate.
            let escalation_only = json!({
                "options": [{"kind": "allow_always", "optionId": "always"}]
            });
            let result = permission_result(Some(&escalation_only)).unwrap();
            assert_eq!(result["outcome"]["outcome"], "cancelled");
        });
    }

    #[test]
    fn permission_without_matching_option_cancels() {
        temp_env_var("PEAR_BRIDGE_ACP_AUTO_APPROVE", None, || {
            let params = json!({"options": [{"kind": "allow_always", "optionId": "always"}]});
            let result = permission_result(Some(&params)).unwrap();
            assert_eq!(result["outcome"]["outcome"], "cancelled");
        });
    }

    #[test]
    fn permission_chunk_records_decision_without_d_field() {
        temp_env_var("PEAR_BRIDGE_ACP_AUTO_APPROVE", None, || {
            let params = all_options();
            let result = permission_result(Some(&params)).unwrap();
            let decision = permission_result_label(Some(&params), &result);
            let chunk = permission_chunk(Some(&params), &decision);
            let json = serde_json::to_value(&chunk).unwrap();
            assert_eq!(json["t"], "perm");
            assert_eq!(json["perm"]["decision"], "denied");
            assert_eq!(json["perm"]["toolCallId"], "call-1");
            assert!(
                json.get("d").is_none(),
                "structured chunks must omit `d` so deployed workers skip them"
            );
        });
    }

    #[tokio::test(start_paused = true)]
    async fn permission_request_timeout_denies_without_waiting_in_real_time() {
        let params = all_options();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let port = ApprovalPort::new(41, tx);
        let resolution = resolve_permission_with(
            Some(&params),
            Some(&port),
            false,
            Duration::from_secs(DEFAULT_APPROVAL_TIMEOUT_SECS),
        );
        tokio::pin!(resolution);

        // Keep the transport-owned responder alive but deliberately never
        // complete it. Tokio's paused clock advances directly to the deadline.
        let request = tokio::select! {
            request = rx.recv() => request.expect("approval request channel closed"),
            result = &mut resolution => panic!("permission resolved before request: {}", result.unwrap().decision),
        };
        assert_eq!(request.request_id, "41-1");
        let resolution = resolution.await.unwrap();
        assert_eq!(resolution.result["outcome"]["outcome"], "selected");
        assert_eq!(resolution.result["outcome"]["optionId"], "reject");
        assert_eq!(resolution.decision, "timeout");

        let chunk =
            serde_json::to_value(permission_chunk(Some(&params), &resolution.decision)).unwrap();
        assert_eq!(chunk["perm"]["decision"], "timeout");
        assert!(chunk.get("d").is_none());
        drop(request);
    }

    #[tokio::test]
    async fn closed_approval_channel_denies_instead_of_failing_the_turn() {
        let params = all_options();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        drop(rx);
        let port = ApprovalPort::new(43, tx);
        let resolution = resolve_permission_with(
            Some(&params),
            Some(&port),
            false,
            Duration::from_secs(DEFAULT_APPROVAL_TIMEOUT_SECS),
        )
        .await
        .unwrap();
        assert_eq!(resolution.result["outcome"]["outcome"], "selected");
        assert_eq!(resolution.result["outcome"]["optionId"], "reject");
        assert_eq!(resolution.decision, "unavailable");
    }

    #[tokio::test]
    async fn human_decision_may_select_allow_always() {
        let params = all_options();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let port = ApprovalPort::new(42, tx);
        let resolution = resolve_permission_with(
            Some(&params),
            Some(&port),
            false,
            Duration::from_secs(DEFAULT_APPROVAL_TIMEOUT_SECS),
        );
        tokio::pin!(resolution);

        let request = tokio::select! {
            request = rx.recv() => request.expect("approval request channel closed"),
            result = &mut resolution => panic!("permission resolved before request: {}", result.unwrap().decision),
        };
        request
            .responder
            .send(ApprovalDecision {
                outcome: "selected".to_string(),
                option_id: Some("always".to_string()),
            })
            .unwrap();
        let resolution = resolution.await.unwrap();
        assert_eq!(resolution.result["outcome"]["optionId"], "always");
        assert_eq!(resolution.decision, "allowed");
    }

    /// End-to-end against the real Claude adapter. Ignored by default: it needs
    /// network, an ambient Claude login, and ~30s. Run deliberately with
    /// `cargo test -p pear-bridge acp_live -- --ignored --nocapture` after
    /// touching the protocol pump or the session map.
    #[tokio::test]
    #[ignore = "spawns the real npx ACP adapter; requires network and login"]
    async fn acp_live_turn_streams_and_resumes() {
        let root =
            std::env::temp_dir().join(format!("pear-bridge-acp-live-{}", std::process::id()));
        let cwd = root.join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        fs::write(cwd.join("marker.txt"), "the codeword is ELDERBERRY\n").unwrap();
        // Redirect the session map into the temp root instead of the real
        // bridge config directory.
        std::env::set_var("XDG_CONFIG_HOME", root.join("config"));

        let extra_env = BTreeMap::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let session_id = "6f1d5a3e-3f1a-4d2b-8c7e-9a0b1c2d3e4f";
        let first = run_turn(TurnRequest {
            provider: "claude-code",
            worker_session_id: session_id,
            prompt: "Read marker.txt and reply with only the codeword it contains.",
            cwd: &cwd,
            mode: Some("default"),
            timeout: Duration::from_secs(180),
            chunks: Some(tx),
            extra_env: &extra_env,
        })
        .await
        .expect("first ACP turn failed");

        assert!(
            !first.resumed,
            "a fresh worker session must not report resumed"
        );
        assert!(
            first.output.to_uppercase().contains("ELDERBERRY"),
            "agent did not read the file: {}",
            first.output
        );

        let mut kinds = Vec::new();
        while let Ok(chunk) = rx.try_recv() {
            let value: Value = serde_json::from_str(&chunk.content).unwrap();
            kinds.push(value["t"].as_str().unwrap().to_string());
        }
        assert!(
            kinds.iter().any(|k| k == "text"),
            "no text chunks: {kinds:?}"
        );
        assert!(
            kinds.iter().any(|k| k == "tool"),
            "reading a file must surface a structured tool chunk: {kinds:?}"
        );

        // Second turn on the same worker session id must load the stored ACP
        // session and answer from context alone.
        let (tx2, _rx2) = tokio::sync::mpsc::unbounded_channel();
        let second = run_turn(TurnRequest {
            provider: "claude-code",
            worker_session_id: session_id,
            prompt: "Without reading any file, repeat the codeword you just told me.",
            cwd: &cwd,
            mode: Some("default"),
            timeout: Duration::from_secs(180),
            chunks: Some(tx2),
            extra_env: &extra_env,
        })
        .await
        .expect("second ACP turn failed");

        assert!(second.resumed, "second turn must resume the mapped session");
        assert!(
            second.output.to_uppercase().contains("ELDERBERRY"),
            "resumed session lost context: {}",
            second.output
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// Env mutation is process-global; serialize it behind a mutex so parallel
    /// tests cannot observe each other's override. `None` asserts the variable
    /// is absent for the body — the default-deny test must not inherit another
    /// test's opt-in.
    fn temp_env_var(key: &str, value: Option<&str>, body: impl FnOnce()) {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = std::env::var(key).ok();
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
        match previous {
            Some(previous) => std::env::set_var(key, previous),
            None => std::env::remove_var(key),
        }
        if let Err(payload) = result {
            std::panic::resume_unwind(payload);
        }
    }
}
