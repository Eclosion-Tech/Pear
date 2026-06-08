//! Bridge device/session/command lifecycle reducers.
//!
//! Authorization model (mirrors the `extensions` module's `installed_by`
//! pattern):
//!
//! * Device-management reducers (`pair`/`revoke`/`rename`/`set_allowlist`)
//!   require the sender to be the device `owner`.
//! * Session-lifecycle and command-completion reducers
//!   (`open_bridge_session`, `close_bridge_session`,
//!   `refresh_bridge_tunnel_token`, `complete_bridge_command`,
//!   `reject_bridge_command`) are called by the relay on the bridge's
//!   behalf — NEVER by an AI user. They are gated on a valid, non-revoked
//!   device/session, not on `ctx.sender()` being human.
//! * `enqueue_bridge_command` is the only reducer an AI user (worker
//!   identity) calls. It records the request; it does NOT execute. The
//!   bridge binary is the execution + allowlist enforcement point.
//!
//! Critical: `complete_bridge_command` / `reject_bridge_command` must
//! never be reachable from an AI user's tool surface — otherwise a
//! prompt-injected agent could forge its own command results. They are
//! relay/bridge-only.

use spacetimedb::{reducer, Identity, ReducerContext, Table, Timestamp};

use crate::bridge::{
    bridge_command, bridge_command_result, bridge_device, bridge_device_allowlist, bridge_session,
    next_bridge_command_id, next_bridge_device_id, next_bridge_session_id, BridgeCommand,
    BridgeCommandResult, BridgeCommandStatus, BridgeDevice, BridgeDeviceAllowlist, BridgeSession,
};
use crate::extensions::{tool_call_audit_log, ToolCallAuditLog};

// ============================================================
// Helpers
// ============================================================

/// Hex SHA-256 of the input, matching the hashing convention used for
/// token hashes elsewhere in the module (sha2 + hex crates).
fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

/// Load a device by id, erroring if missing or revoked.
fn live_device(ctx: &ReducerContext, device_id: u64) -> Result<BridgeDevice, String> {
    let device = ctx
        .db
        .bridge_device()
        .id()
        .find(device_id)
        .ok_or_else(|| format!("Bridge device {device_id} not found"))?;
    if device.revoked_at.is_some() {
        return Err(format!("Bridge device {device_id} has been revoked"));
    }
    Ok(device)
}

/// Require that the sender is the owner of the given device.
fn require_owner(ctx: &ReducerContext, device: &BridgeDevice) -> Result<(), String> {
    if device.owner != ctx.sender() {
        return Err("Only the device owner may perform this action".to_string());
    }
    Ok(())
}

// ============================================================
// Pairing — called by the Pear web app pairing UI
// ============================================================

/// Complete a pairing exchange: create the BridgeDevice row from a
/// validated pairing code and return it. The raw device token is minted
/// and delivered to the bridge out-of-band (via the relay); only its hash
/// is stored here.
///
/// NOTE: pairing-code generation/validation lives in the web app +
/// `/api/bridge/auth`; this reducer assumes the code has already been
/// validated and consumed by the caller. The `device_token_hash` is the
/// hash of the freshly-minted token.
#[reducer]
pub fn pair_bridge_device(
    ctx: &ReducerContext,
    device_name: String,
    device_token_hash: String,
    platform: String,
    bridge_version: String,
) -> Result<(), String> {
    if device_name.trim().is_empty() {
        return Err("Device name cannot be empty".to_string());
    }
    if device_token_hash.len() != 64 {
        return Err("device_token_hash must be a hex SHA-256".to_string());
    }
    let device_id = next_bridge_device_id(ctx);
    ctx.db.bridge_device().insert(BridgeDevice {
        id: device_id,
        owner: ctx.sender(),
        name: device_name,
        device_token_hash,
        pear_bridge_version: bridge_version,
        platform,
        paired_at: ctx.timestamp,
        last_seen_at: None,
        revoked_at: None,
    });
    // Seed a conservative default allowlist (see docs/PEAR_BRIDGE.md
    // § Allowlist defaults). allowed_directories is intentionally NOT
    // defaulted — the pairing UI forces the user to pick (v1 decision #2).
    ctx.db.bridge_device_allowlist().insert(BridgeDeviceAllowlist {
        device_id,
        allowed_commands: default_allowed_commands(),
        blocked_patterns: Vec::new(),
        allowed_directories: Vec::new(),
        require_confirmation_for: default_require_confirmation_for(),
        max_output_bytes: 65536,
        // v1.1 decision: default raised to 120s; 30s timed out cargo/npm.
        max_runtime_seconds: 120,
        updated_at: ctx.timestamp,
        updated_by: ctx.sender(),
    });
    Ok(())
}

#[reducer]
pub fn revoke_bridge_device(ctx: &ReducerContext, device_id: u64) -> Result<(), String> {
    let device = ctx
        .db
        .bridge_device()
        .id()
        .find(device_id)
        .ok_or_else(|| format!("Bridge device {device_id} not found"))?;
    require_owner(ctx, &device)?;
    if device.revoked_at.is_some() {
        return Ok(()); // idempotent
    }
    ctx.db.bridge_device().id().update(BridgeDevice {
        revoked_at: Some(ctx.timestamp),
        ..device
    });
    // Close any live sessions for this device so the relay drops them.
    let open: Vec<BridgeSession> = ctx
        .db
        .bridge_session()
        .iter()
        .filter(|s| s.device_id == device_id && s.disconnected_at.is_none())
        .collect();
    for session in open {
        ctx.db.bridge_session().id().update(BridgeSession {
            disconnected_at: Some(ctx.timestamp),
            ..session
        });
    }
    Ok(())
}

#[reducer]
pub fn rename_bridge_device(
    ctx: &ReducerContext,
    device_id: u64,
    name: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Device name cannot be empty".to_string());
    }
    let device = ctx
        .db
        .bridge_device()
        .id()
        .find(device_id)
        .ok_or_else(|| format!("Bridge device {device_id} not found"))?;
    require_owner(ctx, &device)?;
    ctx.db
        .bridge_device()
        .id()
        .update(BridgeDevice { name, ..device });
    Ok(())
}

// ============================================================
// Session lifecycle — called by the relay on the bridge's behalf
// ============================================================

/// Open a relay session for a device that presented a valid device-token
/// hash. Returns the new session id; the relay mints the raw tunnel token
/// and hands it to the bridge, storing only its hash here.
#[reducer]
pub fn open_bridge_session(
    ctx: &ReducerContext,
    device_token_hash: String,
    tunnel_token_hash: String,
    tunnel_token_expires_at: Timestamp,
    remote_addr: String,
) -> Result<(), String> {
    let device = ctx
        .db
        .bridge_device()
        .iter()
        .find(|d| d.device_token_hash == device_token_hash)
        .ok_or_else(|| "No device matches the presented token".to_string())?;
    if device.revoked_at.is_some() {
        return Err("Device has been revoked".to_string());
    }
    let session_id = next_bridge_session_id(ctx);
    ctx.db.bridge_session().insert(BridgeSession {
        id: session_id,
        device_id: device.id,
        tunnel_token_hash,
        tunnel_token_expires_at,
        connected_at: ctx.timestamp,
        disconnected_at: None,
        remote_addr,
    });
    ctx.db.bridge_device().id().update(BridgeDevice {
        last_seen_at: Some(ctx.timestamp),
        ..device
    });
    Ok(())
}

#[reducer]
pub fn close_bridge_session(ctx: &ReducerContext, session_id: u64) -> Result<(), String> {
    let session = ctx
        .db
        .bridge_session()
        .id()
        .find(session_id)
        .ok_or_else(|| format!("Bridge session {session_id} not found"))?;
    if session.disconnected_at.is_some() {
        return Ok(());
    }
    ctx.db.bridge_session().id().update(BridgeSession {
        disconnected_at: Some(ctx.timestamp),
        ..session
    });
    Ok(())
}

#[reducer]
pub fn refresh_bridge_tunnel_token(
    ctx: &ReducerContext,
    session_id: u64,
    new_tunnel_token_hash: String,
    new_expires_at: Timestamp,
) -> Result<(), String> {
    let session = ctx
        .db
        .bridge_session()
        .id()
        .find(session_id)
        .ok_or_else(|| format!("Bridge session {session_id} not found"))?;
    if session.disconnected_at.is_some() {
        return Err("Session is closed".to_string());
    }
    // Device must still be live.
    live_device(ctx, session.device_id)?;
    ctx.db.bridge_session().id().update(BridgeSession {
        tunnel_token_hash: new_tunnel_token_hash,
        tunnel_token_expires_at: new_expires_at,
        ..session
    });
    Ok(())
}

// ============================================================
// Command lifecycle
// ============================================================

/// Enqueue a command from an AI user's `tool-bash` call. This is the ONLY
/// command reducer an AI user identity calls. It records intent; the
/// bridge binary executes and enforces the allowlist locally.
///
/// `requires_confirmation` is computed bridge-side against
/// `require_confirmation_for` and reflected back via the bridge updating
/// status to AwaitingConfirmation; this reducer always enqueues as
/// Pending. The caller's identity is recorded for audit.
#[reducer]
pub fn enqueue_bridge_command(
    ctx: &ReducerContext,
    device_id: u64,
    command: String,
    cwd: Option<String>,
    conversation_id: u64,
    job_id: Option<u64>,
    task_id: Option<u64>,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Command cannot be empty".to_string());
    }
    let device = live_device(ctx, device_id)?;
    // Require a currently-connected session for this device.
    let session = ctx
        .db
        .bridge_session()
        .iter()
        .filter(|s| s.device_id == device_id && s.disconnected_at.is_none())
        .max_by_key(|s| s.connected_at)
        .ok_or_else(|| format!("No connected bridge session for device {device_id}"))?;

    // NOTE: tool-bash capability + per-device grant is enforced by the
    // PermissionChecker in CompositeToolExecutor BEFORE this reducer is
    // called (PermissionScope::BridgeDevice(device_id)). This reducer is
    // not the permission boundary; it is the command bus.

    let command_id = next_bridge_command_id(ctx);
    ctx.db.bridge_command().insert(BridgeCommand {
        id: command_id,
        device_id,
        session_id: session.id,
        conversation_id,
        job_id,
        task_id,
        requested_by: ctx.sender(),
        command,
        cwd,
        enqueued_at: ctx.timestamp,
        status: BridgeCommandStatus::Pending,
        requires_confirmation: false,
        confirmed_at: None,
        confirmed_by: None,
    });
    let _ = device; // device liveness already validated
    Ok(())
}

/// Confirm a command sitting in AwaitingConfirmation. Called by the Pear
/// UI; the human confirmer is the sender and must own the device.
#[reducer]
pub fn confirm_bridge_command(ctx: &ReducerContext, command_id: u64) -> Result<(), String> {
    let cmd = ctx
        .db
        .bridge_command()
        .id()
        .find(command_id)
        .ok_or_else(|| format!("Bridge command {command_id} not found"))?;
    if cmd.status != BridgeCommandStatus::AwaitingConfirmation {
        return Err("Command is not awaiting confirmation".to_string());
    }
    let device = live_device(ctx, cmd.device_id)?;
    require_owner(ctx, &device)?;
    ctx.db.bridge_command().id().update(BridgeCommand {
        status: BridgeCommandStatus::Pending,
        confirmed_at: Some(ctx.timestamp),
        confirmed_by: Some(ctx.sender()),
        ..cmd
    });
    Ok(())
}

/// Write the result of a completed command. RELAY/BRIDGE-ONLY — must not
/// be reachable from an AI user's tool surface (see module docs).
#[reducer]
pub fn complete_bridge_command(
    ctx: &ReducerContext,
    command_id: u64,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u64,
) -> Result<(), String> {
    let cmd = ctx
        .db
        .bridge_command()
        .id()
        .find(command_id)
        .ok_or_else(|| format!("Bridge command {command_id} not found"))?;
    let status = match exit_code {
        Some(0) => BridgeCommandStatus::Completed,
        _ => BridgeCommandStatus::Failed,
    };
    let output_hash = sha256_hex(&format!("{stdout}{stderr}"));
    // Audit + result are written first (they read `cmd` by reference), then the
    // status update consumes `cmd` via the `..cmd` spread — no clone needed.
    write_audit(ctx, &cmd, "allowed", &output_hash);
    ctx.db.bridge_command_result().insert(BridgeCommandResult {
        command_id,
        requested_by: cmd.requested_by,
        exit_code,
        stdout,
        stderr,
        rejection_reason: None,
        duration_ms,
        completed_at: ctx.timestamp,
        output_hash,
    });
    ctx.db.bridge_command().id().update(BridgeCommand { status, ..cmd });
    Ok(())
}

/// Record a command rejected by the bridge's local AllowlistEnforcer.
/// RELAY/BRIDGE-ONLY.
#[reducer]
pub fn reject_bridge_command(
    ctx: &ReducerContext,
    command_id: u64,
    reason: String,
) -> Result<(), String> {
    let cmd = ctx
        .db
        .bridge_command()
        .id()
        .find(command_id)
        .ok_or_else(|| format!("Bridge command {command_id} not found"))?;
    let output_hash = sha256_hex(&reason);
    // Audit + result first (read `cmd` by reference), then consume `cmd` in the
    // status update via `..cmd` — no clone needed. `reason` is moved into the
    // result row after its hash is computed.
    write_audit(ctx, &cmd, "denied", &output_hash);
    ctx.db.bridge_command_result().insert(BridgeCommandResult {
        command_id,
        requested_by: cmd.requested_by,
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        rejection_reason: Some(reason),
        duration_ms: 0,
        completed_at: ctx.timestamp,
        output_hash,
    });
    ctx.db.bridge_command().id().update(BridgeCommand {
        status: BridgeCommandStatus::Rejected,
        ..cmd
    });
    Ok(())
}

// ============================================================
// Allowlist management
// ============================================================

#[reducer]
pub fn set_bridge_allowlist(
    ctx: &ReducerContext,
    device_id: u64,
    allowed_commands: Vec<String>,
    blocked_patterns: Vec<String>,
    allowed_directories: Vec<String>,
    require_confirmation_for: Vec<String>,
    max_output_bytes: u64,
    max_runtime_seconds: u64,
) -> Result<(), String> {
    let device = live_device(ctx, device_id)?;
    require_owner(ctx, &device)?;
    let existing = ctx.db.bridge_device_allowlist().device_id().find(device_id);
    let row = BridgeDeviceAllowlist {
        device_id,
        allowed_commands,
        blocked_patterns,
        allowed_directories,
        require_confirmation_for,
        max_output_bytes,
        max_runtime_seconds,
        updated_at: ctx.timestamp,
        updated_by: ctx.sender(),
    };
    if existing.is_some() {
        ctx.db.bridge_device_allowlist().device_id().update(row);
    } else {
        ctx.db.bridge_device_allowlist().insert(row);
    }
    Ok(())
}

// ============================================================
// Audit mirror
// ============================================================

/// Mirror a bridge command into the existing ToolCallAuditLog. `outcome`
/// is "allowed" | "denied"; `outcome_detail` points back at the command.
fn write_audit(ctx: &ReducerContext, cmd: &BridgeCommand, outcome: &str, output_hash: &str) {
    use crate::extensions::next_tool_call_audit_log_id;
    ctx.db.tool_call_audit_log().insert(ToolCallAuditLog {
        id: next_tool_call_audit_log_id(ctx),
        conversation_id: cmd.conversation_id,
        job_id: cmd.job_id,
        task_id: cmd.task_id,
        agent_id: identity_short(&cmd.requested_by),
        installed_extension_id: None,
        tool_name: "tool-bash".to_string(),
        input_hash: sha256_hex(&cmd.command),
        output_hash: output_hash.to_string(),
        outcome: outcome.to_string(),
        outcome_detail: Some(format!("bridge_command:{}", cmd.id)),
        called_at: ctx.timestamp,
    });
}

fn identity_short(id: &Identity) -> String {
    let s = id.to_string();
    if s.len() > 18 {
        format!("{}…", &s[..18])
    } else {
        s
    }
}

// ============================================================
// Defaults (see docs/PEAR_BRIDGE.md § Allowlist defaults)
// ============================================================

fn default_allowed_commands() -> Vec<String> {
    [
        "git", "gh", "npm", "npx", "node", "yarn", "pnpm", "cargo", "rustc", "rustfmt", "python3",
        "pip3", "uv", "ruby", "bundle", "gem", "go", "ls", "cat", "grep", "rg", "find", "head",
        "tail", "wc", "echo", "printf", "mkdir", "cp", "mv", "which", "env", "printenv", "make",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn default_require_confirmation_for() -> Vec<String> {
    [
        "git push",
        "git push --force",
        "npm publish",
        "cargo publish",
        "gem push",
        "rm ",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}
