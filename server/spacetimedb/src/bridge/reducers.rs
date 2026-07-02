//! Bridge device/session/command lifecycle reducers.
//!
//! Authorization model (mirrors the `extensions` module's `installed_by`
//! pattern):
//!
//! * Device-management reducers (`pair`/`revoke`/`rename`/`set_allowlist`)
//!   require the sender to be the device `owner`.
//! * Session-lifecycle reducers (`open_bridge_session`,
//!   `close_bridge_session`, `refresh_bridge_tunnel_token`) are called by the
//!   relay on the bridge's behalf.
//! * Command-completion reducers (`complete_bridge_command`,
//!   `reject_bridge_command`) are gated on `ctx.sender()` equalling the
//!   command's `device_identity` (option B) — i.e. only the executing device
//!   (the daemon, connected through the relay as its device identity) may write
//!   a command's result. NEVER callable by an AI user.
//! * `enqueue_bridge_command` is the only reducer an AI user (worker
//!   identity) calls. It records the request; it does NOT execute. The
//!   bridge binary is the execution + allowlist enforcement point.
//!
//! Critical: `complete_bridge_command` / `reject_bridge_command` must
//! never be reachable from an AI user's tool surface — otherwise a
//! prompt-injected agent could forge its own command results. They are
//! relay/bridge-only.

use spacetimedb::{reducer, Identity, ReducerContext, Table, Timestamp};

use crate::ai::ai_user_config;
use crate::bridge::{
    bridge_command, bridge_command_result, bridge_device, bridge_device_allowlist,
    bridge_device_grant, bridge_device_summary, bridge_session, next_bridge_command_id,
    next_bridge_device_grant_id, next_bridge_device_id, next_bridge_session_id, BridgeCommand,
    BridgeCommandResult, BridgeCommandStatus, BridgeDevice, BridgeDeviceAllowlist,
    BridgeDeviceGrant, BridgeDeviceSummary, BridgeSession, UnlistedCommandPolicy,
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

/// Find an existing grant for `(device_id, ai_user_identity)`, if any. Scans the
/// device's grants (indexed by `device_id` — typically a handful per device).
fn find_grant(
    ctx: &ReducerContext,
    device_id: u64,
    ai_user_identity: Identity,
) -> Option<BridgeDeviceGrant> {
    ctx.db
        .bridge_device_grant()
        .device_id()
        .filter(device_id)
        .find(|g| g.ai_user_identity == ai_user_identity)
}

/// The substrate-level `tool-bash` boundary: require that the calling AI user
/// identity has been granted this device by its owner. Default-deny — no grant,
/// no execution. Enforced here (not just in the TS worker) so every caller path
/// is gated uniformly; see `BridgeDeviceGrant` docs.
fn require_bridge_grant(ctx: &ReducerContext, device_id: u64) -> Result<(), String> {
    if find_grant(ctx, device_id, ctx.sender()).is_some() {
        return Ok(());
    }
    Err(format!(
        "AI user is not granted access to bridge device {device_id}. \
         The device owner must grant it via grant_bridge_device."
    ))
}

/// Require that the caller is the device executing this command — i.e. the
/// `pear-bridge` daemon, connected (through the relay) as the device's STDB
/// identity (option B). This closes a forge-results hole: `complete_`/`reject_`
/// previously had no caller authorization, so any identity could write a
/// command's result and inject it into the AI's context.
fn require_executing_device(ctx: &ReducerContext, cmd: &BridgeCommand) -> Result<(), String> {
    if cmd.device_identity == Identity::ZERO {
        return Err("command has no device identity (pre-option-B row)".to_string());
    }
    if cmd.device_identity != ctx.sender() {
        return Err("Only the executing device may report this command's result".to_string());
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
///
/// Option B: `device_identity` + `device_stdb_token_ciphertext` are the
/// device's dedicated STDB identity and its encrypted STDB token. They are
/// minted + encrypted server-side (lifecycle, reusing the `api_service_token`
/// machinery — reducers can't do HTTP or hold the encryption key) and passed
/// in here. `owner` is still `ctx.sender()`, so this must be called as the
/// human who is pairing.
#[reducer]
pub fn pair_bridge_device(
    ctx: &ReducerContext,
    device_name: String,
    device_token_hash: String,
    platform: String,
    bridge_version: String,
    device_identity: Identity,
    // Base64 of the AES-GCM-encrypted device STDB token (minted + encrypted
    // server-side; see `mint_device_credentials`). Stored verbatim.
    device_stdb_token_ciphertext: String,
    // CWD jail chosen at pair time. v1 decision #2: at least one directory is
    // required — the enforcer fails closed, so an empty jail makes any explicit
    // `cwd` unusable. Enforced here so the reducer (not just the pairing UI) is
    // the gate.
    allowed_directories: Vec<String>,
) -> Result<(), String> {
    if device_name.trim().is_empty() {
        return Err("Device name cannot be empty".to_string());
    }
    if device_token_hash.len() != 64 {
        return Err("device_token_hash must be a hex SHA-256".to_string());
    }
    let allowed_directories: Vec<String> = allowed_directories
        .into_iter()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .collect();
    if allowed_directories.is_empty() {
        return Err("At least one allowed directory is required to pair a device".to_string());
    }
    let device_id = next_bridge_device_id(ctx);
    // Public summary mirror for device discovery (clone the safe fields before
    // they move into the private row).
    ctx.db.bridge_device_summary().insert(BridgeDeviceSummary {
        id: device_id,
        name: device_name.clone(),
        platform: platform.clone(),
        connected: false,
        revoked_at: None,
    });
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
        device_identity,
        device_stdb_token_ciphertext: Some(device_stdb_token_ciphertext),
    });
    // Seed a conservative default allowlist (see docs/PEAR_BRIDGE.md
    // § Allowlist defaults) with the caller-chosen CWD jail (validated
    // non-empty above — v1 decision #2).
    ctx.db.bridge_device_allowlist().insert(BridgeDeviceAllowlist {
        device_id,
        allowed_commands: default_allowed_commands(),
        blocked_patterns: Vec::new(),
        allowed_directories,
        require_confirmation_for: default_require_confirmation_for(),
        max_output_bytes: 65536,
        // v1.1 decision: default raised to 120s; 30s timed out cargo/npm.
        max_runtime_seconds: 120,
        updated_at: ctx.timestamp,
        updated_by: ctx.sender(),
        // New devices default to prompting for unlisted commands (the owner can
        // Allow / Deny in the UI) rather than hard-rejecting them.
        unlisted_command_policy: UnlistedCommandPolicy::Prompt,
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
    if let Some(s) = ctx.db.bridge_device_summary().id().find(device_id) {
        ctx.db.bridge_device_summary().id().update(BridgeDeviceSummary {
            revoked_at: Some(ctx.timestamp),
            connected: false,
            ..s
        });
    }
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
    if let Some(s) = ctx.db.bridge_device_summary().id().find(device_id) {
        ctx.db
            .bridge_device_summary()
            .id()
            .update(BridgeDeviceSummary { name: name.clone(), ..s });
    }
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
    // Micros since the Unix epoch. Passed as a primitive (not `Timestamp`) so
    // the relay can call this over STDB HTTP `/call` without encoding the
    // SATS `Timestamp` shape. Built into a `Timestamp` in-reducer.
    tunnel_token_expires_at_micros: i64,
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
        tunnel_token_expires_at: Timestamp::from_micros_since_unix_epoch(
            tunnel_token_expires_at_micros,
        ),
        connected_at: ctx.timestamp,
        disconnected_at: None,
        remote_addr,
    });
    let device_id = device.id;
    ctx.db.bridge_device().id().update(BridgeDevice {
        last_seen_at: Some(ctx.timestamp),
        ..device
    });
    set_summary_connected(ctx, device_id, true);
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
    let device_id = session.device_id;
    ctx.db.bridge_session().id().update(BridgeSession {
        disconnected_at: Some(ctx.timestamp),
        ..session
    });
    set_summary_connected(ctx, device_id, false);
    Ok(())
}

/// Best-effort update of the public summary's `connected` flag. No-op if the
/// summary row is missing (devices paired before the summary table existed).
fn set_summary_connected(ctx: &ReducerContext, device_id: u64, connected: bool) {
    if let Some(s) = ctx.db.bridge_device_summary().id().find(device_id) {
        ctx.db
            .bridge_device_summary()
            .id()
            .update(BridgeDeviceSummary { connected, ..s });
    }
}

#[reducer]
pub fn refresh_bridge_tunnel_token(
    ctx: &ReducerContext,
    session_id: u64,
    new_tunnel_token_hash: String,
    // Micros since the Unix epoch (see `open_bridge_session`).
    new_expires_at_micros: i64,
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
        tunnel_token_expires_at: Timestamp::from_micros_since_unix_epoch(new_expires_at_micros),
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
    // Client-generated unique token so the worker can read back exactly this
    // command (see `BridgeCommand::nonce`). Pass "" to skip read-back correlation.
    nonce: String,
) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Command cannot be empty".to_string());
    }
    let device = live_device(ctx, device_id)?;

    // Substrate-level permission boundary (default-deny): the calling AI user
    // identity must hold a BridgeDeviceGrant for this device. This closes the
    // gap where the chat/`executeTool` path bypassed the TS-side
    // PermissionChecker — every caller path reaches this reducer, so the grant
    // is enforced uniformly here. The TS `CompositeToolExecutor` check remains
    // as defense-in-depth + a friendlier pre-flight error.
    require_bridge_grant(ctx, device_id)?;

    // Require a currently-connected session for this device.
    let session = ctx
        .db
        .bridge_session()
        .iter()
        .filter(|s| s.device_id == device_id && s.disconnected_at.is_none())
        .max_by_key(|s| s.connected_at)
        .ok_or_else(|| format!("No connected bridge session for device {device_id}"))?;

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
        // Stamp the device's STDB identity so the daemon (connected as that
        // identity) can see this command via BRIDGE_COMMAND_DEVICE_FILTER, and
        // so complete/reject can be gated to the executing device.
        device_identity: device.device_identity,
        // Stamp the owner so they can see + approve/deny this command in the UI
        // (BRIDGE_COMMAND_OWNER_FILTER).
        owner_identity: device.owner,
        nonce: if nonce.is_empty() { None } else { Some(nonce) },
    });
    Ok(())
}

/// Confirm a command sitting in AwaitingConfirmation. Called by the Pear UI; the
/// human confirmer is the sender and must own the device. Flipping it back to
/// Pending (with `confirmed_at` set) re-dispatches it to the daemon, which skips
/// the confirmation gate on the confirmed re-run.
///
/// `remember` backs the UI's "Always allow": when true, the command's leading
/// program is appended to the device's `allowed_commands`, so future runs of
/// that program don't prompt. (Only meaningful for the unlisted-command case;
/// harmless for `require_confirmation_for` matches.)
#[reducer]
pub fn confirm_bridge_command(
    ctx: &ReducerContext,
    command_id: u64,
    remember: bool,
) -> Result<(), String> {
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

    if remember {
        if let Some(program) = leading_program(&cmd.command) {
            if let Some(allowlist) = ctx.db.bridge_device_allowlist().device_id().find(cmd.device_id) {
                if !allowlist.allowed_commands.iter().any(|c| c == &program) {
                    let mut allowed_commands = allowlist.allowed_commands.clone();
                    allowed_commands.push(program);
                    ctx.db.bridge_device_allowlist().device_id().update(BridgeDeviceAllowlist {
                        allowed_commands,
                        updated_at: ctx.timestamp,
                        updated_by: ctx.sender(),
                        ..allowlist
                    });
                }
            }
        }
    }

    ctx.db.bridge_command().id().update(BridgeCommand {
        status: BridgeCommandStatus::Pending,
        confirmed_at: Some(ctx.timestamp),
        confirmed_by: Some(ctx.sender()),
        ..cmd
    });
    Ok(())
}

/// Deny a command sitting in AwaitingConfirmation — the UI's "Deny". Owner-only.
/// Writes a Rejected result so the worker's wait resolves immediately (instead of
/// timing out) and the AI learns the human declined. Unlike `reject_bridge_command`
/// (relay/bridge-only, for allowlist rejections), this is the human-initiated path.
#[reducer]
pub fn deny_bridge_command(ctx: &ReducerContext, command_id: u64) -> Result<(), String> {
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
    let reason = "denied by user".to_string();
    let output_hash = sha256_hex(&reason);
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

/// Extract the leading program token of a command for the "Always allow"
/// allowlist append: first segment's first token, skipping `NAME=VALUE`
/// env-assignment prefixes. Deliberately simple (the daemon does the rigorous
/// parsing); this only needs the program name a human just approved.
fn leading_program(command: &str) -> Option<String> {
    let first_segment = command
        .split(['|', '&', ';'])
        .next()
        .unwrap_or(command)
        .trim();
    for token in first_segment.split_whitespace() {
        // Skip leading env assignments like FOO=bar.
        let is_assignment = matches!(token.find('='), Some(i) if i > 0)
            && token
                .split('=')
                .next()
                .map(|n| n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(false);
        if is_assignment {
            continue;
        }
        return Some(token.to_string());
    }
    None
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
    require_executing_device(ctx, &cmd)?;
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
    require_executing_device(ctx, &cmd)?;
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

/// Mark a command as awaiting human confirmation. Called by the bridge daemon
/// (through the relay, as the device identity) when the command matched the
/// local allowlist's `require_confirmation_for`. RELAY/BRIDGE-ONLY — gated on
/// the executing device, like `complete_`/`reject_`. The human then releases it
/// with `confirm_bridge_command`, which flips it back to `Pending` (with
/// `confirmed_at` set) so the bridge re-runs it skipping the confirmation gate.
#[reducer]
pub fn await_bridge_command_confirmation(
    ctx: &ReducerContext,
    command_id: u64,
) -> Result<(), String> {
    let cmd = ctx
        .db
        .bridge_command()
        .id()
        .find(command_id)
        .ok_or_else(|| format!("Bridge command {command_id} not found"))?;
    require_executing_device(ctx, &cmd)?;
    // Only a still-pending command can enter confirmation (ignore if already
    // confirmed/among a re-dispatch race).
    if cmd.status != BridgeCommandStatus::Pending {
        return Ok(());
    }
    ctx.db.bridge_command().id().update(BridgeCommand {
        status: BridgeCommandStatus::AwaitingConfirmation,
        requires_confirmation: true,
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
        // Preserve the existing unlisted-command policy across allowlist edits
        // (it has its own toggle, `set_bridge_unlisted_policy`); new rows default
        // to Prompt.
        unlisted_command_policy: existing
            .as_ref()
            .map(|e| e.unlisted_command_policy.clone())
            .unwrap_or(UnlistedCommandPolicy::Prompt),
    };
    if existing.is_some() {
        ctx.db.bridge_device_allowlist().device_id().update(row);
    } else {
        ctx.db.bridge_device_allowlist().insert(row);
    }
    Ok(())
}

/// Toggle how unlisted commands are handled on a device: `Prompt` (route to
/// human Allow/Deny) or `Reject` (hard-deny). Owner-only.
#[reducer]
pub fn set_bridge_unlisted_policy(
    ctx: &ReducerContext,
    device_id: u64,
    policy: UnlistedCommandPolicy,
) -> Result<(), String> {
    let device = live_device(ctx, device_id)?;
    require_owner(ctx, &device)?;
    let existing = ctx
        .db
        .bridge_device_allowlist()
        .device_id()
        .find(device_id)
        .ok_or_else(|| format!("No allowlist configured for device {device_id}"))?;
    ctx.db.bridge_device_allowlist().device_id().update(BridgeDeviceAllowlist {
        unlisted_command_policy: policy,
        updated_at: ctx.timestamp,
        updated_by: ctx.sender(),
        ..existing
    });
    Ok(())
}

// ============================================================
// Bridge device grants — per-(device, AI user) tool-bash authorization
// ============================================================

/// Grant an AI user permission to run `tool-bash` on a device. Owner-only.
/// Idempotent: re-granting an existing (device, AI user) pair is a no-op.
/// `ai_user_identity` must be a real AI user in this workspace.
#[reducer]
pub fn grant_bridge_device(
    ctx: &ReducerContext,
    device_id: u64,
    ai_user_identity: Identity,
) -> Result<(), String> {
    let device = live_device(ctx, device_id)?;
    require_owner(ctx, &device)?;
    if ai_user_identity == Identity::ZERO {
        return Err("ai_user_identity must be a non-zero Identity".to_string());
    }
    // The grant must name a real AI user, so a typo'd identity can't silently
    // create a dangling grant.
    if ctx
        .db
        .ai_user_config()
        .identity()
        .find(ai_user_identity)
        .is_none()
    {
        return Err("No AI user exists with that identity in this workspace".to_string());
    }
    if find_grant(ctx, device_id, ai_user_identity).is_some() {
        return Ok(()); // idempotent
    }
    ctx.db.bridge_device_grant().insert(BridgeDeviceGrant {
        id: next_bridge_device_grant_id(ctx),
        device_id,
        ai_user_identity,
        granted_by: ctx.sender(),
        granted_at: ctx.timestamp,
    });
    Ok(())
}

/// Revoke an AI user's `tool-bash` access to a device. Owner-only. Idempotent:
/// revoking a non-existent grant is a no-op. Pending commands already enqueued
/// are unaffected (they were authorized when enqueued); future enqueues fail.
#[reducer]
pub fn revoke_bridge_device_grant(
    ctx: &ReducerContext,
    device_id: u64,
    ai_user_identity: Identity,
) -> Result<(), String> {
    // The device may already be revoked/removed; still allow grant cleanup. Only
    // require that, if the device exists, the caller owns it.
    if let Some(device) = ctx.db.bridge_device().id().find(device_id) {
        require_owner(ctx, &device)?;
    }
    if let Some(grant) = find_grant(ctx, device_id, ai_user_identity) {
        ctx.db.bridge_device_grant().id().delete(&grant.id);
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
