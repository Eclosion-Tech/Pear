//! Separately owner-authorized metadata-only mailbox discovery declarations.
//! No mailbox execution, body, cursor advancement, skip or downstream authority.
use super::accounts::{mail_connection, MailConnection};
use super::admission::{canonical, hash, hex64, human, now_ms, opaque, service};
use super::authority::checked_current_authority;
use super::connector::{checked_cursor, cursor_id};
use super::protected::ProtectedMailDirection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spacetimedb::{
    procedure, reducer, table, Identity, ProcedureContext, ReducerContext, SpacetimeType, Table,
    Timestamp,
};

const INVALID: &str = "protected_mail_discovery_invalid_request";
const INCONSISTENT: &str = "protected_mail_discovery_inconsistent";
const OWNER: &str = "protected_mail_discovery_owner_required";
const SERVICE: &str = "protected_mail_discovery_service_required";
const CONFLICT: &str = "protected_mail_discovery_event_conflict";
const STALE: &str = "protected_mail_discovery_stale";
const CONSUMED: &str = "protected_mail_discovery_consumed";
const LIMIT: &str = "protected_mail_discovery_limit_exceeded";
const SAFE: u64 = 9_007_199_254_740_991;
const TTL: u64 = 3_600_000;
const CONTROL: u64 = 65_536;
const MAX_PLAN: usize = 8192;

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailDiscoveryNextWindow {
    pub expected_cursor_generation: u64,
    pub max_slots: u32,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailDiscoveryMode {
    Bootstrap,
    NextWindow(ProtectedMailDiscoveryNextWindow),
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailDiscoveryRequest {
    pub connection_id: u64,
    pub connector_identity: Identity,
    pub runtime_id: String,
    pub run_id: String,
    pub direction: ProtectedMailDirection,
    pub mode: ProtectedMailDiscoveryMode,
    pub not_before_ms: u64,
    pub expires_at_ms: u64,
    pub event_nonce: String,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailDiscoveryObservationInput {
    pub uid_validity: String,
    pub uid_next: u32,
    pub present_uids: Vec<u32>,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailDiscoveryOutcome {
    Failed,
    Unknown,
    CancelledBeforeDispatch,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailDiscoveryGrantEventKind {
    Issued,
    Revoked,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailDiscoveryStatus {
    Pending,
    Dispatching,
    Observed,
    Failed,
    Unknown,
    CancelledBeforeDispatch,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailDiscoveryCursorBinding {
    pub id: String,
    pub generation: u64,
    pub digest: String,
    pub uid_validity: String,
    pub last_uid: u32,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailDiscoveryHeadBinding {
    pub id: String,
    pub generation: u64,
    pub digest: String,
    pub observation_id: String,
    pub uid_validity: String,
    pub uid_next: u32,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailDiscoveryRange {
    pub from_uid: u32,
    pub through_uid: u32,
}

#[table(accessor=protected_mail_discovery_grant,private)]
pub struct ProtectedMailDiscoveryGrant {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub owner: Identity,
    pub workspace: Identity,
    pub request: ProtectedMailDiscoveryRequest,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub folder: String,
    pub cursor: Option<ProtectedMailDiscoveryCursorBinding>,
    pub head: Option<ProtectedMailDiscoveryHeadBinding>,
    pub manifest_digest: String,
    pub manifest_bytes: u64,
    pub canonical: String,
    pub issue_digest: String,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_discovery_grant_event,private)]
pub struct ProtectedMailDiscoveryGrantEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub discovery_id: String,
    pub generation: u64,
    pub kind: ProtectedMailDiscoveryGrantEventKind,
    pub event_nonce: String,
    pub request_digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_discovery_state,private)]
pub struct ProtectedMailDiscoveryState {
    #[primary_key]
    pub discovery_id: String,
    pub generation: u64,
    pub status: ProtectedMailDiscoveryStatus,
    pub reserved_operations: u64,
    pub reserved_control_bytes: u64,
    pub reserved_slots: u32,
    pub last_event_id: String,
}
#[table(accessor=protected_mail_discovery_event,private)]
pub struct ProtectedMailDiscoveryEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub discovery_id: String,
    pub generation: u64,
    pub status: ProtectedMailDiscoveryStatus,
    pub event_nonce: String,
    pub observation_digest: Option<String>,
    pub request_digest: String,
    pub actor: Identity,
    pub reserved_operations: u64,
    pub reserved_control_bytes: u64,
    pub reserved_slots: u32,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_discovery_observation,private)]
pub struct ProtectedMailDiscoveryObservation {
    #[primary_key]
    pub discovery_id: String,
    #[unique]
    pub head_event_id: String,
    pub head_id: String,
    pub head_generation: u64,
    pub previous_head_digest: String,
    pub previous_observation_id: Option<String>,
    pub input: ProtectedMailDiscoveryObservationInput,
    pub range: Option<ProtectedMailDiscoveryRange>,
    pub absent_uids: Vec<u32>,
    pub event_nonce: String,
    pub observation_digest: String,
    pub observation_bytes: u64,
    pub canonical: String,
    pub actor: Identity,
    pub recorded_at: Timestamp,
}
#[table(accessor=protected_mail_discovery_head,private)]
pub struct ProtectedMailDiscoveryHead {
    #[primary_key]
    pub id: String,
    pub owner: Identity,
    pub workspace: Identity,
    pub connection_id: u64,
    pub folder: String,
    pub generation: u64,
    pub digest: String,
    pub observation_id: String,
    pub uid_validity: String,
    pub uid_next: u32,
    pub updated_at: Timestamp,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailDiscoveryPreview {
    pub discovery_id: String,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub manifest_digest: String,
    pub manifest_bytes: u64,
    pub canonical: String,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailDiscoveryDispatch {
    pub discovery_id: String,
    pub manifest_digest: String,
    pub manifest_bytes: u64,
    pub canonical: String,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailDiscoveryReceipt {
    pub discovery_id: String,
    pub observation_digest: String,
    pub head_id: String,
    pub head_generation: u64,
}

fn sha(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}
fn grant_id(workspace: Identity, owner: Identity, connection: u64, nonce: &str) -> String {
    hash(
        "pear-mail-discovery-grant-v1",
        &[
            owner.to_hex().to_string(),
            workspace.to_hex().to_string(),
            connection.to_string(),
            nonce.into(),
        ],
    )
}
fn head_id(workspace: Identity, owner: Identity, connection: u64, folder: &str) -> String {
    format!(
        "mail-discovery-head:{}",
        hash(
            "pear-mail-discovery-head-v1",
            &[
                owner.to_hex().to_string(),
                workspace.to_hex().to_string(),
                connection.to_string(),
                folder.into()
            ]
        )
    )
}
fn owner_event_id(workspace: Identity, owner: Identity, nonce: &str) -> String {
    hash(
        "pear-mail-discovery-owner-event-v1",
        &[
            workspace.to_hex().to_string(),
            owner.to_hex().to_string(),
            nonce.into(),
        ],
    )
}
fn event_id(id: &str, generation: u64) -> String {
    hash(
        "pear-mail-discovery-event-v1",
        &[id.into(), generation.to_string()],
    )
}
fn head_event_id(id: &str, generation: u64) -> String {
    hash(
        "pear-mail-discovery-head-event-v1",
        &[id.into(), generation.to_string()],
    )
}
fn canonical_u32(value: &str) -> bool {
    value
        .parse::<u32>()
        .is_ok_and(|n| n > 0 && n.to_string() == value)
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn mailbox_valid(host: &str, port: u16, username: &str, folder: &str) -> bool {
    text(host, 253)
        && host.trim() == host
        && !host.chars().any(char::is_whitespace)
        && !host.contains(['/', '@', '?', '#'])
        && port > 0
        && text(username, 320)
        && text(folder, 512)
}
fn slots(mode: &ProtectedMailDiscoveryMode) -> u32 {
    match mode {
        ProtectedMailDiscoveryMode::Bootstrap => 0,
        ProtectedMailDiscoveryMode::NextWindow(w) => w.max_slots,
    }
}
fn valid_request(request: &ProtectedMailDiscoveryRequest) -> Result<(), String> {
    if request.connection_id == 0
        || !opaque(&request.runtime_id)
        || !opaque(&request.run_id)
        || !hex64(&request.event_nonce)
        || request.not_before_ms > SAFE
        || request.expires_at_ms > SAFE
        || request.expires_at_ms <= request.not_before_ms
        || request.expires_at_ms - request.not_before_ms > TTL
    {
        return Err(INVALID.into());
    }
    if let ProtectedMailDiscoveryMode::NextWindow(w) = &request.mode {
        if w.expected_cursor_generation == 0 || w.max_slots == 0 {
            return Err(INVALID.into());
        }
        if w.max_slots > 8 {
            return Err(LIMIT.into());
        }
    }
    Ok(())
}
fn window_bounds(
    mode: &ProtectedMailDiscoveryMode,
    cursor: Option<&ProtectedMailDiscoveryCursorBinding>,
) -> Result<Option<ProtectedMailDiscoveryRange>, String> {
    match (mode, cursor) {
        (ProtectedMailDiscoveryMode::Bootstrap, None) => Ok(None),
        (ProtectedMailDiscoveryMode::NextWindow(w), Some(c))
            if w.expected_cursor_generation == c.generation
                && w.max_slots >= 1
                && w.max_slots <= 8 =>
        {
            let from = c.last_uid.checked_add(1).ok_or(LIMIT)?;
            Ok(Some(ProtectedMailDiscoveryRange {
                from_uid: from,
                through_uid: (u64::from(c.last_uid) + u64::from(w.max_slots))
                    .min(u64::from(u32::MAX)) as u32,
            }))
        }
        _ => Err(INVALID.into()),
    }
}
fn cursor_json(c: &ProtectedMailDiscoveryCursorBinding) -> Value {
    json!({"id":c.id,"generation":c.generation.to_string(),"digest":c.digest,"uidValidity":c.uid_validity,"lastUid":c.last_uid})
}
fn head_json(h: &ProtectedMailDiscoveryHeadBinding) -> Value {
    json!({"id":h.id,"generation":h.generation.to_string(),"digest":h.digest,"observationId":h.observation_id,"uidValidity":h.uid_validity,"uidNext":h.uid_next})
}
fn manifest(row: &ProtectedMailDiscoveryGrant) -> Result<String, String> {
    let bounds = window_bounds(&row.request.mode, row.cursor.as_ref())?;
    let direction = match row.request.direction {
        ProtectedMailDirection::Received => "received",
        ProtectedMailDirection::Sent => "sent",
    };
    let value=canonical(&json!({"formatVersion":1,"kind":"mail.connector.discovery","profile":"imap.uid-discovery.v1","discoveryId":row.id,"eventNonce":row.request.event_nonce,"workspaceId":row.workspace.to_hex().to_string(),"ownerId":row.owner.to_hex().to_string(),
 "connection":{"id":row.request.connection_id.to_string(),"epoch":row.connection_epoch.to_string(),"snapshotDigest":row.snapshot_digest},"connector":{"identity":row.request.connector_identity.to_hex().to_string(),"runtimeId":row.request.runtime_id,"runId":row.request.run_id},
 "mailbox":{"host":row.host,"port":row.port,"username":row.username,"folder":row.folder,"direction":direction},"cursor":row.cursor.as_ref().map(cursor_json),"head":row.head.as_ref().map(head_json),
 "window":{"mode":if matches!(row.request.mode,ProtectedMailDiscoveryMode::Bootstrap){"bootstrap"}else{"next_window"},"maxSlots":slots(&row.request.mode),"fromUid":bounds.as_ref().map(|b|b.from_uid),"maxThroughUid":bounds.as_ref().map(|b|b.through_uid)},
 "notBeforeMs":row.request.not_before_ms,"expiresAtMs":row.request.expires_at_ms,"reservation":{"operations":1,"numericSlots":slots(&row.request.mode),"controlBytes":CONTROL}})).map_err(|_|INCONSISTENT)?;
    if value.len() > MAX_PLAN {
        return Err(LIMIT.into());
    }
    Ok(value)
}
fn issue_digest(
    request: &ProtectedMailDiscoveryRequest,
    epoch: u64,
    snapshot: &str,
    manifest: &str,
) -> String {
    let (mode, generation, count) = match &request.mode {
        ProtectedMailDiscoveryMode::Bootstrap => ("bootstrap", 0, 0),
        ProtectedMailDiscoveryMode::NextWindow(w) => {
            ("next_window", w.expected_cursor_generation, w.max_slots)
        }
    };
    hash(
        "pear-mail-discovery-issue-v1",
        &[
            request.connection_id.to_string(),
            request.connector_identity.to_hex().to_string(),
            request.runtime_id.clone(),
            request.run_id.clone(),
            match request.direction {
                ProtectedMailDirection::Received => "received".into(),
                ProtectedMailDirection::Sent => "sent".into(),
            },
            mode.into(),
            generation.to_string(),
            count.to_string(),
            request.not_before_ms.to_string(),
            request.expires_at_ms.to_string(),
            request.event_nonce.clone(),
            epoch.to_string(),
            snapshot.into(),
            manifest.into(),
        ],
    )
}
fn revoke_digest(id: &str, nonce: &str) -> String {
    hash("pear-mail-discovery-revoke-v1", &[id.into(), nonce.into()])
}
fn grant_shape(row: &ProtectedMailDiscoveryGrant) -> bool {
    if valid_request(&row.request).is_err()
        || row.id
            != grant_id(
                row.workspace,
                row.owner,
                row.request.connection_id,
                &row.request.event_nonce,
            )
        || row.connection_epoch == 0
        || !hex64(&row.snapshot_digest)
        || !mailbox_valid(&row.host, row.port, &row.username, &row.folder)
        || window_bounds(&row.request.mode, row.cursor.as_ref()).is_err()
    {
        return false;
    }
    if let Some(c) = &row.cursor {
        if c.id != cursor_id(row.workspace, row.request.connection_id, &row.folder)
            || c.generation == 0
            || !hex64(&c.digest)
            || !canonical_u32(&c.uid_validity)
            || c.last_uid == u32::MAX
        {
            return false;
        }
    }
    if let Some(h) = &row.head {
        if h.id
            != head_id(
                row.workspace,
                row.owner,
                row.request.connection_id,
                &row.folder,
            )
            || h.generation == 0
            || h.generation == u64::MAX
            || !hex64(&h.digest)
            || !hex64(&h.observation_id)
            || !canonical_u32(&h.uid_validity)
            || h.uid_next == 0
            || row
                .cursor
                .as_ref()
                .is_some_and(|c| c.uid_validity != h.uid_validity)
        {
            return false;
        }
    }
    true
}
fn checked_grant(
    ctx: &ReducerContext,
    row: ProtectedMailDiscoveryGrant,
) -> Result<(ProtectedMailDiscoveryGrant, bool), String> {
    let canonical = manifest(&row).map_err(|_| INCONSISTENT)?;
    let created = u64::try_from(row.created_at.to_micros_since_unix_epoch() / 1000)
        .map_err(|_| INCONSISTENT)?;
    if !grant_shape(&row)
        || row.workspace != ctx.identity()
        || row.canonical != canonical
        || row.manifest_bytes != canonical.len() as u64
        || row.manifest_digest != sha(&canonical)
        || row.issue_digest
            != issue_digest(
                &row.request,
                row.connection_epoch,
                &row.snapshot_digest,
                &row.manifest_digest,
            )
        || row.request.expires_at_ms <= created
        || row.request.expires_at_ms - created > TTL
    {
        return Err(INCONSISTENT.into());
    }
    let events = ctx
        .db
        .protected_mail_discovery_grant_event()
        .discovery_id()
        .filter(&row.id)
        .take(3)
        .collect::<Vec<_>>();
    if events.is_empty() || events.len() > 2 {
        return Err(INCONSISTENT.into());
    }
    let (mut issued, mut revoked) = (false, false);
    for event in events {
        if !hex64(&event.event_nonce)
            || event.id != owner_event_id(row.workspace, row.owner, &event.event_nonce)
            || event.actor != row.owner
        {
            return Err(INCONSISTENT.into());
        }
        match event.kind {
            ProtectedMailDiscoveryGrantEventKind::Issued
                if !issued
                    && event.generation == 1
                    && event.event_nonce == row.request.event_nonce
                    && event.request_digest == row.issue_digest
                    && event.created_at == row.created_at =>
            {
                issued = true
            }
            ProtectedMailDiscoveryGrantEventKind::Revoked
                if !revoked
                    && event.generation == 2
                    && event.event_nonce != row.request.event_nonce
                    && event.request_digest == revoke_digest(&row.id, &event.event_nonce)
                    && event.created_at >= row.created_at =>
            {
                revoked = true
            }
            _ => return Err(INCONSISTENT.into()),
        }
    }
    if !issued {
        return Err(INCONSISTENT.into());
    }
    Ok((row, revoked))
}
fn owned(ctx: &ReducerContext, id: &str) -> Result<(ProtectedMailDiscoveryGrant, bool), String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let row = ctx
        .db
        .protected_mail_discovery_grant()
        .id()
        .find(id.to_owned())
        .filter(|r| r.owner == ctx.sender())
        .ok_or(OWNER)?;
    checked_grant(ctx, row)
}
fn bound(ctx: &ReducerContext, id: &str) -> Result<(ProtectedMailDiscoveryGrant, bool), String> {
    if !hex64(id) || !service(ctx, ctx.sender(), Identity::from_byte_array([0; 32])) {
        return Err(SERVICE.into());
    }
    let row = ctx
        .db
        .protected_mail_discovery_grant()
        .id()
        .find(id.to_owned())
        .filter(|r| {
            r.request.connector_identity == ctx.sender() && service(ctx, ctx.sender(), r.owner)
        })
        .ok_or(SERVICE)?;
    checked_grant(ctx, row)
}
fn status_name(status: &ProtectedMailDiscoveryStatus) -> &'static str {
    match status {
        ProtectedMailDiscoveryStatus::Pending => "pending",
        ProtectedMailDiscoveryStatus::Dispatching => "dispatching",
        ProtectedMailDiscoveryStatus::Observed => "observed",
        ProtectedMailDiscoveryStatus::Failed => "failed",
        ProtectedMailDiscoveryStatus::Unknown => "unknown",
        ProtectedMailDiscoveryStatus::CancelledBeforeDispatch => "cancelled_before_dispatch",
    }
}
fn terminal(status: &ProtectedMailDiscoveryStatus) -> bool {
    !matches!(
        status,
        ProtectedMailDiscoveryStatus::Pending | ProtectedMailDiscoveryStatus::Dispatching
    )
}
fn lifecycle_digest(
    grant: &ProtectedMailDiscoveryGrant,
    event: &ProtectedMailDiscoveryEvent,
) -> String {
    hash(
        "pear-mail-discovery-lifecycle-v1",
        &[
            grant.id.clone(),
            grant.issue_digest.clone(),
            event.generation.to_string(),
            status_name(&event.status).into(),
            event.event_nonce.clone(),
            event.observation_digest.clone().unwrap_or_default(),
            event.actor.to_hex().to_string(),
            event.reserved_operations.to_string(),
            event.reserved_control_bytes.to_string(),
            event.reserved_slots.to_string(),
            event.created_at.to_micros_since_unix_epoch().to_string(),
        ],
    )
}
fn event_shape(grant: &ProtectedMailDiscoveryGrant, event: &ProtectedMailDiscoveryEvent) -> bool {
    let pending = event.status == ProtectedMailDiscoveryStatus::Pending;
    let cancelled = event.status == ProtectedMailDiscoveryStatus::CancelledBeforeDispatch;
    let spent = !pending && !cancelled;
    let generation = match event.status {
        ProtectedMailDiscoveryStatus::Pending => 1,
        ProtectedMailDiscoveryStatus::Dispatching
        | ProtectedMailDiscoveryStatus::CancelledBeforeDispatch => 2,
        _ => 3,
    };
    event.id == event_id(&grant.id, event.generation)
        && event.discovery_id == grant.id
        && event.generation == generation
        && event.actor
            == if pending {
                grant.owner
            } else {
                grant.request.connector_identity
            }
        && if pending || event.status == ProtectedMailDiscoveryStatus::Dispatching {
            event.event_nonce.is_empty()
        } else {
            hex64(&event.event_nonce)
        }
        && event.observation_digest.as_ref().is_some_and(|d| hex64(d))
            == (event.status == ProtectedMailDiscoveryStatus::Observed)
        && (event.status == ProtectedMailDiscoveryStatus::Observed
            || event.observation_digest.is_none())
        && event.reserved_operations == if spent { 1 } else { 0 }
        && event.reserved_control_bytes == if spent { CONTROL } else { 0 }
        && event.reserved_slots == if spent { slots(&grant.request.mode) } else { 0 }
        && event.request_digest == lifecycle_digest(grant, event)
        && event.created_at >= grant.created_at
}
fn checked_state(
    ctx: &ReducerContext,
    grant: &ProtectedMailDiscoveryGrant,
) -> Result<ProtectedMailDiscoveryState, String> {
    let row = ctx
        .db
        .protected_mail_discovery_state()
        .discovery_id()
        .find(grant.id.clone())
        .ok_or(INCONSISTENT)?;
    if row.generation == 0
        || row.generation > 3
        || row.last_event_id != event_id(&grant.id, row.generation)
        || ctx
            .db
            .protected_mail_discovery_event()
            .discovery_id()
            .filter(&grant.id)
            .take(4)
            .count()
            != row.generation as usize
    {
        return Err(INCONSISTENT.into());
    }
    let mut previous: Option<ProtectedMailDiscoveryEvent> = None;
    for generation in 1..=row.generation {
        let event = ctx
            .db
            .protected_mail_discovery_event()
            .id()
            .find(event_id(&grant.id, generation))
            .ok_or(INCONSISTENT)?;
        if !event_shape(grant, &event)
            || previous.as_ref().is_some_and(|p| {
                event.created_at < p.created_at
                    || (generation == 3 && p.status != ProtectedMailDiscoveryStatus::Dispatching)
            })
        {
            return Err(INCONSISTENT.into());
        }
        previous = Some(event);
    }
    let latest = previous.ok_or(INCONSISTENT)?;
    if row.status != latest.status
        || row.reserved_operations != latest.reserved_operations
        || row.reserved_control_bytes != latest.reserved_control_bytes
        || row.reserved_slots != latest.reserved_slots
    {
        return Err(INCONSISTENT.into());
    }
    let observation = ctx
        .db
        .protected_mail_discovery_observation()
        .discovery_id()
        .find(grant.id.clone());
    match (
        row.status == ProtectedMailDiscoveryStatus::Observed,
        observation,
    ) {
        (true, Some(o))
            if latest.event_nonce == o.event_nonce
                && latest.observation_digest.as_ref() == Some(&o.observation_digest)
                && latest.actor == o.actor
                && latest.created_at == o.recorded_at =>
        {
            ()
        }
        (false, None) => (),
        _ => return Err(INCONSISTENT.into()),
    }
    Ok(row)
}
fn write_state(
    ctx: &ReducerContext,
    grant: &ProtectedMailDiscoveryGrant,
    generation: u64,
    status: ProtectedMailDiscoveryStatus,
    nonce: &str,
    observation_digest: Option<String>,
) -> Result<(), String> {
    let spent = !matches!(
        status,
        ProtectedMailDiscoveryStatus::Pending
            | ProtectedMailDiscoveryStatus::CancelledBeforeDispatch
    );
    let mut event = ProtectedMailDiscoveryEvent {
        id: event_id(&grant.id, generation),
        discovery_id: grant.id.clone(),
        generation,
        status: status.clone(),
        event_nonce: nonce.into(),
        observation_digest,
        request_digest: String::new(),
        actor: ctx.sender(),
        reserved_operations: if spent { 1 } else { 0 },
        reserved_control_bytes: if spent { CONTROL } else { 0 },
        reserved_slots: if spent { slots(&grant.request.mode) } else { 0 },
        created_at: ctx.timestamp,
    };
    event.request_digest = lifecycle_digest(grant, &event);
    if !event_shape(grant, &event)
        || ctx
            .db
            .protected_mail_discovery_event()
            .id()
            .find(event.id.clone())
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    let row = ProtectedMailDiscoveryState {
        discovery_id: grant.id.clone(),
        generation,
        status,
        reserved_operations: event.reserved_operations,
        reserved_control_bytes: event.reserved_control_bytes,
        reserved_slots: event.reserved_slots,
        last_event_id: event.id.clone(),
    };
    ctx.db.protected_mail_discovery_event().insert(event);
    if generation == 1 {
        ctx.db.protected_mail_discovery_state().insert(row);
    } else {
        ctx.db
            .protected_mail_discovery_state()
            .discovery_id()
            .update(row);
    }
    Ok(())
}

fn derive_observation(
    grant: &ProtectedMailDiscoveryGrant,
    input: &ProtectedMailDiscoveryObservationInput,
) -> Result<(Option<ProtectedMailDiscoveryRange>, Vec<u32>), String> {
    if input.present_uids.len() > 8 {
        return Err(LIMIT.into());
    }
    if !canonical_u32(&input.uid_validity)
        || input.uid_next == 0
        || input.present_uids.windows(2).any(|p| p[0] >= p[1])
        || input
            .present_uids
            .iter()
            .any(|uid| *uid == 0 || *uid >= input.uid_next)
    {
        return Err(INVALID.into());
    }
    if grant
        .head
        .as_ref()
        .is_some_and(|h| h.uid_validity != input.uid_validity || h.uid_next > input.uid_next)
    {
        return Err(STALE.into());
    }
    let Some(cursor) = &grant.cursor else {
        if !input.present_uids.is_empty() {
            return Err(INVALID.into());
        }
        return Ok((None, vec![]));
    };
    if input.uid_validity != cursor.uid_validity || input.uid_next <= cursor.last_uid {
        return Err(STALE.into());
    }
    let bounds = window_bounds(&grant.request.mode, Some(cursor))?.ok_or(INCONSISTENT)?;
    if input.uid_next == bounds.from_uid {
        if !input.present_uids.is_empty() {
            return Err(INVALID.into());
        }
        return Ok((None, vec![]));
    }
    let range = ProtectedMailDiscoveryRange {
        from_uid: bounds.from_uid,
        through_uid: bounds.through_uid.min(input.uid_next - 1),
    };
    if input
        .present_uids
        .iter()
        .any(|uid| *uid < range.from_uid || *uid > range.through_uid)
    {
        return Err(INVALID.into());
    }
    let absent = (range.from_uid..=range.through_uid)
        .filter(|uid| input.present_uids.binary_search(uid).is_err())
        .collect();
    Ok((Some(range), absent))
}
fn observation_canonical(
    grant: &ProtectedMailDiscoveryGrant,
    row: &ProtectedMailDiscoveryObservation,
) -> Result<String, String> {
    canonical(&json!({"formatVersion":1,"kind":"mail.connector.discovery.observation","discoveryId":grant.id,"manifestDigest":grant.manifest_digest,"eventNonce":row.event_nonce,"recordedAtMs":u64::try_from(row.recorded_at.to_micros_since_unix_epoch()/1000).map_err(|_|INCONSISTENT)?,"uidValidity":row.input.uid_validity,"uidNext":row.input.uid_next,"range":row.range.as_ref().map(|r|json!({"fromUid":r.from_uid,"throughUid":r.through_uid})),"presentUids":row.input.present_uids,"absentUids":row.absent_uids,"head":{"id":row.head_id,"generation":row.head_generation.to_string(),"previousDigest":row.previous_head_digest,"previousObservationId":row.previous_observation_id}})).map_err(|_|INCONSISTENT.into())
}
fn checked_observation_local(
    ctx: &ReducerContext,
    row: ProtectedMailDiscoveryObservation,
) -> Result<
    (
        ProtectedMailDiscoveryObservation,
        ProtectedMailDiscoveryGrant,
    ),
    String,
> {
    let (grant, _) = checked_grant(
        ctx,
        ctx.db
            .protected_mail_discovery_grant()
            .id()
            .find(row.discovery_id.clone())
            .ok_or(INCONSISTENT)?,
    )?;
    let state = checked_state(ctx, &grant)?;
    let (range, absent) = derive_observation(&grant, &row.input).map_err(|_| INCONSISTENT)?;
    let canonical = observation_canonical(&grant, &row)?;
    let generation = grant
        .head
        .as_ref()
        .map_or(0, |h| h.generation)
        .checked_add(1)
        .ok_or(INCONSISTENT)?;
    if state.status != ProtectedMailDiscoveryStatus::Observed
        || state.generation != 3
        || row.head_id
            != head_id(
                grant.workspace,
                grant.owner,
                grant.request.connection_id,
                &grant.folder,
            )
        || row.head_generation != generation
        || row.head_event_id != head_event_id(&row.head_id, generation)
        || row.previous_head_digest
            != grant
                .head
                .as_ref()
                .map_or_else(String::new, |h| h.digest.clone())
        || row.previous_observation_id != grant.head.as_ref().map(|h| h.observation_id.clone())
        || row.range != range
        || row.absent_uids != absent
        || row.canonical != canonical
        || row.observation_bytes != canonical.len() as u64
        || row.observation_digest != sha(&canonical)
        || !hex64(&row.event_nonce)
        || row.actor != grant.request.connector_identity
        || row.recorded_at < grant.created_at
        || canonical.len() > 16384
    {
        return Err(INCONSISTENT.into());
    }
    let indexed = ctx
        .db
        .protected_mail_discovery_observation()
        .head_event_id()
        .find(row.head_event_id.clone())
        .ok_or(INCONSISTENT)?;
    if indexed.discovery_id != row.discovery_id {
        return Err(INCONSISTENT.into());
    }
    Ok((row, grant))
}
/// Local validation plus exactly one immediate predecessor; never walks history.
pub(super) fn checked_observation(
    ctx: &ReducerContext,
    row: ProtectedMailDiscoveryObservation,
) -> Result<
    (
        ProtectedMailDiscoveryObservation,
        ProtectedMailDiscoveryGrant,
    ),
    String,
> {
    let (row, grant) = checked_observation_local(ctx, row)?;
    if let Some(previous) = &grant.head {
        let (p, pg) = checked_observation_local(
            ctx,
            ctx.db
                .protected_mail_discovery_observation()
                .discovery_id()
                .find(previous.observation_id.clone())
                .ok_or(INCONSISTENT)?,
        )?;
        if p.head_id != row.head_id
            || p.head_generation != previous.generation
            || p.observation_digest != previous.digest
            || p.input.uid_validity != previous.uid_validity
            || p.input.uid_next != previous.uid_next
            || p.recorded_at > row.recorded_at
            || pg.owner != grant.owner
            || pg.workspace != grant.workspace
            || pg.request.connection_id != grant.request.connection_id
            || pg.folder != grant.folder
        {
            return Err(INCONSISTENT.into());
        }
    } else if row.head_generation != 1
        || !row.previous_head_digest.is_empty()
        || row.previous_observation_id.is_some()
    {
        return Err(INCONSISTENT.into());
    }
    Ok((row, grant))
}
fn checked_head(
    ctx: &ReducerContext,
    id: &str,
) -> Result<Option<ProtectedMailDiscoveryHeadBinding>, String> {
    let Some(head) = ctx
        .db
        .protected_mail_discovery_head()
        .id()
        .find(id.to_owned())
    else {
        if ctx
            .db
            .protected_mail_discovery_observation()
            .head_event_id()
            .find(head_event_id(id, 1))
            .is_some()
        {
            return Err(INCONSISTENT.into());
        }
        return Ok(None);
    };
    let (observation, grant) = checked_observation(
        ctx,
        ctx.db
            .protected_mail_discovery_observation()
            .discovery_id()
            .find(head.observation_id.clone())
            .ok_or(INCONSISTENT)?,
    )?;
    if head.id != id
        || head.id != observation.head_id
        || head.owner != grant.owner
        || head.workspace != grant.workspace
        || head.connection_id != grant.request.connection_id
        || head.folder != grant.folder
        || head.generation != observation.head_generation
        || head.digest != observation.observation_digest
        || head.uid_validity != observation.input.uid_validity
        || head.uid_next != observation.input.uid_next
        || head.updated_at != observation.recorded_at
    {
        return Err(INCONSISTENT.into());
    }
    Ok(Some(ProtectedMailDiscoveryHeadBinding {
        id: head.id,
        generation: head.generation,
        digest: head.digest,
        observation_id: head.observation_id,
        uid_validity: head.uid_validity,
        uid_next: head.uid_next,
    }))
}
fn live_mailbox(
    ctx: &ReducerContext,
    id: u64,
    owner: Identity,
    direction: &ProtectedMailDirection,
) -> Result<(MailConnection, String, u64, String), String> {
    if !human(ctx, owner) {
        return Err(STALE.into());
    }
    let connection = ctx
        .db
        .mail_connection()
        .id()
        .find(id)
        .filter(|c| c.owner == owner)
        .ok_or(STALE)?;
    let authority = checked_current_authority(ctx, id).map_err(|_| STALE)?;
    if authority.owner != owner {
        return Err(INCONSISTENT.into());
    }
    let folder = match direction {
        ProtectedMailDirection::Received => connection.inbox_folder.clone(),
        ProtectedMailDirection::Sent => connection.sent_folder.clone().ok_or(INVALID)?,
    };
    if !mailbox_valid(
        &connection.host,
        connection.port,
        &connection.username,
        &folder,
    ) {
        return Err(INVALID.into());
    }
    Ok((
        connection,
        folder,
        authority.epoch,
        authority.snapshot_digest,
    ))
}
fn cursor_binding(
    ctx: &ReducerContext,
    workspace: Identity,
    owner: Identity,
    connection: u64,
    folder: &str,
) -> Result<Option<ProtectedMailDiscoveryCursorBinding>, String> {
    let cursor =
        checked_cursor(ctx, &cursor_id(workspace, connection, folder)).map_err(|_| INCONSISTENT)?;
    let Some(c) = cursor else { return Ok(None) };
    if c.owner != owner || c.collection_id != connection || c.folder != folder {
        return Err(INCONSISTENT.into());
    }
    Ok(Some(ProtectedMailDiscoveryCursorBinding {
        id: c.id,
        generation: c.generation,
        digest: c.digest,
        uid_validity: c.uid_validity,
        last_uid: c.last_uid,
    }))
}
fn current(
    ctx: &ReducerContext,
    grant: &ProtectedMailDiscoveryGrant,
    revoked: bool,
    active: bool,
) -> Result<(), String> {
    if revoked || !service(ctx, grant.request.connector_identity, grant.owner) {
        return Err(STALE.into());
    }
    let (connection, folder, epoch, snapshot) = live_mailbox(
        ctx,
        grant.request.connection_id,
        grant.owner,
        &grant.request.direction,
    )?;
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if (active && now < grant.request.not_before_ms)
        || now >= grant.request.expires_at_ms
        || epoch != grant.connection_epoch
        || snapshot != grant.snapshot_digest
        || connection.host != grant.host
        || connection.port != grant.port
        || connection.username != grant.username
        || folder != grant.folder
        || cursor_binding(ctx, grant.workspace, grant.owner, connection.id, &folder)?
            != grant.cursor
        || checked_head(
            ctx,
            &head_id(grant.workspace, grant.owner, connection.id, &folder),
        )? != grant.head
    {
        return Err(STALE.into());
    }
    Ok(())
}
/// A completed observation is retained data, independently of its probe grant's
/// expiry/revocation. New checkpoint authority must bind the completed head,
/// rather than the probe's predecessor head, and still match its original cursor.
pub(super) fn require_current_completed_observation(
    ctx: &ReducerContext,
    observation: &ProtectedMailDiscoveryObservation,
    grant: &ProtectedMailDiscoveryGrant,
) -> Result<(), String> {
    if !service(ctx, grant.request.connector_identity, grant.owner) {
        return Err(STALE.into());
    }
    let (connection, folder, epoch, snapshot) = live_mailbox(
        ctx, grant.request.connection_id, grant.owner, &grant.request.direction,
    )?;
    let completed = ProtectedMailDiscoveryHeadBinding {
        id: observation.head_id.clone(),
        generation: observation.head_generation,
        digest: observation.observation_digest.clone(),
        observation_id: observation.discovery_id.clone(),
        uid_validity: observation.input.uid_validity.clone(),
        uid_next: observation.input.uid_next,
    };
    if epoch != grant.connection_epoch || snapshot != grant.snapshot_digest
        || connection.host != grant.host || connection.port != grant.port
        || connection.username != grant.username || folder != grant.folder
        || cursor_binding(ctx, grant.workspace, grant.owner, connection.id, &folder)? != grant.cursor
        || checked_head(ctx, &observation.head_id)? != Some(completed)
    {
        return Err(STALE.into());
    }
    Ok(())
}
fn preview(
    ctx: &ReducerContext,
    request: ProtectedMailDiscoveryRequest,
) -> Result<ProtectedMailDiscoveryGrant, String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    if !ctx
        .db
        .mail_connection()
        .id()
        .find(request.connection_id)
        .is_some_and(|c| c.owner == ctx.sender())
    {
        return Err(OWNER.into());
    }
    valid_request(&request)?;
    if !service(ctx, request.connector_identity, ctx.sender()) {
        return Err(STALE.into());
    }
    let (connection, folder, epoch, snapshot) =
        live_mailbox(ctx, request.connection_id, ctx.sender(), &request.direction)?;
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if request.expires_at_ms <= now || request.expires_at_ms - now > TTL {
        return Err(STALE.into());
    }
    let cursor = cursor_binding(
        ctx,
        ctx.identity(),
        connection.owner,
        connection.id,
        &folder,
    )?;
    match (&request.mode, &cursor) {
        (ProtectedMailDiscoveryMode::Bootstrap, None) => (),
        (ProtectedMailDiscoveryMode::NextWindow(w), Some(c))
            if w.expected_cursor_generation == c.generation =>
        {
            ()
        }
        _ => return Err(STALE.into()),
    }
    window_bounds(&request.mode, cursor.as_ref())?;
    let head = checked_head(
        ctx,
        &head_id(ctx.identity(), connection.owner, connection.id, &folder),
    )?;
    if head.as_ref().is_some_and(|h| h.generation == u64::MAX) {
        return Err(LIMIT.into());
    }
    if head
        .as_ref()
        .zip(cursor.as_ref())
        .is_some_and(|(h, c)| h.uid_validity != c.uid_validity)
    {
        return Err(STALE.into());
    }
    let mut row = ProtectedMailDiscoveryGrant {
        id: grant_id(
            ctx.identity(),
            connection.owner,
            connection.id,
            &request.event_nonce,
        ),
        owner: connection.owner,
        workspace: ctx.identity(),
        request,
        connection_epoch: epoch,
        snapshot_digest: snapshot,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        folder,
        cursor,
        head,
        manifest_digest: String::new(),
        manifest_bytes: 0,
        canonical: String::new(),
        issue_digest: String::new(),
        created_at: ctx.timestamp,
    };
    row.canonical = manifest(&row)?;
    row.manifest_bytes = row.canonical.len() as u64;
    row.manifest_digest = sha(&row.canonical);
    row.issue_digest = issue_digest(
        &row.request,
        row.connection_epoch,
        &row.snapshot_digest,
        &row.manifest_digest,
    );
    if !grant_shape(&row) {
        return Err(INVALID.into());
    }
    Ok(row)
}
fn preview_dto(row: ProtectedMailDiscoveryGrant) -> ProtectedMailDiscoveryPreview {
    ProtectedMailDiscoveryPreview {
        discovery_id: row.id,
        connection_epoch: row.connection_epoch,
        snapshot_digest: row.snapshot_digest,
        manifest_digest: row.manifest_digest,
        manifest_bytes: row.manifest_bytes,
        canonical: row.canonical,
    }
}
#[procedure]
pub fn review_protected_mail_discovery(
    ctx: &mut ProcedureContext,
    request: ProtectedMailDiscoveryRequest,
) -> Result<ProtectedMailDiscoveryPreview, String> {
    ctx.try_with_tx(|tx| {
        preview(tx.as_ref(), request.clone())
            .map(preview_dto)
            .map_err(fixed_error)
    })
}
#[reducer]
pub fn issue_protected_mail_discovery(
    ctx: &ReducerContext,
    request: ProtectedMailDiscoveryRequest,
    expected_epoch: u64,
    expected_snapshot_digest: String,
    expected_manifest_digest: String,
) -> Result<(), String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let id = grant_id(
        ctx.identity(),
        ctx.sender(),
        request.connection_id,
        &request.event_nonce,
    );
    if let Some(old) = ctx
        .db
        .protected_mail_discovery_grant()
        .id()
        .find(id.clone())
    {
        if old.owner != ctx.sender() {
            return Err(OWNER.into());
        }
        let (old, _) = checked_grant(ctx, old)?;
        checked_state(ctx, &old)?;
        if old.issue_digest
            != issue_digest(
                &request,
                expected_epoch,
                &expected_snapshot_digest,
                &expected_manifest_digest,
            )
        {
            return Err(CONFLICT.into());
        }
        return Ok(());
    }
    let row = preview(ctx, request)?;
    if expected_epoch == 0 || !hex64(&expected_snapshot_digest) || !hex64(&expected_manifest_digest)
    {
        return Err(INVALID.into());
    }
    if row.connection_epoch != expected_epoch
        || row.snapshot_digest != expected_snapshot_digest
        || row.manifest_digest != expected_manifest_digest
    {
        return Err(STALE.into());
    }
    if ctx
        .db
        .protected_mail_discovery_grant_event()
        .id()
        .find(owner_event_id(
            row.workspace,
            row.owner,
            &row.request.event_nonce,
        ))
        .is_some()
    {
        return Err(CONFLICT.into());
    }
    if ctx
        .db
        .protected_mail_discovery_grant_event()
        .discovery_id()
        .filter(&id)
        .next()
        .is_some()
        || ctx
            .db
            .protected_mail_discovery_state()
            .discovery_id()
            .find(id.clone())
            .is_some()
        || ctx
            .db
            .protected_mail_discovery_event()
            .discovery_id()
            .filter(&id)
            .next()
            .is_some()
        || ctx
            .db
            .protected_mail_discovery_observation()
            .discovery_id()
            .find(id.clone())
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    ctx.db
        .protected_mail_discovery_grant_event()
        .insert(ProtectedMailDiscoveryGrantEvent {
            id: owner_event_id(row.workspace, row.owner, &row.request.event_nonce),
            discovery_id: id,
            generation: 1,
            kind: ProtectedMailDiscoveryGrantEventKind::Issued,
            event_nonce: row.request.event_nonce.clone(),
            request_digest: row.issue_digest.clone(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    write_state(
        ctx,
        &row,
        1,
        ProtectedMailDiscoveryStatus::Pending,
        "",
        None,
    )?;
    ctx.db.protected_mail_discovery_grant().insert(row);
    Ok(())
}
#[reducer]
pub fn revoke_protected_mail_discovery(
    ctx: &ReducerContext,
    discovery_id: String,
    event_nonce: String,
) -> Result<(), String> {
    let (grant, revoked) = owned(ctx, &discovery_id)?;
    checked_state(ctx, &grant)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    let id = owner_event_id(grant.workspace, grant.owner, &event_nonce);
    let request_digest = revoke_digest(&discovery_id, &event_nonce);
    if let Some(old) = ctx
        .db
        .protected_mail_discovery_grant_event()
        .id()
        .find(id.clone())
    {
        if old.discovery_id == discovery_id
            && old.kind == ProtectedMailDiscoveryGrantEventKind::Revoked
            && old.request_digest == request_digest
        {
            return Ok(());
        }
        return Err(CONFLICT.into());
    }
    if revoked {
        return Err(CONFLICT.into());
    }
    ctx.db
        .protected_mail_discovery_grant_event()
        .insert(ProtectedMailDiscoveryGrantEvent {
            id,
            discovery_id,
            generation: 2,
            kind: ProtectedMailDiscoveryGrantEventKind::Revoked,
            event_nonce,
            request_digest,
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    Ok(())
}
fn begin(ctx: &ReducerContext, id: &str) -> Result<ProtectedMailDiscoveryDispatch, String> {
    let (grant, revoked) = bound(ctx, id)?;
    let state = checked_state(ctx, &grant)?;
    if state.status != ProtectedMailDiscoveryStatus::Pending {
        return Err(CONSUMED.into());
    }
    current(ctx, &grant, revoked, true)?;
    write_state(
        ctx,
        &grant,
        2,
        ProtectedMailDiscoveryStatus::Dispatching,
        "",
        None,
    )?;
    Ok(ProtectedMailDiscoveryDispatch {
        discovery_id: grant.id,
        manifest_digest: grant.manifest_digest,
        manifest_bytes: grant.manifest_bytes,
        canonical: grant.canonical,
    })
}
#[procedure]
pub fn begin_protected_mail_discovery_dispatch(
    ctx: &mut ProcedureContext,
    discovery_id: String,
) -> Result<ProtectedMailDiscoveryDispatch, String> {
    ctx.try_with_tx(|tx| begin(tx.as_ref(), &discovery_id).map_err(fixed_error))
}
fn receipt(row: &ProtectedMailDiscoveryObservation) -> ProtectedMailDiscoveryReceipt {
    ProtectedMailDiscoveryReceipt {
        discovery_id: row.discovery_id.clone(),
        observation_digest: row.observation_digest.clone(),
        head_id: row.head_id.clone(),
        head_generation: row.head_generation,
    }
}
fn complete(
    ctx: &ReducerContext,
    id: &str,
    nonce: &str,
    input: &ProtectedMailDiscoveryObservationInput,
) -> Result<ProtectedMailDiscoveryReceipt, String> {
    let (grant, revoked) = bound(ctx, id)?;
    if let Some(old) = ctx
        .db
        .protected_mail_discovery_observation()
        .discovery_id()
        .find(id.to_owned())
    {
        if old.event_nonce != nonce || old.input != *input {
            return Err(CONFLICT.into());
        }
        return checked_observation(ctx, old).map(|(r, _)| receipt(&r));
    }
    if !hex64(nonce) {
        return Err(INVALID.into());
    }
    let state = checked_state(ctx, &grant)?;
    if state.status != ProtectedMailDiscoveryStatus::Dispatching {
        return Err(CONSUMED.into());
    }
    current(ctx, &grant, revoked, true)?;
    let (range, absent) = derive_observation(&grant, input)?;
    let hid = head_id(
        grant.workspace,
        grant.owner,
        grant.request.connection_id,
        &grant.folder,
    );
    let generation = grant
        .head
        .as_ref()
        .map_or(0, |h| h.generation)
        .checked_add(1)
        .ok_or(LIMIT)?;
    let heid = head_event_id(&hid, generation);
    if ctx
        .db
        .protected_mail_discovery_observation()
        .head_event_id()
        .find(heid.clone())
        .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    let mut row = ProtectedMailDiscoveryObservation {
        discovery_id: id.into(),
        head_event_id: heid,
        head_id: hid.clone(),
        head_generation: generation,
        previous_head_digest: grant
            .head
            .as_ref()
            .map_or_else(String::new, |h| h.digest.clone()),
        previous_observation_id: grant.head.as_ref().map(|h| h.observation_id.clone()),
        input: input.clone(),
        range,
        absent_uids: absent,
        event_nonce: nonce.into(),
        observation_digest: String::new(),
        observation_bytes: 0,
        canonical: String::new(),
        actor: ctx.sender(),
        recorded_at: ctx.timestamp,
    };
    row.canonical = observation_canonical(&grant, &row)?;
    if row.canonical.len() > 16384 {
        return Err(LIMIT.into());
    }
    row.observation_bytes = row.canonical.len() as u64;
    row.observation_digest = sha(&row.canonical);
    let head = ProtectedMailDiscoveryHead {
        id: hid,
        owner: grant.owner,
        workspace: grant.workspace,
        connection_id: grant.request.connection_id,
        folder: grant.folder.clone(),
        generation,
        digest: row.observation_digest.clone(),
        observation_id: row.discovery_id.clone(),
        uid_validity: row.input.uid_validity.clone(),
        uid_next: row.input.uid_next,
        updated_at: ctx.timestamp,
    };
    let result = receipt(&row);
    ctx.db.protected_mail_discovery_observation().insert(row);
    write_state(
        ctx,
        &grant,
        3,
        ProtectedMailDiscoveryStatus::Observed,
        nonce,
        Some(result.observation_digest.clone()),
    )?;
    if grant.head.is_some() {
        ctx.db.protected_mail_discovery_head().id().update(head);
    } else {
        ctx.db.protected_mail_discovery_head().insert(head);
    }
    Ok(result)
}
#[procedure]
pub fn complete_protected_mail_discovery(
    ctx: &mut ProcedureContext,
    discovery_id: String,
    event_nonce: String,
    observation: ProtectedMailDiscoveryObservationInput,
) -> Result<ProtectedMailDiscoveryReceipt, String> {
    ctx.try_with_tx(|tx| {
        complete(tx.as_ref(), &discovery_id, &event_nonce, &observation).map_err(fixed_error)
    })
}
fn outcome_status(outcome: &ProtectedMailDiscoveryOutcome) -> ProtectedMailDiscoveryStatus {
    match outcome {
        ProtectedMailDiscoveryOutcome::Failed => ProtectedMailDiscoveryStatus::Failed,
        ProtectedMailDiscoveryOutcome::Unknown => ProtectedMailDiscoveryStatus::Unknown,
        ProtectedMailDiscoveryOutcome::CancelledBeforeDispatch => {
            ProtectedMailDiscoveryStatus::CancelledBeforeDispatch
        }
    }
}
fn permitted_outcome(
    current: &ProtectedMailDiscoveryStatus,
    desired: &ProtectedMailDiscoveryStatus,
) -> bool {
    (*current == ProtectedMailDiscoveryStatus::Pending
        && *desired == ProtectedMailDiscoveryStatus::CancelledBeforeDispatch)
        || (*current == ProtectedMailDiscoveryStatus::Dispatching
            && matches!(
                desired,
                ProtectedMailDiscoveryStatus::Failed | ProtectedMailDiscoveryStatus::Unknown
            ))
}
#[reducer]
pub fn finish_protected_mail_discovery_dispatch(
    ctx: &ReducerContext,
    discovery_id: String,
    outcome: ProtectedMailDiscoveryOutcome,
    event_nonce: String,
) -> Result<(), String> {
    let (grant, _) = bound(ctx, &discovery_id)?;
    let state = checked_state(ctx, &grant)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    let desired = outcome_status(&outcome);
    if terminal(&state.status) {
        let event = ctx
            .db
            .protected_mail_discovery_event()
            .id()
            .find(state.last_event_id)
            .ok_or(INCONSISTENT)?;
        if state.status == desired && event.event_nonce == event_nonce {
            return Ok(());
        }
        return Err(CONFLICT.into());
    }
    if !permitted_outcome(&state.status, &desired) {
        return Err(INVALID.into());
    }
    write_state(
        ctx,
        &grant,
        state.generation + 1,
        desired,
        &event_nonce,
        None,
    )
}
fn fixed_error(error: String) -> String {
    match error.as_str() {
        INVALID | INCONSISTENT | OWNER | SERVICE | CONFLICT | STALE | CONSUMED | LIMIT => error,
        _ => INCONSISTENT.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> ProtectedMailDiscoveryGrant {
        ProtectedMailDiscoveryGrant {
            id: "a".repeat(64),
            owner: Identity::from_byte_array([0xdd; 32]),
            workspace: Identity::from_byte_array([0xcc; 32]),
            request: ProtectedMailDiscoveryRequest {
                connection_id: 9_007_199_254_740_993,
                connector_identity: Identity::from_byte_array([0xff; 32]),
                runtime_id: "fixture-runtime".into(),
                run_id: "fixture-run".into(),
                direction: ProtectedMailDirection::Received,
                mode: ProtectedMailDiscoveryMode::NextWindow(ProtectedMailDiscoveryNextWindow {
                    expected_cursor_generation: u64::MAX,
                    max_slots: 8,
                }),
                not_before_ms: 1_700_000_000_000,
                expires_at_ms: 1_700_003_600_000,
                event_nonce: "b".repeat(64),
            },
            connection_epoch: u64::MAX,
            snapshot_digest: "e".repeat(64),
            host: "imap.example.test".into(),
            port: 993,
            username: "fixture@example.test".into(),
            folder: "受信🍐e\u{301}\"\\\u{2028}".into(),
            cursor: Some(ProtectedMailDiscoveryCursorBinding {
                id: format!("mail-connector-cursor:{}", "1".repeat(64)),
                generation: u64::MAX,
                digest: "2".repeat(64),
                uid_validity: u32::MAX.to_string(),
                last_uid: u32::MAX - 2,
            }),
            head: Some(ProtectedMailDiscoveryHeadBinding {
                id: format!("mail-discovery-head:{}", "3".repeat(64)),
                generation: u64::MAX,
                digest: "4".repeat(64),
                observation_id: "5".repeat(64),
                uid_validity: u32::MAX.to_string(),
                uid_next: 1,
            }),
            manifest_digest: String::new(),
            manifest_bytes: 0,
            canonical: String::new(),
            issue_digest: String::new(),
            created_at: Timestamp::from_micros_since_unix_epoch(1_700_000_000_000_000),
        }
    }
    fn operational() -> ProtectedMailDiscoveryGrant {
        let mut row = fixture();
        row.id = grant_id(
            row.workspace,
            row.owner,
            row.request.connection_id,
            &row.request.event_nonce,
        );
        row.cursor = Some(ProtectedMailDiscoveryCursorBinding {
            id: cursor_id(row.workspace, row.request.connection_id, &row.folder),
            generation: 4,
            digest: "2".repeat(64),
            uid_validity: "7".into(),
            last_uid: 41,
        });
        row.request.mode =
            ProtectedMailDiscoveryMode::NextWindow(ProtectedMailDiscoveryNextWindow {
                expected_cursor_generation: 4,
                max_slots: 8,
            });
        row.head = Some(ProtectedMailDiscoveryHeadBinding {
            id: head_id(
                row.workspace,
                row.owner,
                row.request.connection_id,
                &row.folder,
            ),
            generation: 2,
            digest: "4".repeat(64),
            observation_id: "5".repeat(64),
            uid_validity: "7".into(),
            uid_next: 40,
        });
        row.canonical = manifest(&row).unwrap();
        row.manifest_bytes = row.canonical.len() as u64;
        row.manifest_digest = sha(&row.canonical);
        row.issue_digest = issue_digest(
            &row.request,
            row.connection_epoch,
            &row.snapshot_digest,
            &row.manifest_digest,
        );
        row
    }
    fn input(next: u32, present: &[u32]) -> ProtectedMailDiscoveryObservationInput {
        ProtectedMailDiscoveryObservationInput {
            uid_validity: "7".into(),
            uid_next: next,
            present_uids: present.into(),
        }
    }
    fn event(
        row: &ProtectedMailDiscoveryGrant,
        status: ProtectedMailDiscoveryStatus,
    ) -> ProtectedMailDiscoveryEvent {
        let generation = match status {
            ProtectedMailDiscoveryStatus::Pending => 1,
            ProtectedMailDiscoveryStatus::Dispatching
            | ProtectedMailDiscoveryStatus::CancelledBeforeDispatch => 2,
            _ => 3,
        };
        let pending = status == ProtectedMailDiscoveryStatus::Pending;
        let dispatch = status == ProtectedMailDiscoveryStatus::Dispatching;
        let cancelled = status == ProtectedMailDiscoveryStatus::CancelledBeforeDispatch;
        let mut e = ProtectedMailDiscoveryEvent {
            id: event_id(&row.id, generation),
            discovery_id: row.id.clone(),
            generation,
            event_nonce: if pending || dispatch {
                String::new()
            } else {
                "6".repeat(64)
            },
            observation_digest: if status == ProtectedMailDiscoveryStatus::Observed {
                Some("7".repeat(64))
            } else {
                None
            },
            status,
            request_digest: String::new(),
            actor: if pending {
                row.owner
            } else {
                row.request.connector_identity
            },
            reserved_operations: if pending || cancelled { 0 } else { 1 },
            reserved_control_bytes: if pending || cancelled { 0 } else { CONTROL },
            reserved_slots: if pending || cancelled {
                0
            } else {
                slots(&row.request.mode)
            },
            created_at: row.created_at,
        };
        e.request_digest = lifecycle_digest(row, &e);
        e
    }
    #[test]
    fn next_window_canonical_matches_independent_python_and_typescript_golden() {
        let text = manifest(&fixture()).unwrap();
        assert_eq!(text.len(), 1661);
        assert_eq!(
            sha(&text),
            "94c2cf538ad1b7d3c1273fc2e38dab5942a99f9567a0e5ea34e8f89dc692141f"
        );
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 16);
        assert_eq!(value["head"]["uidNext"], 1);
        assert_eq!(value["cursor"]["generation"], u64::MAX.to_string());
    }
    #[test]
    fn bootstrap_has_explicit_nulls_zero_slots_and_independent_golden() {
        let mut row = fixture();
        row.request.mode = ProtectedMailDiscoveryMode::Bootstrap;
        row.cursor = None;
        row.head = None;
        let text = manifest(&row).unwrap();
        assert_eq!(text.len(), 1073);
        assert_eq!(
            sha(&text),
            "f2236c40a5781d0795a7f3169f6fa2385bf9794eab67ea5aa6996601f7181a43"
        );
        let value: Value = serde_json::from_str(&text).unwrap();
        assert!(
            value["cursor"].is_null()
                && value["head"].is_null()
                && value["window"]["fromUid"].is_null()
        );
        assert_eq!(
            value["reservation"],
            json!({"operations":1,"numericSlots":0,"controlBytes":65536})
        );
    }
    #[test]
    fn widened_window_arithmetic_clips_without_wrap_and_rejects_exhaustion() {
        let mut row = fixture();
        assert_eq!(
            window_bounds(&row.request.mode, row.cursor.as_ref()).unwrap(),
            Some(ProtectedMailDiscoveryRange {
                from_uid: u32::MAX - 1,
                through_uid: u32::MAX
            })
        );
        row.cursor.as_mut().unwrap().last_uid = u32::MAX;
        assert_eq!(
            window_bounds(&row.request.mode, row.cursor.as_ref()).unwrap_err(),
            LIMIT
        );
        row.cursor.as_mut().unwrap().last_uid = 0;
        assert_eq!(
            window_bounds(&row.request.mode, row.cursor.as_ref())
                .unwrap()
                .unwrap()
                .from_uid,
            1
        );
        assert!(
            window_bounds(&ProtectedMailDiscoveryMode::Bootstrap, row.cursor.as_ref()).is_err()
        );
    }
    #[test]
    fn bootstrap_observes_no_range_or_absence_even_at_extreme_uidnext() {
        let mut row = operational();
        row.request.mode = ProtectedMailDiscoveryMode::Bootstrap;
        row.cursor = None;
        row.head = None;
        for next in [1, u32::MAX] {
            assert_eq!(
                derive_observation(&row, &input(next, &[])).unwrap(),
                (None, vec![])
            );
        }
        assert_eq!(
            derive_observation(&row, &input(2, &[1])).unwrap_err(),
            INVALID
        );
    }
    #[test]
    fn sparse_complete_window_derives_exact_absent_complement_and_horizon() {
        let row = operational();
        assert_eq!(
            derive_observation(&row, &input(45, &[42, 44])).unwrap(),
            (
                Some(ProtectedMailDiscoveryRange {
                    from_uid: 42,
                    through_uid: 44
                }),
                vec![43]
            )
        );
        assert_eq!(
            derive_observation(&row, &input(45, &[])).unwrap().1,
            vec![42, 43, 44]
        );
        assert_eq!(
            derive_observation(&row, &input(100, &[42, 49])).unwrap().1,
            vec![43, 44, 45, 46, 47, 48]
        );
    }
    #[test]
    fn empty_window_is_none_and_future_foreign_or_rollback_uids_never_become_absent() {
        let row = operational();
        assert_eq!(
            derive_observation(&row, &input(42, &[])).unwrap(),
            (None, vec![])
        );
        assert_eq!(
            derive_observation(&row, &input(41, &[])).unwrap_err(),
            STALE
        );
        assert_eq!(
            derive_observation(&row, &input(43, &[41])).unwrap_err(),
            INVALID
        );
        assert_eq!(
            derive_observation(&row, &input(43, &[43])).unwrap_err(),
            INVALID
        );
        assert_eq!(
            derive_observation(&row, &input(100, &[50])).unwrap_err(),
            INVALID
        );
    }
    #[test]
    fn independent_head_and_cursor_minima_apply_without_requiring_head_ahead() {
        let mut row = operational();
        row.head.as_mut().unwrap().uid_next = 1;
        assert!(grant_shape(&row));
        assert!(derive_observation(&row, &input(42, &[])).is_ok());
        row.head.as_mut().unwrap().uid_next = 100;
        assert_eq!(
            derive_observation(&row, &input(99, &[])).unwrap_err(),
            STALE
        );
        assert!(derive_observation(&row, &input(100, &[])).is_ok());
        let mut wrong = input(100, &[]);
        wrong.uid_validity = "8".into();
        assert_eq!(derive_observation(&row, &wrong).unwrap_err(), STALE);
    }
    #[test]
    fn declaration_rejects_noncanonical_duplicate_unsorted_and_unbounded_sets() {
        let row = operational();
        for present in [
            vec![42, 42],
            vec![44, 42],
            vec![0],
            vec![1],
            vec![42, 43, 44, 45, 46, 47, 48, 49, 50],
        ] {
            assert!(derive_observation(&row, &input(100, &present)).is_err());
        }
        for validity in ["0", "01", "4294967296", "+7", " 7"] {
            let mut i = input(100, &[]);
            i.uid_validity = validity.into();
            assert_eq!(derive_observation(&row, &i).unwrap_err(), INVALID);
        }
        assert_eq!(
            derive_observation(&row, &input(0, &[])).unwrap_err(),
            INVALID
        );
    }
    #[test]
    fn closed_request_and_mailbox_byte_and_control_limits_match_selection() {
        let row = operational();
        assert!(valid_request(&row.request).is_ok());
        assert!(mailbox_valid(
            "imap.example.test",
            993,
            "\u{feff}user",
            "受信🍐"
        ));
        for host in ["a/b", "a@b", "a?b", "a#b", "a b", "a\u{2028}b"] {
            assert!(!mailbox_valid(host, 993, "user", "INBOX"));
        }
        assert!(!mailbox_valid("imap.example.test", 0, "user", "INBOX"));
        assert!(!mailbox_valid(
            "imap.example.test",
            993,
            "user\u{85}",
            "INBOX"
        ));
        assert!(!mailbox_valid(
            "imap.example.test",
            993,
            "user",
            &"é".repeat(257)
        ));
        for field in 0..5 {
            let mut r = row.request.clone();
            match field {
                0 => r.expires_at_ms = r.not_before_ms,
                1 => r.expires_at_ms += 1,
                2 => r.event_nonce = "A".repeat(64),
                3 => r.runtime_id = "model chosen".into(),
                _ => {
                    r.mode =
                        ProtectedMailDiscoveryMode::NextWindow(ProtectedMailDiscoveryNextWindow {
                            expected_cursor_generation: 0,
                            max_slots: 8,
                        })
                }
            }
            assert!(valid_request(&r).is_err());
        }
    }
    #[test]
    fn identity_and_history_keys_are_domain_separated_and_head_has_no_epoch_namespace() {
        let row = operational();
        let id = head_id(
            row.workspace,
            row.owner,
            row.request.connection_id,
            &row.folder,
        );
        assert_eq!(
            id,
            head_id(
                row.workspace,
                row.owner,
                row.request.connection_id,
                &row.folder
            )
        );
        assert_ne!(
            id,
            head_id(
                row.workspace,
                row.owner,
                row.request.connection_id,
                &row.folder.to_uppercase()
            )
        );
        assert_ne!(
            row.id,
            grant_id(
                row.workspace,
                Identity::from_byte_array([1; 32]),
                row.request.connection_id,
                &row.request.event_nonce
            )
        );
        assert_ne!(head_event_id(&id, 1), head_event_id(&id, 2));
        assert_ne!(event_id(&row.id, 1), head_event_id(&row.id, 1));
        assert_ne!(
            owner_event_id(row.workspace, row.owner, "a"),
            owner_event_id(row.workspace, row.owner, "b")
        );
    }
    #[test]
    fn lifecycle_has_one_release_terminal_outcomes_and_full_spent_reservation() {
        let row = operational();
        let statuses = [
            ProtectedMailDiscoveryStatus::Pending,
            ProtectedMailDiscoveryStatus::Dispatching,
            ProtectedMailDiscoveryStatus::Observed,
            ProtectedMailDiscoveryStatus::Failed,
            ProtectedMailDiscoveryStatus::Unknown,
            ProtectedMailDiscoveryStatus::CancelledBeforeDispatch,
        ];
        for status in &statuses {
            let e = event(&row, status.clone());
            assert!(event_shape(&row, &e));
            assert_eq!(
                terminal(status),
                !matches!(
                    status,
                    ProtectedMailDiscoveryStatus::Pending
                        | ProtectedMailDiscoveryStatus::Dispatching
                )
            );
        }
        for from in &statuses {
            for to in &statuses {
                assert_eq!(
                    permitted_outcome(from, to),
                    (*from == ProtectedMailDiscoveryStatus::Pending
                        && *to == ProtectedMailDiscoveryStatus::CancelledBeforeDispatch)
                        || (*from == ProtectedMailDiscoveryStatus::Dispatching
                            && matches!(
                                to,
                                ProtectedMailDiscoveryStatus::Failed
                                    | ProtectedMailDiscoveryStatus::Unknown
                            ))
                );
            }
        }
        for field in 0..6 {
            let mut e = event(&row, ProtectedMailDiscoveryStatus::Observed);
            match field {
                0 => e.reserved_control_bytes -= 1,
                1 => e.reserved_operations = 0,
                2 => e.reserved_slots -= 1,
                3 => e.generation = 2,
                4 => e.actor = row.owner,
                _ => e.observation_digest = None,
            }
            e.request_digest = lifecycle_digest(&row, &e);
            assert!(!event_shape(&row, &e));
        }
    }
    #[test]
    fn exact_issuance_commitment_binds_every_mode_scope_and_authority_value() {
        let row = operational();
        let r = &row.request;
        let base = issue_digest(
            r,
            row.connection_epoch,
            &row.snapshot_digest,
            &row.manifest_digest,
        );
        for field in 0..9 {
            let mut q = r.clone();
            match field {
                0 => q.connection_id += 1,
                1 => q.connector_identity = row.owner,
                2 => q.runtime_id.push('x'),
                3 => q.run_id.push('x'),
                4 => q.direction = ProtectedMailDirection::Sent,
                5 => q.mode = ProtectedMailDiscoveryMode::Bootstrap,
                6 => q.not_before_ms += 1,
                7 => q.expires_at_ms -= 1,
                _ => q.event_nonce = "1".repeat(64),
            }
            assert_ne!(
                base,
                issue_digest(
                    &q,
                    row.connection_epoch,
                    &row.snapshot_digest,
                    &row.manifest_digest
                )
            );
        }
        assert_ne!(
            base,
            issue_digest(r, 1, &row.snapshot_digest, &row.manifest_digest)
        );
        assert_ne!(
            base,
            issue_digest(
                r,
                row.connection_epoch,
                &"1".repeat(64),
                &row.manifest_digest
            )
        );
        assert_ne!(
            base,
            issue_digest(
                r,
                row.connection_epoch,
                &row.snapshot_digest,
                &"1".repeat(64)
            )
        );
    }
    #[test]
    fn private_observation_commitment_binds_derived_sets_head_nonce_and_time() {
        let grant = operational();
        let input = input(45, &[42, 44]);
        let (range, absent) = derive_observation(&grant, &input).unwrap();
        let mut row = ProtectedMailDiscoveryObservation {
            discovery_id: grant.id.clone(),
            head_event_id: "1".repeat(64),
            head_id: grant.head.as_ref().unwrap().id.clone(),
            head_generation: 3,
            previous_head_digest: grant.head.as_ref().unwrap().digest.clone(),
            previous_observation_id: Some("5".repeat(64)),
            input,
            range,
            absent_uids: absent,
            event_nonce: "6".repeat(64),
            observation_digest: String::new(),
            observation_bytes: 0,
            canonical: String::new(),
            actor: grant.request.connector_identity,
            recorded_at: grant.created_at,
        };
        let base = observation_canonical(&grant, &row).unwrap();
        let value: Value = serde_json::from_str(&base).unwrap();
        assert_eq!(value["absentUids"], json!([43]));
        assert_eq!(value["head"]["generation"], "3");
        assert!(!base.contains(&grant.folder));
        row.event_nonce = "7".repeat(64);
        assert_ne!(base, observation_canonical(&grant, &row).unwrap());
        row.event_nonce = "6".repeat(64);
        row.head_generation += 1;
        assert_ne!(base, observation_canonical(&grant, &row).unwrap());
        row.head_generation = 3;
        row.absent_uids.clear();
        assert_ne!(base, observation_canonical(&grant, &row).unwrap());
    }
    #[test]
    fn fixed_error_mapping_never_exposes_subsystem_or_mailbox_text() {
        for code in [
            INVALID,
            INCONSISTENT,
            OWNER,
            SERVICE,
            CONFLICT,
            STALE,
            CONSUMED,
            LIMIT,
        ] {
            assert_eq!(fixed_error(code.into()), code);
        }
        assert_eq!(
            fixed_error("DISCOVERY_PRIVATE_SYNTHETIC".into()),
            INCONSISTENT
        );
    }
}
