//! One-use metadata plan for exactly the present UIDs of a retained observation.
//! No IMAP, credentials, body, storage, disposition or cursor effect executes here.
use super::admission::{canonical, hash, hex64, human, now_ms, service};
use super::discovery::{
    self, protected_mail_discovery_grant, protected_mail_discovery_observation,
    ProtectedMailDiscoveryGrant, ProtectedMailDiscoveryMode, ProtectedMailDiscoveryObservation,
};
use super::protected::ProtectedMailDirection;
use serde_json::json;
use sha2::{Digest, Sha256};
use spacetimedb::{
    procedure, reducer, table, Identity, ProcedureContext, ReducerContext, SpacetimeType, Table,
    Timestamp,
};

const INVALID: &str = "protected_mail_sparse_read_invalid_request";
const INCONSISTENT: &str = "protected_mail_sparse_read_inconsistent";
const OWNER: &str = "protected_mail_sparse_read_owner_required";
const SERVICE: &str = "protected_mail_sparse_read_service_required";
const CONFLICT: &str = "protected_mail_sparse_read_event_conflict";
const STALE: &str = "protected_mail_sparse_read_stale";
const CONSUMED: &str = "protected_mail_sparse_read_consumed";
const LIMIT: &str = "protected_mail_sparse_read_limit_exceeded";
const SAFE: u64 = 9_007_199_254_740_991;
const TTL: u64 = 3_600_000;
const MAX_MESSAGE: u64 = 524_288;
const MAX_TOTAL: u64 = 2_097_152;
const MAX_PLAN: usize = 8192;

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct ProtectedMailSparseReadRequest {
    pub observation_id: String,
    pub not_before_ms: u64,
    pub expires_at_ms: u64,
    pub max_message_bytes: u64,
    pub max_total_bytes: u64,
    pub event_nonce: String,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailSparseReadGrantEventKind {
    Issued,
    Revoked,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailSparseReadStatus {
    Pending,
    Dispatching,
    ReadReported,
    Failed,
    Unknown,
    CancelledBeforeDispatch,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailSparseReadOutcome {
    ReadReported,
    Failed,
    Unknown,
    CancelledBeforeDispatch,
}
#[table(accessor=protected_mail_sparse_read_grant,private)]
pub struct ProtectedMailSparseReadGrant {
    #[primary_key]
    pub id: String,
    #[unique]
    pub observation_id: String,
    #[index(btree)]
    pub owner: Identity,
    pub workspace: Identity,
    pub request: ProtectedMailSparseReadRequest,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub plan_digest: String,
    pub plan_bytes: u64,
    pub canonical: String,
    pub issue_digest: String,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_sparse_read_grant_event,private)]
pub struct ProtectedMailSparseReadGrantEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub read_id: String,
    pub generation: u64,
    pub kind: ProtectedMailSparseReadGrantEventKind,
    pub event_nonce: String,
    pub request_digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_sparse_read_state,private)]
pub struct ProtectedMailSparseReadState {
    #[primary_key]
    pub read_id: String,
    pub generation: u64,
    pub status: ProtectedMailSparseReadStatus,
    pub reserved_operations: u64,
    pub reserved_message_slots: u64,
    pub reserved_body_bytes: u64,
    pub last_event_id: String,
}
#[table(accessor=protected_mail_sparse_read_event,private)]
pub struct ProtectedMailSparseReadEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub read_id: String,
    pub generation: u64,
    pub status: ProtectedMailSparseReadStatus,
    pub event_nonce: String,
    pub request_digest: String,
    pub actor: Identity,
    pub reserved_operations: u64,
    pub reserved_message_slots: u64,
    pub reserved_body_bytes: u64,
    pub created_at: Timestamp,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailSparseReadPreview {
    pub read_id: String,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub plan_digest: String,
    pub plan_bytes: u64,
    pub canonical: String,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailSparseReadDispatch {
    pub read_id: String,
    pub plan_digest: String,
    pub plan_bytes: u64,
    pub canonical: String,
}
struct ReadContext {
    observation: ProtectedMailDiscoveryObservation,
    discovery: ProtectedMailDiscoveryGrant,
}
fn sha(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}
fn read_id(observation: &str) -> String {
    hash("pear-mail-sparse-read-grant-v1", &[observation.into()])
}
fn owner_event_id(workspace: Identity, owner: Identity, nonce: &str) -> String {
    hash(
        "pear-mail-sparse-read-owner-event-v1",
        &[
            workspace.to_hex().to_string(),
            owner.to_hex().to_string(),
            nonce.into(),
        ],
    )
}
fn event_id(id: &str, generation: u64) -> String {
    hash(
        "pear-mail-sparse-read-event-v1",
        &[id.into(), generation.to_string()],
    )
}
fn valid_caps(message: u64, total: u64, count: usize) -> Result<(), String> {
    if count == 0 || count > 8 || message == 0 || total == 0 {
        return Err(INVALID.into());
    }
    if message > MAX_MESSAGE || total > MAX_TOTAL {
        return Err(LIMIT.into());
    }
    if message > total || total > message.checked_mul(count as u64).ok_or(LIMIT)? {
        return Err(INVALID.into());
    }
    Ok(())
}
fn valid_request(request: &ProtectedMailSparseReadRequest, count: usize) -> Result<(), String> {
    if !hex64(&request.observation_id)
        || !hex64(&request.event_nonce)
        || request.not_before_ms > SAFE
        || request.expires_at_ms > SAFE
        || request.expires_at_ms <= request.not_before_ms
        || request.expires_at_ms - request.not_before_ms > TTL
    {
        return Err(INVALID.into());
    }
    valid_caps(request.max_message_bytes, request.max_total_bytes, count)
}
fn valid_issue_window(request: &ProtectedMailSparseReadRequest, now: u64) -> Result<(), String> {
    if request.expires_at_ms <= now || request.expires_at_ms - now > TTL {
        return Err(STALE.into());
    }
    Ok(())
}
fn discovery_error(error: String) -> String {
    match error.as_str() {
        "protected_mail_discovery_invalid_request" => INVALID.into(),
        "protected_mail_discovery_stale" => STALE.into(),
        "protected_mail_discovery_limit_exceeded" => LIMIT.into(),
        _ => INCONSISTENT.into(),
    }
}
fn valid_context(binding: &ReadContext) -> Result<(), String> {
    let observation = &binding.observation;
    let discovery = &binding.discovery;
    let cursor = discovery.cursor.as_ref().ok_or(INVALID)?;
    let range = observation.range.as_ref().ok_or(INVALID)?;
    if !matches!(
        discovery.request.mode,
        ProtectedMailDiscoveryMode::NextWindow(_)
    ) || observation.input.present_uids.is_empty()
        || observation.input.present_uids.len() > 8
        || range.from_uid == 0
        || cursor.last_uid.checked_add(1) != Some(range.from_uid)
        || range.through_uid < range.from_uid
        || u64::from(range.through_uid) - u64::from(range.from_uid) >= 8
        || range.through_uid >= observation.input.uid_next
        || observation.input.uid_validity != cursor.uid_validity
    {
        return Err(INVALID.into());
    }
    Ok(())
}
fn retained_context(ctx: &ReducerContext, id: &str) -> Result<ReadContext, String> {
    let observation = ctx
        .db
        .protected_mail_discovery_observation()
        .discovery_id()
        .find(id.to_owned())
        .ok_or(INCONSISTENT)?;
    let (observation, discovery) =
        discovery::checked_observation(ctx, observation).map_err(|_| INCONSISTENT)?;
    let binding = ReadContext {
        observation,
        discovery,
    };
    if binding.observation.discovery_id != id {
        return Err(INCONSISTENT.into());
    }
    valid_context(&binding).map_err(|_| INCONSISTENT)?;
    Ok(binding)
}
fn owned_context(ctx: &ReducerContext, id: &str) -> Result<ReadContext, String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    if !ctx
        .db
        .protected_mail_discovery_grant()
        .id()
        .find(id.to_owned())
        .is_some_and(|r| r.owner == ctx.sender())
    {
        return Err(OWNER.into());
    }
    let observation = ctx
        .db
        .protected_mail_discovery_observation()
        .discovery_id()
        .find(id.to_owned())
        .ok_or(INVALID)?;
    let (observation, discovery) =
        discovery::checked_observation(ctx, observation).map_err(|_| INCONSISTENT)?;
    let binding = ReadContext {
        observation,
        discovery,
    };
    valid_context(&binding)?;
    Ok(binding)
}
fn plan(row: &ProtectedMailSparseReadGrant, binding: &ReadContext) -> Result<String, String> {
    valid_context(binding)?;
    let observation = &binding.observation;
    let discovery = &binding.discovery;
    valid_request(&row.request, observation.input.present_uids.len())?;
    let cursor = discovery.cursor.as_ref().ok_or(INVALID)?;
    let range = observation.range.as_ref().ok_or(INVALID)?;
    let direction = match discovery.request.direction {
        ProtectedMailDirection::Received => "received",
        ProtectedMailDirection::Sent => "sent",
    };
    let value=canonical(&json!({"formatVersion":1,"kind":"mail.connector.sparse_read","profile":"imap.observed-uid-body-peek.v1","readId":row.id,"eventNonce":row.request.event_nonce,"workspaceId":row.workspace.to_hex().to_string(),"ownerId":row.owner.to_hex().to_string(),
        "connection":{"id":discovery.request.connection_id.to_string(),"epoch":row.connection_epoch.to_string(),"snapshotDigest":row.snapshot_digest},
        "connector":{"identity":discovery.request.connector_identity.to_hex().to_string(),"runtimeId":discovery.request.runtime_id,"runId":discovery.request.run_id},
        "mailbox":{"host":discovery.host,"port":discovery.port,"username":discovery.username,"folder":discovery.folder,"direction":direction},
        "cursor":{"id":cursor.id,"generation":cursor.generation.to_string(),"digest":cursor.digest,"uidValidity":cursor.uid_validity,"lastUid":cursor.last_uid},
        "observation":{"id":observation.discovery_id,"digest":observation.observation_digest,"manifestDigest":discovery.manifest_digest,"headId":observation.head_id,"headGeneration":observation.head_generation.to_string(),"uidValidity":observation.input.uid_validity,"uidNext":observation.input.uid_next,"fromUid":range.from_uid,"throughUid":range.through_uid,"presentUids":observation.input.present_uids,"absentUids":observation.absent_uids},
        "limits":{"maxMessageBytes":row.request.max_message_bytes,"maxTotalBytes":row.request.max_total_bytes},"reservation":{"bodyBytes":row.request.max_total_bytes,"messageSlots":observation.input.present_uids.len(),"operations":1},"notBeforeMs":row.request.not_before_ms,"expiresAtMs":row.request.expires_at_ms})).map_err(|_|INCONSISTENT)?;
    if value.len() > MAX_PLAN {
        return Err(LIMIT.into());
    }
    Ok(value)
}
fn issue_digest(
    request: &ProtectedMailSparseReadRequest,
    epoch: u64,
    snapshot: &str,
    plan: &str,
) -> String {
    hash(
        "pear-mail-sparse-read-issue-v1",
        &[
            request.observation_id.clone(),
            request.not_before_ms.to_string(),
            request.expires_at_ms.to_string(),
            request.max_message_bytes.to_string(),
            request.max_total_bytes.to_string(),
            request.event_nonce.clone(),
            epoch.to_string(),
            snapshot.into(),
            plan.into(),
        ],
    )
}
fn revoke_digest(id: &str, nonce: &str) -> String {
    hash(
        "pear-mail-sparse-read-revoke-v1",
        &[id.into(), nonce.into()],
    )
}
fn checked_grant(
    ctx: &ReducerContext,
    row: ProtectedMailSparseReadGrant,
) -> Result<(ProtectedMailSparseReadGrant, ReadContext, bool), String> {
    let binding = retained_context(ctx, &row.observation_id)?;
    let discovery = &binding.discovery;
    let text = plan(&row, &binding).map_err(|_| INCONSISTENT)?;
    let created = u64::try_from(row.created_at.to_micros_since_unix_epoch() / 1000)
        .map_err(|_| INCONSISTENT)?;
    if row.id != read_id(&row.observation_id)
        || row.request.observation_id != row.observation_id
        || row.owner != discovery.owner
        || row.workspace != ctx.identity()
        || row.workspace != discovery.workspace
        || row.connection_epoch != discovery.connection_epoch
        || row.snapshot_digest != discovery.snapshot_digest
        || row.canonical != text
        || row.plan_bytes != text.len() as u64
        || row.plan_digest != sha(&text)
        || row.issue_digest
            != issue_digest(
                &row.request,
                row.connection_epoch,
                &row.snapshot_digest,
                &row.plan_digest,
            )
        || row.created_at < binding.observation.recorded_at
        || valid_issue_window(&row.request, created).is_err()
    {
        return Err(INCONSISTENT.into());
    }
    let indexed = ctx
        .db
        .protected_mail_sparse_read_grant()
        .observation_id()
        .find(row.observation_id.clone())
        .ok_or(INCONSISTENT)?;
    if indexed.id != row.id {
        return Err(INCONSISTENT.into());
    }
    let events = ctx
        .db
        .protected_mail_sparse_read_grant_event()
        .read_id()
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
            ProtectedMailSparseReadGrantEventKind::Issued
                if !issued
                    && event.generation == 1
                    && event.event_nonce == row.request.event_nonce
                    && event.request_digest == row.issue_digest
                    && event.created_at == row.created_at =>
            {
                issued = true
            }
            ProtectedMailSparseReadGrantEventKind::Revoked
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
    Ok((row, binding, revoked))
}
fn owned(
    ctx: &ReducerContext,
    id: &str,
) -> Result<(ProtectedMailSparseReadGrant, ReadContext, bool), String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let row = ctx
        .db
        .protected_mail_sparse_read_grant()
        .id()
        .find(id.to_owned())
        .filter(|r| r.owner == ctx.sender())
        .ok_or(OWNER)?;
    checked_grant(ctx, row)
}
fn bound(
    ctx: &ReducerContext,
    id: &str,
) -> Result<(ProtectedMailSparseReadGrant, ReadContext, bool), String> {
    if !hex64(id) || !service(ctx, ctx.sender(), Identity::from_byte_array([0; 32])) {
        return Err(SERVICE.into());
    }
    let row = ctx
        .db
        .protected_mail_sparse_read_grant()
        .id()
        .find(id.to_owned())
        .ok_or(SERVICE)?;
    if !service(ctx, ctx.sender(), row.owner)
        || !ctx
            .db
            .protected_mail_discovery_grant()
            .id()
            .find(row.observation_id.clone())
            .is_some_and(|d| d.owner == row.owner && d.request.connector_identity == ctx.sender())
    {
        return Err(SERVICE.into());
    }
    checked_grant(ctx, row)
}
fn current(
    ctx: &ReducerContext,
    grant: &ProtectedMailSparseReadGrant,
    binding: &ReadContext,
    revoked: bool,
    active: bool,
) -> Result<(), String> {
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if revoked
        || (active && now < grant.request.not_before_ms)
        || now >= grant.request.expires_at_ms
    {
        return Err(STALE.into());
    }
    discovery::require_current_completed_observation(ctx, &binding.observation, &binding.discovery)
        .map_err(discovery_error)
}
fn status_name(status: &ProtectedMailSparseReadStatus) -> &'static str {
    match status {
        ProtectedMailSparseReadStatus::Pending => "pending",
        ProtectedMailSparseReadStatus::Dispatching => "dispatching",
        ProtectedMailSparseReadStatus::ReadReported => "read_reported",
        ProtectedMailSparseReadStatus::Failed => "failed",
        ProtectedMailSparseReadStatus::Unknown => "unknown",
        ProtectedMailSparseReadStatus::CancelledBeforeDispatch => "cancelled_before_dispatch",
    }
}
fn terminal(status: &ProtectedMailSparseReadStatus) -> bool {
    matches!(
        status,
        ProtectedMailSparseReadStatus::ReadReported
            | ProtectedMailSparseReadStatus::Failed
            | ProtectedMailSparseReadStatus::Unknown
            | ProtectedMailSparseReadStatus::CancelledBeforeDispatch
    )
}
fn event_digest(
    grant: &ProtectedMailSparseReadGrant,
    event: &ProtectedMailSparseReadEvent,
) -> String {
    hash(
        "pear-mail-sparse-read-lifecycle-v1",
        &[
            grant.id.clone(),
            grant.issue_digest.clone(),
            event.generation.to_string(),
            status_name(&event.status).into(),
            event.event_nonce.clone(),
            event.actor.to_hex().to_string(),
            event.reserved_operations.to_string(),
            event.reserved_message_slots.to_string(),
            event.reserved_body_bytes.to_string(),
            event.created_at.to_micros_since_unix_epoch().to_string(),
        ],
    )
}
fn event_shape(
    grant: &ProtectedMailSparseReadGrant,
    binding: &ReadContext,
    event: &ProtectedMailSparseReadEvent,
) -> bool {
    let zero = event.reserved_operations == 0
        && event.reserved_message_slots == 0
        && event.reserved_body_bytes == 0;
    let full = event.reserved_operations == 1
        && event.reserved_message_slots == binding.observation.input.present_uids.len() as u64
        && event.reserved_body_bytes == grant.request.max_total_bytes;
    event.id == event_id(&grant.id, event.generation)
        && event.read_id == grant.id
        && event.created_at >= grant.created_at
        && event.request_digest == event_digest(grant, event)
        && match event.status {
            ProtectedMailSparseReadStatus::Pending => {
                event.generation == 1
                    && zero
                    && event.event_nonce.is_empty()
                    && event.actor == grant.owner
                    && event.created_at == grant.created_at
            }
            ProtectedMailSparseReadStatus::Dispatching => {
                event.generation == 2
                    && full
                    && event.event_nonce.is_empty()
                    && event.actor == binding.discovery.request.connector_identity
            }
            ProtectedMailSparseReadStatus::CancelledBeforeDispatch => {
                event.generation == 2
                    && zero
                    && hex64(&event.event_nonce)
                    && event.actor == binding.discovery.request.connector_identity
            }
            _ => {
                event.generation == 3
                    && full
                    && hex64(&event.event_nonce)
                    && event.actor == binding.discovery.request.connector_identity
            }
        }
}
fn checked_state(
    ctx: &ReducerContext,
    grant: &ProtectedMailSparseReadGrant,
    binding: &ReadContext,
) -> Result<ProtectedMailSparseReadState, String> {
    let row = ctx
        .db
        .protected_mail_sparse_read_state()
        .read_id()
        .find(grant.id.clone())
        .ok_or(INCONSISTENT)?;
    if row.generation == 0
        || row.generation > 3
        || row.last_event_id != event_id(&grant.id, row.generation)
        || ctx
            .db
            .protected_mail_sparse_read_event()
            .read_id()
            .filter(&grant.id)
            .take(4)
            .count()
            != row.generation as usize
    {
        return Err(INCONSISTENT.into());
    }
    let mut previous: Option<ProtectedMailSparseReadEvent> = None;
    for generation in 1..=row.generation {
        let event = ctx
            .db
            .protected_mail_sparse_read_event()
            .id()
            .find(event_id(&grant.id, generation))
            .ok_or(INCONSISTENT)?;
        if !event_shape(grant, binding, &event)
            || previous.as_ref().is_some_and(|p| {
                event.created_at < p.created_at
                    || (generation == 3 && p.status != ProtectedMailSparseReadStatus::Dispatching)
            })
        {
            return Err(INCONSISTENT.into());
        }
        previous = Some(event);
    }
    let last = previous.ok_or(INCONSISTENT)?;
    if row.status != last.status
        || row.reserved_operations != last.reserved_operations
        || row.reserved_message_slots != last.reserved_message_slots
        || row.reserved_body_bytes != last.reserved_body_bytes
    {
        return Err(INCONSISTENT.into());
    }
    Ok(row)
}
fn write_state(
    ctx: &ReducerContext,
    grant: &ProtectedMailSparseReadGrant,
    binding: &ReadContext,
    generation: u64,
    status: ProtectedMailSparseReadStatus,
    nonce: &str,
) -> Result<(), String> {
    let spent = !matches!(
        status,
        ProtectedMailSparseReadStatus::Pending
            | ProtectedMailSparseReadStatus::CancelledBeforeDispatch
    );
    let mut event = ProtectedMailSparseReadEvent {
        id: event_id(&grant.id, generation),
        read_id: grant.id.clone(),
        generation,
        status: status.clone(),
        event_nonce: nonce.into(),
        request_digest: String::new(),
        actor: ctx.sender(),
        reserved_operations: if spent { 1 } else { 0 },
        reserved_message_slots: if spent {
            binding.observation.input.present_uids.len() as u64
        } else {
            0
        },
        reserved_body_bytes: if spent {
            grant.request.max_total_bytes
        } else {
            0
        },
        created_at: ctx.timestamp,
    };
    event.request_digest = event_digest(grant, &event);
    if !event_shape(grant, binding, &event)
        || ctx
            .db
            .protected_mail_sparse_read_event()
            .id()
            .find(event.id.clone())
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    let state = ProtectedMailSparseReadState {
        read_id: grant.id.clone(),
        generation,
        status,
        reserved_operations: event.reserved_operations,
        reserved_message_slots: event.reserved_message_slots,
        reserved_body_bytes: event.reserved_body_bytes,
        last_event_id: event.id.clone(),
    };
    ctx.db.protected_mail_sparse_read_event().insert(event);
    if generation == 1 {
        ctx.db.protected_mail_sparse_read_state().insert(state);
    } else {
        ctx.db
            .protected_mail_sparse_read_state()
            .read_id()
            .update(state);
    }
    Ok(())
}
fn preview(
    ctx: &ReducerContext,
    request: ProtectedMailSparseReadRequest,
) -> Result<(ProtectedMailSparseReadGrant, ReadContext), String> {
    let binding = owned_context(ctx, &request.observation_id)?;
    valid_request(&request, binding.observation.input.present_uids.len())?;
    discovery::require_current_completed_observation(ctx, &binding.observation, &binding.discovery)
        .map_err(discovery_error)?;
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    valid_issue_window(&request, now)?;
    let mut row = ProtectedMailSparseReadGrant {
        id: read_id(&request.observation_id),
        observation_id: request.observation_id.clone(),
        owner: binding.discovery.owner,
        workspace: binding.discovery.workspace,
        request,
        connection_epoch: binding.discovery.connection_epoch,
        snapshot_digest: binding.discovery.snapshot_digest.clone(),
        plan_digest: String::new(),
        plan_bytes: 0,
        canonical: String::new(),
        issue_digest: String::new(),
        created_at: ctx.timestamp,
    };
    row.canonical = plan(&row, &binding)?;
    row.plan_bytes = row.canonical.len() as u64;
    row.plan_digest = sha(&row.canonical);
    row.issue_digest = issue_digest(
        &row.request,
        row.connection_epoch,
        &row.snapshot_digest,
        &row.plan_digest,
    );
    Ok((row, binding))
}
fn preview_dto(row: ProtectedMailSparseReadGrant) -> ProtectedMailSparseReadPreview {
    ProtectedMailSparseReadPreview {
        read_id: row.id,
        connection_epoch: row.connection_epoch,
        snapshot_digest: row.snapshot_digest,
        plan_digest: row.plan_digest,
        plan_bytes: row.plan_bytes,
        canonical: row.canonical,
    }
}
#[procedure]
pub fn review_protected_mail_sparse_read_grant(
    ctx: &mut ProcedureContext,
    request: ProtectedMailSparseReadRequest,
) -> Result<ProtectedMailSparseReadPreview, String> {
    ctx.try_with_tx(|tx| {
        preview(tx.as_ref(), request.clone())
            .map(|(row, _)| preview_dto(row))
            .map_err(fixed_error)
    })
}
#[reducer]
pub fn issue_protected_mail_sparse_read_grant(
    ctx: &ReducerContext,
    request: ProtectedMailSparseReadRequest,
    expected_epoch: u64,
    expected_snapshot_digest: String,
    expected_plan_digest: String,
) -> Result<(), String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let id = read_id(&request.observation_id);
    if let Some(old) = ctx
        .db
        .protected_mail_sparse_read_grant()
        .id()
        .find(id.clone())
    {
        if old.owner != ctx.sender() {
            return Err(OWNER.into());
        }
        let (old, binding, _) = checked_grant(ctx, old)?;
        checked_state(ctx, &old, &binding)?;
        if old.issue_digest
            != issue_digest(
                &request,
                expected_epoch,
                &expected_snapshot_digest,
                &expected_plan_digest,
            )
        {
            return Err(CONFLICT.into());
        }
        return Ok(());
    }
    let (row, binding) = preview(ctx, request)?;
    if expected_epoch == 0 || !hex64(&expected_snapshot_digest) || !hex64(&expected_plan_digest) {
        return Err(INVALID.into());
    }
    if row.connection_epoch != expected_epoch
        || row.snapshot_digest != expected_snapshot_digest
        || row.plan_digest != expected_plan_digest
    {
        return Err(STALE.into());
    }
    let event = owner_event_id(row.workspace, row.owner, &row.request.event_nonce);
    if ctx
        .db
        .protected_mail_sparse_read_grant_event()
        .id()
        .find(event.clone())
        .is_some()
    {
        return Err(CONFLICT.into());
    }
    if ctx
        .db
        .protected_mail_sparse_read_grant_event()
        .read_id()
        .filter(&id)
        .next()
        .is_some()
        || ctx
            .db
            .protected_mail_sparse_read_state()
            .read_id()
            .find(id.clone())
            .is_some()
        || ctx
            .db
            .protected_mail_sparse_read_event()
            .read_id()
            .filter(&id)
            .next()
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    ctx.db
        .protected_mail_sparse_read_grant_event()
        .insert(ProtectedMailSparseReadGrantEvent {
            id: event,
            read_id: id,
            generation: 1,
            kind: ProtectedMailSparseReadGrantEventKind::Issued,
            event_nonce: row.request.event_nonce.clone(),
            request_digest: row.issue_digest.clone(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    write_state(
        ctx,
        &row,
        &binding,
        1,
        ProtectedMailSparseReadStatus::Pending,
        "",
    )?;
    ctx.db.protected_mail_sparse_read_grant().insert(row);
    Ok(())
}
#[reducer]
pub fn revoke_protected_mail_sparse_read_grant(
    ctx: &ReducerContext,
    read_id: String,
    event_nonce: String,
) -> Result<(), String> {
    let (grant, binding, revoked) = owned(ctx, &read_id)?;
    checked_state(ctx, &grant, &binding)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    let id = owner_event_id(grant.workspace, grant.owner, &event_nonce);
    let request_digest = revoke_digest(&read_id, &event_nonce);
    if let Some(old) = ctx
        .db
        .protected_mail_sparse_read_grant_event()
        .id()
        .find(id.clone())
    {
        return if old.read_id == read_id
            && old.kind == ProtectedMailSparseReadGrantEventKind::Revoked
            && old.request_digest == request_digest
        {
            Ok(())
        } else {
            Err(CONFLICT.into())
        };
    }
    if revoked {
        return Err(CONFLICT.into());
    }
    ctx.db
        .protected_mail_sparse_read_grant_event()
        .insert(ProtectedMailSparseReadGrantEvent {
            id,
            read_id,
            generation: 2,
            kind: ProtectedMailSparseReadGrantEventKind::Revoked,
            event_nonce,
            request_digest,
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    Ok(())
}
fn begin(ctx: &ReducerContext, id: &str) -> Result<ProtectedMailSparseReadDispatch, String> {
    let (grant, binding, revoked) = bound(ctx, id)?;
    let state = checked_state(ctx, &grant, &binding)?;
    if state.status != ProtectedMailSparseReadStatus::Pending {
        return Err(CONSUMED.into());
    }
    current(ctx, &grant, &binding, revoked, true)?;
    write_state(
        ctx,
        &grant,
        &binding,
        2,
        ProtectedMailSparseReadStatus::Dispatching,
        "",
    )?;
    Ok(ProtectedMailSparseReadDispatch {
        read_id: grant.id,
        plan_digest: grant.plan_digest,
        plan_bytes: grant.plan_bytes,
        canonical: grant.canonical,
    })
}
#[procedure]
pub fn begin_protected_mail_sparse_read_dispatch(
    ctx: &mut ProcedureContext,
    read_id: String,
) -> Result<ProtectedMailSparseReadDispatch, String> {
    ctx.try_with_tx(|tx| begin(tx.as_ref(), &read_id).map_err(fixed_error))
}
fn outcome_status(outcome: &ProtectedMailSparseReadOutcome) -> ProtectedMailSparseReadStatus {
    match outcome {
        ProtectedMailSparseReadOutcome::ReadReported => ProtectedMailSparseReadStatus::ReadReported,
        ProtectedMailSparseReadOutcome::Failed => ProtectedMailSparseReadStatus::Failed,
        ProtectedMailSparseReadOutcome::Unknown => ProtectedMailSparseReadStatus::Unknown,
        ProtectedMailSparseReadOutcome::CancelledBeforeDispatch => {
            ProtectedMailSparseReadStatus::CancelledBeforeDispatch
        }
    }
}
fn permitted_outcome(
    status: &ProtectedMailSparseReadStatus,
    desired: &ProtectedMailSparseReadStatus,
) -> bool {
    (*status == ProtectedMailSparseReadStatus::Pending
        && *desired == ProtectedMailSparseReadStatus::CancelledBeforeDispatch)
        || (*status == ProtectedMailSparseReadStatus::Dispatching
            && matches!(
                desired,
                ProtectedMailSparseReadStatus::ReadReported
                    | ProtectedMailSparseReadStatus::Failed
                    | ProtectedMailSparseReadStatus::Unknown
            ))
}
#[reducer]
pub fn finish_protected_mail_sparse_read_dispatch(
    ctx: &ReducerContext,
    read_id: String,
    outcome: ProtectedMailSparseReadOutcome,
    event_nonce: String,
) -> Result<(), String> {
    let (grant, binding, _) = bound(ctx, &read_id)?;
    let state = checked_state(ctx, &grant, &binding)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    let desired = outcome_status(&outcome);
    if terminal(&state.status) {
        let event = ctx
            .db
            .protected_mail_sparse_read_event()
            .id()
            .find(state.last_event_id)
            .ok_or(INCONSISTENT)?;
        return if desired == state.status && event.event_nonce == event_nonce {
            Ok(())
        } else {
            Err(CONFLICT.into())
        };
    }
    if !permitted_outcome(&state.status, &desired) {
        return Err(INVALID.into());
    }
    write_state(
        ctx,
        &grant,
        &binding,
        state.generation + 1,
        desired,
        &event_nonce,
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
    use super::super::discovery::{
        ProtectedMailDiscoveryCursorBinding, ProtectedMailDiscoveryNextWindow,
        ProtectedMailDiscoveryObservationInput, ProtectedMailDiscoveryRange,
        ProtectedMailDiscoveryRequest,
    };
    use super::*;
    use serde_json::Value;
    fn fixture() -> (ProtectedMailSparseReadGrant, ReadContext) {
        let time = Timestamp::from_micros_since_unix_epoch(1_700_000_000_000_000);
        let discovery = ProtectedMailDiscoveryGrant {
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
                event_nonce: "1".repeat(64),
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
                last_uid: u32::MAX - 4,
            }),
            head: None,
            manifest_digest: "4".repeat(64),
            manifest_bytes: 0,
            canonical: String::new(),
            issue_digest: String::new(),
            created_at: time,
        };
        let observation = ProtectedMailDiscoveryObservation {
            discovery_id: discovery.id.clone(),
            head_event_id: "4".repeat(64),
            head_id: format!("mail-discovery-head:{}", "5".repeat(64)),
            head_generation: u64::MAX,
            previous_head_digest: "6".repeat(64),
            previous_observation_id: Some("7".repeat(64)),
            input: ProtectedMailDiscoveryObservationInput {
                uid_validity: u32::MAX.to_string(),
                uid_next: u32::MAX,
                present_uids: vec![u32::MAX - 3, u32::MAX - 1],
            },
            range: Some(ProtectedMailDiscoveryRange {
                from_uid: u32::MAX - 3,
                through_uid: u32::MAX - 1,
            }),
            absent_uids: vec![u32::MAX - 2],
            event_nonce: "8".repeat(64),
            observation_digest: "3".repeat(64),
            observation_bytes: 0,
            canonical: String::new(),
            actor: discovery.request.connector_identity,
            recorded_at: time,
        };
        let mut grant = ProtectedMailSparseReadGrant {
            id: read_id(&discovery.id),
            observation_id: discovery.id.clone(),
            owner: discovery.owner,
            workspace: discovery.workspace,
            request: ProtectedMailSparseReadRequest {
                observation_id: discovery.id.clone(),
                not_before_ms: 1_700_000_000_000,
                expires_at_ms: 1_700_003_600_000,
                max_message_bytes: MAX_MESSAGE,
                max_total_bytes: 700_000,
                event_nonce: "b".repeat(64),
            },
            connection_epoch: discovery.connection_epoch,
            snapshot_digest: discovery.snapshot_digest.clone(),
            plan_digest: String::new(),
            plan_bytes: 0,
            canonical: String::new(),
            issue_digest: String::new(),
            created_at: time,
        };
        let binding = ReadContext {
            observation,
            discovery,
        };
        grant.canonical = plan(&grant, &binding).unwrap();
        grant.plan_bytes = grant.canonical.len() as u64;
        grant.plan_digest = sha(&grant.canonical);
        grant.issue_digest = issue_digest(
            &grant.request,
            grant.connection_epoch,
            &grant.snapshot_digest,
            &grant.plan_digest,
        );
        (grant, binding)
    }
    fn event(
        grant: &ProtectedMailSparseReadGrant,
        binding: &ReadContext,
        status: ProtectedMailSparseReadStatus,
    ) -> ProtectedMailSparseReadEvent {
        let generation = match status {
            ProtectedMailSparseReadStatus::Pending => 1,
            ProtectedMailSparseReadStatus::Dispatching
            | ProtectedMailSparseReadStatus::CancelledBeforeDispatch => 2,
            _ => 3,
        };
        let full = !matches!(
            status,
            ProtectedMailSparseReadStatus::Pending
                | ProtectedMailSparseReadStatus::CancelledBeforeDispatch
        );
        let owner = status == ProtectedMailSparseReadStatus::Pending;
        let nonce = if matches!(
            status,
            ProtectedMailSparseReadStatus::Pending | ProtectedMailSparseReadStatus::Dispatching
        ) {
            String::new()
        } else {
            "d".repeat(64)
        };
        let mut row = ProtectedMailSparseReadEvent {
            id: event_id(&grant.id, generation),
            read_id: grant.id.clone(),
            generation,
            status,
            event_nonce: nonce,
            request_digest: String::new(),
            actor: if owner {
                grant.owner
            } else {
                binding.discovery.request.connector_identity
            },
            reserved_operations: if full { 1 } else { 0 },
            reserved_message_slots: if full {
                binding.observation.input.present_uids.len() as u64
            } else {
                0
            },
            reserved_body_bytes: if full {
                grant.request.max_total_bytes
            } else {
                0
            },
            created_at: grant.created_at,
        };
        row.request_digest = event_digest(grant, &row);
        row
    }
    #[test]
    fn mixed_unicode_full_u64_plan_matches_independent_python_and_typescript() {
        let (grant, _) = fixture();
        assert_eq!(
            grant.id,
            "891192f3dd1bb101132702d3c82e07fc3bb76d98f0b127d2bc952e214b0b4509"
        );
        assert_eq!(grant.plan_bytes, 1837);
        assert_eq!(
            grant.plan_digest,
            "15e68420ad194400bbf3f73779336436aed9dc22932d7e0dcb15311564a4b73a"
        );
        let value: Value = serde_json::from_str(&grant.canonical).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 16);
        assert_eq!(value["connection"]["epoch"], u64::MAX.to_string());
        assert_eq!(value["mailbox"]["folder"], "受信🍐e\u{301}\"\\\u{2028}");
        assert_eq!(canonical(&value).unwrap(), grant.canonical);
    }
    #[test]
    fn all_present_zero_cursor_boundary_matches_independent_golden() {
        let (mut grant, mut binding) = fixture();
        binding.discovery.cursor.as_mut().unwrap().last_uid = 0;
        binding.observation.range = Some(ProtectedMailDiscoveryRange {
            from_uid: 1,
            through_uid: 1,
        });
        binding.observation.input.uid_next = 2;
        binding.observation.input.present_uids = vec![1];
        binding.observation.absent_uids.clear();
        grant.request.max_message_bytes = 1;
        grant.request.max_total_bytes = 1;
        let text = plan(&grant, &binding).unwrap();
        assert_eq!(text.len(), 1756);
        assert_eq!(
            sha(&text),
            "0251b9dbff2f078546716e847f69065f89523f6f1048ccc2ce057a764d8c850f"
        );
    }
    #[test]
    fn bootstrap_empty_and_all_absent_are_not_zero_slot_reads() {
        let (_, mut binding) = fixture();
        binding.observation.input.present_uids.clear();
        assert_eq!(valid_context(&binding).unwrap_err(), INVALID);
        let (_, mut binding) = fixture();
        binding.observation.range = None;
        assert_eq!(valid_context(&binding).unwrap_err(), INVALID);
        let (_, mut binding) = fixture();
        binding.discovery.request.mode = ProtectedMailDiscoveryMode::Bootstrap;
        assert_eq!(valid_context(&binding).unwrap_err(), INVALID);
    }
    #[test]
    fn numeric_range_is_bounded_and_does_not_rebase_cursor() {
        let (_, mut binding) = fixture();
        binding.observation.range.as_mut().unwrap().from_uid -= 1;
        assert_eq!(valid_context(&binding).unwrap_err(), INVALID);
        let (_, mut binding) = fixture();
        binding.observation.input.uid_next = u32::MAX - 1;
        assert_eq!(valid_context(&binding).unwrap_err(), INVALID);
        let (_, mut binding) = fixture();
        binding.discovery.cursor.as_mut().unwrap().last_uid = u32::MAX;
        assert_eq!(valid_context(&binding).unwrap_err(), INVALID);
    }
    #[test]
    fn raw_mime_caps_use_present_count_not_numeric_slots() {
        assert!(valid_caps(10, 20, 2).is_ok());
        assert_eq!(valid_caps(10, 21, 2).unwrap_err(), INVALID);
        assert!(valid_caps(MAX_MESSAGE, 700_000, 2).is_ok());
        assert_eq!(valid_caps(MAX_MESSAGE, MAX_TOTAL, 2).unwrap_err(), INVALID);
        assert!(valid_caps(MAX_MESSAGE, MAX_TOTAL, 8).is_ok());
        for (m, t, n) in [(0, 1, 1), (1, 0, 1), (1, 1, 0), (1, 1, 9), (2, 1, 1)] {
            assert_eq!(valid_caps(m, t, n).unwrap_err(), INVALID);
        }
        assert_eq!(
            valid_caps(MAX_MESSAGE + 1, MAX_TOTAL, 8).unwrap_err(),
            LIMIT
        );
        assert_eq!(
            valid_caps(MAX_MESSAGE, MAX_TOTAL + 1, 8).unwrap_err(),
            LIMIT
        );
    }
    #[test]
    fn request_has_safe_bounded_independent_window() {
        let (mut grant, _) = fixture();
        assert!(valid_request(&grant.request, 2).is_ok());
        grant.request.expires_at_ms = grant.request.not_before_ms;
        assert_eq!(valid_request(&grant.request, 2).unwrap_err(), INVALID);
        grant.request.expires_at_ms = grant.request.not_before_ms + TTL + 1;
        assert_eq!(valid_request(&grant.request, 2).unwrap_err(), INVALID);
        grant.request.expires_at_ms = SAFE + 1;
        assert_eq!(valid_request(&grant.request, 2).unwrap_err(), INVALID);
        grant.request.expires_at_ms = grant.request.not_before_ms + TTL;
        grant.request.event_nonce = "X".repeat(64);
        assert_eq!(valid_request(&grant.request, 2).unwrap_err(), INVALID);
    }
    #[test]
    fn one_hour_is_bounded_from_actual_issue_not_just_future_interval() {
        let (mut grant, _) = fixture();
        let now = grant.request.not_before_ms;
        assert!(valid_issue_window(&grant.request, now).is_ok());
        grant.request.not_before_ms += TTL;
        grant.request.expires_at_ms += TTL;
        assert!(valid_request(&grant.request, 2).is_ok());
        assert_eq!(valid_issue_window(&grant.request, now).unwrap_err(), STALE);
        grant.request.expires_at_ms = now;
        assert_eq!(valid_issue_window(&grant.request, now).unwrap_err(), STALE);
    }
    #[test]
    fn independent_grant_window_does_not_resurrect_original_discovery_authority() {
        let (mut grant, binding) = fixture();
        grant.request.not_before_ms += 2 * TTL;
        grant.request.expires_at_ms += 2 * TTL;
        assert!(binding.discovery.request.expires_at_ms < grant.request.not_before_ms);
        assert!(plan(&grant, &binding).is_ok());
        // Retained plan construction deliberately has no clock/current head or
        // original probe revocation checks. New live gates are separate.
        assert!(valid_issue_window(&grant.request, grant.request.not_before_ms).is_ok());
    }
    #[test]
    fn read_identity_is_once_per_observation_not_nonce_cap_or_run() {
        let (grant, mut binding) = fixture();
        let mut request = grant.request.clone();
        request.event_nonce = "e".repeat(64);
        request.max_total_bytes += 1;
        binding.discovery.request.run_id = "other".into();
        assert_eq!(read_id(&request.observation_id), grant.id);
        assert_ne!(read_id(&"f".repeat(64)), grant.id);
        assert_ne!(
            owner_event_id(grant.workspace, grant.owner, "nonce"),
            owner_event_id(grant.owner, grant.workspace, "nonce")
        );
        assert_ne!(event_id(&grant.id, 2), event_id(&grant.id, 3));
    }
    #[test]
    fn issue_commitment_binds_all_reviewed_request_and_snapshot_fields() {
        let (grant, _) = fixture();
        let baseline = issue_digest(&grant.request, 1, "snapshot", "plan");
        for i in 0..6 {
            let mut request = grant.request.clone();
            match i {
                0 => request.observation_id = "f".repeat(64),
                1 => request.not_before_ms += 1,
                2 => request.expires_at_ms -= 1,
                3 => request.max_message_bytes -= 1,
                4 => request.max_total_bytes += 1,
                _ => request.event_nonce = "f".repeat(64),
            }
            assert_ne!(issue_digest(&request, 1, "snapshot", "plan"), baseline);
        }
        assert_ne!(
            issue_digest(&grant.request, 2, "snapshot", "plan"),
            baseline
        );
        assert_ne!(
            issue_digest(&grant.request, 1, "snapshot2", "plan"),
            baseline
        );
        assert_ne!(
            issue_digest(&grant.request, 1, "snapshot", "plan2"),
            baseline
        );
    }
    #[test]
    fn lifecycle_reservation_is_full_for_every_dispatched_outcome() {
        let (grant, binding) = fixture();
        for status in [
            ProtectedMailSparseReadStatus::Pending,
            ProtectedMailSparseReadStatus::Dispatching,
            ProtectedMailSparseReadStatus::ReadReported,
            ProtectedMailSparseReadStatus::Failed,
            ProtectedMailSparseReadStatus::Unknown,
            ProtectedMailSparseReadStatus::CancelledBeforeDispatch,
        ] {
            let row = event(&grant, &binding, status);
            assert!(event_shape(&grant, &binding, &row));
            let full = !matches!(
                row.status,
                ProtectedMailSparseReadStatus::Pending
                    | ProtectedMailSparseReadStatus::CancelledBeforeDispatch
            );
            assert_eq!(row.reserved_message_slots, if full { 2 } else { 0 });
            assert_eq!(row.reserved_body_bytes, if full { 700_000 } else { 0 });
        }
    }
    #[test]
    fn changed_actor_refund_or_absent_slot_reservation_fails_association() {
        let (grant, binding) = fixture();
        let mut row = event(&grant, &binding, ProtectedMailSparseReadStatus::Unknown);
        row.reserved_body_bytes -= 1;
        row.request_digest = event_digest(&grant, &row);
        assert!(!event_shape(&grant, &binding, &row));
        let mut row = event(&grant, &binding, ProtectedMailSparseReadStatus::Dispatching);
        row.reserved_message_slots = 3;
        row.request_digest = event_digest(&grant, &row);
        assert!(!event_shape(&grant, &binding, &row));
        let mut row = event(
            &grant,
            &binding,
            ProtectedMailSparseReadStatus::ReadReported,
        );
        row.actor = grant.owner;
        row.request_digest = event_digest(&grant, &row);
        assert!(!event_shape(&grant, &binding, &row));
    }
    #[test]
    fn only_pending_cancellation_or_dispatch_terminal_is_permitted() {
        let statuses = [
            ProtectedMailSparseReadStatus::Pending,
            ProtectedMailSparseReadStatus::Dispatching,
            ProtectedMailSparseReadStatus::ReadReported,
            ProtectedMailSparseReadStatus::Failed,
            ProtectedMailSparseReadStatus::Unknown,
            ProtectedMailSparseReadStatus::CancelledBeforeDispatch,
        ];
        for current in &statuses {
            for desired in &statuses {
                let expected = (*current == ProtectedMailSparseReadStatus::Pending
                    && *desired == ProtectedMailSparseReadStatus::CancelledBeforeDispatch)
                    || (*current == ProtectedMailSparseReadStatus::Dispatching
                        && matches!(
                            desired,
                            ProtectedMailSparseReadStatus::ReadReported
                                | ProtectedMailSparseReadStatus::Failed
                                | ProtectedMailSparseReadStatus::Unknown
                        ));
                assert_eq!(permitted_outcome(current, desired), expected);
            }
        }
        for status in &statuses[2..] {
            assert!(terminal(status));
            assert!(!permitted_outcome(
                status,
                &ProtectedMailSparseReadStatus::Dispatching
            ));
        }
    }
    #[test]
    fn event_digest_binds_nonce_actor_time_status_and_reservation() {
        let (grant, binding) = fixture();
        let baseline = event(&grant, &binding, ProtectedMailSparseReadStatus::Unknown);
        for i in 0..5 {
            let mut row = event(&grant, &binding, ProtectedMailSparseReadStatus::Unknown);
            match i {
                0 => row.event_nonce = "e".repeat(64),
                1 => row.actor = grant.owner,
                2 => {
                    row.created_at = Timestamp::from_micros_since_unix_epoch(
                        row.created_at.to_micros_since_unix_epoch() + 1,
                    )
                }
                3 => row.status = ProtectedMailSparseReadStatus::Failed,
                _ => row.reserved_body_bytes -= 1,
            }
            assert_ne!(event_digest(&grant, &row), baseline.request_digest);
        }
    }
    #[test]
    fn fixed_errors_never_return_raw_subsystem_details() {
        assert_eq!(fixed_error("private diagnostic".into()), INCONSISTENT);
        assert_eq!(discovery_error("private diagnostic".into()), INCONSISTENT);
        assert_eq!(
            discovery_error("protected_mail_discovery_stale".into()),
            STALE
        );
        assert_eq!(
            discovery_error("protected_mail_discovery_invalid_request".into()),
            INVALID
        );
        for error in [
            INVALID,
            INCONSISTENT,
            OWNER,
            SERVICE,
            CONFLICT,
            STALE,
            CONSUMED,
            LIMIT,
        ] {
            assert_eq!(fixed_error(error.into()), error);
        }
    }
}
