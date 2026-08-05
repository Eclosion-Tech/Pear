//! Provider adapters for `kind = "inference"` bridge commands: one-shot
//! inference through CLIs / daemons already present on this device —
//! `claude -p` (Claude subscription), `codex exec`, and the ollama HTTP API.
//!
//! Deliberately NOT the bash path:
//! * no PTY — plain piped stdio; the prompt travels via **stdin** (argv would
//!   hit ARG_MAX on large contexts) and output is captured raw (no ANSI
//!   stripping, no 24x80 assumptions);
//! * no allowlist — the binary + argument template are fixed here, nothing
//!   user-controlled is interpreted by a shell;
//! * no sandbox — these CLIs need their own auth (`~/.claude`, `~/.codex`) and
//!   the network, which the bash jail denies by design. Confinement for
//!   inference is the fixed argv, not a filesystem jail;
//! * its own per-request timeout — bash's connection-wide `max_runtime` (120s
//!   default) is far too short for local models.
//!
//! Test/override seams (checked per call, like `PEAR_BRIDGE_NO_SANDBOX`):
//! `PEAR_BRIDGE_CLAUDE_BIN`, `PEAR_BRIDGE_CODEX_BIN`, `PEAR_BRIDGE_OLLAMA_URL`.

use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Default / maximum wall-clock budget for one inference run. Local models on
/// laptop hardware are slow; callers can ask for less (or more, up to the cap)
/// via `timeout_seconds` in the payload.
pub const DEFAULT_TIMEOUT_SECS: u64 = 240;
pub const MAX_TIMEOUT_SECS: u64 = 600;
/// Cap on captured provider output (chars kept; the tail is dropped with a
/// marker). Inference answers are text — 512 KiB is generous.
pub const MAX_OUTPUT_BYTES: usize = 512 * 1024;

const DETECT_TIMEOUT: Duration = Duration::from_secs(10);
const OLLAMA_TAGS_TIMEOUT: Duration = Duration::from_secs(3);

/// Provider slugs (also the `BridgeDeviceCapability.provider` values).
pub const PROVIDER_CLAUDE: &str = "claude-code";
pub const PROVIDER_CODEX: &str = "codex";
pub const PROVIDER_OLLAMA: &str = "ollama";

fn claude_bin() -> String {
    std::env::var("PEAR_BRIDGE_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string())
}

fn codex_bin() -> String {
    std::env::var("PEAR_BRIDGE_CODEX_BIN").unwrap_or_else(|_| "codex".to_string())
}

fn ollama_url() -> String {
    std::env::var("PEAR_BRIDGE_OLLAMA_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:11434".to_string())
}

/// The `payload_json` body of an inference command (written by the worker's
/// `tool_infer` / bridge-inference provider, validated for size by the
/// `enqueue_bridge_inference` reducer). Exactly ONE of `prompt` (v1, plain
/// one-shot) or `chat` (v2, structured chat with tool calling — ollama only)
/// must be present. A `chat` payload against a pre-v2 daemon fails to parse
/// (`prompt` was required) → an honest `ok:false` rather than a silently
/// degraded flattened run that would break the tool loop mid-turn.
#[derive(Clone, Debug, Deserialize)]
pub struct InferencePayload {
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub chat: Option<ChatPayload>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

/// Structured chat for tool-calling inference. `messages` and `tools` are
/// deliberately OPAQUE JSON: the daemon forwards them verbatim into ollama's
/// `/api/chat` body, so evolving message/tool shapes are a worker↔ollama
/// contract that never requires a daemon rebuild.
#[derive(Clone, Debug, Deserialize)]
pub struct ChatPayload {
    pub messages: serde_json::Value,
    #[serde(default)]
    pub tools: Option<serde_json::Value>,
}

/// One tool call the model requested (ollama `message.tool_calls[].function`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCallOut {
    pub name: String,
    pub arguments: serde_json::Value,
}

/// The JSON envelope returned in the result frame's `stdout`. The worker parses
/// this; `ok:false` + `error` is a *transport-honest* failure (the model did
/// not answer), never fabricated output.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InferenceResult {
    pub ok: bool,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub output: String,
    /// Tool calls the model requested (structured-chat runs only). The worker
    /// maps these back to tool_use blocks and continues its conversation loop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallOut>>,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl InferenceResult {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|e| {
            format!("{{\"ok\":false,\"provider\":\"\",\"output\":\"\",\"duration_ms\":0,\"error\":\"result serialization failed: {e}\"}}")
        })
    }

    fn failure(provider: &str, model: Option<String>, started: Instant, error: String) -> Self {
        InferenceResult {
            ok: false,
            provider: provider.to_string(),
            model,
            output: String::new(),
            tool_calls: None,
            duration_ms: started.elapsed().as_millis() as u64,
            error: Some(error),
        }
    }
}

/// One detected provider, as reported to the server (`report_bridge_device_capability`)
/// and serialized into the relay `capabilities` frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderCapability {
    pub provider: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
}

/// Entry point used by [`crate::daemon::process_incoming`]: parse the payload
/// and run it, mapping every failure mode into an `ok:false` envelope (the
/// transport always gets a well-formed result to report).
pub async fn run_inference_json(payload_json: Option<&str>) -> InferenceResult {
    let started = Instant::now();
    let raw = match payload_json {
        Some(r) if !r.trim().is_empty() => r,
        _ => {
            return InferenceResult::failure(
                "",
                None,
                started,
                "inference command carried no payload_json".to_string(),
            )
        }
    };
    let payload: InferencePayload = match serde_json::from_str(raw) {
        Ok(p) => p,
        Err(e) => {
            return InferenceResult::failure(
                "",
                None,
                started,
                format!("invalid inference payload: {e}"),
            )
        }
    };
    run_inference(&payload).await
}

/// Run one inference request through the named provider.
pub async fn run_inference(payload: &InferencePayload) -> InferenceResult {
    let started = Instant::now();
    let timeout = Duration::from_secs(
        payload
            .timeout_seconds
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );
    let provider = payload.provider.trim();
    if payload.prompt.is_none() && payload.chat.is_none() {
        return InferenceResult::failure(
            provider,
            payload.model.clone(),
            started,
            "inference payload needs either \"prompt\" or \"chat\"".to_string(),
        );
    }
    if payload.prompt.is_some() && payload.chat.is_some() {
        return InferenceResult::failure(
            provider,
            payload.model.clone(),
            started,
            "inference payload must carry exactly one of \"prompt\" or \"chat\", not both".to_string(),
        );
    }
    let run = match provider {
        PROVIDER_CLAUDE | "claude" => run_claude(payload, timeout).await,
        PROVIDER_CODEX => run_codex(payload, timeout).await,
        PROVIDER_OLLAMA => run_ollama(payload, timeout).await,
        other => Err(format!(
            "unknown inference provider \"{other}\" (supported: {PROVIDER_CLAUDE}, {PROVIDER_CODEX}, {PROVIDER_OLLAMA})"
        )),
    };
    match run {
        Ok((output, tool_calls)) => InferenceResult {
            ok: true,
            provider: provider.to_string(),
            model: payload.model.clone(),
            output: cap_output(output),
            tool_calls,
            duration_ms: started.elapsed().as_millis() as u64,
            error: None,
        },
        Err(e) => InferenceResult::failure(provider, payload.model.clone(), started, e),
    }
}

/// The message a claude/codex adapter returns when handed a structured-chat
/// payload: those CLIs are agents, not completion endpoints — their tool story
/// is device-side harness sessions (ticket 14443), not worker-side tool loops.
fn no_structured_chat(provider: &str) -> String {
    format!(
        "provider \"{provider}\" does not support structured chat (tool calling) over the bridge — \
         bind an ollama model for tool use, or use plain prompt inference"
    )
}

fn require_prompt(payload: &InferencePayload) -> Result<&str, String> {
    payload
        .prompt
        .as_deref()
        .ok_or_else(|| "payload has no \"prompt\"".to_string())
}

fn cap_output(mut s: String) -> String {
    if s.len() > MAX_OUTPUT_BYTES {
        let mut cut = MAX_OUTPUT_BYTES;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n[output truncated]");
    }
    s
}

/// How a provider CLI run failed — lets the harness distinguish "this session
/// id is unknown on this device" (retry as a new session) from real failures.
#[derive(Debug)]
pub enum ProviderExecError {
    UnknownSession,
    Other(String),
}

impl ProviderExecError {
    pub fn into_message(self) -> String {
        match self {
            ProviderExecError::UnknownSession => "session not found on device".to_string(),
            ProviderExecError::Other(m) => m,
        }
    }
}

/// Spawn a provider CLI with the prompt piped to stdin, capture stdout/stderr,
/// enforce the timeout (the child is killed on expiry via `kill_on_drop`).
/// Inference callers pass the OS temp dir so one-shot runs can't pick up
/// project context (CLAUDE.md / AGENTS.md); harness turns pass their
/// jail-checked project directory — there the context is the point.
pub(crate) async fn run_cli(
    bin: &str,
    args: &[String],
    stdin_body: &str,
    timeout: Duration,
    cwd: &std::path::Path,
) -> Result<std::process::Output, String> {
    let mut child = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to launch {bin}: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(stdin_body.as_bytes())
            .await
            .map_err(|e| format!("failed to write prompt to {bin} stdin: {e}"))?;
        // Drop closes the pipe → the CLI sees EOF and starts.
    }

    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(format!("{bin} failed: {e}")),
        Err(_) => Err(format!(
            "{bin} timed out after {}s and was killed",
            timeout.as_secs()
        )),
    }
}

fn stderr_excerpt(output: &std::process::Output) -> String {
    let s = String::from_utf8_lossy(&output.stderr);
    let s = s.trim();
    if s.len() > 500 {
        let mut cut = 500;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}…", &s[..cut])
    } else {
        s.to_string()
    }
}

/// `claude -p --output-format json --tools ""` — pure tool-less one-shot
/// inference against the user's Claude Code auth. The JSON envelope's `result`
/// field is the answer; on parse failure the raw stdout is returned as-is.
async fn run_claude(
    payload: &InferencePayload,
    timeout: Duration,
) -> Result<(String, Option<Vec<ToolCallOut>>), String> {
    if payload.chat.is_some() {
        return Err(no_structured_chat(PROVIDER_CLAUDE));
    }
    let prompt = require_prompt(payload)?;
    let bin = claude_bin();
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "json".into(),
        "--tools".into(),
        String::new(),
    ];
    if let Some(model) = payload.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(model.to_string());
    }
    if let Some(system) = payload.system.as_deref().filter(|s| !s.is_empty()) {
        args.push("--append-system-prompt".into());
        args.push(system.to_string());
    }
    let output = run_cli(&bin, &args, prompt, timeout, &std::env::temp_dir()).await?;
    if !output.status.success() {
        return Err(format!(
            "claude exited with {}: {}",
            output.status,
            stderr_excerpt(&output)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    // Envelope: {"type":"result","subtype":"success","is_error":false,"result":"…",…}
    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(v) => {
            if v.get("is_error").and_then(|b| b.as_bool()) == Some(true) {
                let msg = v
                    .get("result")
                    .and_then(|r| r.as_str())
                    .unwrap_or("claude reported an error");
                Err(format!("claude error: {msg}"))
            } else if let Some(result) = v.get("result").and_then(|r| r.as_str()) {
                Ok((result.to_string(), None))
            } else {
                Ok((stdout, None))
            }
        }
        Err(_) => Ok((stdout, None)),
    }
}

/// `codex exec --ephemeral --skip-git-repo-check -` — prompt via stdin, final
/// answer on stdout. Codex has no separate system flag for `exec`; a `system`
/// block is prepended to the prompt.
async fn run_codex(
    payload: &InferencePayload,
    timeout: Duration,
) -> Result<(String, Option<Vec<ToolCallOut>>), String> {
    if payload.chat.is_some() {
        return Err(no_structured_chat(PROVIDER_CODEX));
    }
    let prompt = require_prompt(payload)?;
    let bin = codex_bin();
    let mut args: Vec<String> = vec![
        "exec".into(),
        "--ephemeral".into(),
        "--skip-git-repo-check".into(),
        "--color".into(),
        "never".into(),
    ];
    if let Some(model) = payload.model.as_deref().filter(|m| !m.is_empty()) {
        args.push("-m".into());
        args.push(model.to_string());
    }
    args.push("-".into());
    let body = match payload.system.as_deref().filter(|s| !s.is_empty()) {
        Some(system) => format!("{system}\n\n{prompt}"),
        None => prompt.to_string(),
    };
    let output = run_cli(&bin, &args, &body, timeout, &std::env::temp_dir()).await?;
    if !output.status.success() {
        return Err(format!(
            "codex exited with {}: {}",
            output.status,
            stderr_excerpt(&output)
        ));
    }
    Ok((String::from_utf8_lossy(&output.stdout).trim().to_string(), None))
}

/// Ollama via its local HTTP API — cleaner contract than wrapping the CLI, and
/// gives us the model list for free at detection time. Requires an explicit
/// `model`. Two modes: v1 `prompt` → `/api/generate`; v2 `chat` (structured
/// messages + tools, forwarded VERBATIM) → `/api/chat`, with any
/// `message.tool_calls` mapped into the result envelope so the worker's
/// conversation loop can keep orchestrating Pear tools.
async fn run_ollama(
    payload: &InferencePayload,
    timeout: Duration,
) -> Result<(String, Option<Vec<ToolCallOut>>), String> {
    let model = payload
        .model
        .as_deref()
        .filter(|m| !m.is_empty())
        .ok_or("ollama requires an explicit model (see the device's capability row for the installed list)")?;
    let base = ollama_url();
    let client = reqwest::Client::new();

    let (endpoint, body) = match &payload.chat {
        Some(chat) => {
            let mut body = serde_json::json!({
                "model": model,
                "messages": chat.messages,
                "stream": false,
            });
            if let Some(tools) = &chat.tools {
                body["tools"] = tools.clone();
            }
            ("/api/chat", body)
        }
        None => {
            let prompt = require_prompt(payload)?;
            let mut body = serde_json::json!({
                "model": model,
                "prompt": prompt,
                "stream": false,
            });
            if let Some(system) = payload.system.as_deref().filter(|s| !s.is_empty()) {
                body["system"] = serde_json::Value::String(system.to_string());
            }
            ("/api/generate", body)
        }
    };

    let resp = client
        .post(format!("{base}{endpoint}"))
        .json(&body)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("ollama request failed (is the ollama daemon running?): {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("failed to read ollama response: {e}"))?;
    if !status.is_success() {
        return Err(format!("ollama returned {status}: {text}"));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("invalid ollama response JSON: {e}"))?;

    if payload.chat.is_some() {
        // /api/chat: {"message":{"role":"assistant","content":"…","tool_calls":
        // [{"function":{"name":"…","arguments":{…}}}]},"done":true,…}
        let message = v
            .get("message")
            .ok_or("ollama chat response had no \"message\" field")?;
        let content = message
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        let tool_calls = message
            .get("tool_calls")
            .and_then(|t| t.as_array())
            .map(|calls| {
                calls
                    .iter()
                    .filter_map(|c| {
                        let f = c.get("function")?;
                        Some(ToolCallOut {
                            name: f.get("name")?.as_str()?.to_string(),
                            arguments: f
                                .get("arguments")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|calls| !calls.is_empty());
        Ok((content, tool_calls))
    } else {
        v.get("response")
            .and_then(|r| r.as_str())
            .map(|s| (s.to_string(), None))
            .ok_or_else(|| "ollama response had no \"response\" field".to_string())
    }
}

/// Detect which providers this device can serve. Presence-based for the CLIs
/// (`--version` succeeds ⇒ installed; auth problems surface at run time as
/// honest `ok:false` results); the ollama row distinguishes *installed but
/// daemon down* (`available:false`) from *serving* (`available:true` + models).
/// Providers that are simply absent produce no row at all.
pub async fn detect_capabilities() -> Vec<ProviderCapability> {
    let (claude, codex, ollama) = tokio::join!(
        detect_cli(PROVIDER_CLAUDE, claude_bin()),
        detect_cli(PROVIDER_CODEX, codex_bin()),
        detect_ollama()
    );
    [claude, codex, ollama].into_iter().flatten().collect()
}

async fn detect_cli(provider: &str, bin: String) -> Option<ProviderCapability> {
    let run = Command::new(&bin)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(DETECT_TIMEOUT, run).await {
        Ok(Ok(output)) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty());
            Some(ProviderCapability {
                provider: provider.to_string(),
                available: true,
                version,
                models: None,
            })
        }
        // Spawn error (not installed), non-zero exit, or hung --version: no row.
        _ => None,
    }
}

async fn detect_ollama() -> Option<ProviderCapability> {
    let base = ollama_url();
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{base}/api/tags"))
        .timeout(OLLAMA_TAGS_TIMEOUT)
        .send()
        .await;
    match resp {
        Ok(resp) if resp.status().is_success() => {
            let models = resp
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| {
                    v.get("models").and_then(|m| m.as_array()).map(|arr| {
                        arr.iter()
                            .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
                            .map(|s| s.to_string())
                            .collect::<Vec<_>>()
                    })
                })
                .filter(|m: &Vec<String>| !m.is_empty());
            Some(ProviderCapability {
                provider: PROVIDER_OLLAMA.to_string(),
                available: true,
                version: None,
                models,
            })
        }
        // API unreachable: report installed-but-down only if the CLI exists,
        // so a machine without ollama produces no row at all.
        _ => {
            let cli = detect_cli(PROVIDER_OLLAMA, "ollama".to_string()).await;
            cli.map(|c| ProviderCapability {
                available: false,
                ..c
            })
        }
    }
}
