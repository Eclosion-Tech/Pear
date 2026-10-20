//! Frozen protected-processor declarations. These private management records
//! do not authenticate a credential vault, approve a workflow, admit disclosure
//! or dispatch a request. No generic AI configuration or environment is read.

use sha2::{Digest, Sha256};
use spacetimedb::{reducer, table, Identity, ReducerContext, SpacetimeType, Table, Timestamp};
use url::Url;

use crate::module_install::sender_is_module_publisher;

const INVALID_PROFILE: &str = "protected_mail_processor_invalid_profile";
const INVALID_EVENT: &str = "protected_mail_processor_invalid_event";
const INVALID_CONFIG: &str = "protected_mail_processor_invalid_config";
const REQUIRED: &str = "protected_mail_processor_required";
const INCONSISTENT: &str = "protected_mail_processor_inconsistent";
const CONFLICT: &str = "protected_mail_processor_event_conflict";
const STALE: &str = "protected_mail_processor_stale";
const RETIRED: &str = "protected_mail_processor_retired";
const EXHAUSTED: &str = "protected_mail_processor_generation_exhausted";

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailProcessorAdapter {
    AnthropicMessagesV1,
    OpenAiChatCompletionsV1,
}

/// Closed, versioned declaration. Credential fields are opaque host-declared
/// references, never a raw-key field or proof that a matching secret exists.
#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub struct ProtectedMailProcessorConfig {
    pub format_version: u32,
    pub adapter: ProtectedMailProcessorAdapter,
    /// Complete exact HTTPS request URL, not an SDK base URL or domain rule.
    pub endpoint: String,
    pub model: String,
    pub credential_handle: String,
    pub credential_version: String,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq, Eq)]
pub enum ProtectedMailProcessorEventKind {
    Configure,
    Retire,
}

#[table(accessor = protected_mail_processor_head, private)]
pub struct ProtectedMailProcessorHead {
    #[primary_key]
    pub profile_id: String,
    pub generation: u64,
    pub current_revision_id: String,
    pub retired: bool,
    pub last_event_id: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[table(accessor = protected_mail_processor_revision, private)]
pub struct ProtectedMailProcessorRevision {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub profile_id: String,
    pub generation: u64,
    pub digest: String,
    pub config: ProtectedMailProcessorConfig,
    pub event_id: String,
    pub created_by: Identity,
    pub created_at: Timestamp,
}

#[table(accessor = protected_mail_processor_event, private)]
pub struct ProtectedMailProcessorEvent {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub profile_id: String,
    pub event_key: String,
    pub kind: ProtectedMailProcessorEventKind,
    pub expected_generation: u64,
    pub generation: u64,
    pub request_digest: String,
    pub revision_id: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}

fn valid_opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

fn valid_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn bounded_text(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_config(config: &ProtectedMailProcessorConfig) -> bool {
    config.format_version == 1
        && bounded_text(&config.model, 256)
        && valid_opaque(&config.credential_handle)
        && valid_opaque(&config.credential_version)
        && bounded_text(&config.endpoint, 2048)
        && Url::parse(&config.endpoint).is_ok_and(|endpoint| {
            endpoint.scheme() == "https"
                && endpoint.has_host()
                && endpoint.username().is_empty()
                && endpoint.password().is_none()
                && endpoint.query().is_none()
                && endpoint.fragment().is_none()
                && endpoint.as_str() == config.endpoint
        })
}

fn adapter_name(adapter: &ProtectedMailProcessorAdapter) -> &'static str {
    match adapter {
        ProtectedMailProcessorAdapter::AnthropicMessagesV1 => "anthropic.messages.v1",
        ProtectedMailProcessorAdapter::OpenAiChatCompletionsV1 => "openai.chat-completions.v1",
    }
}

fn hash_fields(domain: &str, fields: &[String]) -> String {
    let mut hash = Sha256::new();
    for field in std::iter::once(domain).chain(fields.iter().map(String::as_str)) {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    hex::encode(hash.finalize())
}

fn config_digest(config: &ProtectedMailProcessorConfig) -> String {
    hash_fields(
        "pear-mail-processor-config-v1",
        &[
            config.format_version.to_string(),
            adapter_name(&config.adapter).into(),
            config.endpoint.clone(),
            config.model.clone(),
            config.credential_handle.clone(),
            config.credential_version.clone(),
        ],
    )
}

fn revision_id(profile_id: &str, generation: u64, digest: &str) -> String {
    format!(
        "mail-processor-revision:{}",
        hash_fields(
            "pear-mail-processor-revision-v1",
            &[profile_id.into(), generation.to_string(), digest.into(),]
        )
    )
}

fn event_id(profile_id: &str, event_key: &str) -> String {
    format!(
        "mail-processor-event:{}",
        hash_fields(
            "pear-mail-processor-event-v1",
            &[profile_id.into(), event_key.into(),]
        )
    )
}

fn request_digest(
    profile_id: &str,
    expected_generation: u64,
    event_key: &str,
    kind: &ProtectedMailProcessorEventKind,
    config_digest: Option<&str>,
) -> String {
    let mut fields = vec![
        profile_id.into(),
        expected_generation.to_string(),
        event_key.into(),
        match kind {
            ProtectedMailProcessorEventKind::Configure => "configure".into(),
            ProtectedMailProcessorEventKind::Retire => "retire".into(),
        },
    ];
    if let Some(digest) = config_digest {
        fields.push(digest.into());
    }
    hash_fields("pear-mail-processor-request-v1", &fields)
}

fn revision_matches(revision: &ProtectedMailProcessorRevision) -> bool {
    valid_opaque(&revision.profile_id)
        && revision.generation > 0
        && valid_config(&revision.config)
        && revision.digest == config_digest(&revision.config)
        && revision.id == revision_id(&revision.profile_id, revision.generation, &revision.digest)
}

fn event_matches(
    event: &ProtectedMailProcessorEvent,
    revision: &ProtectedMailProcessorRevision,
) -> bool {
    if !revision_matches(revision)
        || event.profile_id != revision.profile_id
        || !valid_hex(&event.event_key)
        || event.id != event_id(&event.profile_id, &event.event_key)
        || event.expected_generation.checked_add(1) != Some(event.generation)
        || event.revision_id != revision.id
    {
        return false;
    }
    match event.kind {
        ProtectedMailProcessorEventKind::Configure => {
            event.generation == revision.generation
                && event.id == revision.event_id
                && event.actor == revision.created_by
                && event.created_at == revision.created_at
                && event.request_digest
                    == request_digest(
                        &event.profile_id,
                        event.expected_generation,
                        &event.event_key,
                        &event.kind,
                        Some(&revision.digest),
                    )
        }
        ProtectedMailProcessorEventKind::Retire => {
            event.expected_generation == revision.generation
                && event.id != revision.event_id
                && event.request_digest
                    == request_digest(
                        &event.profile_id,
                        event.expected_generation,
                        &event.event_key,
                        &event.kind,
                        None,
                    )
        }
    }
}

fn head_matches(
    head: &ProtectedMailProcessorHead,
    revision: &ProtectedMailProcessorRevision,
    latest_event: &ProtectedMailProcessorEvent,
) -> bool {
    head.profile_id == revision.profile_id
        && head.current_revision_id == revision.id
        && head.generation == latest_event.generation
        && head.last_event_id == latest_event.id
        && head.retired == (latest_event.kind == ProtectedMailProcessorEventKind::Retire)
        && event_matches(latest_event, revision)
}

pub(super) fn checked_revision(
    ctx: &ReducerContext,
    id: &str,
) -> Result<ProtectedMailProcessorRevision, String> {
    let revision = ctx
        .db
        .protected_mail_processor_revision()
        .id()
        .find(id.to_owned())
        .ok_or(INCONSISTENT)?;
    let configured = ctx
        .db
        .protected_mail_processor_event()
        .id()
        .find(revision.event_id.clone())
        .ok_or(INCONSISTENT)?;
    if configured.kind != ProtectedMailProcessorEventKind::Configure
        || !event_matches(&configured, &revision)
    {
        return Err(INCONSISTENT.into());
    }
    Ok(revision)
}

pub(super) fn checked_head(
    ctx: &ReducerContext,
    profile_id: &str,
) -> Result<Option<(ProtectedMailProcessorHead, ProtectedMailProcessorRevision)>, String> {
    let Some(head) = ctx
        .db
        .protected_mail_processor_head()
        .profile_id()
        .find(profile_id.to_owned())
    else {
        return Ok(None);
    };
    let revision = checked_revision(ctx, &head.current_revision_id)?;
    let latest = ctx
        .db
        .protected_mail_processor_event()
        .id()
        .find(head.last_event_id.clone())
        .ok_or(INCONSISTENT)?;
    if head.profile_id != profile_id || !head_matches(&head, &revision, &latest) {
        return Err(INCONSISTENT.into());
    }
    Ok(Some((head, revision)))
}

fn replay_matches(
    event: &ProtectedMailProcessorEvent,
    revision: &ProtectedMailProcessorRevision,
    head: &ProtectedMailProcessorHead,
    digest: &str,
) -> Result<(), String> {
    if !event_matches(event, revision)
        || event.profile_id != head.profile_id
        || event.generation > head.generation
    {
        return Err(INCONSISTENT.into());
    }
    if event.request_digest != digest {
        return Err(CONFLICT.into());
    }
    Ok(())
}

/// Shared event namespace across configure and retire. Historical retries are
/// read-only: neither retirement nor a later revision can be undone by replay.
fn historical_replay(
    ctx: &ReducerContext,
    profile_id: &str,
    event_key: &str,
    digest: &str,
    head: Option<&ProtectedMailProcessorHead>,
) -> Result<bool, String> {
    let Some(event) = ctx
        .db
        .protected_mail_processor_event()
        .id()
        .find(event_id(profile_id, event_key))
    else {
        return Ok(false);
    };
    let revision = checked_revision(ctx, &event.revision_id)?;
    replay_matches(&event, &revision, head.ok_or(INCONSISTENT)?, digest)?;
    Ok(true)
}

fn next_generation(current: u64, expected: u64, retired: bool) -> Result<u64, String> {
    if retired {
        return Err(RETIRED.into());
    }
    if current != expected {
        return Err(STALE.into());
    }
    current.checked_add(1).ok_or_else(|| EXHAUSTED.into())
}

fn require_publisher(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_module_publisher(ctx) {
        return Err("protected_mail_publisher_required".into());
    }
    Ok(())
}

/// A new event always creates a new immutable revision, even when every
/// declared configuration field is identical. Credentials and configuration
/// can therefore never edit-and-revert to an older revision identity.
#[reducer]
pub fn configure_protected_mail_processor(
    ctx: &ReducerContext,
    profile_id: String,
    expected_generation: u64,
    event_key: String,
    config: ProtectedMailProcessorConfig,
) -> Result<(), String> {
    require_publisher(ctx)?;
    if !valid_opaque(&profile_id) {
        return Err(INVALID_PROFILE.into());
    }
    if !valid_hex(&event_key) {
        return Err(INVALID_EVENT.into());
    }
    if !valid_config(&config) {
        return Err(INVALID_CONFIG.into());
    }
    let existing = checked_head(ctx, &profile_id)?;
    let digest = config_digest(&config);
    let request = request_digest(
        &profile_id,
        expected_generation,
        &event_key,
        &ProtectedMailProcessorEventKind::Configure,
        Some(&digest),
    );
    if historical_replay(
        ctx,
        &profile_id,
        &event_key,
        &request,
        existing.as_ref().map(|(head, _)| head),
    )? {
        return Ok(());
    }
    // Processor profiles are retained private state even without a collection.
    // Do not create a new revision alongside an ordinary snapshot restore.
    crate::import::pear_v2::require_no_snapshot_import(ctx)?;
    let generation = next_generation(
        existing.as_ref().map_or(0, |(head, _)| head.generation),
        expected_generation,
        existing.as_ref().is_some_and(|(head, _)| head.retired),
    )?;
    let revision_id = revision_id(&profile_id, generation, &digest);
    let event_id = event_id(&profile_id, &event_key);
    if ctx
        .db
        .protected_mail_processor_revision()
        .id()
        .find(revision_id.clone())
        .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    ctx.db
        .protected_mail_processor_revision()
        .insert(ProtectedMailProcessorRevision {
            id: revision_id.clone(),
            profile_id: profile_id.clone(),
            generation,
            digest,
            config,
            event_id: event_id.clone(),
            created_by: ctx.sender(),
            created_at: ctx.timestamp,
        });
    ctx.db
        .protected_mail_processor_event()
        .insert(ProtectedMailProcessorEvent {
            id: event_id.clone(),
            profile_id: profile_id.clone(),
            event_key,
            kind: ProtectedMailProcessorEventKind::Configure,
            expected_generation,
            generation,
            request_digest: request,
            revision_id: revision_id.clone(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    let head = ProtectedMailProcessorHead {
        profile_id,
        generation,
        current_revision_id: revision_id,
        retired: false,
        last_event_id: event_id,
        created_at: existing
            .as_ref()
            .map_or(ctx.timestamp, |(head, _)| head.created_at),
        updated_at: ctx.timestamp,
    };
    if existing.is_some() {
        ctx.db
            .protected_mail_processor_head()
            .profile_id()
            .update(head);
    } else {
        ctx.db.protected_mail_processor_head().insert(head);
    }
    Ok(())
}

/// Retirement is terminal. Keep the last configuration, all revisions and the
/// retirement event; replacement requires a new profile identity and cannot
/// silently match a source ceiling for any prior revision.
#[reducer]
pub fn retire_protected_mail_processor(
    ctx: &ReducerContext,
    profile_id: String,
    expected_generation: u64,
    event_key: String,
) -> Result<(), String> {
    require_publisher(ctx)?;
    if !valid_opaque(&profile_id) {
        return Err(INVALID_PROFILE.into());
    }
    if !valid_hex(&event_key) {
        return Err(INVALID_EVENT.into());
    }
    let (head, revision) = checked_head(ctx, &profile_id)?.ok_or(REQUIRED)?;
    let request = request_digest(
        &profile_id,
        expected_generation,
        &event_key,
        &ProtectedMailProcessorEventKind::Retire,
        None,
    );
    if historical_replay(ctx, &profile_id, &event_key, &request, Some(&head))? {
        return Ok(());
    }
    let generation = next_generation(head.generation, expected_generation, head.retired)?;
    let event_id = event_id(&profile_id, &event_key);
    ctx.db
        .protected_mail_processor_event()
        .insert(ProtectedMailProcessorEvent {
            id: event_id.clone(),
            profile_id,
            event_key,
            kind: ProtectedMailProcessorEventKind::Retire,
            expected_generation,
            generation,
            request_digest: request,
            revision_id: revision.id,
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        });
    ctx.db
        .protected_mail_processor_head()
        .profile_id()
        .update(ProtectedMailProcessorHead {
            generation,
            retired: true,
            last_event_id: event_id,
            updated_at: ctx.timestamp,
            ..head
        });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ProtectedMailProcessorConfig {
        ProtectedMailProcessorConfig {
            format_version: 1,
            adapter: ProtectedMailProcessorAdapter::AnthropicMessagesV1,
            endpoint: "https://processor.example.test/v1/messages".into(),
            model: "fixture-model".into(),
            credential_handle: "fixture-vault-handle".into(),
            credential_version: "version-1".into(),
        }
    }

    fn fixture(
        profile: &str,
        generation: u64,
        event_key: &str,
        config: ProtectedMailProcessorConfig,
    ) -> (
        ProtectedMailProcessorHead,
        ProtectedMailProcessorRevision,
        ProtectedMailProcessorEvent,
    ) {
        let digest = config_digest(&config);
        let id = revision_id(profile, generation, &digest);
        let event_id = event_id(profile, event_key);
        let actor = Identity::from_byte_array([1; 32]);
        let created_at = Timestamp::from_micros_since_unix_epoch(generation as i64);
        (
            ProtectedMailProcessorHead {
                profile_id: profile.into(),
                generation,
                current_revision_id: id.clone(),
                retired: false,
                last_event_id: event_id.clone(),
                created_at,
                updated_at: created_at,
            },
            ProtectedMailProcessorRevision {
                id: id.clone(),
                profile_id: profile.into(),
                generation,
                digest: digest.clone(),
                config,
                event_id: event_id.clone(),
                created_by: actor,
                created_at,
            },
            ProtectedMailProcessorEvent {
                id: event_id,
                profile_id: profile.into(),
                event_key: event_key.into(),
                kind: ProtectedMailProcessorEventKind::Configure,
                expected_generation: generation - 1,
                generation,
                request_digest: request_digest(
                    profile,
                    generation - 1,
                    event_key,
                    &ProtectedMailProcessorEventKind::Configure,
                    Some(&digest),
                ),
                revision_id: id,
                actor,
                created_at,
            },
        )
    }

    #[test]
    fn endpoints_are_exact_canonical_https_requests_without_auth_query_or_fragment() {
        assert!(valid_config(&config()));
        for endpoint in [
            "http://processor.example.test/v1/messages",
            "https://user@processor.example.test/v1/messages",
            "https://user:password@processor.example.test/v1/messages",
            "https://processor.example.test/v1/messages?",
            "https://processor.example.test/v1/messages?key=fixture",
            "https://processor.example.test/v1/messages#",
            "https://PROCESSOR.example.test/v1/messages",
            "https://processor.example.test:443/v1/messages",
            "https://processor.example.test/../v1/messages",
            "https://processor.example.test",
            " https://processor.example.test/v1/messages",
            "https://processor.example.test/v1/messages\n",
            "https://processor.example.test\\v1\\messages",
        ] {
            let mut value = config();
            value.endpoint = endpoint.into();
            assert!(!valid_config(&value));
        }
        // Declaration alone makes no DNS/TLS/private-host safety claim.
        let mut exact = config();
        exact.endpoint = "https://127.0.0.1:8443/v1/messages".into();
        assert!(valid_config(&exact));
    }

    #[test]
    fn closed_configuration_versions_and_utf8_opaque_limits_fail_without_truncation() {
        let mut value = config();
        value.format_version = 2;
        assert!(!valid_config(&value));
        for invalid in ["", " handle", "handle\n", "vault/secret", "é"] {
            assert!(!valid_opaque(invalid));
            value = config();
            value.credential_handle = invalid.into();
            assert!(!valid_config(&value));
            value = config();
            value.credential_version = invalid.into();
            assert!(!valid_config(&value));
        }
        assert!(valid_opaque(&"a".repeat(128)));
        assert!(!valid_opaque(&"a".repeat(129)));
        for invalid in [
            String::new(),
            " model".into(),
            "model\0".into(),
            "é".repeat(129),
        ] {
            value = config();
            value.model = invalid;
            assert!(!valid_config(&value));
        }
        value = config();
        value.model = "é".repeat(128);
        assert!(valid_config(&value));
        value = config();
        value.endpoint = format!("https://processor.example.test/{}", "a".repeat(2048));
        assert!(!valid_config(&value));
    }

    #[test]
    fn config_digest_binds_every_field_and_length_delimited_boundaries() {
        let original = config();
        let digest = config_digest(&original);
        for field in 0..7 {
            let mut value = original.clone();
            match field {
                0 => value.format_version = 2,
                1 => value.adapter = ProtectedMailProcessorAdapter::OpenAiChatCompletionsV1,
                2 => value.endpoint = "https://other.example.test/v1/messages".into(),
                3 => value.model.push('2'),
                4 => value.credential_handle.push('2'),
                5 => value.credential_version.push('2'),
                _ => {
                    value.credential_handle = "ab".into();
                    value.credential_version = "c".into();
                }
            }
            assert_ne!(digest, config_digest(&value));
        }
        let mut first = original.clone();
        first.credential_handle = "ab".into();
        first.credential_version = "c".into();
        let mut second = original;
        second.credential_handle = "a".into();
        second.credential_version = "bc".into();
        assert_ne!(config_digest(&first), config_digest(&second));
    }

    #[test]
    fn identical_and_credential_reverted_configs_never_reuse_revision_identity() {
        let first = config();
        let digest = config_digest(&first);
        let mut rotated = first.clone();
        rotated.credential_version = "version-2".into();
        assert_ne!(digest, config_digest(&rotated));
        assert_eq!(digest, config_digest(&first));
        assert_ne!(
            revision_id("profile", 1, &digest),
            revision_id("profile", 2, &digest)
        );
        assert_ne!(
            revision_id("profile", 1, &digest),
            revision_id("profile", 3, &digest)
        );
        assert_ne!(
            revision_id("profile", 1, &digest),
            revision_id("another-profile", 1, &digest)
        );
        assert_ne!(
            event_id("profile", &"a".repeat(64)),
            event_id("another-profile", &"a".repeat(64))
        );
    }

    #[test]
    fn stale_retired_and_overflow_transitions_never_reset_generation() {
        assert_eq!(next_generation(0, 0, false), Ok(1));
        assert_eq!(next_generation(4, 4, false), Ok(5));
        assert_eq!(next_generation(4, 3, false), Err(STALE.into()));
        assert_eq!(next_generation(4, 5, false), Err(STALE.into()));
        assert_eq!(next_generation(4, 4, true), Err(RETIRED.into()));
        assert_eq!(next_generation(4, 3, true), Err(RETIRED.into()));
        assert_eq!(
            next_generation(u64::MAX, u64::MAX, false),
            Err(EXHAUSTED.into())
        );
    }

    #[test]
    fn old_config_replay_after_rotation_or_retirement_is_read_only_and_cross_mode_conflicts() {
        let (_, original, event) = fixture("profile", 1, &"a".repeat(64), config());
        let mut rotated = config();
        rotated.credential_version = "version-2".into();
        let (mut current, _, _) = fixture("profile", 2, &"b".repeat(64), rotated);
        let current_revision = current.current_revision_id.clone();
        assert!(replay_matches(&event, &original, &current, &event.request_digest).is_ok());
        assert_eq!(current.generation, 2);
        assert_eq!(current.current_revision_id, current_revision);
        current.retired = true;
        current.generation = 3;
        assert!(replay_matches(&event, &original, &current, &event.request_digest).is_ok());
        assert!(current.retired);
        assert_eq!(current.current_revision_id, current_revision);
        let retire_request = request_digest(
            "profile",
            0,
            &"a".repeat(64),
            &ProtectedMailProcessorEventKind::Retire,
            None,
        );
        assert_eq!(
            replay_matches(&event, &original, &current, &retire_request),
            Err(CONFLICT.into())
        );
        let changed = request_digest(
            "profile",
            1,
            &"a".repeat(64),
            &ProtectedMailProcessorEventKind::Configure,
            Some(&original.digest),
        );
        assert_eq!(
            replay_matches(&event, &original, &current, &changed),
            Err(CONFLICT.into())
        );
    }

    #[test]
    fn head_and_event_associations_fail_closed_for_wrong_revision_status_or_metadata() {
        let (mut head, mut revision, mut event) = fixture("profile", 1, &"a".repeat(64), config());
        assert!(head_matches(&head, &revision, &event));
        head.retired = true;
        assert!(!head_matches(&head, &revision, &event));
        head.retired = false;
        head.generation = 2;
        assert!(!head_matches(&head, &revision, &event));
        head.generation = 1;
        revision.config.model.push('2');
        assert!(!head_matches(&head, &revision, &event));
        revision.config.model.pop();
        event.actor = Identity::from_byte_array([2; 32]);
        assert!(!head_matches(&head, &revision, &event));
        event.actor = revision.created_by;
        event.request_digest = "f".repeat(64);
        assert!(!head_matches(&head, &revision, &event));
    }

    #[test]
    fn retire_keeps_last_revision_and_exact_retirement_replay_cannot_create_a_new_head() {
        let (mut head, revision, _) = fixture("profile", 2, &"a".repeat(64), config());
        let key = "b".repeat(64);
        let id = event_id("profile", &key);
        let event = ProtectedMailProcessorEvent {
            id: id.clone(),
            profile_id: "profile".into(),
            event_key: key.clone(),
            kind: ProtectedMailProcessorEventKind::Retire,
            expected_generation: 2,
            generation: 3,
            request_digest: request_digest(
                "profile",
                2,
                &key,
                &ProtectedMailProcessorEventKind::Retire,
                None,
            ),
            revision_id: revision.id.clone(),
            actor: revision.created_by,
            created_at: Timestamp::from_micros_since_unix_epoch(3),
        };
        head.generation = 3;
        head.retired = true;
        head.last_event_id = id;
        assert!(head_matches(&head, &revision, &event));
        assert!(replay_matches(&event, &revision, &head, &event.request_digest).is_ok());
        assert_eq!(head.current_revision_id, revision.id);
        assert!(head.retired);
        assert_eq!(
            next_generation(head.generation, 3, head.retired),
            Err(RETIRED.into())
        );
    }
}
