//! Exact owner-authorized checkpoint of a retained sparse observation and
//! already-stored S1 records. Absence is a point-in-time disposition, never a
//! permanent negative tuple or permission to read, import, process or disclose.
use super::admission::{canonical, hash, hex64, human, now_ms, service};
use super::connector::{
    self, protected_mail_connector_cursor, CursorDescriptor, ProtectedMailConnectorCursor,
};
use super::discovery::{
    self, protected_mail_discovery_grant, protected_mail_discovery_observation,
    ProtectedMailDiscoveryGrant, ProtectedMailDiscoveryMode, ProtectedMailDiscoveryObservation,
};
use super::governance::ProtectedMailSourceRef;
use super::ingestion::protected_mail_ingestion_disposition;
use super::protected::{
    checked_stored_mail_tuple, mailbox_tuple_event_id, protected_mail_receipt,
    ProtectedMailDirection,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spacetimedb::{
    procedure, reducer, table, Identity, ProcedureContext, ReducerContext, SpacetimeType, Table,
    Timestamp,
};

const INVALID: &str = "protected_mail_sparse_checkpoint_invalid_request";
const INCONSISTENT: &str = "protected_mail_sparse_checkpoint_inconsistent";
const OWNER: &str = "protected_mail_sparse_checkpoint_owner_required";
const SERVICE: &str = "protected_mail_sparse_checkpoint_service_required";
const CONFLICT: &str = "protected_mail_sparse_checkpoint_event_conflict";
const STALE: &str = "protected_mail_sparse_checkpoint_stale";
const REQUIRED: &str = "protected_mail_sparse_checkpoint_source_required";
const LIMIT: &str = "protected_mail_sparse_checkpoint_limit_exceeded";
const SAFE: u64 = 9_007_199_254_740_991;
const TTL: u64 = 3_600_000;
const MAX_BYTES: u64 = 2_097_152;
const MAX_MANIFEST: usize = 16_384;

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailSparseCheckpointRequest {
    pub observation_id: String,
    pub not_before_ms: u64,
    pub expires_at_ms: u64,
    pub max_acknowledged_bytes: u64,
    pub event_nonce: String,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailSparseCheckpointSource {
    pub uid: u32,
    pub source: ProtectedMailSourceRef,
    pub bytes: u64,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailSparseCheckpointDisposition {
    Present(ProtectedMailSparseCheckpointSource),
    ObservedAbsent(u32),
}
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailSparseCheckpointGrantEventKind {
    Issued,
    Revoked,
}
#[table(accessor=protected_mail_sparse_checkpoint_grant,private)]
pub struct ProtectedMailSparseCheckpointGrant {
    #[primary_key]
    pub id: String,
    #[unique]
    pub observation_id: String,
    #[index(btree)]
    pub owner: Identity,
    pub workspace: Identity,
    pub request: ProtectedMailSparseCheckpointRequest,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub sources: Vec<ProtectedMailSparseCheckpointSource>,
    pub acknowledged_bytes: u64,
    pub manifest_digest: String,
    pub manifest_bytes: u64,
    pub canonical: String,
    pub issue_digest: String,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_sparse_checkpoint_grant_event,private)]
pub struct ProtectedMailSparseCheckpointGrantEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub checkpoint_id: String,
    pub generation: u64,
    pub kind: ProtectedMailSparseCheckpointGrantEventKind,
    pub event_nonce: String,
    pub request_digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_sparse_checkpoint_receipt,private)]
pub struct ProtectedMailSparseCheckpointReceipt {
    #[primary_key]
    pub checkpoint_id: String,
    pub event_nonce: String,
    pub request_digest: String,
    pub observation_digest: String,
    pub cursor_id: String,
    #[unique]
    pub history_id: String,
    pub cursor_generation: u64,
    pub uid_validity: String,
    pub from_uid: u32,
    pub last_uid: u32,
    pub previous_digest: String,
    pub dispositions: Vec<ProtectedMailSparseCheckpointDisposition>,
    pub acknowledged_messages: u32,
    pub observed_absent_messages: u32,
    pub acknowledged_bytes: u64,
    pub receipt_digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[table(accessor=protected_mail_sparse_checkpoint_cursor_history,private)]
pub struct ProtectedMailSparseCheckpointCursorHistory {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub cursor_id: String,
    #[unique]
    pub checkpoint_id: String,
    pub owner: Identity,
    pub collection_id: u64,
    pub folder: String,
    pub uid_validity: String,
    pub generation: u64,
    pub from_uid: u32,
    pub last_uid: u32,
    pub previous_digest: String,
    pub digest: String,
    pub created_at: Timestamp,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailSparseCheckpointPreview {
    pub checkpoint_id: String,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub manifest_digest: String,
    pub manifest_bytes: u64,
    pub canonical: String,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailSparseCheckpointReceiptDto {
    pub checkpoint_id: String,
    pub observation_id: String,
    pub cursor_id: String,
    pub cursor_generation: u64,
    pub uid_validity: String,
    pub last_uid: u32,
    pub acknowledged_messages: u32,
    pub observed_absent_messages: u32,
    pub acknowledged_bytes: u64,
    pub receipt_digest: String,
}

fn sha(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn checkpoint_id(observation: &str) -> String {
    hash("pear-mail-sparse-checkpoint-v1", &[observation.into()])
}
fn owner_event_id(workspace: Identity, owner: Identity, nonce: &str) -> String {
    hash(
        "pear-mail-sparse-checkpoint-owner-event-v1",
        &[
            workspace.to_hex().to_string(),
            owner.to_hex().to_string(),
            nonce.into(),
        ],
    )
}
pub(super) fn history_id(cursor: &str, generation: u64) -> String {
    format!(
        "mail-sparse-checkpoint-cursor-history:{}",
        hash(
            "pear-mail-sparse-checkpoint-cursor-history-v1",
            &[cursor.into(), generation.to_string()]
        )
    )
}
fn valid_request(request: &ProtectedMailSparseCheckpointRequest) -> Result<(), String> {
    if !hex64(&request.observation_id)
        || !hex64(&request.event_nonce)
        || request.not_before_ms > SAFE
        || request.expires_at_ms > SAFE
        || request.expires_at_ms <= request.not_before_ms
        || request.expires_at_ms - request.not_before_ms > TTL
    {
        return Err(INVALID.into());
    }
    if request.max_acknowledged_bytes > MAX_BYTES {
        return Err(LIMIT.into());
    }
    Ok(())
}
fn source_json(source: &ProtectedMailSparseCheckpointSource) -> Value {
    json!({"uid":source.uid,"source":{"id":source.source.id,"revision":source.source.revision.to_string(),"digest":source.source.digest},"bytes":source.bytes})
}
fn source_shape(source: &ProtectedMailSparseCheckpointSource) -> bool {
    let pieces = source.source.id.split(':').collect::<Vec<_>>();
    pieces.len() == 3
        && pieces[0] == "mail-source"
        && pieces[1]
            .parse::<u64>()
            .is_ok_and(|v| v > 0 && v.to_string() == pieces[1])
        && hex64(pieces[2])
        && source.source.revision == 1
        && hex64(&source.source.digest)
        && source.uid > 0
        && source.bytes > 0
        && source.bytes <= MAX_BYTES
}
fn sources_total(
    sources: &[ProtectedMailSparseCheckpointSource],
    present: &[u32],
    max: u64,
) -> Result<u64, String> {
    if sources.len() > 8 || max > MAX_BYTES {
        return Err(LIMIT.into());
    }
    if sources.len() != present.len() || (sources.is_empty() != (max == 0)) {
        return Err(INVALID.into());
    }
    let mut total = 0u64;
    for (source, uid) in sources.iter().zip(present) {
        if !source_shape(source) || source.uid != *uid {
            return Err(INVALID.into());
        }
        total = total.checked_add(source.bytes).ok_or(LIMIT)?;
    }
    if total > max || total > MAX_BYTES {
        return Err(LIMIT.into());
    }
    Ok(total)
}
fn observation_range(
    observation: &ProtectedMailDiscoveryObservation,
    discovery: &ProtectedMailDiscoveryGrant,
) -> Result<(u32, u32), String> {
    let cursor = discovery.cursor.as_ref().ok_or(INVALID)?;
    let range = observation.range.as_ref().ok_or(INVALID)?;
    if !matches!(
        discovery.request.mode,
        ProtectedMailDiscoveryMode::NextWindow(_)
    ) || range.from_uid == 0
        || cursor.last_uid.checked_add(1) != Some(range.from_uid)
        || range.through_uid < range.from_uid
        || u64::from(range.through_uid) - u64::from(range.from_uid) >= 8
        || range.through_uid >= observation.input.uid_next
        || observation.input.uid_validity != cursor.uid_validity
    {
        return Err(INVALID.into());
    }
    Ok((range.from_uid, range.through_uid))
}
fn manifest(
    row: &ProtectedMailSparseCheckpointGrant,
    observation: &ProtectedMailDiscoveryObservation,
    discovery: &ProtectedMailDiscoveryGrant,
) -> Result<String, String> {
    valid_request(&row.request)?;
    let (from, through) = observation_range(observation, discovery)?;
    let cursor = discovery.cursor.as_ref().ok_or(INVALID)?;
    if sources_total(
        &row.sources,
        &observation.input.present_uids,
        row.request.max_acknowledged_bytes,
    )? != row.acknowledged_bytes
    {
        return Err(INVALID.into());
    }
    let direction = match discovery.request.direction {
        ProtectedMailDirection::Received => "received",
        ProtectedMailDirection::Sent => "sent",
    };
    let value=canonical(&json!({"formatVersion":1,"kind":"mail.connector.sparse_checkpoint","checkpointId":row.id,"eventNonce":row.request.event_nonce,"workspaceId":row.workspace.to_hex().to_string(),"ownerId":row.owner.to_hex().to_string(),
        "connection":{"id":discovery.request.connection_id.to_string(),"epoch":row.connection_epoch.to_string(),"snapshotDigest":row.snapshot_digest},
        "connector":{"identity":discovery.request.connector_identity.to_hex().to_string(),"runtimeId":discovery.request.runtime_id,"runId":discovery.request.run_id},
        "mailbox":{"host":discovery.host,"port":discovery.port,"username":discovery.username,"folder":discovery.folder,"direction":direction},
        "cursor":{"id":cursor.id,"generation":cursor.generation.to_string(),"digest":cursor.digest,"uidValidity":cursor.uid_validity,"lastUid":cursor.last_uid},
        "observation":{"id":observation.discovery_id,"digest":observation.observation_digest,"manifestDigest":discovery.manifest_digest,"headId":observation.head_id,"headGeneration":observation.head_generation.to_string(),"uidValidity":observation.input.uid_validity,"uidNext":observation.input.uid_next,"fromUid":from,"throughUid":through,"presentUids":observation.input.present_uids,"absentUids":observation.absent_uids},
        "sources":row.sources.iter().map(source_json).collect::<Vec<_>>(),"acknowledgedBytes":row.acknowledged_bytes,"maxAcknowledgedBytes":row.request.max_acknowledged_bytes,"notBeforeMs":row.request.not_before_ms,"expiresAtMs":row.request.expires_at_ms})).map_err(|_|INCONSISTENT)?;
    if value.len() > MAX_MANIFEST {
        return Err(LIMIT.into());
    }
    Ok(value)
}
fn issue_digest(
    request: &ProtectedMailSparseCheckpointRequest,
    epoch: u64,
    snapshot: &str,
    manifest: &str,
) -> String {
    hash(
        "pear-mail-sparse-checkpoint-issue-v1",
        &[
            request.observation_id.clone(),
            request.not_before_ms.to_string(),
            request.expires_at_ms.to_string(),
            request.max_acknowledged_bytes.to_string(),
            request.event_nonce.clone(),
            epoch.to_string(),
            snapshot.into(),
            manifest.into(),
        ],
    )
}
fn revoke_digest(id: &str, nonce: &str) -> String {
    hash(
        "pear-mail-sparse-checkpoint-revoke-v1",
        &[id.into(), nonce.into()],
    )
}
fn ack_request(id: &str, nonce: &str, manifest: &str) -> String {
    hash(
        "pear-mail-sparse-checkpoint-ack-v1",
        &[id.into(), nonce.into(), manifest.into()],
    )
}
fn retained_observation(
    ctx: &ReducerContext,
    id: &str,
) -> Result<
    (
        ProtectedMailDiscoveryObservation,
        ProtectedMailDiscoveryGrant,
    ),
    String,
> {
    let observation = ctx
        .db
        .protected_mail_discovery_observation()
        .discovery_id()
        .find(id.to_owned())
        .ok_or(INCONSISTENT)?;
    let (observation, discovery) =
        discovery::checked_observation(ctx, observation).map_err(|_| INCONSISTENT)?;
    if observation.discovery_id != id {
        return Err(INCONSISTENT.into());
    }
    observation_range(&observation, &discovery).map_err(|_| INCONSISTENT)?;
    Ok((observation, discovery))
}
fn owned_observation(
    ctx: &ReducerContext,
    id: &str,
) -> Result<
    (
        ProtectedMailDiscoveryObservation,
        ProtectedMailDiscoveryGrant,
    ),
    String,
> {
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
    observation_range(&observation, &discovery)?;
    Ok((observation, discovery))
}
fn measured_sources(
    ctx: &ReducerContext,
    observation: &ProtectedMailDiscoveryObservation,
    discovery: &ProtectedMailDiscoveryGrant,
) -> Result<Vec<ProtectedMailSparseCheckpointSource>, String> {
    observation
        .input
        .present_uids
        .iter()
        .map(|uid| {
            let (id, revision, digest, bytes) = checked_stored_mail_tuple(
                ctx,
                discovery.request.connection_id,
                discovery.owner,
                &discovery.folder,
                &observation.input.uid_validity,
                *uid,
                &discovery.request.direction,
            )
            .map_err(|e| {
                if e == "protected_mail_connector_source_required" {
                    REQUIRED
                } else {
                    INCONSISTENT
                }
            })?;
            Ok(ProtectedMailSparseCheckpointSource {
                uid: *uid,
                source: ProtectedMailSourceRef {
                    id,
                    revision,
                    digest,
                },
                bytes,
            })
        })
        .collect()
}
/// This fresh-only check is deliberately absent from all retained validators.
/// A later independent trusted import must not invalidate an earlier observation.
fn require_absent_now(
    ctx: &ReducerContext,
    observation: &ProtectedMailDiscoveryObservation,
    discovery: &ProtectedMailDiscoveryGrant,
) -> Result<(), String> {
    for uid in &observation.absent_uids {
        let tuple = mailbox_tuple_event_id(
            discovery.request.connection_id,
            &discovery.folder,
            &observation.input.uid_validity,
            *uid,
        );
        if ctx
            .db
            .protected_mail_receipt()
            .mailbox_event_id()
            .find(tuple.clone())
            .is_some()
            || ctx
                .db
                .protected_mail_ingestion_disposition()
                .id()
                .find(tuple)
                .is_some()
        {
            return Err(CONFLICT.into());
        }
    }
    Ok(())
}
fn checked_grant(
    ctx: &ReducerContext,
    row: ProtectedMailSparseCheckpointGrant,
) -> Result<
    (
        ProtectedMailSparseCheckpointGrant,
        ProtectedMailDiscoveryObservation,
        ProtectedMailDiscoveryGrant,
        bool,
    ),
    String,
> {
    let (observation, discovery) = retained_observation(ctx, &row.observation_id)?;
    let canonical = manifest(&row, &observation, &discovery).map_err(|_| INCONSISTENT)?;
    let created = u64::try_from(row.created_at.to_micros_since_unix_epoch() / 1000)
        .map_err(|_| INCONSISTENT)?;
    if row.id != checkpoint_id(&row.observation_id)
        || row.request.observation_id != row.observation_id
        || row.owner != discovery.owner
        || row.workspace != ctx.identity()
        || row.workspace != discovery.workspace
        || row.connection_epoch != discovery.connection_epoch
        || row.snapshot_digest != discovery.snapshot_digest
        || row.sources
            != measured_sources(ctx, &observation, &discovery).map_err(|_| INCONSISTENT)?
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
        || row.created_at < observation.recorded_at
        || row.request.expires_at_ms <= created
        || row.request.expires_at_ms - created > TTL
    {
        return Err(INCONSISTENT.into());
    }
    let indexed = ctx
        .db
        .protected_mail_sparse_checkpoint_grant()
        .observation_id()
        .find(row.observation_id.clone())
        .ok_or(INCONSISTENT)?;
    if indexed.id != row.id {
        return Err(INCONSISTENT.into());
    }
    let events = ctx
        .db
        .protected_mail_sparse_checkpoint_grant_event()
        .checkpoint_id()
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
            ProtectedMailSparseCheckpointGrantEventKind::Issued
                if !issued
                    && event.generation == 1
                    && event.event_nonce == row.request.event_nonce
                    && event.request_digest == row.issue_digest
                    && event.created_at == row.created_at =>
            {
                issued = true
            }
            ProtectedMailSparseCheckpointGrantEventKind::Revoked
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
    Ok((row, observation, discovery, revoked))
}
fn owned(
    ctx: &ReducerContext,
    id: &str,
) -> Result<
    (
        ProtectedMailSparseCheckpointGrant,
        ProtectedMailDiscoveryObservation,
        ProtectedMailDiscoveryGrant,
        bool,
    ),
    String,
> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let row = ctx
        .db
        .protected_mail_sparse_checkpoint_grant()
        .id()
        .find(id.to_owned())
        .filter(|r| r.owner == ctx.sender())
        .ok_or(OWNER)?;
    checked_grant(ctx, row)
}
fn bound(
    ctx: &ReducerContext,
    id: &str,
) -> Result<
    (
        ProtectedMailSparseCheckpointGrant,
        ProtectedMailDiscoveryObservation,
        ProtectedMailDiscoveryGrant,
        bool,
    ),
    String,
> {
    if !hex64(id) || !service(ctx, ctx.sender(), Identity::from_byte_array([0; 32])) {
        return Err(SERVICE.into());
    }
    let row = ctx
        .db
        .protected_mail_sparse_checkpoint_grant()
        .id()
        .find(id.to_owned())
        .ok_or(SERVICE)?;
    if !service(ctx, ctx.sender(), row.owner)
        || !ctx
            .db
            .protected_mail_discovery_grant()
            .id()
            .find(row.observation_id.clone())
            .is_some_and(|d| d.request.connector_identity == ctx.sender() && d.owner == row.owner)
    {
        return Err(SERVICE.into());
    }
    checked_grant(ctx, row)
}
fn current(
    ctx: &ReducerContext,
    row: &ProtectedMailSparseCheckpointGrant,
    observation: &ProtectedMailDiscoveryObservation,
    discovery: &ProtectedMailDiscoveryGrant,
    revoked: bool,
    active: bool,
) -> Result<(), String> {
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if revoked || (active && now < row.request.not_before_ms) || now >= row.request.expires_at_ms {
        return Err(STALE.into());
    }
    discovery::require_current_completed_observation(ctx, observation, discovery)
        .map_err(|_| STALE)?;
    if measured_sources(ctx, observation, discovery)? != row.sources {
        return Err(INCONSISTENT.into());
    }
    require_absent_now(ctx, observation, discovery)
}
fn preview(
    ctx: &ReducerContext,
    request: ProtectedMailSparseCheckpointRequest,
) -> Result<ProtectedMailSparseCheckpointGrant, String> {
    let (observation, discovery) = owned_observation(ctx, &request.observation_id)?;
    valid_request(&request)?;
    discovery::require_current_completed_observation(ctx, &observation, &discovery)
        .map_err(|_| STALE)?;
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if request.expires_at_ms <= now || request.expires_at_ms - now > TTL {
        return Err(STALE.into());
    }
    if discovery
        .cursor
        .as_ref()
        .is_some_and(|c| c.generation == u64::MAX)
    {
        return Err(LIMIT.into());
    }
    let sources = measured_sources(ctx, &observation, &discovery)?;
    let acknowledged_bytes = sources_total(
        &sources,
        &observation.input.present_uids,
        request.max_acknowledged_bytes,
    )?;
    require_absent_now(ctx, &observation, &discovery)?;
    let mut row = ProtectedMailSparseCheckpointGrant {
        id: checkpoint_id(&request.observation_id),
        observation_id: request.observation_id.clone(),
        owner: discovery.owner,
        workspace: discovery.workspace,
        request,
        connection_epoch: discovery.connection_epoch,
        snapshot_digest: discovery.snapshot_digest.clone(),
        sources,
        acknowledged_bytes,
        manifest_digest: String::new(),
        manifest_bytes: 0,
        canonical: String::new(),
        issue_digest: String::new(),
        created_at: ctx.timestamp,
    };
    row.canonical = manifest(&row, &observation, &discovery)?;
    row.manifest_bytes = row.canonical.len() as u64;
    row.manifest_digest = sha(&row.canonical);
    row.issue_digest = issue_digest(
        &row.request,
        row.connection_epoch,
        &row.snapshot_digest,
        &row.manifest_digest,
    );
    Ok(row)
}
fn preview_dto(row: ProtectedMailSparseCheckpointGrant) -> ProtectedMailSparseCheckpointPreview {
    ProtectedMailSparseCheckpointPreview {
        checkpoint_id: row.id,
        connection_epoch: row.connection_epoch,
        snapshot_digest: row.snapshot_digest,
        manifest_digest: row.manifest_digest,
        manifest_bytes: row.manifest_bytes,
        canonical: row.canonical,
    }
}
#[procedure]
pub fn review_protected_mail_sparse_checkpoint(
    ctx: &mut ProcedureContext,
    request: ProtectedMailSparseCheckpointRequest,
) -> Result<ProtectedMailSparseCheckpointPreview, String> {
    ctx.try_with_tx(|tx| {
        preview(tx.as_ref(), request.clone())
            .map(preview_dto)
            .map_err(fixed_error)
    })
}
#[reducer]
pub fn issue_protected_mail_sparse_checkpoint(
    ctx: &ReducerContext,
    request: ProtectedMailSparseCheckpointRequest,
    expected_epoch: u64,
    expected_snapshot_digest: String,
    expected_manifest_digest: String,
) -> Result<(), String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let id = checkpoint_id(&request.observation_id);
    if let Some(old) = ctx
        .db
        .protected_mail_sparse_checkpoint_grant()
        .id()
        .find(id.clone())
    {
        if old.owner != ctx.sender() {
            return Err(OWNER.into());
        }
        let (old, _, _, _) = checked_grant(ctx, old)?;
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
    let event_id = owner_event_id(row.workspace, row.owner, &row.request.event_nonce);
    if ctx
        .db
        .protected_mail_sparse_checkpoint_grant_event()
        .id()
        .find(event_id.clone())
        .is_some()
    {
        return Err(CONFLICT.into());
    }
    if ctx
        .db
        .protected_mail_sparse_checkpoint_grant_event()
        .checkpoint_id()
        .filter(&id)
        .next()
        .is_some()
        || ctx
            .db
            .protected_mail_sparse_checkpoint_receipt()
            .checkpoint_id()
            .find(id.clone())
            .is_some()
        || ctx
            .db
            .protected_mail_sparse_checkpoint_cursor_history()
            .checkpoint_id()
            .find(id.clone())
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    ctx.db
        .protected_mail_sparse_checkpoint_grant_event()
        .insert(ProtectedMailSparseCheckpointGrantEvent {
            id: event_id,
            checkpoint_id: id,
            generation: 1,
            kind: ProtectedMailSparseCheckpointGrantEventKind::Issued,
            event_nonce: row.request.event_nonce.clone(),
            request_digest: row.issue_digest.clone(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    ctx.db.protected_mail_sparse_checkpoint_grant().insert(row);
    Ok(())
}
#[reducer]
pub fn revoke_protected_mail_sparse_checkpoint(
    ctx: &ReducerContext,
    checkpoint_id: String,
    event_nonce: String,
) -> Result<(), String> {
    let (grant, _, _, revoked) = owned(ctx, &checkpoint_id)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    let id = owner_event_id(grant.workspace, grant.owner, &event_nonce);
    let request_digest = revoke_digest(&checkpoint_id, &event_nonce);
    if let Some(old) = ctx
        .db
        .protected_mail_sparse_checkpoint_grant_event()
        .id()
        .find(id.clone())
    {
        return if old.checkpoint_id == checkpoint_id
            && old.kind == ProtectedMailSparseCheckpointGrantEventKind::Revoked
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
        .protected_mail_sparse_checkpoint_grant_event()
        .insert(ProtectedMailSparseCheckpointGrantEvent {
            id,
            checkpoint_id,
            generation: 2,
            kind: ProtectedMailSparseCheckpointGrantEventKind::Revoked,
            event_nonce,
            request_digest,
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    Ok(())
}
fn dispositions(
    observation: &ProtectedMailDiscoveryObservation,
    discovery: &ProtectedMailDiscoveryGrant,
    sources: &[ProtectedMailSparseCheckpointSource],
) -> Result<Vec<ProtectedMailSparseCheckpointDisposition>, String> {
    let (from, through) = observation_range(observation, discovery)?;
    let mut result = Vec::new();
    for uid in from..=through {
        if let Some(source) = sources.iter().find(|s| s.uid == uid) {
            result.push(ProtectedMailSparseCheckpointDisposition::Present(
                source.clone(),
            ));
        } else if observation.absent_uids.binary_search(&uid).is_ok() {
            result.push(ProtectedMailSparseCheckpointDisposition::ObservedAbsent(
                uid,
            ));
        } else {
            return Err(INCONSISTENT.into());
        }
    }
    Ok(result)
}
fn receipt_digest(row: &ProtectedMailSparseCheckpointReceipt) -> String {
    let mut fields = vec![
        row.checkpoint_id.clone(),
        row.event_nonce.clone(),
        row.request_digest.clone(),
        row.observation_digest.clone(),
        row.cursor_id.clone(),
        row.history_id.clone(),
        row.cursor_generation.to_string(),
        row.uid_validity.clone(),
        row.from_uid.to_string(),
        row.last_uid.to_string(),
        row.previous_digest.clone(),
        row.dispositions.len().to_string(),
    ];
    for disposition in &row.dispositions {
        match disposition {
            ProtectedMailSparseCheckpointDisposition::Present(source) => fields.extend([
                "present".into(),
                source.uid.to_string(),
                source.source.id.clone(),
                source.source.revision.to_string(),
                source.source.digest.clone(),
                source.bytes.to_string(),
            ]),
            ProtectedMailSparseCheckpointDisposition::ObservedAbsent(uid) => {
                fields.extend(["observed_absent".into(), uid.to_string()])
            }
        }
    }
    fields.extend([
        row.acknowledged_messages.to_string(),
        row.observed_absent_messages.to_string(),
        row.acknowledged_bytes.to_string(),
        row.actor.to_hex().to_string(),
        row.created_at.to_micros_since_unix_epoch().to_string(),
    ]);
    hash("pear-mail-sparse-checkpoint-receipt-v1", &fields)
}
fn history_digest(row: &ProtectedMailSparseCheckpointCursorHistory, receipt: &str) -> String {
    hash(
        "pear-mail-sparse-checkpoint-cursor-state-v1",
        &[
            row.id.clone(),
            row.cursor_id.clone(),
            row.checkpoint_id.clone(),
            row.owner.to_hex().to_string(),
            row.collection_id.to_string(),
            row.folder.clone(),
            row.uid_validity.clone(),
            row.generation.to_string(),
            row.from_uid.to_string(),
            row.last_uid.to_string(),
            row.previous_digest.clone(),
            receipt.into(),
            row.created_at.to_micros_since_unix_epoch().to_string(),
        ],
    )
}
fn dto(
    row: &ProtectedMailSparseCheckpointReceipt,
    observation_id: &str,
) -> ProtectedMailSparseCheckpointReceiptDto {
    ProtectedMailSparseCheckpointReceiptDto {
        checkpoint_id: row.checkpoint_id.clone(),
        observation_id: observation_id.into(),
        cursor_id: row.cursor_id.clone(),
        cursor_generation: row.cursor_generation,
        uid_validity: row.uid_validity.clone(),
        last_uid: row.last_uid,
        acknowledged_messages: row.acknowledged_messages,
        observed_absent_messages: row.observed_absent_messages,
        acknowledged_bytes: row.acknowledged_bytes,
        receipt_digest: row.receipt_digest.clone(),
    }
}
/// Local immutable association only: deliberately no current head/owner/time or
/// absent-tuple check. Common cursor validation checks one immediate predecessor.
fn checked_receipt_local(
    ctx: &ReducerContext,
    receipt: &ProtectedMailSparseCheckpointReceipt,
) -> Result<CursorDescriptor, String> {
    let (grant, observation, discovery, _) = checked_grant(
        ctx,
        ctx.db
            .protected_mail_sparse_checkpoint_grant()
            .id()
            .find(receipt.checkpoint_id.clone())
            .ok_or(INCONSISTENT)?,
    )?;
    let cursor = discovery.cursor.as_ref().ok_or(INCONSISTENT)?;
    let generation = cursor.generation.checked_add(1).ok_or(INCONSISTENT)?;
    let (from, through) = observation_range(&observation, &discovery).map_err(|_| INCONSISTENT)?;
    if connector::cursor_generation_exists(ctx, &cursor.id, generation)
        || super::ingestion::cursor_generation_present(ctx, &cursor.id, generation)
    {
        return Err(INCONSISTENT.into());
    }
    let history = ctx
        .db
        .protected_mail_sparse_checkpoint_cursor_history()
        .id()
        .find(history_id(&cursor.id, generation))
        .ok_or(INCONSISTENT)?;
    let indexed = ctx
        .db
        .protected_mail_sparse_checkpoint_receipt()
        .history_id()
        .find(history.id.clone())
        .ok_or(INCONSISTENT)?;
    if !hex64(&receipt.event_nonce)
        || receipt.request_digest
            != ack_request(&grant.id, &receipt.event_nonce, &grant.manifest_digest)
        || receipt.observation_digest != observation.observation_digest
        || receipt.cursor_id != cursor.id
        || receipt.history_id != history.id
        || receipt.cursor_generation != generation
        || receipt.uid_validity != observation.input.uid_validity
        || receipt.from_uid != from
        || receipt.last_uid != through
        || receipt.previous_digest != cursor.digest
        || receipt.dispositions != dispositions(&observation, &discovery, &grant.sources)?
        || receipt.acknowledged_messages != grant.sources.len() as u32
        || receipt.observed_absent_messages != observation.absent_uids.len() as u32
        || receipt.acknowledged_bytes != grant.acknowledged_bytes
        || receipt.receipt_digest != receipt_digest(receipt)
        || receipt.actor != discovery.request.connector_identity
        || receipt.created_at < grant.created_at
        || indexed.checkpoint_id != grant.id
        || history.checkpoint_id != grant.id
        || history.cursor_id != cursor.id
        || history.owner != grant.owner
        || history.collection_id != discovery.request.connection_id
        || history.folder != discovery.folder
        || history.uid_validity != receipt.uid_validity
        || history.generation != generation
        || history.from_uid != from
        || history.last_uid != through
        || history.previous_digest != cursor.digest
        || history.created_at != receipt.created_at
        || history.digest != history_digest(&history, &receipt.receipt_digest)
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
        from_uid: from,
        last_uid: through,
        digest: history.digest,
        previous_digest: history.previous_digest,
        created_at: history.created_at,
    })
}
pub(super) fn cursor_generation_present(
    ctx: &ReducerContext,
    cursor: &str,
    generation: u64,
) -> bool {
    ctx.db
        .protected_mail_sparse_checkpoint_cursor_history()
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
        .protected_mail_sparse_checkpoint_cursor_history()
        .id()
        .find(history_id(cursor, generation))
    else {
        return Ok(None);
    };
    let receipt = ctx
        .db
        .protected_mail_sparse_checkpoint_receipt()
        .checkpoint_id()
        .find(history.checkpoint_id.clone())
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
fn acknowledge(
    ctx: &ReducerContext,
    id: &str,
    nonce: &str,
) -> Result<ProtectedMailSparseCheckpointReceiptDto, String> {
    let (grant, observation, discovery, revoked) = bound(ctx, id)?;
    if let Some(receipt) = ctx
        .db
        .protected_mail_sparse_checkpoint_receipt()
        .checkpoint_id()
        .find(id.to_owned())
    {
        if receipt.event_nonce != nonce {
            return Err(CONFLICT.into());
        }
        let descriptor = checked_receipt_local(ctx, &receipt)?;
        connector::validate_cursor_predecessor(ctx, &descriptor).map_err(|_| INCONSISTENT)?;
        return Ok(dto(&receipt, &grant.observation_id));
    }
    if !hex64(nonce) {
        return Err(INVALID.into());
    }
    current(ctx, &grant, &observation, &discovery, revoked, true)?;
    let original = discovery.cursor.as_ref().ok_or(INCONSISTENT)?;
    let cursor = connector::checked_cursor(ctx, &original.id)
        .map_err(|_| INCONSISTENT)?
        .ok_or(STALE)?;
    let generation = cursor.generation.checked_add(1).ok_or(LIMIT)?;
    if connector::cursor_generation_exists(ctx, &cursor.id, generation)
        || super::ingestion::cursor_generation_present(ctx, &cursor.id, generation)
        || cursor_generation_present(ctx, &cursor.id, generation)
        || ctx
            .db
            .protected_mail_sparse_checkpoint_cursor_history()
            .checkpoint_id()
            .find(id.to_owned())
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    let (from, through) = observation_range(&observation, &discovery)?;
    let mut receipt = ProtectedMailSparseCheckpointReceipt {
        checkpoint_id: id.into(),
        event_nonce: nonce.into(),
        request_digest: ack_request(id, nonce, &grant.manifest_digest),
        observation_digest: observation.observation_digest.clone(),
        cursor_id: cursor.id.clone(),
        history_id: history_id(&cursor.id, generation),
        cursor_generation: generation,
        uid_validity: observation.input.uid_validity.clone(),
        from_uid: from,
        last_uid: through,
        previous_digest: cursor.digest.clone(),
        dispositions: dispositions(&observation, &discovery, &grant.sources)?,
        acknowledged_messages: grant.sources.len() as u32,
        observed_absent_messages: observation.absent_uids.len() as u32,
        acknowledged_bytes: grant.acknowledged_bytes,
        receipt_digest: String::new(),
        actor: ctx.sender(),
        created_at: ctx.timestamp,
    };
    receipt.receipt_digest = receipt_digest(&receipt);
    let mut history = ProtectedMailSparseCheckpointCursorHistory {
        id: receipt.history_id.clone(),
        cursor_id: cursor.id.clone(),
        checkpoint_id: id.into(),
        owner: grant.owner,
        collection_id: discovery.request.connection_id,
        folder: discovery.folder,
        uid_validity: receipt.uid_validity.clone(),
        generation,
        from_uid: from,
        last_uid: through,
        previous_digest: cursor.digest.clone(),
        digest: String::new(),
        created_at: ctx.timestamp,
    };
    history.digest = history_digest(&history, &receipt.receipt_digest);
    let next = ProtectedMailConnectorCursor {
        generation,
        last_uid: through,
        digest: history.digest.clone(),
        history_id: history.id.clone(),
        updated_at: ctx.timestamp,
        ..cursor
    };
    let result = dto(&receipt, &grant.observation_id);
    ctx.db
        .protected_mail_sparse_checkpoint_cursor_history()
        .insert(history);
    ctx.db
        .protected_mail_sparse_checkpoint_receipt()
        .insert(receipt);
    ctx.db.protected_mail_connector_cursor().id().update(next);
    Ok(result)
}
fn fixed_error(error: String) -> String {
    match error.as_str() {
        INVALID | INCONSISTENT | OWNER | SERVICE | CONFLICT | STALE | REQUIRED | LIMIT => error,
        _ => INCONSISTENT.into(),
    }
}
#[procedure]
pub fn acknowledge_protected_mail_sparse_checkpoint(
    ctx: &mut ProcedureContext,
    checkpoint_id: String,
    event_nonce: String,
) -> Result<ProtectedMailSparseCheckpointReceiptDto, String> {
    ctx.try_with_tx(|tx| {
        acknowledge(tx.as_ref(), &checkpoint_id, &event_nonce).map_err(fixed_error)
    })
}

#[cfg(test)]
mod tests {
    use super::super::discovery::{
        ProtectedMailDiscoveryCursorBinding, ProtectedMailDiscoveryNextWindow,
        ProtectedMailDiscoveryObservationInput, ProtectedMailDiscoveryRange,
        ProtectedMailDiscoveryRequest,
    };
    use super::*;
    fn fixture() -> (
        ProtectedMailSparseCheckpointGrant,
        ProtectedMailDiscoveryObservation,
        ProtectedMailDiscoveryGrant,
    ) {
        let time = Timestamp::from_micros_since_unix_epoch(1_700_000_000_000_000);
        let discovery = ProtectedMailDiscoveryGrant {
            id: "a".repeat(64),
            owner: Identity::from_byte_array([0xcc; 32]),
            workspace: Identity::from_byte_array([0xbb; 32]),
            request: ProtectedMailDiscoveryRequest {
                connection_id: 9_007_199_254_740_993,
                connector_identity: Identity::from_byte_array([0xee; 32]),
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
            snapshot_digest: "d".repeat(64),
            host: "imap.example.test".into(),
            port: 993,
            username: "fixture@example.test".into(),
            folder: "受信🍐e\u{301}\"\\\u{2028}".into(),
            cursor: Some(ProtectedMailDiscoveryCursorBinding {
                id: format!("mail-connector-cursor:{}", "1".repeat(64)),
                generation: u64::MAX,
                digest: "2".repeat(64),
                uid_validity: "7".into(),
                last_uid: 41,
            }),
            head: None,
            manifest_digest: "3".repeat(64),
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
                uid_validity: "7".into(),
                uid_next: 45,
                present_uids: vec![42, 44],
            },
            range: Some(ProtectedMailDiscoveryRange {
                from_uid: 42,
                through_uid: 44,
            }),
            absent_uids: vec![43],
            event_nonce: "8".repeat(64),
            observation_digest: "9".repeat(64),
            observation_bytes: 0,
            canonical: String::new(),
            actor: discovery.request.connector_identity,
            recorded_at: time,
        };
        let sources = vec![source(42, 123), source(44, 456)];
        let row = ProtectedMailSparseCheckpointGrant {
            id: checkpoint_id(&discovery.id),
            observation_id: discovery.id.clone(),
            owner: discovery.owner,
            workspace: discovery.workspace,
            request: ProtectedMailSparseCheckpointRequest {
                observation_id: discovery.id.clone(),
                not_before_ms: 1_700_000_000_000,
                expires_at_ms: 1_700_003_600_000,
                max_acknowledged_bytes: 1000,
                event_nonce: "f".repeat(64),
            },
            connection_epoch: discovery.connection_epoch,
            snapshot_digest: discovery.snapshot_digest.clone(),
            sources,
            acknowledged_bytes: 579,
            manifest_digest: String::new(),
            manifest_bytes: 0,
            canonical: String::new(),
            issue_digest: String::new(),
            created_at: time,
        };
        (row, observation, discovery)
    }
    fn source(uid: u32, bytes: u64) -> ProtectedMailSparseCheckpointSource {
        ProtectedMailSparseCheckpointSource {
            uid,
            source: ProtectedMailSourceRef {
                id: format!("mail-source:9007199254740993:{}", format!("{uid:064x}")),
                revision: 1,
                digest: "a".repeat(64),
            },
            bytes,
        }
    }
    fn receipt() -> ProtectedMailSparseCheckpointReceipt {
        let (grant, observation, discovery) = fixture();
        let cursor = discovery.cursor.as_ref().unwrap();
        ProtectedMailSparseCheckpointReceipt {
            checkpoint_id: grant.id,
            event_nonce: "e".repeat(64),
            request_digest: "d".repeat(64),
            observation_digest: observation.observation_digest.clone(),
            cursor_id: cursor.id.clone(),
            history_id: history_id(&cursor.id, 9),
            cursor_generation: 9,
            uid_validity: "7".into(),
            from_uid: 42,
            last_uid: 44,
            previous_digest: cursor.digest.clone(),
            dispositions: dispositions(&observation, &discovery, &grant.sources).unwrap(),
            acknowledged_messages: 2,
            observed_absent_messages: 1,
            acknowledged_bytes: 579,
            receipt_digest: String::new(),
            actor: discovery.request.connector_identity,
            created_at: grant.created_at,
        }
    }
    #[test]
    fn request_times_and_ceiling_are_bounded() {
        let (mut row, _, _) = fixture();
        assert!(valid_request(&row.request).is_ok());
        row.request.expires_at_ms = row.request.not_before_ms;
        assert_eq!(valid_request(&row.request).unwrap_err(), INVALID);
        row.request.expires_at_ms = row.request.not_before_ms + TTL + 1;
        assert_eq!(valid_request(&row.request).unwrap_err(), INVALID);
        row.request.expires_at_ms = SAFE + 1;
        assert_eq!(valid_request(&row.request).unwrap_err(), INVALID);
        row.request.expires_at_ms = row.request.not_before_ms + 1;
        row.request.max_acknowledged_bytes = MAX_BYTES + 1;
        assert_eq!(valid_request(&row.request).unwrap_err(), LIMIT);
    }
    #[test]
    fn zero_ceiling_iff_no_positive_sources() {
        assert_eq!(sources_total(&[], &[], 0).unwrap(), 0);
        assert_eq!(sources_total(&[], &[], 1).unwrap_err(), INVALID);
        assert_eq!(
            sources_total(&[source(1, 1)], &[1], 0).unwrap_err(),
            INVALID
        );
        assert_eq!(sources_total(&[source(1, 1)], &[1], 1).unwrap(), 1);
    }
    #[test]
    fn source_order_revision_digest_and_full_cost_are_exact() {
        let mut sources = vec![source(1, 7), source(3, 11)];
        assert_eq!(sources_total(&sources, &[1, 3], 18).unwrap(), 18);
        assert_eq!(sources_total(&sources, &[1, 3], 17).unwrap_err(), LIMIT);
        sources.swap(0, 1);
        assert_eq!(sources_total(&sources, &[1, 3], 18).unwrap_err(), INVALID);
        sources.swap(0, 1);
        sources[0].source.revision = 2;
        assert_eq!(sources_total(&sources, &[1, 3], 18).unwrap_err(), INVALID);
        sources[0].source.revision = 1;
        sources[0].source.digest = "A".repeat(64);
        assert_eq!(sources_total(&sources, &[1, 3], 18).unwrap_err(), INVALID);
    }
    #[test]
    fn source_bound_is_on_complete_preimages_not_just_message_bodies() {
        assert_eq!(
            sources_total(&[source(1, MAX_BYTES)], &[1], MAX_BYTES).unwrap(),
            MAX_BYTES
        );
        assert_eq!(
            sources_total(&[source(1, MAX_BYTES), source(2, 1)], &[1, 2], MAX_BYTES).unwrap_err(),
            LIMIT
        );
        assert_eq!(
            sources_total(&[source(1, 0)], &[1], 1).unwrap_err(),
            INVALID
        );
        assert_eq!(
            sources_total(&vec![source(1, 1); 9], &[1; 9], 9).unwrap_err(),
            LIMIT
        );
    }
    #[test]
    fn checkpoint_requires_nonempty_next_window_and_no_baseline() {
        let (_, mut observation, mut discovery) = fixture();
        assert_eq!(
            observation_range(&observation, &discovery).unwrap(),
            (42, 44)
        );
        observation.range = None;
        assert_eq!(
            observation_range(&observation, &discovery).unwrap_err(),
            INVALID
        );
        observation.range = Some(ProtectedMailDiscoveryRange {
            from_uid: 42,
            through_uid: 44,
        });
        discovery.request.mode = ProtectedMailDiscoveryMode::Bootstrap;
        assert_eq!(
            observation_range(&observation, &discovery).unwrap_err(),
            INVALID
        );
    }
    #[test]
    fn range_arithmetic_is_bounded_and_clipped_at_observed_horizon() {
        let (_, mut observation, mut discovery) = fixture();
        observation.range.as_mut().unwrap().through_uid = 50;
        observation.input.uid_next = 51;
        assert_eq!(
            observation_range(&observation, &discovery).unwrap_err(),
            INVALID
        );
        observation.range = Some(ProtectedMailDiscoveryRange {
            from_uid: u32::MAX - 1,
            through_uid: u32::MAX - 1,
        });
        observation.input.uid_next = u32::MAX;
        discovery.cursor.as_mut().unwrap().last_uid = u32::MAX - 2;
        assert_eq!(
            observation_range(&observation, &discovery).unwrap(),
            (u32::MAX - 1, u32::MAX - 1)
        );
        observation.range.as_mut().unwrap().through_uid = u32::MAX;
        assert_eq!(
            observation_range(&observation, &discovery).unwrap_err(),
            INVALID
        );
    }
    #[test]
    fn partition_has_exact_positive_and_observation_absent_slots() {
        let (grant, mut observation, discovery) = fixture();
        let actual = dispositions(&observation, &discovery, &grant.sources).unwrap();
        assert_eq!(
            actual,
            vec![
                ProtectedMailSparseCheckpointDisposition::Present(grant.sources[0].clone()),
                ProtectedMailSparseCheckpointDisposition::ObservedAbsent(43),
                ProtectedMailSparseCheckpointDisposition::Present(grant.sources[1].clone())
            ]
        );
        observation.absent_uids.clear();
        assert_eq!(
            dispositions(&observation, &discovery, &grant.sources).unwrap_err(),
            INCONSISTENT
        );
    }
    #[test]
    fn all_absent_nonempty_range_is_not_empty_discovery() {
        let (mut grant, mut observation, discovery) = fixture();
        observation.input.present_uids.clear();
        observation.absent_uids = vec![42, 43, 44];
        grant.sources.clear();
        grant.acknowledged_bytes = 0;
        grant.request.max_acknowledged_bytes = 0;
        assert!(manifest(&grant, &observation, &discovery).is_ok());
        assert_eq!(
            dispositions(&observation, &discovery, &[]).unwrap(),
            vec![
                ProtectedMailSparseCheckpointDisposition::ObservedAbsent(42),
                ProtectedMailSparseCheckpointDisposition::ObservedAbsent(43),
                ProtectedMailSparseCheckpointDisposition::ObservedAbsent(44)
            ]
        );
    }
    #[test]
    fn manifest_preserves_literal_unicode_and_full_u64_metadata() {
        let (grant, observation, discovery) = fixture();
        let text = manifest(&grant, &observation, &discovery).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["connection"]["epoch"], u64::MAX.to_string());
        assert_eq!(value["cursor"]["generation"], u64::MAX.to_string());
        assert_eq!(value["mailbox"]["folder"], "受信🍐e\u{301}\"\\\u{2028}");
        assert_eq!(text, canonical(&value).unwrap());
        assert_eq!(value.as_object().unwrap().len(), 16);
    }
    #[test]
    fn authority_request_commitment_binds_every_owner_field() {
        let (grant, _, _) = fixture();
        let baseline = issue_digest(&grant.request, 1, "snapshot", "manifest");
        for index in 0..5 {
            let mut request = grant.request.clone();
            match index {
                0 => request.observation_id = "b".repeat(64),
                1 => request.not_before_ms += 1,
                2 => request.expires_at_ms -= 1,
                3 => request.max_acknowledged_bytes += 1,
                _ => request.event_nonce = "b".repeat(64),
            };
            assert_ne!(issue_digest(&request, 1, "snapshot", "manifest"), baseline);
        }
        assert_ne!(
            issue_digest(&grant.request, 2, "snapshot", "manifest"),
            baseline
        );
        assert_ne!(
            issue_digest(&grant.request, 1, "snapshot2", "manifest"),
            baseline
        );
        assert_ne!(
            issue_digest(&grant.request, 1, "snapshot", "manifest2"),
            baseline
        );
    }
    #[test]
    fn event_and_checkpoint_namespaces_cannot_alias_by_nonce_or_run() {
        let id = checkpoint_id(&"a".repeat(64));
        assert_ne!(id, checkpoint_id(&"b".repeat(64)));
        let workspace = Identity::from_byte_array([1; 32]);
        let owner = Identity::from_byte_array([2; 32]);
        assert_ne!(
            owner_event_id(workspace, owner, "nonce"),
            owner_event_id(owner, workspace, "nonce")
        );
        assert_ne!(history_id("cursor", 1), history_id("cursor", 2));
        assert_ne!(
            revoke_digest(&id, "nonce"),
            ack_request(&id, "nonce", "manifest")
        );
    }
    #[test]
    fn receipt_commitment_distinguishes_absence_from_positive_and_all_metadata() {
        let mut row = receipt();
        let baseline = receipt_digest(&row);
        row.dispositions[0] = ProtectedMailSparseCheckpointDisposition::ObservedAbsent(42);
        assert_ne!(receipt_digest(&row), baseline);
        let mut row = receipt();
        row.event_nonce = "f".repeat(64);
        assert_ne!(receipt_digest(&row), baseline);
        let mut row = receipt();
        row.actor = Identity::from_byte_array([1; 32]);
        assert_ne!(receipt_digest(&row), baseline);
        let mut row = receipt();
        row.observation_digest = "b".repeat(64);
        assert_ne!(receipt_digest(&row), baseline);
        let mut row = receipt();
        row.acknowledged_bytes += 1;
        assert_ne!(receipt_digest(&row), baseline);
    }
    #[test]
    fn internal_error_details_are_never_returned() {
        assert_eq!(fixed_error("raw private error".into()), INCONSISTENT);
        for error in [
            INVALID,
            INCONSISTENT,
            OWNER,
            SERVICE,
            CONFLICT,
            STALE,
            REQUIRED,
            LIMIT,
        ] {
            assert_eq!(fixed_error(error.into()), error);
        }
    }
    fn golden() -> (
        ProtectedMailSparseCheckpointGrant,
        ProtectedMailDiscoveryObservation,
        ProtectedMailDiscoveryGrant,
    ) {
        let (mut row, mut observation, mut discovery) = fixture();
        row.workspace = Identity::from_byte_array([0xcc; 32]);
        row.owner = Identity::from_byte_array([0xdd; 32]);
        row.request.event_nonce = "b".repeat(64);
        row.snapshot_digest = "e".repeat(64);
        discovery.workspace = row.workspace;
        discovery.owner = row.owner;
        discovery.snapshot_digest = row.snapshot_digest.clone();
        discovery.request.connector_identity = Identity::from_byte_array([0xff; 32]);
        discovery.manifest_digest = "4".repeat(64);
        let cursor = discovery.cursor.as_mut().unwrap();
        cursor.uid_validity = u32::MAX.to_string();
        cursor.last_uid = u32::MAX - 4;
        observation.observation_digest = "3".repeat(64);
        observation.input.uid_validity = u32::MAX.to_string();
        observation.input.uid_next = u32::MAX;
        observation.input.present_uids = vec![u32::MAX - 3, u32::MAX - 1];
        observation.absent_uids = vec![u32::MAX - 2];
        observation.range = Some(ProtectedMailDiscoveryRange {
            from_uid: u32::MAX - 3,
            through_uid: u32::MAX - 1,
        });
        row.sources = vec![
            ProtectedMailSparseCheckpointSource {
                uid: u32::MAX - 3,
                source: ProtectedMailSourceRef {
                    id: format!("mail-source:9007199254740993:{}", "6".repeat(64)),
                    revision: 1,
                    digest: "7".repeat(64),
                },
                bytes: 512,
            },
            ProtectedMailSparseCheckpointSource {
                uid: u32::MAX - 1,
                source: ProtectedMailSourceRef {
                    id: format!("mail-source:9007199254740993:{}", "8".repeat(64)),
                    revision: 1,
                    digest: "9".repeat(64),
                },
                bytes: 777,
            },
        ];
        row.acknowledged_bytes = 1289;
        row.request.max_acknowledged_bytes = MAX_BYTES;
        (row, observation, discovery)
    }
    #[test]
    fn independent_python_and_typescript_mixed_canonical_golden() {
        let (row, observation, discovery) = golden();
        assert_eq!(
            row.id,
            "cb02833267b2d0d17f273c7f04efc48a5431674e7652de4226465aa7d4a2268e"
        );
        let text = manifest(&row, &observation, &discovery).unwrap();
        assert_eq!(text.len(), 2216);
        assert_eq!(
            sha(&text),
            "55d6b4b0cdcf92bebd13ef4cf097b39b7e0b2b940858781bd015a76a73162502"
        );
    }
    #[test]
    fn independent_python_and_typescript_all_absent_canonical_golden() {
        let (mut row, mut observation, discovery) = golden();
        row.sources.clear();
        row.acknowledged_bytes = 0;
        row.request.max_acknowledged_bytes = 0;
        observation.input.present_uids.clear();
        observation.absent_uids = vec![u32::MAX - 3, u32::MAX - 2, u32::MAX - 1];
        let text = manifest(&row, &observation, &discovery).unwrap();
        assert_eq!(text.len(), 1741);
        assert_eq!(
            sha(&text),
            "e5c8a6bbd43f1f0c75782dc1db3302719bfcdf586b1e257dc4f41a1dba01e064"
        );
    }
}
