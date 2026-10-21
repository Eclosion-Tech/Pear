//! Durable source ceilings and immutable policy history. These records are
//! trusted management input, never human approval or execution authority.
//! Nothing here dispatches a request, grants ordinary agents access, or records
//! that a model actually observed a declared source.

use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};
use spacetimedb::{reducer, table, Identity, ReducerContext, SpacetimeType, Table, Timestamp};
use url::Url;

use super::protected::{
    associated, protected_mail_collection, protected_mail_receipt, protected_mail_record,
    protected_mail_source,
};
use crate::ai::{ai_user_config, ai_user_profile};
use crate::auth::user;
use crate::module_install::sender_is_module_publisher;

const MAX_SOURCES: usize = 256;
const MAX_DEPTH: usize = 32;
const MAX_PROCESSORS: usize = 32;

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct ProtectedMailSourceRef {
    pub id: String,
    pub revision: u64,
    pub digest: String,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct ProtectedMailProcessor {
    pub profile_id: String,
    pub revision: String,
    pub endpoint: String,
    pub model: String,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct ProtectedMailSourceGeneration {
    pub source: ProtectedMailSourceRef,
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ResolvedProtectedMailSource {
    pub reference: ProtectedMailSourceRef,
    pub owner: Identity,
    pub collection_id: u64,
    pub parents: Vec<ProtectedMailSourceRef>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct EffectiveProtectedMailPolicy {
    pub processors: Vec<ProtectedMailProcessor>,
    pub allow_owner_storage: bool,
    pub bindings: Vec<ProtectedMailSourceGeneration>,
}

#[table(accessor = protected_mail_source_policy_head, private)]
pub struct ProtectedMailSourcePolicyHead {
    #[primary_key]
    pub id: String,
    pub source: ProtectedMailSourceRef,
    #[index(btree)]
    pub owner: Identity,
    pub collection_id: u64,
    pub generation: u64,
}

#[table(accessor = protected_mail_source_policy_history, private)]
pub struct ProtectedMailSourcePolicyHistory {
    #[primary_key]
    pub id: String,
    pub policy_id: String,
    pub source: ProtectedMailSourceRef,
    #[index(btree)]
    pub owner: Identity,
    pub collection_id: u64,
    pub generation: u64,
    pub processors: Vec<ProtectedMailProcessor>,
    pub allow_owner_storage: bool,
    pub revoked: bool,
    pub changed_by: Identity,
    pub changed_at: Timestamp,
}

fn bounded_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

pub(super) fn validate_source_ref(reference: &ProtectedMailSourceRef) -> Result<(), String> {
    if !bounded_text(&reference.id, 256)
        || reference.revision == 0
        || reference.digest.len() != 64
        || !reference
            .digest
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("protected_mail_invalid_source_ref".into());
    }
    Ok(())
}

fn processor_key(processor: &ProtectedMailProcessor) -> (&str, &str, &str, &str) {
    (
        &processor.profile_id,
        &processor.revision,
        &processor.endpoint,
        &processor.model,
    )
}

fn valid_processor(processor: &ProtectedMailProcessor) -> bool {
    if !bounded_text(&processor.profile_id, 256)
        || !bounded_text(&processor.revision, 256)
        || !bounded_text(&processor.model, 256)
        || !bounded_text(&processor.endpoint, 2048)
    {
        return false;
    }
    Url::parse(&processor.endpoint).is_ok_and(|endpoint| {
        endpoint.scheme() == "https"
            && endpoint.has_host()
            && endpoint.username().is_empty()
            && endpoint.password().is_none()
            && endpoint.query().is_none()
            && endpoint.fragment().is_none()
            && endpoint.as_str() == processor.endpoint
    })
}

fn canonical_processors(
    mut processors: Vec<ProtectedMailProcessor>,
) -> Result<Vec<ProtectedMailProcessor>, String> {
    if processors.len() > MAX_PROCESSORS || processors.iter().any(|p| !valid_processor(p)) {
        return Err("protected_mail_invalid_processors".into());
    }
    processors.sort_by(|a, b| processor_key(a).cmp(&processor_key(b)));
    if processors.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("protected_mail_invalid_processors".into());
    }
    Ok(processors)
}

fn policy_id(reference: &ProtectedMailSourceRef) -> String {
    let mut hash = Sha256::new();
    let revision = reference.revision.to_string();
    for field in [
        "pear-protected-mail-source-policy-v1",
        &reference.id,
        &revision,
        &reference.digest,
    ] {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    format!("mail-source-policy:{}", hex::encode(hash.finalize()))
}

fn history_id(policy: &str, generation: u64) -> String {
    format!("{policy}:{generation}")
}

fn resolve_source(
    ctx: &ReducerContext,
    reference: &ProtectedMailSourceRef,
) -> Result<ResolvedProtectedMailSource, String> {
    validate_source_ref(reference)?;
    let external = ctx
        .db
        .protected_mail_source()
        .id()
        .find(reference.id.clone());
    let derived = super::provenance::resolve_derived_source(ctx, reference)?;
    let instruction = super::instructions::resolve_instruction_source(ctx, reference)?;
    if [external.is_some(), derived.is_some(), instruction.is_some()]
        .into_iter()
        .filter(|present| *present)
        .count()
        > 1
    {
        return Err("protected_mail_source_conflict".into());
    }
    if let Some(source) = external {
        let collection = ctx
            .db
            .protected_mail_collection()
            .id()
            .find(source.collection_id)
            .ok_or("protected_mail_inconsistent_state")?;
        let id = source
            .id
            .strip_prefix("mail-source:")
            .ok_or("protected_mail_inconsistent_state")?;
        let record = ctx
            .db
            .protected_mail_record()
            .id()
            .find(id.to_string())
            .ok_or("protected_mail_inconsistent_state")?;
        let receipt = ctx
            .db
            .protected_mail_receipt()
            .id()
            .find(id.to_string())
            .ok_or("protected_mail_inconsistent_state")?;
        if !associated(&collection, &source, &record, &receipt) {
            return Err("protected_mail_inconsistent_state".into());
        }
        if source.revision != reference.revision || source.digest != reference.digest {
            return Err("protected_mail_source_conflict".into());
        }
        return Ok(ResolvedProtectedMailSource {
            reference: reference.clone(),
            owner: source.owner,
            collection_id: source.collection_id,
            parents: vec![],
        });
    }
    derived
        .or(instruction)
        .ok_or_else(|| "protected_mail_source_missing".into())
}

/// The cached subtree height preserves the depth bound when a shared ancestor
/// is reached again by a longer path, without repeatedly expanding a dense DAG.
fn walk_source_graph(
    owner: Identity,
    collection_id: u64,
    references: &[ProtectedMailSourceRef],
    mut load: impl FnMut(&ProtectedMailSourceRef) -> Result<ResolvedProtectedMailSource, String>,
) -> Result<Vec<ResolvedProtectedMailSource>, String> {
    type Key = (String, u64);
    struct Walker<'a, F> {
        owner: Identity,
        collection_id: u64,
        load: &'a mut F,
        declared: BTreeMap<Key, ProtectedMailSourceRef>,
        visiting: BTreeSet<Key>,
        resolved: BTreeMap<Key, (ResolvedProtectedMailSource, usize)>,
    }
    impl<F> Walker<'_, F>
    where
        F: FnMut(&ProtectedMailSourceRef) -> Result<ResolvedProtectedMailSource, String>,
    {
        fn visit(
            &mut self,
            reference: &ProtectedMailSourceRef,
            depth: usize,
        ) -> Result<usize, String> {
            validate_source_ref(reference)?;
            if depth > MAX_DEPTH {
                return Err("protected_mail_source_graph_bounds".into());
            }
            let key = (reference.id.clone(), reference.revision);
            if let Some(previous) = self.declared.get(&key) {
                if previous != reference {
                    return Err("protected_mail_source_conflict".into());
                }
            } else {
                if self.declared.len() >= MAX_SOURCES {
                    return Err("protected_mail_source_graph_bounds".into());
                }
                self.declared.insert(key.clone(), reference.clone());
            }
            if self.visiting.contains(&key) {
                return Err("protected_mail_source_cycle".into());
            }
            if let Some((_, height)) = self.resolved.get(&key) {
                if depth + height - 1 > MAX_DEPTH {
                    return Err("protected_mail_source_graph_bounds".into());
                }
                return Ok(*height);
            }
            let source = (self.load)(reference)?;
            if source.reference != *reference {
                return Err("protected_mail_source_conflict".into());
            }
            if source.owner != self.owner || source.collection_id != self.collection_id {
                return Err("protected_mail_source_scope_mismatch".into());
            }
            if source.parents.len() > MAX_SOURCES {
                return Err("protected_mail_source_graph_bounds".into());
            }
            self.visiting.insert(key.clone());
            let mut height = 1;
            for parent in &source.parents {
                height = height.max(self.visit(parent, depth + 1)? + 1);
            }
            self.visiting.remove(&key);
            self.resolved.insert(key, (source, height));
            Ok(height)
        }
    }
    if references.is_empty() || references.len() > MAX_SOURCES {
        return Err("protected_mail_source_graph_bounds".into());
    }
    let mut walker = Walker {
        owner,
        collection_id,
        load: &mut load,
        declared: BTreeMap::new(),
        visiting: BTreeSet::new(),
        resolved: BTreeMap::new(),
    };
    for reference in references {
        walker.visit(reference, 1)?;
    }
    Ok(walker
        .resolved
        .into_values()
        .map(|(source, _)| source)
        .collect())
}

/// Complete immutable ancestry; policy absence/revocation must not erase
/// provenance. No caller/model-supplied owner or workspace is authoritative.
pub(super) fn resolve_source_graph(
    ctx: &ReducerContext,
    collection_id: u64,
    references: &[ProtectedMailSourceRef],
) -> Result<Vec<ResolvedProtectedMailSource>, String> {
    let collection = ctx
        .db
        .protected_mail_collection()
        .id()
        .find(collection_id)
        .ok_or("protected_mail_collection_required")?;
    walk_source_graph(collection.owner, collection_id, references, |reference| {
        resolve_source(ctx, reference)
    })
}

/// Validate one prospective output wrapper without storing a placeholder or
/// flattening its ancestors. The source identity/digest are host supplied;
/// this only checks immutable association and the existing graph bounds.
pub(super) fn validate_prospective_derived_source(ctx: &ReducerContext, collection_id: u64,
    reference: &ProtectedMailSourceRef, parents: &[ProtectedMailSourceRef]) -> Result<(),String> {
    let collection=ctx.db.protected_mail_collection().id().find(collection_id).ok_or("protected_mail_inconsistent_state")?;
    walk_source_graph(collection.owner,collection_id,std::slice::from_ref(reference),|candidate| {
        if candidate.id == reference.id && candidate.revision == reference.revision {
            if candidate != reference { return Err("protected_mail_source_conflict".into()); }
            Ok(ResolvedProtectedMailSource { reference:reference.clone(),owner:collection.owner,collection_id,parents:parents.to_vec() })
        } else { resolve_source(ctx,candidate) }
    })?;
    Ok(())
}

fn current_policy(
    ctx: &ReducerContext,
    source: &ResolvedProtectedMailSource,
) -> Result<ProtectedMailSourcePolicyHistory, String> {
    let id = policy_id(&source.reference);
    let head = ctx
        .db
        .protected_mail_source_policy_head()
        .id()
        .find(id.clone())
        .ok_or("protected_mail_source_policy_required")?;
    let history = ctx
        .db
        .protected_mail_source_policy_history()
        .id()
        .find(history_id(&id, head.generation))
        .ok_or("protected_mail_source_policy_inconsistent")?;
    if head.id != id
        || head.generation == 0
        || head.source != source.reference
        || head.owner != source.owner
        || head.collection_id != source.collection_id
        || history.policy_id != id
        || history.source != source.reference
        || history.owner != source.owner
        || history.collection_id != source.collection_id
        || history.generation != head.generation
        || canonical_processors(history.processors.clone())? != history.processors
    {
        return Err("protected_mail_source_policy_inconsistent".into());
    }
    Ok(history)
}

fn enrollment_matches(
    source: &ResolvedProtectedMailSource,
    head: Option<&ProtectedMailSourcePolicyHead>,
    initial: Option<&ProtectedMailSourcePolicyHistory>,
) -> Result<bool, String> {
    let (head, initial) = match (head, initial) {
        (None, None) => return Ok(false),
        (Some(head), Some(initial)) => (head, initial),
        _ => return Err("protected_mail_source_policy_inconsistent".into()),
    };
    let id = policy_id(&source.reference);
    if head.id != id
        || head.source != source.reference
        || head.owner != source.owner
        || head.collection_id != source.collection_id
        || head.generation == 0
        || initial.id != history_id(&id, 1)
        || initial.policy_id != id
        || initial.source != source.reference
        || initial.owner != source.owner
        || initial.collection_id != source.collection_id
        || initial.generation != 1
        || initial.revoked
        || canonical_processors(initial.processors.clone())? != initial.processors
    {
        return Err("protected_mail_source_policy_inconsistent".into());
    }
    Ok(true)
}

/// A policy head is the enrollment marker. Never treat a broken head or an
/// orphaned initial history row as an unenrolled instruction that may shed its
/// restrictions on the next edit. This reads metadata without widening it.
pub(super) fn source_policy_enrolled(
    ctx: &ReducerContext,
    reference: &ProtectedMailSourceRef,
) -> Result<bool, String> {
    validate_source_ref(reference)?;
    let id = policy_id(reference);
    let head = ctx
        .db
        .protected_mail_source_policy_head()
        .id()
        .find(id.clone());
    let initial = ctx
        .db
        .protected_mail_source_policy_history()
        .id()
        .find(history_id(&id, 1));
    let resolved = resolve_source(ctx, reference)?;
    if !enrollment_matches(&resolved, head.as_ref(), initial.as_ref())? {
        return Ok(false);
    }
    current_policy(ctx, &resolved)?;
    Ok(true)
}

pub(super) fn current_effective_policy(
    ctx: &ReducerContext,
    collection_id: u64,
    references: &[ProtectedMailSourceRef],
) -> Result<EffectiveProtectedMailPolicy, String> {
    let closure = resolve_source_graph(ctx, collection_id, references)?;
    let mut processors: Option<Vec<ProtectedMailProcessor>> = None;
    let mut allow_owner_storage = true;
    let mut bindings = Vec::with_capacity(closure.len());
    for source in closure {
        let policy = current_policy(ctx, &source)?;
        if policy.revoked {
            return Err("protected_mail_source_policy_revoked".into());
        }
        if let Some(effective) = &mut processors {
            effective.retain(|processor| policy.processors.contains(processor));
        } else {
            processors = Some(policy.processors.clone());
        }
        allow_owner_storage &= policy.allow_owner_storage;
        bindings.push(ProtectedMailSourceGeneration {
            source: source.reference,
            generation: policy.generation,
        });
    }
    Ok(EffectiveProtectedMailPolicy {
        processors: processors.unwrap_or_default(),
        allow_owner_storage,
        bindings,
    })
}

fn authenticated_human_sender(ctx: &ReducerContext) -> bool {
    let sender = ctx.sender();
    ctx.db.ai_user_config().identity().find(sender).is_none()
        && ctx.db.ai_user_profile().identity().find(sender).is_none()
        && ctx
            .db
            .user()
            .identity()
            .find(sender)
            .is_some_and(|u| u.is_authenticated)
}

fn insert_initial_policy(
    ctx: &ReducerContext,
    source: &ResolvedProtectedMailSource,
    processors: Vec<ProtectedMailProcessor>,
    allow_owner_storage: bool,
) -> Result<(), String> {
    let id = policy_id(&source.reference);
    if ctx
        .db
        .protected_mail_source_policy_head()
        .id()
        .find(id.clone())
        .is_some()
        || ctx
            .db
            .protected_mail_source_policy_history()
            .id()
            .find(history_id(&id, 1))
            .is_some()
    {
        return Err("protected_mail_source_policy_inconsistent".into());
    }
    ctx.db
        .protected_mail_source_policy_history()
        .insert(ProtectedMailSourcePolicyHistory {
            id: history_id(&id, 1),
            policy_id: id.clone(),
            source: source.reference.clone(),
            owner: source.owner,
            collection_id: source.collection_id,
            generation: 1,
            processors,
            allow_owner_storage,
            revoked: false,
            changed_by: ctx.sender(),
            changed_at: ctx.timestamp,
        });
    ctx.db
        .protected_mail_source_policy_head()
        .insert(ProtectedMailSourcePolicyHead {
            id,
            source: source.reference.clone(),
            owner: source.owner,
            collection_id: source.collection_id,
            generation: 1,
        });
    Ok(())
}

#[reducer]
pub fn initialize_protected_mail_source_policy(
    ctx: &ReducerContext,
    source: ProtectedMailSourceRef,
    processors: Vec<ProtectedMailProcessor>,
) -> Result<(), String> {
    if !sender_is_module_publisher(ctx) {
        return Err("protected_mail_publisher_required".into());
    }
    let processors = canonical_processors(processors)?;
    let resolved = resolve_source(ctx, &source)?;
    resolve_source_graph(ctx, resolved.collection_id, std::slice::from_ref(&source))?;
    let id = policy_id(&source);
    if ctx
        .db
        .protected_mail_source_policy_head()
        .id()
        .find(id.clone())
        .is_some()
    {
        current_policy(ctx, &resolved)?;
        let initial = ctx
            .db
            .protected_mail_source_policy_history()
            .id()
            .find(history_id(&id, 1))
            .ok_or("protected_mail_source_policy_inconsistent")?;
        if initial.source != source
            || initial.owner != resolved.owner
            || initial.collection_id != resolved.collection_id
            || initial.policy_id != id
            || initial.generation != 1
            || initial.revoked
            || initial.processors != processors
            || !initial.allow_owner_storage
        {
            return Err("protected_mail_source_policy_initialization_conflict".into());
        }
        return Ok(());
    }
    // Only first enrollment is current-only. Historical exact initialization
    // replay above remains read-only after edits, decisions or revocation.
    super::instructions::require_current_instruction_for_initial_policy(ctx, &source)?;
    // An initialized derived source cannot exceed any ancestor's current
    // ceiling. Normally derivation installs its policy in the same transaction.
    if !resolved.parents.is_empty() {
        let effective = current_effective_policy(ctx, resolved.collection_id, &resolved.parents)?;
        if !effective.allow_owner_storage
            || !processors.iter().all(|p| effective.processors.contains(p))
        {
            return Err("protected_mail_source_policy_expansion".into());
        }
    }
    insert_initial_policy(ctx, &resolved, processors, true)
}

fn validate_narrowing(
    current_generation: u64,
    expected_generation: u64,
    current_processors: &[ProtectedMailProcessor],
    current_storage: bool,
    current_revoked: bool,
    processors: &[ProtectedMailProcessor],
    allow_owner_storage: bool,
    revoked: bool,
) -> Result<bool, String> {
    if current_generation != expected_generation {
        return Err("protected_mail_source_policy_stale".into());
    }
    if !processors.iter().all(|p| current_processors.contains(p))
        || (allow_owner_storage && !current_storage)
        || (current_revoked && !revoked)
    {
        return Err("protected_mail_source_policy_expansion".into());
    }
    Ok(current_processors != processors
        || current_storage != allow_owner_storage
        || current_revoked != revoked)
}

#[reducer]
pub fn narrow_protected_mail_source_policy(
    ctx: &ReducerContext,
    source: ProtectedMailSourceRef,
    expected_generation: u64,
    processors: Vec<ProtectedMailProcessor>,
    allow_owner_storage: bool,
    revoked: bool,
) -> Result<(), String> {
    let publisher = sender_is_module_publisher(ctx);
    if !publisher && !authenticated_human_sender(ctx) {
        return Err("protected_mail_source_policy_owner_required".into());
    }
    // Ordinary callers must not learn whether a private reference exists or
    // merely has a different digest/revision. Authenticate first, then expose
    // source/policy diagnostics only after exact ownership is established.
    let resolved = if publisher {
        resolve_source(ctx, &source)?
    } else {
        resolve_source(ctx, &source)
            .ok()
            .filter(|resolved| resolved.owner == ctx.sender())
            .ok_or("protected_mail_source_policy_owner_required")?
    };
    let processors = canonical_processors(processors)?;
    resolve_source_graph(ctx, resolved.collection_id, std::slice::from_ref(&source))?;
    let current = current_policy(ctx, &resolved)?;
    if !validate_narrowing(
        current.generation,
        expected_generation,
        &current.processors,
        current.allow_owner_storage,
        current.revoked,
        &processors,
        allow_owner_storage,
        revoked,
    )? {
        return Ok(());
    }
    let generation = current
        .generation
        .checked_add(1)
        .ok_or("protected_mail_source_policy_generation_exhausted")?;
    let id = policy_id(&source);
    if ctx
        .db
        .protected_mail_source_policy_history()
        .id()
        .find(history_id(&id, generation))
        .is_some()
    {
        return Err("protected_mail_source_policy_inconsistent".into());
    }
    ctx.db
        .protected_mail_source_policy_history()
        .insert(ProtectedMailSourcePolicyHistory {
            id: history_id(&id, generation),
            policy_id: id.clone(),
            source: source.clone(),
            owner: resolved.owner,
            collection_id: resolved.collection_id,
            generation,
            processors,
            allow_owner_storage,
            revoked,
            changed_by: ctx.sender(),
            changed_at: ctx.timestamp,
        });
    ctx.db
        .protected_mail_source_policy_head()
        .id()
        .update(ProtectedMailSourcePolicyHead {
            id,
            source,
            owner: resolved.owner,
            collection_id: resolved.collection_id,
            generation,
        });
    Ok(())
}

/// Called only within the publisher's local derivation transaction after its
/// immutable content/source association has been inserted. Rechecks live
/// ancestry and ceilings; callers cannot install a broader derived policy.
pub(super) fn install_derived_policy(
    ctx: &ReducerContext,
    reference: &ProtectedMailSourceRef,
    processors: Vec<ProtectedMailProcessor>,
    allow_owner_storage: bool,
) -> Result<(), String> {
    if !sender_is_module_publisher(ctx) {
        return Err("protected_mail_publisher_required".into());
    }
    install_derived_policy_checked(ctx,reference,processors,allow_owner_storage)
}

fn install_derived_policy_checked(
    ctx: &ReducerContext,
    reference: &ProtectedMailSourceRef,
    processors: Vec<ProtectedMailProcessor>,
    allow_owner_storage: bool,
) -> Result<(), String> {
    let processors = canonical_processors(processors)?;
    let resolved = super::provenance::resolve_derived_source(ctx, reference)?
        .ok_or("protected_mail_source_missing")?;
    resolve_source_graph(ctx, resolved.collection_id, std::slice::from_ref(reference))?;
    let effective = current_effective_policy(ctx, resolved.collection_id, &resolved.parents)?;
    if (allow_owner_storage && !effective.allow_owner_storage)
        || !processors.iter().all(|p| effective.processors.contains(p))
    {
        return Err("protected_mail_source_policy_expansion".into());
    }
    insert_initial_policy(ctx, &resolved, processors, allow_owner_storage)
}

/// A separate, same-transaction result capability; the public publisher
/// installer above keeps its original authentication gate unchanged.
pub(super) fn install_accepted_result_policy(ctx: &ReducerContext,
    authority: &super::results::AuthorizedResultWrite, reference: &ProtectedMailSourceRef) -> Result<(),String> {
    if !authority.matches_context(ctx) { return Err("protected_mail_result_inconsistent".into()); }
    let resolved=super::provenance::resolve_derived_source(ctx,reference)?.ok_or("protected_mail_result_inconsistent")?;
    if resolved.owner != authority.owner() || resolved.collection_id != authority.collection_id() || resolved.parents != authority.parents() {
        return Err("protected_mail_result_inconsistent".into());
    }
    install_derived_policy_checked(ctx,reference,authority.processors().to_vec(),true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn processor(name: &str) -> ProtectedMailProcessor {
        ProtectedMailProcessor {
            profile_id: name.into(),
            revision: "config-1".into(),
            endpoint: "https://processor.example.test/v1/summary".into(),
            model: "fixed-model".into(),
        }
    }

    fn reference(id: &str) -> ProtectedMailSourceRef {
        ProtectedMailSourceRef {
            id: id.into(),
            revision: 1,
            digest: "a".repeat(64),
        }
    }

    fn source(id: &str, parents: &[&str]) -> ResolvedProtectedMailSource {
        ResolvedProtectedMailSource {
            reference: reference(id),
            owner: Identity::from_byte_array([1; 32]),
            collection_id: 7,
            parents: parents.iter().map(|id| reference(id)).collect(),
        }
    }

    fn resolve_fixture(
        references: &[ProtectedMailSourceRef],
        nodes: Vec<ResolvedProtectedMailSource>,
    ) -> Result<Vec<ResolvedProtectedMailSource>, String> {
        let nodes: BTreeMap<_, _> = nodes
            .into_iter()
            .map(|s| ((s.reference.id.clone(), s.reference.revision), s))
            .collect();
        walk_source_graph(
            Identity::from_byte_array([1; 32]),
            7,
            references,
            |reference| {
                nodes
                    .get(&(reference.id.clone(), reference.revision))
                    .cloned()
                    .ok_or("protected_mail_source_missing".into())
            },
        )
    }

    #[test]
    fn processor_ceiling_is_an_exact_canonical_set() {
        let a = processor("a");
        let b = processor("b");
        assert_eq!(
            canonical_processors(vec![b.clone(), a.clone()]).unwrap(),
            vec![a.clone(), b]
        );
        assert!(canonical_processors(vec![a.clone(), a]).is_err());
        assert!(
            canonical_processors((0..33).map(|i| processor(&format!("p{i}"))).collect()).is_err()
        );
        assert!(canonical_processors(vec![]).unwrap().is_empty());
    }

    #[test]
    fn processor_endpoints_require_canonical_credential_free_https() {
        for endpoint in [
            "http://processor.example.test/v1/summary",
            "https://user@processor.example.test/v1/summary",
            "https://user:password@processor.example.test/v1/summary",
            "https://processor.example.test/v1/summary?",
            "https://processor.example.test/v1/summary#",
            "https://PROCESSOR.example.test/v1/summary",
            "https://processor.example.test:443/v1/summary",
            "https://processor.example.test/../v1/summary",
            "https://processor.example.test",
            " https://processor.example.test/v1/summary",
            "https://processor.example.test/v1/summary\n",
        ] {
            let mut p = processor("a");
            p.endpoint = endpoint.into();
            assert!(!valid_processor(&p));
        }
        assert!(valid_processor(&processor("a")));
        let mut p = processor("a");
        p.model = "model\tsecret".into();
        assert!(!valid_processor(&p));
    }

    #[test]
    fn reference_identity_binds_id_revision_and_digest() {
        let original = reference("mail-source:a");
        assert!(validate_source_ref(&original).is_ok());
        let mut revision = original.clone();
        revision.revision += 1;
        let mut digest = original.clone();
        digest.digest = "b".repeat(64);
        assert_ne!(policy_id(&original), policy_id(&revision));
        assert_ne!(policy_id(&original), policy_id(&digest));
        for invalid in [
            ProtectedMailSourceRef {
                revision: 0,
                ..original.clone()
            },
            ProtectedMailSourceRef {
                digest: "A".repeat(64),
                ..original.clone()
            },
            ProtectedMailSourceRef {
                id: " source".into(),
                ..original.clone()
            },
        ] {
            assert!(validate_source_ref(&invalid).is_err());
        }
    }

    #[test]
    fn enrollment_marker_rejects_orphan_or_mismatched_policy_associations() {
        let source = source("mail-instruction-head:fixture", &[]);
        let fixture = || {
            let id = policy_id(&source.reference);
            (
                ProtectedMailSourcePolicyHead {
                    id: id.clone(),
                    source: source.reference.clone(),
                    owner: source.owner,
                    collection_id: source.collection_id,
                    generation: 2,
                },
                ProtectedMailSourcePolicyHistory {
                    id: history_id(&id, 1),
                    policy_id: id,
                    source: source.reference.clone(),
                    owner: source.owner,
                    collection_id: source.collection_id,
                    generation: 1,
                    processors: vec![processor("a")],
                    allow_owner_storage: true,
                    revoked: false,
                    changed_by: source.owner,
                    changed_at: Timestamp::from_micros_since_unix_epoch(1),
                },
            )
        };
        let (head, initial) = fixture();
        assert_eq!(enrollment_matches(&source, None, None), Ok(false));
        assert_eq!(
            enrollment_matches(&source, Some(&head), Some(&initial)),
            Ok(true)
        );
        assert!(enrollment_matches(&source, Some(&head), None).is_err());
        assert!(enrollment_matches(&source, None, Some(&initial)).is_err());
        for field in 0..10 {
            let (mut head, mut initial) = fixture();
            match field {
                0 => head.source.digest = "b".repeat(64),
                1 => head.owner = Identity::from_byte_array([2; 32]),
                2 => head.collection_id += 1,
                3 => head.generation = 0,
                4 => initial.id.push('x'),
                5 => initial.policy_id.push('x'),
                6 => initial.source.revision += 1,
                7 => initial.generation += 1,
                8 => initial.revoked = true,
                _ => initial.processors.push(processor("a")),
            }
            assert!(enrollment_matches(&source, Some(&head), Some(&initial)).is_err());
        }
    }

    #[test]
    fn narrowing_never_expands_or_rewinds_and_checks_cas_before_noop() {
        let a = processor("a");
        let b = processor("b");
        assert_eq!(
            validate_narrowing(
                2,
                2,
                &[a.clone(), b.clone()],
                true,
                false,
                &[a.clone()],
                true,
                false
            ),
            Ok(true)
        );
        assert_eq!(
            validate_narrowing(2, 2, &[a.clone()], true, false, &[a.clone()], true, false),
            Ok(false)
        );
        assert_eq!(
            validate_narrowing(2, 1, &[a.clone()], true, false, &[a.clone()], true, false),
            Err("protected_mail_source_policy_stale".into())
        );
        assert_eq!(
            validate_narrowing(2, 2, &[a.clone()], true, false, &[b], true, false),
            Err("protected_mail_source_policy_expansion".into())
        );
        assert_eq!(
            validate_narrowing(2, 2, &[a.clone()], false, false, &[a.clone()], true, false),
            Err("protected_mail_source_policy_expansion".into())
        );
        assert_eq!(
            validate_narrowing(2, 2, &[a.clone()], false, true, &[a], false, false),
            Err("protected_mail_source_policy_expansion".into())
        );
    }

    #[test]
    fn processor_config_changes_are_expansions_even_for_same_profile() {
        let original = processor("a");
        for field in 0..3 {
            let mut changed = original.clone();
            match field {
                0 => changed.revision = "config-2".into(),
                1 => changed.endpoint = "https://other.example.test/v1/summary".into(),
                _ => changed.model = "other-model".into(),
            }
            assert_eq!(
                validate_narrowing(
                    1,
                    1,
                    &[original.clone()],
                    true,
                    false,
                    &[changed],
                    true,
                    false
                ),
                Err("protected_mail_source_policy_expansion".into())
            );
        }
    }

    #[test]
    fn graph_closure_is_complete_sorted_and_deduplicated() {
        let closure = resolve_fixture(
            &[reference("d"), reference("b")],
            vec![
                source("d", &["c", "b"]),
                source("c", &["a"]),
                source("b", &["a"]),
                source("a", &[]),
            ],
        )
        .unwrap();
        assert_eq!(
            closure
                .iter()
                .map(|s| s.reference.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b", "c", "d"]
        );
    }

    #[test]
    fn graph_keeps_distinct_revisions_of_one_source_identity() {
        let older = source("same-source", &[]);
        let mut newer = source("same-source", &[]);
        newer.reference.revision = 2;
        newer.reference.digest = "b".repeat(64);
        newer.parents = vec![older.reference.clone()];
        let closure = resolve_fixture(&[newer.reference.clone()], vec![newer, older]).unwrap();
        assert_eq!(closure.len(), 2);
        assert_eq!(closure[0].reference.revision, 1);
        assert_eq!(closure[1].reference.revision, 2);
        assert_eq!(closure[1].parents, vec![closure[0].reference.clone()]);
    }

    #[test]
    fn graph_rejects_missing_conflicting_cyclic_and_cross_scope_sources() {
        assert_eq!(
            resolve_fixture(&[reference("a")], vec![]),
            Err("protected_mail_source_missing".into())
        );
        assert_eq!(
            resolve_fixture(
                &[reference("a")],
                vec![source("a", &["b"]), source("b", &["a"])]
            ),
            Err("protected_mail_source_cycle".into())
        );
        let mut other = source("a", &[]);
        other.owner = Identity::from_byte_array([2; 32]);
        assert_eq!(
            resolve_fixture(&[reference("a")], vec![other]),
            Err("protected_mail_source_scope_mismatch".into())
        );
        let mut other = source("a", &[]);
        other.collection_id = 8;
        assert_eq!(
            resolve_fixture(&[reference("a")], vec![other]),
            Err("protected_mail_source_scope_mismatch".into())
        );
        let mut conflicting = reference("a");
        conflicting.digest = "b".repeat(64);
        assert_eq!(
            resolve_fixture(&[reference("a"), conflicting], vec![source("a", &[])]),
            Err("protected_mail_source_conflict".into())
        );
    }

    #[test]
    fn graph_bounds_cover_depth_size_and_cached_longer_paths() {
        let chain = |length: usize| {
            (0..length)
                .map(|i| {
                    source(
                        &format!("n{i:03}"),
                        &if i == 0 {
                            vec![]
                        } else {
                            vec![format!("n{:03}", i - 1)]
                        }
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                    )
                })
                .collect::<Vec<_>>()
        };
        assert!(resolve_fixture(&[reference("n031")], chain(32)).is_ok());
        assert_eq!(
            resolve_fixture(&[reference("n032")], chain(33)),
            Err("protected_mail_source_graph_bounds".into())
        );
        let leaves = (0..256)
            .map(|i| source(&format!("leaf{i:03}"), &[]))
            .collect::<Vec<_>>();
        let refs = leaves
            .iter()
            .map(|s| s.reference.clone())
            .collect::<Vec<_>>();
        assert!(resolve_fixture(&refs, leaves).is_ok());
        let mut nodes = chain(31);
        nodes.push(source("longer", &["n030"]));
        nodes.push(source("too-long", &["longer"]));
        // Visit and cache n030 at a short path first, then reach it deeper.
        assert_eq!(
            resolve_fixture(&[reference("n030"), reference("too-long")], nodes),
            Err("protected_mail_source_graph_bounds".into())
        );
        let mut wide = source("wide", &[]);
        wide.parents = (0..256)
            .map(|i| reference(&format!("leaf{i:03}")))
            .collect();
        let mut nodes = (0..256)
            .map(|i| source(&format!("leaf{i:03}"), &[]))
            .collect::<Vec<_>>();
        nodes.push(wide);
        assert_eq!(
            resolve_fixture(&[reference("wide")], nodes),
            Err("protected_mail_source_graph_bounds".into())
        );
    }

    #[test]
    fn prospective_instruction_wrapper_counts_against_depth_and_node_bounds() {
        let mut chain = Vec::<ResolvedProtectedMailSource>::new();
        for revision in 1..=32 {
            chain.push(ResolvedProtectedMailSource {
                reference: ProtectedMailSourceRef {
                    id: "mail-instruction-head:one-family".into(),
                    revision,
                    digest: format!("{revision:064x}"),
                },
                owner: Identity::from_byte_array([1; 32]),
                collection_id: 7,
                parents: chain
                    .last()
                    .map(|source| vec![source.reference.clone()])
                    .unwrap_or_default(),
            });
        }
        let previous = chain.last().unwrap().reference.clone();
        assert!(resolve_fixture(std::slice::from_ref(&previous), chain.clone()).is_ok());
        let wrapper = ResolvedProtectedMailSource {
            reference: ProtectedMailSourceRef {
                revision: 33,
                digest: format!("{:064x}", 33),
                ..previous.clone()
            },
            parents: vec![previous],
            ..chain.last().unwrap().clone()
        };
        let reference = wrapper.reference.clone();
        chain.push(wrapper);
        assert_eq!(
            resolve_fixture(&[reference], chain),
            Err("protected_mail_source_graph_bounds".into())
        );

        let mut leaves = (0..256)
            .map(|i| source(&format!("mail-source:leaf-{i}"), &[]))
            .collect::<Vec<_>>();
        let parents = leaves
            .iter()
            .map(|source| source.reference.clone())
            .collect::<Vec<_>>();
        assert!(resolve_fixture(&parents, leaves.clone()).is_ok());
        let mut wrapper = source("mail-instruction-head:wide-family", &[]);
        wrapper.parents = parents;
        let reference = wrapper.reference.clone();
        leaves.push(wrapper);
        assert_eq!(
            resolve_fixture(&[reference], leaves),
            Err("protected_mail_source_graph_bounds".into())
        );
    }
}
