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

pub(crate) fn next_bridge_device_grant_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "bridge_device_grant", || {
        ctx.db.bridge_device_grant().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_bridge_device_capability_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "bridge_device_capability", || {
        ctx.db.bridge_device_capability().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_bridge_command_chunk_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "bridge_command_chunk", || {
        ctx.db.bridge_command_chunk().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

// ============================================================
// Bridge — enums
// ============================================================

/// How the bridge treats a command whose leading token is not in
/// `allowed_commands` (and is not caught by the in-binary baseline-blocked
/// floor). The daemon enforces this; the value is shipped to it in the allowlist
/// bootstrap frame.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum UnlistedCommandPolicy {
    /// Route unlisted commands to `AwaitingConfirmation` so the device owner can
    /// Allow / Deny in the Pear UI. The baseline-blocked floor + CWD jail still
    /// hard-reject regardless. This is the default for new devices.
    Prompt,
    /// Hard-reject unlisted commands (strict — the original behavior).
    Reject,
}

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
    /// The dedicated SpacetimeDB identity minted for this device at pair time
    /// (option B). The relay dials STDB as THIS identity — least privilege, never
    /// an owner/admin token — so the daemon's command subscription is RLS-scoped
    /// to its own device via `BRIDGE_COMMAND_DEVICE_FILTER`. `Identity::ZERO`
    /// until paired under the option-B flow.
    #[default(Identity::ZERO)]
    pub device_identity: Identity,
    /// Base64 of the AES-GCM ciphertext (`nonce || ciphertext`) of the device's
    /// STDB token, minted + encrypted server-side at pair time and decrypted by
    /// the relay to dial STDB on the device's behalf. The device itself never
    /// holds an STDB token. Kept in STDB (NOT Postgres) so a self-hosted OSS
    /// relay can read it — bridge state must not depend on Pear-Cloud infra.
    /// Stored as a base64 String (not `Vec<u8>`) so it round-trips reliably
    /// through STDB SQL when the relay reads it back. `None` until paired under
    /// option B. Lives on this PRIVATE table, so it is never client-readable.
    #[default(None::<String>)]
    pub device_stdb_token_ciphertext: Option<String>,
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

/// Second visibility rule, **unioned (OR)** with `BRIDGE_COMMAND_FILTER`: the
/// executing device's own STDB identity can read its device's commands. The
/// `pear-bridge` daemon connects (through the relay) AS this identity, so its
/// subscription delivers exactly its own pending commands. STDB enforces RLS and
/// unions multiple filters — confirmed by `spikes/rls-multi-filter/`.
#[client_visibility_filter]
const BRIDGE_COMMAND_DEVICE_FILTER: Filter =
    Filter::Sql("SELECT * FROM bridge_command WHERE device_identity = :sender");

/// Third visibility rule, **unioned (OR)** with the two above: the device
/// **owner** (the human who paired it) can read their devices' commands. This is
/// what lets the owner see `AwaitingConfirmation` commands and Allow/Deny them in
/// the Pear UI. Backed by the denormalized `owner_identity` column (stamped at
/// enqueue from `BridgeDevice.owner`) so the filter stays a simple equality —
/// joins/subqueries in RLS are unproven (see `spikes/rls-multi-filter`).
#[client_visibility_filter]
const BRIDGE_COMMAND_OWNER_FILTER: Filter =
    Filter::Sql("SELECT * FROM bridge_command WHERE owner_identity = :sender");

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
    /// The executing device's STDB identity, copied from `BridgeDevice` at
    /// enqueue. Backs `BRIDGE_COMMAND_DEVICE_FILTER` so the daemon can see its
    /// own device's commands, and gates `complete_/reject_bridge_command` to the
    /// device that owns the work. `Identity::ZERO` for pre-option-B rows.
    #[default(Identity::ZERO)]
    pub device_identity: Identity,
    /// The device owner's identity, copied from `BridgeDevice.owner` at enqueue.
    /// Backs `BRIDGE_COMMAND_OWNER_FILTER` so the owner can see and approve/deny
    /// their devices' commands in the UI. `Identity::ZERO` for rows enqueued
    /// before this column existed (invisible to the owner — only historical).
    ///
    #[default(Identity::ZERO)]
    pub owner_identity: Identity,
    /// Client-generated unique token for the enqueue call, so the worker can read
    /// back exactly the command it enqueued (match on `nonce`) instead of on
    /// `(device_id, command)` — two identical in-flight commands no longer
    /// cross-match. Empty for legacy rows / callers that don't supply one.
    #[default(None::<String>)]
    pub nonce: Option<String>,
    /// Command kind discriminator. `None` ≡ "bash" (legacy rows and plain
    /// tool-bash commands). "inference" = a one-shot inference request whose
    /// request body lives in `payload_json`; the daemon runs it through a
    /// provider adapter (claude -p / codex exec / ollama) OUTSIDE the bash
    /// sandbox and allowlist. "harness" is reserved for bridge harness
    /// sessions (ticket 14443). String, not enum: adding enum variants is a
    /// breaking type change for deployed clients (see STATUS_TAGS coupling in
    /// worker/bridge-sql.ts and desktop stdb.rs), a string is forward-open.
    #[default(None::<String>)]
    pub kind: Option<String>,
    /// Kind-specific request body (JSON), e.g. for kind="inference":
    /// `{"provider":"claude-code","model":"…","prompt":"…","system":"…",
    ///   "timeout_seconds":240}`. Capped at 1 MiB by the enqueue reducer.
    /// `command` holds only a short human-readable summary for UI/audit.
    ///
    /// Must remain last for schema migration (STDB only allows additive changes
    /// at the end of a struct).
    #[default(None::<String>)]
    pub payload_json: Option<String>,
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

/// Incremental output for a streaming command (`kind = "inference"` with
/// `stream: true`): the device appends chunks while the model generates, the
/// worker polls them via `/sql` and forwards them as stream deltas, and the
/// terminal `complete_/reject_bridge_command` DELETES them — chunks are
/// transient stream state, not part of the record (the full output lands in
/// `BridgeCommandResult`). `content` is a small JSON envelope
/// (`{"t":"text"|"think","d":"…"}`). Same visibility rule as results: only the
/// requesting AI user reads its own stream.
#[client_visibility_filter]
const BRIDGE_COMMAND_CHUNK_FILTER: Filter =
    Filter::Sql("SELECT * FROM bridge_command_chunk WHERE requested_by = :sender");

#[table(accessor = bridge_command_chunk, public)]
pub struct BridgeCommandChunk {
    #[primary_key]
    pub id: u64,
    #[index(btree)]
    pub command_id: u64,
    /// Device-assigned monotonic sequence within the command.
    pub seq: u32,
    /// JSON delta envelope, capped at 64 KiB by the reducer.
    pub content: String,
    /// Copied from `BridgeCommand.requested_by`; backs the RLS filter.
    pub requested_by: Identity,
    pub created_at: Timestamp,
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

/// Second allowlist rule, **unioned (OR)** with the owner filter above: the
/// device's own STDB identity can read its allowlist row. The desktop-embedded
/// bridge connects directly to STDB as the device identity (no relay to ship it
/// an allowlist bootstrap frame), so it must be able to fetch its own config.
/// Backed by the denormalized `device_identity` column, stamped at pair time
/// and preserved by `set_bridge_allowlist`.
#[client_visibility_filter]
const BRIDGE_DEVICE_ALLOWLIST_DEVICE_FILTER: Filter =
    Filter::Sql("SELECT * FROM bridge_device_allowlist WHERE device_identity = :sender");

/// Non-sensitive, workspace-readable view of paired devices. `bridge_device`
/// itself is PRIVATE (it holds token hashes + the encrypted STDB token), so AI
/// users and the device-management UI cannot read it to discover which devices
/// exist. This public mirror carries only the safe fields, letting any identity
/// connected to this workspace module list devices (e.g. the `list_bridge_devices`
/// agent tool). No RLS — visible workspace-wide, like other public reference
/// data. Kept in sync by the device + session lifecycle reducers; 1:1 with
/// `BridgeDevice` by `id`.
#[table(accessor = bridge_device_summary, public)]
pub struct BridgeDeviceSummary {
    /// == `BridgeDevice.id`.
    #[primary_key]
    pub id: u64,
    pub name: String,
    pub platform: String,
    /// True while a relay session is open for this device (best-effort; set by
    /// `open_/close_bridge_session`).
    pub connected: bool,
    pub revoked_at: Option<Timestamp>,
}

/// Inference providers a paired device exposes (claude-code / codex / ollama),
/// one row per (device, provider). Self-reported by the device via
/// `report_bridge_device_capability` at connect time (the daemon detects
/// installed CLIs / a reachable ollama daemon), so rows describe the last
/// report, not a live guarantee — pair with `BridgeDeviceSummary.connected`
/// before enqueueing. Like `BridgeDeviceSummary`: public, no RLS, no secrets —
/// AI users must be able to read it to discover where they can run inference
/// (`tool_infer`, per-AI-user inference backends).
#[table(accessor = bridge_device_capability, public)]
pub struct BridgeDeviceCapability {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// == `BridgeDevice.id`.
    #[index(btree)]
    pub device_id: u64,
    /// Provider slug: "claude-code" | "codex" | "ollama" (forward-open).
    pub provider: String,
    /// False when the CLI is installed but currently unusable (e.g. ollama
    /// daemon not running at last report).
    pub available: bool,
    /// Provider CLI/daemon version string, when detectable.
    pub version: Option<String>,
    /// JSON array of model names the provider reported (ollama tag list);
    /// `None` when the provider doesn't enumerate models (claude/codex).
    pub models_json: Option<String>,
    pub detected_at: Timestamp,
}

/// Per-(device, AI user) authorization to run `tool-bash` on a device.
///
/// This is the **substrate-level** permission boundary for the bridge. The
/// `enqueue_bridge_command` reducer is default-deny: an AI user identity may
/// only enqueue a command for a device that has a matching grant row. Every
/// caller path — chat (`executeTool`), Orcha, and any future MCP surface —
/// goes through that reducer, so the grant is enforced uniformly regardless of
/// which worker code path initiated the call. (The `CompositeToolExecutor`
/// `PermissionChecker` check remains as TS-side defense-in-depth, but it is no
/// longer the only thing standing between an AI user and a real shell.)
///
/// Grants are created/removed by the device `owner` (`grant_bridge_device` /
/// `revoke_bridge_device_grant`). Two visibility filters apply (unioned): the
/// owner reads their grants via `granted_by`, and an AI user reads grants
/// naming it via `ai_user_identity` (so `list_bridge_devices` can scope to the
/// devices that AI user may actually target).
#[client_visibility_filter]
const BRIDGE_DEVICE_GRANT_OWNER_FILTER: Filter =
    Filter::Sql("SELECT * FROM bridge_device_grant WHERE granted_by = :sender");

#[client_visibility_filter]
const BRIDGE_DEVICE_GRANT_AI_USER_FILTER: Filter =
    Filter::Sql("SELECT * FROM bridge_device_grant WHERE ai_user_identity = :sender");

#[table(accessor = bridge_device_grant, public)]
pub struct BridgeDeviceGrant {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub device_id: u64,
    /// The AI user's STDB identity (== `AiUserConfig.identity`). Matched against
    /// `ctx.sender()` in `enqueue_bridge_command`.
    pub ai_user_identity: Identity,
    /// The device owner who created this grant.
    pub granted_by: Identity,
    pub granted_at: Timestamp,
}

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
    /// What to do with a command whose leader is not in `allowed_commands`:
    /// `Prompt` (default) routes it to human confirmation; `Reject` hard-denies.
    #[default(UnlistedCommandPolicy::Prompt)]
    pub unlisted_command_policy: UnlistedCommandPolicy,
    /// The device's own STDB identity, denormalized from `BridgeDevice` so the
    /// desktop-embedded bridge can read its allowlist row via
    /// `BRIDGE_DEVICE_ALLOWLIST_DEVICE_FILTER`. `Identity::ZERO` for rows from
    /// before this column existed (relay-served devices don't need it).
    /// Must remain last for schema migration (STDB only allows additive changes
    /// at the end of a struct).
    #[default(Identity::ZERO)]
    pub device_identity: Identity,
}
