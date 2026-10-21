//! Exact owner-reviewed prepared text ingestion. No mailbox execution, MIME
//! parsing, sanitization certification, processor policy, or workflow activation.
use super::admission::{canonical, hash, hex64, human, now_ms};
use super::connector::{
    self, protected_mail_connector_cursor, CursorDescriptor, ProtectedMailConnectorCursor,
    ProtectedMailConnectorSelection,
};
use super::governance::ProtectedMailSourceRef;
use super::protected::{
    self, protected_mail_collection, protected_mail_receipt, ProtectedMailDirection,
    ProtectedMailInput,
};
use super::read::{self, protected_mail_read_grant, ProtectedMailReadGrant};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spacetimedb::{
    procedure, reducer, table, Identity, ProcedureContext, ReducerContext, SpacetimeType, Table,
    Timestamp,
};

const INVALID: &str = "protected_mail_ingestion_invalid_request";
const INCONSISTENT: &str = "protected_mail_ingestion_inconsistent";
const OWNER: &str = "protected_mail_ingestion_owner_required";
const SERVICE: &str = "protected_mail_ingestion_service_required";
const CONFLICT: &str = "protected_mail_ingestion_event_conflict";
const STALE: &str = "protected_mail_ingestion_stale";
const LIMIT: &str = "protected_mail_ingestion_limit_exceeded";
const MAX_BYTES: u64 = 2_097_152;
const SAFE: u64 = 9_007_199_254_740_991;
const MAX_TTL: u64 = 3_600_000;

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailIngestionRequest {
    pub read_id: String,
    pub not_before_ms: u64,
    pub expires_at_ms: u64,
    pub max_envelope_bytes: u64,
    pub event_nonce: String,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailHeldReason {
    AuthenticationMaterial,
    SensitiveContent,
    UnsupportedContent,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailHeldInput {
    pub uid: u32,
    pub reason: ProtectedMailHeldReason,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailIngestionEntry {
    Imported(ProtectedMailInput),
    Held(ProtectedMailHeldInput),
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailIngestionAuthorizationEventKind {
    Issued,
    Revoked,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailIngestionDispositionKind {
    Imported(ProtectedMailSourceRef),
    Held(ProtectedMailHeldReason),
}

#[table(accessor=protected_mail_ingestion_authorization,private)]
pub struct ProtectedMailIngestionAuthorization {
    #[primary_key]
    pub read_id: String,
    #[index(btree)]
    pub owner: Identity,
    pub request: ProtectedMailIngestionRequest,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub read_plan_digest: String,
    pub selection_digest: String,
    pub payload_digest: String,
    pub payload_bytes: u64,
    pub entry_count: u32,
    pub manifest_digest: String,
    pub manifest_bytes: u64,
    pub canonical: String,
    pub issue_digest: String,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_ingestion_authorization_event,private)]
pub struct ProtectedMailIngestionAuthorizationEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub read_id: String,
    pub generation: u64,
    pub kind: ProtectedMailIngestionAuthorizationEventKind,
    pub event_nonce: String,
    pub request_digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_ingestion_disposition,private)]
pub struct ProtectedMailIngestionDisposition {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub read_id: String,
    pub owner: Identity,
    pub collection_id: u64,
    pub folder: String,
    pub uid_validity: String,
    pub uid: u32,
    pub direction: ProtectedMailDirection,
    pub kind: ProtectedMailIngestionDispositionKind,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_ingestion_receipt,private)]
pub struct ProtectedMailIngestionReceipt {
    #[primary_key]
    pub read_id: String,
    pub selection_id: String,
    pub event_nonce: String,
    pub request_digest: String,
    pub payload_digest: String,
    pub envelope_bytes: u64,
    pub disposition_ids: Vec<String>,
    pub cursor_id: String,
    pub cursor_generation: u64,
    pub history_id: String,
    pub cursor_digest: String,
    pub uid_validity: String,
    pub last_uid: u32,
    pub imported_messages: u32,
    pub held_messages: u32,
    pub digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_ingestion_cursor_history,private)]
pub struct ProtectedMailIngestionCursorHistory {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub cursor_id: String,
    pub owner: Identity,
    pub collection_id: u64,
    pub folder: String,
    pub uid_validity: String,
    pub generation: u64,
    pub last_uid: u32,
    pub previous_digest: String,
    pub read_id: String,
    pub selection_id: String,
    pub request_digest: String,
    pub imported_messages: u32,
    pub held_messages: u32,
    pub envelope_bytes: u64,
    pub digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailIngestionPreview {
    pub read_id: String,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub payload_digest: String,
    pub payload_bytes: u64,
    pub manifest_digest: String,
    pub manifest_bytes: u64,
    pub canonical: String,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailIngestionReceiptDto {
    pub read_id: String,
    pub selection_id: String,
    pub cursor_id: String,
    pub cursor_generation: u64,
    pub uid_validity: String,
    pub last_uid: u32,
    pub imported_messages: u32,
    pub held_messages: u32,
    pub envelope_bytes: u64,
    pub receipt_digest: String,
}

fn owner_event_id(owner: Identity, nonce: &str) -> String {
    hash(
        "pear-mail-ingestion-owner-event-v1",
        &[owner.to_hex().to_string(), nonce.into()],
    )
}
pub(super) fn history_id(cursor: &str, generation: u64) -> String {
    format!(
        "mail-ingestion-cursor-history:{}",
        hash(
            "pear-mail-ingestion-cursor-history-id-v1",
            &[cursor.into(), generation.to_string()]
        )
    )
}
fn mail_event_key(id: &str, uid: u32) -> String {
    hash(
        "pear-mail-ingestion-mail-event-v1",
        &[id.into(), uid.to_string()],
    )
}
fn sha(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn reason(reason: &ProtectedMailHeldReason) -> &'static str {
    match reason {
        ProtectedMailHeldReason::AuthenticationMaterial => "authentication_material",
        ProtectedMailHeldReason::SensitiveContent => "sensitive_content",
        ProtectedMailHeldReason::UnsupportedContent => "unsupported_content",
    }
}
fn direction(value: &ProtectedMailDirection) -> &'static str {
    match value {
        ProtectedMailDirection::Received => "received",
        ProtectedMailDirection::Sent => "sent",
    }
}
fn uid(entry: &ProtectedMailIngestionEntry) -> u32 {
    match entry {
        ProtectedMailIngestionEntry::Imported(m) => m.uid,
        ProtectedMailIngestionEntry::Held(h) => h.uid,
    }
}
fn entry_json(entry: &ProtectedMailIngestionEntry) -> Value {
    match entry {
        ProtectedMailIngestionEntry::Imported(m) => {
            json!({"uid":m.uid,"kind":"imported","message":{"folder":m.folder,"uidValidity":m.uid_validity,"uid":m.uid,"direction":direction(&m.direction),"messageDate":m.message_date,"from":m.from,"to":m.to,"cc":m.cc,"subject":m.subject,"body":m.body,"note":m.note,"sanitizationVersion":m.sanitization_version}})
        }
        ProtectedMailIngestionEntry::Held(h) => {
            json!({"uid":h.uid,"kind":"held","reason":reason(&h.reason)})
        }
    }
}
fn payload(
    grant: &ProtectedMailReadGrant,
    selection: &ProtectedMailConnectorSelection,
    entries: &[ProtectedMailIngestionEntry],
) -> Result<String, String> {
    if entries.len() > 8 {
        return Err(LIMIT.into());
    }
    if entries.is_empty() || entries.len() != selection.uids.len() {
        return Err(INVALID.into());
    }
    for (entry, selected) in entries.iter().zip(&selection.uids) {
        if uid(entry) != *selected {
            return Err(INVALID.into());
        }
        if let ProtectedMailIngestionEntry::Imported(m) = entry {
            protected::validate_message(&mail_event_key(&grant.id, m.uid), m)
                .map_err(|_| INVALID)?;
            if m.folder != selection.folder
                || m.uid_validity != connector::validity(&selection.request.window)
                || m.direction != selection.request.direction
            {
                return Err(INVALID.into());
            }
        }
    }
    let read: Value = serde_json::from_str(&grant.canonical).map_err(|_| INCONSISTENT)?;
    let value=canonical(&json!({"formatVersion":1,"kind":"mail.ingestion.batch","read":read,"entries":entries.iter().map(entry_json).collect::<Vec<_>>()})).map_err(|_|INCONSISTENT)?;
    if value.len() as u64 > MAX_BYTES {
        return Err(LIMIT.into());
    }
    Ok(value)
}
fn valid_request(request: &ProtectedMailIngestionRequest) -> Result<(), String> {
    if !hex64(&request.read_id)
        || !hex64(&request.event_nonce)
        || request.not_before_ms > SAFE
        || request.expires_at_ms > SAFE
        || request.expires_at_ms == 0
        || request.not_before_ms > request.expires_at_ms
        || request.max_envelope_bytes == 0
    {
        return Err(INVALID.into());
    }
    if request.max_envelope_bytes > MAX_BYTES {
        return Err(LIMIT.into());
    }
    Ok(())
}
fn manifest(
    request: &ProtectedMailIngestionRequest,
    grant: &ProtectedMailReadGrant,
    digest: &str,
    bytes: u64,
    slots: u32,
) -> Result<String, String> {
    let read: Value = serde_json::from_str(&grant.canonical).map_err(|_| INCONSISTENT)?;
    let result=canonical(&json!({"formatVersion":1,"kind":"mail.ingestion.authorization","request":{"readId":request.read_id,"notBeforeMs":request.not_before_ms,"expiresAtMs":request.expires_at_ms,"maxEnvelopeBytes":request.max_envelope_bytes,"eventNonce":request.event_nonce},"read":read,"readPlanDigest":grant.plan_digest,"payload":{"digest":digest,"bytes":bytes,"slots":slots}})).map_err(|_|INCONSISTENT)?;
    if result.len() > 16384 {
        return Err(LIMIT.into());
    }
    Ok(result)
}
fn issue_digest(
    request: &ProtectedMailIngestionRequest,
    epoch: u64,
    snapshot: &str,
    manifest: &str,
) -> String {
    hash(
        "pear-mail-ingestion-issue-v1",
        &[
            request.read_id.clone(),
            request.not_before_ms.to_string(),
            request.expires_at_ms.to_string(),
            request.max_envelope_bytes.to_string(),
            request.event_nonce.clone(),
            epoch.to_string(),
            snapshot.into(),
            manifest.into(),
        ],
    )
}
fn revoke_digest(id: &str, nonce: &str) -> String {
    hash("pear-mail-ingestion-revoke-v1", &[id.into(), nonce.into()])
}
fn accept_digest(id: &str, nonce: &str, payload_digest: &str, bytes: u64) -> String {
    hash(
        "pear-mail-ingestion-accept-v1",
        &[
            id.into(),
            nonce.into(),
            payload_digest.into(),
            bytes.to_string(),
        ],
    )
}
fn window_valid(
    request: &ProtectedMailIngestionRequest,
    selection: &ProtectedMailConnectorSelection,
    created: u64,
) -> bool {
    request.not_before_ms >= selection.request.not_before_ms
        && request.expires_at_ms <= selection.request.expires_at_ms
        && request.expires_at_ms > created
        && request.expires_at_ms - created <= MAX_TTL
}
fn read_error(error: String) -> String {
    match error.as_str() {
        "protected_mail_read_owner_required" => OWNER.into(),
        "protected_mail_read_service_required" => SERVICE.into(),
        "protected_mail_read_stale" => STALE.into(),
        "protected_mail_read_event_conflict" => CONFLICT.into(),
        "protected_mail_read_invalid_request" => INVALID.into(),
        "protected_mail_read_limit_exceeded" => LIMIT.into(),
        _ => INCONSISTENT.into(),
    }
}
fn connector_error(error: String) -> String {
    if error == "protected_mail_connector_stale" {
        STALE.into()
    } else {
        INCONSISTENT.into()
    }
}
fn retained_authorization(
    ctx: &ReducerContext,
    id: &str,
    grant: &ProtectedMailReadGrant,
    selection: &ProtectedMailConnectorSelection,
) -> Result<(ProtectedMailIngestionAuthorization, bool), String> {
    let row = ctx
        .db
        .protected_mail_ingestion_authorization()
        .read_id()
        .find(id.to_owned())
        .ok_or(STALE)?;
    let canonical = manifest(
        &row.request,
        grant,
        &row.payload_digest,
        row.payload_bytes,
        row.entry_count,
    )
    .map_err(|_| INCONSISTENT)?;
    let created = u64::try_from(row.created_at.to_micros_since_unix_epoch() / 1000)
        .map_err(|_| INCONSISTENT)?;
    if valid_request(&row.request).is_err()
        || row.read_id != id
        || row.request.read_id != id
        || row.owner != selection.owner
        || row.connection_epoch != selection.connection_epoch
        || row.snapshot_digest != selection.snapshot_digest
        || row.read_plan_digest != grant.plan_digest
        || row.selection_digest != selection.manifest_digest
        || !hex64(&row.payload_digest)
        || row.payload_bytes == 0
        || row.payload_bytes > row.request.max_envelope_bytes
        || row.entry_count != selection.uids.len() as u32
        || row.canonical != canonical
        || row.manifest_digest != sha(&canonical)
        || row.manifest_bytes != canonical.len() as u64
        || row.issue_digest
            != issue_digest(
                &row.request,
                row.connection_epoch,
                &row.snapshot_digest,
                &row.manifest_digest,
            )
        || row.created_at < grant.created_at
        || !window_valid(&row.request, selection, created)
    {
        return Err(INCONSISTENT.into());
    }
    let events = ctx
        .db
        .protected_mail_ingestion_authorization_event()
        .read_id()
        .filter(&row.read_id)
        .take(3)
        .collect::<Vec<_>>();
    if events.is_empty() || events.len() > 2 {
        return Err(INCONSISTENT.into());
    }
    let (mut issued, mut revoked) = (false, false);
    for event in events {
        if !hex64(&event.event_nonce)
            || event.id != owner_event_id(row.owner, &event.event_nonce)
            || event.actor != row.owner
        {
            return Err(INCONSISTENT.into());
        }
        match event.kind {
            ProtectedMailIngestionAuthorizationEventKind::Issued
                if !issued
                    && event.generation == 1
                    && event.event_nonce == row.request.event_nonce
                    && event.request_digest == row.issue_digest
                    && event.created_at == row.created_at =>
            {
                issued = true
            }
            ProtectedMailIngestionAuthorizationEventKind::Revoked
                if !revoked
                    && event.generation == 2
                    && event.event_nonce != row.request.event_nonce
                    && event.request_digest == revoke_digest(id, &event.event_nonce)
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
fn preview(
    ctx: &ReducerContext,
    request: ProtectedMailIngestionRequest,
    entries: &[ProtectedMailIngestionEntry],
) -> Result<ProtectedMailIngestionAuthorization, String> {
    let (grant, selection, _, _) =
        read::ingestion_read(ctx, &request.read_id, true).map_err(read_error)?;
    valid_request(&request)?;
    read::current_ingestion_read(ctx, &grant, &selection, true).map_err(read_error)?;
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if !window_valid(&request, &selection, now) {
        return Err(STALE.into());
    }
    let payload = payload(&grant, &selection, entries)?;
    if payload.len() as u64 > request.max_envelope_bytes {
        return Err(LIMIT.into());
    }
    let digest = sha(&payload);
    let canonical = manifest(
        &request,
        &grant,
        &digest,
        payload.len() as u64,
        entries.len() as u32,
    )?;
    let manifest_digest = sha(&canonical);
    Ok(ProtectedMailIngestionAuthorization {
        read_id: request.read_id.clone(),
        owner: selection.owner,
        connection_epoch: selection.connection_epoch,
        snapshot_digest: selection.snapshot_digest.clone(),
        read_plan_digest: grant.plan_digest.clone(),
        selection_digest: selection.manifest_digest.clone(),
        payload_digest: digest,
        payload_bytes: payload.len() as u64,
        entry_count: entries.len() as u32,
        manifest_bytes: canonical.len() as u64,
        issue_digest: issue_digest(
            &request,
            selection.connection_epoch,
            &selection.snapshot_digest,
            &manifest_digest,
        ),
        request,
        manifest_digest,
        canonical,
        created_at: ctx.timestamp,
    })
}
fn preview_dto(row: ProtectedMailIngestionAuthorization) -> ProtectedMailIngestionPreview {
    ProtectedMailIngestionPreview {
        read_id: row.read_id,
        connection_epoch: row.connection_epoch,
        snapshot_digest: row.snapshot_digest,
        payload_digest: row.payload_digest,
        payload_bytes: row.payload_bytes,
        manifest_digest: row.manifest_digest,
        manifest_bytes: row.manifest_bytes,
        canonical: row.canonical,
    }
}
#[procedure]
pub fn review_protected_mail_ingestion(
    ctx: &mut ProcedureContext,
    request: ProtectedMailIngestionRequest,
    entries: Vec<ProtectedMailIngestionEntry>,
) -> Result<ProtectedMailIngestionPreview, String> {
    ctx.try_with_tx(|tx| {
        preview(tx.as_ref(), request.clone(), &entries)
            .map(preview_dto)
            .map_err(fixed_error)
    })
}
#[reducer]
pub fn issue_protected_mail_ingestion(
    ctx: &ReducerContext,
    request: ProtectedMailIngestionRequest,
    entries: Vec<ProtectedMailIngestionEntry>,
    expected_epoch: u64,
    expected_snapshot_digest: String,
    expected_manifest_digest: String,
) -> Result<(), String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    if let Some(row) = ctx
        .db
        .protected_mail_ingestion_authorization()
        .read_id()
        .find(request.read_id.clone())
    {
        if row.owner != ctx.sender() {
            return Err(OWNER.into());
        }
        let (grant, selection, _, _) =
            read::ingestion_read(ctx, &request.read_id, true).map_err(read_error)?;
        let (row, _) = retained_authorization(ctx, &request.read_id, &grant, &selection)?;
        let content = payload(&grant, &selection, &entries)?;
        if row.issue_digest
            != issue_digest(
                &request,
                expected_epoch,
                &expected_snapshot_digest,
                &expected_manifest_digest,
            )
            || row.payload_digest != sha(&content)
            || row.payload_bytes != content.len() as u64
        {
            return Err(CONFLICT.into());
        }
        return Ok(());
    }
    let row = preview(ctx, request, &entries)?;
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
        .protected_mail_ingestion_authorization_event()
        .id()
        .find(owner_event_id(row.owner, &row.request.event_nonce))
        .is_some()
    {
        return Err(CONFLICT.into());
    }
    if ctx
        .db
        .protected_mail_ingestion_authorization_event()
        .read_id()
        .filter(&row.read_id)
        .next()
        .is_some()
        || ctx
            .db
            .protected_mail_ingestion_receipt()
            .read_id()
            .find(row.read_id.clone())
            .is_some()
        || ctx
            .db
            .protected_mail_ingestion_disposition()
            .read_id()
            .filter(&row.read_id)
            .next()
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    ctx.db
        .protected_mail_ingestion_authorization_event()
        .insert(ProtectedMailIngestionAuthorizationEvent {
            id: owner_event_id(row.owner, &row.request.event_nonce),
            read_id: row.read_id.clone(),
            generation: 1,
            kind: ProtectedMailIngestionAuthorizationEventKind::Issued,
            event_nonce: row.request.event_nonce.clone(),
            request_digest: row.issue_digest.clone(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    ctx.db.protected_mail_ingestion_authorization().insert(row);
    Ok(())
}
#[reducer]
pub fn revoke_protected_mail_ingestion(
    ctx: &ReducerContext,
    read_id: String,
    event_nonce: String,
) -> Result<(), String> {
    let (grant, selection, _, _) = read::ingestion_read(ctx, &read_id, true).map_err(read_error)?;
    let (row, revoked) = retained_authorization(ctx, &read_id, &grant, &selection)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    let id = owner_event_id(row.owner, &event_nonce);
    let request_digest = revoke_digest(&read_id, &event_nonce);
    if let Some(old) = ctx
        .db
        .protected_mail_ingestion_authorization_event()
        .id()
        .find(id.clone())
    {
        if old.read_id == read_id
            && old.kind == ProtectedMailIngestionAuthorizationEventKind::Revoked
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
        .protected_mail_ingestion_authorization_event()
        .insert(ProtectedMailIngestionAuthorizationEvent {
            id,
            read_id,
            generation: 2,
            kind: ProtectedMailIngestionAuthorizationEventKind::Revoked,
            event_nonce,
            request_digest,
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    Ok(())
}
fn history_digest(row: &ProtectedMailIngestionCursorHistory) -> String {
    hash(
        "pear-mail-ingestion-cursor-state-v1",
        &[
            row.id.clone(),
            row.cursor_id.clone(),
            row.owner.to_hex().to_string(),
            row.collection_id.to_string(),
            row.folder.clone(),
            row.uid_validity.clone(),
            row.generation.to_string(),
            row.last_uid.to_string(),
            row.previous_digest.clone(),
            row.read_id.clone(),
            row.selection_id.clone(),
            row.request_digest.clone(),
            row.imported_messages.to_string(),
            row.held_messages.to_string(),
            row.envelope_bytes.to_string(),
            row.actor.to_hex().to_string(),
            row.created_at.to_micros_since_unix_epoch().to_string(),
        ],
    )
}
fn receipt_digest(row: &ProtectedMailIngestionReceipt) -> String {
    let mut fields = vec![
        row.read_id.clone(),
        row.selection_id.clone(),
        row.event_nonce.clone(),
        row.request_digest.clone(),
        row.payload_digest.clone(),
        row.envelope_bytes.to_string(),
        row.cursor_id.clone(),
        row.cursor_generation.to_string(),
        row.history_id.clone(),
        row.cursor_digest.clone(),
        row.uid_validity.clone(),
        row.last_uid.to_string(),
        row.imported_messages.to_string(),
        row.held_messages.to_string(),
        row.actor.to_hex().to_string(),
        row.created_at.to_micros_since_unix_epoch().to_string(),
    ];
    fields.extend(row.disposition_ids.clone());
    hash("pear-mail-ingestion-receipt-v1", &fields)
}
fn dto(row: &ProtectedMailIngestionReceipt) -> ProtectedMailIngestionReceiptDto {
    ProtectedMailIngestionReceiptDto {
        read_id: row.read_id.clone(),
        selection_id: row.selection_id.clone(),
        cursor_id: row.cursor_id.clone(),
        cursor_generation: row.cursor_generation,
        uid_validity: row.uid_validity.clone(),
        last_uid: row.last_uid,
        imported_messages: row.imported_messages,
        held_messages: row.held_messages,
        envelope_bytes: row.envelope_bytes,
        receipt_digest: row.digest.clone(),
    }
}

/// Local immutable association only. It must not inspect today's cursor,
/// owner login, policies, configuration or grants' current activation status.
fn checked_receipt_local(
    ctx: &ReducerContext,
    receipt: &ProtectedMailIngestionReceipt,
) -> Result<CursorDescriptor, String> {
    // Use the retained row directly: service eligibility is checked by the public
    // replay path, not by historical cursor validation on a later owner's behalf.
    let grant = ctx
        .db
        .protected_mail_read_grant()
        .id()
        .find(receipt.read_id.clone())
        .ok_or(INCONSISTENT)?;
    let selection =
        connector::retained_selection(ctx, &grant.selection_id).map_err(|_| INCONSISTENT)?;
    let (grant, _) =
        read::retained_ingestion_grant(ctx, grant, &selection).map_err(|_| INCONSISTENT)?;
    let (auth, _) = retained_authorization(ctx, &receipt.read_id, &grant, &selection)
        .map_err(|_| INCONSISTENT)?;
    read::checked_ingestion_terminal(ctx, &grant, &selection, &receipt.event_nonce)
        .map_err(|_| INCONSISTENT)?;
    let cid = connector::cursor_id(
        ctx.identity(),
        selection.request.connection_id,
        &selection.folder,
    );
    let generation = selection
        .expected_cursor_generation
        .checked_add(1)
        .ok_or(INCONSISTENT)?;
    if connector::cursor_generation_exists(ctx, &cid, generation)
        || super::sparse_checkpoint::cursor_generation_present(ctx, &cid, generation) {
        return Err(INCONSISTENT.into());
    }
    let history = ctx
        .db
        .protected_mail_ingestion_cursor_history()
        .id()
        .find(history_id(&cid, generation))
        .ok_or(INCONSISTENT)?;
    let rows = ctx
        .db
        .protected_mail_ingestion_disposition()
        .read_id()
        .filter(&receipt.read_id)
        .take(9)
        .collect::<Vec<_>>();
    if rows.len() != selection.uids.len() || receipt.disposition_ids.len() != rows.len() {
        return Err(INCONSISTENT.into());
    }
    let mut entries = Vec::new();
    let mut imported = 0u32;
    let mut held = 0u32;
    for (uid, id) in selection.uids.iter().zip(&receipt.disposition_ids) {
        let expected = protected::mailbox_tuple_event_id(
            selection.request.connection_id,
            &selection.folder,
            connector::validity(&selection.request.window),
            *uid,
        );
        let row = ctx
            .db
            .protected_mail_ingestion_disposition()
            .id()
            .find(id.clone())
            .ok_or(INCONSISTENT)?;
        if id != &expected
            || row.read_id != receipt.read_id
            || row.owner != selection.owner
            || row.collection_id != selection.request.connection_id
            || row.folder != selection.folder
            || row.uid_validity != connector::validity(&selection.request.window)
            || row.uid != *uid
            || row.direction != selection.request.direction
            || row.created_at != receipt.created_at
        {
            return Err(INCONSISTENT.into());
        }
        match row.kind {
            ProtectedMailIngestionDispositionKind::Imported(reference) => {
                let (actual, message) = protected::retained_ingested_mail(
                    ctx,
                    row.collection_id,
                    row.owner,
                    &mail_event_key(&receipt.read_id, *uid),
                )
                .map_err(|_| INCONSISTENT)?;
                if actual != reference {
                    return Err(INCONSISTENT.into());
                }
                entries.push(ProtectedMailIngestionEntry::Imported(message));
                imported += 1;
            }
            ProtectedMailIngestionDispositionKind::Held(reason) => {
                if ctx
                    .db
                    .protected_mail_receipt()
                    .mailbox_event_id()
                    .find(expected)
                    .is_some()
                {
                    return Err(INCONSISTENT.into());
                }
                entries.push(ProtectedMailIngestionEntry::Held(ProtectedMailHeldInput {
                    uid: *uid,
                    reason,
                }));
                held += 1;
            }
        }
    }
    let content = payload(&grant, &selection, &entries).map_err(|_| INCONSISTENT)?;
    if !hex64(&receipt.event_nonce)
        || receipt.selection_id != selection.id
        || receipt.payload_digest != sha(&content)
        || receipt.payload_digest != auth.payload_digest
        || receipt.envelope_bytes != content.len() as u64
        || receipt.envelope_bytes != auth.payload_bytes
        || receipt.request_digest
            != accept_digest(
                &receipt.read_id,
                &receipt.event_nonce,
                &receipt.payload_digest,
                receipt.envelope_bytes,
            )
        || receipt.cursor_id != cid
        || receipt.cursor_generation != generation
        || receipt.history_id != history.id
        || receipt.cursor_digest != history.digest
        || receipt.uid_validity != connector::validity(&selection.request.window)
        || receipt.last_uid != selection.through_uid
        || receipt.imported_messages != imported
        || receipt.held_messages != held
        || receipt.digest != receipt_digest(receipt)
        || receipt.actor != selection.request.connector_identity
        || receipt.created_at < auth.created_at
        || history.cursor_id != cid
        || history.owner != selection.owner
        || history.collection_id != selection.request.connection_id
        || history.folder != selection.folder
        || history.uid_validity != receipt.uid_validity
        || history.generation != generation
        || history.last_uid != receipt.last_uid
        || history.previous_digest != selection.previous_cursor_digest
        || history.read_id != receipt.read_id
        || history.selection_id != receipt.selection_id
        || history.request_digest != receipt.request_digest
        || history.imported_messages != imported
        || history.held_messages != held
        || history.envelope_bytes != receipt.envelope_bytes
        || history.actor != receipt.actor
        || history.created_at != receipt.created_at
        || history.digest != history_digest(&history)
    {
        return Err(INCONSISTENT.into());
    }
    Ok(CursorDescriptor {
        history_id: history.id,
        cursor_id: cid,
        owner: selection.owner,
        collection_id: selection.request.connection_id,
        folder: selection.folder,
        uid_validity: receipt.uid_validity.clone(),
        generation,
        from_uid: selection.from_uid,
        last_uid: receipt.last_uid,
        digest: receipt.cursor_digest.clone(),
        previous_digest: selection.previous_cursor_digest,
        created_at: receipt.created_at,
    })
}
pub(super) fn cursor_generation_present(
    ctx: &ReducerContext,
    cursor: &str,
    generation: u64,
) -> bool {
    ctx.db
        .protected_mail_ingestion_cursor_history()
        .id()
        .find(history_id(cursor, generation))
        .is_some()
}
pub(super) fn retained_cursor_descriptor(
    ctx: &ReducerContext,
    cursor: &str,
    generation: u64,
) -> Result<Option<CursorDescriptor>, String> {
    let Some(history) = ctx
        .db
        .protected_mail_ingestion_cursor_history()
        .id()
        .find(history_id(cursor, generation))
    else {
        return Ok(None);
    };
    let receipt = ctx
        .db
        .protected_mail_ingestion_receipt()
        .read_id()
        .find(history.read_id.clone())
        .ok_or(INCONSISTENT)?;
    let descriptor = checked_receipt_local(ctx, &receipt)?;
    if descriptor.cursor_id != cursor
        || descriptor.generation != generation
        || descriptor.history_id != history.id
    {
        return Err(INCONSISTENT.into());
    }
    Ok(Some(descriptor))
}
fn accept(
    ctx: &ReducerContext,
    id: &str,
    nonce: &str,
    entries: &[ProtectedMailIngestionEntry],
) -> Result<ProtectedMailIngestionReceiptDto, String> {
    let (grant, selection, _, _) = read::ingestion_read(ctx, id, false).map_err(read_error)?;
    if let Some(receipt) = ctx
        .db
        .protected_mail_ingestion_receipt()
        .read_id()
        .find(id.to_owned())
    {
        let content = payload(&grant, &selection, entries).map_err(|_| CONFLICT)?;
        if receipt.event_nonce != nonce
            || receipt.payload_digest != sha(&content)
            || receipt.envelope_bytes != content.len() as u64
        {
            return Err(CONFLICT.into());
        }
        let descriptor = checked_receipt_local(ctx, &receipt)?;
        connector::validate_cursor_predecessor(ctx, &descriptor).map_err(|_| INCONSISTENT)?;
        return Ok(dto(&receipt));
    }
    if !hex64(nonce) {
        return Err(INVALID.into());
    }
    let (auth, revoked) = retained_authorization(ctx, id, &grant, &selection)?;
    if revoked {
        return Err(STALE.into());
    }
    read::current_ingestion_read(ctx, &grant, &selection, false).map_err(read_error)?;
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if now < auth.request.not_before_ms || now >= auth.request.expires_at_ms {
        return Err(STALE.into());
    }
    let content = payload(&grant, &selection, entries)?;
    if content.len() as u64 > auth.request.max_envelope_bytes {
        return Err(LIMIT.into());
    }
    if auth.payload_digest != sha(&content) || auth.payload_bytes != content.len() as u64 {
        return Err(CONFLICT.into());
    }
    let cursor = connector::require_current_selection(ctx, &selection, true)
        .map_err(connector_error)?
        .ok_or(INCONSISTENT)?;
    let collection = ctx
        .db
        .protected_mail_collection()
        .id()
        .find(selection.request.connection_id)
        .filter(|r| r.owner == selection.owner)
        .ok_or(INCONSISTENT)?;
    let mut ids = Vec::new();
    let mut imported = 0;
    let mut held = 0;
    for entry in entries {
        let tuple = protected::mailbox_tuple_event_id(
            collection.id,
            &selection.folder,
            connector::validity(&selection.request.window),
            uid(entry),
        );
        if ctx
            .db
            .protected_mail_ingestion_disposition()
            .id()
            .find(tuple.clone())
            .is_some()
            || ctx
                .db
                .protected_mail_receipt()
                .mailbox_event_id()
                .find(tuple.clone())
                .is_some()
        {
            return Err(CONFLICT.into());
        }
        if let ProtectedMailIngestionEntry::Imported(message) = entry {
            protected::require_new_mail(
                ctx,
                collection.id,
                &mail_event_key(id, message.uid),
                message,
            )
            .map_err(|_| CONFLICT)?;
            imported += 1;
        } else {
            held += 1;
        }
        ids.push(tuple);
    }
    if ctx
        .db
        .protected_mail_ingestion_disposition()
        .read_id()
        .filter(&id.to_owned())
        .next()
        .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    let generation = cursor.generation.checked_add(1).ok_or(LIMIT)?;
    let hid = history_id(&cursor.id, generation);
    if ctx
        .db
        .protected_mail_ingestion_cursor_history()
        .id()
        .find(hid.clone())
        .is_some()
        || connector::cursor_generation_exists(ctx, &cursor.id, generation)
        || super::sparse_checkpoint::cursor_generation_present(ctx, &cursor.id, generation)
    {
        return Err(INCONSISTENT.into());
    }
    let request_digest = accept_digest(id, nonce, &auth.payload_digest, auth.payload_bytes);
    let mut history = ProtectedMailIngestionCursorHistory {
        id: hid.clone(),
        cursor_id: cursor.id.clone(),
        owner: selection.owner,
        collection_id: collection.id,
        folder: selection.folder.clone(),
        uid_validity: connector::validity(&selection.request.window).into(),
        generation,
        last_uid: selection.through_uid,
        previous_digest: cursor.digest.clone(),
        read_id: id.into(),
        selection_id: selection.id.clone(),
        request_digest: request_digest.clone(),
        imported_messages: imported,
        held_messages: held,
        envelope_bytes: auth.payload_bytes,
        digest: String::new(),
        actor: ctx.sender(),
        created_at: ctx.timestamp,
    };
    history.digest = history_digest(&history);
    let mut receipt = ProtectedMailIngestionReceipt {
        read_id: id.into(),
        selection_id: selection.id.clone(),
        event_nonce: nonce.into(),
        request_digest,
        payload_digest: auth.payload_digest.clone(),
        envelope_bytes: auth.payload_bytes,
        disposition_ids: ids.clone(),
        cursor_id: cursor.id.clone(),
        cursor_generation: generation,
        history_id: hid.clone(),
        cursor_digest: history.digest.clone(),
        uid_validity: history.uid_validity.clone(),
        last_uid: selection.through_uid,
        imported_messages: imported,
        held_messages: held,
        digest: String::new(),
        actor: ctx.sender(),
        created_at: ctx.timestamp,
    };
    receipt.digest = receipt_digest(&receipt);
    for (entry, tuple) in entries.iter().zip(ids) {
        let kind = match entry {
            ProtectedMailIngestionEntry::Imported(message) => {
                ProtectedMailIngestionDispositionKind::Imported(
                    protected::insert_ingested_mail(
                        ctx,
                        &collection,
                        &mail_event_key(id, message.uid),
                        message,
                    )
                    .map_err(|_| INCONSISTENT)?,
                )
            }
            ProtectedMailIngestionEntry::Held(h) => {
                ProtectedMailIngestionDispositionKind::Held(h.reason.clone())
            }
        };
        ctx.db
            .protected_mail_ingestion_disposition()
            .insert(ProtectedMailIngestionDisposition {
                id: tuple,
                read_id: id.into(),
                owner: selection.owner,
                collection_id: collection.id,
                folder: selection.folder.clone(),
                uid_validity: history.uid_validity.clone(),
                uid: uid(entry),
                direction: selection.request.direction.clone(),
                kind,
                created_at: ctx.timestamp,
            });
    }
    // The legacy terminal reporter and this continuation race on the same c2 TX.
    read::finish_protected_mail_read_dispatch(
        ctx,
        id.into(),
        read::ProtectedMailReadOutcome::ReadReported,
        nonce.into(),
    )
    .map_err(read_error)?;
    ctx.db
        .protected_mail_ingestion_cursor_history()
        .insert(history);
    ctx.db
        .protected_mail_connector_cursor()
        .id()
        .update(ProtectedMailConnectorCursor {
            generation,
            last_uid: selection.through_uid,
            digest: receipt.cursor_digest.clone(),
            history_id: hid,
            updated_at: ctx.timestamp,
            ..cursor
        });
    let result = dto(&receipt);
    ctx.db.protected_mail_ingestion_receipt().insert(receipt);
    Ok(result)
}
fn fixed_error(error: String) -> String {
    match error.as_str() {
        INVALID | INCONSISTENT | OWNER | SERVICE | CONFLICT | STALE | LIMIT => error,
        _ => INCONSISTENT.into(),
    }
}
#[procedure]
pub fn accept_protected_mail_ingestion(
    ctx: &mut ProcedureContext,
    read_id: String,
    event_nonce: String,
    entries: Vec<ProtectedMailIngestionEntry>,
) -> Result<ProtectedMailIngestionReceiptDto, String> {
    ctx.try_with_tx(|tx| accept(tx.as_ref(), &read_id, &event_nonce, &entries).map_err(fixed_error))
}

#[cfg(test)]
mod tests {
    use super::super::connector::{
        ProtectedMailConnectorSelectionRequest, ProtectedMailConnectorStoredBatch,
        ProtectedMailConnectorWindow,
    };
    use super::super::read::ProtectedMailReadGrantRequest;
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
            max_message_bytes: 524_288,
            max_total_bytes: 1_048_576,
            event_nonce: "2".repeat(64),
        };
        let canonical = super::super::admission::canonical(&json!({"formatVersion":1,"kind":"mail.connector.read","limits":{"maxMessageBytes":request.max_message_bytes,"maxTotalBytes":request.max_total_bytes},"profile":"imap.uid-body-peek.v1","readId":hash("pear-mail-read-grant-v1",&[selection.id.clone()]),"reservation":{"bodyBytes":request.max_total_bytes,"messageSlots":selection.uids.len(),"operations":1},"selection":selection_value,"selectionDigest":selection.manifest_digest})).unwrap();
        let plan_digest = hex::encode(Sha256::digest(canonical.as_bytes()));
        let grant = ProtectedMailReadGrant {
            id: hash("pear-mail-read-grant-v1", &[selection.id.clone()]),
            owner: selection.owner,
            selection_id: selection.id.clone(),
            selection_digest: selection.manifest_digest.clone(),
            issue_digest: "4".repeat(64),
            request,
            plan_digest,
            plan_bytes: canonical.len() as u64,
            canonical,
            created_at: selection.created_at,
        };
        (grant, selection)
    }

    fn imported(
        selection: &ProtectedMailConnectorSelection,
        uid: u32,
        body: &str,
    ) -> ProtectedMailIngestionEntry {
        ProtectedMailIngestionEntry::Imported(ProtectedMailInput {
            folder: selection.folder.clone(),
            uid_validity: connector::validity(&selection.request.window).into(),
            uid,
            direction: selection.request.direction.clone(),
            message_date: "2026-10-21".into(),
            from: "sender@example.test".into(),
            to: "owner@example.test".into(),
            cc: String::new(),
            subject: "prepared".into(),
            body: body.into(),
            note: String::new(),
            sanitization_version: "fixture-v1".into(),
        })
    }
    fn mixed(selection: &ProtectedMailConnectorSelection) -> Vec<ProtectedMailIngestionEntry> {
        vec![
            imported(selection, 2, "literal\t\"body\"\\\r\n🍐"),
            ProtectedMailIngestionEntry::Held(ProtectedMailHeldInput {
                uid: 3,
                reason: ProtectedMailHeldReason::AuthenticationMaterial,
            }),
        ]
    }
    fn request(id: &str) -> ProtectedMailIngestionRequest {
        ProtectedMailIngestionRequest {
            read_id: id.into(),
            not_before_ms: 1_700_000_000_000,
            expires_at_ms: 1_700_003_600_000,
            max_envelope_bytes: MAX_BYTES,
            event_nonce: "8".repeat(64),
        }
    }
    #[test]
    fn complete_payload_is_closed_and_measures_every_escaped_utf8_byte() {
        let (grant, selection) = fixture();
        let entries = mixed(&selection);
        let text = payload(&grant, &selection, &entries).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert_eq!(value["read"]["readId"], grant.id);
        assert_eq!(
            value["entries"][0]["message"]["body"],
            "literal\t\"body\"\\\r\n🍐"
        );
        assert_eq!(
            value["entries"][1],
            json!({"uid":3,"kind":"held","reason":"authentication_material"})
        );
        assert!(text.len() > grant.canonical.len() + 200);
        assert!(text.contains("\\t"));
        assert!(text.contains("🍐"));
    }
    #[test]
    fn owner_manifest_is_metadata_only_and_binds_payload_and_read() {
        let (grant, selection) = fixture();
        let text = payload(&grant, &selection, &mixed(&selection)).unwrap();
        let request = request(&grant.id);
        let metadata = manifest(&request, &grant, &sha(&text), text.len() as u64, 2).unwrap();
        let value: Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 6);
        assert_eq!(value["payload"]["bytes"], text.len() as u64);
        assert_eq!(value["readPlanDigest"], grant.plan_digest);
        assert!(!metadata.contains("literal"));
        assert!(!metadata.contains("authentication_material"));
        assert_ne!(
            metadata,
            manifest(&request, &grant, &"f".repeat(64), text.len() as u64, 2).unwrap()
        );
        assert_ne!(
            metadata,
            manifest(&request, &grant, &sha(&text), text.len() as u64 + 1, 2).unwrap()
        );
    }
    #[test]
    fn exact_selected_slots_cannot_reorder_duplicate_omit_or_widen() {
        let (grant, selection) = fixture();
        let entries = mixed(&selection);
        for bad in [
            vec![],
            vec![entries[0].clone()],
            vec![entries[1].clone(), entries[0].clone()],
            vec![entries[0].clone(), entries[0].clone()],
        ] {
            assert_eq!(payload(&grant, &selection, &bad).unwrap_err(), INVALID);
        }
        let mut bad = entries.clone();
        bad[1] = ProtectedMailIngestionEntry::Held(ProtectedMailHeldInput {
            uid: 4,
            reason: ProtectedMailHeldReason::SensitiveContent,
        });
        assert_eq!(payload(&grant, &selection, &bad).unwrap_err(), INVALID);
        assert_eq!(
            payload(&grant, &selection, &vec![entries[0].clone(); 9]).unwrap_err(),
            LIMIT
        );
    }
    #[test]
    fn imported_tuple_and_configured_direction_are_exact() {
        let (grant, selection) = fixture();
        let base = mixed(&selection);
        for field in 0..4 {
            let mut bad = base.clone();
            if let ProtectedMailIngestionEntry::Imported(m) = &mut bad[0] {
                match field {
                    0 => m.folder.push(' '),
                    1 => m.uid_validity = "7".into(),
                    2 => m.uid = 99,
                    _ => m.direction = ProtectedMailDirection::Sent,
                }
            }
            assert_eq!(payload(&grant, &selection, &bad).unwrap_err(), INVALID);
        }
    }
    #[test]
    fn unchanged_s1_byte_and_control_limits_apply_before_storage() {
        let (grant, selection) = fixture();
        for bad in ["\0".into(), "\u{85}".into(), "🍐".repeat(40_001)] {
            let mut entries = mixed(&selection);
            entries[0] = imported(&selection, 2, &bad);
            assert_eq!(payload(&grant, &selection, &entries).unwrap_err(), INVALID);
        }
        let mut entries = mixed(&selection);
        entries[0] = imported(&selection, 2, &"🍐".repeat(40_000));
        assert!(payload(&grant, &selection, &entries).is_ok());
    }
    #[test]
    fn whole_envelope_limit_includes_json_escaping_not_only_literals() {
        let (grant, mut selection) = fixture();
        selection.uids = (2..=9).collect();
        let entries = selection
            .uids
            .iter()
            .map(|uid| imported(&selection, *uid, &"\t".repeat(160_000)))
            .collect::<Vec<_>>();
        assert_eq!(payload(&grant, &selection, &entries).unwrap_err(), LIMIT);
    }
    #[test]
    fn held_has_no_body_or_free_text_and_all_reasons_are_distinct() {
        for (reason, label) in [
            (
                ProtectedMailHeldReason::AuthenticationMaterial,
                "authentication_material",
            ),
            (
                ProtectedMailHeldReason::SensitiveContent,
                "sensitive_content",
            ),
            (
                ProtectedMailHeldReason::UnsupportedContent,
                "unsupported_content",
            ),
        ] {
            let value = entry_json(&ProtectedMailIngestionEntry::Held(ProtectedMailHeldInput {
                uid: 3,
                reason,
            }));
            assert_eq!(value, json!({"uid":3,"kind":"held","reason":label}));
        }
    }
    #[test]
    fn request_intervals_and_limits_cannot_renew_or_expand_selection() {
        let (grant, selection) = fixture();
        let mut r = request(&grant.id);
        assert!(valid_request(&r).is_ok());
        assert!(window_valid(&r, &selection, r.not_before_ms));
        r.not_before_ms -= 1;
        assert!(!window_valid(&r, &selection, r.not_before_ms));
        r = request(&grant.id);
        r.expires_at_ms += 1;
        assert!(!window_valid(&r, &selection, 1_700_000_000_000));
        r = request(&grant.id);
        assert!(!window_valid(&r, &selection, r.expires_at_ms));
        r.max_envelope_bytes = MAX_BYTES + 1;
        assert_eq!(valid_request(&r).unwrap_err(), LIMIT);
        r = request(&grant.id);
        r.expires_at_ms = SAFE + 1;
        assert_eq!(valid_request(&r).unwrap_err(), INVALID);
    }
    #[test]
    fn issue_and_accept_digests_bind_every_owner_and_operation_argument() {
        let (grant, _) = fixture();
        let r = request(&grant.id);
        let epoch = 3;
        let snapshot = "a".repeat(64);
        let manifest = "b".repeat(64);
        let base = issue_digest(&r, epoch, &snapshot, &manifest);
        for field in 0..5 {
            let mut changed = r.clone();
            match field {
                0 => changed.read_id = "1".repeat(64),
                1 => changed.not_before_ms += 1,
                2 => changed.expires_at_ms -= 1,
                3 => changed.max_envelope_bytes -= 1,
                _ => changed.event_nonce = "2".repeat(64),
            }
            assert_ne!(base, issue_digest(&changed, epoch, &snapshot, &manifest));
        }
        assert_ne!(base, issue_digest(&r, epoch + 1, &snapshot, &manifest));
        assert_ne!(base, issue_digest(&r, epoch, &"c".repeat(64), &manifest));
        assert_ne!(base, issue_digest(&r, epoch, &snapshot, &"d".repeat(64)));
        let base = accept_digest(&grant.id, &"e".repeat(64), &"f".repeat(64), 42);
        assert_ne!(
            base,
            accept_digest(&grant.id, &"e".repeat(64), &"f".repeat(64), 43)
        );
        assert_ne!(
            base,
            accept_digest(&grant.id, &"f".repeat(64), &"f".repeat(64), 42)
        );
    }
    #[test]
    fn global_tuple_and_history_domains_do_not_follow_request_nonces() {
        let owner = Identity::from_byte_array([7; 32]);
        assert_ne!(
            owner_event_id(owner, &"1".repeat(64)),
            owner_event_id(Identity::from_byte_array([8; 32]), &"1".repeat(64))
        );
        let tuple = protected::mailbox_tuple_event_id(1, "INBOX", "7", 2);
        assert_ne!(tuple, protected::mailbox_tuple_event_id(1, "INBOX", "7", 3));
        assert_ne!(
            mail_event_key(&"a".repeat(64), 2),
            mail_event_key(&"b".repeat(64), 2)
        );
        assert!(hex64(&mail_event_key(&"a".repeat(64), 2)));
        assert_ne!(history_id("cursor", 1), history_id("cursor", 2));
        assert!(history_id("cursor", 1).starts_with("mail-ingestion-cursor-history:"));
    }
    #[test]
    fn fixed_error_mapping_never_exposes_arbitrary_subsystem_text() {
        for code in [
            INVALID,
            INCONSISTENT,
            OWNER,
            SERVICE,
            CONFLICT,
            STALE,
            LIMIT,
        ] {
            assert_eq!(fixed_error(code.into()), code);
        }
        assert_eq!(fixed_error("private body/error".into()), INCONSISTENT);
    }
    #[test]
    fn independent_python_and_typescript_full_payload_golden() {
        let (mut grant, mut selection) = fixture();
        let read:Value=serde_json::from_str(r###"{"formatVersion":1,"kind":"mail.connector.read","limits":{"maxMessageBytes":524288,"maxTotalBytes":524288},"profile":"imap.uid-body-peek.v1","readId":"bd59b410c67e7ef343f8d6b4689fc9bb74ccbc402b97fbbc8550710ef3ddae2c","reservation":{"bodyBytes":524288,"messageSlots":2,"operations":1},"selection":{"formatVersion":1,"kind":"mail.connector.selection","selectionId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workspaceId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","ownerId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","connection":{"id":"9007199254740993","epoch":"18446744073709551615","snapshotDigest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},"connector":{"identity":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","runtimeId":"fixture-runtime","runId":"fixture-run"},"mailbox":{"host":"imap.example.test","port":993,"username":"fixture@example.test","folder":"受信🍐é","direction":"received"},"selection":{"mode":"stored_batch","uidValidity":"7","expectedCursorGeneration":"18446744073709551615","previousCursorDigest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","fromUid":2,"throughUid":3,"uids":[2,3],"maxAcknowledgedBytes":1},"notBeforeMs":1700000000000,"expiresAtMs":1700003600000},"selectionDigest":"d59513d73e4641baff7766fb3cd401973cd124eddabde6e73c54af802643ad9d"}"###).unwrap();
        let m:Value=serde_json::from_str(r###"{"folder":"受信🍐é","uidValidity":"7","uid":2,"direction":"received","messageDate":"2026-10-21","from":"fixture@example.test","to":"owner@example.test","cc":"","subject":"literal \"subject\"","body":"日本語🍐é \nquoted \"text\"\\","note":"","sanitizationVersion":"prepared-text-v1"}"###).unwrap();
        grant.canonical = canonical(&read).unwrap();
        grant.plan_digest = sha(&grant.canonical);
        selection.folder = m["folder"].as_str().unwrap().into();
        selection.request.window =
            ProtectedMailConnectorWindow::StoredBatch(ProtectedMailConnectorStoredBatch {
                uid_validity: "7".into(),
                expected_cursor_generation: u64::MAX,
                message_count: 2,
                max_acknowledged_bytes: 1,
            });
        let field = |key: &str| m[key].as_str().unwrap().to_owned();
        let imported = ProtectedMailInput {
            folder: field("folder"),
            uid_validity: field("uidValidity"),
            uid: 2,
            direction: ProtectedMailDirection::Received,
            message_date: field("messageDate"),
            from: field("from"),
            to: field("to"),
            cc: field("cc"),
            subject: field("subject"),
            body: field("body"),
            note: field("note"),
            sanitization_version: field("sanitizationVersion"),
        };
        let entries = vec![
            ProtectedMailIngestionEntry::Imported(imported),
            ProtectedMailIngestionEntry::Held(ProtectedMailHeldInput {
                uid: 3,
                reason: ProtectedMailHeldReason::AuthenticationMaterial,
            }),
        ];
        let text = payload(&grant, &selection, &entries).unwrap();
        assert_eq!(text.len(), 1883);
        assert_eq!(
            sha(&text),
            "4369fe3ef974e1cb8e77f275f673e82a84ba4e2b165b3251981c465d31f8b935"
        );
    }
}
