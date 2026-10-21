//! One-use release of an owner-authorized, body-free read-plan declaration.
//! No commands, sockets, credentials, MIME bodies, import or ACK execute here.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spacetimedb::{
    procedure, reducer, table, Identity, ProcedureContext, ReducerContext, SpacetimeType, Table,
    Timestamp,
};

use super::admission::{canonical, hash, hex64, human, service};
use super::connector::{
    bound_selection, owned_selection, require_current_selection, ProtectedMailConnectorSelection,
    ProtectedMailConnectorWindow,
};

const INVALID: &str = "protected_mail_read_invalid_request";
const INCONSISTENT: &str = "protected_mail_read_inconsistent";
const OWNER: &str = "protected_mail_read_owner_required";
const SERVICE: &str = "protected_mail_read_service_required";
const CONFLICT: &str = "protected_mail_read_event_conflict";
const STALE: &str = "protected_mail_read_stale";
const CONSUMED: &str = "protected_mail_read_consumed";
const LIMIT: &str = "protected_mail_read_limit_exceeded";
const MAX_MESSAGE: u64 = 524_288;
const MAX_TOTAL: u64 = 2_097_152;
const MAX_PLAN: usize = 12_288;

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct ProtectedMailReadGrantRequest {
    pub selection_id: String,
    pub max_message_bytes: u64,
    pub max_total_bytes: u64,
    pub event_nonce: String,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailReadGrantEventKind {
    Issued,
    Revoked,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailReadStatus {
    Pending,
    Dispatching,
    ReadReported,
    Failed,
    Unknown,
    CancelledBeforeDispatch,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailReadOutcome {
    ReadReported,
    Failed,
    Unknown,
    CancelledBeforeDispatch,
}

#[table(accessor = protected_mail_read_grant, private)]
pub struct ProtectedMailReadGrant {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub owner: Identity,
    pub selection_id: String,
    pub request: ProtectedMailReadGrantRequest,
    pub selection_digest: String,
    pub plan_digest: String,
    pub plan_bytes: u64,
    pub canonical: String,
    pub issue_digest: String,
    pub created_at: Timestamp,
}
#[table(accessor = protected_mail_read_grant_event, private)]
pub struct ProtectedMailReadGrantEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub grant_id: String,
    pub owner: Identity,
    pub generation: u64,
    pub kind: ProtectedMailReadGrantEventKind,
    pub event_nonce: String,
    pub request_digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[table(accessor = protected_mail_read_state, private)]
pub struct ProtectedMailReadState {
    #[primary_key]
    pub read_id: String,
    pub generation: u64,
    pub status: ProtectedMailReadStatus,
    pub reserved_operations: u64,
    pub reserved_message_slots: u64,
    pub reserved_body_bytes: u64,
    pub last_event_id: String,
}
#[table(accessor = protected_mail_read_event, private)]
pub struct ProtectedMailReadEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub read_id: String,
    pub generation: u64,
    pub status: ProtectedMailReadStatus,
    pub event_nonce: String,
    pub request_digest: String,
    pub actor: Identity,
    pub reserved_operations: u64,
    pub reserved_message_slots: u64,
    pub reserved_body_bytes: u64,
    pub created_at: Timestamp,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailReadPreview {
    pub read_id: String,
    pub plan_digest: String,
    pub plan_bytes: u64,
    pub canonical: String,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailReadDispatch {
    pub read_id: String,
    pub plan_digest: String,
    pub plan_bytes: u64,
    pub canonical: String,
}

fn read_id(selection: &str) -> String {
    hash("pear-mail-read-grant-v1", &[selection.into()])
}
fn owner_event_id(owner: Identity, nonce: &str) -> String {
    hash(
        "pear-mail-read-owner-event-v1",
        &[owner.to_hex().to_string(), nonce.into()],
    )
}
fn event_id(id: &str, generation: u64) -> String {
    hash(
        "pear-mail-read-event-v1",
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
    if message > total {
        return Err(INVALID.into());
    }
    if total > message.checked_mul(count as u64).ok_or(LIMIT)? {
        return Err(INVALID.into());
    }
    Ok(())
}
fn plan(
    selection: &Value,
    selection_digest: &str,
    id: &str,
    message: u64,
    total: u64,
    count: usize,
) -> Result<String, String> {
    valid_caps(message, total, count)?;
    let result=canonical(&json!({"formatVersion":1,"kind":"mail.connector.read","limits":{"maxMessageBytes":message,"maxTotalBytes":total},
        "profile":"imap.uid-body-peek.v1","readId":id,"reservation":{"bodyBytes":total,"messageSlots":count,"operations":1},
        "selection":selection,"selectionDigest":selection_digest})).map_err(|_|INCONSISTENT)?;
    if result.len() > MAX_PLAN {
        return Err(LIMIT.into());
    }
    Ok(result)
}
fn selection_plan(
    selection: &ProtectedMailConnectorSelection,
    request: &ProtectedMailReadGrantRequest,
) -> Result<String, String> {
    if !matches!(
        selection.request.window,
        ProtectedMailConnectorWindow::StoredBatch(_)
    ) {
        return Err(INVALID.into());
    }
    let value: Value = serde_json::from_str(&selection.canonical).map_err(|_| INCONSISTENT)?;
    plan(
        &value,
        &selection.manifest_digest,
        &read_id(&selection.id),
        request.max_message_bytes,
        request.max_total_bytes,
        selection.uids.len(),
    )
}
fn issue_digest(id: &str, request: &ProtectedMailReadGrantRequest, plan_digest: &str) -> String {
    hash(
        "pear-mail-read-issue-request-v1",
        &[
            id.into(),
            request.selection_id.clone(),
            request.max_message_bytes.to_string(),
            request.max_total_bytes.to_string(),
            request.event_nonce.clone(),
            plan_digest.into(),
        ],
    )
}
fn revoke_digest(id: &str, nonce: &str) -> String {
    hash(
        "pear-mail-read-revoke-request-v1",
        &[id.into(), nonce.into()],
    )
}
fn selection_error(error: String) -> String {
    match error.as_str() {
        "protected_mail_connector_owner_required" => OWNER.into(),
        "protected_mail_connector_service_required" => SERVICE.into(),
        "protected_mail_connector_stale" => STALE.into(),
        "protected_mail_connector_invalid_request" => INVALID.into(),
        "protected_mail_connector_limit_exceeded" => LIMIT.into(),
        _ => INCONSISTENT.into(),
    }
}
fn current_selection(
    ctx: &ReducerContext,
    selection: &ProtectedMailConnectorSelection,
    active: bool,
) -> Result<(), String> {
    if !service(ctx, selection.request.connector_identity, selection.owner) {
        return Err(STALE.into());
    }
    require_current_selection(ctx, selection, active).map_err(selection_error)?;
    Ok(())
}
fn checked_grant(
    ctx: &ReducerContext,
    row: ProtectedMailReadGrant,
    selection: &ProtectedMailConnectorSelection,
) -> Result<(ProtectedMailReadGrant, bool), String> {
    let canonical = selection_plan(selection, &row.request).map_err(|_| INCONSISTENT)?;
    if row.id != read_id(&selection.id)
        || row.selection_id != selection.id
        || row.request.selection_id != selection.id
        || row.owner != selection.owner
        || !hex64(&row.request.event_nonce)
        || row.selection_digest != selection.manifest_digest
        || row.canonical != canonical
        || row.plan_bytes != canonical.len() as u64
        || row.plan_digest != hex::encode(Sha256::digest(canonical.as_bytes()))
        || row.issue_digest != issue_digest(&row.id, &row.request, &row.plan_digest)
        || row.created_at < selection.created_at
    {
        return Err(INCONSISTENT.into());
    }
    let events = ctx
        .db
        .protected_mail_read_grant_event()
        .grant_id()
        .filter(&row.id)
        .take(3)
        .collect::<Vec<_>>();
    if events.is_empty() || events.len() > 2 {
        return Err(INCONSISTENT.into());
    }
    let mut issued = false;
    let mut revoked = false;
    for event in events {
        if event.owner != row.owner
            || event.actor != row.owner
            || !hex64(&event.event_nonce)
            || event.id != owner_event_id(row.owner, &event.event_nonce)
        {
            return Err(INCONSISTENT.into());
        }
        match event.kind {
            ProtectedMailReadGrantEventKind::Issued
                if !issued
                    && event.generation == 1
                    && event.event_nonce == row.request.event_nonce
                    && event.request_digest == row.issue_digest
                    && event.created_at == row.created_at =>
            {
                issued = true
            }
            ProtectedMailReadGrantEventKind::Revoked
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
fn owned_grant(
    ctx: &ReducerContext,
    id: &str,
) -> Result<
    (
        ProtectedMailReadGrant,
        ProtectedMailConnectorSelection,
        bool,
    ),
    String,
> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let row = ctx
        .db
        .protected_mail_read_grant()
        .id()
        .find(id.to_owned())
        .filter(|r| r.owner == ctx.sender())
        .ok_or(OWNER)?;
    let selection = owned_selection(ctx, &row.selection_id).map_err(|_| INCONSISTENT)?;
    let (row, revoked) = checked_grant(ctx, row, &selection)?;
    Ok((row, selection, revoked))
}
fn bound_grant(
    ctx: &ReducerContext,
    id: &str,
) -> Result<
    (
        ProtectedMailReadGrant,
        ProtectedMailConnectorSelection,
        bool,
    ),
    String,
> {
    if !hex64(id) || !service(ctx, ctx.sender(), Identity::from_byte_array([0; 32])) {
        return Err(SERVICE.into());
    }
    let row = ctx
        .db
        .protected_mail_read_grant()
        .id()
        .find(id.to_owned())
        .ok_or(SERVICE)?;
    let selection = bound_selection(ctx, &row.selection_id).map_err(selection_error)?;
    let (row, revoked) = checked_grant(ctx, row, &selection)?;
    Ok((row, selection, revoked))
}
fn status_name(status: &ProtectedMailReadStatus) -> &'static str {
    match status {
        ProtectedMailReadStatus::Pending => "pending",
        ProtectedMailReadStatus::Dispatching => "dispatching",
        ProtectedMailReadStatus::ReadReported => "read_reported",
        ProtectedMailReadStatus::Failed => "failed",
        ProtectedMailReadStatus::Unknown => "unknown",
        ProtectedMailReadStatus::CancelledBeforeDispatch => "cancelled_before_dispatch",
    }
}
fn event_digest(grant: &ProtectedMailReadGrant, event: &ProtectedMailReadEvent) -> String {
    hash(
        "pear-mail-read-lifecycle-request-v1",
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
fn terminal(status: &ProtectedMailReadStatus) -> bool {
    matches!(
        status,
        ProtectedMailReadStatus::ReadReported
            | ProtectedMailReadStatus::Failed
            | ProtectedMailReadStatus::Unknown
            | ProtectedMailReadStatus::CancelledBeforeDispatch
    )
}
fn event_shape(
    grant: &ProtectedMailReadGrant,
    selection: &ProtectedMailConnectorSelection,
    event: &ProtectedMailReadEvent,
) -> bool {
    let zero = event.reserved_operations == 0
        && event.reserved_message_slots == 0
        && event.reserved_body_bytes == 0;
    let full = event.reserved_operations == 1
        && event.reserved_message_slots == selection.uids.len() as u64
        && event.reserved_body_bytes == grant.request.max_total_bytes;
    event.id == event_id(&grant.id, event.generation)
        && event.read_id == grant.id
        && event.created_at >= grant.created_at
        && event.request_digest == event_digest(grant, event)
        && match event.status {
            ProtectedMailReadStatus::Pending => {
                event.generation == 1
                    && zero
                    && event.event_nonce.is_empty()
                    && event.actor == grant.owner
                    && event.created_at == grant.created_at
            }
            ProtectedMailReadStatus::Dispatching => {
                event.generation == 2
                    && full
                    && event.event_nonce.is_empty()
                    && event.actor == selection.request.connector_identity
            }
            ProtectedMailReadStatus::CancelledBeforeDispatch => {
                event.generation == 2
                    && zero
                    && hex64(&event.event_nonce)
                    && event.actor == selection.request.connector_identity
            }
            _ => {
                event.generation == 3
                    && full
                    && hex64(&event.event_nonce)
                    && event.actor == selection.request.connector_identity
            }
        }
}
fn checked_state(
    ctx: &ReducerContext,
    grant: &ProtectedMailReadGrant,
    selection: &ProtectedMailConnectorSelection,
) -> Result<ProtectedMailReadState, String> {
    let state = ctx
        .db
        .protected_mail_read_state()
        .read_id()
        .find(grant.id.clone())
        .ok_or(INCONSISTENT)?;
    if state.generation == 0
        || state.generation > 3
        || state.last_event_id != event_id(&grant.id, state.generation)
    {
        return Err(INCONSISTENT.into());
    }
    if ctx
        .db
        .protected_mail_read_event()
        .read_id()
        .filter(&grant.id)
        .take(4)
        .count()
        != state.generation as usize
    {
        return Err(INCONSISTENT.into());
    }
    let mut previous = None;
    for generation in 1..=state.generation {
        let event = ctx
            .db
            .protected_mail_read_event()
            .id()
            .find(event_id(&grant.id, generation))
            .ok_or(INCONSISTENT)?;
        if !event_shape(grant, selection, &event) {
            return Err(INCONSISTENT.into());
        }
        if let Some(p) = previous.as_ref() {
            let p: &ProtectedMailReadEvent = p;
            if event.created_at < p.created_at
                || (generation == 3 && p.status != ProtectedMailReadStatus::Dispatching)
            {
                return Err(INCONSISTENT.into());
            }
        }
        previous = Some(event);
    }
    let latest = previous.ok_or(INCONSISTENT)?;
    if state.status != latest.status
        || state.reserved_operations != latest.reserved_operations
        || state.reserved_message_slots != latest.reserved_message_slots
        || state.reserved_body_bytes != latest.reserved_body_bytes
    {
        return Err(INCONSISTENT.into());
    }
    if state.generation < 3
        && ctx
            .db
            .protected_mail_read_event()
            .id()
            .find(event_id(&grant.id, state.generation + 1))
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    Ok(state)
}
fn write_state(
    ctx: &ReducerContext,
    grant: &ProtectedMailReadGrant,
    selection: &ProtectedMailConnectorSelection,
    generation: u64,
    status: ProtectedMailReadStatus,
    nonce: &str,
) -> Result<(), String> {
    let spent = !matches!(
        status,
        ProtectedMailReadStatus::Pending | ProtectedMailReadStatus::CancelledBeforeDispatch
    );
    let mut event = ProtectedMailReadEvent {
        id: event_id(&grant.id, generation),
        read_id: grant.id.clone(),
        generation,
        status: status.clone(),
        event_nonce: nonce.into(),
        request_digest: String::new(),
        actor: ctx.sender(),
        reserved_operations: if spent { 1 } else { 0 },
        reserved_message_slots: if spent {
            selection.uids.len() as u64
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
    if !event_shape(grant, selection, &event)
        || ctx
            .db
            .protected_mail_read_event()
            .id()
            .find(event.id.clone())
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    let state = ProtectedMailReadState {
        read_id: grant.id.clone(),
        generation,
        status,
        reserved_operations: event.reserved_operations,
        reserved_message_slots: event.reserved_message_slots,
        reserved_body_bytes: event.reserved_body_bytes,
        last_event_id: event.id.clone(),
    };
    ctx.db.protected_mail_read_event().insert(event);
    if generation == 1 {
        if ctx
            .db
            .protected_mail_read_state()
            .read_id()
            .find(grant.id.clone())
            .is_some()
        {
            return Err(INCONSISTENT.into());
        }
        ctx.db.protected_mail_read_state().insert(state);
    } else {
        ctx.db.protected_mail_read_state().read_id().update(state);
    }
    Ok(())
}
fn preview(
    ctx: &ReducerContext,
    request: &ProtectedMailReadGrantRequest,
) -> Result<(ProtectedMailConnectorSelection, ProtectedMailReadPreview), String> {
    let selection = owned_selection(ctx, &request.selection_id).map_err(selection_error)?;
    if !hex64(&request.event_nonce) {
        return Err(INVALID.into());
    }
    let canonical = selection_plan(&selection, request)?;
    current_selection(ctx, &selection, false)?;
    let dto = ProtectedMailReadPreview {
        read_id: read_id(&selection.id),
        plan_digest: hex::encode(Sha256::digest(canonical.as_bytes())),
        plan_bytes: canonical.len() as u64,
        canonical,
    };
    Ok((selection, dto))
}
#[procedure]
pub fn review_protected_mail_read_grant(
    ctx: &mut ProcedureContext,
    request: ProtectedMailReadGrantRequest,
) -> Result<ProtectedMailReadPreview, String> {
    ctx.try_with_tx(|tx| {
        preview(tx.as_ref(), &request)
            .map(|(_, dto)| dto)
            .map_err(fixed_error)
    })
}
#[reducer]
pub fn issue_protected_mail_read_grant(
    ctx: &ReducerContext,
    request: ProtectedMailReadGrantRequest,
    expected_plan_digest: String,
) -> Result<(), String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let id = read_id(&request.selection_id);
    if let Some(existing) = ctx.db.protected_mail_read_grant().id().find(id.clone()) {
        if existing.owner != ctx.sender() {
            return Err(OWNER.into());
        }
        let (old, selection, _) = owned_grant(ctx, &id)?;
        checked_state(ctx, &old, &selection)?;
        if old.issue_digest != issue_digest(&id, &request, &expected_plan_digest) {
            return Err(CONFLICT.into());
        }
        return Ok(());
    }
    let (selection, dto) = preview(ctx, &request)?;
    if !hex64(&expected_plan_digest) {
        return Err(INVALID.into());
    }
    if dto.plan_digest != expected_plan_digest {
        return Err(STALE.into());
    }
    let owner_id = owner_event_id(ctx.sender(), &request.event_nonce);
    if ctx
        .db
        .protected_mail_read_grant_event()
        .id()
        .find(owner_id.clone())
        .is_some()
    {
        return Err(CONFLICT.into());
    }
    if ctx
        .db
        .protected_mail_read_state()
        .read_id()
        .find(id.clone())
        .is_some()
        || ctx
            .db
            .protected_mail_read_event()
            .read_id()
            .filter(&id)
            .next()
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    let row = ProtectedMailReadGrant {
        id: id.clone(),
        owner: ctx.sender(),
        selection_id: selection.id.clone(),
        selection_digest: selection.manifest_digest.clone(),
        issue_digest: issue_digest(&id, &request, &dto.plan_digest),
        request,
        plan_digest: dto.plan_digest,
        plan_bytes: dto.plan_bytes,
        canonical: dto.canonical,
        created_at: ctx.timestamp,
    };
    ctx.db
        .protected_mail_read_grant_event()
        .insert(ProtectedMailReadGrantEvent {
            id: owner_id,
            grant_id: id,
            owner: ctx.sender(),
            generation: 1,
            kind: ProtectedMailReadGrantEventKind::Issued,
            event_nonce: row.request.event_nonce.clone(),
            request_digest: row.issue_digest.clone(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    write_state(
        ctx,
        &row,
        &selection,
        1,
        ProtectedMailReadStatus::Pending,
        "",
    )?;
    ctx.db.protected_mail_read_grant().insert(row);
    Ok(())
}
#[reducer]
pub fn revoke_protected_mail_read_grant(
    ctx: &ReducerContext,
    read_id: String,
    event_nonce: String,
) -> Result<(), String> {
    let (grant, selection, revoked) = owned_grant(ctx, &read_id)?;
    checked_state(ctx, &grant, &selection)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    let id = owner_event_id(grant.owner, &event_nonce);
    let request = revoke_digest(&read_id, &event_nonce);
    if let Some(existing) = ctx
        .db
        .protected_mail_read_grant_event()
        .id()
        .find(id.clone())
    {
        if existing.grant_id == grant.id
            && existing.kind == ProtectedMailReadGrantEventKind::Revoked
            && existing.request_digest == request
        {
            return Ok(());
        }
        return Err(CONFLICT.into());
    }
    if revoked {
        return Err(CONFLICT.into());
    }
    ctx.db
        .protected_mail_read_grant_event()
        .insert(ProtectedMailReadGrantEvent {
            id,
            grant_id: read_id,
            owner: grant.owner,
            generation: 2,
            kind: ProtectedMailReadGrantEventKind::Revoked,
            event_nonce,
            request_digest: request,
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    Ok(())
}
fn begin(ctx: &ReducerContext, id: &str) -> Result<ProtectedMailReadDispatch, String> {
    let (grant, selection, revoked) = bound_grant(ctx, id)?;
    let state = checked_state(ctx, &grant, &selection)?;
    if state.status != ProtectedMailReadStatus::Pending {
        return Err(CONSUMED.into());
    }
    if revoked {
        return Err(STALE.into());
    }
    current_selection(ctx, &selection, true)?;
    write_state(
        ctx,
        &grant,
        &selection,
        2,
        ProtectedMailReadStatus::Dispatching,
        "",
    )?;
    Ok(ProtectedMailReadDispatch {
        read_id: grant.id,
        plan_digest: grant.plan_digest,
        plan_bytes: grant.plan_bytes,
        canonical: grant.canonical,
    })
}
#[procedure]
pub fn begin_protected_mail_read_dispatch(
    ctx: &mut ProcedureContext,
    read_id: String,
) -> Result<ProtectedMailReadDispatch, String> {
    ctx.try_with_tx(|tx| begin(tx.as_ref(), &read_id).map_err(fixed_error))
}
fn outcome_status(outcome: &ProtectedMailReadOutcome) -> ProtectedMailReadStatus {
    match outcome {
        ProtectedMailReadOutcome::ReadReported => ProtectedMailReadStatus::ReadReported,
        ProtectedMailReadOutcome::Failed => ProtectedMailReadStatus::Failed,
        ProtectedMailReadOutcome::Unknown => ProtectedMailReadStatus::Unknown,
        ProtectedMailReadOutcome::CancelledBeforeDispatch => {
            ProtectedMailReadStatus::CancelledBeforeDispatch
        }
    }
}
fn permitted_outcome(status: &ProtectedMailReadStatus, outcome: &ProtectedMailReadStatus) -> bool {
    (*status == ProtectedMailReadStatus::Pending
        && *outcome == ProtectedMailReadStatus::CancelledBeforeDispatch)
        || (*status == ProtectedMailReadStatus::Dispatching
            && matches!(
                outcome,
                ProtectedMailReadStatus::ReadReported
                    | ProtectedMailReadStatus::Failed
                    | ProtectedMailReadStatus::Unknown
            ))
}
#[reducer]
pub fn finish_protected_mail_read_dispatch(
    ctx: &ReducerContext,
    read_id: String,
    outcome: ProtectedMailReadOutcome,
    event_nonce: String,
) -> Result<(), String> {
    let (grant, selection, _) = bound_grant(ctx, &read_id)?;
    let state = checked_state(ctx, &grant, &selection)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    let desired = outcome_status(&outcome);
    if terminal(&state.status) {
        let event = ctx
            .db
            .protected_mail_read_event()
            .id()
            .find(state.last_event_id)
            .ok_or(INCONSISTENT)?;
        if desired == state.status && event.event_nonce == event_nonce {
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
        &selection,
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
    use super::super::connector::{
        ProtectedMailConnectorSelectionRequest, ProtectedMailConnectorStoredBatch,
    };
    use super::super::protected::ProtectedMailDirection;
    use super::*;

    fn selection_json(unicode: bool) -> Value {
        let mut value = json!({"formatVersion":1,"kind":"mail.connector.selection","selectionId":"a".repeat(64),"workspaceId":"b".repeat(64),"ownerId":"c".repeat(64),
            "connection":{"id":u64::MAX.to_string(),"epoch":"9007199254740993","snapshotDigest":"d".repeat(64)},
            "connector":{"identity":"e".repeat(64),"runtimeId":"fixture-runtime","runId":"fixture-run"},
            "mailbox":{"host":"imap.example.test","port":993,"username":"quoted\"user\\@example.test","folder":"Inbox \"quoted\"\\","direction":"received"},
            "selection":{"mode":"stored_batch","uidValidity":u32::MAX.to_string(),"expectedCursorGeneration":u64::MAX.to_string(),"previousCursorDigest":"f".repeat(64),
                "fromUid":2,"throughUid":3,"uids":[2,3],"maxAcknowledgedBytes":1},"notBeforeMs":1_700_000_000_000u64,"expiresAtMs":1_700_003_600_000u64});
        if unicode {
            value["connection"]["id"] = json!("9007199254740993");
            value["connection"]["epoch"] = json!(u64::MAX.to_string());
            value["mailbox"] = json!({"host":"imap.example.test","port":65535,"username":"日本語🍐e\u{301}\u{2028}@example.test","folder":"送信済み🍐\u{2028}e\u{301}","direction":"sent"});
            value["selection"] = json!({"mode":"stored_batch","uidValidity":"7","expectedCursorGeneration":u64::MAX.to_string(),"previousCursorDigest":"f".repeat(64),
                "fromUid":u32::MAX-7,"throughUid":u32::MAX,"uids":(u32::MAX-7..=u32::MAX).collect::<Vec<_>>(),"maxAcknowledgedBytes":2_097_152});
        }
        value
    }
    fn fixture() -> (ProtectedMailReadGrant, ProtectedMailConnectorSelection) {
        let selection_value = selection_json(false);
        let canonical = canonical(&selection_value).unwrap();
        let selection_digest = hex::encode(Sha256::digest(canonical.as_bytes()));
        let selection = ProtectedMailConnectorSelection {
            id: "a".repeat(64),
            owner: Identity::from_byte_array([0xcc; 32]),
            workspace: Identity::from_byte_array([0xbb; 32]),
            request: ProtectedMailConnectorSelectionRequest {
                connection_id: u64::MAX,
                connector_identity: Identity::from_byte_array([0xee; 32]),
                runtime_id: "fixture-runtime".into(),
                run_id: "fixture-run".into(),
                direction: ProtectedMailDirection::Received,
                window: ProtectedMailConnectorWindow::StoredBatch(
                    ProtectedMailConnectorStoredBatch {
                        uid_validity: u32::MAX.to_string(),
                        expected_cursor_generation: u64::MAX,
                        message_count: 2,
                        max_acknowledged_bytes: 1,
                    },
                ),
                not_before_ms: 1_700_000_000_000,
                expires_at_ms: 1_700_003_600_000,
                event_nonce: "1".repeat(64),
            },
            connection_epoch: 9_007_199_254_740_993,
            snapshot_digest: "d".repeat(64),
            host: "imap.example.test".into(),
            port: 993,
            username: "quoted\"user\\@example.test".into(),
            folder: "Inbox \"quoted\"\\".into(),
            expected_cursor_generation: u64::MAX,
            previous_cursor_digest: "f".repeat(64),
            from_uid: 2,
            through_uid: 3,
            uids: vec![2, 3],
            max_acknowledged_bytes: 1,
            manifest_digest: selection_digest,
            manifest_bytes: canonical.len() as u64,
            canonical,
            issue_digest: "f".repeat(64),
            created_at: Timestamp::from_micros_since_unix_epoch(1_700_000_000_000_000),
        };
        let request = ProtectedMailReadGrantRequest {
            selection_id: selection.id.clone(),
            max_message_bytes: MAX_MESSAGE,
            max_total_bytes: 1_048_576,
            event_nonce: "2".repeat(64),
        };
        let canonical = selection_plan(&selection, &request).unwrap();
        let plan_digest = hex::encode(Sha256::digest(canonical.as_bytes()));
        let grant = ProtectedMailReadGrant {
            id: read_id(&selection.id),
            owner: selection.owner,
            selection_id: selection.id.clone(),
            selection_digest: selection.manifest_digest.clone(),
            issue_digest: issue_digest(&read_id(&selection.id), &request, &plan_digest),
            request,
            plan_digest,
            plan_bytes: canonical.len() as u64,
            canonical,
            created_at: selection.created_at,
        };
        (grant, selection)
    }
    fn event(
        grant: &ProtectedMailReadGrant,
        selection: &ProtectedMailConnectorSelection,
        generation: u64,
        status: ProtectedMailReadStatus,
    ) -> ProtectedMailReadEvent {
        let pending = status == ProtectedMailReadStatus::Pending;
        let cancelled = status == ProtectedMailReadStatus::CancelledBeforeDispatch;
        let spent = !pending && !cancelled;
        let mut event = ProtectedMailReadEvent {
            id: event_id(&grant.id, generation),
            read_id: grant.id.clone(),
            generation,
            status,
            event_nonce: if generation == 3 || cancelled {
                "3".repeat(64)
            } else {
                String::new()
            },
            request_digest: String::new(),
            actor: if pending {
                grant.owner
            } else {
                selection.request.connector_identity
            },
            reserved_operations: if spent { 1 } else { 0 },
            reserved_message_slots: if spent {
                selection.uids.len() as u64
            } else {
                0
            },
            reserved_body_bytes: if spent {
                grant.request.max_total_bytes
            } else {
                0
            },
            created_at: grant.created_at,
        };
        event.request_digest = event_digest(grant, &event);
        event
    }
    #[test]
    fn escaped_plan_matches_independent_selection_and_read_goldens() {
        let (grant, selection) = fixture();
        assert_eq!(selection.manifest_bytes, 1058);
        assert_eq!(
            selection.manifest_digest,
            "1b4aaef21712b771ea1f572405ab0aed20c5094fa6f0769f51b5193e0f4558d6"
        );
        assert_eq!(
            grant.id,
            "bd59b410c67e7ef343f8d6b4689fc9bb74ccbc402b97fbbc8550710ef3ddae2c"
        );
        assert_eq!(grant.plan_bytes, 1442);
        assert_eq!(
            grant.plan_digest,
            "a7e0e6e8f0f6ec10dce608184b518799b2f2b3323094c0fcffc851e110de0b90"
        );
    }
    #[test]
    fn unicode_plan_preserves_scalar_bytes_and_full_integer_selection() {
        let selection = selection_json(true);
        let encoded = canonical(&selection).unwrap();
        assert_eq!(encoded.len(), 1164);
        let digest = hex::encode(Sha256::digest(encoded.as_bytes()));
        assert_eq!(
            digest,
            "54e5e98a4f7f972833b3796b1e7f7d6bc5f2e6a8464a7e12ec96537130ba2197"
        );
        let encoded = plan(
            &selection,
            &digest,
            &read_id(&"a".repeat(64)),
            MAX_MESSAGE,
            MAX_TOTAL,
            8,
        )
        .unwrap();
        assert_eq!(encoded.len(), 1548);
        assert_eq!(
            hex::encode(Sha256::digest(encoded.as_bytes())),
            "b857747278ce1db25100cb32e73d1b142872a54ce70d46f1132e4079716fe3c2"
        );
        assert!(encoded.contains("18446744073709551615"));
        assert!(encoded.contains("送信済み🍐\u{2028}e\u{301}"));
    }
    #[test]
    fn caps_allow_partial_aggregate_but_never_an_extra_probe_octet() {
        assert!(valid_caps(1, 1, 1).is_ok());
        assert!(valid_caps(MAX_MESSAGE, MAX_TOTAL, 8).is_ok());
        assert_eq!(
            valid_caps(MAX_MESSAGE + 1, MAX_TOTAL, 8).unwrap_err(),
            LIMIT
        );
        assert_eq!(
            valid_caps(MAX_MESSAGE, MAX_TOTAL + 1, 8).unwrap_err(),
            LIMIT
        );
        for (message, total, count) in [
            (0, 1, 1),
            (1, 0, 1),
            (2, 1, 1),
            (1, 2, 1),
            (1, 1, 0),
            (1, 1, 9),
        ] {
            assert_eq!(valid_caps(message, total, count).unwrap_err(), INVALID);
        }
        assert!(valid_caps(MAX_MESSAGE, MAX_MESSAGE, 8).is_ok());
    }
    #[test]
    fn plan_is_closed_metadata_with_fixed_profile_and_full_reservation() {
        let (grant, _) = fixture();
        let value: Value = serde_json::from_str(&grant.canonical).unwrap();
        assert_eq!(
            value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                "formatVersion",
                "kind",
                "limits",
                "profile",
                "readId",
                "reservation",
                "selection",
                "selectionDigest"
            ]
        );
        assert_eq!(value["profile"], "imap.uid-body-peek.v1");
        assert_eq!(
            value["reservation"],
            json!({"bodyBytes":1_048_576,"messageSlots":2,"operations":1})
        );
        assert_eq!(value["selection"]["selection"]["uids"], json!([2, 3]));
        assert_eq!(
            value["selection"]["mailbox"]["username"],
            "quoted\"user\\@example.test"
        );
    }
    #[test]
    fn all_plan_and_issue_bindings_change_commitments() {
        let (grant, selection) = fixture();
        let original = grant.canonical.clone();
        let mut changed = grant.request.clone();
        changed.max_message_bytes -= 1;
        changed.max_total_bytes -= 2;
        assert_ne!(selection_plan(&selection, &changed).unwrap(), original);
        changed = grant.request.clone();
        changed.max_total_bytes -= 1;
        assert_ne!(selection_plan(&selection, &changed).unwrap(), original);
        let original = grant.issue_digest.clone();
        changed = grant.request.clone();
        changed.event_nonce = "4".repeat(64);
        assert_ne!(
            issue_digest(&grant.id, &changed, &grant.plan_digest),
            original
        );
        assert_ne!(
            issue_digest(&grant.id, &grant.request, &"a".repeat(64)),
            original
        );
        assert_ne!(
            issue_digest(&"b".repeat(64), &grant.request, &grant.plan_digest),
            original
        );
    }
    #[test]
    fn one_read_id_is_global_per_selection_not_per_attempt_or_cap() {
        let (grant, _) = fixture();
        assert_eq!(read_id(&grant.selection_id), grant.id);
        let mut changed = grant.request.clone();
        changed.event_nonce = "f".repeat(64);
        changed.max_total_bytes -= 1;
        assert_eq!(read_id(&changed.selection_id), grant.id);
        assert_ne!(read_id(&"b".repeat(64)), grant.id);
        assert_ne!(
            grant.id,
            hash("pear-mail-read-other-version", &[grant.selection_id])
        );
    }
    #[test]
    fn owner_nonce_namespace_is_shared_across_new_grants_but_not_owners() {
        let owner = Identity::from_byte_array([1; 32]);
        let other = Identity::from_byte_array([2; 32]);
        let nonce = "a".repeat(64);
        assert_eq!(owner_event_id(owner, &nonce), owner_event_id(owner, &nonce));
        assert_ne!(owner_event_id(owner, &nonce), owner_event_id(other, &nonce));
        assert_ne!(owner_event_id(owner, &nonce), event_id(&nonce, 1));
        assert_ne!(event_id(&nonce, 1), event_id(&nonce, 2));
        assert_ne!(
            revoke_digest("first", &nonce),
            revoke_digest("second", &nonce)
        );
    }
    #[test]
    fn full_reservation_is_retained_for_every_dispatched_outcome() {
        let (grant, selection) = fixture();
        assert!(event_shape(
            &grant,
            &selection,
            &event(&grant, &selection, 1, ProtectedMailReadStatus::Pending)
        ));
        assert!(event_shape(
            &grant,
            &selection,
            &event(&grant, &selection, 2, ProtectedMailReadStatus::Dispatching)
        ));
        for status in [
            ProtectedMailReadStatus::ReadReported,
            ProtectedMailReadStatus::Failed,
            ProtectedMailReadStatus::Unknown,
        ] {
            let mut e = event(&grant, &selection, 3, status);
            assert!(event_shape(&grant, &selection, &e));
            e.reserved_body_bytes = 1;
            e.request_digest = event_digest(&grant, &e);
            assert!(!event_shape(&grant, &selection, &e));
        }
        let mut e = event(
            &grant,
            &selection,
            2,
            ProtectedMailReadStatus::CancelledBeforeDispatch,
        );
        assert!(event_shape(&grant, &selection, &e));
        e.reserved_operations = 1;
        e.request_digest = event_digest(&grant, &e);
        assert!(!event_shape(&grant, &selection, &e));
    }
    #[test]
    fn only_pending_cancel_or_dispatched_report_transitions_are_permitted() {
        use ProtectedMailReadStatus::*;
        for before in [
            Pending,
            Dispatching,
            ReadReported,
            Failed,
            Unknown,
            CancelledBeforeDispatch,
        ] {
            for outcome in [
                ProtectedMailReadOutcome::ReadReported,
                ProtectedMailReadOutcome::Failed,
                ProtectedMailReadOutcome::Unknown,
                ProtectedMailReadOutcome::CancelledBeforeDispatch,
            ] {
                let after = outcome_status(&outcome);
                let expected = (before == Pending && after == CancelledBeforeDispatch)
                    || (before == Dispatching && matches!(after, ReadReported | Failed | Unknown));
                assert_eq!(permitted_outcome(&before, &after), expected);
            }
        }
        for after in [ReadReported, Failed, Unknown, CancelledBeforeDispatch] {
            assert!(terminal(&after));
        }
        assert!(!terminal(&Pending));
        assert!(!terminal(&Dispatching));
    }
    #[test]
    fn event_association_checks_actor_generation_nonce_and_spending() {
        let (grant, selection) = fixture();
        let original = event(&grant, &selection, 2, ProtectedMailReadStatus::Dispatching);
        assert!(event_shape(&grant, &selection, &original));
        let mutations: Vec<Box<dyn Fn(&mut ProtectedMailReadEvent)>> = vec![
            Box::new(|e| e.actor = Identity::from_byte_array([3; 32])),
            Box::new(|e| e.generation = 3),
            Box::new(|e| e.event_nonce = "a".repeat(64)),
            Box::new(|e| e.reserved_message_slots = 1),
            Box::new(|e| e.reserved_operations = 0),
            Box::new(|e| e.read_id = "a".repeat(64)),
        ];
        for mutate in mutations {
            let mut e = event(&grant, &selection, 2, ProtectedMailReadStatus::Dispatching);
            mutate(&mut e);
            e.request_digest = event_digest(&grant, &e);
            assert!(!event_shape(&grant, &selection, &e));
        }
        let mut e = event(&grant, &selection, 3, ProtectedMailReadStatus::Unknown);
        let digest = e.request_digest.clone();
        e.event_nonce = "f".repeat(64);
        assert_ne!(event_digest(&grant, &e), digest);
    }
    #[test]
    fn no_new_only_plan_or_unbounded_metadata() {
        let (grant, mut selection) = fixture();
        selection.request.window = ProtectedMailConnectorWindow::NewOnly(
            super::super::connector::ProtectedMailConnectorNewOnly {
                uid_validity: "7".into(),
                uid_next: 1,
            },
        );
        assert_eq!(
            selection_plan(&selection, &grant.request).unwrap_err(),
            INVALID
        );
        let value = json!({"syntheticMetadata":"x".repeat(MAX_PLAN)});
        assert_eq!(
            plan(&value, &"a".repeat(64), &"b".repeat(64), 1, 1, 1).unwrap_err(),
            LIMIT
        );
    }
    #[test]
    fn finite_error_mapping_never_exposes_private_subsystem_text() {
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
            fixed_error("SYNTHETIC_PRIVATE_READ_ERROR".into()),
            INCONSISTENT
        );
        assert_eq!(
            selection_error("protected_mail_connector_stale".into()),
            STALE
        );
        assert_eq!(
            selection_error("protected_mail_connector_service_required".into()),
            SERVICE
        );
        assert_eq!(
            selection_error("protected_mail_connector_source_required".into()),
            INCONSISTENT
        );
    }
}
