//! Explicit owner authority for one bounded, broker-declared inference result.
//! This is private staging, not provider attestation or summary promotion.

use serde_json::json;
use sha2::{Digest, Sha256};
use spacetimedb::{
    procedure, reducer, table, Identity, ProcedureContext, ReducerContext, SpacetimeType, Table,
    Timestamp,
};

use super::admission::{canonical, hash, hex64, human, now_ms};
use super::governance::{
    current_effective_policy, resolve_source_graph, source_policy_enrolled, validate_prospective_derived_source,
    validate_source_ref, ProtectedMailProcessor, ProtectedMailSourceGeneration,
    ProtectedMailSourceRef,
};
use super::inference::{
    broker_result_context, current_result_input_bindings, owner_result_context,
    report_protected_mail_inference_outcome, result_event, result_nonce_available, result_state,
    ProtectedMailInferenceAdmission, ProtectedMailInferenceGrant, ProtectedMailInferenceOutcome,
    ProtectedMailInferenceRun, ProtectedMailInferenceStatus,
};
use super::processors::checked_revision as checked_processor_revision;
use super::provenance::{
    accepted_result_body, accepted_result_reference, insert_accepted_result_stage, verify_accepted_result_stage,
};
use crate::module_install::module_install_meta;

const INVALID: &str = "protected_mail_result_invalid_request";
const INCONSISTENT: &str = "protected_mail_result_inconsistent";
const OWNER: &str = "protected_mail_result_owner_required";
const BROKER: &str = "protected_mail_result_broker_required";
const CONFLICT: &str = "protected_mail_result_event_conflict";
const STALE: &str = "protected_mail_result_stale";
const REQUIRED: &str = "protected_mail_result_authorization_required";
const LIMIT: &str = "protected_mail_result_limit_exceeded";
const MAX_BODY: usize = 64 * 1024;
const MAX_ENVELOPE: u64 = 256 * 1024;
const MAX_TTL: u64 = 3_600_000;
const SAFE: u64 = 9_007_199_254_740_991;

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct ProtectedMailInferenceTextResult {
    pub format_version: u32,
    pub adapter: String,
    pub model: String,
    pub stop_reason: String,
    pub output_tokens: u64,
    pub body: String,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailResultAuthorizationEventKind {
    Issued,
    Revoked,
}
#[table(accessor = protected_mail_result_authorization, private)]
pub struct ProtectedMailResultAuthorization {
    #[primary_key]
    pub admission_id: String,
    #[index(btree)]
    pub owner: Identity,
    pub collection_id: u64,
    pub broker_identity: Identity,
    pub grant_id: String,
    pub grant_digest: String,
    pub admission_request_digest: String,
    pub input_payload_digest: String,
    pub operation_fingerprint: String,
    pub issue_nonce: String,
    pub expires_at_ms: u64,
    pub max_envelope_bytes: u64,
    pub request_digest: String,
    pub digest: String,
    pub created_at: Timestamp,
}
#[table(accessor = protected_mail_result_authorization_event, private)]
pub struct ProtectedMailResultAuthorizationEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub admission_id: String,
    pub generation: u64,
    pub kind: ProtectedMailResultAuthorizationEventKind,
    pub event_nonce: String,
    pub request_digest: String,
    pub authorization_digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[table(accessor = protected_mail_result_receipt, private)]
pub struct ProtectedMailResultReceipt {
    #[primary_key]
    pub admission_id: String,
    #[index(btree)]
    pub owner: Identity,
    pub collection_id: u64,
    pub broker_identity: Identity,
    pub authorization_digest: String,
    pub event_nonce: String,
    pub request_digest: String,
    pub format_version: u32,
    pub adapter: String,
    pub model: String,
    pub stop_reason: String,
    pub output_tokens: u64,
    pub source: ProtectedMailSourceRef,
    pub envelope_digest: String,
    pub envelope_bytes: u64,
    pub dispatch_event_id: String,
    pub completion_event_id: String,
    pub dispatch_source_bindings: Vec<ProtectedMailSourceGeneration>,
    pub accept_source_bindings: Vec<ProtectedMailSourceGeneration>,
    pub created_at: Timestamp,
}
#[derive(SpacetimeType)]
pub struct ProtectedMailAcceptedResult {
    pub admission_id: String,
    pub source: ProtectedMailSourceRef,
    pub envelope_digest: String,
    pub envelope_bytes: u64,
}

/// One retained accepted body for its current authenticated human owner. This
/// is not a new storage, processing, approval or summary-promotion capability.
/// Product order is the closed procedure response contract.
#[derive(SpacetimeType)]
pub struct ProtectedMailOwnerResult {
    pub format_version: u32,
    pub admission_id: String,
    pub source: ProtectedMailSourceRef,
    pub body: String,
    pub envelope_digest: String,
    pub envelope_bytes: u64,
}

/// An internal, same-transaction capability. Only this module can construct
/// it, after ticket, broker, current authority and both policy facets pass.
pub(super) struct AuthorizedResultWrite {
    admission_id: String,
    collection_id: u64,
    owner: Identity,
    broker: Identity,
    timestamp: Timestamp,
    roots: Vec<ProtectedMailSourceRef>,
    parents: Vec<ProtectedMailSourceRef>,
    processors: Vec<ProtectedMailProcessor>,
}
impl AuthorizedResultWrite {
    pub(super) fn admission_id(&self) -> &str {
        &self.admission_id
    }
    pub(super) fn collection_id(&self) -> u64 {
        self.collection_id
    }
    pub(super) fn owner(&self) -> Identity {
        self.owner
    }
    pub(super) fn roots(&self) -> &[ProtectedMailSourceRef] {
        &self.roots
    }
    pub(super) fn parents(&self) -> &[ProtectedMailSourceRef] {
        &self.parents
    }
    pub(super) fn processors(&self) -> &[ProtectedMailProcessor] {
        &self.processors
    }
    pub(super) fn matches_context(&self, ctx: &ReducerContext) -> bool {
        self.broker == ctx.sender() && self.timestamp == ctx.timestamp
    }
}

fn json_ref(reference: &ProtectedMailSourceRef) -> serde_json::Value {
    json!({"digest":reference.digest,"id":reference.id,"revision":reference.revision.to_string()})
}
fn validate_declaration(
    result: &ProtectedMailInferenceTextResult,
    model: &str,
    reserved_output: u64,
) -> Result<(), String> {
    if result.body.is_empty() || result.body.len() > MAX_BODY {
        return Err(LIMIT.into());
    }
    if result.format_version != 1
        || result.adapter != "anthropic.messages.v1"
        || result.model != model
        || result.stop_reason != "end_turn"
        || result.output_tokens == 0
        || result.output_tokens > reserved_output
        || result.output_tokens > 4096
        || result
            .body
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(INVALID.into());
    }
    Ok(())
}
fn envelope(
    id: &str,
    result: &ProtectedMailInferenceTextResult,
    parents: &[ProtectedMailSourceRef],
) -> Result<Vec<u8>, String> {
    if !hex64(id) || parents.is_empty() {
        return Err(INVALID.into());
    }
    if parents.len() > 255 {
        return Err(LIMIT.into());
    }
    for reference in parents {
        validate_source_ref(reference).map_err(|_| INVALID)?;
    }
    if parents
        .windows(2)
        .any(|pair| (&pair[0].id, pair[0].revision) >= (&pair[1].id, pair[1].revision))
    {
        return Err(INVALID.into());
    }
    let bytes=canonical(&json!({"adapter":result.adapter,"admissionId":id,"body":result.body,"formatVersion":result.format_version,
        "kind":"mail.inference.result","model":result.model,"outputTokens":result.output_tokens,"parents":parents.iter().map(json_ref).collect::<Vec<_>>(),
        "sanitizationVersion":"sentinel-result-v1","stopReason":result.stop_reason})).map_err(|_| INCONSISTENT)?.into_bytes();
    if bytes.len() as u64 > MAX_ENVELOPE {
        return Err(LIMIT.into());
    }
    Ok(bytes)
}
fn authorization_event_id(id: &str, generation: u64) -> String {
    hash(
        "pear-mail-result-authorization-event-v1",
        &[id.into(), generation.to_string()],
    )
}
fn authorization_request(row: &ProtectedMailResultAuthorization) -> String {
    hash(
        "pear-mail-result-authorization-request-v1",
        &[
            row.admission_id.clone(),
            row.owner.to_hex().to_string(),
            row.collection_id.to_string(),
            row.broker_identity.to_hex().to_string(),
            row.grant_id.clone(),
            row.grant_digest.clone(),
            row.admission_request_digest.clone(),
            row.input_payload_digest.clone(),
            row.operation_fingerprint.clone(),
            row.issue_nonce.clone(),
            row.expires_at_ms.to_string(),
            row.max_envelope_bytes.to_string(),
        ],
    )
}
fn authorization_digest(row: &ProtectedMailResultAuthorization) -> String {
    hash(
        "pear-mail-result-authorization-v1",
        &[row.request_digest.clone()],
    )
}
fn result_request(id: &str, nonce: &str, digest: &str, bytes: u64) -> String {
    hash(
        "pear-mail-result-accept-request-v1",
        &[id.into(), nonce.into(), digest.into(), bytes.to_string()],
    )
}
fn bindings_refs(bindings: &[ProtectedMailSourceGeneration]) -> Vec<ProtectedMailSourceRef> {
    bindings
        .iter()
        .map(|binding| binding.source.clone())
        .collect()
}
fn valid_authorization_window(expires: u64, now: u64, processing_expiry: u64) -> bool {
    expires <= SAFE && expires > now && expires - now <= MAX_TTL && expires <= processing_expiry
}

fn checked_authorization(
    ctx: &ReducerContext,
    grant: &ProtectedMailInferenceGrant,
    admission: &ProtectedMailInferenceAdmission,
) -> Result<ProtectedMailResultAuthorization, String> {
    let row = ctx
        .db
        .protected_mail_result_authorization()
        .admission_id()
        .find(admission.id.clone())
        .ok_or(REQUIRED)?;
    let created_ms = u64::try_from(row.created_at.to_micros_since_unix_epoch() / 1000)
        .map_err(|_| INCONSISTENT)?;
    if row.owner != admission.owner
        || row.collection_id != admission.collection_id
        || row.broker_identity != admission.broker_identity
        || row.grant_id != grant.id
        || row.grant_digest != grant.digest
        || row.admission_request_digest != admission.request_digest
        || row.input_payload_digest != admission.payload_digest
        || row.operation_fingerprint != admission.operation_fingerprint
        || !hex64(&row.issue_nonce)
        || !valid_authorization_window(row.expires_at_ms, created_ms, grant.expires_at_ms)
        || row.max_envelope_bytes == 0
        || row.max_envelope_bytes > MAX_ENVELOPE
        || row.request_digest != authorization_request(&row)
        || row.digest != authorization_digest(&row)
    {
        return Err(INCONSISTENT.into());
    }
    let issued = ctx
        .db
        .protected_mail_result_authorization_event()
        .id()
        .find(authorization_event_id(&row.admission_id, 1))
        .ok_or(INCONSISTENT)?;
    if issued.admission_id != row.admission_id
        || issued.generation != 1
        || issued.kind != ProtectedMailResultAuthorizationEventKind::Issued
        || issued.event_nonce != row.issue_nonce
        || issued.request_digest != row.request_digest
        || issued.authorization_digest != row.digest
        || issued.actor != row.owner
        || issued.created_at != row.created_at
    {
        return Err(INCONSISTENT.into());
    }
    if let Some(event) = ctx
        .db
        .protected_mail_result_authorization_event()
        .id()
        .find(authorization_event_id(&row.admission_id, 2))
    {
        if event.admission_id != row.admission_id
            || event.generation != 2
            || event.kind != ProtectedMailResultAuthorizationEventKind::Revoked
            || !hex64(&event.event_nonce)
            || event.event_nonce == row.issue_nonce
            || event.actor != row.owner
            || event.authorization_digest != row.digest
            || event.request_digest
                != hash(
                    "pear-mail-result-revoke-v1",
                    &[row.admission_id.clone(), event.event_nonce.clone()],
                )
        {
            return Err(INCONSISTENT.into());
        }
    }
    Ok(row)
}
fn owner_context(
    ctx: &ReducerContext,
    id: &str,
) -> Result<
    (
        ProtectedMailInferenceGrant,
        ProtectedMailInferenceRun,
        ProtectedMailInferenceAdmission,
    ),
    String,
> {
    owner_result_context(ctx, id).map_err(|error| {
        if error == "protected_mail_inference_owner_required" {
            OWNER.into()
        } else {
            INCONSISTENT.into()
        }
    })
}
fn broker_context(
    ctx: &ReducerContext,
    id: &str,
) -> Result<
    (
        ProtectedMailInferenceGrant,
        ProtectedMailInferenceRun,
        ProtectedMailInferenceAdmission,
    ),
    String,
> {
    broker_result_context(ctx, id).map_err(|error| {
        if error == "protected_mail_inference_broker_required" {
            BROKER.into()
        } else {
            INCONSISTENT.into()
        }
    })
}
fn allowed_ticket_state(status: &ProtectedMailInferenceStatus) -> bool {
    matches!(
        status,
        ProtectedMailInferenceStatus::Admitted | ProtectedMailInferenceStatus::Dispatching
    )
}
fn current_authority(
    ctx: &ReducerContext,
    grant: &ProtectedMailInferenceGrant,
    run: &ProtectedMailInferenceRun,
    admission: &ProtectedMailInferenceAdmission,
) -> Result<
    (
        Vec<ProtectedMailSourceGeneration>,
        Vec<ProtectedMailProcessor>,
    ),
    String,
> {
    let bindings = current_result_input_bindings(ctx, grant, run, admission).map_err(|_| STALE)?;
    let parents = bindings_refs(&admission.source_bindings);
    if bindings_refs(&bindings) != parents {
        return Err(INCONSISTENT.into());
    }
    let policy =
        current_effective_policy(ctx, admission.collection_id, &parents).map_err(|_| STALE)?;
    if !policy.allow_owner_storage {
        return Err(STALE.into());
    }
    if policy.bindings != bindings {
        return Err(INCONSISTENT.into());
    }
    Ok((bindings, policy.processors))
}

#[reducer]
pub fn issue_protected_mail_result_authorization(
    ctx: &ReducerContext,
    admission_id: String,
    event_nonce: String,
    expires_at_ms: u64,
    max_envelope_bytes: u64,
) -> Result<(), String> {
    let (grant, run, admission) = owner_context(ctx, &admission_id)?;
    if !hex64(&event_nonce)
        || expires_at_ms == 0
        || expires_at_ms > SAFE
        || max_envelope_bytes == 0
        || max_envelope_bytes > MAX_ENVELOPE
    {
        return Err(INVALID.into());
    }
    let mut row = ProtectedMailResultAuthorization {
        admission_id: admission_id.clone(),
        owner: admission.owner,
        collection_id: admission.collection_id,
        broker_identity: admission.broker_identity,
        grant_id: grant.id.clone(),
        grant_digest: grant.digest.clone(),
        admission_request_digest: admission.request_digest.clone(),
        input_payload_digest: admission.payload_digest.clone(),
        operation_fingerprint: admission.operation_fingerprint.clone(),
        issue_nonce: event_nonce.clone(),
        expires_at_ms,
        max_envelope_bytes,
        request_digest: String::new(),
        digest: String::new(),
        created_at: ctx.timestamp,
    };
    row.request_digest = authorization_request(&row);
    row.digest = authorization_digest(&row);
    if ctx
        .db
        .protected_mail_result_authorization()
        .admission_id()
        .find(admission_id.clone())
        .is_some()
    {
        let old = checked_authorization(ctx, &grant, &admission)?;
        if old.request_digest != row.request_digest {
            return Err(CONFLICT.into());
        }
        return Ok(());
    }
    if ctx
        .db
        .protected_mail_result_authorization_event()
        .id()
        .find(authorization_event_id(&admission_id, 1))
        .is_some()
        || ctx
            .db
            .protected_mail_result_authorization_event()
            .id()
            .find(authorization_event_id(&admission_id, 2))
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    let state = result_state(ctx, &admission).map_err(|_| INCONSISTENT)?;
    if !allowed_ticket_state(&state.status) {
        return Err(STALE.into());
    }
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if !valid_authorization_window(expires_at_ms, now, grant.expires_at_ms) {
        return Err(STALE.into());
    }
    current_authority(ctx, &grant, &run, &admission)?;
    validate_prospective_derived_source(
        ctx,
        admission.collection_id,
        &accepted_result_reference(admission.collection_id, &admission.id, ""),
        &bindings_refs(&admission.source_bindings),
    )
    .map_err(stage_error)?;
    ctx.db.protected_mail_result_authorization_event().insert(
        ProtectedMailResultAuthorizationEvent {
            id: authorization_event_id(&admission_id, 1),
            admission_id: admission_id.clone(),
            generation: 1,
            kind: ProtectedMailResultAuthorizationEventKind::Issued,
            event_nonce,
            request_digest: row.request_digest.clone(),
            authorization_digest: row.digest.clone(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        },
    );
    ctx.db.protected_mail_result_authorization().insert(row);
    Ok(())
}
#[reducer]
pub fn revoke_protected_mail_result_authorization(
    ctx: &ReducerContext,
    admission_id: String,
    event_nonce: String,
) -> Result<(), String> {
    let (grant, _, admission) = owner_context(ctx, &admission_id)?;
    let row = checked_authorization(ctx, &grant, &admission)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    if event_nonce == row.issue_nonce {
        return Err(CONFLICT.into());
    }
    let request = hash(
        "pear-mail-result-revoke-v1",
        &[admission_id.clone(), event_nonce.clone()],
    );
    if let Some(event) = ctx
        .db
        .protected_mail_result_authorization_event()
        .id()
        .find(authorization_event_id(&admission_id, 2))
    {
        if event.request_digest != request {
            return Err(CONFLICT.into());
        }
        return Ok(());
    }
    ctx.db.protected_mail_result_authorization_event().insert(
        ProtectedMailResultAuthorizationEvent {
            id: authorization_event_id(&admission_id, 2),
            admission_id,
            generation: 2,
            kind: ProtectedMailResultAuthorizationEventKind::Revoked,
            event_nonce,
            request_digest: request,
            authorization_digest: row.digest,
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        },
    );
    Ok(())
}

fn result_roots(admission: &ProtectedMailInferenceAdmission) -> Vec<ProtectedMailSourceRef> {
    vec![
        admission.mail_source.clone(),
        ProtectedMailSourceRef {
            id: admission.instruction.id.clone(),
            revision: admission.instruction.revision,
            digest: admission.instruction.digest.clone(),
        },
    ]
}
fn historical_result(
    ctx: &ReducerContext,
    grant: &ProtectedMailInferenceGrant,
    admission: &ProtectedMailInferenceAdmission,
    authorization: &ProtectedMailResultAuthorization,
    receipt: &ProtectedMailResultReceipt,
    nonce: &str,
    result: &ProtectedMailInferenceTextResult,
) -> Result<ProtectedMailAcceptedResult, String> {
    if receipt.event_nonce != nonce
        || receipt.format_version != result.format_version
        || receipt.adapter != result.adapter
        || receipt.model != result.model
        || receipt.stop_reason != result.stop_reason
        || receipt.output_tokens != result.output_tokens
        || receipt.source
            != accepted_result_reference(admission.collection_id, &admission.id, &result.body)
    {
        return Err(CONFLICT.into());
    }
    let model = checked_processor_revision(ctx, &grant.processor.revision_id)
        .map_err(|_| INCONSISTENT)?
        .config
        .model;
    validate_declaration(result, &model, admission.output_tokens).map_err(|_| CONFLICT)?;
    let parents = bindings_refs(&admission.source_bindings);
    let bytes = envelope(&admission.id, result, &parents).map_err(|_| CONFLICT)?;
    let digest = hex::encode(Sha256::digest(&bytes));
    if receipt.request_digest != result_request(&admission.id, nonce, &digest, bytes.len() as u64) {
        return Err(CONFLICT.into());
    }
    let dispatch = result_event(ctx, admission, 2).map_err(|_| INCONSISTENT)?;
    let completion = result_event(ctx, admission, 3).map_err(|_| INCONSISTENT)?;
    if receipt.admission_id != admission.id
        || receipt.owner != admission.owner
        || receipt.collection_id != admission.collection_id
        || receipt.broker_identity != admission.broker_identity
        || receipt.authorization_digest != authorization.digest
        || receipt.envelope_digest != digest
        || receipt.envelope_bytes != bytes.len() as u64
        || receipt.envelope_bytes > authorization.max_envelope_bytes
        || receipt.dispatch_event_id != dispatch.id
        || receipt.completion_event_id != completion.id
        || dispatch.status != ProtectedMailInferenceStatus::Dispatching
        || completion.status != ProtectedMailInferenceStatus::ResponseReceived
        || completion.event_nonce != nonce
        || completion.created_at != receipt.created_at
        || receipt.dispatch_source_bindings != dispatch.source_bindings
        || bindings_refs(&receipt.dispatch_source_bindings) != parents
        || bindings_refs(&receipt.accept_source_bindings) != parents
        || receipt
            .accept_source_bindings
            .iter()
            .any(|binding| binding.generation == 0)
    {
        return Err(INCONSISTENT.into());
    }
    let created = verify_accepted_result_stage(
        ctx,
        admission.collection_id,
        &admission.id,
        &receipt.source,
        &result.body,
        &result_roots(admission),
        &parents,
    )
    .map_err(|_| INCONSISTENT)?;
    if created != receipt.created_at
        || !source_policy_enrolled(ctx, &receipt.source).map_err(|_| INCONSISTENT)?
    {
        return Err(INCONSISTENT.into());
    }
    Ok(ProtectedMailAcceptedResult {
        admission_id: admission.id.clone(),
        source: receipt.source.clone(),
        envelope_digest: digest,
        envelope_bytes: bytes.len() as u64,
    })
}
fn stage_error(error: String) -> String {
    match error.as_str() {
        INVALID | INCONSISTENT | OWNER | BROKER | CONFLICT | STALE | REQUIRED | LIMIT => error,
        "protected_mail_source_graph_bounds" => LIMIT.into(),
        _ => INCONSISTENT.into(),
    }
}
fn accept(
    ctx: &ReducerContext,
    id: &str,
    nonce: &str,
    result: &ProtectedMailInferenceTextResult,
) -> Result<ProtectedMailAcceptedResult, String> {
    let (grant, run, admission) = broker_context(ctx, id)?;
    if let Some(receipt) = ctx
        .db
        .protected_mail_result_receipt()
        .admission_id()
        .find(id.to_owned())
    {
        let authorization =
            checked_authorization(ctx, &grant, &admission).map_err(|_| INCONSISTENT)?;
        return historical_result(
            ctx,
            &grant,
            &admission,
            &authorization,
            &receipt,
            nonce,
            result,
        );
    }
    let authorization = checked_authorization(ctx, &grant, &admission)?;
    if !hex64(nonce) {
        return Err(INVALID.into());
    }
    let state = result_state(ctx, &admission).map_err(|_| INCONSISTENT)?;
    if state.status != ProtectedMailInferenceStatus::Dispatching {
        return Err(STALE.into());
    }
    if !result_nonce_available(ctx, id, nonce) {
        return Err(CONFLICT.into());
    }
    if ctx
        .db
        .protected_mail_result_authorization_event()
        .id()
        .find(authorization_event_id(id, 2))
        .is_some()
        || now_ms(ctx).map_err(|_| INVALID)? >= authorization.expires_at_ms
    {
        return Err(STALE.into());
    }
    let (bindings, processors) = current_authority(ctx, &grant, &run, &admission)?;
    let model = checked_processor_revision(ctx, &grant.processor.revision_id)
        .map_err(|_| INCONSISTENT)?
        .config
        .model;
    validate_declaration(result, &model, admission.output_tokens)?;
    let parents = bindings_refs(&admission.source_bindings);
    let bytes = envelope(id, result, &parents)?;
    if bytes.len() as u64 > authorization.max_envelope_bytes {
        return Err(LIMIT.into());
    }
    let digest = hex::encode(Sha256::digest(&bytes));
    let dispatch = result_event(ctx, &admission, 2).map_err(|_| INCONSISTENT)?;
    if dispatch.status != ProtectedMailInferenceStatus::Dispatching
        || bindings_refs(&dispatch.source_bindings) != parents
    {
        return Err(INCONSISTENT.into());
    }
    let authority = AuthorizedResultWrite {
        admission_id: id.into(),
        collection_id: admission.collection_id,
        owner: admission.owner,
        broker: ctx.sender(),
        timestamp: ctx.timestamp,
        roots: result_roots(&admission),
        parents,
        processors,
    };
    let source =
        insert_accepted_result_stage(ctx, &authority, &result.body).map_err(stage_error)?;
    report_protected_mail_inference_outcome(
        ctx,
        id.into(),
        nonce.into(),
        ProtectedMailInferenceOutcome::ResponseReceived,
    )
    .map_err(|_| INCONSISTENT)?;
    let completion = result_event(ctx, &admission, 3).map_err(|_| INCONSISTENT)?;
    ctx.db
        .protected_mail_result_receipt()
        .insert(ProtectedMailResultReceipt {
            admission_id: id.into(),
            owner: admission.owner,
            collection_id: admission.collection_id,
            broker_identity: ctx.sender(),
            authorization_digest: authorization.digest,
            event_nonce: nonce.into(),
            request_digest: result_request(id, nonce, &digest, bytes.len() as u64),
            format_version: result.format_version,
            adapter: result.adapter.clone(),
            model: result.model.clone(),
            stop_reason: result.stop_reason.clone(),
            output_tokens: result.output_tokens,
            source: source.clone(),
            envelope_digest: digest.clone(),
            envelope_bytes: bytes.len() as u64,
            dispatch_event_id: dispatch.id,
            completion_event_id: completion.id,
            dispatch_source_bindings: dispatch.source_bindings,
            accept_source_bindings: bindings,
            created_at: ctx.timestamp,
        });
    Ok(ProtectedMailAcceptedResult {
        admission_id: id.into(),
        source,
        envelope_digest: digest,
        envelope_bytes: bytes.len() as u64,
    })
}

#[procedure]
pub fn accept_protected_mail_inference_result(
    ctx: &mut ProcedureContext,
    admission_id: String,
    event_nonce: String,
    result: ProtectedMailInferenceTextResult,
) -> Result<ProtectedMailAcceptedResult, String> {
    ctx.try_with_tx(|tx| {
        accept(tx.as_ref(), &admission_id, &event_nonce, &result).map_err(stage_error)
    })
}

fn owner_result_response(
    accepted: ProtectedMailAcceptedResult,
    body: String,
) -> Result<ProtectedMailOwnerResult, String> {
    if !hex64(&accepted.admission_id)
        || validate_source_ref(&accepted.source).is_err()
        || !accepted.source.id.starts_with("mail-derived-source:")
        || accepted.source.revision != 1
        || body.is_empty()
        || body.len() > MAX_BODY
        || body.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        || !hex64(&accepted.envelope_digest)
        || accepted.envelope_bytes == 0
        || accepted.envelope_bytes > MAX_ENVELOPE
    {
        return Err(INCONSISTENT.into());
    }
    Ok(ProtectedMailOwnerResult {
        format_version: 1,
        admission_id: accepted.admission_id,
        source: accepted.source,
        body,
        envelope_digest: accepted.envelope_digest,
        envelope_bytes: accepted.envelope_bytes,
    })
}

fn owner_read_error(error: String) -> String {
    if error == OWNER { OWNER.into() } else { INCONSISTENT.into() }
}

fn read_owner_result(
    ctx: &ReducerContext,
    id: &str,
) -> Result<ProtectedMailOwnerResult, String> {
    // Identity metadata is read before any admission, receipt or body. Missing
    // publisher metadata also fails closed, as the retained S1 owner view does.
    let eligible = ctx.db.module_install_meta().id().find(0)
        .is_some_and(|meta| meta.publisher_identity != ctx.sender())
        && human(ctx, ctx.sender());
    if !eligible || !hex64(id) {
        return Err(OWNER.into());
    }
    // This exact-owner adapter validates retained grant/run/admission and the
    // original immutable input graph without requiring live operational rights.
    let (grant, _, admission) = owner_context(ctx, id)?;
    let receipt = ctx.db.protected_mail_result_receipt().admission_id()
        .find(id.to_owned()).ok_or(OWNER)?;
    if receipt.owner != ctx.sender()
        || receipt.owner != admission.owner
        || receipt.collection_id != admission.collection_id
        || receipt.broker_identity != admission.broker_identity
    {
        return Err(INCONSISTENT.into());
    }
    let authorization = checked_authorization(ctx, &grant, &admission)
        .map_err(|_| INCONSISTENT)?;
    let body = accepted_result_body(ctx, admission.collection_id, admission.owner, id, &receipt.source)
        .map_err(|_| INCONSISTENT)?;
    let result = ProtectedMailInferenceTextResult {
        format_version: receipt.format_version,
        adapter: receipt.adapter.clone(),
        model: receipt.model.clone(),
        stop_reason: receipt.stop_reason.clone(),
        output_tokens: receipt.output_tokens,
        body,
    };
    // Reuse the completed-result checker: authorization, envelope bytes/hash,
    // dispatch/completion, accepted derivation/seal and policy-row associations.
    // It does not restore or require current processing/storage permissions.
    let accepted = historical_result(ctx, &grant, &admission, &authorization, &receipt,
        &receipt.event_nonce, &result).map_err(|_| INCONSISTENT)?;
    // Validate the complete immutable result graph, including its output node.
    // Policy revocation is deliberately separate from retained owner access.
    let actual = resolve_source_graph(ctx, admission.collection_id, std::slice::from_ref(&receipt.source))
        .map_err(|_| INCONSISTENT)?;
    let mut expected = bindings_refs(&admission.source_bindings);
    expected.push(receipt.source.clone());
    expected.sort_by(|a, b| (&a.id, a.revision).cmp(&(&b.id, b.revision)));
    if actual.into_iter().map(|source| source.reference).collect::<Vec<_>>() != expected {
        return Err(INCONSISTENT.into());
    }
    owner_result_response(accepted, result.body)
}

/// Historical private retrieval only. Later connection deletion, grant expiry,
/// revocation or ancestor-policy narrowing cannot erase an already accepted
/// owner's history. Current login, exact ownership and all retained joins are
/// still required. This read performs no repair, admission, broadcast or write.
#[procedure]
pub fn read_protected_mail_result(
    ctx: &mut ProcedureContext,
    admission_id: String,
) -> Result<ProtectedMailOwnerResult, String> {
    ctx.try_with_tx(|tx| read_owner_result(tx.as_ref(), &admission_id).map_err(owner_read_error))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn accepted_owner_response(body: &str) -> ProtectedMailAcceptedResult {
        let admission = "a".repeat(64);
        let result = ProtectedMailInferenceTextResult { body: body.into(), ..declaration() };
        let bytes = envelope(&admission, &result, &parents()).unwrap();
        ProtectedMailAcceptedResult {
            admission_id: admission.clone(),
            source: accepted_result_reference(7, &admission, body),
            envelope_digest: hex::encode(Sha256::digest(&bytes)),
            envelope_bytes: bytes.len() as u64,
        }
    }

    #[test]
    fn owner_response_keeps_literal_unicode_and_closed_bounded_product() {
        let body = " \u{feff}🍐e\u{301}\u{2028}\r\n\"\\\t ";
        let row = owner_result_response(accepted_owner_response(body), body.into()).unwrap();
        assert_eq!(row.format_version, 1);
        assert!(row.body.as_bytes() == body.as_bytes());
        let product = json!([row.format_version, row.admission_id,
            [row.source.id, row.source.revision, row.source.digest], row.body,
            row.envelope_digest, row.envelope_bytes]);
        assert_eq!(product.as_array().unwrap().len(), 6);
        // JSON doubles every body character in this worst-escape case, but
        // remains below the host's separate streamed response ceiling.
        let body = "\\".repeat(MAX_BODY);
        let row = owner_result_response(accepted_owner_response(&body), body).unwrap();
        let encoded = json!([row.format_version, row.admission_id,
            [row.source.id, row.source.revision, row.source.digest], row.body,
            row.envelope_digest, row.envelope_bytes]).to_string();
        assert!(encoded.len() < 192 * 1024);
    }

    #[test]
    fn owner_response_rejects_unbounded_or_nonliteral_payload_and_bad_metadata() {
        for body in [String::new(), "x".repeat(MAX_BODY + 1), "bad\0body".into(), "bad\u{85}body".into()] {
            assert!(owner_result_response(accepted_owner_response("valid"), body).is_err());
        }
        for mutate in [
            |row: &mut ProtectedMailAcceptedResult| row.admission_id = "not-an-id".into(),
            |row: &mut ProtectedMailAcceptedResult| row.source.revision = 2,
            |row: &mut ProtectedMailAcceptedResult| row.source.id = "mail-source:7:unrelated".into(),
            |row: &mut ProtectedMailAcceptedResult| row.envelope_digest = "not-a-digest".into(),
            |row: &mut ProtectedMailAcceptedResult| row.envelope_bytes = 0,
            |row: &mut ProtectedMailAcceptedResult| row.envelope_bytes = MAX_ENVELOPE + 1,
        ] {
            let mut row = accepted_owner_response("valid"); mutate(&mut row);
            assert!(owner_result_response(row, "valid".into()).is_err());
        }
    }

    #[test]
    fn owner_read_only_exposes_its_two_fixed_denials() {
        assert_eq!(owner_read_error(OWNER.into()), OWNER);
        for error in [BROKER, REQUIRED, CONFLICT, STALE, LIMIT, "SYNTHETIC_PRIVATE_DETAIL\nsecret"] {
            assert_eq!(owner_read_error(error.into()), INCONSISTENT);
        }
    }

    fn source(id: &str, revision: u64, c: char) -> ProtectedMailSourceRef {
        ProtectedMailSourceRef {
            id: id.into(),
            revision,
            digest: c.to_string().repeat(64),
        }
    }
    fn declaration() -> ProtectedMailInferenceTextResult {
        ProtectedMailInferenceTextResult {
            format_version: 1,
            adapter: "anthropic.messages.v1".into(),
            model: "fixture-model".into(),
            stop_reason: "end_turn".into(),
            output_tokens: 128,
            body: "\tquoted \"body\"\\\r\n".into(),
        }
    }
    fn parents() -> Vec<ProtectedMailSourceRef> {
        vec![
            source("mail-source:escaped\"\\", 2, 'c'),
            source("mail-source:escaped\"\\", 10, 'b'),
        ]
    }
    fn authorization() -> ProtectedMailResultAuthorization {
        let mut row = ProtectedMailResultAuthorization {
            admission_id: "a".repeat(64),
            owner: Identity::from_byte_array([1; 32]),
            collection_id: 7,
            broker_identity: Identity::from_byte_array([2; 32]),
            grant_id: "b".repeat(64),
            grant_digest: "c".repeat(64),
            admission_request_digest: "d".repeat(64),
            input_payload_digest: "e".repeat(64),
            operation_fingerprint: "f".repeat(64),
            issue_nonce: "1".repeat(64),
            expires_at_ms: 2000,
            max_envelope_bytes: 10000,
            request_digest: String::new(),
            digest: String::new(),
            created_at: Timestamp::from_micros_since_unix_epoch(1_000_000),
        };
        row.request_digest = authorization_request(&row);
        row.digest = authorization_digest(&row);
        row
    }
    #[test]
    fn escaped_result_envelope_matches_independent_codec_golden() {
        let result = declaration();
        validate_declaration(&result, "fixture-model", 128).unwrap();
        let bytes = envelope(&"a".repeat(64), &result, &parents()).unwrap();
        assert_eq!(bytes.len(), 569);
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            "73a46f6ec32879172ca1c2cdd2087a21c476fa069177e8752063734cbfc5b90a"
        );
        let object: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(object.as_object().unwrap().len(), 10);
        assert_eq!(object["body"], result.body);
        assert_eq!(object["parents"][0]["revision"], "2");
    }
    #[test]
    fn unicode_result_golden_preserves_exact_scalars_and_u64_precision() {
        let mut result = declaration();
        result.model = "unicode-model".into();
        result.output_tokens = 4096;
        result.body = "\t🍐\u{2028}e\u{301}\u{2029}日本語 \u{feff}\r\n\"\\".into();
        let parents = vec![
            source("e\u{301}", 10, 'a'),
            source("\u{e000}", 9_007_199_254_740_993, 'e'),
            source("𝄞", 2, 'f'),
            source("🍐", u64::MAX, 'd'),
        ];
        let bytes = envelope(&"a".repeat(64), &result, &parents).unwrap();
        assert_eq!(bytes.len(), 787);
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            "d5cc334229eb2cecdffbe453b5e7cc216bae0e7c7f1551db45ed4fca7adb7196"
        );
        assert!(String::from_utf8(bytes)
            .unwrap()
            .contains("18446744073709551615"));
    }
    #[test]
    fn declaration_requires_fixed_final_text_and_never_trims_or_refunds_usage() {
        let mut result = declaration();
        result.body = " \r\n\t\u{feff} ".into();
        assert!(validate_declaration(&result, "fixture-model", 128).is_ok());
        result.body = "".into();
        assert_eq!(
            validate_declaration(&result, "fixture-model", 128).unwrap_err(),
            LIMIT
        );
        result.body = "🍐".repeat(16384);
        assert!(validate_declaration(&result, "fixture-model", 128).is_ok());
        result.body.push('x');
        assert_eq!(
            validate_declaration(&result, "fixture-model", 128).unwrap_err(),
            LIMIT
        );
        result = declaration();
        result.output_tokens = 1;
        assert!(validate_declaration(&result, "fixture-model", 128).is_ok());
        result.output_tokens = 0;
        assert!(validate_declaration(&result, "fixture-model", 128).is_err());
        result.output_tokens = 129;
        assert!(validate_declaration(&result, "fixture-model", 128).is_err());
        result.output_tokens = 4097;
        assert!(validate_declaration(&result, "fixture-model", 4097).is_err());
    }
    #[test]
    fn incomplete_tool_or_other_model_declarations_fail_closed() {
        let mutations: Vec<Box<dyn Fn(&mut ProtectedMailInferenceTextResult)>> = vec![
            Box::new(|r| r.format_version = 2),
            Box::new(|r| r.adapter = "openai.chat-completions.v1".into()),
            Box::new(|r| r.model = "other".into()),
            Box::new(|r| r.stop_reason = "tool_use".into()),
            Box::new(|r| r.stop_reason = "max_tokens".into()),
            Box::new(|r| r.body = "\0".into()),
            Box::new(|r| r.body = "\u{85}".into()),
        ];
        for mutate in mutations {
            let mut result = declaration();
            mutate(&mut result);
            assert!(validate_declaration(&result, "fixture-model", 128).is_err());
        }
    }
    #[test]
    fn complete_envelope_binds_literal_metadata_and_every_parent() {
        let result = declaration();
        let original = envelope(&"a".repeat(64), &result, &parents()).unwrap();
        let mut changed = result.clone();
        changed.body.push(' ');
        assert_ne!(
            envelope(&"a".repeat(64), &changed, &parents()).unwrap(),
            original
        );
        changed = result.clone();
        changed.output_tokens -= 1;
        assert_ne!(
            envelope(&"a".repeat(64), &changed, &parents()).unwrap(),
            original
        );
        changed = result.clone();
        changed.model.push('x');
        assert_ne!(
            envelope(&"a".repeat(64), &changed, &parents()).unwrap(),
            original
        );
        assert_ne!(
            envelope(&"b".repeat(64), &result, &parents()).unwrap(),
            original
        );
        assert_ne!(
            envelope(&"a".repeat(64), &result, &parents()[..1]).unwrap(),
            original
        );
        let mut changed_parents = parents();
        changed_parents[0].digest = "a".repeat(64);
        assert_ne!(
            envelope(&"a".repeat(64), &result, &changed_parents).unwrap(),
            original
        );
    }
    #[test]
    fn canonical_parents_leave_room_for_the_result_wrapper() {
        let result = declaration();
        let mut reversed = parents();
        reversed.reverse();
        assert_eq!(
            envelope(&"a".repeat(64), &result, &reversed).unwrap_err(),
            INVALID
        );
        let a = parents()[0].clone();
        assert_eq!(
            envelope(&"a".repeat(64), &result, &[a.clone(), a]).unwrap_err(),
            INVALID
        );
        let sources = (0..255)
            .map(|i| source(&format!("{i:03}"), 1, 'a'))
            .collect::<Vec<_>>();
        assert!(envelope(&"a".repeat(64), &result, &sources).is_ok());
        let mut sources = sources;
        sources.push(source("zzz", 1, 'b'));
        assert_eq!(
            envelope(&"a".repeat(64), &result, &sources).unwrap_err(),
            LIMIT
        );
        assert_eq!(
            envelope(&"a".repeat(64), &result, &[]).unwrap_err(),
            INVALID
        );
    }
    #[test]
    fn hard_limit_measures_full_escaped_envelope_not_only_body() {
        let mut result = declaration();
        result.body = "\"".repeat(MAX_BODY);
        assert!(validate_declaration(&result, "fixture-model", 128).is_ok());
        let bytes = envelope(&"a".repeat(64), &result, &parents()).unwrap();
        assert!(bytes.len() > 2 * MAX_BODY);
        let sources = (0..255)
            .map(|i| source(&format!("{i:03}{}", "\\".repeat(252)), 1, 'a'))
            .collect::<Vec<_>>();
        assert_eq!(
            envelope(&"a".repeat(64), &result, &sources).unwrap_err(),
            LIMIT
        );
    }
    #[test]
    fn authorization_is_exact_frozen_owner_resource_and_limit() {
        let original = authorization_request(&authorization());
        let mutations: Vec<Box<dyn Fn(&mut ProtectedMailResultAuthorization)>> = vec![
            Box::new(|r| r.admission_id = "b".repeat(64)),
            Box::new(|r| r.owner = Identity::from_byte_array([3; 32])),
            Box::new(|r| r.collection_id += 1),
            Box::new(|r| r.broker_identity = Identity::from_byte_array([4; 32])),
            Box::new(|r| r.grant_id = "a".repeat(64)),
            Box::new(|r| r.grant_digest = "a".repeat(64)),
            Box::new(|r| r.admission_request_digest = "a".repeat(64)),
            Box::new(|r| r.input_payload_digest = "a".repeat(64)),
            Box::new(|r| r.operation_fingerprint = "a".repeat(64)),
            Box::new(|r| r.issue_nonce = "2".repeat(64)),
            Box::new(|r| r.expires_at_ms += 1),
            Box::new(|r| r.max_envelope_bytes += 1),
        ];
        for mutate in mutations {
            let mut changed = authorization();
            mutate(&mut changed);
            assert_ne!(authorization_request(&changed), original);
        }
        assert_ne!(
            authorization_event_id("a", 1),
            authorization_event_id("a", 2)
        );
    }
    #[test]
    fn ticket_cannot_outlive_processing_or_extend_its_window() {
        assert!(valid_authorization_window(2000, 1000, 2000));
        assert!(!valid_authorization_window(2001, 1000, 2000));
        assert!(!valid_authorization_window(1000, 1000, 2000));
        assert!(!valid_authorization_window(1000 + MAX_TTL + 1, 1000, SAFE));
        assert!(valid_authorization_window(1000 + MAX_TTL, 1000, SAFE));
        assert!(!valid_authorization_window(SAFE + 1, SAFE, SAFE + 1));
    }
    #[test]
    fn terminal_outcomes_never_gain_result_authority() {
        use ProtectedMailInferenceStatus::*;
        assert!(allowed_ticket_state(&Admitted));
        assert!(allowed_ticket_state(&Dispatching));
        for state in [ResponseReceived, Failed, Unknown, CancelledBeforeDispatch] {
            assert!(!allowed_ticket_state(&state));
        }
    }
    #[test]
    fn accept_request_has_its_own_exact_mode_body_and_nonce_commitment() {
        let a = result_request("a", "nonce", &"b".repeat(64), 569);
        assert_ne!(a, result_request("a", "other", &"b".repeat(64), 569));
        assert_ne!(a, result_request("a", "nonce", &"c".repeat(64), 569));
        assert_ne!(a, result_request("a", "nonce", &"b".repeat(64), 570));
        assert_ne!(
            a,
            hash(
                "pear-mail-inference-lifecycle-request-v1",
                &["a".into(), "response_received".into(), "nonce".into()]
            )
        );
    }
    #[test]
    fn fixed_result_error_mapping_never_returns_private_subsystem_text() {
        for code in [
            INVALID,
            INCONSISTENT,
            OWNER,
            BROKER,
            CONFLICT,
            STALE,
            REQUIRED,
            LIMIT,
        ] {
            assert_eq!(stage_error(code.into()), code);
        }
        assert_eq!(
            stage_error("protected_mail_source_graph_bounds".into()),
            LIMIT
        );
        assert_eq!(
            stage_error("SYNTHETIC_PRIVATE_PROVIDER_ERROR".into()),
            INCONSISTENT
        );
    }
}
