//! Staged, exact-revision instruction review. An authenticated owner decision
//! is not physical-human attestation, disclosure authority, or an admission.
//! No runner, prompt builder, model, or workflow consumes this store.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};
use spacetimedb::{
    reducer, table, view, Identity, ReducerContext, SpacetimeType, Table, Timestamp, ViewContext,
};

use super::governance::{
    current_effective_policy, resolve_source_graph, source_policy_enrolled, validate_source_ref,
    ProtectedMailSourceRef, ResolvedProtectedMailSource,
};
use super::protected::{
    authenticated_owner, protected_mail_collection, protected_mail_collection__view,
    ProtectedMailCollection,
};
use super::provenance::{protected_mail_derivation, resolve_derived_source};
use crate::ai::{ai_user_config, ai_user_profile};
use crate::auth::user;
use crate::module_install::sender_is_module_publisher;

const OWNER_REQUIRED: &str = "protected_mail_instruction_owner_required";
const INCONSISTENT: &str = "protected_mail_instruction_inconsistent";
const CONFLICT: &str = "protected_mail_instruction_event_conflict";
const STALE: &str = "protected_mail_instruction_stale";
const MAX_BODY: usize = 16 * 1024;
const MAX_PARENTS: usize = 256;

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct ProtectedMailInstructionScope {
    pub format_version: u32,
    pub scope_version: u32,
    pub purpose: String,
    pub collection_id: u64,
    pub instruction_key: String,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct ProtectedMailInstructionRef {
    pub id: String,
    pub revision: u64,
    pub digest: String,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailInstructionStatus {
    Draft,
    InstructionApproved,
    InstructionRevoked,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailInstructionDecisionKind {
    Approve,
    Revoke,
}

#[table(accessor = protected_mail_instruction_head, private)]
pub struct ProtectedMailInstructionHead {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub owner: Identity,
    pub scope: ProtectedMailInstructionScope,
    pub generation: u64,
    pub current_revision: ProtectedMailInstructionRef,
    pub status: ProtectedMailInstructionStatus,
    pub decision_id: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[table(accessor = protected_mail_instruction_revision, private)]
pub struct ProtectedMailInstructionRevision {
    #[primary_key]
    pub id: String,
    pub head_id: String,
    pub owner: Identity,
    pub scope: ProtectedMailInstructionScope,
    pub revision: u64,
    pub digest: String,
    pub body: String,
    /// "unknown" means a manual literal, never a claim of clean content.
    pub origin: String,
    pub parents: Vec<ProtectedMailSourceRef>,
    pub derived_source: Option<ProtectedMailSourceRef>,
    pub event_key: String,
    #[unique]
    pub event_id: String,
    pub request_digest: String,
    pub expected_generation: u64,
    pub editor: Identity,
    pub created_at: Timestamp,
}

#[table(accessor = protected_mail_instruction_decision, private)]
pub struct ProtectedMailInstructionDecision {
    #[primary_key]
    pub id: String,
    pub head_id: String,
    pub owner: Identity,
    pub scope: ProtectedMailInstructionScope,
    pub generation: u64,
    pub instruction: ProtectedMailInstructionRef,
    pub kind: ProtectedMailInstructionDecisionKind,
    pub event_key: String,
    #[unique]
    pub event_id: String,
    pub request_digest: String,
    pub expected_generation: u64,
    pub actor: Identity,
    pub created_at: Timestamp,
}

#[derive(SpacetimeType)]
pub struct ProtectedMailInstructionRow {
    pub scope: ProtectedMailInstructionScope,
    pub reference: ProtectedMailInstructionRef,
    pub body: String,
    pub origin: String,
    pub parents: Vec<ProtectedMailSourceRef>,
    pub generation: u64,
    pub status: ProtectedMailInstructionStatus,
    pub decision_id: Option<String>,
}

fn valid_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn valid_scope(scope: &ProtectedMailInstructionScope) -> bool {
    scope.format_version == 1
        && scope.scope_version == 1
        && scope.purpose == "mail.summary"
        && !scope.instruction_key.is_empty()
        && scope.instruction_key.len() <= 128
        && scope
            .instruction_key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

fn valid_body(body: &str) -> bool {
    body.len() <= MAX_BODY
        && !body
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}

fn hash_fields(domain: &str, fields: &[String]) -> String {
    let mut hash = Sha256::new();
    for field in std::iter::once(domain).chain(fields.iter().map(String::as_str)) {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    hex::encode(hash.finalize())
}

fn scope_fields(scope: &ProtectedMailInstructionScope) -> Vec<String> {
    vec![
        scope.format_version.to_string(),
        scope.scope_version.to_string(),
        scope.purpose.clone(),
        scope.collection_id.to_string(),
        scope.instruction_key.clone(),
    ]
}

fn head_id(scope: &ProtectedMailInstructionScope) -> String {
    format!(
        "mail-instruction-head:{}",
        hash_fields("pear-mail-instruction-head-v1", &scope_fields(scope))
    )
}

fn revision_id(head: &str, revision: u64) -> String {
    format!(
        "mail-instruction-revision:{}",
        hash_fields(
            "pear-mail-instruction-revision-v1",
            &[head.into(), revision.to_string()]
        )
    )
}

fn decision_id(head: &str, generation: u64) -> String {
    format!(
        "mail-instruction-decision:{}",
        hash_fields(
            "pear-mail-instruction-decision-v1",
            &[head.into(), generation.to_string()]
        )
    )
}

fn event_id(head: &str, event_key: &str) -> String {
    format!(
        "mail-instruction-event:{}",
        hash_fields(
            "pear-mail-instruction-event-v1",
            &[head.into(), event_key.into()]
        )
    )
}

fn append_source_fields(fields: &mut Vec<String>, reference: &ProtectedMailSourceRef) {
    fields.extend([
        reference.id.clone(),
        reference.revision.to_string(),
        reference.digest.clone(),
    ]);
}

fn content_digest(
    scope: &ProtectedMailInstructionScope,
    body: &str,
    origin: &str,
    parents: &[ProtectedMailSourceRef],
    derived_source: Option<&ProtectedMailSourceRef>,
) -> String {
    let mut fields = scope_fields(scope);
    fields.extend([body.into(), origin.into(), parents.len().to_string()]);
    for reference in parents {
        append_source_fields(&mut fields, reference);
    }
    fields.push(
        if derived_source.is_some() {
            "some"
        } else {
            "none"
        }
        .into(),
    );
    if let Some(source) = derived_source {
        append_source_fields(&mut fields, source);
    }
    hash_fields("pear-mail-instruction-content-v1", &fields)
}

fn request_digest(
    scope: &ProtectedMailInstructionScope,
    expected_generation: u64,
    event_key: &str,
    mode: &str,
    body: Option<&str>,
    source: Option<&ProtectedMailSourceRef>,
    instruction: Option<&ProtectedMailInstructionRef>,
) -> String {
    let mut fields = scope_fields(scope);
    fields.extend([
        expected_generation.to_string(),
        event_key.into(),
        mode.into(),
    ]);
    if let Some(body) = body {
        fields.push(body.into());
    }
    if let Some(source) = source {
        append_source_fields(&mut fields, source);
    }
    if let Some(instruction) = instruction {
        fields.extend([
            instruction.id.clone(),
            instruction.revision.to_string(),
            instruction.digest.clone(),
        ]);
    }
    hash_fields("pear-mail-instruction-request-v1", &fields)
}

fn canonical_parents(
    parents: &[ProtectedMailSourceRef],
) -> Result<Vec<ProtectedMailSourceRef>, String> {
    let mut canonical = BTreeMap::new();
    for parent in parents {
        validate_source_ref(parent).map_err(|_| INCONSISTENT.to_string())?;
        let key = (parent.id.clone(), parent.revision);
        if let Some(previous) = canonical.insert(key, parent.clone()) {
            if previous != *parent {
                return Err(INCONSISTENT.into());
            }
        }
    }
    if canonical.len() > MAX_PARENTS {
        return Err("protected_mail_instruction_parent_limit".into());
    }
    Ok(canonical.into_values().collect())
}

fn human_identity(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db.ai_user_config().identity().find(identity).is_none()
        && ctx.db.ai_user_profile().identity().find(identity).is_none()
        && ctx
            .db
            .user()
            .identity()
            .find(identity)
            .is_some_and(|u| u.is_authenticated)
}

fn owned_collection(
    ctx: &ReducerContext,
    scope: &ProtectedMailInstructionScope,
) -> Result<ProtectedMailCollection, String> {
    if sender_is_module_publisher(ctx) || !human_identity(ctx, ctx.sender()) || !valid_scope(scope)
    {
        return Err(OWNER_REQUIRED.into());
    }
    ctx.db
        .protected_mail_collection()
        .id()
        .find(scope.collection_id)
        .filter(|collection| collection.owner == ctx.sender())
        .ok_or_else(|| OWNER_REQUIRED.into())
}

fn publisher_collection(
    ctx: &ReducerContext,
    scope: &ProtectedMailInstructionScope,
) -> Result<ProtectedMailCollection, String> {
    if !sender_is_module_publisher(ctx) {
        return Err("protected_mail_publisher_required".into());
    }
    if !valid_scope(scope) {
        return Err(OWNER_REQUIRED.into());
    }
    ctx.db
        .protected_mail_collection()
        .id()
        .find(scope.collection_id)
        .filter(|collection| {
            collection.owner != ctx.sender() && human_identity(ctx, collection.owner)
        })
        .ok_or_else(|| OWNER_REQUIRED.into())
}

fn revision_matches(
    revision: &ProtectedMailInstructionRevision,
    collection: &ProtectedMailCollection,
) -> bool {
    let head = head_id(&revision.scope);
    valid_scope(&revision.scope)
        && revision.owner == collection.owner
        && revision.scope.collection_id == collection.id
        && revision.head_id == head
        && revision.revision > 0
        && revision.expected_generation.checked_add(1) == Some(revision.revision)
        && revision.id == revision_id(&head, revision.revision)
        && valid_hex(&revision.event_key)
        && revision.event_id == event_id(&head, &revision.event_key)
        && valid_body(&revision.body)
        && canonical_parents(&revision.parents).is_ok_and(|parents| parents == revision.parents)
        && match (&*revision.origin, &revision.derived_source) {
            ("unknown", None) => revision.editor == collection.owner,
            ("derived", Some(source)) => {
                validate_source_ref(source).is_ok() && revision.parents.contains(source)
            }
            _ => false,
        }
        && revision.digest
            == content_digest(
                &revision.scope,
                &revision.body,
                &revision.origin,
                &revision.parents,
                revision.derived_source.as_ref(),
            )
        && revision.request_digest
            == request_digest(
                &revision.scope,
                revision.expected_generation,
                &revision.event_key,
                if revision.derived_source.is_some() {
                    "draft-derived"
                } else {
                    "draft-literal"
                },
                if revision.derived_source.is_none() {
                    Some(&revision.body)
                } else {
                    None
                },
                revision.derived_source.as_ref(),
                None,
            )
}

fn decision_matches(
    decision: &ProtectedMailInstructionDecision,
    collection: &ProtectedMailCollection,
    revision: &ProtectedMailInstructionRevision,
) -> bool {
    let mode = match decision.kind {
        ProtectedMailInstructionDecisionKind::Approve => "approve",
        ProtectedMailInstructionDecisionKind::Revoke => "revoke",
    };
    decision.owner == collection.owner
        && decision.actor == collection.owner
        && decision.scope == revision.scope
        && decision.head_id == revision.head_id
        && decision.generation > revision.revision
        && decision.expected_generation.checked_add(1) == Some(decision.generation)
        && decision.id == decision_id(&decision.head_id, decision.generation)
        && decision.instruction == instruction_ref(revision)
        && valid_hex(&decision.event_key)
        && decision.event_id == event_id(&decision.head_id, &decision.event_key)
        && decision.request_digest
            == request_digest(
                &decision.scope,
                decision.expected_generation,
                &decision.event_key,
                mode,
                None,
                None,
                Some(&decision.instruction),
            )
}

fn instruction_ref(revision: &ProtectedMailInstructionRevision) -> ProtectedMailInstructionRef {
    ProtectedMailInstructionRef {
        id: revision.head_id.clone(),
        revision: revision.revision,
        digest: revision.digest.clone(),
    }
}

fn instruction_source_ref(revision: &ProtectedMailInstructionRevision) -> ProtectedMailSourceRef {
    ProtectedMailSourceRef {
        id: revision.head_id.clone(),
        revision: revision.revision,
        digest: revision.digest.clone(),
    }
}

fn source_matches(
    reference: &ProtectedMailSourceRef,
    revision: &ProtectedMailInstructionRevision,
    collection: &ProtectedMailCollection,
    head: &ProtectedMailInstructionHead,
) -> bool {
    validate_source_ref(reference).is_ok()
        && *reference == instruction_source_ref(revision)
        && revision_matches(revision, collection)
        && head.id == revision.head_id
        && head.scope == revision.scope
        && head.owner == collection.owner
        && head.current_revision.revision >= revision.revision
}

fn derived_literal_matches(
    revision: &ProtectedMailInstructionRevision,
    source: &ResolvedProtectedMailSource,
    body: &str,
    collection: &ProtectedMailCollection,
) -> bool {
    revision.derived_source.as_ref() == Some(&source.reference)
        && source.owner == collection.owner
        && source.collection_id == collection.id
        && body == revision.body
}

fn head_matches(
    head: &ProtectedMailInstructionHead,
    collection: &ProtectedMailCollection,
    revision: &ProtectedMailInstructionRevision,
    decision: Option<&ProtectedMailInstructionDecision>,
) -> bool {
    if head.owner != collection.owner
        || head.scope != revision.scope
        || head.id != head_id(&head.scope)
        || head.current_revision != instruction_ref(revision)
        || head.generation < revision.revision
        || !revision_matches(revision, collection)
    {
        return false;
    }
    match (&head.status, decision) {
        (ProtectedMailInstructionStatus::Draft, None) => {
            head.decision_id.is_none() && head.generation == revision.revision
        }
        (ProtectedMailInstructionStatus::InstructionApproved, Some(decision)) => {
            head.decision_id.as_ref() == Some(&decision.id)
                && head.generation == decision.generation
                && decision_matches(decision, collection, revision)
                && decision.kind == ProtectedMailInstructionDecisionKind::Approve
        }
        (ProtectedMailInstructionStatus::InstructionRevoked, Some(decision)) => {
            head.decision_id.as_ref() == Some(&decision.id)
                && head.generation == decision.generation
                && decision_matches(decision, collection, revision)
                && decision.kind == ProtectedMailInstructionDecisionKind::Revoke
        }
        _ => false,
    }
}

fn checked_head(
    ctx: &ReducerContext,
    collection: &ProtectedMailCollection,
    scope: &ProtectedMailInstructionScope,
) -> Result<
    Option<(
        ProtectedMailInstructionHead,
        ProtectedMailInstructionRevision,
    )>,
    String,
> {
    let Some(head) = ctx
        .db
        .protected_mail_instruction_head()
        .id()
        .find(head_id(scope))
    else {
        return Ok(None);
    };
    let revision = ctx
        .db
        .protected_mail_instruction_revision()
        .id()
        .find(revision_id(&head.id, head.current_revision.revision))
        .ok_or(OWNER_REQUIRED)?;
    let decision = head.decision_id.as_ref().map(|id| {
        ctx.db
            .protected_mail_instruction_decision()
            .id()
            .find(id.clone())
    });
    if head.scope != *scope
        || !head_matches(
            &head,
            collection,
            &revision,
            decision.as_ref().and_then(Option::as_ref),
        )
    {
        return Err(OWNER_REQUIRED.into());
    }
    Ok(Some((head, revision)))
}

/// Internal exact decision binding, not a read grant or evidence of display.
/// The admission caller separately authenticates the owner or bound service.
pub(super) fn checked_approved_instruction(
    ctx: &ReducerContext,
    collection_id: u64,
    reference: &ProtectedMailInstructionRef,
    generation: u64,
    decision_id: &str,
) -> Result<(), String> {
    let collection = ctx.db.protected_mail_collection().id().find(collection_id)
        .ok_or("protected_mail_summary_instruction_stale")?;
    let head = ctx.db.protected_mail_instruction_head().id().find(reference.id.clone())
        .ok_or("protected_mail_summary_instruction_stale")?;
    let (current, _) = checked_head(ctx, &collection, &head.scope)
        .map_err(|_| "protected_mail_summary_instruction_stale")?
        .ok_or("protected_mail_summary_instruction_stale")?;
    if current.scope.collection_id != collection_id
        || current.current_revision != *reference
        || current.generation != generation
        || current.status != ProtectedMailInstructionStatus::InstructionApproved
        || current.decision_id.as_deref() != Some(decision_id)
    {
        return Err("protected_mail_summary_instruction_stale".into());
    }
    Ok(())
}

/// An immutable instruction revision is trackable data regardless of its
/// current decision or policy. Current instruction authority is a separate
/// future admission check; old references must never lose their ancestry.
pub(super) fn resolve_instruction_source(
    ctx: &ReducerContext,
    reference: &ProtectedMailSourceRef,
) -> Result<Option<ResolvedProtectedMailSource>, String> {
    if !reference.id.starts_with("mail-instruction-head:") {
        return Ok(None);
    }
    let revision = ctx
        .db
        .protected_mail_instruction_revision()
        .id()
        .find(revision_id(&reference.id, reference.revision))
        .ok_or("protected_mail_source_missing")?;
    let collection = ctx
        .db
        .protected_mail_collection()
        .id()
        .find(revision.scope.collection_id)
        .ok_or(INCONSISTENT)?;
    let (head, _) = checked_head(ctx, &collection, &revision.scope)?.ok_or(INCONSISTENT)?;
    if !source_matches(reference, &revision, &collection, &head) {
        return Err("protected_mail_source_conflict".into());
    }
    if let Some(source) = &revision.derived_source {
        let resolved = resolve_derived_source(ctx, source)?.ok_or(INCONSISTENT)?;
        let derivation = ctx
            .db
            .protected_mail_derivation()
            .source_id()
            .find(source.id.clone())
            .ok_or(INCONSISTENT)?;
        if !derived_literal_matches(&revision, &resolved, &derivation.body, &collection) {
            return Err(INCONSISTENT.into());
        }
    }
    Ok(Some(ResolvedProtectedMailSource {
        reference: reference.clone(),
        owner: collection.owner,
        collection_id: collection.id,
        parents: revision.parents,
    }))
}

fn require_current_source(
    reference: &ProtectedMailSourceRef,
    current: &ProtectedMailInstructionRevision,
) -> Result<(), String> {
    if *reference != instruction_source_ref(current) {
        return Err("protected_mail_instruction_source_not_current".into());
    }
    Ok(())
}

/// First enrollment must serialize with edits. A historical unenrolled
/// revision cannot acquire a ceiling after a successor omitted that edge.
/// Existing-policy replay never calls this gate and never changes authority.
pub(super) fn require_current_instruction_for_initial_policy(
    ctx: &ReducerContext,
    reference: &ProtectedMailSourceRef,
) -> Result<(), String> {
    if !reference.id.starts_with("mail-instruction-head:") {
        return Ok(());
    }
    let head = ctx
        .db
        .protected_mail_instruction_head()
        .id()
        .find(reference.id.clone())
        .ok_or(OWNER_REQUIRED)?;
    let collection = publisher_collection(ctx, &head.scope)?;
    let (_, current) = checked_head(ctx, &collection, &head.scope)?.ok_or(OWNER_REQUIRED)?;
    require_current_source(reference, &current)
}

/// One namespace covers drafts and decisions. A historical replay validates
/// its original immutable row, then returns without touching the current head.
fn historical_replay(
    ctx: &ReducerContext,
    collection: &ProtectedMailCollection,
    head: &str,
    event_key: &str,
    digest: &str,
    actor: Identity,
) -> Result<bool, String> {
    let event = event_id(head, event_key);
    let revision = ctx
        .db
        .protected_mail_instruction_revision()
        .event_id()
        .find(event.clone());
    let decision = ctx
        .db
        .protected_mail_instruction_decision()
        .event_id()
        .find(event);
    if revision.is_some() && decision.is_some() {
        return Err(INCONSISTENT.into());
    }
    if let Some(revision) = revision {
        if !revision_matches(&revision, collection) {
            return Err(INCONSISTENT.into());
        }
        if revision.editor != actor || revision.request_digest != digest {
            return Err(CONFLICT.into());
        }
        return Ok(true);
    }
    if let Some(decision) = decision {
        let revision = ctx
            .db
            .protected_mail_instruction_revision()
            .id()
            .find(revision_id(
                &decision.head_id,
                decision.instruction.revision,
            ))
            .ok_or(INCONSISTENT)?;
        if !revision_matches(&revision, collection)
            || !decision_matches(&decision, collection, &revision)
        {
            return Err(INCONSISTENT.into());
        }
        if decision.actor != actor || decision.request_digest != digest {
            return Err(CONFLICT.into());
        }
        return Ok(true);
    }
    Ok(false)
}

fn next_generation(current: u64, expected: u64) -> Result<u64, String> {
    if current != expected {
        return Err(STALE.into());
    }
    current
        .checked_add(1)
        .ok_or_else(|| "protected_mail_instruction_generation_exhausted".into())
}

fn retained_parents(
    ctx: &ReducerContext,
    collection: &ProtectedMailCollection,
    previous: Option<&ProtectedMailInstructionRevision>,
    additional: &[ProtectedMailSourceRef],
) -> Result<Vec<ProtectedMailSourceRef>, String> {
    let enrolled = previous
        .map(|revision| source_policy_enrolled(ctx, &instruction_source_ref(revision)))
        .transpose()?
        .unwrap_or(false);
    let parents = draft_parent_refs(previous, additional, enrolled)?;
    if parents.is_empty() {
        return Ok(parents);
    }
    let closure = resolve_source_graph(ctx, collection.id, &parents)?;
    let parents = closure
        .into_iter()
        .map(|source| source.reference)
        .collect::<Vec<_>>();
    let policy = current_effective_policy(ctx, collection.id, &parents)?;
    if !policy.allow_owner_storage {
        return Err("protected_mail_source_disclosure_denied".into());
    }
    Ok(parents)
}

fn draft_parent_refs(
    previous: Option<&ProtectedMailInstructionRevision>,
    additional: &[ProtectedMailSourceRef],
    previous_enrolled: bool,
) -> Result<Vec<ProtectedMailSourceRef>, String> {
    let mut additional = additional.to_vec();
    if previous_enrolled {
        additional.push(instruction_source_ref(previous.ok_or(INCONSISTENT)?));
    }
    merge_parent_refs(
        previous.map_or(&[], |revision| revision.parents.as_slice()),
        &additional,
    )
}

fn merge_parent_refs(
    previous: &[ProtectedMailSourceRef],
    additional: &[ProtectedMailSourceRef],
) -> Result<Vec<ProtectedMailSourceRef>, String> {
    let mut parents = previous.to_vec();
    parents.extend_from_slice(additional);
    canonical_parents(&parents)
}

fn insert_draft(
    ctx: &ReducerContext,
    collection: ProtectedMailCollection,
    scope: ProtectedMailInstructionScope,
    expected_generation: u64,
    event_key: String,
    body: String,
    derived_source: Option<ProtectedMailSourceRef>,
    request: String,
    existing: Option<(
        ProtectedMailInstructionHead,
        ProtectedMailInstructionRevision,
    )>,
) -> Result<(), String> {
    if !valid_body(&body) {
        return Err("protected_mail_instruction_invalid_body".into());
    }
    let generation = next_generation(
        existing.as_ref().map_or(0, |(head, _)| head.generation),
        expected_generation,
    )?;
    let parents = retained_parents(
        ctx,
        &collection,
        existing.as_ref().map(|(_, revision)| revision),
        derived_source.as_slice(),
    )?;
    let origin = if derived_source.is_some() {
        "derived"
    } else {
        "unknown"
    }
    .to_string();
    let id = head_id(&scope);
    let digest = content_digest(&scope, &body, &origin, &parents, derived_source.as_ref());
    let reference = ProtectedMailInstructionRef {
        id: id.clone(),
        revision: generation,
        digest: digest.clone(),
    };
    let source = ProtectedMailSourceRef {
        id: reference.id.clone(),
        revision: reference.revision,
        digest: reference.digest.clone(),
    };
    let revision = ProtectedMailInstructionRevision {
        id: revision_id(&id, generation),
        head_id: id.clone(),
        owner: collection.owner,
        scope: scope.clone(),
        revision: generation,
        digest,
        body,
        origin,
        parents,
        derived_source,
        event_id: event_id(&id, &event_key),
        event_key,
        request_digest: request,
        expected_generation,
        editor: ctx.sender(),
        created_at: ctx.timestamp,
    };
    if ctx
        .db
        .protected_mail_instruction_revision()
        .id()
        .find(revision.id.clone())
        .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    ctx.db
        .protected_mail_instruction_revision()
        .insert(revision);
    let head = ProtectedMailInstructionHead {
        id,
        owner: collection.owner,
        scope,
        generation,
        current_revision: reference,
        status: ProtectedMailInstructionStatus::Draft,
        decision_id: None,
        created_at: existing
            .as_ref()
            .map_or(ctx.timestamp, |(head, _)| head.created_at),
        updated_at: ctx.timestamp,
    };
    if existing.is_some() {
        ctx.db.protected_mail_instruction_head().id().update(head);
    } else {
        ctx.db.protected_mail_instruction_head().insert(head);
    }
    // Include this wrapper in both bounds, not just its parents. Any failure
    // rolls back the new revision and head in the same reducer transaction.
    resolve_source_graph(ctx, collection.id, std::slice::from_ref(&source))?;
    Ok(())
}

#[reducer]
pub fn draft_protected_mail_instruction(
    ctx: &ReducerContext,
    scope: ProtectedMailInstructionScope,
    expected_generation: u64,
    event_key: String,
    body: String,
) -> Result<(), String> {
    let collection = owned_collection(ctx, &scope)?;
    if !valid_hex(&event_key) {
        return Err("protected_mail_instruction_invalid_event".into());
    }
    let existing = checked_head(ctx, &collection, &scope)?;
    let request = request_digest(
        &scope,
        expected_generation,
        &event_key,
        "draft-literal",
        Some(&body),
        None,
        None,
    );
    if historical_replay(
        ctx,
        &collection,
        &head_id(&scope),
        &event_key,
        &request,
        ctx.sender(),
    )? {
        return Ok(());
    }
    insert_draft(
        ctx,
        collection,
        scope,
        expected_generation,
        event_key,
        body,
        None,
        request,
        existing,
    )
}

#[reducer]
pub fn draft_protected_mail_instruction_from_derivation(
    ctx: &ReducerContext,
    scope: ProtectedMailInstructionScope,
    expected_generation: u64,
    event_key: String,
    source: ProtectedMailSourceRef,
) -> Result<(), String> {
    let collection = publisher_collection(ctx, &scope)?;
    if !valid_hex(&event_key) {
        return Err("protected_mail_instruction_invalid_event".into());
    }
    let existing = checked_head(ctx, &collection, &scope)?;
    let request = request_digest(
        &scope,
        expected_generation,
        &event_key,
        "draft-derived",
        None,
        Some(&source),
        None,
    );
    if historical_replay(
        ctx,
        &collection,
        &head_id(&scope),
        &event_key,
        &request,
        ctx.sender(),
    )? {
        return Ok(());
    }
    let resolved = resolve_derived_source(ctx, &source)
        .ok()
        .flatten()
        .filter(|source| source.owner == collection.owner && source.collection_id == collection.id)
        .ok_or(OWNER_REQUIRED)?;
    if resolved.reference != source {
        return Err(OWNER_REQUIRED.into());
    }
    let derivation = ctx
        .db
        .protected_mail_derivation()
        .source_id()
        .find(source.id.clone())
        .ok_or(OWNER_REQUIRED)?;
    insert_draft(
        ctx,
        collection,
        scope,
        expected_generation,
        event_key,
        derivation.body,
        Some(source),
        request,
        existing,
    )
}

fn decide(
    ctx: &ReducerContext,
    scope: ProtectedMailInstructionScope,
    expected_generation: u64,
    event_key: String,
    instruction: ProtectedMailInstructionRef,
    kind: ProtectedMailInstructionDecisionKind,
) -> Result<(), String> {
    let collection = owned_collection(ctx, &scope)?;
    let (head, current) = checked_head(ctx, &collection, &scope)?.ok_or(OWNER_REQUIRED)?;
    if instruction.id != head.id || instruction.revision == 0 || !valid_hex(&instruction.digest) {
        return Err(OWNER_REQUIRED.into());
    }
    let revision = ctx
        .db
        .protected_mail_instruction_revision()
        .id()
        .find(revision_id(&head.id, instruction.revision))
        .ok_or(OWNER_REQUIRED)?;
    if !revision_matches(&revision, &collection) || instruction != instruction_ref(&revision) {
        return Err(OWNER_REQUIRED.into());
    }
    if !valid_hex(&event_key) {
        return Err("protected_mail_instruction_invalid_event".into());
    }
    let mode = match kind {
        ProtectedMailInstructionDecisionKind::Approve => "approve",
        ProtectedMailInstructionDecisionKind::Revoke => "revoke",
    };
    let request = request_digest(
        &scope,
        expected_generation,
        &event_key,
        mode,
        None,
        None,
        Some(&instruction),
    );
    if historical_replay(
        ctx,
        &collection,
        &head.id,
        &event_key,
        &request,
        ctx.sender(),
    )? {
        return Ok(());
    }
    let generation = next_generation(head.generation, expected_generation)?;
    if instruction != instruction_ref(&current) {
        return Err(STALE.into());
    }
    let decision_id = decision_id(&head.id, generation);
    if ctx
        .db
        .protected_mail_instruction_decision()
        .id()
        .find(decision_id.clone())
        .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    ctx.db
        .protected_mail_instruction_decision()
        .insert(ProtectedMailInstructionDecision {
            id: decision_id.clone(),
            head_id: head.id.clone(),
            owner: collection.owner,
            scope: scope.clone(),
            generation,
            instruction,
            kind: kind.clone(),
            event_id: event_id(&head.id, &event_key),
            event_key,
            request_digest: request,
            expected_generation,
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    ctx.db
        .protected_mail_instruction_head()
        .id()
        .update(ProtectedMailInstructionHead {
            generation,
            status: match kind {
                ProtectedMailInstructionDecisionKind::Approve => {
                    ProtectedMailInstructionStatus::InstructionApproved
                }
                ProtectedMailInstructionDecisionKind::Revoke => {
                    ProtectedMailInstructionStatus::InstructionRevoked
                }
            },
            decision_id: Some(decision_id),
            updated_at: ctx.timestamp,
            ..head
        });
    Ok(())
}

#[reducer]
pub fn approve_protected_mail_instruction(
    ctx: &ReducerContext,
    scope: ProtectedMailInstructionScope,
    expected_generation: u64,
    event_key: String,
    instruction: ProtectedMailInstructionRef,
) -> Result<(), String> {
    decide(
        ctx,
        scope,
        expected_generation,
        event_key,
        instruction,
        ProtectedMailInstructionDecisionKind::Approve,
    )
}

#[reducer]
pub fn revoke_protected_mail_instruction(
    ctx: &ReducerContext,
    scope: ProtectedMailInstructionScope,
    expected_generation: u64,
    event_key: String,
    instruction: ProtectedMailInstructionRef,
) -> Result<(), String> {
    decide(
        ctx,
        scope,
        expected_generation,
        event_key,
        instruction,
        ProtectedMailInstructionDecisionKind::Revoke,
    )
}

#[view(accessor = my_protected_mail_instructions, public)]
pub fn my_protected_mail_instructions(ctx: &ViewContext) -> Vec<ProtectedMailInstructionRow> {
    if !authenticated_owner(ctx) {
        return vec![];
    }
    let collections: BTreeMap<_, _> = ctx
        .db
        .protected_mail_collection()
        .owner()
        .filter(ctx.sender())
        .map(|collection| (collection.id, collection))
        .collect();
    ctx.db
        .protected_mail_instruction_head()
        .owner()
        .filter(ctx.sender())
        .filter_map(|head| {
            let collection = collections.get(&head.scope.collection_id)?;
            let revision = ctx
                .db
                .protected_mail_instruction_revision()
                .id()
                .find(revision_id(&head.id, head.current_revision.revision))?;
            let decision = head.decision_id.as_ref().map(|id| {
                ctx.db
                    .protected_mail_instruction_decision()
                    .id()
                    .find(id.clone())
            });
            if !head_matches(
                &head,
                collection,
                &revision,
                decision.as_ref().and_then(Option::as_ref),
            ) {
                return None;
            }
            Some(ProtectedMailInstructionRow {
                scope: head.scope,
                reference: head.current_revision,
                body: revision.body,
                origin: revision.origin,
                parents: revision.parents,
                generation: head.generation,
                status: head.status,
                decision_id: head.decision_id,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> Identity {
        Identity::from_byte_array([1; 32])
    }
    fn time() -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(1)
    }
    fn scope() -> ProtectedMailInstructionScope {
        ProtectedMailInstructionScope {
            format_version: 1,
            scope_version: 1,
            purpose: "mail.summary".into(),
            collection_id: 7,
            instruction_key: "summary-rules".into(),
        }
    }
    fn collection() -> ProtectedMailCollection {
        ProtectedMailCollection {
            id: 7,
            owner: owner(),
            created_at: time(),
        }
    }
    fn source(id: &str) -> ProtectedMailSourceRef {
        ProtectedMailSourceRef {
            id: id.into(),
            revision: 1,
            digest: "a".repeat(64),
        }
    }
    fn revision(generation: u64) -> ProtectedMailInstructionRevision {
        let scope = scope();
        let id = head_id(&scope);
        let body = "  Literal instruction\r\nKeep exact bytes.\t";
        let event_key = format!("{generation:064x}");
        ProtectedMailInstructionRevision {
            id: revision_id(&id, generation),
            head_id: id.clone(),
            owner: owner(),
            scope: scope.clone(),
            revision: generation,
            digest: content_digest(&scope, body, "unknown", &[], None),
            body: body.into(),
            origin: "unknown".into(),
            parents: vec![],
            derived_source: None,
            event_id: event_id(&id, &event_key),
            request_digest: request_digest(
                &scope,
                generation - 1,
                &event_key,
                "draft-literal",
                Some(body),
                None,
                None,
            ),
            event_key,
            expected_generation: generation - 1,
            editor: owner(),
            created_at: time(),
        }
    }
    fn decision(
        revision: &ProtectedMailInstructionRevision,
        generation: u64,
        kind: ProtectedMailInstructionDecisionKind,
    ) -> ProtectedMailInstructionDecision {
        let instruction = instruction_ref(revision);
        let mode = if kind == ProtectedMailInstructionDecisionKind::Approve {
            "approve"
        } else {
            "revoke"
        };
        let event_key = format!("{generation:064x}");
        ProtectedMailInstructionDecision {
            id: decision_id(&revision.head_id, generation),
            head_id: revision.head_id.clone(),
            owner: owner(),
            scope: scope(),
            generation,
            instruction: instruction.clone(),
            kind,
            event_id: event_id(&revision.head_id, &event_key),
            request_digest: request_digest(
                &scope(),
                generation - 1,
                &event_key,
                mode,
                None,
                None,
                Some(&instruction),
            ),
            event_key,
            expected_generation: generation - 1,
            actor: owner(),
            created_at: time(),
        }
    }
    fn head(
        revision: &ProtectedMailInstructionRevision,
        generation: u64,
        status: ProtectedMailInstructionStatus,
        decision: Option<&ProtectedMailInstructionDecision>,
    ) -> ProtectedMailInstructionHead {
        ProtectedMailInstructionHead {
            id: revision.head_id.clone(),
            owner: owner(),
            scope: scope(),
            generation,
            current_revision: instruction_ref(revision),
            status,
            decision_id: decision.map(|decision| decision.id.clone()),
            created_at: time(),
            updated_at: time(),
        }
    }

    #[test]
    fn fixed_scope_has_no_implicit_version_purpose_or_key_coercion() {
        assert!(valid_scope(&scope()));
        for field in 0..7 {
            let mut changed = scope();
            match field {
                0 => changed.format_version = 2,
                1 => changed.scope_version = 2,
                2 => changed.purpose = "mail.send".into(),
                3 => changed.instruction_key = String::new(),
                4 => changed.instruction_key = "key with space".into(),
                5 => changed.instruction_key = "é".into(),
                _ => changed.instruction_key = "a".repeat(129),
            }
            assert!(!valid_scope(&changed));
        }
        let mut changed = scope();
        changed.collection_id += 1;
        assert_ne!(head_id(&scope()), head_id(&changed));
    }

    #[test]
    fn literal_bytes_are_never_trimmed_normalized_or_truncated() {
        assert!(valid_body(""));
        assert!(valid_body("  literal\r\n\t  "));
        assert!(valid_body(&"é".repeat(8192)));
        assert!(!valid_body(&"é".repeat(8193)));
        for body in ["secret\0", "bad\u{7f}", "bad\u{1b}", "bad\u{85}"] {
            assert!(!valid_body(body));
        }
        assert_ne!(
            content_digest(&scope(), "text", "unknown", &[], None),
            content_digest(&scope(), " text", "unknown", &[], None)
        );
        assert_ne!(
            content_digest(&scope(), "a\r\nb", "unknown", &[], None),
            content_digest(&scope(), "a\nb", "unknown", &[], None)
        );
    }

    #[test]
    fn content_binding_includes_complete_scope_origin_and_exact_source_references() {
        let a = source("a");
        let b = source("b");
        let digest = content_digest(&scope(), "body", "derived", &[a.clone()], Some(&a));
        for field in 0..5 {
            let mut changed = scope();
            match field {
                0 => changed.format_version += 1,
                1 => changed.scope_version += 1,
                2 => changed.purpose.push('x'),
                3 => changed.collection_id += 1,
                _ => changed.instruction_key.push('x'),
            }
            assert_ne!(
                digest,
                content_digest(&changed, "body", "derived", &[a.clone()], Some(&a))
            );
        }
        assert_ne!(
            digest,
            content_digest(&scope(), "body", "unknown", &[a.clone()], None)
        );
        assert_ne!(
            digest,
            content_digest(
                &scope(),
                "body",
                "derived",
                &[a.clone(), b.clone()],
                Some(&a)
            )
        );
        assert_ne!(
            digest,
            content_digest(&scope(), "body", "derived", &[a], Some(&b))
        );
    }

    #[test]
    fn event_namespace_is_shared_but_requests_bind_mode_actor_inputs_and_generation() {
        let event = "e".repeat(64);
        let source = source("derived-source");
        let reference = instruction_ref(&revision(1));
        let literal = request_digest(
            &scope(),
            0,
            &event,
            "draft-literal",
            Some("body"),
            None,
            None,
        );
        let derived = request_digest(
            &scope(),
            0,
            &event,
            "draft-derived",
            None,
            Some(&source),
            None,
        );
        let approved = request_digest(&scope(), 0, &event, "approve", None, None, Some(&reference));
        let revoked = request_digest(&scope(), 0, &event, "revoke", None, None, Some(&reference));
        let unique = [literal.clone(), derived.clone(), approved, revoked]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(unique.len(), 4);
        assert_ne!(
            literal,
            request_digest(
                &scope(),
                1,
                &event,
                "draft-literal",
                Some("body"),
                None,
                None
            )
        );
        let mut changed = source.clone();
        changed.revision += 1;
        assert_ne!(
            derived,
            request_digest(
                &scope(),
                0,
                &event,
                "draft-derived",
                None,
                Some(&changed),
                None
            )
        );
        let id = head_id(&scope());
        assert_ne!(event_id(&id, &event), revision_id(&id, 1));
        assert_ne!(revision_id(&id, 1), decision_id(&id, 1));
    }

    #[test]
    fn retained_ancestry_cannot_be_removed_or_collapsed_by_source_id() {
        let a = source("same-source");
        let mut newer = a.clone();
        newer.revision = 2;
        newer.digest = "b".repeat(64);
        let parents = merge_parent_refs(&[a.clone()], &[newer.clone(), a.clone()]).unwrap();
        assert_eq!(parents, vec![a.clone(), newer]);
        assert_eq!(merge_parent_refs(&parents, &[]).unwrap(), parents);
        let mut conflict = a.clone();
        conflict.digest = "c".repeat(64);
        assert!(merge_parent_refs(&[a], &[conflict]).is_err());
        let too_many = (0..257)
            .map(|i| source(&format!("source-{i:03}")))
            .collect::<Vec<_>>();
        assert_eq!(
            canonical_parents(&too_many).unwrap_err(),
            "protected_mail_instruction_parent_limit"
        );
    }

    #[test]
    fn instruction_source_is_exact_immutable_data_across_later_edits_and_decisions() {
        let old = revision(1);
        let current = revision(3);
        let approval = decision(&current, 4, ProtectedMailInstructionDecisionKind::Approve);
        let current_head = head(
            &current,
            4,
            ProtectedMailInstructionStatus::InstructionApproved,
            Some(&approval),
        );
        let reference = instruction_source_ref(&old);
        assert_eq!(reference.id, instruction_ref(&old).id);
        assert_eq!(reference.revision, instruction_ref(&old).revision);
        assert_eq!(reference.digest, instruction_ref(&old).digest);
        assert!(source_matches(
            &reference,
            &old,
            &collection(),
            &current_head
        ));
        for field in 0..6 {
            let mut reference = instruction_source_ref(&old);
            let mut changed_collection = collection();
            let mut changed_head = head(&current, 3, ProtectedMailInstructionStatus::Draft, None);
            match field {
                0 => reference.digest = "b".repeat(64),
                1 => reference.revision += 1,
                2 => reference.id.push('x'),
                3 => changed_collection.owner = Identity::from_byte_array([2; 32]),
                4 => changed_head.scope.instruction_key.push('x'),
                _ => changed_head.current_revision.revision = 0,
            }
            assert!(!source_matches(
                &reference,
                &old,
                &changed_collection,
                &changed_head
            ));
        }
    }

    #[test]
    fn derived_instruction_source_checks_literal_copy_even_with_a_self_consistent_digest() {
        let mut derived = revision(1);
        let parent = source("mail-derived-source:fixture");
        derived.origin = "derived".into();
        derived.derived_source = Some(parent.clone());
        derived.parents = vec![parent.clone()];
        derived.digest = content_digest(
            &derived.scope,
            &derived.body,
            &derived.origin,
            &derived.parents,
            derived.derived_source.as_ref(),
        );
        derived.request_digest = request_digest(
            &derived.scope,
            derived.expected_generation,
            &derived.event_key,
            "draft-derived",
            None,
            Some(&parent),
            None,
        );
        let resolved = ResolvedProtectedMailSource {
            reference: parent,
            owner: owner(),
            collection_id: collection().id,
            parents: vec![],
        };
        assert!(revision_matches(&derived, &collection()));
        assert!(derived_literal_matches(
            &derived,
            &resolved,
            &derived.body,
            &collection()
        ));
        let exact = derived.body.clone();
        derived.body.push('x');
        derived.digest = content_digest(
            &derived.scope,
            &derived.body,
            &derived.origin,
            &derived.parents,
            derived.derived_source.as_ref(),
        );
        assert!(revision_matches(&derived, &collection()));
        assert!(!derived_literal_matches(
            &derived,
            &resolved,
            &exact,
            &collection()
        ));
    }

    #[test]
    fn enrollment_and_edit_order_cannot_add_a_late_ceiling_or_drop_an_existing_one() {
        let first = revision(1);
        let first_source = instruction_source_ref(&first);
        assert!(require_current_source(&first_source, &first).is_ok());
        // Enrollment wins first: the edit must retain this exact source.
        let mut second = revision(2);
        second.parents = draft_parent_refs(Some(&first), &[], true).unwrap();
        assert_eq!(second.parents, vec![first_source.clone()]);
        // Edit wins first: the now-historical first revision cannot enroll.
        assert_eq!(
            require_current_source(&first_source, &second),
            Err("protected_mail_instruction_source_not_current".into())
        );
        assert!(draft_parent_refs(Some(&first), &[], false)
            .unwrap()
            .is_empty());
        // Even an unenrolled intermediate edit cannot shed a prior ceiling.
        assert_eq!(
            draft_parent_refs(Some(&second), &[], false).unwrap(),
            second.parents
        );
        assert_eq!(draft_parent_refs(None, &[], true), Err(INCONSISTENT.into()));
    }

    #[test]
    fn enrolled_predecessor_and_known_ancestry_are_retained_for_every_edit_mode() {
        let mut previous = revision(1);
        let known = source("mail-source:known");
        previous.parents = vec![known.clone()];
        let additional = source("mail-derived-source:new");
        let expected = canonical_parents(&[
            known.clone(),
            instruction_source_ref(&previous),
            additional.clone(),
        ])
        .unwrap();
        assert_eq!(
            draft_parent_refs(Some(&previous), &[additional], true).unwrap(),
            expected
        );
        let manual = draft_parent_refs(Some(&previous), &[], true).unwrap();
        assert!(manual.contains(&known));
        assert!(manual.contains(&instruction_source_ref(&previous)));
        assert_eq!(
            draft_parent_refs(Some(&previous), &manual, true).unwrap(),
            manual
        );
    }

    #[test]
    fn identical_edit_and_revert_are_distinct_unapproved_revisions() {
        let old = revision(1);
        let approval = decision(&old, 2, ProtectedMailInstructionDecisionKind::Approve);
        let approved = head(
            &old,
            2,
            ProtectedMailInstructionStatus::InstructionApproved,
            Some(&approval),
        );
        assert!(head_matches(
            &approved,
            &collection(),
            &old,
            Some(&approval)
        ));
        let edited = revision(3);
        assert_eq!(old.body, edited.body);
        assert_eq!(old.digest, edited.digest);
        assert_ne!(instruction_ref(&old), instruction_ref(&edited));
        let draft = head(&edited, 3, ProtectedMailInstructionStatus::Draft, None);
        assert!(head_matches(&draft, &collection(), &edited, None));
        assert!(!head_matches(
            &approved,
            &collection(),
            &edited,
            Some(&approval)
        ));
        assert!(!head_matches(
            &head(
                &edited,
                3,
                ProtectedMailInstructionStatus::InstructionApproved,
                Some(&approval)
            ),
            &collection(),
            &edited,
            Some(&approval)
        ));
    }

    #[test]
    fn old_approval_cannot_describe_revoked_or_later_approved_head() {
        let revision = revision(1);
        let old = decision(&revision, 2, ProtectedMailInstructionDecisionKind::Approve);
        let revoked = decision(&revision, 3, ProtectedMailInstructionDecisionKind::Revoke);
        let revoked_head = head(
            &revision,
            3,
            ProtectedMailInstructionStatus::InstructionRevoked,
            Some(&revoked),
        );
        assert!(head_matches(
            &revoked_head,
            &collection(),
            &revision,
            Some(&revoked)
        ));
        assert!(!head_matches(
            &revoked_head,
            &collection(),
            &revision,
            Some(&old)
        ));
        let fresh = decision(&revision, 4, ProtectedMailInstructionDecisionKind::Approve);
        assert!(head_matches(
            &head(
                &revision,
                4,
                ProtectedMailInstructionStatus::InstructionApproved,
                Some(&fresh)
            ),
            &collection(),
            &revision,
            Some(&fresh)
        ));
        assert!(!head_matches(
            &head(
                &revision,
                4,
                ProtectedMailInstructionStatus::InstructionApproved,
                Some(&old)
            ),
            &collection(),
            &revision,
            Some(&old)
        ));
    }

    #[test]
    fn review_associations_fail_closed_on_body_parents_scope_actor_or_decision_tamper() {
        for field in 0..5 {
            let mut record = revision(1);
            match field {
                0 => record.body.push('x'),
                1 => record.parents.push(source("hidden-parent")),
                2 => record.scope.scope_version += 1,
                3 => record.editor = Identity::from_byte_array([2; 32]),
                _ => record.event_key = "b".repeat(64),
            }
            assert!(!revision_matches(&record, &collection()));
        }
        let record = revision(1);
        let mut approval = decision(&record, 2, ProtectedMailInstructionDecisionKind::Approve);
        approval.actor = Identity::from_byte_array([2; 32]);
        assert!(!decision_matches(&approval, &collection(), &record));
    }

    #[test]
    fn generation_cas_and_overflow_are_explicit() {
        assert_eq!(next_generation(0, 0).unwrap(), 1);
        assert_eq!(next_generation(7, 7).unwrap(), 8);
        assert_eq!(next_generation(7, 6).unwrap_err(), STALE);
        assert_eq!(
            next_generation(u64::MAX, u64::MAX).unwrap_err(),
            "protected_mail_instruction_generation_exhausted"
        );
    }
}
