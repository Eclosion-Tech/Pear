//! The daemon run loop — the engine that turns the tested parts (allowlist, pty,
//! audit) into a working bridge.
//!
//! Steady state (`PEAR_BRIDGE.md` § Startup sequence):
//!   on each incoming `BridgeCommand` for this device →
//!     1. run [`crate::allowlist::AllowlistEnforcer`] (the local trust boundary),
//!     2. write the local [`crate::audit`] entry *before* executing,
//!     3. if allowed, run it in a PTY ([`crate::pty`]),
//!     4. report the [`Outcome`] back (→ `complete_bridge_command` /
//!        `reject_bridge_command`).
//!
//! The transport — *how* commands arrive and results go back — is abstracted
//! behind [`CommandSource`] / [`ResultSink`] so the engine logic is testable
//! without SpacetimeDB or a relay. The production transport (a SpacetimeDB
//! subscription proxied over the relay) implements these two traits.
//!
//! NOTE (transport, unresolved): the production [`CommandSource`] must deliver
//! only *this device's* commands. The current RLS on `bridge_command`
//! (`WHERE requested_by = :sender`) scopes rows to the enqueuing AI identity, not
//! the relay's server-side identity — so a naive subscription over the relay sees
//! nothing. Resolving that (relay-side device-scoped subscription, or a
//! device-keyed visibility rule) is a prerequisite for the real transport; it
//! does not affect this engine. See the run-loop discussion in the design doc.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::allowlist::{AllowlistEnforcer, Decision};
use crate::audit::{AuditLog, NewAuditRecord};
use crate::pty::{run_command, PtyLimits};

/// A command the daemon must execute, as received from the command bus.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IncomingCommand {
    pub command_id: u64,
    pub device_id: u64,
    pub session_id: u64,
    pub conversation_id: u64,
    /// The enqueuing AI user identity (hex), recorded in the audit trail.
    pub requested_by: String,
    pub command: String,
    pub cwd: Option<String>,
    /// True if a human has confirmed this command (`confirmed_at` set). When set,
    /// the `require_confirmation_for` gate is skipped on re-entry.
    pub confirmed: bool,
    /// Command kind: `None` ≡ "bash". "inference" routes to the provider
    /// adapters ([`crate::providers`]) instead of the allowlist+PTY path.
    /// `#[serde(default)]` so frames from an older relay (no kind field) parse
    /// as bash, and an older daemon receiving a kind-carrying frame ignores the
    /// unknown field (its allowlist then fail-safes on the summary string).
    #[serde(default)]
    pub kind: Option<String>,
    /// Kind-specific request body (JSON) — the inference payload. `command`
    /// carries only a short summary for non-bash kinds.
    #[serde(default)]
    pub payload_json: Option<String>,
}

/// The result of handling one command, mapped onto the command-lifecycle
/// reducers by the transport. Serialized over the wire (tagged by `status`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome {
    /// Ran to completion (→ `complete_bridge_command`). `exit_code` `None` or
    /// non-zero is a failed run; the reducer derives Completed/Failed.
    Completed {
        exit_code: Option<i32>,
        stdout: String,
        stderr: String,
        duration_ms: u64,
    },
    /// Blocked by the allowlist (→ `reject_bridge_command`).
    Rejected { reason: String },
    /// Matched `require_confirmation_for` and not yet confirmed — the command
    /// waits for a human (the transport sets status `AwaitingConfirmation`).
    AwaitingConfirmation { matched: String },
}

/// Execution settings for the loop (the allowlist config lives in the enforcer).
pub struct ExecConfig {
    pub shell: String,
    pub limits: PtyLimits,
    pub server_url: String,
}

/// Source of inbound commands (the proxied SpacetimeDB subscription in prod).
#[allow(async_fn_in_trait)]
pub trait CommandSource {
    /// The next command to run, or `None` when the stream ends.
    async fn next_command(&mut self) -> Option<IncomingCommand>;
}

/// Sink for outcomes (the `complete_/reject_/…` reducers in prod).
#[allow(async_fn_in_trait)]
pub trait ResultSink {
    async fn send_outcome(&mut self, command_id: u64, outcome: Outcome) -> Result<(), String>;
}

/// Handle one command: enforce → audit (before exec) → execute. Pure except for
/// the PTY spawn and the audit-log append; no transport involved, so it is
/// directly testable.
pub fn process_command(
    cmd: &IncomingCommand,
    enforcer: &AllowlistEnforcer,
    exec: &ExecConfig,
    audit: &mut AuditLog,
) -> Outcome {
    let decision = enforcer.enforce(&cmd.command, cmd.cwd.as_deref());

    // A confirmed command skips the confirmation gate but is otherwise re-checked
    // (prefix allowlist, blocked patterns, CWD jail all still apply).
    let effective = match &decision {
        Decision::AwaitingConfirmation { .. } if cmd.confirmed => Decision::Allow,
        other => other.clone(),
    };

    let allowlist_result = match &effective {
        Decision::Allow => "allowed",
        Decision::Reject { .. } => "denied",
        Decision::AwaitingConfirmation { .. } => "awaiting_confirmation",
    };

    // Audit BEFORE executing, so a crash mid-command still leaves a record.
    let _ = audit.append(NewAuditRecord {
        ts: now_timestamp(),
        device_id: cmd.device_id.to_string(),
        session_id: cmd.session_id,
        command_id: cmd.command_id,
        server: exec.server_url.clone(),
        requested_by_identity: cmd.requested_by.clone(),
        conversation_id: cmd.conversation_id,
        command: cmd.command.clone(),
        cwd: cmd.cwd.clone(),
        allowlist_result: allowlist_result.to_string(),
        kind: None,
    });

    match effective {
        Decision::Reject { reason } => Outcome::Rejected { reason },
        Decision::AwaitingConfirmation { matched } => Outcome::AwaitingConfirmation { matched },
        Decision::Allow => {
            // No explicit cwd → run in the first allowed directory (keeps writes
            // inside the jail and in a predictable place, not the daemon's launch
            // dir). An explicit cwd has already been jail-checked by the enforcer.
            let cwd = cmd
                .cwd
                .as_deref()
                .map(Path::new)
                .or_else(|| enforcer.primary_dir());
            match run_command(
                &cmd.command,
                cwd,
                &exec.shell,
                &exec.limits,
                enforcer.allowed_dirs(),
            ) {
                Ok(out) => Outcome::Completed {
                    exit_code: out.exit_code,
                    // PTY merges stdout+stderr into one stream (see pty.rs); the
                    // combined output goes in stdout, stderr stays empty.
                    stdout: out.output,
                    stderr: String::new(),
                    duration_ms: out.duration.as_millis() as u64,
                },
                Err(e) => Outcome::Completed {
                    exit_code: None,
                    stdout: String::new(),
                    stderr: format!("bridge: failed to execute command: {e}"),
                    duration_ms: 0,
                },
            }
        }
    }
}

/// Handle one command of ANY kind. Bash commands go through the existing
/// synchronous allowlist → audit → PTY path ([`process_command`]); inference
/// commands go through the provider adapters ([`crate::providers`]) — no
/// allowlist, no PTY, no sandbox (fixed binary + argument template; the prompt
/// travels via stdin), but the same audit-before-exec rule. Both production
/// transports (relay `run_session`, desktop embed `run_loop`) call this.
pub async fn process_incoming(
    cmd: &IncomingCommand,
    enforcer: &AllowlistEnforcer,
    exec: &ExecConfig,
    audit: &mut AuditLog,
) -> Outcome {
    match cmd.kind.as_deref() {
        Some("inference") => {
            // Audit BEFORE executing, mirroring process_command. `command` is
            // the enqueue-side summary (`infer:{provider}:{model}`) — the
            // prompt itself is NOT logged (it may carry sensitive context);
            // the module-side ToolCallAuditLog hashes the full payload.
            let _ = audit.append(NewAuditRecord {
                ts: now_timestamp(),
                device_id: cmd.device_id.to_string(),
                session_id: cmd.session_id,
                command_id: cmd.command_id,
                server: exec.server_url.clone(),
                requested_by_identity: cmd.requested_by.clone(),
                conversation_id: cmd.conversation_id,
                command: cmd.command.clone(),
                cwd: None,
                allowlist_result: "allowed".to_string(),
                kind: Some("inference".to_string()),
            });
            let result =
                crate::providers::run_inference_json(cmd.payload_json.as_deref()).await;
            Outcome::Completed {
                exit_code: Some(if result.ok { 0 } else { 1 }),
                stdout: result.to_json(),
                stderr: String::new(),
                duration_ms: result.duration_ms,
            }
        }
        Some("harness") => {
            // Audit before executing; `command` is the enqueue summary
            // (`harness:{provider}`). The prompt is not logged locally.
            let _ = audit.append(NewAuditRecord {
                ts: now_timestamp(),
                device_id: cmd.device_id.to_string(),
                session_id: cmd.session_id,
                command_id: cmd.command_id,
                server: exec.server_url.clone(),
                requested_by_identity: cmd.requested_by.clone(),
                conversation_id: cmd.conversation_id,
                command: cmd.command.clone(),
                cwd: None,
                allowlist_result: "allowed".to_string(),
                kind: Some("harness".to_string()),
            });
            let result = crate::harness::run_harness_json(
                cmd.payload_json.as_deref(),
                enforcer.allowed_dirs(),
            )
            .await;
            Outcome::Completed {
                exit_code: Some(if result.ok { 0 } else { 1 }),
                stdout: result.to_json(),
                stderr: String::new(),
                duration_ms: result.duration_ms,
            }
        }
        // Unknown kinds are rejected explicitly (a newer server than daemon);
        // None / "bash" take the classic path.
        Some(other) if other != "bash" => Outcome::Rejected {
            reason: format!(
                "this pear-bridge build does not support command kind \"{other}\" — update pear-bridge"
            ),
        },
        _ => process_command(cmd, enforcer, exec, audit),
    }
}

/// Drive the loop: pull commands from `source`, process each, push the outcome to
/// `sink`. Returns when the source is exhausted (or a sink error). The transport
/// supplies reconnect/token-refresh around this (see [`crate::relay`]).
pub async fn run_loop<S: CommandSource, K: ResultSink>(
    mut source: S,
    mut sink: K,
    enforcer: &AllowlistEnforcer,
    exec: &ExecConfig,
    audit: &mut AuditLog,
) -> Result<(), String> {
    while let Some(cmd) = source.next_command().await {
        let outcome = process_incoming(&cmd, enforcer, exec, audit).await;
        sink.send_outcome(cmd.command_id, outcome).await?;
    }
    Ok(())
}

/// Epoch-millis timestamp as a string. (RFC 3339 would be nicer for the audit
/// log; deferred to avoid a time-formatting dependency in the daemon core.)
fn now_timestamp() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    ms.to_string()
}
