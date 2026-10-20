//! Owner-authorized local promotion of already-staged private summaries.
//! No mailbox, model, network dispatch, checkpoint, or service body read exists.
//! Publisher staging remains trusted management authority outside this facet.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spacetimedb::{reducer, table, Identity, ReducerContext, SpacetimeType, Table, Timestamp};

use super::authority::checked_current_authority;
use super::governance::{
    current_effective_policy, resolve_source_graph, validate_source_ref,
    ProtectedMailSourceGeneration, ProtectedMailSourceRef,
};
use super::instructions::{checked_approved_instruction, ProtectedMailInstructionRef};
use super::protected::{protected_mail_collection, protected_mail_source};
use super::provenance::{
    protected_mail_context, protected_mail_derivation, resolve_derived_source,
};
use crate::ai::{ai_user_config, ai_user_profile};
use crate::auth::user;
use crate::module_install::module_install_meta;

const OWNER: &str = "protected_mail_summary_owner_required";
const SERVICE: &str = "protected_mail_summary_service_required";
const INVALID: &str = "protected_mail_summary_invalid_request";
const INCONSISTENT: &str = "protected_mail_summary_inconsistent";
const CONFLICT: &str = "protected_mail_summary_event_conflict";
const REVOKED: &str = "protected_mail_summary_grant_revoked";
const EXPIRED: &str = "protected_mail_summary_grant_not_active";
const BUDGET: &str = "protected_mail_summary_budget_exceeded";
const SAFE: u64 = 9_007_199_254_740_991;
const MAX_TTL_MS: u64 = 3_600_000;
const MAX_ENVELOPE: usize = 512 * 1024;

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailSummaryGrantEventKind {
    Issued,
    Revoked,
}

#[table(accessor = protected_mail_summary_grant, private)]
pub struct ProtectedMailSummaryGrant {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub owner: Identity,
    pub collection_id: u64,
    pub service_identity: Identity,
    pub runtime_id: String,
    pub connection_epoch: u64,
    pub snapshot_digest: String,
    pub instruction: ProtectedMailInstructionRef,
    pub instruction_generation: u64,
    pub decision_id: String,
    pub allowed_stages: Vec<ProtectedMailSourceRef>,
    pub not_before_ms: u64,
    pub expires_at_ms: u64,
    pub max_operations: u64,
    pub max_append_bytes: u64,
    pub max_append_bytes_per_operation: u64,
    pub request_digest: String,
    pub digest: String,
    pub created_at: Timestamp,
}

#[table(accessor = protected_mail_summary_grant_event, private)]
pub struct ProtectedMailSummaryGrantEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub grant_id: String,
    pub generation: u64,
    pub kind: ProtectedMailSummaryGrantEventKind,
    pub event_nonce: String,
    pub request_digest: String,
    pub grant_digest: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}

#[table(accessor = protected_mail_summary_run, private)]
pub struct ProtectedMailSummaryRun {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub grant_id: String,
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub root_run_id: String,
    pub depth: u32,
    pub service_identity: Identity,
    pub runtime_id: String,
    pub request_digest: String,
    pub created_at: Timestamp,
}

#[table(accessor = protected_mail_summary_budget, private)]
pub struct ProtectedMailSummaryBudget {
    #[primary_key]
    pub grant_id: String,
    pub generation: u64,
    pub remaining_operations: u64,
    pub remaining_append_bytes: u64,
    pub last_receipt_id: Option<String>,
}

#[table(accessor = protected_mail_committed_summary, private)]
pub struct ProtectedMailCommittedSummary {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub owner: Identity,
    pub collection_id: u64,
    pub stage: ProtectedMailSourceRef,
    pub grant_id: String,
    pub run_id: String,
    pub receipt_id: String,
    pub created_at: Timestamp,
}

#[table(accessor = protected_mail_summary_admission_receipt, private)]
pub struct ProtectedMailSummaryAdmissionReceipt {
    #[primary_key]
    pub id: String,
    #[unique]
    pub event_id: String,
    #[index(btree)]
    pub grant_id: String,
    pub run_id: String,
    pub root_run_id: String,
    pub owner: Identity,
    pub service_identity: Identity,
    pub collection_id: u64,
    pub stage: ProtectedMailSourceRef,
    pub event_nonce: String,
    pub request_digest: String,
    pub payload_digest: String,
    pub operation_fingerprint: String,
    pub append_bytes: u64,
    pub budget_generation: u64,
    pub remaining_operations: u64,
    pub remaining_append_bytes: u64,
    pub stage_policy_generation: u64,
    pub source_bindings: Vec<ProtectedMailSourceGeneration>,
    pub created_at: Timestamp,
}

pub(super) fn hash(domain: &str, fields: &[String]) -> String {
    let mut digest = Sha256::new();
    for value in std::iter::once(domain).chain(fields.iter().map(String::as_str)) {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    hex::encode(digest.finalize())
}
pub(super) fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(super) fn opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}
fn decision_key(value: &str) -> bool {
    value
        .strip_prefix("mail-instruction-decision:")
        .is_some_and(hex64)
}
fn publisher(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db
        .module_install_meta()
        .id()
        .find(0)
        .is_some_and(|m| m.publisher_identity == identity)
}
pub(super) fn human(ctx: &ReducerContext, identity: Identity) -> bool {
    !publisher(ctx, identity)
        && ctx.db.ai_user_config().identity().find(identity).is_none()
        && ctx.db.ai_user_profile().identity().find(identity).is_none()
        && ctx
            .db
            .user()
            .identity()
            .find(identity)
            .is_some_and(|u| u.is_authenticated)
}
pub(super) fn service(ctx: &ReducerContext, identity: Identity, owner: Identity) -> bool {
    identity != owner
        && identity != Identity::from_byte_array([0; 32])
        && !publisher(ctx, identity)
        && ctx.db.ai_user_config().identity().find(identity).is_none()
        && ctx.db.ai_user_profile().identity().find(identity).is_none()
        && !ctx
            .db
            .user()
            .identity()
            .find(identity)
            .is_some_and(|u| u.is_authenticated || u.is_admin)
}
pub(super) fn now_ms(ctx: &ReducerContext) -> Result<u64, String> {
    let value =
        u64::try_from(ctx.timestamp.to_micros_since_unix_epoch() / 1000).map_err(|_| INVALID)?;
    if value > SAFE {
        return Err(INVALID.into());
    }
    Ok(value)
}
fn ref_fields(reference: &ProtectedMailSourceRef) -> Vec<String> {
    vec![
        reference.id.clone(),
        reference.revision.to_string(),
        reference.digest.clone(),
    ]
}
fn instruction_source(reference: &ProtectedMailInstructionRef) -> ProtectedMailSourceRef {
    ProtectedMailSourceRef {
        id: reference.id.clone(),
        revision: reference.revision,
        digest: reference.digest.clone(),
    }
}
fn canonical_refs(refs: &[ProtectedMailSourceRef]) -> Result<Vec<ProtectedMailSourceRef>, String> {
    if refs.is_empty() || refs.len() > 64 {
        return Err(INVALID.into());
    }
    let mut result = refs.to_vec();
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
fn grant_request(grant: &ProtectedMailSummaryGrant) -> String {
    let mut fields = vec![
        grant.id.clone(),
        grant.owner.to_hex().to_string(),
        grant.collection_id.to_string(),
        grant.connection_epoch.to_string(),
        grant.service_identity.to_hex().to_string(),
        grant.runtime_id.clone(),
    ];
    fields.extend(ref_fields(&instruction_source(&grant.instruction)));
    fields.extend([
        grant.instruction_generation.to_string(),
        grant.decision_id.clone(),
        grant.allowed_stages.len().to_string(),
    ]);
    for stage in &grant.allowed_stages {
        fields.extend(ref_fields(stage));
    }
    fields.extend([
        grant.not_before_ms.to_string(),
        grant.expires_at_ms.to_string(),
        grant.max_operations.to_string(),
        grant.max_append_bytes.to_string(),
        grant.max_append_bytes_per_operation.to_string(),
    ]);
    hash("pear-mail-summary-grant-request-v1", &fields)
}
fn grant_digest(grant: &ProtectedMailSummaryGrant) -> String {
    hash(
        "pear-mail-summary-grant-v1",
        &[grant.request_digest.clone(), grant.snapshot_digest.clone()],
    )
}
fn event_id(grant: &str, generation: u64) -> String {
    format!("{grant}:{generation}")
}
fn run_key(grant: &str, run: &str) -> String {
    hash("pear-mail-summary-run-v1", &[grant.into(), run.into()])
}
fn run_request(grant: &str, run: &str, parent: Option<&str>) -> String {
    hash(
        "pear-mail-summary-run-request-v1",
        &[
            grant.into(),
            run.into(),
            parent.is_some().to_string(),
            parent.unwrap_or("").into(),
        ],
    )
}
fn admission_event(grant: &str, run: &str, nonce: &str) -> String {
    hash(
        "pear-mail-summary-admission-event-v1",
        &[grant.into(), run.into(), nonce.into()],
    )
}
fn request_digest(grant: &str, run: &str, stage: &ProtectedMailSourceRef, nonce: &str) -> String {
    let mut fields = vec![grant.into(), run.into(), nonce.into()];
    fields.extend(ref_fields(stage));
    hash("pear-mail-summary-admission-request-v1", &fields)
}
fn effect_id(workspace: Identity, collection: u64, stage: &ProtectedMailSourceRef) -> String {
    let mut fields = vec![
        workspace.to_hex().to_string(),
        collection.to_string(),
        "1".into(),
    ];
    fields.extend(ref_fields(stage));
    format!(
        "mail-summary-effect:{}",
        hash("pear-mail-summary-effect-v1", &fields)
    )
}
fn safe_limits(grant: &ProtectedMailSummaryGrant) -> bool {
    grant.connection_epoch > 0
        && grant.connection_epoch <= SAFE
        && grant.instruction_generation > 0
        && grant.instruction_generation <= SAFE
        && grant.not_before_ms <= SAFE
        && grant.expires_at_ms <= SAFE
        && grant.expires_at_ms > grant.not_before_ms
        && grant.expires_at_ms - grant.not_before_ms <= MAX_TTL_MS
        && grant.max_operations > 0
        && grant.max_operations < SAFE
        && grant.max_append_bytes > 0
        && grant.max_append_bytes <= SAFE
        && grant.max_append_bytes_per_operation > 0
        && grant.max_append_bytes_per_operation <= grant.max_append_bytes
        && grant.max_append_bytes_per_operation <= MAX_ENVELOPE as u64
}
fn issuance_window(grant: &ProtectedMailSummaryGrant, now: u64) -> bool {
    grant.expires_at_ms > now && grant.expires_at_ms - now <= MAX_TTL_MS
}
fn budget_shape(grant: &ProtectedMailSummaryGrant, budget: &ProtectedMailSummaryBudget) -> bool {
    budget.generation > 0
        && budget.generation <= SAFE
        && budget.remaining_operations <= grant.max_operations
        && grant
            .max_operations
            .checked_sub(budget.remaining_operations)
            .and_then(|used| used.checked_add(1))
            == Some(budget.generation)
        && budget.remaining_append_bytes <= grant.max_append_bytes
}

// Explicit recursive key sorting matches S0 canonicalOperation independent of
// serde_json map feature unification. Arrays retain the authoritative order.
pub(super) fn canonical(value: &Value) -> Result<String, String> {
    match value {
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let mut entries = Vec::with_capacity(keys.len());
            for key in keys {
                entries.push(format!(
                    "{}:{}",
                    serde_json::to_string(key).map_err(|_| INCONSISTENT)?,
                    canonical(&values[key])?
                ));
            }
            Ok(format!("{{{}}}", entries.join(",")))
        }
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        _ => serde_json::to_string(value).map_err(|_| INCONSISTENT.into()),
    }
}
fn json_ref(reference: &ProtectedMailSourceRef) -> Value {
    json!({"id":reference.id,"revision":reference.revision.to_string(),"digest":reference.digest})
}
fn payload(
    body: &str,
    sanitizer: &str,
    stage: &ProtectedMailSourceRef,
    parents: &[ProtectedMailSourceRef],
) -> Result<Vec<u8>, String> {
    // A private stage supplies these values, but keep the codec contract
    // self-contained and identical to the independent TypeScript builder.
    if body.len() > 160_000
        || body
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        || sanitizer.is_empty()
        || sanitizer.len() > 64
        || !sanitizer
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        || parents.is_empty()
        || parents.len() > 256
    {
        return Err(INVALID.into());
    }
    validate_source_ref(stage).map_err(|_| INVALID)?;
    for reference in parents {
        validate_source_ref(reference).map_err(|_| INVALID)?;
    }
    if parents
        .windows(2)
        .any(|pair| (&pair[0].id, pair[0].revision) >= (&pair[1].id, pair[1].revision))
        || !parents.contains(stage)
    {
        return Err(INVALID.into());
    }
    let bytes = canonical(&json!({"body":body,"contractVersion":1,"kind":"mail.summary",
        "parents":parents.iter().map(json_ref).collect::<Vec<_>>(),"sanitizationVersion":sanitizer,"stage":json_ref(stage)}))?.into_bytes();
    if bytes.len() > MAX_ENVELOPE {
        return Err(INVALID.into());
    }
    Ok(bytes)
}
fn operation_fingerprint(
    workspace: Identity,
    grant: &ProtectedMailSummaryGrant,
    run: &ProtectedMailSummaryRun,
    bytes: u64,
    digest: &str,
) -> Result<String, String> {
    let mut scope = json!({"workspaceId":workspace.to_hex().to_string(),"principalId":grant.owner.to_hex().to_string(),
        "runtimeId":grant.runtime_id,"runId":run.run_id});
    if let Some(parent) = &run.parent_run_id {
        scope["parentRunId"] = json!(parent);
    }
    let operation = json!({"bytes":bytes,"connectionId":grant.collection_id.to_string(),"contractVersion":1,
        "destination":{"ownerId":grant.owner.to_hex().to_string(),"rootId":grant.collection_id.to_string(),"workspaceId":workspace.to_hex().to_string()},
        "epoch":grant.connection_epoch,"kind":"mail.append","payloadDigest":digest,"scope":scope});
    Ok(hex::encode(Sha256::digest(
        canonical(&operation)?.as_bytes(),
    )))
}

fn checked_grant(
    ctx: &ReducerContext,
    grant: ProtectedMailSummaryGrant,
) -> Result<ProtectedMailSummaryGrant, String> {
    if !hex64(&grant.id)
        || !opaque(&grant.runtime_id)
        || !safe_limits(&grant)
        || validate_source_ref(&instruction_source(&grant.instruction)).is_err()
        || !decision_key(&grant.decision_id)
        || canonical_refs(&grant.allowed_stages)? != grant.allowed_stages
        || !hex64(&grant.snapshot_digest)
        || grant.request_digest != grant_request(&grant)
        || grant.digest != grant_digest(&grant)
    {
        return Err(INCONSISTENT.into());
    }
    let issued = ctx
        .db
        .protected_mail_summary_grant_event()
        .id()
        .find(event_id(&grant.id, 1))
        .ok_or(INCONSISTENT)?;
    if issued.grant_id != grant.id
        || issued.generation != 1
        || issued.kind != ProtectedMailSummaryGrantEventKind::Issued
        || issued.event_nonce != grant.id
        || issued.request_digest != grant.request_digest
        || issued.grant_digest != grant.digest
        || issued.actor != grant.owner
        || issued.created_at != grant.created_at
    {
        return Err(INCONSISTENT.into());
    }
    if let Some(revoked) = ctx
        .db
        .protected_mail_summary_grant_event()
        .id()
        .find(event_id(&grant.id, 2))
    {
        if revoked.grant_id != grant.id
            || revoked.generation != 2
            || revoked.kind != ProtectedMailSummaryGrantEventKind::Revoked
            || revoked.actor != grant.owner
            || revoked.grant_digest != grant.digest
            || !hex64(&revoked.event_nonce)
            || revoked.event_nonce == grant.id
            || revoked.request_digest
                != hash(
                    "pear-mail-summary-revoke-v1",
                    &[grant.id.clone(), revoked.event_nonce.clone()],
                )
        {
            return Err(INCONSISTENT.into());
        }
    }
    Ok(grant)
}
fn owned_grant(ctx: &ReducerContext, id: &str) -> Result<ProtectedMailSummaryGrant, String> {
    if !human(ctx, ctx.sender()) {
        return Err(OWNER.into());
    }
    let grant = ctx
        .db
        .protected_mail_summary_grant()
        .id()
        .find(id.to_owned())
        .filter(|g| g.owner == ctx.sender())
        .ok_or(OWNER)?;
    checked_grant(ctx, grant)
}
fn service_grant(ctx: &ReducerContext, id: &str) -> Result<ProtectedMailSummaryGrant, String> {
    let grant = ctx
        .db
        .protected_mail_summary_grant()
        .id()
        .find(id.to_owned())
        .filter(|g| g.service_identity == ctx.sender() && service(ctx, ctx.sender(), g.owner))
        .ok_or(SERVICE)?;
    checked_grant(ctx, grant)
}
fn active(ctx: &ReducerContext, grant: &ProtectedMailSummaryGrant) -> Result<(), String> {
    if ctx
        .db
        .protected_mail_summary_grant_event()
        .id()
        .find(event_id(&grant.id, 2))
        .is_some()
    {
        return Err(REVOKED.into());
    }
    let now = now_ms(ctx)?;
    if now < grant.not_before_ms || now >= grant.expires_at_ms {
        return Err(EXPIRED.into());
    }
    if !human(ctx, grant.owner) || !service(ctx, grant.service_identity, grant.owner) {
        return Err(SERVICE.into());
    }
    let authority = checked_current_authority(ctx, grant.collection_id)?;
    if authority.owner != grant.owner
        || authority.collection_id != grant.collection_id
        || authority.epoch != grant.connection_epoch
        || authority.snapshot_digest != grant.snapshot_digest
    {
        return Err("protected_mail_summary_stale_epoch".into());
    }
    checked_approved_instruction(
        ctx,
        grant.collection_id,
        &grant.instruction,
        grant.instruction_generation,
        &grant.decision_id,
    )
}
fn checked_run(
    ctx: &ReducerContext,
    grant: &ProtectedMailSummaryGrant,
    id: &str,
) -> Result<ProtectedMailSummaryRun, String> {
    let run = ctx
        .db
        .protected_mail_summary_run()
        .id()
        .find(run_key(&grant.id, id))
        .ok_or("protected_mail_summary_run_required")?;
    let mut current_id = run.run_id.clone();
    let mut expected_depth = run.depth;
    for _ in 0..16 {
        let current = ctx
            .db
            .protected_mail_summary_run()
            .id()
            .find(run_key(&grant.id, &current_id))
            .ok_or(INCONSISTENT)?;
        if current.id != run_key(&grant.id, &current.run_id)
            || current.grant_id != grant.id
            || !opaque(&current.run_id)
            || current.service_identity != grant.service_identity
            || current.runtime_id != grant.runtime_id
            || current.depth == 0
            || current.depth > 16
            || current.depth != expected_depth
            || current.root_run_id != run.root_run_id
            || current.request_digest
                != run_request(&grant.id, &current.run_id, current.parent_run_id.as_deref())
        {
            return Err(INCONSISTENT.into());
        }
        let Some(parent) = &current.parent_run_id else {
            if current.depth != 1
                || current.root_run_id != current.run_id
                || run.root_run_id != current.run_id
            {
                return Err(INCONSISTENT.into());
            }
            return Ok(run);
        };
        current_id = parent.clone();
        expected_depth = current.depth.checked_sub(1).ok_or(INCONSISTENT)?;
    }
    Err(INCONSISTENT.into())
}
fn checked_budget(
    ctx: &ReducerContext,
    grant: &ProtectedMailSummaryGrant,
) -> Result<ProtectedMailSummaryBudget, String> {
    let budget = ctx
        .db
        .protected_mail_summary_budget()
        .grant_id()
        .find(grant.id.clone())
        .ok_or(INCONSISTENT)?;
    if !budget_shape(grant, &budget) {
        return Err(INCONSISTENT.into());
    }
    match &budget.last_receipt_id {
        None if budget.generation == 1
            && budget.remaining_operations == grant.max_operations
            && budget.remaining_append_bytes == grant.max_append_bytes => {}
        Some(id) => {
            let receipt = ctx
                .db
                .protected_mail_summary_admission_receipt()
                .id()
                .find(id.clone())
                .ok_or(INCONSISTENT)?;
            if receipt.grant_id != grant.id
                || receipt.budget_generation != budget.generation
                || receipt.remaining_operations != budget.remaining_operations
                || receipt.remaining_append_bytes != budget.remaining_append_bytes
            {
                return Err(INCONSISTENT.into());
            }
        }
        _ => return Err(INCONSISTENT.into()),
    }
    Ok(budget)
}
fn stage_data(
    ctx: &ReducerContext,
    grant: &ProtectedMailSummaryGrant,
    stage: &ProtectedMailSourceRef,
    check_current: bool,
) -> Result<(Vec<ProtectedMailSourceRef>, Vec<u8>), String> {
    let resolved =
        resolve_derived_source(ctx, stage)?.ok_or("protected_mail_summary_stage_required")?;
    if resolved.owner != grant.owner || resolved.collection_id != grant.collection_id {
        return Err("protected_mail_summary_stage_required".into());
    }
    let derivation = ctx
        .db
        .protected_mail_derivation()
        .source_id()
        .find(stage.id.clone())
        .ok_or(INCONSISTENT)?;
    let context = ctx
        .db
        .protected_mail_context()
        .id()
        .find(derivation.context_id.clone())
        .ok_or(INCONSISTENT)?;
    if context.owner != grant.owner || context.collection_id != grant.collection_id {
        return Err(INCONSISTENT.into());
    }
    if check_current && context.blocked {
        return Err("protected_mail_context_blocked".into());
    }
    let closure = resolve_source_graph(ctx, grant.collection_id, std::slice::from_ref(stage))?;
    let parents = closure.into_iter().map(|s| s.reference).collect::<Vec<_>>();
    if !parents.contains(&instruction_source(&grant.instruction)) {
        return Err("protected_mail_summary_instruction_source_required".into());
    }
    if !parents.iter().any(|reference| {
        ctx.db
            .protected_mail_source()
            .id()
            .find(reference.id.clone())
            .is_some_and(|source| {
                source.collection_id == grant.collection_id && source.owner == grant.owner
            })
    }) {
        return Err("protected_mail_summary_mail_source_required".into());
    }
    let bytes = payload(
        &derivation.body,
        &derivation.sanitization_version,
        stage,
        &parents,
    )?;
    Ok((parents, bytes))
}

#[reducer]
#[allow(clippy::too_many_arguments)]
pub fn issue_protected_mail_summary_grant(
    ctx: &ReducerContext,
    grant_id: String,
    connection_id: u64,
    expected_epoch: u64,
    service_identity: Identity,
    runtime_id: String,
    instruction: ProtectedMailInstructionRef,
    expected_instruction_generation: u64,
    decision_id: String,
    allowed_stages: Vec<ProtectedMailSourceRef>,
    not_before_ms: u64,
    expires_at_ms: u64,
    max_operations: u64,
    max_append_bytes: u64,
    max_append_bytes_per_operation: u64,
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
    if !hex64(&grant_id) || !opaque(&runtime_id) {
        return Err(INVALID.into());
    }
    let mut grant = ProtectedMailSummaryGrant {
        id: grant_id.clone(),
        owner: collection.owner,
        collection_id: connection_id,
        service_identity,
        runtime_id,
        connection_epoch: expected_epoch,
        snapshot_digest: String::new(),
        instruction,
        instruction_generation: expected_instruction_generation,
        decision_id,
        allowed_stages: canonical_refs(&allowed_stages)?,
        not_before_ms,
        expires_at_ms,
        max_operations,
        max_append_bytes,
        max_append_bytes_per_operation,
        request_digest: String::new(),
        digest: String::new(),
        created_at: ctx.timestamp,
    };
    if !safe_limits(&grant)
        || !decision_key(&grant.decision_id)
        || validate_source_ref(&instruction_source(&grant.instruction)).is_err()
    {
        return Err(INVALID.into());
    }
    grant.request_digest = grant_request(&grant);
    if let Some(existing) = ctx
        .db
        .protected_mail_summary_grant()
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
        .protected_mail_summary_grant_event()
        .id()
        .find(event_id(&grant_id, 1))
        .is_some()
        || ctx
            .db
            .protected_mail_summary_grant_event()
            .id()
            .find(event_id(&grant_id, 2))
            .is_some()
        || ctx
            .db
            .protected_mail_summary_budget()
            .grant_id()
            .find(grant_id.clone())
            .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    if !service(ctx, grant.service_identity, grant.owner) {
        return Err(SERVICE.into());
    }
    let now = now_ms(ctx)?;
    if !issuance_window(&grant, now) {
        return Err(EXPIRED.into());
    }
    let authority = checked_current_authority(ctx, connection_id)?;
    if authority.owner != grant.owner || authority.epoch != expected_epoch {
        return Err("protected_mail_summary_stale_epoch".into());
    }
    grant.snapshot_digest = authority.snapshot_digest;
    checked_approved_instruction(
        ctx,
        connection_id,
        &grant.instruction,
        grant.instruction_generation,
        &grant.decision_id,
    )?;
    for stage in &grant.allowed_stages {
        let (_, bytes) = stage_data(ctx, &grant, stage, true)?;
        if bytes.len() as u64 > grant.max_append_bytes_per_operation {
            return Err(BUDGET.into());
        }
        if !current_effective_policy(ctx, connection_id, std::slice::from_ref(stage))?
            .allow_owner_storage
        {
            return Err("protected_mail_source_disclosure_denied".into());
        }
    }
    // Bound the complete grant resource set, not merely each selected stage.
    resolve_source_graph(ctx, connection_id, &grant.allowed_stages)?;
    grant.digest = grant_digest(&grant);
    ctx.db
        .protected_mail_summary_grant_event()
        .insert(ProtectedMailSummaryGrantEvent {
            id: event_id(&grant_id, 1),
            grant_id: grant_id.clone(),
            generation: 1,
            kind: ProtectedMailSummaryGrantEventKind::Issued,
            event_nonce: grant_id.clone(),
            request_digest: grant.request_digest.clone(),
            grant_digest: grant.digest.clone(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    ctx.db
        .protected_mail_summary_budget()
        .insert(ProtectedMailSummaryBudget {
            grant_id,
            generation: 1,
            remaining_operations: max_operations,
            remaining_append_bytes: max_append_bytes,
            last_receipt_id: None,
        });
    ctx.db.protected_mail_summary_grant().insert(grant);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str, revision: u64, digest: char) -> ProtectedMailSourceRef {
        ProtectedMailSourceRef {
            id: id.into(),
            revision,
            digest: digest.to_string().repeat(64),
        }
    }
    fn grant() -> ProtectedMailSummaryGrant {
        let mut grant = ProtectedMailSummaryGrant {
            id: "a".repeat(64),
            owner: Identity::from_byte_array([1; 32]),
            collection_id: 7,
            service_identity: Identity::from_byte_array([2; 32]),
            runtime_id: "restricted-mail-service".into(),
            connection_epoch: 3,
            snapshot_digest: "b".repeat(64),
            instruction: ProtectedMailInstructionRef {
                id: "instruction".into(),
                revision: 2,
                digest: "c".repeat(64),
            },
            instruction_generation: 4,
            decision_id: format!("mail-instruction-decision:{}", "d".repeat(64)),
            allowed_stages: vec![source("stage", 1, 'e')],
            not_before_ms: 1_000,
            expires_at_ms: 2_000,
            max_operations: 3,
            max_append_bytes: 10_000,
            max_append_bytes_per_operation: 5_000,
            request_digest: String::new(),
            digest: String::new(),
            created_at: Timestamp::from_micros_since_unix_epoch(1_000_000),
        };
        grant.request_digest = grant_request(&grant);
        grant.digest = grant_digest(&grant);
        grant
    }
    fn run(
        grant: &ProtectedMailSummaryGrant,
        id: &str,
        parent: Option<&str>,
    ) -> ProtectedMailSummaryRun {
        ProtectedMailSummaryRun {
            id: run_key(&grant.id, id),
            grant_id: grant.id.clone(),
            run_id: id.into(),
            parent_run_id: parent.map(str::to_owned),
            root_run_id: parent.unwrap_or(id).into(),
            depth: if parent.is_some() { 2 } else { 1 },
            service_identity: grant.service_identity,
            runtime_id: grant.runtime_id.clone(),
            request_digest: run_request(&grant.id, id, parent),
            created_at: grant.created_at,
        }
    }
    fn initial_budget(grant: &ProtectedMailSummaryGrant) -> ProtectedMailSummaryBudget {
        ProtectedMailSummaryBudget {
            grant_id: grant.id.clone(),
            generation: 1,
            remaining_operations: grant.max_operations,
            remaining_append_bytes: grant.max_append_bytes,
            last_receipt_id: None,
        }
    }

    #[test]
    fn canonical_append_golden_escaped_literal() {
        let stage = source("stage", 1, 'a');
        let bytes = payload(
            "hi\n\"quote\"\\\t\r",
            "v1",
            &stage,
            std::slice::from_ref(&stage),
        )
        .unwrap();
        assert_eq!(bytes.len(), 331);
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            "79915b3cb20545cffcf823d15da29aaa3b4acf794bcc9613883ffc9e0e2c2677"
        );
        assert!(String::from_utf8(bytes)
            .unwrap()
            .starts_with("{\"body\":\"hi\\n\\\"quote\\\"\\\\\\t\\r\",\"contractVersion\":1"));
    }

    #[test]
    fn canonical_append_golden_unicode_and_u64_revisions() {
        let parents = vec![
            source("same", 2, 'b'),
            source("same", 10, 'b'),
            source("same", 9_007_199_254_740_993, 'b'),
            source("same", u64::MAX, 'b'),
            source("\u{e000}", 1, 'c'),
            source("🍐", 1, 'd'),
        ];
        let bytes = payload(" 🍐\u{2028}e\u{301}日本語 ", "v1", &parents[0], &parents).unwrap();
        assert_eq!(bytes.len(), 890);
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            "fca432a86a3a27395da40197acc724f8290a281b39ef97a6bbe626f0c8a0d074"
        );
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("\"revision\":\"18446744073709551615\""));
        assert!(text.contains("🍐\u{2028}e\u{301}"));
    }

    #[test]
    fn payload_rejects_invalid_graph_order_and_preserves_literal_bytes() {
        let a = source("a", 2, 'a');
        let b = source("a", 10, 'b');
        let bytes = payload(" \n\t\r ", "sanitizer-1.0", &a, &[a.clone(), b.clone()]).unwrap();
        assert_ne!(
            bytes,
            payload("\n\t\r", "sanitizer-1.0", &a, &[a.clone(), b.clone()]).unwrap()
        );
        assert!(payload("", "v1", &a, std::slice::from_ref(&a)).is_ok());
        for body in ["\0", "\u{85}", "\u{7f}"] {
            assert!(payload(body, "v1", &a, std::slice::from_ref(&a)).is_err());
        }
        assert!(payload(&"x".repeat(160_001), "v1", &a, std::slice::from_ref(&a)).is_err());
        assert!(payload("x", "v1", &a, &[b.clone(), a.clone()]).is_err());
        assert!(payload("x", "v1", &a, &[a.clone(), a.clone()]).is_err());
        assert!(payload("x", "v1", &a, std::slice::from_ref(&b)).is_err());
        assert!(payload("x", " v1", &a, std::slice::from_ref(&a)).is_err());
        assert!(payload("x", "v1", &a, &[]).is_err());
    }

    #[test]
    fn canonical_payload_charges_full_envelope_not_literal_only() {
        let stage = source("stage", 1, 'a');
        let raw = "\"".repeat(100);
        let bytes = payload(&raw, "v1", &stage, std::slice::from_ref(&stage)).unwrap();
        assert!(bytes.len() > raw.len() * 2);
        let grant = grant();
        let budget = initial_budget(&grant);
        assert!(debit(&budget, bytes.len() as u64, raw.len() as u64).is_err());
        let (_, _, remaining) = debit(&budget, bytes.len() as u64, MAX_ENVELOPE as u64).unwrap();
        assert_eq!(remaining, grant.max_append_bytes - bytes.len() as u64);
    }

    #[test]
    fn grant_request_binds_each_owner_reviewed_input() {
        let original = grant_request(&grant());
        let mutations: Vec<Box<dyn Fn(&mut ProtectedMailSummaryGrant)>> = vec![
            Box::new(|g| g.id = "b".repeat(64)),
            Box::new(|g| g.owner = Identity::from_byte_array([9; 32])),
            Box::new(|g| g.collection_id += 1),
            Box::new(|g| g.connection_epoch += 1),
            Box::new(|g| g.service_identity = Identity::from_byte_array([8; 32])),
            Box::new(|g| g.runtime_id.push('x')),
            Box::new(|g| g.instruction.id.push('x')),
            Box::new(|g| g.instruction.revision += 1),
            Box::new(|g| g.instruction.digest = "f".repeat(64)),
            Box::new(|g| g.instruction_generation += 1),
            Box::new(|g| g.decision_id.push('x')),
            Box::new(|g| g.allowed_stages[0].revision += 1),
            Box::new(|g| g.allowed_stages.push(source("stage2", 1, 'f'))),
            Box::new(|g| g.not_before_ms += 1),
            Box::new(|g| g.expires_at_ms += 1),
            Box::new(|g| g.max_operations += 1),
            Box::new(|g| g.max_append_bytes += 1),
            Box::new(|g| g.max_append_bytes_per_operation += 1),
        ];
        for mutate in mutations {
            let mut changed = grant();
            mutate(&mut changed);
            assert_ne!(grant_request(&changed), original);
        }
        let mut changed = grant();
        changed.snapshot_digest = "f".repeat(64);
        assert_eq!(grant_request(&changed), original);
        assert_ne!(grant_digest(&changed), grant().digest);
    }

    #[test]
    fn length_prefixing_and_global_effect_have_separate_namespaces() {
        assert_ne!(
            hash("x", &["ab".into(), "c".into()]),
            hash("x", &["a".into(), "bc".into()])
        );
        assert_ne!(hash("x", &["a".into()]), hash("y", &["a".into()]));
        let stage = source("stage", 1, 'a');
        let workspace = Identity::from_byte_array([1; 32]);
        let effect = effect_id(workspace, 7, &stage);
        assert_ne!(
            effect,
            effect_id(Identity::from_byte_array([2; 32]), 7, &stage)
        );
        assert_ne!(effect, effect_id(workspace, 8, &stage));
        assert_ne!(effect, effect_id(workspace, 7, &source("stage", 2, 'a')));
        assert_ne!(effect, effect_id(workspace, 7, &source("stage", 1, 'b')));
        // The effect API has no grant/run/nonce inputs. Event keys have exactly
        // those inputs, independently of the stage reference.
        assert_ne!(
            admission_event("grant", "root", "nonce"),
            admission_event("grant", "child", "nonce")
        );
        assert_ne!(
            admission_event("grant", "root", "nonce"),
            admission_event("other", "root", "nonce")
        );
        assert_ne!(
            request_digest("grant", "root", &stage, "nonce"),
            request_digest("grant", "root", &source("other", 1, 'a'), "nonce")
        );
    }

    #[test]
    fn operation_fingerprint_matches_effect_run_and_actual_envelope_cost() {
        let grant = grant();
        let workspace = Identity::from_byte_array([7; 32]);
        let root = run(&grant, "root", None);
        let child = run(&grant, "child", Some("root"));
        let digest = "a".repeat(64);
        let fingerprint = operation_fingerprint(workspace, &grant, &root, 331, &digest).unwrap();
        assert_ne!(
            fingerprint,
            operation_fingerprint(workspace, &grant, &child, 331, &digest).unwrap()
        );
        assert_ne!(
            fingerprint,
            operation_fingerprint(workspace, &grant, &root, 332, &digest).unwrap()
        );
        assert_ne!(
            fingerprint,
            operation_fingerprint(workspace, &grant, &root, 331, &"b".repeat(64)).unwrap()
        );
        let mut changed = grant;
        changed.connection_epoch += 1;
        assert_ne!(
            fingerprint,
            operation_fingerprint(workspace, &changed, &root, 331, &digest).unwrap()
        );
        assert_ne!(run_request("g", "a", None), run_request("g", "a", Some("")));
    }

    #[test]
    fn shared_budget_debits_once_per_complete_logical_envelope() {
        let grant = grant();
        let budget = initial_budget(&grant);
        assert!(budget_shape(&grant, &budget));
        let (generation, operations, bytes) = debit(&budget, 331, 500).unwrap();
        assert_eq!((generation, operations, bytes), (2, 2, 9_669));
        let next = ProtectedMailSummaryBudget {
            grant_id: grant.id.clone(),
            generation,
            remaining_operations: operations,
            remaining_append_bytes: bytes,
            last_receipt_id: Some("receipt".into()),
        };
        assert!(budget_shape(&grant, &next));
        assert_eq!(debit(&next, 890, 1_000).unwrap(), (3, 1, 8_779));
        assert!(debit(&next, 501, 500).is_err());
        assert!(debit(&next, 0, 500).is_err());
        let mut bad = next;
        bad.remaining_operations += 1;
        assert!(!budget_shape(&grant, &bad));
        bad.remaining_operations = 0;
        bad.remaining_append_bytes = 1;
        assert!(debit(&bad, 1, 500).is_err());
        bad.remaining_operations = 1;
        bad.generation = SAFE;
        assert!(debit(&bad, 1, 500).is_err());
    }

    #[test]
    fn grant_limits_are_js_safe_bounded_and_never_deferred_indefinitely() {
        let mut grant = grant();
        assert!(safe_limits(&grant));
        assert!(issuance_window(&grant, 1_000));
        grant.expires_at_ms = grant.not_before_ms + MAX_TTL_MS;
        assert!(safe_limits(&grant));
        assert!(issuance_window(&grant, grant.not_before_ms));
        assert!(!issuance_window(&grant, grant.not_before_ms - 1));
        assert!(!issuance_window(&grant, grant.expires_at_ms));
        grant.expires_at_ms += 1;
        assert!(!safe_limits(&grant));
        grant.expires_at_ms = 2_000;
        grant.connection_epoch = SAFE + 1;
        assert!(!safe_limits(&grant));
        grant.connection_epoch = 0;
        assert!(!safe_limits(&grant));
        grant.connection_epoch = 1;
        grant.instruction_generation = SAFE + 1;
        assert!(!safe_limits(&grant));
        grant.instruction_generation = 1;
        grant.max_operations = SAFE;
        assert!(!safe_limits(&grant));
        grant.max_operations = 1;
        grant.max_append_bytes = SAFE + 1;
        assert!(!safe_limits(&grant));
    }

    #[test]
    fn stage_allowlist_is_exact_sorted_bounded_not_collection_wildcard() {
        let a = source("a", 2, 'a');
        let b = source("a", 10, 'b');
        assert_eq!(
            canonical_refs(&[b.clone(), a.clone()]).unwrap(),
            vec![a.clone(), b.clone()]
        );
        assert!(canonical_refs(&[a.clone(), a.clone()]).is_err());
        assert!(canonical_refs(&[a.clone(), source("a", 2, 'b')]).is_err());
        assert!(canonical_refs(&[]).is_err());
        assert!(canonical_refs(
            &(0..65)
                .map(|i| source(&format!("s{i}"), 1, 'a'))
                .collect::<Vec<_>>()
        )
        .is_err());
        assert!(!hex64(&"A".repeat(64)));
        assert!(!opaque("contains space"));
        assert!(!decision_key(&"d".repeat(64)));
        assert!(decision_key(&format!(
            "mail-instruction-decision:{}",
            "d".repeat(64)
        )));
    }
}

#[reducer]
pub fn revoke_protected_mail_summary_grant(
    ctx: &ReducerContext,
    grant_id: String,
    event_nonce: String,
) -> Result<(), String> {
    let grant = owned_grant(ctx, &grant_id)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    if event_nonce == grant.id {
        return Err(CONFLICT.into());
    }
    let request = hash(
        "pear-mail-summary-revoke-v1",
        &[grant_id.clone(), event_nonce.clone()],
    );
    if let Some(existing) = ctx
        .db
        .protected_mail_summary_grant_event()
        .id()
        .find(event_id(&grant_id, 2))
    {
        if existing.request_digest != request {
            return Err(REVOKED.into());
        }
        return Ok(());
    }
    ctx.db
        .protected_mail_summary_grant_event()
        .insert(ProtectedMailSummaryGrantEvent {
            id: event_id(&grant_id, 2),
            grant_id,
            generation: 2,
            kind: ProtectedMailSummaryGrantEventKind::Revoked,
            event_nonce,
            request_digest: request,
            grant_digest: grant.digest,
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    Ok(())
}

#[reducer]
pub fn start_protected_mail_summary_run(
    ctx: &ReducerContext,
    grant_id: String,
    run_id: String,
    parent_run_id: Option<String>,
) -> Result<(), String> {
    let grant = service_grant(ctx, &grant_id)?;
    if !opaque(&run_id) || parent_run_id.as_ref().is_some_and(|p| !opaque(p)) {
        return Err(INVALID.into());
    }
    let id = run_key(&grant_id, &run_id);
    let request = run_request(&grant_id, &run_id, parent_run_id.as_deref());
    if ctx
        .db
        .protected_mail_summary_run()
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
        .protected_mail_summary_run()
        .grant_id()
        .filter(&grant_id)
        .count()
        >= 256
    {
        return Err("protected_mail_summary_run_limit".into());
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
        return Err("protected_mail_summary_run_limit".into());
    }
    ctx.db
        .protected_mail_summary_run()
        .insert(ProtectedMailSummaryRun {
            id,
            grant_id,
            run_id,
            parent_run_id,
            root_run_id,
            depth,
            service_identity: ctx.sender(),
            runtime_id: grant.runtime_id,
            request_digest: request,
            created_at: ctx.timestamp,
        });
    Ok(())
}

fn debit(
    budget: &ProtectedMailSummaryBudget,
    bytes: u64,
    per_operation: u64,
) -> Result<(u64, u64, u64), String> {
    if bytes == 0
        || bytes > per_operation
        || budget.remaining_operations < 1
        || bytes > budget.remaining_append_bytes
    {
        return Err(BUDGET.into());
    }
    let generation = budget
        .generation
        .checked_add(1)
        .filter(|g| *g <= SAFE)
        .ok_or(INCONSISTENT)?;
    Ok((
        generation,
        budget.remaining_operations - 1,
        budget.remaining_append_bytes - bytes,
    ))
}
fn checked_completed(
    ctx: &ReducerContext,
    grant: &ProtectedMailSummaryGrant,
    run: &ProtectedMailSummaryRun,
    receipt: &ProtectedMailSummaryAdmissionReceipt,
    stage: &ProtectedMailSourceRef,
    nonce: &str,
) -> Result<(), String> {
    if receipt.grant_id != grant.id
        || receipt.run_id != run.run_id
        || receipt.root_run_id != run.root_run_id
        || receipt.service_identity != ctx.sender()
        || receipt.owner != grant.owner
        || receipt.collection_id != grant.collection_id
        || receipt.stage != *stage
        || receipt.event_nonce != nonce
        || receipt.event_id != admission_event(&grant.id, &run.run_id, nonce)
        || receipt.request_digest != request_digest(&grant.id, &run.run_id, stage, nonce)
    {
        return Err(CONFLICT.into());
    }
    let (parents, bytes) = stage_data(ctx, grant, stage, false)?;
    let payload_digest = hex::encode(Sha256::digest(&bytes));
    let summary = ctx
        .db
        .protected_mail_committed_summary()
        .id()
        .find(receipt.id.clone())
        .ok_or(INCONSISTENT)?;
    let budget = checked_budget(ctx, grant)?;
    let bindings = receipt
        .source_bindings
        .iter()
        .map(|binding| binding.source.clone())
        .collect::<Vec<_>>();
    if receipt.id != effect_id(ctx.identity(), grant.collection_id, stage)
        || receipt.payload_digest != payload_digest
        || receipt.append_bytes != bytes.len() as u64
        || receipt.operation_fingerprint
            != operation_fingerprint(
                ctx.identity(),
                grant,
                run,
                receipt.append_bytes,
                &payload_digest,
            )?
        || bindings != parents
        || receipt.source_bindings.iter().any(|b| b.generation == 0)
        || !receipt
            .source_bindings
            .iter()
            .any(|b| b.source == *stage && b.generation == receipt.stage_policy_generation)
        || receipt.budget_generation < 2
        || receipt.budget_generation > budget.generation
        || receipt.remaining_operations > grant.max_operations
        || grant.max_operations - receipt.remaining_operations + 1 != receipt.budget_generation
        || receipt.remaining_append_bytes > grant.max_append_bytes
        || receipt.remaining_append_bytes < budget.remaining_append_bytes
        || summary.owner != grant.owner
        || summary.collection_id != grant.collection_id
        || summary.stage != *stage
        || summary.receipt_id != receipt.id
        || summary.grant_id != grant.id
        || summary.run_id != run.run_id
        || summary.created_at != receipt.created_at
    {
        return Err(INCONSISTENT.into());
    }
    Ok(())
}

/// The only admitted effect in this version is promotion of one existing
/// immutable private stage. All hashes, bytes, parents and costs are server
/// derived. There is no external dispatch or first-storage/inference claim.
#[reducer]
pub fn admit_and_promote_protected_mail_derivation(
    ctx: &ReducerContext,
    grant_id: String,
    run_id: String,
    stage: ProtectedMailSourceRef,
    event_nonce: String,
) -> Result<(), String> {
    let grant = service_grant(ctx, &grant_id)?;
    let run = checked_run(ctx, &grant, &run_id)?;
    if !hex64(&event_nonce) {
        return Err(INVALID.into());
    }
    validate_source_ref(&stage).map_err(|_| INVALID)?;
    // One request namespace is independent of stages and of the global effect.
    // A changed stage under an old nonce must conflict before effect lookup.
    let event = admission_event(&grant_id, &run_id, &event_nonce);
    if let Some(receipt) = ctx
        .db
        .protected_mail_summary_admission_receipt()
        .event_id()
        .find(event.clone())
    {
        return checked_completed(ctx, &grant, &run, &receipt, &stage, &event_nonce);
    }
    if !grant.allowed_stages.contains(&stage) {
        return Err("protected_mail_summary_stage_not_allowed".into());
    }
    // A new request must be currently authorized before it can observe whether
    // another grant has consumed the stage. Only its own completed event is an
    // effect-free historical replay above.
    active(ctx, &grant)?;
    let effect = effect_id(ctx.identity(), grant.collection_id, &stage);
    if ctx
        .db
        .protected_mail_summary_admission_receipt()
        .id()
        .find(effect.clone())
        .is_some()
    {
        return Err("protected_mail_summary_effect_consumed".into());
    }
    if ctx
        .db
        .protected_mail_committed_summary()
        .id()
        .find(effect.clone())
        .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    let (parents, bytes) = stage_data(ctx, &grant, &stage, true)?;
    let policy = current_effective_policy(ctx, grant.collection_id, std::slice::from_ref(&stage))?;
    if !policy.allow_owner_storage {
        return Err("protected_mail_source_disclosure_denied".into());
    }
    if policy
        .bindings
        .iter()
        .map(|b| b.source.clone())
        .collect::<Vec<_>>()
        != parents
    {
        return Err(INCONSISTENT.into());
    }
    let stage_policy_generation = policy
        .bindings
        .iter()
        .find(|b| b.source == stage)
        .ok_or(INCONSISTENT)?
        .generation;
    let append_bytes = bytes.len() as u64;
    let budget = checked_budget(ctx, &grant)?;
    let (budget_generation, remaining_operations, remaining_append_bytes) =
        debit(&budget, append_bytes, grant.max_append_bytes_per_operation)?;
    let payload_digest = hex::encode(Sha256::digest(&bytes));
    let fingerprint =
        operation_fingerprint(ctx.identity(), &grant, &run, append_bytes, &payload_digest)?;
    ctx.db
        .protected_mail_committed_summary()
        .insert(ProtectedMailCommittedSummary {
            id: effect.clone(),
            owner: grant.owner,
            collection_id: grant.collection_id,
            stage: stage.clone(),
            grant_id: grant_id.clone(),
            run_id: run_id.clone(),
            receipt_id: effect.clone(),
            created_at: ctx.timestamp,
        });
    ctx.db.protected_mail_summary_admission_receipt().insert(
        ProtectedMailSummaryAdmissionReceipt {
            id: effect.clone(),
            event_id: event,
            grant_id: grant_id.clone(),
            run_id: run_id.clone(),
            root_run_id: run.root_run_id,
            owner: grant.owner,
            service_identity: ctx.sender(),
            collection_id: grant.collection_id,
            stage: stage.clone(),
            event_nonce: event_nonce.clone(),
            request_digest: request_digest(&grant_id, &run_id, &stage, &event_nonce),
            payload_digest,
            operation_fingerprint: fingerprint,
            append_bytes,
            budget_generation,
            remaining_operations,
            remaining_append_bytes,
            stage_policy_generation,
            source_bindings: policy.bindings,
            created_at: ctx.timestamp,
        },
    );
    ctx.db
        .protected_mail_summary_budget()
        .grant_id()
        .update(ProtectedMailSummaryBudget {
            grant_id,
            generation: budget_generation,
            remaining_operations,
            remaining_append_bytes,
            last_receipt_id: Some(effect),
        });
    Ok(())
}
