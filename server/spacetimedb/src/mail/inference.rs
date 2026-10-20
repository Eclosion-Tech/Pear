//! Fixed stateless inference admission and one-use broker payload release.
//! No provider I/O, credential lookup, result body, mailbox read or checkpoint.

use serde_json::json;
use sha2::{Digest, Sha256};
use spacetimedb::{
    procedure, reducer, table, Identity, ProcedureContext, ReducerContext, SpacetimeType, Table,
    Timestamp,
};

use super::admission::{canonical, hash, hex64, human, now_ms, opaque, service};
use super::authority::checked_current_authority;
use super::governance::{
    current_effective_policy, resolve_source_graph, validate_source_ref,
    EffectiveProtectedMailPolicy, ProtectedMailProcessor, ProtectedMailSourceGeneration,
    ProtectedMailSourceRef,
};
use super::instructions::{
    checked_approved_instruction_revision, decision_matches, protected_mail_instruction_decision,
    protected_mail_instruction_revision, resolve_instruction_source, revision_id,
    ProtectedMailInstructionDecisionKind, ProtectedMailInstructionRef,
};
use super::processors::{
    checked_head as checked_processor_head, checked_revision as checked_processor_revision,
    ProtectedMailProcessorAdapter, ProtectedMailProcessorConfig, ProtectedMailProcessorRevision,
};
use super::protected::{
    associated, protected_mail_collection, protected_mail_receipt, protected_mail_record,
    protected_mail_source, ProtectedMailDirection, ProtectedMailInput,
};

const INVALID: &str = "protected_mail_inference_invalid_request";
const INCONSISTENT: &str = "protected_mail_inference_inconsistent";
const MAX_PAYLOAD: usize = 1024 * 1024;
const MAX_OUTPUT_TOKENS: u64 = 4096;
const SAFE: u64 = 9_007_199_254_740_991;
const MAX_TTL: u64 = 3_600_000;
const OWNER: &str = "protected_mail_inference_owner_required";
const BROKER: &str = "protected_mail_inference_broker_required";
const CONFLICT: &str = "protected_mail_inference_event_conflict";
const CONSUMED: &str = "protected_mail_inference_consumed";
const STALE: &str = "protected_mail_inference_stale";
const BUDGET: &str = "protected_mail_inference_budget_exceeded";

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct ProtectedMailInferenceProcessorRef {
    pub profile_id: String,
    pub generation: u64,
    pub revision_id: String,
    pub digest: String,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailInferenceGrantEventKind {
    Issued,
    Revoked,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailInferenceStatus {
    Admitted,
    Dispatching,
    ResponseReceived,
    Failed,
    Unknown,
    CancelledBeforeDispatch,
}
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailInferenceOutcome {
    ResponseReceived,
    Failed,
    Unknown,
    CancelledBeforeDispatch,
}

#[table(accessor = protected_mail_inference_grant, private)]
pub struct ProtectedMailInferenceGrant {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub owner: Identity,
    pub collection_id: u64,
    pub broker_identity: Identity,
    pub runtime_id: String,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub instruction: ProtectedMailInstructionRef,
    pub instruction_generation: u64,
    pub decision_id: String,
    pub processor: ProtectedMailInferenceProcessorRef,
    pub allowed_mail_sources: Vec<ProtectedMailSourceRef>,
    pub not_before_ms: u64,
    pub expires_at_ms: u64,
    pub max_operations: u64,
    pub max_input_bytes: u64,
    pub max_output_tokens: u64,
    pub max_input_bytes_per_operation: u64,
    pub output_tokens_per_operation: u64,
    pub request_digest: String,
    pub digest: String,
    pub created_at: Timestamp,
}
#[table(accessor = protected_mail_inference_grant_event, private)]
pub struct ProtectedMailInferenceGrantEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub grant_id: String,
    pub generation: u64,
    pub kind: ProtectedMailInferenceGrantEventKind,
    pub event_nonce: String,
    pub request_digest: String,
    pub grant_digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}
#[table(accessor = protected_mail_inference_run, private)]
pub struct ProtectedMailInferenceRun {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub grant_id: String,
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub root_run_id: String,
    pub depth: u32,
    pub broker_identity: Identity,
    pub runtime_id: String,
    pub request_digest: String,
    pub created_at: Timestamp,
}
#[table(accessor = protected_mail_inference_budget, private)]
pub struct ProtectedMailInferenceBudget {
    #[primary_key]
    pub grant_id: String,
    pub generation: u64,
    pub remaining_operations: u64,
    pub remaining_input_bytes: u64,
    pub remaining_output_tokens: u64,
    pub last_admission_id: Option<String>,
}
#[table(accessor = protected_mail_inference_admission, private)]
pub struct ProtectedMailInferenceAdmission {
    #[primary_key]
    pub id: String,
    #[unique]
    pub event_id: String,
    #[index(btree)]
    pub grant_id: String,
    pub run_id: String,
    pub root_run_id: String,
    pub owner: Identity,
    pub broker_identity: Identity,
    pub collection_id: u64,
    pub mail_source: ProtectedMailSourceRef,
    pub instruction: ProtectedMailInstructionRef,
    pub processor: ProtectedMailInferenceProcessorRef,
    pub event_nonce: String,
    pub request_digest: String,
    pub grant_digest: String,
    pub payload_digest: String,
    pub operation_fingerprint: String,
    pub input_bytes: u64,
    pub output_tokens: u64,
    pub budget_generation: u64,
    pub remaining_operations: u64,
    pub remaining_input_bytes: u64,
    pub remaining_output_tokens: u64,
    pub source_bindings: Vec<ProtectedMailSourceGeneration>,
    pub created_at: Timestamp,
}
#[table(accessor = protected_mail_inference_state, private)]
pub struct ProtectedMailInferenceState {
    #[primary_key]
    pub admission_id: String,
    pub generation: u64,
    pub status: ProtectedMailInferenceStatus,
    pub last_event_id: String,
}
#[table(accessor = protected_mail_inference_event, private)]
pub struct ProtectedMailInferenceEvent {
    #[primary_key]
    pub id: String,
    #[unique]
    pub request_event_id: String,
    #[index(btree)]
    pub admission_id: String,
    pub generation: u64,
    pub status: ProtectedMailInferenceStatus,
    pub event_nonce: String,
    pub request_digest: String,
    pub actor: Identity,
    pub source_bindings: Vec<ProtectedMailSourceGeneration>,
    pub created_at: Timestamp,
}

#[derive(SpacetimeType)]
pub struct ProtectedMailInferenceAdmissionResult {
    pub admission_id: String,
}

/// A one-use authenticated procedure result, never a table or view. Its
/// payload is reconstructed inside the same transaction as Dispatching.
#[derive(SpacetimeType)]
pub struct ProtectedMailInferenceDispatchPayload {
    pub format_version: u32,
    pub admission_id: String,
    pub processor: ProtectedMailInferenceProcessorRef,
    pub config: ProtectedMailProcessorConfig,
    pub method: String,
    pub content_type: String,
    pub anthropic_version: String,
    pub payload: String,
    pub payload_digest: String,
    pub operation_fingerprint: String,
    pub input_bytes: u64,
    pub output_tokens: u64,
    pub expires_at_ms: u64,
}

fn text(value: &str, max: usize, multiline: bool) -> bool {
    value.len() <= max
        && !value
            .chars()
            .any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\r' | '\t')))
}

/// Exact literal subset approved for this fixed recipe. Mailbox identifiers and
/// importer notes remain source metadata and are deliberately not model input.
fn provider_payload(
    instruction: &str,
    message: &ProtectedMailInput,
    model: &str,
    output_tokens: u64,
) -> Result<Vec<u8>, String> {
    if !text(instruction,16 * 1024,true) || !text(&message.body,160_000,true)
        || !text(&message.cc,2048,false) || !text(&message.from,2048,false)
        || !text(&message.to,2048,false) || !text(&message.message_date,64,false)
        || !text(&message.subject,1024,false) || message.sanitization_version.is_empty()
        || message.sanitization_version.len() > 64
        || !message.sanitization_version.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c,b'.'|b'_'|b'-'))
        || model.is_empty() || !text(model,256,false) || model.trim() != model
        // S0 uses JavaScript trim, which additionally treats BOM as boundary
        // whitespace. Preserve literal text elsewhere, but fail this model key.
        || model.starts_with('\u{feff}') || model.ends_with('\u{feff}')
        || output_tokens == 0 || output_tokens > MAX_OUTPUT_TOKENS
    {
        return Err(INVALID.into());
    }
    let direction = match message.direction {
        ProtectedMailDirection::Received => "received",
        ProtectedMailDirection::Sent => "sent",
    };
    let inner = canonical(&json!({"body":message.body,"cc":message.cc,"direction":direction,
        "from":message.from,"messageDate":message.message_date,"sanitizationVersion":message.sanitization_version,
        "subject":message.subject,"to":message.to})).map_err(|_| INCONSISTENT)?;
    let bytes = canonical(
        &json!({"max_tokens":output_tokens,"messages":[{"content":inner,"role":"user"}],
        "model":model,"system":instruction}),
    )
    .map_err(|_| INCONSISTENT)?
    .into_bytes();
    if bytes.len() > MAX_PAYLOAD {
        return Err(INVALID.into());
    }
    Ok(bytes)
}

fn raw_mail(
    ctx: &ReducerContext,
    collection_id: u64,
    owner: Identity,
    reference: &ProtectedMailSourceRef,
) -> Result<ProtectedMailInput, String> {
    validate_source_ref(reference).map_err(|_| INVALID)?;
    let collection = ctx
        .db
        .protected_mail_collection()
        .id()
        .find(collection_id)
        .ok_or(INCONSISTENT)?;
    let source = ctx
        .db
        .protected_mail_source()
        .id()
        .find(reference.id.clone())
        .ok_or("protected_mail_inference_raw_mail_required")?;
    let id = source.id.strip_prefix("mail-source:").ok_or(INCONSISTENT)?;
    let record = ctx
        .db
        .protected_mail_record()
        .id()
        .find(id.to_owned())
        .ok_or(INCONSISTENT)?;
    let receipt = ctx
        .db
        .protected_mail_receipt()
        .id()
        .find(id.to_owned())
        .ok_or(INCONSISTENT)?;
    if collection.owner != owner
        || source.revision != reference.revision
        || source.digest != reference.digest
        || !associated(&collection, &source, &record, &receipt)
    {
        return Err(INCONSISTENT.into());
    }
    Ok(record.message)
}

#[allow(clippy::too_many_arguments)]
fn operation_fingerprint(
    workspace: Identity,
    owner: Identity,
    collection: u64,
    epoch: u64,
    runtime: &str,
    run: &str,
    parent_run: Option<&str>,
    processor: &ProtectedMailProcessor,
    input_bytes: u64,
    output_tokens: u64,
    payload_digest: &str,
) -> Result<String, String> {
    let mut scope = json!({"workspaceId":workspace.to_hex().to_string(),"principalId":owner.to_hex().to_string(),
        "runtimeId":runtime,"runId":run});
    if let Some(parent) = parent_run {
        scope["parentRunId"] = json!(parent);
    }
    let operation = json!({"kind":"model.infer","contractVersion":1,"purpose":"mail.summary","scope":scope,
        "connectionId":collection.to_string(),"epoch":epoch,"processor":{"profileId":processor.profile_id,
        "revision":processor.revision,"endpoint":processor.endpoint,"model":processor.model},
        "inputBytes":input_bytes,"outputTokens":output_tokens,"payloadDigest":payload_digest});
    Ok(hex::encode(Sha256::digest(
        canonical(&operation).map_err(|_| INCONSISTENT)?.as_bytes(),
    )))
}

fn instruction_source(reference: &ProtectedMailInstructionRef) -> ProtectedMailSourceRef {
    ProtectedMailSourceRef {
        id: reference.id.clone(),
        revision: reference.revision,
        digest: reference.digest.clone(),
    }
}
fn ref_fields(reference: &ProtectedMailSourceRef) -> Vec<String> {
    vec![
        reference.id.clone(),
        reference.revision.to_string(),
        reference.digest.clone(),
    ]
}
fn processor_fields(reference: &ProtectedMailInferenceProcessorRef) -> Vec<String> {
    vec![
        reference.profile_id.clone(),
        reference.generation.to_string(),
        reference.revision_id.clone(),
        reference.digest.clone(),
    ]
}
fn canonical_sources(
    sources: &[ProtectedMailSourceRef],
) -> Result<Vec<ProtectedMailSourceRef>, String> {
    if sources.is_empty() || sources.len() > 64 {
        return Err(INVALID.into());
    }
    let mut result = sources.to_vec();
    for reference in &result {
        validate_source_ref(reference).map_err(|_| INVALID)?;
    }
    result.sort_by(|a, b| (&a.id, a.revision).cmp(&(&b.id, b.revision)));
    if result
        .windows(2)
        .any(|p| p[0].id == p[1].id && p[0].revision == p[1].revision)
    {
        return Err(INVALID.into());
    }
    Ok(result)
}
fn grant_id(owner: Identity, collection_id: u64, nonce: &str) -> String {
    hash(
        "pear-mail-inference-grant-id-v1",
        &[
            owner.to_hex().to_string(),
            collection_id.to_string(),
            nonce.into(),
        ],
    )
}
fn grant_request(grant: &ProtectedMailInferenceGrant) -> String {
    let mut fields = vec![
        grant.id.clone(),
        grant.owner.to_hex().to_string(),
        grant.collection_id.to_string(),
        grant.connection_epoch.to_string(),
        grant.broker_identity.to_hex().to_string(),
        grant.runtime_id.clone(),
    ];
    fields.extend(ref_fields(&instruction_source(&grant.instruction)));
    fields.extend([
        grant.instruction_generation.to_string(),
        grant.decision_id.clone(),
    ]);
    fields.extend(processor_fields(&grant.processor));
    fields.push(grant.allowed_mail_sources.len().to_string());
    for reference in &grant.allowed_mail_sources {
        fields.extend(ref_fields(reference));
    }
    fields.extend([
        grant.not_before_ms.to_string(),
        grant.expires_at_ms.to_string(),
        grant.max_operations.to_string(),
        grant.max_input_bytes.to_string(),
        grant.max_output_tokens.to_string(),
        grant.max_input_bytes_per_operation.to_string(),
        grant.output_tokens_per_operation.to_string(),
    ]);
    hash("pear-mail-inference-grant-request-v1", &fields)
}
fn grant_digest(grant: &ProtectedMailInferenceGrant) -> String {
    hash(
        "pear-mail-inference-grant-v1",
        &[grant.request_digest.clone(), grant.snapshot_digest.clone()],
    )
}
fn grant_event_id(id: &str, generation: u64) -> String {
    format!("{id}:{generation}")
}
fn run_id(grant: &str, run: &str) -> String {
    hash("pear-mail-inference-run-v1", &[grant.into(), run.into()])
}
fn run_request(grant: &str, run: &str, parent: Option<&str>) -> String {
    hash(
        "pear-mail-inference-run-request-v1",
        &[
            grant.into(),
            run.into(),
            parent.is_some().to_string(),
            parent.unwrap_or("").into(),
        ],
    )
}
fn request_event(grant: &str, run: &str, nonce: &str) -> String {
    hash(
        "pear-mail-inference-request-event-v1",
        &[grant.into(), run.into(), nonce.into()],
    )
}
fn request_digest(grant: &str, run: &str, mail: &ProtectedMailSourceRef, nonce: &str) -> String {
    let mut fields = vec![grant.into(), run.into(), nonce.into()];
    fields.extend(ref_fields(mail));
    hash("pear-mail-inference-request-v1", &fields)
}
fn effect_id(
    workspace: Identity,
    grant: &ProtectedMailInferenceGrant,
    mail: &ProtectedMailSourceRef,
) -> String {
    let mut fields = vec![
        workspace.to_hex().to_string(),
        grant.collection_id.to_string(),
        "mail.summary".into(),
        "1".into(),
    ];
    fields.extend(ref_fields(mail));
    fields.extend(ref_fields(&instruction_source(&grant.instruction)));
    fields.extend(processor_fields(&grant.processor));
    hash("pear-mail-inference-effect-v1", &fields)
}
fn lifecycle_id(id: &str, generation: u64) -> String {
    hash(
        "pear-mail-inference-lifecycle-v1",
        &[id.into(), generation.to_string()],
    )
}
fn lifecycle_request(id: &str, status: &ProtectedMailInferenceStatus, nonce: &str) -> String {
    hash(
        "pear-mail-inference-lifecycle-request-v1",
        &[id.into(), status_name(status).into(), nonce.into()],
    )
}
fn lifecycle_request_id(id: &str, nonce: &str) -> String {
    hash(
        "pear-mail-inference-lifecycle-event-v1",
        &[id.into(), nonce.into()],
    )
}
fn dispatch_nonce(id: &str) -> String {
    hash("pear-mail-inference-dispatch-nonce-v1", &[id.into()])
}
fn permitted_admission_nonce(id: &str, nonce: &str) -> bool {
    nonce != dispatch_nonce(id)
}
fn status_name(status: &ProtectedMailInferenceStatus) -> &'static str {
    match status {
        ProtectedMailInferenceStatus::Admitted => "admitted",
        ProtectedMailInferenceStatus::Dispatching => "dispatching",
        ProtectedMailInferenceStatus::ResponseReceived => "response_received",
        ProtectedMailInferenceStatus::Failed => "failed",
        ProtectedMailInferenceStatus::Unknown => "unknown",
        ProtectedMailInferenceStatus::CancelledBeforeDispatch => "cancelled_before_dispatch",
    }
}
fn limits(grant: &ProtectedMailInferenceGrant) -> bool {
    grant.connection_epoch > 0
        && grant.connection_epoch <= SAFE
        && grant.instruction_generation > 0
        && grant.instruction_generation <= SAFE
        && grant.not_before_ms <= SAFE
        && grant.expires_at_ms <= SAFE
        && grant.expires_at_ms > grant.not_before_ms
        && grant.expires_at_ms - grant.not_before_ms <= MAX_TTL
        && (1..=64).contains(&grant.max_operations)
        && grant.max_input_bytes > 0
        && grant.max_input_bytes <= SAFE
        && grant.max_output_tokens > 0
        && grant.max_output_tokens <= SAFE
        && grant.max_input_bytes_per_operation > 0
        && grant.max_input_bytes_per_operation <= MAX_PAYLOAD as u64
        && grant.max_input_bytes_per_operation <= grant.max_input_bytes
        && (1..=MAX_OUTPUT_TOKENS).contains(&grant.output_tokens_per_operation)
        && grant.output_tokens_per_operation <= grant.max_output_tokens
        && opaque(&grant.processor.profile_id)
        && grant.processor.generation > 0
        && grant.processor.generation <= SAFE
        && hex64(&grant.processor.digest)
        && grant.processor.revision_id.len() <= 256
        && grant.decision_id.len() <= 256
}
fn processor(
    ctx: &ReducerContext,
    reference: &ProtectedMailInferenceProcessorRef,
    current: bool,
) -> Result<ProtectedMailProcessorRevision, String> {
    let revision = if current {
        let (head, revision) = checked_processor_head(ctx, &reference.profile_id)
            .map_err(|_| STALE)?
            .ok_or(STALE)?;
        if head.retired
            || head.generation != reference.generation
            || head.current_revision_id != reference.revision_id
        {
            return Err(STALE.into());
        }
        revision
    } else {
        checked_processor_revision(ctx, &reference.revision_id).map_err(|_| INCONSISTENT)?
    };
    if revision.id != reference.revision_id
        || revision.profile_id != reference.profile_id
        || revision.generation != reference.generation
        || revision.digest != reference.digest
    {
        return Err(STALE.into());
    }
    if revision.config.adapter != ProtectedMailProcessorAdapter::AnthropicMessagesV1 {
        return Err("protected_mail_inference_adapter_unsupported".into());
    }
    Ok(revision)
}
fn processor_tuple(revision: &ProtectedMailProcessorRevision) -> ProtectedMailProcessor {
    ProtectedMailProcessor {
        profile_id: revision.profile_id.clone(),
        revision: revision.id.clone(),
        endpoint: revision.config.endpoint.clone(),
        model: revision.config.model.clone(),
    }
}
fn instruction_literal(
    ctx: &ReducerContext,
    grant: &ProtectedMailInferenceGrant,
    current: bool,
) -> Result<String, String> {
    if current {
        return checked_approved_instruction_revision(
            ctx,
            grant.collection_id,
            &grant.instruction,
            grant.instruction_generation,
            &grant.decision_id,
        )
        .map(|revision| revision.body)
        .map_err(|_| STALE.into());
    }
    let resolved = resolve_instruction_source(ctx, &instruction_source(&grant.instruction))
        .map_err(|_| INCONSISTENT)?
        .ok_or(INCONSISTENT)?;
    if resolved.owner != grant.owner || resolved.collection_id != grant.collection_id {
        return Err(INCONSISTENT.into());
    }
    let revision = ctx
        .db
        .protected_mail_instruction_revision()
        .id()
        .find(revision_id(
            &grant.instruction.id,
            grant.instruction.revision,
        ))
        .ok_or(INCONSISTENT)?;
    let collection = ctx
        .db
        .protected_mail_collection()
        .id()
        .find(grant.collection_id)
        .ok_or(INCONSISTENT)?;
    let decision = ctx
        .db
        .protected_mail_instruction_decision()
        .id()
        .find(grant.decision_id.clone())
        .ok_or(INCONSISTENT)?;
    if decision.kind != ProtectedMailInstructionDecisionKind::Approve
        || decision.generation != grant.instruction_generation
        || !decision_matches(&decision, &collection, &revision)
    {
        return Err(INCONSISTENT.into());
    }
    Ok(revision.body)
}
struct Materialized {
    config: ProtectedMailProcessorConfig,
    processor: ProtectedMailProcessor,
    bytes: Vec<u8>,
    sources: Vec<ProtectedMailSourceRef>,
    bindings: Vec<ProtectedMailSourceGeneration>,
}
fn permits_inference(
    policy: &EffectiveProtectedMailPolicy,
    processor: &ProtectedMailProcessor,
) -> bool {
    policy.processors.contains(processor)
}
fn materialize(
    ctx: &ReducerContext,
    grant: &ProtectedMailInferenceGrant,
    mail: &ProtectedMailSourceRef,
    current: bool,
) -> Result<Materialized, String> {
    let message = raw_mail(ctx, grant.collection_id, grant.owner, mail)?;
    let instruction = instruction_literal(ctx, grant, current)?;
    let registry = processor(ctx, &grant.processor, current)?;
    let tuple = processor_tuple(&registry);
    let roots = [mail.clone(), instruction_source(&grant.instruction)];
    let sources = resolve_source_graph(ctx, grant.collection_id, &roots)
        .map_err(|_| INCONSISTENT)?
        .into_iter()
        .map(|source| source.reference)
        .collect::<Vec<_>>();
    let bindings = if current {
        let policy = current_effective_policy(ctx, grant.collection_id, &roots)
            .map_err(|_| "protected_mail_inference_processor_denied")?;
        // Processing is independent of the human-visible storage facet.
        if !permits_inference(&policy, &tuple) {
            return Err("protected_mail_inference_processor_denied".into());
        }
        if policy
            .bindings
            .iter()
            .map(|binding| binding.source.clone())
            .collect::<Vec<_>>()
            != sources
        {
            return Err(INCONSISTENT.into());
        }
        policy.bindings
    } else {
        vec![]
    };
    let bytes = provider_payload(
        &instruction,
        &message,
        &registry.config.model,
        grant.output_tokens_per_operation,
    )?;
    Ok(Materialized {
        config: registry.config,
        processor: tuple,
        bytes,
        sources,
        bindings,
    })
}
fn checked_grant(
    ctx: &ReducerContext,
    grant: ProtectedMailInferenceGrant,
) -> Result<ProtectedMailInferenceGrant, String> {
    if !hex64(&grant.id)
        || !opaque(&grant.runtime_id)
        || !limits(&grant)
        || !hex64(&grant.snapshot_digest)
        || canonical_sources(&grant.allowed_mail_sources)? != grant.allowed_mail_sources
        || validate_source_ref(&instruction_source(&grant.instruction)).is_err()
        || grant.request_digest != grant_request(&grant)
        || grant.digest != grant_digest(&grant)
    {
        return Err(INCONSISTENT.into());
    }
    let issued = ctx
        .db
        .protected_mail_inference_grant_event()
        .id()
        .find(grant_event_id(&grant.id, 1))
        .ok_or(INCONSISTENT)?;
    if issued.grant_id != grant.id
        || issued.generation != 1
        || issued.kind != ProtectedMailInferenceGrantEventKind::Issued
        || !hex64(&issued.event_nonce)
        || grant.id != grant_id(grant.owner, grant.collection_id, &issued.event_nonce)
        || issued.request_digest != grant.request_digest
        || issued.grant_digest != grant.digest
        || issued.actor != grant.owner
        || issued.created_at != grant.created_at
    {
        return Err(INCONSISTENT.into());
    }
    if let Some(event) = ctx
        .db
        .protected_mail_inference_grant_event()
        .id()
        .find(grant_event_id(&grant.id, 2))
    {
        if event.grant_id != grant.id
            || event.generation != 2
            || event.kind != ProtectedMailInferenceGrantEventKind::Revoked
            || event.actor != grant.owner
            || event.grant_digest != grant.digest
            || !hex64(&event.event_nonce)
            || event.event_nonce == issued.event_nonce
            || event.request_digest
                != hash(
                    "pear-mail-inference-revoke-v1",
                    &[grant.id.clone(), event.event_nonce.clone()],
                )
        {
            return Err(INCONSISTENT.into());
        }
    }
    Ok(grant)
}
fn owned_grant(ctx: &ReducerContext, id: &str) -> Result<ProtectedMailInferenceGrant, String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let grant = ctx
        .db
        .protected_mail_inference_grant()
        .id()
        .find(id.to_owned())
        .filter(|g| g.owner == ctx.sender())
        .ok_or(OWNER)?;
    checked_grant(ctx, grant)
}
fn broker_grant(ctx: &ReducerContext, id: &str) -> Result<ProtectedMailInferenceGrant, String> {
    let grant = ctx
        .db
        .protected_mail_inference_grant()
        .id()
        .find(id.to_owned())
        .filter(|g| g.broker_identity == ctx.sender() && service(ctx, ctx.sender(), g.owner))
        .ok_or(BROKER)?;
    checked_grant(ctx, grant)
}
fn active(ctx: &ReducerContext, grant: &ProtectedMailInferenceGrant) -> Result<(), String> {
    if ctx
        .db
        .protected_mail_inference_grant_event()
        .id()
        .find(grant_event_id(&grant.id, 2))
        .is_some()
    {
        return Err("protected_mail_inference_grant_revoked".into());
    }
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if now < grant.not_before_ms || now >= grant.expires_at_ms {
        return Err("protected_mail_inference_grant_not_active".into());
    }
    if !human(ctx, grant.owner) || !service(ctx, grant.broker_identity, grant.owner) {
        return Err(BROKER.into());
    }
    let authority = checked_current_authority(ctx, grant.collection_id).map_err(|_| STALE)?;
    if authority.owner != grant.owner
        || authority.collection_id != grant.collection_id
        || authority.epoch != grant.connection_epoch
        || authority.snapshot_digest != grant.snapshot_digest
    {
        return Err(STALE.into());
    }
    checked_approved_instruction_revision(
        ctx,
        grant.collection_id,
        &grant.instruction,
        grant.instruction_generation,
        &grant.decision_id,
    )
    .map_err(|_| STALE)?;
    processor(ctx, &grant.processor, true)?;
    Ok(())
}

fn checked_run(
    ctx: &ReducerContext,
    grant: &ProtectedMailInferenceGrant,
    label: &str,
) -> Result<ProtectedMailInferenceRun, String> {
    let run = ctx
        .db
        .protected_mail_inference_run()
        .id()
        .find(run_id(&grant.id, label))
        .ok_or("protected_mail_inference_run_required")?;
    let mut current = run.run_id.clone();
    let mut depth = run.depth;
    for _ in 0..16 {
        let row = ctx
            .db
            .protected_mail_inference_run()
            .id()
            .find(run_id(&grant.id, &current))
            .ok_or(INCONSISTENT)?;
        if row.id != run_id(&grant.id, &row.run_id)
            || row.grant_id != grant.id
            || !opaque(&row.run_id)
            || row.depth == 0
            || row.depth > 16
            || row.depth != depth
            || row.root_run_id != run.root_run_id
            || row.broker_identity != grant.broker_identity
            || row.runtime_id != grant.runtime_id
            || row.request_digest
                != run_request(&grant.id, &row.run_id, row.parent_run_id.as_deref())
        {
            return Err(INCONSISTENT.into());
        }
        if let Some(parent) = &row.parent_run_id {
            current = parent.clone();
            depth = row.depth.checked_sub(1).ok_or(INCONSISTENT)?;
        } else {
            if row.depth != 1 || row.root_run_id != row.run_id {
                return Err(INCONSISTENT.into());
            }
            return Ok(run);
        }
    }
    Err(INCONSISTENT.into())
}
fn budget_shape(
    grant: &ProtectedMailInferenceGrant,
    budget: &ProtectedMailInferenceBudget,
) -> bool {
    let used = grant
        .max_operations
        .checked_sub(budget.remaining_operations);
    budget.generation > 0
        && used.and_then(|used| used.checked_add(1)) == Some(budget.generation)
        && budget.remaining_input_bytes <= grant.max_input_bytes
        && used
            .and_then(|used| used.checked_mul(grant.output_tokens_per_operation))
            .and_then(|tokens| grant.max_output_tokens.checked_sub(tokens))
            == Some(budget.remaining_output_tokens)
}
fn checked_budget(
    ctx: &ReducerContext,
    grant: &ProtectedMailInferenceGrant,
) -> Result<ProtectedMailInferenceBudget, String> {
    let budget = ctx
        .db
        .protected_mail_inference_budget()
        .grant_id()
        .find(grant.id.clone())
        .ok_or(INCONSISTENT)?;
    if !budget_shape(grant, &budget) {
        return Err(INCONSISTENT.into());
    }
    match &budget.last_admission_id {
        None if budget.generation == 1 && budget.remaining_input_bytes == grant.max_input_bytes => {
        }
        Some(id) => {
            let row = ctx
                .db
                .protected_mail_inference_admission()
                .id()
                .find(id.clone())
                .ok_or(INCONSISTENT)?;
            if row.grant_id != grant.id
                || row.budget_generation != budget.generation
                || row.remaining_operations != budget.remaining_operations
                || row.remaining_input_bytes != budget.remaining_input_bytes
                || row.remaining_output_tokens != budget.remaining_output_tokens
            {
                return Err(INCONSISTENT.into());
            }
        }
        _ => return Err(INCONSISTENT.into()),
    }
    Ok(budget)
}
fn reserve(
    budget: &ProtectedMailInferenceBudget,
    bytes: u64,
    output_tokens: u64,
    per_operation: u64,
) -> Result<(u64, u64, u64, u64), String> {
    if bytes == 0
        || bytes > per_operation
        || budget.remaining_operations == 0
        || bytes > budget.remaining_input_bytes
        || output_tokens == 0
        || output_tokens > budget.remaining_output_tokens
    {
        return Err(BUDGET.into());
    }
    Ok((
        budget
            .generation
            .checked_add(1)
            .filter(|generation| *generation <= 65)
            .ok_or(INCONSISTENT)?,
        budget.remaining_operations - 1,
        budget.remaining_input_bytes - bytes,
        budget.remaining_output_tokens - output_tokens,
    ))
}

#[reducer]
#[allow(clippy::too_many_arguments)]
pub fn issue_protected_mail_inference_grant(
    ctx: &ReducerContext,
    grant_nonce: String,
    connection_id: u64,
    expected_epoch: u64,
    broker_identity: Identity,
    runtime_id: String,
    instruction: ProtectedMailInstructionRef,
    expected_instruction_generation: u64,
    decision_id: String,
    processor: ProtectedMailInferenceProcessorRef,
    allowed_mail_sources: Vec<ProtectedMailSourceRef>,
    not_before_ms: u64,
    expires_at_ms: u64,
    max_operations: u64,
    max_input_bytes: u64,
    max_output_tokens: u64,
    max_input_bytes_per_operation: u64,
    output_tokens_per_operation: u64,
) -> Result<(), String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let collection = ctx
        .db
        .protected_mail_collection()
        .id()
        .find(connection_id)
        .filter(|c| c.owner == ctx.sender())
        .ok_or(OWNER)?;
    if !hex64(&grant_nonce) || !opaque(&runtime_id) {
        return Err(INVALID.into());
    }
    let grant_id = self::grant_id(ctx.sender(), connection_id, &grant_nonce);
    let mut grant = ProtectedMailInferenceGrant {
        id: grant_id.clone(),
        owner: collection.owner,
        collection_id: connection_id,
        broker_identity,
        runtime_id,
        connection_epoch: expected_epoch,
        snapshot_digest: String::new(),
        instruction,
        instruction_generation: expected_instruction_generation,
        decision_id,
        processor,
        allowed_mail_sources: canonical_sources(&allowed_mail_sources)?,
        not_before_ms,
        expires_at_ms,
        max_operations,
        max_input_bytes,
        max_output_tokens,
        max_input_bytes_per_operation,
        output_tokens_per_operation,
        request_digest: String::new(),
        digest: String::new(),
        created_at: ctx.timestamp,
    };
    if !limits(&grant) || validate_source_ref(&instruction_source(&grant.instruction)).is_err() {
        return Err(INVALID.into());
    }
    grant.request_digest = grant_request(&grant);
    if let Some(existing) = ctx
        .db
        .protected_mail_inference_grant()
        .id()
        .find(grant_id.clone())
    {
        if existing.owner != ctx.sender() {
            return Err(OWNER.into());
        }
        let existing = checked_grant(ctx, existing)?;
        checked_budget(ctx, &existing)?;
        if existing.request_digest != grant.request_digest {
            return Err(CONFLICT.into());
        }
        return Ok(());
    }
    if ctx
        .db
        .protected_mail_inference_grant_event()
        .id()
        .find(grant_event_id(&grant_id, 1))
        .is_some()
        || ctx
            .db
            .protected_mail_inference_grant_event()
            .id()
            .find(grant_event_id(&grant_id, 2))
            .is_some()
        || ctx
            .db
            .protected_mail_inference_budget()
            .grant_id()
            .find(grant_id.clone())
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    if !service(ctx, broker_identity, collection.owner) {
        return Err(BROKER.into());
    }
    let now = now_ms(ctx).map_err(|_| INVALID)?;
    if expires_at_ms <= now || expires_at_ms - now > MAX_TTL {
        return Err("protected_mail_inference_grant_not_active".into());
    }
    let authority = checked_current_authority(ctx, connection_id).map_err(|_| STALE)?;
    if authority.owner != grant.owner || authority.epoch != expected_epoch {
        return Err(STALE.into());
    }
    grant.snapshot_digest = authority.snapshot_digest;
    for mail in &grant.allowed_mail_sources {
        let data = materialize(ctx, &grant, mail, true)?;
        if data.bytes.len() as u64 > max_input_bytes_per_operation {
            return Err(BUDGET.into());
        }
    }
    let mut roots = grant.allowed_mail_sources.clone();
    roots.push(instruction_source(&grant.instruction));
    resolve_source_graph(ctx, connection_id, &roots).map_err(|_| INVALID)?;
    grant.digest = grant_digest(&grant);
    ctx.db
        .protected_mail_inference_grant_event()
        .insert(ProtectedMailInferenceGrantEvent {
            id: grant_event_id(&grant_id, 1),
            grant_id: grant_id.clone(),
            generation: 1,
            kind: ProtectedMailInferenceGrantEventKind::Issued,
            event_nonce: grant_nonce,
            request_digest: grant.request_digest.clone(),
            grant_digest: grant.digest.clone(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    ctx.db
        .protected_mail_inference_budget()
        .insert(ProtectedMailInferenceBudget {
            grant_id,
            generation: 1,
            remaining_operations: max_operations,
            remaining_input_bytes: max_input_bytes,
            remaining_output_tokens: max_output_tokens,
            last_admission_id: None,
        });
    ctx.db.protected_mail_inference_grant().insert(grant);
    Ok(())
}

#[reducer]
pub fn revoke_protected_mail_inference_grant(
    ctx: &ReducerContext,
    grant_id: String,
    event_nonce: String,
) -> Result<(), String> {
    let grant = owned_grant(ctx, &grant_id)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    let issued = ctx
        .db
        .protected_mail_inference_grant_event()
        .id()
        .find(grant_event_id(&grant_id, 1))
        .ok_or(INCONSISTENT)?;
    if event_nonce == issued.event_nonce {
        return Err(CONFLICT.into());
    }
    let request = hash(
        "pear-mail-inference-revoke-v1",
        &[grant_id.clone(), event_nonce.clone()],
    );
    if let Some(existing) = ctx
        .db
        .protected_mail_inference_grant_event()
        .id()
        .find(grant_event_id(&grant_id, 2))
    {
        if existing.request_digest != request {
            return Err(CONFLICT.into());
        }
        return Ok(());
    }
    ctx.db
        .protected_mail_inference_grant_event()
        .insert(ProtectedMailInferenceGrantEvent {
            id: grant_event_id(&grant_id, 2),
            grant_id,
            generation: 2,
            kind: ProtectedMailInferenceGrantEventKind::Revoked,
            event_nonce,
            request_digest: request,
            grant_digest: grant.digest,
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    Ok(())
}

#[reducer]
pub fn start_protected_mail_inference_run(
    ctx: &ReducerContext,
    grant_id: String,
    run_id: String,
    parent_run_id: Option<String>,
) -> Result<(), String> {
    let grant = broker_grant(ctx, &grant_id)?;
    if !opaque(&run_id) || parent_run_id.as_ref().is_some_and(|parent| !opaque(parent)) {
        return Err(INVALID.into());
    }
    let id = self::run_id(&grant_id, &run_id);
    let request = run_request(&grant_id, &run_id, parent_run_id.as_deref());
    if ctx
        .db
        .protected_mail_inference_run()
        .id()
        .find(id.clone())
        .is_some()
    {
        let existing = checked_run(ctx, &grant, &run_id)?;
        if existing.request_digest != request {
            return Err(CONFLICT.into());
        }
        return Ok(());
    }
    active(ctx, &grant)?;
    if ctx
        .db
        .protected_mail_inference_run()
        .grant_id()
        .filter(&grant_id)
        .count()
        >= 256
    {
        return Err("protected_mail_inference_run_limit".into());
    }
    let (depth, root_run_id) = if let Some(parent) = &parent_run_id {
        let parent = checked_run(ctx, &grant, parent)?;
        (
            parent.depth.checked_add(1).ok_or(INVALID)?,
            parent.root_run_id,
        )
    } else {
        (1, run_id.clone())
    };
    if depth > 16 {
        return Err("protected_mail_inference_run_limit".into());
    }
    ctx.db
        .protected_mail_inference_run()
        .insert(ProtectedMailInferenceRun {
            id,
            grant_id,
            run_id,
            parent_run_id,
            root_run_id,
            depth,
            broker_identity: ctx.sender(),
            runtime_id: grant.runtime_id,
            request_digest: request,
            created_at: ctx.timestamp,
        });
    Ok(())
}

fn bindings_match(
    bindings: &[ProtectedMailSourceGeneration],
    sources: &[ProtectedMailSourceRef],
) -> bool {
    bindings
        .iter()
        .map(|binding| binding.source.clone())
        .collect::<Vec<_>>()
        == sources
        && bindings.iter().all(|binding| binding.generation > 0)
}
/// The dedicated broker driver accepts only this closed public error set.
/// Subsystem/current-policy diagnostics never become an arbitrary response.
fn procedure_error(error: String) -> String {
    match error.as_str() {
        INVALID | INCONSISTENT | OWNER | BROKER | CONFLICT | CONSUMED | STALE | BUDGET => error,
        "protected_mail_inference_grant_revoked"
        | "protected_mail_inference_grant_not_active"
        | "protected_mail_inference_processor_denied" => STALE.into(),
        "protected_mail_inference_raw_mail_required"
        | "protected_mail_inference_adapter_unsupported"
        | "protected_mail_inference_run_required"
        | "protected_mail_inference_mail_not_allowed" => INVALID.into(),
        _ => INCONSISTENT.into(),
    }
}
fn checked_event(
    ctx: &ReducerContext,
    admission: &ProtectedMailInferenceAdmission,
    generation: u64,
) -> Result<ProtectedMailInferenceEvent, String> {
    let event = ctx
        .db
        .protected_mail_inference_event()
        .id()
        .find(lifecycle_id(&admission.id, generation))
        .ok_or(INCONSISTENT)?;
    if event.admission_id != admission.id
        || event.generation != generation
        || event.actor != admission.broker_identity
        || !hex64(&event.event_nonce)
        || event.request_event_id != lifecycle_request_id(&admission.id, &event.event_nonce)
        || event.request_digest
            != lifecycle_request(&admission.id, &event.status, &event.event_nonce)
    {
        return Err(INCONSISTENT.into());
    }
    Ok(event)
}
fn checked_state(
    ctx: &ReducerContext,
    admission: &ProtectedMailInferenceAdmission,
) -> Result<ProtectedMailInferenceState, String> {
    let state = ctx
        .db
        .protected_mail_inference_state()
        .admission_id()
        .find(admission.id.clone())
        .ok_or(INCONSISTENT)?;
    let initial = checked_event(ctx, admission, 1)?;
    if initial.status != ProtectedMailInferenceStatus::Admitted
        || initial.event_nonce != admission.event_nonce
        || initial.source_bindings != admission.source_bindings
        || initial.created_at != admission.created_at
    {
        return Err(INCONSISTENT.into());
    }
    let latest = checked_event(ctx, admission, state.generation)?;
    if state.last_event_id != latest.id || state.status != latest.status {
        return Err(INCONSISTENT.into());
    }
    let sources = admission
        .source_bindings
        .iter()
        .map(|binding| binding.source.clone())
        .collect::<Vec<_>>();
    match state.status {
        ProtectedMailInferenceStatus::Admitted if state.generation == 1 => {}
        ProtectedMailInferenceStatus::Dispatching if state.generation == 2 => {
            if latest.event_nonce != dispatch_nonce(&admission.id)
                || !bindings_match(&latest.source_bindings, &sources)
            {
                return Err(INCONSISTENT.into());
            }
        }
        ProtectedMailInferenceStatus::CancelledBeforeDispatch if state.generation == 2 => {
            if !latest.source_bindings.is_empty() {
                return Err(INCONSISTENT.into());
            }
        }
        ProtectedMailInferenceStatus::ResponseReceived
        | ProtectedMailInferenceStatus::Failed
        | ProtectedMailInferenceStatus::Unknown
            if state.generation == 3 =>
        {
            let dispatch = checked_event(ctx, admission, 2)?;
            if dispatch.status != ProtectedMailInferenceStatus::Dispatching
                || dispatch.event_nonce != dispatch_nonce(&admission.id)
                || !bindings_match(&dispatch.source_bindings, &sources)
                || !latest.source_bindings.is_empty()
            {
                return Err(INCONSISTENT.into());
            }
        }
        _ => return Err(INCONSISTENT.into()),
    }
    Ok(state)
}
fn admission_matches(
    ctx: &ReducerContext,
    grant: &ProtectedMailInferenceGrant,
    run: &ProtectedMailInferenceRun,
    admission: &ProtectedMailInferenceAdmission,
) -> Result<(), String> {
    if admission.grant_id != grant.id
        || admission.run_id != run.run_id
        || admission.root_run_id != run.root_run_id
        || admission.owner != grant.owner
        || admission.broker_identity != grant.broker_identity
        || admission.collection_id != grant.collection_id
        || admission.instruction != grant.instruction
        || admission.processor != grant.processor
        || admission.grant_digest != grant.digest
        || !grant.allowed_mail_sources.contains(&admission.mail_source)
        || !hex64(&admission.event_nonce)
        || admission.event_id != request_event(&grant.id, &run.run_id, &admission.event_nonce)
        || admission.request_digest
            != request_digest(
                &grant.id,
                &run.run_id,
                &admission.mail_source,
                &admission.event_nonce,
            )
        || admission.id != effect_id(ctx.identity(), grant, &admission.mail_source)
    {
        return Err(INCONSISTENT.into());
    }
    let data = materialize(ctx, grant, &admission.mail_source, false)?;
    let digest = hex::encode(Sha256::digest(&data.bytes));
    let budget = checked_budget(ctx, grant)?;
    if admission.input_bytes != data.bytes.len() as u64
        || admission.payload_digest != digest
        || admission.output_tokens != grant.output_tokens_per_operation
        || admission.input_bytes > grant.max_input_bytes_per_operation
        || !bindings_match(&admission.source_bindings, &data.sources)
        || admission.operation_fingerprint
            != operation_fingerprint(
                ctx.identity(),
                grant.owner,
                grant.collection_id,
                grant.connection_epoch,
                &grant.runtime_id,
                &run.run_id,
                run.parent_run_id.as_deref(),
                &data.processor,
                admission.input_bytes,
                admission.output_tokens,
                &digest,
            )?
        || admission.budget_generation < 2
        || admission.budget_generation > budget.generation
        || admission.remaining_operations > grant.max_operations
        || grant.max_operations - admission.remaining_operations + 1 != admission.budget_generation
        || admission.remaining_input_bytes > grant.max_input_bytes
        || admission.remaining_input_bytes < budget.remaining_input_bytes
        || (admission.budget_generation - 1)
            .checked_mul(grant.output_tokens_per_operation)
            .and_then(|used| grant.max_output_tokens.checked_sub(used))
            != Some(admission.remaining_output_tokens)
        || admission.remaining_output_tokens < budget.remaining_output_tokens
    {
        return Err(INCONSISTENT.into());
    }
    checked_state(ctx, admission)?;
    Ok(())
}
fn bound_admission(
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
    // Normalize missing/foreign/malformed resources before private diagnostics.
    let admission = ctx
        .db
        .protected_mail_inference_admission()
        .id()
        .find(id.to_owned())
        .filter(|row| row.broker_identity == ctx.sender() && service(ctx, ctx.sender(), row.owner))
        .ok_or(BROKER)?;
    let grant = broker_grant(ctx, &admission.grant_id)?;
    let run = checked_run(ctx, &grant, &admission.run_id)?;
    admission_matches(ctx, &grant, &run, &admission)?;
    Ok((grant, run, admission))
}
fn insert_event(
    ctx: &ReducerContext,
    admission_id: &str,
    generation: u64,
    status: ProtectedMailInferenceStatus,
    nonce: &str,
    bindings: Vec<ProtectedMailSourceGeneration>,
) -> String {
    let id = lifecycle_id(admission_id, generation);
    ctx.db
        .protected_mail_inference_event()
        .insert(ProtectedMailInferenceEvent {
            id: id.clone(),
            request_event_id: lifecycle_request_id(admission_id, nonce),
            admission_id: admission_id.into(),
            generation,
            request_digest: lifecycle_request(admission_id, &status, nonce),
            status,
            event_nonce: nonce.into(),
            actor: ctx.sender(),
            source_bindings: bindings,
            created_at: ctx.timestamp,
        });
    id
}

fn admit(
    ctx: &ReducerContext,
    grant_id: &str,
    run_label: &str,
    mail: &ProtectedMailSourceRef,
    nonce: &str,
) -> Result<ProtectedMailInferenceAdmissionResult, String> {
    let grant = broker_grant(ctx, grant_id)?;
    let run = checked_run(ctx, &grant, run_label)?;
    if !hex64(nonce) || validate_source_ref(mail).is_err() {
        return Err(INVALID.into());
    }
    let event = request_event(grant_id, run_label, nonce);
    if let Some(existing) = ctx
        .db
        .protected_mail_inference_admission()
        .event_id()
        .find(event.clone())
    {
        if existing.request_digest != request_digest(grant_id, run_label, mail, nonce) {
            return Err(CONFLICT.into());
        }
        admission_matches(ctx, &grant, &run, &existing)?;
        return Ok(ProtectedMailInferenceAdmissionResult {
            admission_id: existing.id,
        });
    }
    if !grant.allowed_mail_sources.contains(mail) {
        return Err("protected_mail_inference_mail_not_allowed".into());
    }
    active(ctx, &grant)?;
    let id = effect_id(ctx.identity(), &grant, mail);
    // The host reserves this lifecycle event key for the one-use release.
    // Reject before consuming the budget or the global effect; otherwise a
    // chosen admission key could collide with the later unique claim event.
    if !permitted_admission_nonce(&id, nonce) {
        return Err(INVALID.into());
    }
    if ctx
        .db
        .protected_mail_inference_admission()
        .id()
        .find(id.clone())
        .is_some()
    {
        return Err(CONSUMED.into());
    }
    if ctx
        .db
        .protected_mail_inference_state()
        .admission_id()
        .find(id.clone())
        .is_some()
        || ctx
            .db
            .protected_mail_inference_event()
            .id()
            .find(lifecycle_id(&id, 1))
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    let data = materialize(ctx, &grant, mail, true)?;
    let input_bytes = data.bytes.len() as u64;
    let output_tokens = grant.output_tokens_per_operation;
    let budget = checked_budget(ctx, &grant)?;
    let (budget_generation, remaining_operations, remaining_input_bytes, remaining_output_tokens) =
        reserve(
            &budget,
            input_bytes,
            output_tokens,
            grant.max_input_bytes_per_operation,
        )?;
    let payload_digest = hex::encode(Sha256::digest(&data.bytes));
    let fingerprint = operation_fingerprint(
        ctx.identity(),
        grant.owner,
        grant.collection_id,
        grant.connection_epoch,
        &grant.runtime_id,
        &run.run_id,
        run.parent_run_id.as_deref(),
        &data.processor,
        input_bytes,
        output_tokens,
        &payload_digest,
    )?;
    ctx.db
        .protected_mail_inference_admission()
        .insert(ProtectedMailInferenceAdmission {
            id: id.clone(),
            event_id: event,
            grant_id: grant.id.clone(),
            run_id: run.run_id.clone(),
            root_run_id: run.root_run_id,
            owner: grant.owner,
            broker_identity: ctx.sender(),
            collection_id: grant.collection_id,
            mail_source: mail.clone(),
            instruction: grant.instruction.clone(),
            processor: grant.processor.clone(),
            event_nonce: nonce.into(),
            request_digest: request_digest(grant_id, run_label, mail, nonce),
            grant_digest: grant.digest.clone(),
            payload_digest,
            operation_fingerprint: fingerprint,
            input_bytes,
            output_tokens,
            budget_generation,
            remaining_operations,
            remaining_input_bytes,
            remaining_output_tokens,
            source_bindings: data.bindings.clone(),
            created_at: ctx.timestamp,
        });
    let initial = insert_event(
        ctx,
        &id,
        1,
        ProtectedMailInferenceStatus::Admitted,
        nonce,
        data.bindings,
    );
    ctx.db
        .protected_mail_inference_state()
        .insert(ProtectedMailInferenceState {
            admission_id: id.clone(),
            generation: 1,
            status: ProtectedMailInferenceStatus::Admitted,
            last_event_id: initial,
        });
    ctx.db
        .protected_mail_inference_budget()
        .grant_id()
        .update(ProtectedMailInferenceBudget {
            grant_id: grant.id,
            generation: budget_generation,
            remaining_operations,
            remaining_input_bytes,
            remaining_output_tokens,
            last_admission_id: Some(id.clone()),
        });
    Ok(ProtectedMailInferenceAdmissionResult { admission_id: id })
}

/// This metadata-only procedure reserves the complete request and output cap.
/// All checks and writes use the transaction's fresh time, including retries.
#[procedure]
pub fn admit_protected_mail_inference(
    ctx: &mut ProcedureContext,
    grant_id: String,
    run_id: String,
    mail_source: ProtectedMailSourceRef,
    event_nonce: String,
) -> Result<ProtectedMailInferenceAdmissionResult, String> {
    ctx.try_with_tx(|tx| {
        admit(tx.as_ref(), &grant_id, &run_id, &mail_source, &event_nonce).map_err(procedure_error)
    })
}

fn claim(ctx: &ReducerContext, id: &str) -> Result<ProtectedMailInferenceDispatchPayload, String> {
    let (grant, run, admission) = bound_admission(ctx, id)?;
    let state = checked_state(ctx, &admission)?;
    if state.status != ProtectedMailInferenceStatus::Admitted {
        return Err(CONSUMED.into());
    }
    active(ctx, &grant)?;
    let data = materialize(ctx, &grant, &admission.mail_source, true)?;
    let digest = hex::encode(Sha256::digest(&data.bytes));
    let fingerprint = operation_fingerprint(
        ctx.identity(),
        grant.owner,
        grant.collection_id,
        grant.connection_epoch,
        &grant.runtime_id,
        &run.run_id,
        run.parent_run_id.as_deref(),
        &data.processor,
        data.bytes.len() as u64,
        grant.output_tokens_per_operation,
        &digest,
    )?;
    if digest != admission.payload_digest
        || data.bytes.len() as u64 != admission.input_bytes
        || fingerprint != admission.operation_fingerprint
    {
        return Err(INCONSISTENT.into());
    }
    let payload = String::from_utf8(data.bytes).map_err(|_| INCONSISTENT)?;
    let nonce = dispatch_nonce(&admission.id);
    let event = insert_event(
        ctx,
        &admission.id,
        2,
        ProtectedMailInferenceStatus::Dispatching,
        &nonce,
        data.bindings,
    );
    ctx.db
        .protected_mail_inference_state()
        .admission_id()
        .update(ProtectedMailInferenceState {
            admission_id: admission.id.clone(),
            generation: 2,
            status: ProtectedMailInferenceStatus::Dispatching,
            last_event_id: event,
        });
    Ok(ProtectedMailInferenceDispatchPayload {
        format_version: 1,
        admission_id: admission.id,
        processor: grant.processor,
        config: data.config,
        method: "POST".into(),
        content_type: "application/json".into(),
        anthropic_version: "2023-06-01".into(),
        payload,
        payload_digest: digest,
        operation_fingerprint: fingerprint,
        input_bytes: admission.input_bytes,
        output_tokens: admission.output_tokens,
        expires_at_ms: grant.expires_at_ms,
    })
}

/// The returned value is neither persisted to the commitlog nor broadcast by
/// SDK 2.0.3. Returning this closure result directly commits Dispatching before
/// the authenticated response, and never releases bytes on any later call.
#[procedure]
pub fn begin_protected_mail_inference_dispatch(
    ctx: &mut ProcedureContext,
    admission_id: String,
) -> Result<ProtectedMailInferenceDispatchPayload, String> {
    ctx.try_with_tx(|tx| claim(tx.as_ref(), &admission_id).map_err(procedure_error))
}

fn outcome_status(outcome: &ProtectedMailInferenceOutcome) -> ProtectedMailInferenceStatus {
    match outcome {
        ProtectedMailInferenceOutcome::ResponseReceived => {
            ProtectedMailInferenceStatus::ResponseReceived
        }
        ProtectedMailInferenceOutcome::Failed => ProtectedMailInferenceStatus::Failed,
        ProtectedMailInferenceOutcome::Unknown => ProtectedMailInferenceStatus::Unknown,
        ProtectedMailInferenceOutcome::CancelledBeforeDispatch => {
            ProtectedMailInferenceStatus::CancelledBeforeDispatch
        }
    }
}
fn outcome_transition(
    current: &ProtectedMailInferenceStatus,
    desired: &ProtectedMailInferenceStatus,
) -> bool {
    matches!(
        (current, desired),
        (
            ProtectedMailInferenceStatus::Admitted,
            ProtectedMailInferenceStatus::CancelledBeforeDispatch
        ) | (
            ProtectedMailInferenceStatus::Dispatching,
            ProtectedMailInferenceStatus::ResponseReceived
                | ProtectedMailInferenceStatus::Failed
                | ProtectedMailInferenceStatus::Unknown
        )
    )
}
#[reducer]
pub fn report_protected_mail_inference_outcome(
    ctx: &ReducerContext,
    admission_id: String,
    event_nonce: String,
    outcome: ProtectedMailInferenceOutcome,
) -> Result<(), String> {
    let (_, _, admission) = bound_admission(ctx, &admission_id)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    let desired = outcome_status(&outcome);
    if let Some(existing) = ctx
        .db
        .protected_mail_inference_event()
        .request_event_id()
        .find(lifecycle_request_id(&admission_id, &event_nonce))
    {
        if existing.admission_id != admission_id
            || existing.actor != ctx.sender()
            || existing.status != desired
            || existing.request_digest != lifecycle_request(&admission_id, &desired, &event_nonce)
        {
            return Err(CONFLICT.into());
        }
        return Ok(());
    }
    let state = checked_state(ctx, &admission)?;
    if !outcome_transition(&state.status, &desired) {
        return Err(CONFLICT.into());
    }
    let generation = state.generation.checked_add(1).ok_or(INCONSISTENT)?;
    let event = insert_event(
        ctx,
        &admission_id,
        generation,
        desired.clone(),
        &event_nonce,
        vec![],
    );
    ctx.db
        .protected_mail_inference_state()
        .admission_id()
        .update(ProtectedMailInferenceState {
            admission_id,
            generation,
            status: desired,
            last_event_id: event,
        });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(id: &str, revision: u64, c: char) -> ProtectedMailSourceRef {
        ProtectedMailSourceRef {
            id: id.into(),
            revision,
            digest: c.to_string().repeat(64),
        }
    }
    fn message() -> ProtectedMailInput {
        ProtectedMailInput {
            folder: "INBOX".into(),
            uid_validity: "18446744073709551615".into(),
            uid: 1,
            direction: ProtectedMailDirection::Received,
            message_date: "2026-10-20T12:00:00Z".into(),
            from: "sender@example.test".into(),
            to: "owner@example.test".into(),
            cc: "".into(),
            subject: "Subject".into(),
            body: "hi\n\"quote\"\\\t\r".into(),
            note: "PRIVATE_IMPORTER_NOTE".into(),
            sanitization_version: "v1".into(),
        }
    }
    fn grant() -> ProtectedMailInferenceGrant {
        let mut row = ProtectedMailInferenceGrant {
            id: "a".repeat(64),
            owner: Identity::from_byte_array([1; 32]),
            collection_id: 7,
            broker_identity: Identity::from_byte_array([2; 32]),
            runtime_id: "restricted-broker".into(),
            connection_epoch: 3,
            snapshot_digest: "b".repeat(64),
            instruction: ProtectedMailInstructionRef {
                id: "instruction".into(),
                revision: 1,
                digest: "c".repeat(64),
            },
            instruction_generation: 2,
            decision_id: format!("mail-instruction-decision:{}", "d".repeat(64)),
            processor: ProtectedMailInferenceProcessorRef {
                profile_id: "profile".into(),
                generation: 1,
                revision_id: format!("mail-processor-revision:{}", "e".repeat(64)),
                digest: "f".repeat(64),
            },
            allowed_mail_sources: vec![source("mail-source:7:one", 1, 'a')],
            not_before_ms: 1000,
            expires_at_ms: 2000,
            max_operations: 3,
            max_input_bytes: 10000,
            max_output_tokens: 384,
            max_input_bytes_per_operation: 1000,
            output_tokens_per_operation: 128,
            request_digest: String::new(),
            digest: String::new(),
            created_at: Timestamp::from_micros_since_unix_epoch(1_000_000),
        };
        row.request_digest = grant_request(&row);
        row.digest = grant_digest(&row);
        row
    }
    fn budget(grant: &ProtectedMailInferenceGrant) -> ProtectedMailInferenceBudget {
        ProtectedMailInferenceBudget {
            grant_id: grant.id.clone(),
            generation: 1,
            remaining_operations: grant.max_operations,
            remaining_input_bytes: grant.max_input_bytes,
            remaining_output_tokens: grant.max_output_tokens,
            last_admission_id: None,
        }
    }
    fn tuple() -> ProtectedMailProcessor {
        ProtectedMailProcessor {
            profile_id: "profile".into(),
            revision: "exact-revision".into(),
            endpoint: "https://model.example.test/v1/messages".into(),
            model: "model".into(),
        }
    }

    #[test]
    fn escaped_provider_golden_charges_both_json_layers_and_instruction() {
        let bytes = provider_payload(
            "\tApproved \"instruction\"\\\r\n",
            &message(),
            "fixture-model",
            128,
        )
        .unwrap();
        assert_eq!(bytes.len(), 369);
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            "f4a1165b4fe330907b0b797bad7fcee7a52d85de830f6d6e37f48ba9b9ce910c"
        );
        let outer: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let inner: serde_json::Value =
            serde_json::from_str(outer["messages"][0]["content"].as_str().unwrap()).unwrap();
        assert_eq!(inner.as_object().unwrap().len(), 8);
        assert_eq!(inner["body"], message().body);
        assert!(!String::from_utf8(bytes)
            .unwrap()
            .contains("PRIVATE_IMPORTER_NOTE"));
    }
    #[test]
    fn unicode_provider_golden_preserves_scalars_bom_combining_and_line_bytes() {
        let mut message = message();
        message.body = "body 🍐\u{2028}e\u{301}\u{2029}\u{feff}".into();
        message.cc = "cc@example.test".into();
        message.direction = ProtectedMailDirection::Sent;
        message.from = "o\"wner@example.test".into();
        message.message_date = "".into();
        message.sanitization_version = "v2".into();
        message.subject = "𝄞\u{e000}\"\\".into();
        message.to = "recipient@example.test".into();
        let bytes = provider_payload(
            " 🍐\u{2028}e\u{301}日本語 \r\n",
            &message,
            "unicode-model",
            4096,
        )
        .unwrap();
        assert_eq!(bytes.len(), 362);
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            "787c3f95e16fae5e51b2580d8e7191274e0989e9e5ca71d746c20df1fe2235ca"
        );
        assert!(String::from_utf8(bytes).unwrap().contains('\u{2028}'));
    }
    #[test]
    fn fixed_recipe_binds_eight_fields_and_omits_only_declared_metadata() {
        let original = provider_payload("instruction", &message(), "model", 128).unwrap();
        let mutations: Vec<Box<dyn Fn(&mut ProtectedMailInput)>> = vec![
            Box::new(|m| m.body.push('x')),
            Box::new(|m| m.cc.push('x')),
            Box::new(|m| m.direction = ProtectedMailDirection::Sent),
            Box::new(|m| m.from.push('x')),
            Box::new(|m| m.message_date.push('x')),
            Box::new(|m| m.sanitization_version.push('x')),
            Box::new(|m| m.subject.push('x')),
            Box::new(|m| m.to.push('x')),
        ];
        for mutate in mutations {
            let mut changed = message();
            mutate(&mut changed);
            assert_ne!(
                provider_payload("instruction", &changed, "model", 128).unwrap(),
                original
            );
        }
        let mut metadata = message();
        metadata.folder = "Sent".into();
        metadata.uid_validity = "2".into();
        metadata.uid = 2;
        metadata.note = "other".into();
        assert_eq!(
            provider_payload("instruction", &metadata, "model", 128).unwrap(),
            original
        );
        assert_ne!(
            provider_payload(" instruction", &message(), "model", 128).unwrap(),
            original
        );
        assert_ne!(
            provider_payload("instruction", &message(), "model", 129).unwrap(),
            original
        );
        assert_ne!(
            provider_payload("instruction", &message(), "other", 128).unwrap(),
            original
        );
    }
    #[test]
    fn literal_bounds_and_double_escaping_are_not_truncated() {
        let mut message = message();
        message.body = "\\".repeat(160000);
        let bytes = provider_payload(&"x".repeat(16384), &message, "model", 4096).unwrap();
        assert!(bytes.len() > 512 * 1024 && bytes.len() <= MAX_PAYLOAD);
        message.body.push('x');
        assert!(provider_payload("", &message, "model", 1).is_err());
        for model in [
            " model",
            "model ",
            "\u{feff}model",
            "model\u{feff}",
            "\u{85}model",
            "",
        ] {
            assert!(provider_payload("", &super::tests::message(), model, 1).is_err());
        }
        for value in ["\0", "\u{85}", "\u{7f}"] {
            assert!(provider_payload(value, &super::tests::message(), "model", 1).is_err());
        }
        assert!(provider_payload("\u{feff} \r\n\t", &super::tests::message(), "model", 1).is_ok());
        assert!(provider_payload("", &super::tests::message(), "model", 0).is_err());
        assert!(provider_payload("", &super::tests::message(), "model", 4097).is_err());
    }
    #[test]
    fn processing_permission_is_exact_and_independent_of_storage() {
        let target = tuple();
        let mut policy = EffectiveProtectedMailPolicy {
            processors: vec![],
            allow_owner_storage: true,
            bindings: vec![],
        };
        assert!(!permits_inference(&policy, &target));
        policy.processors.push(target.clone());
        policy.allow_owner_storage = false;
        assert!(permits_inference(&policy, &target));
        let mut other = target.clone();
        other.revision.push('x');
        assert!(!permits_inference(&policy, &other));
        other = target.clone();
        other.endpoint.push('/');
        assert!(!permits_inference(&policy, &other));
        other = target.clone();
        other.model.push('x');
        assert!(!permits_inference(&policy, &other));
    }
    #[test]
    fn global_once_excludes_grants_runs_epochs_decisions_and_token_cap() {
        let workspace = Identity::from_byte_array([7; 32]);
        let original = grant();
        let mail = original.allowed_mail_sources[0].clone();
        let id = effect_id(workspace, &original, &mail);
        assert!(hex64(&id));
        let mut another = grant();
        another.id = "b".repeat(64);
        another.runtime_id = "another".into();
        another.connection_epoch += 1;
        another.instruction_generation += 1;
        another.decision_id.push('x');
        another.output_tokens_per_operation += 1;
        assert_eq!(effect_id(workspace, &another, &mail), id);
        assert_ne!(
            effect_id(Identity::from_byte_array([8; 32]), &original, &mail),
            id
        );
        another.collection_id += 1;
        assert_ne!(effect_id(workspace, &another, &mail), id);
        another.collection_id = original.collection_id;
        another.instruction.revision += 1;
        assert_ne!(effect_id(workspace, &another, &mail), id);
        another = grant();
        another.processor.generation += 1;
        assert_ne!(effect_id(workspace, &another, &mail), id);
        another = grant();
        another.processor.revision_id.push('x');
        assert_ne!(effect_id(workspace, &another, &mail), id);
        assert_ne!(
            effect_id(workspace, &original, &source(&mail.id, 2, 'a')),
            id
        );
    }
    #[test]
    fn grant_digest_binds_every_reviewed_limit_and_reference() {
        let original = grant_request(&grant());
        let mutations: Vec<Box<dyn Fn(&mut ProtectedMailInferenceGrant)>> = vec![
            Box::new(|g| g.id.push('b')),
            Box::new(|g| g.owner = Identity::from_byte_array([3; 32])),
            Box::new(|g| g.collection_id += 1),
            Box::new(|g| g.connection_epoch += 1),
            Box::new(|g| g.broker_identity = Identity::from_byte_array([4; 32])),
            Box::new(|g| g.runtime_id.push('x')),
            Box::new(|g| g.instruction.revision += 1),
            Box::new(|g| g.instruction_generation += 1),
            Box::new(|g| g.decision_id.push('x')),
            Box::new(|g| g.processor.profile_id.push('x')),
            Box::new(|g| g.processor.generation += 1),
            Box::new(|g| g.processor.revision_id.push('x')),
            Box::new(|g| g.processor.digest = "a".repeat(64)),
            Box::new(|g| g.allowed_mail_sources.push(source("other", 1, 'a'))),
            Box::new(|g| g.not_before_ms += 1),
            Box::new(|g| g.expires_at_ms += 1),
            Box::new(|g| g.max_operations += 1),
            Box::new(|g| g.max_input_bytes += 1),
            Box::new(|g| g.max_output_tokens += 1),
            Box::new(|g| g.max_input_bytes_per_operation += 1),
            Box::new(|g| g.output_tokens_per_operation += 1),
        ];
        for mutate in mutations {
            let mut changed = grant();
            mutate(&mut changed);
            assert_ne!(grant_request(&changed), original);
        }
        let mut changed = grant();
        changed.snapshot_digest = "a".repeat(64);
        assert_eq!(grant_request(&changed), original);
        assert_ne!(grant_digest(&changed), grant().digest);
    }
    #[test]
    fn reservations_charge_whole_input_and_full_output_cap_without_refunds() {
        let grant = grant();
        let initial = budget(&grant);
        assert!(budget_shape(&grant, &initial));
        assert_eq!(
            reserve(&initial, 369, 128, 1000).unwrap(),
            (2, 2, 9631, 256)
        );
        let mut current = ProtectedMailInferenceBudget {
            grant_id: grant.id.clone(),
            generation: 2,
            remaining_operations: 2,
            remaining_input_bytes: 9631,
            remaining_output_tokens: 256,
            last_admission_id: Some("admission".into()),
        };
        assert!(budget_shape(&grant, &current));
        assert_eq!(
            reserve(&current, 369, 128, 1000).unwrap(),
            (3, 1, 9262, 128)
        );
        current.remaining_output_tokens = 127;
        assert!(reserve(&current, 369, 128, 1000).is_err());
        assert!(!budget_shape(&grant, &current));
        current.remaining_output_tokens = 256;
        current.remaining_input_bytes = 368;
        assert!(reserve(&current, 369, 128, 1000).is_err());
        current.remaining_input_bytes = 9631;
        assert!(reserve(&current, 1001, 128, 1000).is_err());
        current.remaining_operations = 0;
        assert!(reserve(&current, 369, 128, 1000).is_err());
        current.remaining_operations = 2;
        current.generation = 65;
        assert!(reserve(&current, 369, 128, 1000).is_err());
    }
    #[test]
    fn lifecycle_never_reopens_and_only_predispatch_can_cancel() {
        use ProtectedMailInferenceStatus::*;
        let statuses = [
            Admitted,
            Dispatching,
            ResponseReceived,
            Failed,
            Unknown,
            CancelledBeforeDispatch,
        ];
        for old in &statuses {
            for next in &statuses {
                let expected = matches!(
                    (old, next),
                    (Admitted, CancelledBeforeDispatch)
                        | (Dispatching, ResponseReceived | Failed | Unknown)
                );
                assert_eq!(outcome_transition(old, next), expected);
            }
        }
        assert_ne!(
            lifecycle_request("id", &Failed, "nonce"),
            lifecycle_request("id", &Unknown, "nonce")
        );
        assert_ne!(
            lifecycle_request_id("id", "nonce"),
            lifecycle_request_id("id", "other")
        );
    }
    #[test]
    fn request_nonce_namespace_is_separate_from_mail_effect_identity() {
        let a = source("mail-a", 1, 'a');
        let b = source("mail-b", 1, 'b');
        assert_ne!(
            request_digest("g", "r", &a, "n"),
            request_digest("g", "r", &b, "n")
        );
        assert_ne!(
            request_event("g", "r", "n"),
            request_event("g", "child", "n")
        );
        assert_ne!(
            request_event("g", "r", "n"),
            request_event("other", "r", "n")
        );
        assert_ne!(run_request("g", "r", None), run_request("g", "r", Some("")));
        assert!(canonical_sources(&[a.clone(), a.clone()]).is_err());
        assert!(canonical_sources(&[]).is_err());
        assert!(canonical_sources(
            &(0..65)
                .map(|i| source(&format!("m{i}"), 1, 'a'))
                .collect::<Vec<_>>()
        )
        .is_err());
    }
    #[test]
    fn caller_cannot_reserve_the_internal_dispatch_event_key() {
        let grant = grant();
        let id = effect_id(
            Identity::from_byte_array([7; 32]),
            &grant,
            &grant.allowed_mail_sources[0],
        );
        let reserved = dispatch_nonce(&id);
        assert!(hex64(&reserved));
        assert!(!permitted_admission_nonce(&id, &reserved));
        assert!(permitted_admission_nonce(&id, &"a".repeat(64)));
        assert_ne!(
            lifecycle_request_id(&id, &reserved),
            lifecycle_request_id(&id, &"a".repeat(64))
        );
    }
    #[test]
    fn fixed_limits_are_safe_and_no_more_than_one_hour() {
        let mut grant = grant();
        assert!(limits(&grant));
        grant.max_operations = 65;
        assert!(!limits(&grant));
        grant.max_operations = 3;
        grant.expires_at_ms = grant.not_before_ms + MAX_TTL + 1;
        assert!(!limits(&grant));
        grant.expires_at_ms = 2000;
        grant.max_input_bytes = SAFE + 1;
        assert!(!limits(&grant));
        grant.max_input_bytes = 10000;
        grant.max_output_tokens = SAFE + 1;
        assert!(!limits(&grant));
        grant.max_output_tokens = 384;
        grant.output_tokens_per_operation = 4097;
        assert!(!limits(&grant));
        grant.output_tokens_per_operation = 128;
        grant.connection_epoch = SAFE + 1;
        assert!(!limits(&grant));
    }
    #[test]
    fn procedure_errors_are_a_closed_non_content_response() {
        for code in [
            INVALID,
            INCONSISTENT,
            OWNER,
            BROKER,
            CONFLICT,
            CONSUMED,
            STALE,
            BUDGET,
        ] {
            assert_eq!(procedure_error(code.into()), code);
        }
        assert_eq!(
            procedure_error("protected_mail_inference_grant_revoked".into()),
            STALE
        );
        assert_eq!(
            procedure_error("protected_mail_inference_processor_denied".into()),
            STALE
        );
        assert_eq!(
            procedure_error("RAW_SYNTHETIC_PRIVATE_ERROR".into()),
            INCONSISTENT
        );
    }

    #[test]
    fn grant_nonce_is_scoped_to_exact_owner_and_collection() {
        let owner = Identity::from_byte_array([1; 32]);
        let nonce = "a".repeat(64);
        let id = grant_id(owner, 7, &nonce);
        assert!(hex64(&id));
        assert_eq!(grant_id(owner, 7, &nonce), id);
        assert_ne!(grant_id(Identity::from_byte_array([2; 32]), 7, &nonce), id);
        assert_ne!(grant_id(owner, 8, &nonce), id);
        assert_ne!(grant_id(owner, 7, &"b".repeat(64)), id);
        // Supplying another resource's derived ID as a nonce does not select
        // or reserve that resource in the caller's owner namespace.
        assert_ne!(grant_id(Identity::from_byte_array([2; 32]), 7, &id), id);
    }
}
