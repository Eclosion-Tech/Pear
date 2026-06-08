//! Pear Bridge: local-shell execution backend for the `tool-bash`
//! capability. A paired `pear-bridge` daemon dials out to the relay and
//! executes allowlisted commands in the user's real environment.
//!
//! This module owns the bridge tables, the per-table id helpers, and the
//! command/session/device lifecycle reducers. It integrates with the
//! existing `extensions` machinery: `tool-bash` is already a sensitive
//! capability (see `PermissionScope::BridgeDevice` below and
//! `ExtensionPermission`), and every command execution is mirrored into
//! the existing `ToolCallAuditLog`.
//!
//! Security note: the SpacetimeDB layer is NOT the enforcement point. The
//! allowlist is re-enforced locally in the bridge binary before any PTY
//! call. These tables are the command bus and the audit trail; they are
//! authoritative for configuration but not for containment. See
//! `docs/PEAR_BRIDGE.md` § Security.

use spacetimedb::{client_visibility_filter, table, Filter, Identity, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::id_counters::alloc_id;

pub(crate) mod reducers;

// ============================================================
// Bridge — id helpers (counter-backed, gap-free; see id_counters.rs)
// ============================================================

pub(crate) fn next_bridge_device_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "bridge_device", || {
        ctx.db.bridge_device().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_bridge_session_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "bridge_session", || {
        ctx.db.bridge_session().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_bridge_command_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "bridge_command", || {
        ctx.db.bridge_command().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

// ============================================================
// Bridge — enums
// ============================================================

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum BridgeCommandStatus {
    /// Enqueued, not yet picked up by the bridge.
    Pending,
    /// Matched `require_confirmation_for`; waiting for a human to call
    /// `confirm_bridge_command` from the Pear UI.
    AwaitingConfirmation,
    /// Bridge has started the PTY.
    Running,
    /// Exited cleanly (exit code captured in BridgeCommandResult).
    Completed,
    /// Non-zero exit or bridge-side error.
    Failed,
    /// Blocked by the allowlist or CWD jail in the bridge binary.
    Rejected,
    /// Exceeded `max_runtime_seconds`; bridge killed the PTY.
    TimedOut,
}

// ============================================================
// Bridge — tables
// ============================================================

/// One registered bridge device. Created at pair time; survives across
/// reconnects. Revocation sets `revoked_at`; the relay rejects further
/// dial-ins immediately. Private — never readable by AI users.
#[table(accessor = bridge_device, private)]
pub struct BridgeDevice {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// The user who paired this device.
    pub owner: Identity,
    /// Human-readable, e.g. "MacBook Pro".
    pub name: String,
    /// SHA-256 of the long-lived device token; the raw token is never stored.
    pub device_token_hash: String,
    /// Reported at pair time, updated on reconnect.
    pub pear_bridge_version: String,
    /// "darwin-arm64", "linux-x86_64", "windows-x86_64".
    pub platform: String,
    pub paired_at: Timestamp,
    pub last_seen_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
}

/// An active or recently-closed relay session for a paired device.
/// One row per bridge connection; `disconnected_at` set on disconnect.
/// Private — never readable by AI users.
#[table(accessor = bridge_session, private)]
pub struct BridgeSession {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub device_id: u64,
    /// SHA-256 of the short-lived ephemeral tunnel token.
    pub tunnel_token_hash: String,
    /// Bridge must re-auth after this; ~30 min TTL.
    pub tunnel_token_expires_at: Timestamp,
    pub connected_at: Timestamp,
    pub disconnected_at: Option<Timestamp>,
    /// IP of the bridge connection, for audit.
    pub remote_addr: String,
}

/// A command enqueued by an AI user's `tool-bash` call. The `command`
/// string is stored pre-allowlist-check; the bridge binary is the
/// enforcement point. Each AI user sees only their own commands via
/// `BRIDGE_COMMAND_FILTER`; the relay (module publisher) sees all rows.
#[client_visibility_filter]
const BRIDGE_COMMAND_FILTER: Filter =
    Filter::Sql("SELECT * FROM bridge_command WHERE requested_by = :sender");

#[table(accessor = bridge_command, public)]
pub struct BridgeCommand {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub device_id: u64,
    #[index(btree)]
    pub session_id: u64,
    pub conversation_id: u64,
    pub job_id: Option<u64>,
    pub task_id: Option<u64>,
    /// The AI user's identity.
    pub requested_by: Identity,
    /// The raw command string (pre-allowlist check).
    pub command: String,
    /// Requested CWD; the bridge validates against `allowed_directories`.
    pub cwd: Option<String>,
    pub enqueued_at: Timestamp,
    pub status: BridgeCommandStatus,
    /// True if the command matched `require_confirmation_for`.
    pub requires_confirmation: bool,
    /// Set when a human confirms in the Pear UI.
    pub confirmed_at: Option<Timestamp>,
    /// The human who confirmed.
    pub confirmed_by: Option<Identity>,
}

/// Output and result for a completed command. 1:1 with BridgeCommand.
/// `requested_by` is copied from the parent `BridgeCommand` at write time
/// so the RLS filter can scope rows to the originating AI user without a
/// join. The proxy never surfaces session internals — only stdout/stderr.
#[client_visibility_filter]
const BRIDGE_COMMAND_RESULT_FILTER: Filter =
    Filter::Sql("SELECT * FROM bridge_command_result WHERE requested_by = :sender");

#[table(accessor = bridge_command_result, public)]
pub struct BridgeCommandResult {
    /// 1:1 with BridgeCommand.id.
    #[primary_key]
    pub command_id: u64,
    pub exit_code: Option<i32>,
    /// Truncated at `max_output_bytes`; a suffix is appended if cut.
    pub stdout: String,
    pub stderr: String,
    /// Set when status = Rejected.
    pub rejection_reason: Option<String>,
    pub duration_ms: u64,
    pub completed_at: Timestamp,
    /// SHA-256 of raw stdout+stderr, for the audit chain.
    pub output_hash: String,
    /// Copied from `BridgeCommand.requested_by` at completion time; used
    /// by `BRIDGE_COMMAND_RESULT_FILTER` to scope visibility to the
    /// originating AI user.
    #[default(Identity::ZERO)]
    pub requested_by: Identity,
}

/// Per-device allowlist configuration. Authoritative source, editable
/// from the Pear UI, fetched by the bridge at connect time. The bridge
/// ALSO enforces this locally and applies an in-binary baseline of
/// blocked patterns that the server cannot remove. 1:1 with BridgeDevice.
///
/// Readable by the device owner so the Pear settings UI can display and
/// edit the current config without a REST round-trip. `updated_by` is
/// always the device owner (enforced in `set_bridge_allowlist` via
/// `require_owner`), so it doubles as the RLS identity column.
#[client_visibility_filter]
const BRIDGE_DEVICE_ALLOWLIST_FILTER: Filter =
    Filter::Sql("SELECT * FROM bridge_device_allowlist WHERE updated_by = :sender");

#[table(accessor = bridge_device_allowlist, public)]
pub struct BridgeDeviceAllowlist {
    /// 1:1 with BridgeDevice.id.
    #[primary_key]
    pub device_id: u64,
    /// e.g. ["git", "npm", "cargo", "python3"].
    pub allowed_commands: Vec<String>,
    /// Regex patterns rejected regardless of the allowlist (server-side,
    /// additive to the binary baseline).
    pub blocked_patterns: Vec<String>,
    /// CWD jail; resolved CWD must be a prefix of one of these.
    pub allowed_directories: Vec<String>,
    /// Patterns that need human confirmation before execution.
    pub require_confirmation_for: Vec<String>,
    /// Default 65536.
    pub max_output_bytes: u64,
    /// Default 30; bridge kills the PTY after this.
    pub max_runtime_seconds: u64,
    pub updated_at: Timestamp,
    pub updated_by: Identity,
}
