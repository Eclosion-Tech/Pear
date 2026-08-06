//! Harness sessions (`kind = "harness"`, ticket 14443): full agent turns
//! through a resumable Claude Code session bound to a Pear conversation.
//!
//! Unlike inference (`providers.rs`), the harness runs with **tools enabled**
//! in a real project directory — that is the point: local bash/edit/read
//! against the bound working tree, with Claude Code's own session state
//! carrying context between turns (`--resume <session-id>`).
//!
//! Containment model (v1, documented honestly):
//! * the working directory MUST resolve inside the device's
//!   `allowed_directories` (same jail semantics as bash commands);
//! * inside the session, Claude Code's own permission system governs tools —
//!   `permission_mode` defaults to `acceptEdits` and `bypassPermissions` is
//!   REFUSED here (that would disable the only in-session gate);
//! * no OS sandbox — the harness needs its auth, the network, and the project
//!   tree. The AwaitingConfirmation approvals phase layers on later (14443 §3).
//!
//! Session identity: the worker derives a stable UUID per (AI user,
//! conversation) and always sends it. The daemon first tries `--resume <id>`;
//! if Claude reports the session unknown (fresh device, pruned state), it
//! falls back to `--session-id <id>` to START the session under that same id,
//! and reports `resumed: false` so the caller knows continuity was reset.

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::providers::{flush_pending, run_cli, ChunkSender, ProviderExecError};

/// Default / maximum wall-clock budget for one harness turn. Agent turns are
/// long — they may run builds and tests.
pub const DEFAULT_TIMEOUT_SECS: u64 = 600;
pub const MAX_TIMEOUT_SECS: u64 = 1800;
/// Cap on the answer text carried back in the envelope.
pub const MAX_OUTPUT_BYTES: usize = 512 * 1024;

const PERMISSION_MODES: [&str; 3] = ["default", "acceptEdits", "plan"];

fn claude_bin() -> String {
    std::env::var("PEAR_BRIDGE_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string())
}

/// The `payload_json` body of a harness command.
#[derive(Clone, Debug, Deserialize)]
pub struct HarnessPayload {
    pub provider: String,
    /// Stable per-conversation session UUID (worker-derived).
    pub session_id: String,
    /// The user's latest message — Claude Code holds the prior turns itself.
    pub prompt: String,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Claude Code permission mode: "default" | "acceptEdits" | "plan".
    /// Defaults to "acceptEdits". "bypassPermissions" is refused.
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Optional explicit tool allowlist (Claude Code `--allowedTools` syntax).
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    /// Stream the turn's transcript as chunk deltas (claude stream-json →
    /// `{"t":"text"|"think","d":…}` envelopes). Absent on older workers →
    /// batch mode, unchanged envelope.
    #[serde(default)]
    pub stream: Option<bool>,
}

/// The JSON envelope returned in the result frame's `stdout`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HarnessResult {
    pub ok: bool,
    pub provider: String,
    pub session_id: String,
    /// True when the turn continued an existing session; false when the
    /// session had to be started fresh (context did not carry over).
    pub resumed: bool,
    pub output: String,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl HarnessResult {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|e| {
            format!("{{\"ok\":false,\"provider\":\"\",\"session_id\":\"\",\"resumed\":false,\"output\":\"\",\"duration_ms\":0,\"error\":\"result serialization failed: {e}\"}}")
        })
    }

    fn failure(provider: &str, session_id: &str, started: Instant, error: String) -> Self {
        HarnessResult {
            ok: false,
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            resumed: false,
            output: String::new(),
            duration_ms: started.elapsed().as_millis() as u64,
            error: Some(error),
        }
    }
}

/// Entry point used by [`crate::daemon::process_incoming`]. Every failure mode
/// maps to an `ok:false` envelope so the transport always reports something
/// well-formed.
pub async fn run_harness_json(
    payload_json: Option<&str>,
    allowed_dirs: &[PathBuf],
    chunks: Option<ChunkSender>,
) -> HarnessResult {
    let started = Instant::now();
    let raw = match payload_json {
        Some(r) if !r.trim().is_empty() => r,
        _ => {
            return HarnessResult::failure(
                "",
                "",
                started,
                "harness command carried no payload_json".to_string(),
            )
        }
    };
    let payload: HarnessPayload = match serde_json::from_str(raw) {
        Ok(p) => p,
        Err(e) => {
            return HarnessResult::failure("", "", started, format!("invalid harness payload: {e}"))
        }
    };
    run_harness(&payload, allowed_dirs, chunks).await
}

pub async fn run_harness(
    payload: &HarnessPayload,
    allowed_dirs: &[PathBuf],
    chunks: Option<ChunkSender>,
) -> HarnessResult {
    let started = Instant::now();
    let provider = payload.provider.trim();
    let sid = payload.session_id.trim();

    if provider != "claude-code" && provider != "claude" {
        return HarnessResult::failure(
            provider,
            sid,
            started,
            format!("harness provider \"{provider}\" is not supported yet (v1: claude-code)"),
        );
    }
    if !looks_like_uuid(sid) {
        return HarnessResult::failure(
            provider,
            sid,
            started,
            "session_id must be a UUID (Claude Code --session-id requirement)".to_string(),
        );
    }
    if payload.prompt.trim().is_empty() {
        return HarnessResult::failure(provider, sid, started, "prompt is empty".to_string());
    }
    let mode = payload.permission_mode.as_deref().unwrap_or("acceptEdits");
    if !PERMISSION_MODES.contains(&mode) {
        return HarnessResult::failure(
            provider,
            sid,
            started,
            format!(
                "permission_mode \"{mode}\" is not allowed over the bridge (allowed: {}) — \
                 bypassPermissions would disable the harness's only in-session gate",
                PERMISSION_MODES.join(", ")
            ),
        );
    }
    let cwd = match resolve_cwd(payload.cwd.as_deref(), allowed_dirs) {
        Ok(dir) => dir,
        Err(e) => return HarnessResult::failure(provider, sid, started, e),
    };

    let timeout = std::time::Duration::from_secs(
        payload
            .timeout_seconds
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS),
    );

    let streaming = payload.stream == Some(true) && chunks.is_some();
    // Attempt 1: resume the existing session under this id.
    match run_claude_turn(payload, sid, mode, &cwd, timeout, true, streaming, chunks.clone()).await
    {
        Ok(output) => finish(provider, sid, started, output, true),
        Err(ProviderExecError::UnknownSession) => {
            // Fresh device / pruned session state → start the session under
            // the SAME id so future turns resume it.
            match run_claude_turn(payload, sid, mode, &cwd, timeout, false, streaming, chunks)
                .await
            {
                Ok(output) => finish(provider, sid, started, output, false),
                Err(e) => HarnessResult::failure(provider, sid, started, e.into_message()),
            }
        }
        Err(e) => HarnessResult::failure(provider, sid, started, e.into_message()),
    }
}

fn finish(
    provider: &str,
    sid: &str,
    started: Instant,
    mut output: String,
    resumed: bool,
) -> HarnessResult {
    if output.len() > MAX_OUTPUT_BYTES {
        let mut cut = MAX_OUTPUT_BYTES;
        while !output.is_char_boundary(cut) {
            cut -= 1;
        }
        output.truncate(cut);
        output.push_str("\n[output truncated]");
    }
    HarnessResult {
        ok: true,
        provider: provider.to_string(),
        session_id: sid.to_string(),
        resumed,
        output,
        duration_ms: started.elapsed().as_millis() as u64,
        error: None,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_claude_turn(
    payload: &HarnessPayload,
    sid: &str,
    mode: &str,
    cwd: &Path,
    timeout: std::time::Duration,
    resume: bool,
    streaming: bool,
    chunks: Option<ChunkSender>,
) -> Result<String, ProviderExecError> {
    let bin = claude_bin();
    let mut args: Vec<String> = vec!["-p".into(), "--output-format".into()];
    if streaming {
        // stream-json requires --verbose in print mode; partial messages give
        // real text/thinking deltas rather than whole-message events.
        args.push("stream-json".into());
        args.push("--verbose".into());
        args.push("--include-partial-messages".into());
    } else {
        args.push("json".into());
    }
    if resume {
        args.push("--resume".into());
    } else {
        args.push("--session-id".into());
    }
    args.push(sid.to_string());
    args.push("--permission-mode".into());
    args.push(mode.to_string());
    if let Some(tools) = payload.allowed_tools.as_ref().filter(|t| !t.is_empty()) {
        args.push("--allowedTools".into());
        args.push(tools.join(","));
    }

    if streaming {
        if let Some(tx) = chunks {
            return run_claude_turn_streaming(&bin, &args, &payload.prompt, timeout, cwd, resume, tx)
                .await;
        }
    }

    let output = run_cli(&bin, &args, &payload.prompt, timeout, cwd)
        .await
        .map_err(ProviderExecError::Other)?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        let combined = format!("{stdout}\n{stderr}").to_lowercase();
        // Claude's unknown-session error ("No conversation found with session
        // ID …"); only meaningful on the resume attempt.
        if resume && combined.contains("no conversation found") {
            return Err(ProviderExecError::UnknownSession);
        }
        let excerpt: String = stderr.trim().chars().take(500).collect();
        return Err(ProviderExecError::Other(format!(
            "claude exited with {}: {excerpt}",
            output.status
        )));
    }
    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(v) => {
            if v.get("is_error").and_then(|b| b.as_bool()) == Some(true) {
                let msg = v
                    .get("result")
                    .and_then(|r| r.as_str())
                    .unwrap_or("claude reported an error");
                Err(ProviderExecError::Other(format!("claude error: {msg}")))
            } else if let Some(result) = v.get("result").and_then(|r| r.as_str()) {
                Ok(result.to_string())
            } else {
                Ok(stdout)
            }
        }
        Err(_) => Ok(stdout),
    }
}

/// Streamed harness turn: spawn claude with `--output-format stream-json
/// --include-partial-messages`, forward text/thinking deltas and tool-activity
/// notes as chunk envelopes while the agent works, and return the final result
/// text. Event parsing is deliberately defensive — stream-json shapes vary
/// across claude versions; anything unrecognized is skipped, and if no
/// terminal `result` event arrives the accumulated text deltas stand in.
async fn run_claude_turn_streaming(
    bin: &str,
    args: &[String],
    prompt: &str,
    timeout: std::time::Duration,
    cwd: &Path,
    resume: bool,
    tx: ChunkSender,
) -> Result<String, ProviderExecError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let mut child = tokio::process::Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| ProviderExecError::Other(format!("failed to launch {bin}: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| ProviderExecError::Other(format!("failed to write prompt: {e}")))?;
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ProviderExecError::Other("no stdout handle".to_string()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| ProviderExecError::Other("no stderr handle".to_string()))?;

    let work = async {
        let mut lines = BufReader::new(stdout).lines();
        let mut result_text: Option<String> = None;
        let mut is_error = false;
        let mut accumulated = String::new();
        let mut seq: u32 = 0;
        let mut pending_think = String::new();
        let mut pending_text = String::new();
        let mut last_flush = Instant::now();

        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            match v.get("type").and_then(|t| t.as_str()) {
                // Partial-message deltas: real streaming text/thinking.
                Some("stream_event") => {
                    if let Some(delta) = v.pointer("/event/delta") {
                        if let Some(t) = delta.get("text").and_then(|t| t.as_str()) {
                            accumulated.push_str(t);
                            pending_text.push_str(t);
                        } else if let Some(t) = delta.get("thinking").and_then(|t| t.as_str()) {
                            pending_think.push_str(t);
                        }
                    }
                }
                // Whole assistant messages: surface tool activity as thinking
                // notes (text was already streamed via deltas above).
                Some("assistant") => {
                    if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array())
                    {
                        for block in blocks {
                            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                                if let Some(name) = block.get("name").and_then(|n| n.as_str()) {
                                    pending_think.push_str(&format!("[tool: {name}]\n"));
                                }
                            }
                        }
                    }
                }
                Some("result") => {
                    is_error = v.get("is_error").and_then(|b| b.as_bool()) == Some(true);
                    result_text = v
                        .get("result")
                        .and_then(|r| r.as_str())
                        .map(|s| s.to_string());
                }
                _ => {}
            }
            if pending_think.len() + pending_text.len() >= 256
                || (last_flush.elapsed() >= std::time::Duration::from_millis(400)
                    && (!pending_think.is_empty() || !pending_text.is_empty()))
            {
                flush_pending(&tx, &mut seq, &mut pending_think, &mut pending_text);
                last_flush = Instant::now();
            }
        }
        flush_pending(&tx, &mut seq, &mut pending_think, &mut pending_text);

        let status = child
            .wait()
            .await
            .map_err(|e| ProviderExecError::Other(format!("wait failed: {e}")))?;
        let mut err_buf = String::new();
        let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut err_buf).await;
        if !status.success() {
            let combined = format!("{err_buf}\n{accumulated}").to_lowercase();
            if resume && combined.contains("no conversation found") {
                return Err(ProviderExecError::UnknownSession);
            }
            let excerpt: String = err_buf.trim().chars().take(500).collect();
            return Err(ProviderExecError::Other(format!(
                "claude exited with {status}: {excerpt}"
            )));
        }
        if is_error {
            return Err(ProviderExecError::Other(format!(
                "claude error: {}",
                result_text.as_deref().unwrap_or("unknown")
            )));
        }
        Ok(result_text.unwrap_or(accumulated))
    };
    match tokio::time::timeout(timeout, work).await {
        Ok(r) => r,
        Err(_) => Err(ProviderExecError::Other(format!(
            "claude harness turn timed out after {}s and was killed",
            timeout.as_secs()
        ))),
    }
}

/// Resolve + jail-check the working directory: it must canonicalize to a path
/// inside one of `allowed_dirs` (which are already canonicalized by the
/// enforcer). No allowed dirs → no harness.
fn resolve_cwd(requested: Option<&str>, allowed_dirs: &[PathBuf]) -> Result<PathBuf, String> {
    if allowed_dirs.is_empty() {
        return Err(
            "this device has no allowed_directories — harness sessions need a working tree to bind"
                .to_string(),
        );
    }
    let dir = match requested.filter(|c| !c.trim().is_empty()) {
        // Bindings written in the UI commonly say `~/Projects/...` — expand
        // before canonicalizing (same reasoning as the allowlist entries).
        Some(c) => crate::allowlist::expand_tilde(c),
        None => return Ok(allowed_dirs[0].clone()),
    };
    let canonical = dir
        .canonicalize()
        .map_err(|e| format!("cwd {} does not resolve: {e}", dir.display()))?;
    if allowed_dirs.iter().any(|a| canonical.starts_with(a)) {
        Ok(canonical)
    } else {
        Err(format!(
            "cwd {} is outside this device's allowed_directories",
            canonical.display()
        ))
    }
}

fn looks_like_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}
