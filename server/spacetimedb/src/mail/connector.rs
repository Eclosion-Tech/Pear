//! Owner-reviewed progress over already stored mail. This supplies no mailbox
//! read, credential, import, processing, or recurring-workflow authority.

use serde_json::json;
use sha2::{Digest, Sha256};
use spacetimedb::{
    procedure, reducer, table, Identity, ProcedureContext, ReducerContext, SpacetimeType, Table,
    Timestamp,
};

use super::accounts::{mail_connection, MailConnection};
use super::admission::{canonical, hash, hex64, human, now_ms, opaque, service};
use super::authority::checked_current_authority;
use super::governance::ProtectedMailSourceRef;
use super::protected::{checked_stored_mail_tuple, ProtectedMailDirection};

const INVALID: &str = "protected_mail_connector_invalid_request";
const INCONSISTENT: &str = "protected_mail_connector_inconsistent";
const OWNER: &str = "protected_mail_connector_owner_required";
const SERVICE: &str = "protected_mail_connector_service_required";
const CONFLICT: &str = "protected_mail_connector_event_conflict";
const STALE: &str = "protected_mail_connector_stale";
const REQUIRED: &str = "protected_mail_connector_source_required";
const LIMIT: &str = "protected_mail_connector_limit_exceeded";
const SAFE: u64 = 9_007_199_254_740_991;
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MANIFEST: usize = 8192;
const MAX_TTL: u64 = 3_600_000;

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailConnectorNewOnly {
    pub uid_validity: String,
    pub uid_next: u32,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailConnectorStoredBatch {
    pub uid_validity: String,
    pub expected_cursor_generation: u64,
    pub message_count: u32,
    pub max_acknowledged_bytes: u64,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailConnectorWindow {
    NewOnly(ProtectedMailConnectorNewOnly),
    StoredBatch(ProtectedMailConnectorStoredBatch),
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailConnectorSelectionRequest {
    pub connection_id: u64,
    pub connector_identity: Identity,
    pub runtime_id: String,
    pub run_id: String,
    pub direction: ProtectedMailDirection,
    pub window: ProtectedMailConnectorWindow,
    pub not_before_ms: u64,
    pub expires_at_ms: u64,
    pub event_nonce: String,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailConnectorSelectionEventKind {
    Issued,
    Revoked,
}

#[table(accessor = protected_mail_connector_selection, private)]
pub struct ProtectedMailConnectorSelection {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub owner: Identity,
    pub workspace: Identity,
    pub request: ProtectedMailConnectorSelectionRequest,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub folder: String,
    pub expected_cursor_generation: u64,
    pub previous_cursor_digest: String,
    pub from_uid: u32,
    pub through_uid: u32,
    pub uids: Vec<u32>,
    pub max_acknowledged_bytes: u64,
    pub manifest_digest: String,
    pub manifest_bytes: u64,
    pub canonical: String,
    pub issue_digest: String,
    pub created_at: Timestamp,
}
#[table(accessor = protected_mail_connector_selection_event, private)]
pub struct ProtectedMailConnectorSelectionEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub selection_id: String,
    pub generation: u64,
    pub kind: ProtectedMailConnectorSelectionEventKind,
    pub event_nonce: String,
    pub request_digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[table(accessor = protected_mail_connector_cursor, private)]
pub struct ProtectedMailConnectorCursor {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub owner: Identity,
    pub collection_id: u64,
    pub folder: String,
    pub uid_validity: String,
    pub generation: u64,
    pub last_uid: u32,
    pub digest: String,
    pub history_id: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}
#[table(accessor = protected_mail_connector_cursor_history, private)]
pub struct ProtectedMailConnectorCursorHistory {
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
    pub selection_id: String,
    pub request_digest: String,
    pub acknowledged_messages: u32,
    pub acknowledged_bytes: u64,
    pub digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[table(accessor = protected_mail_connector_ack_receipt, private)]
pub struct ProtectedMailConnectorAckReceipt {
    #[primary_key]
    pub selection_id: String,
    pub event_nonce: String,
    pub request_digest: String,
    pub sources: Vec<ProtectedMailSourceRef>,
    pub cursor_id: String,
    pub cursor_generation: u64,
    pub history_id: String,
    pub cursor_digest: String,
    pub uid_validity: String,
    pub last_uid: u32,
    pub acknowledged_messages: u32,
    pub acknowledged_bytes: u64,
    pub digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailConnectorPreview {
    pub selection_id: String,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub manifest_digest: String,
    pub manifest_bytes: u64,
    pub canonical: String,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailConnectorAck {
    pub selection_id: String,
    pub cursor_id: String,
    pub cursor_generation: u64,
    pub uid_validity: String,
    pub last_uid: u32,
    pub acknowledged_messages: u32,
    pub acknowledged_bytes: u64,
    pub receipt_digest: String,
}

fn direction(value: &ProtectedMailDirection) -> &'static str {
    match value {
        ProtectedMailDirection::Received => "received",
        ProtectedMailDirection::Sent => "sent",
    }
}
pub(super) fn validity(window: &ProtectedMailConnectorWindow) -> &str {
    match window {
        ProtectedMailConnectorWindow::NewOnly(ProtectedMailConnectorNewOnly {
            uid_validity,
            ..
        })
        | ProtectedMailConnectorWindow::StoredBatch(ProtectedMailConnectorStoredBatch {
            uid_validity,
            ..
        }) => uid_validity,
    }
}
fn canonical_u32(value: &str) -> bool {
    value
        .parse::<u32>()
        .is_ok_and(|v| v > 0 && v.to_string() == value)
}
fn next_uids(last: u32, count: u32) -> Result<(u32, u32, Vec<u32>), String> {
    if count == 0 {
        return Err(INVALID.into());
    }
    if count > 8 {
        return Err(LIMIT.into());
    }
    let from = last.checked_add(1).ok_or(LIMIT)?;
    let through = last.checked_add(count).ok_or(LIMIT)?;
    Ok((from, through, (from..=through).collect()))
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn valid_request(request: &ProtectedMailConnectorSelectionRequest) -> Result<(), String> {
    if request.connection_id == 0
        || !opaque(&request.runtime_id)
        || !opaque(&request.run_id)
        || !hex64(&request.event_nonce)
        || !canonical_u32(validity(&request.window))
        || request.not_before_ms > SAFE
        || request.expires_at_ms > SAFE
        || request.expires_at_ms == 0
        || request.not_before_ms > request.expires_at_ms
    {
        return Err(INVALID.into());
    }
    match &request.window {
        ProtectedMailConnectorWindow::NewOnly(ProtectedMailConnectorNewOnly {
            uid_next, ..
        }) if *uid_next == 0 => Err(INVALID.into()),
        ProtectedMailConnectorWindow::StoredBatch(ProtectedMailConnectorStoredBatch {
            expected_cursor_generation,
            message_count,
            max_acknowledged_bytes,
            ..
        }) => {
            if *expected_cursor_generation == 0
                || *message_count == 0
                || *max_acknowledged_bytes == 0
            {
                return Err(INVALID.into());
            }
            if *message_count > 8 || *max_acknowledged_bytes > MAX_BYTES {
                return Err(LIMIT.into());
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
fn selection_id(owner: Identity, connection: u64, nonce: &str) -> String {
    hash(
        "pear-mail-connector-selection-id-v1",
        &[
            owner.to_hex().to_string(),
            connection.to_string(),
            nonce.into(),
        ],
    )
}
pub(super) fn cursor_id(workspace: Identity, collection: u64, folder: &str) -> String {
    format!(
        "mail-connector-cursor:{}",
        hash(
            "pear-mail-connector-cursor-id-v1",
            &[
                workspace.to_hex().to_string(),
                collection.to_string(),
                folder.into()
            ]
        )
    )
}
fn history_id(cursor: &str, generation: u64) -> String {
    format!(
        "mail-connector-cursor-history:{}",
        hash(
            "pear-mail-connector-cursor-history-id-v1",
            &[cursor.into(), generation.to_string()]
        )
    )
}
fn event_id(id: &str, generation: u64) -> String {
    hash(
        "pear-mail-connector-owner-event-v1",
        &[id.into(), generation.to_string()],
    )
}
fn window_request(window: &ProtectedMailConnectorWindow) -> Vec<String> {
    match window {
        ProtectedMailConnectorWindow::NewOnly(ProtectedMailConnectorNewOnly {
            uid_validity,
            uid_next,
        }) => vec![
            "new_only".into(),
            uid_validity.clone(),
            uid_next.to_string(),
        ],
        ProtectedMailConnectorWindow::StoredBatch(ProtectedMailConnectorStoredBatch {
            uid_validity,
            expected_cursor_generation,
            message_count,
            max_acknowledged_bytes,
        }) => vec![
            "stored_batch".into(),
            uid_validity.clone(),
            expected_cursor_generation.to_string(),
            message_count.to_string(),
            max_acknowledged_bytes.to_string(),
        ],
    }
}
fn issue_digest(
    request: &ProtectedMailConnectorSelectionRequest,
    epoch: u64,
    snapshot: &str,
    manifest: &str,
) -> String {
    let mut fields = vec![
        request.connection_id.to_string(),
        request.connector_identity.to_hex().to_string(),
        request.runtime_id.clone(),
        request.run_id.clone(),
        direction(&request.direction).into(),
    ];
    fields.extend(window_request(&request.window));
    fields.extend([
        request.not_before_ms.to_string(),
        request.expires_at_ms.to_string(),
        request.event_nonce.clone(),
        epoch.to_string(),
        snapshot.into(),
        manifest.into(),
    ]);
    hash("pear-mail-connector-issue-request-v1", &fields)
}
fn metadata(row: &ProtectedMailConnectorSelection) -> Result<String, String> {
    let mode = match row.request.window {
        ProtectedMailConnectorWindow::NewOnly(ProtectedMailConnectorNewOnly { .. }) => "new_only",
        _ => "stored_batch",
    };
    let result=canonical(&json!({"formatVersion":1,"kind":"mail.connector.selection","selectionId":row.id,"workspaceId":row.workspace.to_hex().to_string(),
        "ownerId":row.owner.to_hex().to_string(),"connection":{"id":row.request.connection_id.to_string(),"epoch":row.connection_epoch.to_string(),"snapshotDigest":row.snapshot_digest},
        "connector":{"identity":row.request.connector_identity.to_hex().to_string(),"runtimeId":row.request.runtime_id,"runId":row.request.run_id},
        "mailbox":{"host":row.host,"port":row.port,"username":row.username,"folder":row.folder,"direction":direction(&row.request.direction)},
        "selection":{"mode":mode,"uidValidity":validity(&row.request.window),"expectedCursorGeneration":row.expected_cursor_generation.to_string(),
        "previousCursorDigest":row.previous_cursor_digest,"fromUid":row.from_uid,"throughUid":row.through_uid,"uids":row.uids,"maxAcknowledgedBytes":row.max_acknowledged_bytes},
        "notBeforeMs":row.request.not_before_ms,"expiresAtMs":row.request.expires_at_ms})).map_err(|_| INCONSISTENT)?;
    if result.len() > MAX_MANIFEST {
        return Err(LIMIT.into());
    }
    Ok(result)
}
fn selection_shape(row: &ProtectedMailConnectorSelection) -> bool {
    if valid_request(&row.request).is_err()
        || !text(&row.host, 253)
        || row
            .host
            .chars()
            .any(|c| c.is_whitespace() || "/@?#".contains(c))
        || row.port == 0
        || !text(&row.username, 320)
        || !text(&row.folder, 512)
        || row.connection_epoch == 0
        || !hex64(&row.snapshot_digest)
        || row.id
            != selection_id(
                row.owner,
                row.request.connection_id,
                &row.request.event_nonce,
            )
    {
        return false;
    }
    match &row.request.window {
        ProtectedMailConnectorWindow::NewOnly(ProtectedMailConnectorNewOnly {
            uid_next, ..
        }) => {
            row.expected_cursor_generation == 0
                && row.previous_cursor_digest.is_empty()
                && row.from_uid == 0
                && row.through_uid == uid_next - 1
                && row.uids.is_empty()
                && row.max_acknowledged_bytes == 0
        }
        ProtectedMailConnectorWindow::StoredBatch(ProtectedMailConnectorStoredBatch {
            expected_cursor_generation,
            message_count,
            max_acknowledged_bytes,
            ..
        }) => {
            row.expected_cursor_generation == *expected_cursor_generation
                && hex64(&row.previous_cursor_digest)
                && row.from_uid > 0
                && row.from_uid.checked_add(message_count - 1) == Some(row.through_uid)
                && row.uids == (row.from_uid..=row.through_uid).collect::<Vec<_>>()
                && row.max_acknowledged_bytes == *max_acknowledged_bytes
        }
    }
}
fn checked_selection(
    ctx: &ReducerContext,
    row: ProtectedMailConnectorSelection,
) -> Result<ProtectedMailConnectorSelection, String> {
    if !selection_shape(&row) || row.workspace != ctx.identity() {
        return Err(INCONSISTENT.into());
    }
    let canonical = metadata(&row).map_err(|_| INCONSISTENT)?;
    let created_ms = u64::try_from(row.created_at.to_micros_since_unix_epoch() / 1000)
        .map_err(|_| INCONSISTENT)?;
    if row.canonical != canonical
        || row.manifest_bytes != canonical.len() as u64
        || row.manifest_digest != hex::encode(Sha256::digest(canonical.as_bytes()))
        || row.issue_digest
            != issue_digest(
                &row.request,
                row.connection_epoch,
                &row.snapshot_digest,
                &row.manifest_digest,
            )
        || row.request.expires_at_ms <= created_ms
        || row.request.expires_at_ms - created_ms > MAX_TTL
    {
        return Err(INCONSISTENT.into());
    }
    let issued = ctx
        .db
        .protected_mail_connector_selection_event()
        .id()
        .find(event_id(&row.id, 1))
        .ok_or(INCONSISTENT)?;
    if issued.selection_id != row.id
        || issued.generation != 1
        || issued.kind != ProtectedMailConnectorSelectionEventKind::Issued
        || issued.event_nonce != row.request.event_nonce
        || issued.request_digest != row.issue_digest
        || issued.actor != row.owner
        || issued.created_at != row.created_at
    {
        return Err(INCONSISTENT.into());
    }
    if let Some(revoked) = ctx
        .db
        .protected_mail_connector_selection_event()
        .id()
        .find(event_id(&row.id, 2))
    {
        if revoked.selection_id != row.id
            || revoked.generation != 2
            || revoked.kind != ProtectedMailConnectorSelectionEventKind::Revoked
            || !hex64(&revoked.event_nonce)
            || revoked.event_nonce == row.request.event_nonce
            || revoked.actor != row.owner
            || revoked.request_digest
                != hash(
                    "pear-mail-connector-revoke-v1",
                    &[row.id.clone(), revoked.event_nonce.clone()],
                )
        {
            return Err(INCONSISTENT.into());
        }
    }
    Ok(row)
}
pub(super) fn retained_selection(
    ctx: &ReducerContext,
    id: &str,
) -> Result<ProtectedMailConnectorSelection, String> {
    checked_selection(
        ctx,
        ctx.db
            .protected_mail_connector_selection()
            .id()
            .find(id.to_owned())
            .ok_or(INCONSISTENT)?,
    )
}
pub(super) fn cursor_generation_exists(ctx: &ReducerContext, id: &str, generation: u64) -> bool {
    ctx.db
        .protected_mail_connector_cursor_history()
        .id()
        .find(history_id(id, generation))
        .is_some()
}

fn owner_connection(ctx: &ReducerContext, id: u64) -> Result<MailConnection, String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    ctx.db
        .mail_connection()
        .id()
        .find(id)
        .filter(|c| c.owner == ctx.sender())
        .ok_or(OWNER.into())
}
pub(super) fn owned_selection(
    ctx: &ReducerContext,
    id: &str,
) -> Result<ProtectedMailConnectorSelection, String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let row = ctx
        .db
        .protected_mail_connector_selection()
        .id()
        .find(id.to_owned())
        .filter(|r| r.owner == ctx.sender())
        .ok_or(OWNER)?;
    checked_selection(ctx, row)
}
pub(super) fn bound_selection(
    ctx: &ReducerContext,
    id: &str,
) -> Result<ProtectedMailConnectorSelection, String> {
    if !hex64(id) || !service(ctx, ctx.sender(), Identity::from_byte_array([0; 32])) {
        return Err(SERVICE.into());
    }
    let row = ctx
        .db
        .protected_mail_connector_selection()
        .id()
        .find(id.to_owned())
        .filter(|r| {
            r.request.connector_identity == ctx.sender() && service(ctx, ctx.sender(), r.owner)
        })
        .ok_or(SERVICE)?;
    checked_selection(ctx, row)
}
fn history_digest(row: &ProtectedMailConnectorCursorHistory) -> String {
    hash(
        "pear-mail-connector-cursor-state-v1",
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
            row.selection_id.clone(),
            row.request_digest.clone(),
            row.acknowledged_messages.to_string(),
            row.acknowledged_bytes.to_string(),
            row.actor.to_hex().to_string(),
            row.created_at.to_micros_since_unix_epoch().to_string(),
        ],
    )
}
fn ack_request(id: &str, nonce: &str, sources: &[ProtectedMailSourceRef]) -> String {
    let mut fields = vec![id.into(), nonce.into()];
    for source in sources {
        fields.extend([
            source.id.clone(),
            source.revision.to_string(),
            source.digest.clone(),
        ]);
    }
    hash("pear-mail-connector-ack-request-v1", &fields)
}
fn receipt_digest(row: &ProtectedMailConnectorAckReceipt) -> String {
    hash(
        "pear-mail-connector-ack-receipt-v1",
        &[
            row.selection_id.clone(),
            row.event_nonce.clone(),
            row.request_digest.clone(),
            row.cursor_id.clone(),
            row.cursor_generation.to_string(),
            row.history_id.clone(),
            row.cursor_digest.clone(),
            row.uid_validity.clone(),
            row.last_uid.to_string(),
            row.acknowledged_messages.to_string(),
            row.acknowledged_bytes.to_string(),
            row.actor.to_hex().to_string(),
            row.created_at.to_micros_since_unix_epoch().to_string(),
        ],
    )
}
fn selected_sources(
    ctx: &ReducerContext,
    row: &ProtectedMailConnectorSelection,
    sources: &[ProtectedMailSourceRef],
) -> Result<u64, String> {
    if sources.len() > 8 {
        return Err(LIMIT.into());
    }
    if sources.len() != row.uids.len() {
        return Err(INVALID.into());
    }
    let mut bytes = 0u64;
    for (uid, supplied) in row.uids.iter().zip(sources) {
        let (id, revision, digest, size) = checked_stored_mail_tuple(
            ctx,
            row.request.connection_id,
            row.owner,
            &row.folder,
            validity(&row.request.window),
            *uid,
            &row.request.direction,
        )?;
        if supplied.id != id || supplied.revision != revision || supplied.digest != digest {
            return Err(INVALID.into());
        }
        bytes = bytes.checked_add(size).ok_or(LIMIT)?;
    }
    if bytes > row.max_acknowledged_bytes || bytes > MAX_BYTES {
        return Err(LIMIT.into());
    }
    Ok(bytes)
}
fn checked_receipt_local(
    ctx: &ReducerContext,
    selection: &ProtectedMailConnectorSelection,
    receipt: ProtectedMailConnectorAckReceipt,
) -> Result<ProtectedMailConnectorAckReceipt, String> {
    let cursor = cursor_id(
        selection.workspace,
        selection.request.connection_id,
        &selection.folder,
    );
    let generation = selection
        .expected_cursor_generation
        .checked_add(1)
        .ok_or(INCONSISTENT)?;
    let history = ctx
        .db
        .protected_mail_connector_cursor_history()
        .id()
        .find(history_id(&cursor, generation))
        .ok_or(INCONSISTENT)?;
    let bytes = selected_sources(ctx, selection, &receipt.sources).map_err(|_| INCONSISTENT)?;
    if receipt.selection_id != selection.id
        || !hex64(&receipt.event_nonce)
        || receipt.request_digest
            != ack_request(&selection.id, &receipt.event_nonce, &receipt.sources)
        || receipt.cursor_id != cursor
        || receipt.cursor_generation != generation
        || receipt.history_id != history.id
        || receipt.cursor_digest != history.digest
        || receipt.uid_validity != validity(&selection.request.window)
        || receipt.last_uid != selection.through_uid
        || receipt.acknowledged_messages != selection.uids.len() as u32
        || receipt.acknowledged_bytes != bytes
        || receipt.actor != selection.request.connector_identity
        || receipt.digest != receipt_digest(&receipt)
        || history.cursor_id != cursor
        || history.owner != selection.owner
        || history.collection_id != selection.request.connection_id
        || history.folder != selection.folder
        || history.uid_validity != receipt.uid_validity
        || history.generation != generation
        || history.last_uid != receipt.last_uid
        || history.previous_digest != selection.previous_cursor_digest
        || history.selection_id != selection.id
        || history.request_digest != receipt.request_digest
        || history.acknowledged_messages != receipt.acknowledged_messages
        || history.acknowledged_bytes != receipt.acknowledged_bytes
        || history.actor != receipt.actor
        || history.created_at != receipt.created_at
        || history.digest != history_digest(&history)
    {
        return Err(INCONSISTENT.into());
    }
    Ok(receipt)
}

/// Closed read-only cursor association across the three immutable commit families.
/// Descriptor validation is local, with only one explicit predecessor check.
pub(super) struct CursorDescriptor {
    pub history_id: String,
    pub cursor_id: String,
    pub owner: Identity,
    pub collection_id: u64,
    pub folder: String,
    pub uid_validity: String,
    pub generation: u64,
    pub from_uid: u32,
    pub last_uid: u32,
    pub digest: String,
    pub previous_digest: String,
    pub created_at: Timestamp,
}
pub(super) fn checked_cursor_descriptor(
    ctx: &ReducerContext,
    cursor: &str,
    generation: u64,
) -> Result<CursorDescriptor, String> {
    let old = ctx
        .db
        .protected_mail_connector_cursor_history()
        .id()
        .find(history_id(cursor, generation));
    let new = super::ingestion::retained_cursor_descriptor(ctx, cursor, generation)?;
    let sparse = super::sparse_checkpoint::retained_cursor_descriptor(ctx, cursor, generation)?;
    match (old, new, sparse) {
        (Some(history), None, None) => {
            let selection = checked_selection(
                ctx,
                ctx.db
                    .protected_mail_connector_selection()
                    .id()
                    .find(history.selection_id.clone())
                    .ok_or(INCONSISTENT)?,
            )?;
            let receipt = checked_receipt_local(
                ctx,
                &selection,
                ctx.db
                    .protected_mail_connector_ack_receipt()
                    .selection_id()
                    .find(selection.id.clone())
                    .ok_or(INCONSISTENT)?,
            )?;
            if receipt.history_id != history.id
                || history.cursor_id != cursor
                || history.generation != generation
            {
                return Err(INCONSISTENT.into());
            }
            Ok(CursorDescriptor {
                history_id: history.id,
                cursor_id: history.cursor_id,
                owner: history.owner,
                collection_id: history.collection_id,
                folder: history.folder,
                uid_validity: history.uid_validity,
                generation,
                from_uid: selection.from_uid,
                last_uid: history.last_uid,
                digest: history.digest,
                previous_digest: history.previous_digest,
                created_at: history.created_at,
            })
        }
        (None, Some(descriptor), None) | (None, None, Some(descriptor)) => Ok(descriptor),
        _ => Err(INCONSISTENT.into()),
    }
}
pub(super) fn validate_cursor_predecessor(
    ctx: &ReducerContext,
    row: &CursorDescriptor,
) -> Result<(), String> {
    if row.generation == 1 {
        if !row.previous_digest.is_empty() || row.from_uid != 0 {
            return Err(INCONSISTENT.into());
        }
        return Ok(());
    }
    let previous = checked_cursor_descriptor(
        ctx,
        &row.cursor_id,
        row.generation.checked_sub(1).ok_or(INCONSISTENT)?,
    )?;
    if previous.owner != row.owner
        || previous.collection_id != row.collection_id
        || previous.folder != row.folder
        || previous.uid_validity != row.uid_validity
        || previous.digest != row.previous_digest
        || previous.last_uid.checked_add(1) != Some(row.from_uid)
        || previous.created_at > row.created_at
    {
        return Err(INCONSISTENT.into());
    }
    Ok(())
}
fn checked_receipt(
    ctx: &ReducerContext,
    selection: &ProtectedMailConnectorSelection,
    receipt: ProtectedMailConnectorAckReceipt,
) -> Result<ProtectedMailConnectorAckReceipt, String> {
    let receipt = checked_receipt_local(ctx, selection, receipt)?;
    let descriptor = checked_cursor_descriptor(ctx, &receipt.cursor_id, receipt.cursor_generation)?;
    if descriptor.history_id != receipt.history_id || descriptor.digest != receipt.cursor_digest {
        return Err(INCONSISTENT.into());
    }
    validate_cursor_predecessor(ctx, &descriptor)?;
    Ok(receipt)
}
pub(super) fn checked_cursor(
    ctx: &ReducerContext,
    id: &str,
) -> Result<Option<ProtectedMailConnectorCursor>, String> {
    let Some(row) = ctx
        .db
        .protected_mail_connector_cursor()
        .id()
        .find(id.to_owned())
    else {
        return Ok(None);
    };
    let descriptor = checked_cursor_descriptor(ctx, id, row.generation)?;
    if row.id != cursor_id(ctx.identity(), row.collection_id, &row.folder)
        || row.history_id != descriptor.history_id
        || row.owner != descriptor.owner
        || row.collection_id != descriptor.collection_id
        || row.folder != descriptor.folder
        || row.uid_validity != descriptor.uid_validity
        || row.last_uid != descriptor.last_uid
        || row.digest != descriptor.digest
        || row.updated_at != descriptor.created_at
        || row.created_at > row.updated_at
    {
        return Err(INCONSISTENT.into());
    }
    validate_cursor_predecessor(ctx, &descriptor)?;
    let initial = checked_cursor_descriptor(ctx, id, 1)?;
    if initial.created_at != row.created_at
        || initial.owner != row.owner
        || initial.collection_id != row.collection_id
        || initial.folder != row.folder
        || initial.uid_validity != row.uid_validity
    {
        return Err(INCONSISTENT.into());
    }
    Ok(Some(row))
}

fn preview(
    ctx: &ReducerContext,
    request: ProtectedMailConnectorSelectionRequest,
) -> Result<ProtectedMailConnectorSelection, String> {
    let connection = owner_connection(ctx, request.connection_id)?;
    valid_request(&request)?;
    if !service(ctx, request.connector_identity, connection.owner) {
        return Err(STALE.into());
    }
    let authority = checked_current_authority(ctx, connection.id).map_err(|_| STALE)?;
    if authority.owner != connection.owner {
        return Err(INCONSISTENT.into());
    }
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if request.expires_at_ms <= now || request.expires_at_ms - now > MAX_TTL {
        return Err(STALE.into());
    }
    let folder = match request.direction {
        ProtectedMailDirection::Received => connection.inbox_folder.clone(),
        ProtectedMailDirection::Sent => connection.sent_folder.clone().ok_or(INVALID)?,
    };
    let existing = checked_cursor(ctx, &cursor_id(ctx.identity(), connection.id, &folder))?;
    let (generation, previous, from, through, uids, max) = match &request.window {
        ProtectedMailConnectorWindow::NewOnly(ProtectedMailConnectorNewOnly {
            uid_next, ..
        }) => {
            if existing.is_some() {
                return Err(STALE.into());
            }
            (0, String::new(), 0, uid_next - 1, vec![], 0)
        }
        ProtectedMailConnectorWindow::StoredBatch(ProtectedMailConnectorStoredBatch {
            uid_validity,
            expected_cursor_generation,
            message_count,
            max_acknowledged_bytes,
        }) => {
            let cursor = existing.ok_or(STALE)?;
            if cursor.uid_validity != *uid_validity
                || cursor.generation != *expected_cursor_generation
            {
                return Err(STALE.into());
            }
            cursor.generation.checked_add(1).ok_or(LIMIT)?;
            let (from, through, uids) = next_uids(cursor.last_uid, *message_count)?;
            (
                cursor.generation,
                cursor.digest,
                from,
                through,
                uids,
                *max_acknowledged_bytes,
            )
        }
    };
    let mut row = ProtectedMailConnectorSelection {
        id: selection_id(connection.owner, connection.id, &request.event_nonce),
        owner: connection.owner,
        workspace: ctx.identity(),
        request,
        connection_epoch: authority.epoch,
        snapshot_digest: authority.snapshot_digest,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        folder,
        expected_cursor_generation: generation,
        previous_cursor_digest: previous,
        from_uid: from,
        through_uid: through,
        uids,
        max_acknowledged_bytes: max,
        manifest_digest: String::new(),
        manifest_bytes: 0,
        canonical: String::new(),
        issue_digest: String::new(),
        created_at: ctx.timestamp,
    };
    if !selection_shape(&row) {
        return Err(INVALID.into());
    }
    row.canonical = metadata(&row)?;
    row.manifest_bytes = row.canonical.len() as u64;
    row.manifest_digest = hex::encode(Sha256::digest(row.canonical.as_bytes()));
    row.issue_digest = issue_digest(
        &row.request,
        row.connection_epoch,
        &row.snapshot_digest,
        &row.manifest_digest,
    );
    Ok(row)
}
fn preview_dto(row: ProtectedMailConnectorSelection) -> ProtectedMailConnectorPreview {
    ProtectedMailConnectorPreview {
        selection_id: row.id,
        connection_epoch: row.connection_epoch,
        snapshot_digest: row.snapshot_digest,
        manifest_digest: row.manifest_digest,
        manifest_bytes: row.manifest_bytes,
        canonical: row.canonical,
    }
}
#[procedure]
pub fn review_protected_mail_connector_selection(
    ctx: &mut ProcedureContext,
    request: ProtectedMailConnectorSelectionRequest,
) -> Result<ProtectedMailConnectorPreview, String> {
    ctx.try_with_tx(|tx| {
        preview(tx.as_ref(), request.clone())
            .map(preview_dto)
            .map_err(fixed_error)
    })
}
#[reducer]
pub fn issue_protected_mail_connector_selection(
    ctx: &ReducerContext,
    request: ProtectedMailConnectorSelectionRequest,
    expected_epoch: u64,
    expected_snapshot_digest: String,
    expected_manifest_digest: String,
) -> Result<(), String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let id = selection_id(ctx.sender(), request.connection_id, &request.event_nonce);
    if let Some(old) = ctx
        .db
        .protected_mail_connector_selection()
        .id()
        .find(id.clone())
    {
        let old = checked_selection(ctx, old)?;
        if old.owner != ctx.sender() {
            return Err(OWNER.into());
        }
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
    if !hex64(&expected_snapshot_digest) || !hex64(&expected_manifest_digest) || expected_epoch == 0
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
        .protected_mail_connector_selection_event()
        .id()
        .find(event_id(&id, 1))
        .is_some()
        || ctx
            .db
            .protected_mail_connector_selection_event()
            .id()
            .find(event_id(&id, 2))
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    ctx.db.protected_mail_connector_selection_event().insert(
        ProtectedMailConnectorSelectionEvent {
            id: event_id(&id, 1),
            selection_id: id,
            generation: 1,
            kind: ProtectedMailConnectorSelectionEventKind::Issued,
            event_nonce: row.request.event_nonce.clone(),
            request_digest: row.issue_digest.clone(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        },
    );
    ctx.db.protected_mail_connector_selection().insert(row);
    Ok(())
}
#[reducer]
pub fn revoke_protected_mail_connector_selection(
    ctx: &ReducerContext,
    selection_id: String,
    event_nonce: String,
) -> Result<(), String> {
    let row = owned_selection(ctx, &selection_id)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    if event_nonce == row.request.event_nonce {
        return Err(CONFLICT.into());
    }
    let request_digest = hash(
        "pear-mail-connector-revoke-v1",
        &[selection_id.clone(), event_nonce.clone()],
    );
    if let Some(old) = ctx
        .db
        .protected_mail_connector_selection_event()
        .id()
        .find(event_id(&selection_id, 2))
    {
        if old.request_digest != request_digest {
            return Err(CONFLICT.into());
        }
        return Ok(());
    }
    ctx.db.protected_mail_connector_selection_event().insert(
        ProtectedMailConnectorSelectionEvent {
            id: event_id(&selection_id, 2),
            selection_id,
            generation: 2,
            kind: ProtectedMailConnectorSelectionEventKind::Revoked,
            event_nonce,
            request_digest,
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        },
    );
    Ok(())
}
fn ack_dto(row: &ProtectedMailConnectorAckReceipt) -> ProtectedMailConnectorAck {
    ProtectedMailConnectorAck {
        selection_id: row.selection_id.clone(),
        cursor_id: row.cursor_id.clone(),
        cursor_generation: row.cursor_generation,
        uid_validity: row.uid_validity.clone(),
        last_uid: row.last_uid,
        acknowledged_messages: row.acknowledged_messages,
        acknowledged_bytes: row.acknowledged_bytes,
        receipt_digest: row.digest.clone(),
    }
}
/// Current selection authority only. No lookup of the future selected S1
/// sources and no historical ACK bypass; review may precede activation.
pub(super) fn require_current_selection(ctx: &ReducerContext, row: &ProtectedMailConnectorSelection,
    require_active: bool) -> Result<Option<ProtectedMailConnectorCursor>, String> {
    if !human(ctx, row.owner) {
        return Err(STALE.into());
    }
    let authority = checked_current_authority(ctx, row.request.connection_id).map_err(|_| STALE)?;
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if authority.owner != row.owner
        || authority.epoch != row.connection_epoch
        || authority.snapshot_digest != row.snapshot_digest
        || (require_active && now < row.request.not_before_ms)
        || now >= row.request.expires_at_ms
        || ctx
            .db
            .protected_mail_connector_selection_event()
            .id()
            .find(event_id(&row.id, 2))
            .is_some()
    {
        return Err(STALE.into());
    }
    let cursor_id = cursor_id(ctx.identity(), row.request.connection_id, &row.folder);
    let cursor = checked_cursor(ctx, &cursor_id)?;
    match &cursor {
        None if row.expected_cursor_generation == 0 => (),
        Some(c)
            if c.owner == row.owner
                && c.collection_id == row.request.connection_id
                && c.folder == row.folder
                && c.uid_validity == validity(&row.request.window)
                && c.generation == row.expected_cursor_generation
                && c.digest == row.previous_cursor_digest
                && c.last_uid.checked_add(1) == Some(row.from_uid) =>
        {
            ()
        }
        _ => return Err(STALE.into()),
    }
    Ok(cursor)
}
fn acknowledge(
    ctx: &ReducerContext,
    id: &str,
    nonce: &str,
    sources: &[ProtectedMailSourceRef],
) -> Result<ProtectedMailConnectorAck, String> {
    let row = bound_selection(ctx, id)?;
    if let Some(receipt) = ctx.db.protected_mail_connector_ack_receipt().selection_id().find(id.to_owned()) {
        if receipt.event_nonce != nonce || receipt.sources != sources { return Err(CONFLICT.into()); }
        return checked_receipt(ctx, &row, receipt).map(|r| ack_dto(&r));
    }
    if !hex64(nonce) { return Err(INVALID.into()); }
    let cursor = require_current_selection(ctx, &row, true)?;
    let cursor_id = cursor_id(ctx.identity(), row.request.connection_id, &row.folder);
    let bytes = selected_sources(ctx, &row, sources)?;
    let generation = row.expected_cursor_generation.checked_add(1).ok_or(LIMIT)?;
    let history_id = history_id(&cursor_id, generation);
    if ctx
        .db
        .protected_mail_connector_cursor_history()
        .id()
        .find(history_id.clone())
        .is_some()
        || super::ingestion::cursor_generation_present(ctx,&cursor_id,generation)
        || super::sparse_checkpoint::cursor_generation_present(ctx,&cursor_id,generation)
    {
        return Err(INCONSISTENT.into());
    }
    let request_digest = ack_request(id, nonce, sources);
    let mut history = ProtectedMailConnectorCursorHistory {
        id: history_id.clone(),
        cursor_id: cursor_id.clone(),
        owner: row.owner,
        collection_id: row.request.connection_id,
        folder: row.folder.clone(),
        uid_validity: validity(&row.request.window).into(),
        generation,
        last_uid: row.through_uid,
        previous_digest: row.previous_cursor_digest.clone(),
        selection_id: id.into(),
        request_digest: request_digest.clone(),
        acknowledged_messages: sources.len() as u32,
        acknowledged_bytes: bytes,
        digest: String::new(),
        actor: ctx.sender(),
        created_at: ctx.timestamp,
    };
    history.digest = history_digest(&history);
    let mut receipt = ProtectedMailConnectorAckReceipt {
        selection_id: id.into(),
        event_nonce: nonce.into(),
        request_digest,
        sources: sources.to_vec(),
        cursor_id: cursor_id.clone(),
        cursor_generation: generation,
        history_id: history_id.clone(),
        cursor_digest: history.digest.clone(),
        uid_validity: history.uid_validity.clone(),
        last_uid: row.through_uid,
        acknowledged_messages: sources.len() as u32,
        acknowledged_bytes: bytes,
        digest: String::new(),
        actor: ctx.sender(),
        created_at: ctx.timestamp,
    };
    receipt.digest = receipt_digest(&receipt);
    let next = ProtectedMailConnectorCursor {
        id: cursor_id,
        owner: row.owner,
        collection_id: row.request.connection_id,
        folder: row.folder,
        uid_validity: history.uid_validity.clone(),
        generation,
        last_uid: row.through_uid,
        digest: history.digest.clone(),
        history_id,
        created_at: cursor.as_ref().map_or(ctx.timestamp, |c| c.created_at),
        updated_at: ctx.timestamp,
    };
    ctx.db
        .protected_mail_connector_cursor_history()
        .insert(history);
    if cursor.is_some() {
        ctx.db.protected_mail_connector_cursor().id().update(next);
    } else {
        ctx.db.protected_mail_connector_cursor().insert(next);
    }
    let dto = ack_dto(&receipt);
    ctx.db
        .protected_mail_connector_ack_receipt()
        .insert(receipt);
    Ok(dto)
}
fn fixed_error(error: String) -> String {
    match error.as_str() {
        INVALID | INCONSISTENT | OWNER | SERVICE | CONFLICT | STALE | REQUIRED | LIMIT => error,
        _ => INCONSISTENT.into(),
    }
}
#[procedure]
pub fn acknowledge_protected_mail_connector_selection(
    ctx: &mut ProcedureContext,
    selection_id: String,
    event_nonce: String,
    sources: Vec<ProtectedMailSourceRef>,
) -> Result<ProtectedMailConnectorAck, String> {
    ctx.try_with_tx(|tx| {
        acknowledge(tx.as_ref(), &selection_id, &event_nonce, &sources).map_err(fixed_error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> ProtectedMailConnectorSelectionRequest {
        ProtectedMailConnectorSelectionRequest {
            connection_id: u64::MAX,
            connector_identity: Identity::from_byte_array([0xee; 32]),
            runtime_id: "fixture-runtime".into(),
            run_id: "fixture-run".into(),
            direction: ProtectedMailDirection::Received,
            window: ProtectedMailConnectorWindow::NewOnly(ProtectedMailConnectorNewOnly {
                uid_validity: u32::MAX.to_string(),
                uid_next: 1,
            }),
            not_before_ms: 1_700_000_000_000,
            expires_at_ms: 1_700_003_600_000,
            event_nonce: "1".repeat(64),
        }
    }
    fn row() -> ProtectedMailConnectorSelection {
        ProtectedMailConnectorSelection {
            id: "a".repeat(64),
            owner: Identity::from_byte_array([0xcc; 32]),
            workspace: Identity::from_byte_array([0xbb; 32]),
            request: request(),
            connection_epoch: 9_007_199_254_740_993,
            snapshot_digest: "d".repeat(64),
            host: "imap.example.test".into(),
            port: 993,
            username: "quoted\"user\\@example.test".into(),
            folder: "Inbox \"quoted\"\\".into(),
            expected_cursor_generation: 0,
            previous_cursor_digest: String::new(),
            from_uid: 0,
            through_uid: 0,
            uids: vec![],
            max_acknowledged_bytes: 0,
            manifest_digest: String::new(),
            manifest_bytes: 0,
            canonical: String::new(),
            issue_digest: String::new(),
            created_at: Timestamp::from_micros_since_unix_epoch(1_700_000_000_000_000),
        }
    }
    fn source(id: &str) -> ProtectedMailSourceRef {
        ProtectedMailSourceRef {
            id: id.into(),
            revision: 1,
            digest: "a".repeat(64),
        }
    }
    #[test]
    fn new_only_metadata_matches_independent_golden() {
        let bytes = metadata(&row()).unwrap();
        assert_eq!(bytes.len(), 968);
        assert_eq!(
            hex::encode(Sha256::digest(bytes.as_bytes())),
            "a943ecf05316032f36e90c6c20c52c6cef8aaac357a82861d34a97e9b7c8bc25"
        );
        let parsed: serde_json::Value = serde_json::from_str(&bytes).unwrap();
        assert_eq!(parsed.as_object().unwrap().len(), 11);
        assert_eq!(parsed["connection"]["id"], u64::MAX.to_string());
        assert_eq!(parsed["selection"]["throughUid"], 0);
    }
    #[test]
    fn stored_batch_unicode_and_full_integer_golden() {
        let mut row = row();
        row.request.connection_id = 9_007_199_254_740_993;
        row.connection_epoch = u64::MAX;
        row.port = 65535;
        row.username = "日本語🍐e\u{301}\u{2028}@example.test".into();
        row.folder = "送信済み🍐\u{2028}e\u{301}".into();
        row.request.direction = ProtectedMailDirection::Sent;
        row.request.window =
            ProtectedMailConnectorWindow::StoredBatch(ProtectedMailConnectorStoredBatch {
                uid_validity: "7".into(),
                expected_cursor_generation: u64::MAX,
                message_count: 8,
                max_acknowledged_bytes: MAX_BYTES,
            });
        row.expected_cursor_generation = u64::MAX;
        row.previous_cursor_digest = "f".repeat(64);
        row.from_uid = u32::MAX - 7;
        row.through_uid = u32::MAX;
        row.uids = (row.from_uid..=row.through_uid).collect();
        row.max_acknowledged_bytes = MAX_BYTES;
        let bytes = metadata(&row).unwrap();
        assert_eq!(bytes.len(), 1164);
        assert_eq!(
            hex::encode(Sha256::digest(bytes.as_bytes())),
            "54e5e98a4f7f972833b3796b1e7f7d6bc5f2e6a8464a7e12ec96537130ba2197"
        );
        assert!(bytes.contains("18446744073709551615"));
        assert!(bytes.contains("送信済み🍐\u{2028}e\u{301}"));
    }
    #[test]
    fn new_uid_contract_is_canonical_nonzero_u32_without_changing_s1() {
        for invalid in [
            "0",
            "01",
            "+1",
            " 1",
            "1 ",
            "4294967296",
            "18446744073709551615",
            "",
        ] {
            assert!(!canonical_u32(invalid));
        }
        for valid in ["1", "4294967295"] {
            assert!(canonical_u32(valid));
        }
        let mut request = request();
        request.window = ProtectedMailConnectorWindow::NewOnly(ProtectedMailConnectorNewOnly {
            uid_validity: "1".into(),
            uid_next: 0,
        });
        assert_eq!(valid_request(&request).unwrap_err(), INVALID);
    }
    #[test]
    fn contiguous_batches_include_every_numeric_slot_and_fail_on_overflow() {
        assert_eq!(next_uids(0, 1).unwrap(), (1, 1, vec![1]));
        assert_eq!(next_uids(10, 3).unwrap(), (11, 13, vec![11, 12, 13]));
        assert_eq!(
            next_uids(u32::MAX - 8, 8).unwrap().2,
            (u32::MAX - 7..=u32::MAX).collect::<Vec<_>>()
        );
        assert_eq!(next_uids(u32::MAX, 1).unwrap_err(), LIMIT);
        assert_eq!(next_uids(u32::MAX - 7, 8).unwrap_err(), LIMIT);
        assert_eq!(next_uids(0, 9).unwrap_err(), LIMIT);
        assert_eq!(next_uids(0, 0).unwrap_err(), INVALID);
    }
    #[test]
    fn request_limits_and_exact_ascii_run_binding_are_closed() {
        let original = request();
        assert!(valid_request(&original).is_ok());
        for value in ["", "run space", "run/other", "🍐", "a\n"] {
            let mut r = original.clone();
            r.run_id = value.into();
            assert_eq!(valid_request(&r).unwrap_err(), INVALID);
        }
        let mut r = original.clone();
        r.run_id = "a".repeat(128);
        assert!(valid_request(&r).is_ok());
        r.run_id.push('a');
        assert!(valid_request(&r).is_err());
        r = original.clone();
        r.not_before_ms = r.expires_at_ms;
        assert!(valid_request(&r).is_ok());
        r.not_before_ms += 1;
        assert!(valid_request(&r).is_err());
        r = original;
        r.window = ProtectedMailConnectorWindow::StoredBatch(ProtectedMailConnectorStoredBatch {
            uid_validity: "1".into(),
            expected_cursor_generation: 1,
            message_count: 9,
            max_acknowledged_bytes: MAX_BYTES,
        });
        assert_eq!(valid_request(&r).unwrap_err(), LIMIT);
    }
    #[test]
    fn manifest_freezes_every_config_and_selection_field() {
        let original = metadata(&row()).unwrap();
        let mutations: Vec<Box<dyn Fn(&mut ProtectedMailConnectorSelection)>> = vec![
            Box::new(|r| r.owner = Identity::from_byte_array([1; 32])),
            Box::new(|r| r.workspace = Identity::from_byte_array([2; 32])),
            Box::new(|r| r.host.push('x')),
            Box::new(|r| r.port -= 1),
            Box::new(|r| r.username.push(' ')),
            Box::new(|r| r.folder.push(' ')),
            Box::new(|r| r.request.run_id.push('x')),
            Box::new(|r| r.connection_epoch -= 1),
            Box::new(|r| r.snapshot_digest = "1".repeat(64)),
            Box::new(|r| r.request.expires_at_ms -= 1),
            Box::new(|r| r.through_uid = 1),
        ];
        for mutate in mutations {
            let mut r = row();
            mutate(&mut r);
            assert_ne!(metadata(&r).unwrap(), original);
        }
    }
    #[test]
    fn issue_replay_commits_full_request_and_review_pins() {
        let r = request();
        let original = issue_digest(&r, 1, &"a".repeat(64), &"b".repeat(64));
        let mut changed = r.clone();
        changed.run_id.push('x');
        assert_ne!(
            issue_digest(&changed, 1, &"a".repeat(64), &"b".repeat(64)),
            original
        );
        changed = r.clone();
        changed.window = ProtectedMailConnectorWindow::NewOnly(ProtectedMailConnectorNewOnly {
            uid_validity: "1".into(),
            uid_next: 1,
        });
        assert_ne!(
            issue_digest(&changed, 1, &"a".repeat(64), &"b".repeat(64)),
            original
        );
        assert_ne!(
            issue_digest(&r, 2, &"a".repeat(64), &"b".repeat(64)),
            original
        );
        assert_ne!(
            issue_digest(&r, 1, &"c".repeat(64), &"b".repeat(64)),
            original
        );
        assert_ne!(
            issue_digest(&r, 1, &"a".repeat(64), &"c".repeat(64)),
            original
        );
    }
    #[test]
    fn ids_are_owner_scoped_and_cursor_namespace_survives_selection_changes() {
        let owner = Identity::from_byte_array([1; 32]);
        let workspace = Identity::from_byte_array([2; 32]);
        let nonce = "a".repeat(64);
        assert_ne!(
            selection_id(owner, 1, &nonce),
            selection_id(workspace, 1, &nonce)
        );
        assert_ne!(
            selection_id(owner, 1, &nonce),
            selection_id(owner, 2, &nonce)
        );
        let cursor = cursor_id(workspace, 1, "Inbox");
        assert!(cursor.starts_with("mail-connector-cursor:"));
        assert_ne!(cursor, cursor_id(workspace, 2, "Inbox"));
        assert_ne!(cursor, cursor_id(workspace, 1, "inbox"));
        assert_ne!(history_id(&cursor, 1), history_id(&cursor, 2));
        assert_ne!(event_id(&nonce, 1), event_id(&nonce, 2));
    }
    #[test]
    fn ack_request_binds_exact_nonce_source_order_and_revision_digest() {
        let sources = vec![source("one"), source("two")];
        let original = ack_request("selection", "nonce", &sources);
        let mut reversed = sources.clone();
        reversed.reverse();
        assert_ne!(ack_request("selection", "nonce", &reversed), original);
        let mut changed = sources.clone();
        changed[0].revision = 2;
        assert_ne!(ack_request("selection", "nonce", &changed), original);
        changed = sources.clone();
        changed[0].digest = "b".repeat(64);
        assert_ne!(ack_request("selection", "nonce", &changed), original);
        assert_ne!(ack_request("selection", "other", &sources), original);
        assert_ne!(ack_request("other", "nonce", &sources), original);
    }
    #[test]
    fn historical_cursor_digest_binds_predecessor_selection_actor_and_measurement() {
        let h = || ProtectedMailConnectorCursorHistory {
            id: "history".into(),
            cursor_id: "cursor".into(),
            owner: Identity::from_byte_array([1; 32]),
            collection_id: 1,
            folder: "INBOX".into(),
            uid_validity: "7".into(),
            generation: 2,
            last_uid: 8,
            previous_digest: "a".repeat(64),
            selection_id: "b".repeat(64),
            request_digest: "c".repeat(64),
            acknowledged_messages: 8,
            acknowledged_bytes: 1000,
            digest: String::new(),
            actor: Identity::from_byte_array([2; 32]),
            created_at: Timestamp::from_micros_since_unix_epoch(1),
        };
        let original = history_digest(&h());
        let mut changed = h();
        changed.previous_digest = "d".repeat(64);
        assert_ne!(history_digest(&changed), original);
        changed = h();
        changed.last_uid += 1;
        assert_ne!(history_digest(&changed), original);
        changed = h();
        changed.acknowledged_bytes += 1;
        assert_ne!(history_digest(&changed), original);
        changed = h();
        changed.actor = Identity::from_byte_array([3; 32]);
        assert_ne!(history_digest(&changed), original);
        changed = h();
        changed.selection_id = "e".repeat(64);
        assert_ne!(history_digest(&changed), original);
    }
    #[test]
    fn malformed_persisted_selection_cannot_change_window_or_introduce_holes() {
        let mut r = row();
        r.id = selection_id(r.owner, r.request.connection_id, &r.request.event_nonce);
        assert!(selection_shape(&r));
        r.through_uid = 1;
        assert!(!selection_shape(&r));
        r = row();
        r.id = selection_id(r.owner, r.request.connection_id, &r.request.event_nonce);
        r.request.window =
            ProtectedMailConnectorWindow::StoredBatch(ProtectedMailConnectorStoredBatch {
                uid_validity: "7".into(),
                expected_cursor_generation: 1,
                message_count: 3,
                max_acknowledged_bytes: 1000,
            });
        r.expected_cursor_generation = 1;
        r.previous_cursor_digest = "a".repeat(64);
        r.from_uid = 1;
        r.through_uid = 3;
        r.uids = vec![1, 2, 3];
        r.max_acknowledged_bytes = 1000;
        assert!(selection_shape(&r));
        r.uids = vec![1, 3];
        assert!(!selection_shape(&r));
        r.uids = vec![3, 2, 1];
        assert!(!selection_shape(&r));
    }
    #[test]
    fn metadata_limits_and_fixed_errors_never_disclose_subsystem_text() {
        let mut r = row();
        r.folder = "\\".repeat(MAX_MANIFEST);
        assert_eq!(metadata(&r).unwrap_err(), LIMIT);
        for code in [
            INVALID,
            INCONSISTENT,
            OWNER,
            SERVICE,
            CONFLICT,
            STALE,
            REQUIRED,
            LIMIT,
        ] {
            assert_eq!(fixed_error(code.into()), code);
        }
        assert_eq!(fixed_error("SYNTHETIC_PRIVATE_ERROR".into()), INCONSISTENT);
        assert!(text("日本語\u{2028}🍐", 512));
        assert!(!text("bad\u{85}", 512));
        assert!(!text("bad\0", 512));
    }
}
