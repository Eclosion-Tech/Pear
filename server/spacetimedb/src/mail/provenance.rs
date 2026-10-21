//! Private, host-registered exposure history. These records describe declared
//! context exposure; they neither prove complete tracking nor admit an effect.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};
use spacetimedb::{reducer, table, Identity, ReducerContext, Table, Timestamp};

use super::governance::{
    current_effective_policy, install_derived_policy, install_accepted_result_policy, resolve_source_graph, ProtectedMailSourceRef,
    ResolvedProtectedMailSource,
};
use super::protected::{
    paused_human_connection, protected_mail_collection, ProtectedMailCollection,
};
use crate::module_install::sender_is_module_publisher;
use super::results::AuthorizedResultWrite;

const MAX_DIRECT: usize = 64;
const MAX_INHERITED: usize = 16;
const MAX_MEMBERS: usize = 256;
const DERIVED_REVISION: u64 = 1;
const RESULT_RUNTIME: &str = "inference-result-v1";
const RESULT_SANITIZATION: &str = "sentinel-result-v1";

#[table(accessor = protected_mail_context, private)]
pub struct ProtectedMailContext {
    #[primary_key]
    pub id: String,
    pub owner: Identity,
    #[index(btree)]
    pub collection_id: u64,
    pub runtime_id: String,
    pub run_id: String,
    pub latest_generation: u64,
    pub latest_exposure_id: Option<String>,
    pub blocked: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[table(accessor = protected_mail_exposure, private)]
pub struct ProtectedMailExposure {
    #[primary_key]
    pub id: String,
    pub owner: Identity,
    #[index(btree)]
    pub collection_id: u64,
    pub context_id: String,
    pub runtime_id: String,
    pub run_id: String,
    pub event_key: String,
    pub request_digest: String,
    pub generation: u64,
    pub previous_id: Option<String>,
    pub added_sources: Vec<ProtectedMailSourceRef>,
    pub inherited_exposure_ids: Vec<String>,
    /// Complete sorted source closure, never model-selected citations.
    pub members: Vec<ProtectedMailSourceRef>,
    pub created_at: Timestamp,
}

#[table(accessor = protected_mail_derivation, private)]
pub struct ProtectedMailDerivation {
    #[primary_key]
    pub id: String,
    #[unique]
    pub source_id: String,
    pub owner: Identity,
    #[index(btree)]
    pub collection_id: u64,
    pub context_id: String,
    pub exposure_id: String,
    pub event_key: String,
    pub request_digest: String,
    pub revision: u64,
    pub digest: String,
    pub body: String,
    pub sanitization_version: String,
    pub parents: Vec<ProtectedMailSourceRef>,
    pub created_at: Timestamp,
}

fn hash_fields<'a>(domain: &'a str, values: impl IntoIterator<Item = &'a str>) -> String {
    let mut hash = Sha256::new();
    for value in std::iter::once(domain).chain(values) {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    hex::encode(hash.finalize())
}

fn valid_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn valid_context_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

fn validate_context(runtime_id: &str, run_id: &str) -> Result<(), String> {
    if !valid_context_part(runtime_id) || !valid_context_part(run_id) {
        return Err("protected_mail_invalid_context".into());
    }
    Ok(())
}

fn context_id(collection_id: u64, runtime_id: &str, run_id: &str) -> String {
    format!(
        "mail-context:{}",
        hash_fields(
            "pear-mail-context-v1",
            [&collection_id.to_string(), runtime_id, run_id]
        )
    )
}

fn exposure_id(context_id: &str, event_key: &str) -> String {
    format!(
        "mail-exposure:{}",
        hash_fields("pear-mail-exposure-id-v1", [context_id, event_key])
    )
}

fn derivation_id(context_id: &str, event_key: &str) -> String {
    format!(
        "mail-derivation:{}",
        hash_fields("pear-mail-derivation-id-v1", [context_id, event_key])
    )
}

fn derived_source_id(derivation_id: &str) -> String {
    format!(
        "mail-derived-source:{}",
        hash_fields("pear-mail-derived-source-id-v1", [derivation_id])
    )
}

/// Identity is (id, revision), not just id or digest. UTF-8 lexical ordering and
/// length-delimited hashes are shared-language canonical encodings.
fn canonical_refs(refs: &[ProtectedMailSourceRef]) -> Result<Vec<ProtectedMailSourceRef>, String> {
    let mut unique: BTreeMap<(&str, u64), &ProtectedMailSourceRef> = BTreeMap::new();
    for reference in refs {
        if reference.id.is_empty()
            || reference.id.len() > 256
            || reference.revision == 0
            || reference.id.trim() != reference.id
            || reference.id.chars().any(char::is_control)
            || !valid_hex(&reference.digest)
        {
            return Err("protected_mail_invalid_exposure".into());
        }
        let key = (reference.id.as_str(), reference.revision);
        if let Some(previous) = unique.insert(key, reference) {
            if previous.digest != reference.digest {
                return Err("protected_mail_source_conflict".into());
            }
        }
    }
    if unique.len() > MAX_MEMBERS {
        return Err("protected_mail_exposure_limit".into());
    }
    Ok(unique.into_values().cloned().collect())
}

fn canonical_inherited(ids: &[String]) -> Result<Vec<String>, String> {
    if ids.len() > MAX_INHERITED
        || ids
            .iter()
            .any(|id| !id.strip_prefix("mail-exposure:").is_some_and(valid_hex))
    {
        return Err("protected_mail_invalid_exposure".into());
    }
    let mut result = ids.to_vec();
    result.sort();
    result.dedup();
    Ok(result)
}

fn exposure_request_digest(
    context_id: &str,
    expected_generation: u64,
    event_key: &str,
    added: &[ProtectedMailSourceRef],
    inherited: &[String],
) -> String {
    let mut values = vec![
        context_id.to_owned(),
        expected_generation.to_string(),
        event_key.to_owned(),
        added.len().to_string(),
    ];
    for reference in added {
        values.extend([
            reference.id.clone(),
            reference.revision.to_string(),
            reference.digest.clone(),
        ]);
    }
    values.push(inherited.len().to_string());
    values.extend(inherited.iter().cloned());
    hash_fields(
        "pear-mail-exposure-request-v1",
        values.iter().map(String::as_str),
    )
}

fn derivation_digest(body: &str, sanitization_version: &str) -> String {
    hash_fields(
        "pear-mail-derived-content-v1",
        ["derived", body, sanitization_version],
    )
}

fn derivation_request_digest(
    context_id: &str,
    exposure_id: &str,
    event_key: &str,
    digest: &str,
) -> String {
    hash_fields(
        "pear-mail-derivation-request-v1",
        [context_id, exposure_id, event_key, digest],
    )
}

fn validate_derivation(
    event_key: &str,
    body: &str,
    sanitization_version: &str,
) -> Result<(), String> {
    if !valid_hex(event_key)
        || body.len() > 160_000
        || body
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        || sanitization_version.is_empty()
        || sanitization_version.len() > 64
        || !sanitization_version
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        return Err("protected_mail_invalid_derivation".into());
    }
    Ok(())
}

fn live_collection(
    ctx: &ReducerContext,
    connection_id: u64,
) -> Result<ProtectedMailCollection, String> {
    let connection = paused_human_connection(ctx, connection_id)?;
    let collection = ctx
        .db
        .protected_mail_collection()
        .id()
        .find(connection_id)
        .ok_or("protected_mail_collection_required")?;
    if collection.owner != connection.owner {
        return Err("protected_mail_collection_mismatch".into());
    }
    Ok(collection)
}

fn context_matches(
    context: &ProtectedMailContext,
    collection: &ProtectedMailCollection,
    runtime_id: &str,
    run_id: &str,
) -> bool {
    context.id == context_id(collection.id, runtime_id, run_id)
        && context.owner == collection.owner
        && context.collection_id == collection.id
        && context.runtime_id == runtime_id
        && context.run_id == run_id
}

fn exposure_matches(
    exposure: &ProtectedMailExposure,
    collection: &ProtectedMailCollection,
) -> bool {
    exposure.owner == collection.owner
        && exposure.collection_id == collection.id
        && valid_context_part(&exposure.runtime_id)
        && valid_context_part(&exposure.run_id)
        && exposure.context_id == context_id(collection.id, &exposure.runtime_id, &exposure.run_id)
        && valid_hex(&exposure.event_key)
        && exposure.id == exposure_id(&exposure.context_id, &exposure.event_key)
        && exposure.generation > 0
        && (exposure.generation == 1) == exposure.previous_id.is_none()
        && exposure.added_sources.len() <= MAX_DIRECT
        && canonical_refs(&exposure.added_sources).is_ok_and(|refs| refs == exposure.added_sources)
        && canonical_inherited(&exposure.inherited_exposure_ids)
            .is_ok_and(|ids| ids == exposure.inherited_exposure_ids)
        && canonical_refs(&exposure.members).is_ok_and(|refs| refs == exposure.members)
        && exposure.request_digest
            == exposure_request_digest(
                &exposure.context_id,
                exposure.generation - 1,
                &exposure.event_key,
                &exposure.added_sources,
                &exposure.inherited_exposure_ids,
            )
}

fn checked_exposure_shallow(
    ctx: &ReducerContext,
    collection: &ProtectedMailCollection,
    id: &str,
) -> Result<ProtectedMailExposure, String> {
    let exposure = ctx
        .db
        .protected_mail_exposure()
        .id()
        .find(id.to_owned())
        .ok_or("protected_mail_exposure_missing")?;
    if !exposure_matches(&exposure, collection) {
        return Err("protected_mail_inconsistent_state".into());
    }
    Ok(exposure)
}

/// Check only immediate immutable associations. This intentionally does not
/// recursively walk exposure history or resolve source ancestry; actual source
/// graphs are validated at insertion and again whenever policy is evaluated.
fn checked_exposure(
    ctx: &ReducerContext,
    collection: &ProtectedMailCollection,
    id: &str,
) -> Result<ProtectedMailExposure, String> {
    let exposure = checked_exposure_shallow(ctx, collection, id)?;
    let previous = exposure
        .previous_id
        .as_ref()
        .map(|previous_id| checked_exposure_shallow(ctx, collection, previous_id))
        .transpose()?;
    let inherited = exposure
        .inherited_exposure_ids
        .iter()
        .map(|inherited_id| checked_exposure_shallow(ctx, collection, inherited_id))
        .collect::<Result<Vec<_>, _>>()?;
    check_exposure_associations(&exposure, previous.as_ref(), &inherited)?;
    Ok(exposure)
}

fn check_exposure_associations(
    exposure: &ProtectedMailExposure,
    previous: Option<&ProtectedMailExposure>,
    inherited: &[ProtectedMailExposure],
) -> Result<(), String> {
    if exposure.previous_id.as_deref() != previous.map(|seal| seal.id.as_str())
        || previous.is_some_and(|seal| {
            seal.context_id != exposure.context_id
                || seal.generation.checked_add(1) != Some(exposure.generation)
        })
        || inherited.len() != exposure.inherited_exposure_ids.len()
        || inherited
            .iter()
            .zip(&exposure.inherited_exposure_ids)
            .any(|(seal, id)| seal.id != *id || seal.id == exposure.id)
    {
        return Err("protected_mail_inconsistent_state".into());
    }
    let members: BTreeMap<_, _> = exposure
        .members
        .iter()
        .map(|reference| {
            (
                (reference.id.as_str(), reference.revision),
                reference.digest.as_str(),
            )
        })
        .collect();
    let required = exposure
        .added_sources
        .iter()
        .chain(previous.into_iter().flat_map(|seal| seal.members.iter()))
        .chain(inherited.iter().flat_map(|seal| seal.members.iter()));
    if required.into_iter().any(|reference| {
        members
            .get(&(reference.id.as_str(), reference.revision))
            .copied()
            != Some(reference.digest.as_str())
    }) {
        return Err("protected_mail_inconsistent_state".into());
    }
    Ok(())
}

/// A replay may identify an old immutable seal, but cannot supply a new head.
/// Callers return before the only head-update branch.
fn check_exposure_replay(
    existing: &ProtectedMailExposure,
    collection: &ProtectedMailCollection,
    head: &ProtectedMailContext,
    request_digest: &str,
) -> Result<(), String> {
    if !exposure_matches(existing, collection)
        || existing.context_id != head.id
        || existing.generation > head.latest_generation
    {
        return Err("protected_mail_inconsistent_state".into());
    }
    if existing.request_digest != request_digest {
        return Err("protected_mail_exposure_conflict".into());
    }
    Ok(())
}

/// Register before disclosure. A successful seal records host declarations,
/// not completeness, runtime authentication, delegation authority or admission.
#[reducer]
pub fn record_protected_mail_exposure(
    ctx: &ReducerContext,
    connection_id: u64,
    runtime_id: String,
    run_id: String,
    expected_generation: u64,
    event_key: String,
    added_sources: Vec<ProtectedMailSourceRef>,
    inherited_exposure_ids: Vec<String>,
) -> Result<(), String> {
    let collection = live_collection(ctx, connection_id)?;
    validate_context(&runtime_id, &run_id)?;
    if !valid_hex(&event_key) || added_sources.len() > MAX_DIRECT {
        return Err("protected_mail_invalid_exposure".into());
    }
    let added = canonical_refs(&added_sources)?;
    let inherited = canonical_inherited(&inherited_exposure_ids)?;
    let id = context_id(collection.id, &runtime_id, &run_id);
    let head = ctx.db.protected_mail_context().id().find(id.clone());
    if let Some(context) = &head {
        if !context_matches(context, &collection, &runtime_id, &run_id) {
            return Err("protected_mail_context_mismatch".into());
        }
        if context.blocked {
            return Err("protected_mail_context_blocked".into());
        }
    }
    let seal_id = exposure_id(&id, &event_key);
    let request_digest =
        exposure_request_digest(&id, expected_generation, &event_key, &added, &inherited);
    if let Some(existing) = ctx.db.protected_mail_exposure().id().find(seal_id.clone()) {
        // No writes: retrying an older event cannot move the current head back.
        return check_exposure_replay(
            &existing,
            &collection,
            head.as_ref().ok_or("protected_mail_inconsistent_state")?,
            &request_digest,
        );
    }
    if runtime_id == RESULT_RUNTIME {
        return Err("protected_mail_reserved_result_context".into());
    }
    let actual_generation = head.as_ref().map_or(0, |context| context.latest_generation);
    if actual_generation != expected_generation {
        return Err("protected_mail_exposure_stale".into());
    }
    let generation = actual_generation
        .checked_add(1)
        .ok_or("protected_mail_exposure_limit")?;
    let previous_id = head
        .as_ref()
        .and_then(|context| context.latest_exposure_id.clone());
    let mut members = added.clone();
    if let Some(previous_id) = &previous_id {
        let previous = checked_exposure(ctx, &collection, previous_id)?;
        if previous.context_id != id || previous.generation != actual_generation {
            return Err("protected_mail_inconsistent_state".into());
        }
        members.extend(previous.members);
    } else if actual_generation != 0 {
        return Err("protected_mail_inconsistent_state".into());
    }
    for inherited_id in &inherited {
        members.extend(checked_exposure(ctx, &collection, inherited_id)?.members);
    }
    let members = canonical_refs(&members)?;
    // Resolve exact immutable ancestry even when current policy denies use.
    let graph = if members.is_empty() {
        Vec::new()
    } else {
        resolve_source_graph(ctx, collection.id, &members)?
    };
    let closure: Vec<_> = graph.into_iter().map(|source| source.reference).collect();
    let members = canonical_refs(&closure)?;
    ctx.db
        .protected_mail_exposure()
        .insert(ProtectedMailExposure {
            id: seal_id.clone(),
            owner: collection.owner,
            collection_id: collection.id,
            context_id: id.clone(),
            runtime_id: runtime_id.clone(),
            run_id: run_id.clone(),
            event_key,
            request_digest,
            generation,
            previous_id,
            added_sources: added,
            inherited_exposure_ids: inherited,
            members,
            created_at: ctx.timestamp,
        });
    if let Some(context) = head {
        ctx.db
            .protected_mail_context()
            .id()
            .update(ProtectedMailContext {
                latest_generation: generation,
                latest_exposure_id: Some(seal_id),
                updated_at: ctx.timestamp,
                ..context
            });
    } else {
        ctx.db
            .protected_mail_context()
            .insert(ProtectedMailContext {
                id,
                owner: collection.owner,
                collection_id: collection.id,
                runtime_id,
                run_id,
                latest_generation: generation,
                latest_exposure_id: Some(seal_id),
                blocked: false,
                created_at: ctx.timestamp,
                updated_at: ctx.timestamp,
            });
    }
    Ok(())
}

/// Terminal host safety latch. Retained collections can be blocked after their
/// connection/credentials have been deleted. No reducer clears this flag.
#[reducer]
pub fn block_protected_mail_context(
    ctx: &ReducerContext,
    connection_id: u64,
    runtime_id: String,
    run_id: String,
) -> Result<(), String> {
    if !sender_is_module_publisher(ctx) {
        return Err("protected_mail_publisher_required".into());
    }
    validate_context(&runtime_id, &run_id)?;
    let collection = ctx
        .db
        .protected_mail_collection()
        .id()
        .find(connection_id)
        .ok_or("protected_mail_collection_required")?;
    let id = context_id(collection.id, &runtime_id, &run_id);
    if let Some(context) = ctx.db.protected_mail_context().id().find(id.clone()) {
        if !context_matches(&context, &collection, &runtime_id, &run_id) {
            return Err("protected_mail_context_mismatch".into());
        }
        if !context.blocked {
            ctx.db
                .protected_mail_context()
                .id()
                .update(ProtectedMailContext {
                    blocked: true,
                    updated_at: ctx.timestamp,
                    ..context
                });
        }
    } else {
        ctx.db
            .protected_mail_context()
            .insert(ProtectedMailContext {
                id,
                owner: collection.owner,
                collection_id: collection.id,
                runtime_id,
                run_id,
                latest_generation: 0,
                latest_exposure_id: None,
                blocked: true,
                created_at: ctx.timestamp,
                updated_at: ctx.timestamp,
            });
    }
    Ok(())
}

/// Literal private output whose parents come from the full immutable input
/// seal. A historical seal is allowed for delayed output; a blocked context is
/// not. Current ancestor policy is checked again for every new derivation.
#[reducer]
pub fn append_protected_mail_derivation(
    ctx: &ReducerContext,
    connection_id: u64,
    runtime_id: String,
    run_id: String,
    exposure_id: String,
    event_key: String,
    body: String,
    sanitization_version: String,
) -> Result<(), String> {
    let collection = live_collection(ctx, connection_id)?;
    validate_context(&runtime_id, &run_id)?;
    validate_derivation(&event_key, &body, &sanitization_version)?;
    let context_id = context_id(collection.id, &runtime_id, &run_id);
    let context = ctx
        .db
        .protected_mail_context()
        .id()
        .find(context_id.clone())
        .ok_or("protected_mail_context_required")?;
    if !context_matches(&context, &collection, &runtime_id, &run_id) {
        return Err("protected_mail_context_mismatch".into());
    }
    if context.blocked {
        return Err("protected_mail_context_blocked".into());
    }
    let exposure = checked_exposure(ctx, &collection, &exposure_id)?;
    if exposure.context_id != context_id || exposure.generation > context.latest_generation {
        return Err("protected_mail_context_mismatch".into());
    }
    if exposure.members.is_empty() {
        return Err("protected_mail_source_required".into());
    }
    let id = derivation_id(&context_id, &event_key);
    let source_id = derived_source_id(&id);
    let digest = derivation_digest(&body, &sanitization_version);
    let request_digest = derivation_request_digest(&context_id, &exposure_id, &event_key, &digest);
    if let Some(existing) = ctx.db.protected_mail_derivation().id().find(id.clone()) {
        let reference = ProtectedMailSourceRef {
            id: existing.source_id.clone(),
            revision: existing.revision,
            digest: existing.digest.clone(),
        };
        resolve_derived_source(ctx, &reference)?.ok_or("protected_mail_inconsistent_state")?;
        if existing.request_digest != request_digest
            || existing.body != body
            || existing.sanitization_version != sanitization_version
        {
            return Err("protected_mail_derivation_conflict".into());
        }
        return Ok(());
    }
    if runtime_id == RESULT_RUNTIME {
        return Err("protected_mail_reserved_result_context".into());
    }
    let policy = current_effective_policy(ctx, collection.id, &exposure.members)?;
    if !policy.allow_owner_storage {
        return Err("protected_mail_source_disclosure_denied".into());
    }
    let reference = ProtectedMailSourceRef {
        id: source_id.clone(),
        revision: DERIVED_REVISION,
        digest: digest.clone(),
    };
    ctx.db
        .protected_mail_derivation()
        .insert(ProtectedMailDerivation {
            id,
            source_id,
            owner: collection.owner,
            collection_id: collection.id,
            context_id,
            exposure_id,
            event_key,
            request_digest,
            revision: DERIVED_REVISION,
            digest,
            body,
            sanitization_version,
            parents: exposure.members,
            created_at: ctx.timestamp,
        });
    install_derived_policy(
        ctx,
        &reference,
        policy.processors,
        policy.allow_owner_storage,
    )?;
    Ok(())
}

fn result_stage_ids(collection_id: u64, admission_id: &str) -> (String,String,String,String) {
    let context=context_id(collection_id,RESULT_RUNTIME,admission_id);
    let event=hash_fields("pear-mail-inference-result-stage-event-v1",[admission_id]);
    let exposure=exposure_id(&context,&event);
    let derivation=derivation_id(&context,&event);
    (context,event,exposure,derivation)
}
pub(super) fn accepted_result_reference(collection_id: u64, admission_id: &str, body: &str) -> ProtectedMailSourceRef {
    let (_,_,_,derivation)=result_stage_ids(collection_id,admission_id);
    ProtectedMailSourceRef { id:derived_source_id(&derivation),revision:DERIVED_REVISION,digest:derivation_digest(body,RESULT_SANITIZATION) }
}
/// No public publisher gate is relaxed. The unforgeable internal token is
/// created only after the separate result-storage authorization succeeds in
/// this exact transaction; callers cannot choose a context, parents or policy.
pub(super) fn insert_accepted_result_stage(ctx: &ReducerContext, authority: &AuthorizedResultWrite, body: &str)
    -> Result<ProtectedMailSourceRef,String> {
    if !authority.matches_context(ctx) || body.is_empty() || body.len() > 64*1024 { return Err("protected_mail_result_inconsistent".into()); }
    let collection=ctx.db.protected_mail_collection().id().find(authority.collection_id()).ok_or("protected_mail_result_inconsistent")?;
    if collection.owner != authority.owner() { return Err("protected_mail_result_inconsistent".into()); }
    let (context,event,exposure,derivation)=result_stage_ids(collection.id,authority.admission_id());
    validate_derivation(&event,body,RESULT_SANITIZATION)?;
    let reference=accepted_result_reference(collection.id,authority.admission_id(),body);
    if ctx.db.protected_mail_context().id().find(context.clone()).is_some()
        || ctx.db.protected_mail_exposure().id().find(exposure.clone()).is_some()
        || ctx.db.protected_mail_derivation().id().find(derivation.clone()).is_some()
        || ctx.db.protected_mail_derivation().source_id().find(reference.id.clone()).is_some() {
        return Err("protected_mail_result_event_conflict".into());
    }
    let roots=canonical_refs(authority.roots())?;
    let resolved=resolve_source_graph(ctx,collection.id,&roots)?.into_iter().map(|source|source.reference).collect::<Vec<_>>();
    if resolved != authority.parents() { return Err("protected_mail_result_inconsistent".into()); }
    ctx.db.protected_mail_context().insert(ProtectedMailContext { id:context.clone(),owner:collection.owner,collection_id:collection.id,
        runtime_id:RESULT_RUNTIME.into(),run_id:authority.admission_id().into(),latest_generation:1,latest_exposure_id:Some(exposure.clone()),
        blocked:false,created_at:ctx.timestamp,updated_at:ctx.timestamp });
    ctx.db.protected_mail_exposure().insert(ProtectedMailExposure { id:exposure.clone(),owner:collection.owner,collection_id:collection.id,
        context_id:context.clone(),runtime_id:RESULT_RUNTIME.into(),run_id:authority.admission_id().into(),event_key:event.clone(),
        request_digest:exposure_request_digest(&context,0,&event,&roots,&[]),generation:1,previous_id:None,added_sources:roots,
        inherited_exposure_ids:vec![],members:resolved.clone(),created_at:ctx.timestamp });
    ctx.db.protected_mail_derivation().insert(ProtectedMailDerivation { id:derivation,source_id:reference.id.clone(),owner:collection.owner,
        collection_id:collection.id,context_id:context.clone(),exposure_id:exposure.clone(),event_key:event.clone(),
        request_digest:derivation_request_digest(&context,&exposure,&event,&reference.digest),revision:reference.revision,digest:reference.digest.clone(),
        body:body.into(),sanitization_version:RESULT_SANITIZATION.into(),parents:resolved,created_at:ctx.timestamp });
    // The extra output node counts against both graph bounds. Any failure
    // rolls back the context, seal, source, policy, receipt and lifecycle.
    resolve_source_graph(ctx,collection.id,std::slice::from_ref(&reference))?;
    install_accepted_result_policy(ctx,authority,&reference)?;
    Ok(reference)
}
pub(super) fn verify_accepted_result_stage(ctx: &ReducerContext, collection_id: u64, admission_id: &str,
    reference: &ProtectedMailSourceRef, body: &str, roots: &[ProtectedMailSourceRef], parents: &[ProtectedMailSourceRef]) -> Result<Timestamp,String> {
    let collection=ctx.db.protected_mail_collection().id().find(collection_id).ok_or("protected_mail_result_inconsistent")?;
    let (context_id,event,exposure_id,derivation_id)=result_stage_ids(collection_id,admission_id);
    let context=ctx.db.protected_mail_context().id().find(context_id.clone()).ok_or("protected_mail_result_inconsistent")?;
    let exposure=checked_exposure(ctx,&collection,&exposure_id)?;
    let derivation=ctx.db.protected_mail_derivation().id().find(derivation_id).ok_or("protected_mail_result_inconsistent")?;
    if *reference != accepted_result_reference(collection_id,admission_id,body)
        || !context_matches(&context,&collection,RESULT_RUNTIME,admission_id) || context.latest_generation != 1
        || context.latest_exposure_id.as_deref() != Some(exposure_id.as_str()) || exposure.generation != 1
        || exposure.previous_id.is_some() || !exposure.inherited_exposure_ids.is_empty()
        || exposure.added_sources != canonical_refs(roots)? || exposure.members != parents || exposure.event_key != event
        || derivation.body != body || derivation.parents != parents || derivation.sanitization_version != RESULT_SANITIZATION
        || derivation.created_at != exposure.created_at || context.created_at != exposure.created_at {
        return Err("protected_mail_result_inconsistent".into());
    }
    resolve_derived_source(ctx,reference)?.ok_or("protected_mail_result_inconsistent")?;
    Ok(derivation.created_at)
}

/// Validate immutable derived-source association without consulting current
/// policy or context blocking. An old source must remain trackable after use
/// is revoked; the graph resolver applies current ancestor policies separately.
pub(super) fn resolve_derived_source(
    ctx: &ReducerContext,
    reference: &ProtectedMailSourceRef,
) -> Result<Option<ResolvedProtectedMailSource>, String> {
    if !reference.id.starts_with("mail-derived-source:") {
        return Ok(None);
    }
    let derivation = ctx
        .db
        .protected_mail_derivation()
        .source_id()
        .find(reference.id.clone())
        .ok_or("protected_mail_source_missing")?;
    let collection = ctx
        .db
        .protected_mail_collection()
        .id()
        .find(derivation.collection_id)
        .ok_or("protected_mail_inconsistent_state")?;
    let exposure = checked_exposure(ctx, &collection, &derivation.exposure_id)?;
    if derivation.owner != collection.owner
        || derivation.context_id != exposure.context_id
        || derivation.id != derivation_id(&derivation.context_id, &derivation.event_key)
        || derivation.source_id != derived_source_id(&derivation.id)
        || derivation.revision != DERIVED_REVISION
        || reference.revision != derivation.revision
        || reference.digest != derivation.digest
        || validate_derivation(
            &derivation.event_key,
            &derivation.body,
            &derivation.sanitization_version,
        )
        .is_err()
        || derivation.digest
            != derivation_digest(&derivation.body, &derivation.sanitization_version)
        || derivation.request_digest
            != derivation_request_digest(
                &derivation.context_id,
                &derivation.exposure_id,
                &derivation.event_key,
                &derivation.digest,
            )
        || derivation.parents.is_empty()
        || derivation.parents != exposure.members
    {
        return Err("protected_mail_inconsistent_state".into());
    }
    Ok(Some(ResolvedProtectedMailSource {
        reference: reference.clone(),
        owner: derivation.owner,
        collection_id: derivation.collection_id,
        parents: derivation.parents,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str, revision: u64, digit: char) -> ProtectedMailSourceRef {
        ProtectedMailSourceRef {
            id: id.into(),
            revision,
            digest: digit.to_string().repeat(64),
        }
    }

    #[test]
    fn canonical_exposure_refs_preserve_revisions_and_reject_conflicting_identity() {
        let a = source("mail-source:a", 1, 'a');
        let b = source("mail-source:a", 2, 'b');
        assert_eq!(
            canonical_refs(&[b.clone(), a.clone(), a.clone()]).unwrap(),
            vec![a.clone(), b]
        );
        assert_eq!(
            canonical_refs(&[a, source("mail-source:a", 1, 'c')]).unwrap_err(),
            "protected_mail_source_conflict"
        );
        assert!(canonical_refs(&[source("source", 0, 'a')]).is_err());
        assert!(canonical_refs(&[source(" source", 1, 'a')]).is_err());
        assert!(canonical_refs(&[source("source", 1, 'A')]).is_err());
    }

    #[test]
    fn exposure_request_hash_is_order_independent_only_after_full_canonicalization() {
        let a = source("a", 1, 'a');
        let b = source("b", 1, 'b');
        let seal_a = exposure_id("context", &"a".repeat(64));
        let seal_b = exposure_id("context", &"b".repeat(64));
        let digest = exposure_request_digest(
            "context",
            0,
            &"e".repeat(64),
            &canonical_refs(&[b.clone(), a.clone(), a.clone()]).unwrap(),
            &canonical_inherited(&[seal_b.clone(), seal_a.clone()]).unwrap(),
        );
        assert_eq!(
            digest,
            exposure_request_digest(
                "context",
                0,
                &"e".repeat(64),
                &canonical_refs(&[a.clone(), b.clone()]).unwrap(),
                &canonical_inherited(&[seal_a.clone(), seal_b.clone(), seal_a.clone()]).unwrap()
            )
        );
        assert_ne!(
            digest,
            exposure_request_digest("context", 1, &"e".repeat(64), &[a, b], &[seal_a, seal_b])
        );
        assert_ne!(context_id(1, "a-b", "c"), context_id(1, "a", "b-c"));
        assert_ne!(context_id(1, "a", "b"), context_id(2, "a", "b"));
    }

    #[test]
    fn canonical_limits_never_truncate_an_exposure() {
        let refs: Vec<_> = (0..257)
            .map(|i| source(&format!("source-{i:03}"), 1, 'a'))
            .collect();
        assert_eq!(
            canonical_refs(&refs).unwrap_err(),
            "protected_mail_exposure_limit"
        );
        assert_eq!(canonical_refs(&refs[..256]).unwrap().len(), 256);
        assert!(canonical_inherited(&vec![exposure_id("context", &"a".repeat(64)); 17]).is_err());
        assert!(canonical_inherited(&["arbitrary-page-id".into()]).is_err());
    }

    #[test]
    fn derived_content_is_bounded_literal_text_with_domain_separated_identity() {
        assert!(validate_derivation(&"a".repeat(64), "literal\ntext\r\t", "fixture-v1").is_ok());
        assert!(validate_derivation(&"a".repeat(64), "bad\0text", "fixture-v1").is_err());
        assert!(validate_derivation(&"a".repeat(64), &"é".repeat(80_001), "fixture-v1").is_err());
        assert!(validate_derivation(&"a".repeat(64), &"é".repeat(80_000), "fixture-v1").is_ok());
        assert!(validate_derivation(&"a".repeat(64), "body", "unsafe version").is_err());
        assert_ne!(derivation_digest("ab", "c"), derivation_digest("a", "bc"));
        assert_ne!(
            derivation_digest("body", "v1"),
            derivation_digest("body", "v2")
        );
        let context = context_id(1, "runtime", "run");
        let event = "e".repeat(64);
        assert_ne!(
            exposure_id(&context, &event),
            derivation_id(&context, &event)
        );
        assert_ne!(
            derivation_request_digest(&context, "seal-a", &event, &"a".repeat(64)),
            derivation_request_digest(&context, "seal-b", &event, &"a".repeat(64))
        );
    }

    #[test]
    fn context_identifiers_are_bounded_opaque_declarations() {
        assert!(validate_context("runtime-1", "run_1.2").is_ok());
        for invalid in ["", " runtime", "runtime/run", "runtime\n", "é"] {
            assert!(validate_context(invalid, "run").is_err());
        }
        assert!(validate_context(&"a".repeat(129), "run").is_err());
    }

    #[test]
    fn exact_old_exposure_replay_preserves_the_later_head_and_conflicts_on_changed_request() {
        let owner = Identity::from_byte_array([1; 32]);
        let timestamp = Timestamp::from_micros_since_unix_epoch(1);
        let collection = ProtectedMailCollection {
            id: 1,
            owner,
            created_at: timestamp,
        };
        let context_id = context_id(1, "runtime", "run");
        let event_key = "a".repeat(64);
        let reference = source("source-a", 1, 'a');
        let original_digest =
            exposure_request_digest(&context_id, 0, &event_key, &[reference.clone()], &[]);
        let original = ProtectedMailExposure {
            id: exposure_id(&context_id, &event_key),
            owner,
            collection_id: 1,
            context_id: context_id.clone(),
            runtime_id: "runtime".into(),
            run_id: "run".into(),
            event_key: event_key.clone(),
            request_digest: original_digest.clone(),
            generation: 1,
            previous_id: None,
            added_sources: vec![reference.clone()],
            inherited_exposure_ids: vec![],
            members: vec![reference],
            created_at: timestamp,
        };
        let head_id = exposure_id(&context_id, &"b".repeat(64));
        let head = ProtectedMailContext {
            id: context_id.clone(),
            owner,
            collection_id: 1,
            runtime_id: "runtime".into(),
            run_id: "run".into(),
            latest_generation: 2,
            latest_exposure_id: Some(head_id.clone()),
            blocked: false,
            created_at: timestamp,
            updated_at: timestamp,
        };
        assert!(check_exposure_replay(&original, &collection, &head, &original_digest).is_ok());
        assert_eq!(head.latest_generation, 2);
        assert_eq!(head.latest_exposure_id, Some(head_id));
        let changed =
            exposure_request_digest(&context_id, 1, &event_key, &original.added_sources, &[]);
        assert_eq!(
            check_exposure_replay(&original, &collection, &head, &changed).unwrap_err(),
            "protected_mail_exposure_conflict"
        );
        let other_owner = ProtectedMailCollection {
            owner: Identity::from_byte_array([2; 32]),
            ..collection
        };
        assert_eq!(
            check_exposure_replay(&original, &other_owner, &head, &original_digest).unwrap_err(),
            "protected_mail_inconsistent_state"
        );
    }

    #[test]
    fn immediate_seal_associations_reject_dropped_members_wrong_predecessor_and_self_inheritance() {
        fn seal(
            runtime: &str,
            event: char,
            generation: u64,
            previous_id: Option<String>,
            added_sources: Vec<ProtectedMailSourceRef>,
            inherited_exposure_ids: Vec<String>,
            members: Vec<ProtectedMailSourceRef>,
        ) -> ProtectedMailExposure {
            let context_id = context_id(1, runtime, "run");
            let event_key = event.to_string().repeat(64);
            ProtectedMailExposure {
                id: exposure_id(&context_id, &event_key),
                owner: Identity::from_byte_array([1; 32]),
                collection_id: 1,
                context_id: context_id.clone(),
                runtime_id: runtime.into(),
                run_id: "run".into(),
                request_digest: exposure_request_digest(
                    &context_id,
                    generation - 1,
                    &event_key,
                    &added_sources,
                    &inherited_exposure_ids,
                ),
                event_key,
                generation,
                previous_id,
                added_sources,
                inherited_exposure_ids,
                members,
                created_at: Timestamp::from_micros_since_unix_epoch(1),
            }
        }
        let a = source("a", 1, 'a');
        let b = source("b", 1, 'b');
        let c = source("c", 1, 'c');
        let mut previous = seal(
            "runtime",
            'a',
            1,
            None,
            vec![a.clone()],
            vec![],
            vec![a.clone()],
        );
        let inherited = vec![seal(
            "parent-runtime",
            'b',
            1,
            None,
            vec![b.clone()],
            vec![],
            vec![b.clone()],
        )];
        let mut current = seal(
            "runtime",
            'c',
            2,
            Some(previous.id.clone()),
            vec![c.clone()],
            vec![inherited[0].id.clone()],
            vec![a.clone(), b.clone(), c.clone()],
        );
        assert!(check_exposure_associations(&current, Some(&previous), &inherited).is_ok());
        for missing in [&a, &b, &c] {
            current.members = vec![a.clone(), b.clone(), c.clone()]
                .into_iter()
                .filter(|reference| reference != missing)
                .collect();
            assert_eq!(
                check_exposure_associations(&current, Some(&previous), &inherited).unwrap_err(),
                "protected_mail_inconsistent_state"
            );
        }
        current.members = vec![a, b, c];
        previous.generation = 2;
        assert!(check_exposure_associations(&current, Some(&previous), &inherited).is_err());
        previous.generation = 1;
        previous.context_id = "other-context".into();
        assert!(check_exposure_associations(&current, Some(&previous), &inherited).is_err());
        previous.context_id = current.context_id.clone();
        current.inherited_exposure_ids = vec![current.id.clone()];
        let self_seal = seal(
            "runtime",
            'c',
            2,
            current.previous_id.clone(),
            current.added_sources.clone(),
            current.inherited_exposure_ids.clone(),
            current.members.clone(),
        );
        assert!(check_exposure_associations(&current, Some(&previous), &[self_seal]).is_err());
    }
}
