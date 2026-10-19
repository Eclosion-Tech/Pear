//! Staged private mail storage, disconnected from the runner. Publisher access
//! remains trusted management authority. These reducers do not admit a runtime
//! operation or certify that an importer's declared sanitization was adequate.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};
use spacetimedb::{
    reducer, table, view, Identity, ReducerContext, SpacetimeType, Table, Timestamp, ViewContext,
};

use super::accounts::{mail_connection, MailConnection};
use crate::ai::{ai_user_config, ai_user_config__view, ai_user_profile, ai_user_profile__view};
use crate::auth::{user, user__view};
use crate::module_install::{module_install_meta__view, sender_is_module_publisher};

const ORIGIN: &str = "external_mail";
const SOURCE_REVISION: u64 = 1;
const INVALID_MESSAGE: &str = "protected_mail_invalid_message";

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ProtectedMailDirection {
    Received,
    Sent,
}

/// Literal bounded text supplied by a trusted importer. No caller-supplied
/// owner, source authority, page, ACL, processor, derived output or raw MIME.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct ProtectedMailInput {
    pub folder: String,
    pub uid_validity: String,
    pub uid: u32,
    pub direction: ProtectedMailDirection,
    pub message_date: String,
    pub from: String,
    pub to: String,
    pub cc: String,
    pub subject: String,
    pub body: String,
    pub note: String,
    pub sanitization_version: String,
}

#[table(accessor = protected_mail_collection, private)]
pub struct ProtectedMailCollection {
    #[primary_key]
    pub id: u64,
    #[index(btree)]
    pub owner: Identity,
    pub created_at: Timestamp,
}

#[table(accessor = protected_mail_source, private)]
pub struct ProtectedMailSource {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub owner: Identity,
    pub collection_id: u64,
    pub revision: u64,
    pub digest: String,
    pub origin: String,
    pub sanitization_version: String,
    pub created_at: Timestamp,
}

#[table(accessor = protected_mail_record, private)]
pub struct ProtectedMailRecord {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub owner: Identity,
    pub collection_id: u64,
    pub source_id: String,
    pub source_revision: u64,
    pub message: ProtectedMailInput,
    pub imported_at: Timestamp,
}

#[table(accessor = protected_mail_receipt, private)]
pub struct ProtectedMailReceipt {
    #[primary_key]
    pub id: String,
    pub owner: Identity,
    pub collection_id: u64,
    pub event_key: String,
    /// Canonical connection/folder/UID-epoch/UID identity, independent of a
    /// caller's request key. A retry cannot re-key one message as a new import.
    #[unique]
    pub mailbox_event_id: String,
    pub record_id: String,
    pub source_id: String,
    pub digest: String,
}

#[derive(SpacetimeType)]
pub struct ProtectedMailCollectionRow {
    pub id: u64,
    pub owner: Identity,
    pub created_at: Timestamp,
}

#[derive(SpacetimeType)]
pub struct ProtectedMailRow {
    pub id: String,
    pub collection_id: u64,
    pub source_id: String,
    pub source_revision: u64,
    pub digest: String,
    pub sanitization_version: String,
    pub origin: String,
    pub imported_at: Timestamp,
    pub message: ProtectedMailInput,
}

pub(super) fn require_legacy_connection(ctx: &ReducerContext, id: u64) -> Result<(), String> {
    if ctx.db.protected_mail_collection().id().find(id).is_some() {
        return Err("protected_mail_legacy_sync_disabled".into());
    }
    Ok(())
}

/// Ordinary snapshots cannot retain protected state while importing a new
/// identity/source universe. A future protected restore needs its own contract.
pub(crate) fn require_no_protected_mail_collections(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.protected_mail_collection().iter().next().is_some() {
        return Err("protected_mail_restore_not_supported".into());
    }
    Ok(())
}

fn paused_human_connection(ctx: &ReducerContext, id: u64) -> Result<MailConnection, String> {
    if !sender_is_module_publisher(ctx) {
        return Err("protected_mail_publisher_required".into());
    }
    let connection = ctx
        .db
        .mail_connection()
        .id()
        .find(id)
        .ok_or("protected_mail_connection_required")?;
    if connection.enabled {
        return Err("protected_mail_connection_not_paused".into());
    }
    if connection.owner == ctx.sender()
        || ctx
            .db
            .ai_user_config()
            .identity()
            .find(connection.owner)
            .is_some()
        || ctx
            .db
            .ai_user_profile()
            .identity()
            .find(connection.owner)
            .is_some()
        || !ctx
            .db
            .user()
            .identity()
            .find(connection.owner)
            .is_some_and(|u| u.is_authenticated)
    {
        return Err("protected_mail_owner_unavailable".into());
    }
    Ok(connection)
}

#[reducer]
pub fn create_protected_mail_collection(
    ctx: &ReducerContext,
    connection_id: u64,
) -> Result<(), String> {
    let connection = paused_human_connection(ctx, connection_id)?;
    crate::import::pear_v2::require_no_snapshot_import(ctx)?;
    if let Some(collection) = ctx.db.protected_mail_collection().id().find(connection_id) {
        if collection.owner != connection.owner {
            return Err("protected_mail_collection_mismatch".into());
        }
        return Ok(());
    }
    ctx.db
        .protected_mail_collection()
        .insert(ProtectedMailCollection {
            id: connection_id,
            owner: connection.owner,
            created_at: ctx.timestamp,
        });
    Ok(())
}

fn one_line(value: &str, limit: usize) -> bool {
    value.len() <= limit && !value.chars().any(char::is_control)
}

fn plain_text(value: &str, limit: usize) -> bool {
    value.len() <= limit
        && !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}

fn validate_message(event_key: &str, message: &ProtectedMailInput) -> Result<(), String> {
    let validity = message.uid_validity.parse::<u64>().ok();
    if event_key.len() != 64
        || !event_key
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || message.folder.is_empty()
        || !one_line(&message.folder, 512)
        || validity.is_none_or(|v| v == 0 || v.to_string() != message.uid_validity)
        || message.uid == 0
        || !one_line(&message.message_date, 64)
        || !one_line(&message.from, 2048)
        || !one_line(&message.to, 2048)
        || !one_line(&message.cc, 2048)
        || !one_line(&message.subject, 1024)
        || !plain_text(&message.body, 160_000)
        || !plain_text(&message.note, 2048)
        || message.sanitization_version.is_empty()
        || message.sanitization_version.len() > 64
        || !message
            .sanitization_version
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        return Err(INVALID_MESSAGE.into());
    }
    Ok(())
}

fn validate_configured_source(
    inbox_folder: &str,
    sent_folder: Option<&str>,
    message: &ProtectedMailInput,
) -> Result<(), String> {
    let matches = match message.direction {
        ProtectedMailDirection::Received => message.folder == inbox_folder,
        ProtectedMailDirection::Sent => sent_folder.is_some_and(|folder| message.folder == folder),
    };
    if !matches {
        return Err("protected_mail_source_mismatch".into());
    }
    Ok(())
}

/// Versioned, length-delimited UTF-8 fields avoid serialization ambiguities.
/// Hashes remain private identifiers, not a claim of anonymization/redaction.
fn message_digest(message: &ProtectedMailInput) -> String {
    let mut hash = Sha256::new();
    let direction = match message.direction {
        ProtectedMailDirection::Received => "received",
        ProtectedMailDirection::Sent => "sent",
    };
    let uid = message.uid.to_string();
    for value in [
        "pear-protected-mail-content-v1",
        ORIGIN,
        &message.folder,
        &message.uid_validity,
        &uid,
        direction,
        &message.message_date,
        &message.from,
        &message.to,
        &message.cc,
        &message.subject,
        &message.body,
        &message.note,
        &message.sanitization_version,
    ] {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    hex::encode(hash.finalize())
}

fn record_id(connection_id: u64, event_key: &str) -> String {
    format!("{connection_id}:{event_key}")
}
fn source_id(record_id: &str) -> String {
    format!("mail-source:{record_id}")
}

fn mailbox_event_id(connection_id: u64, message: &ProtectedMailInput) -> String {
    let mut hash = Sha256::new();
    let connection = connection_id.to_string();
    let uid = message.uid.to_string();
    for value in [
        "pear-protected-mail-event-v1",
        &connection,
        &message.folder,
        &message.uid_validity,
        &uid,
    ] {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    hex::encode(hash.finalize())
}

fn associated(
    collection: &ProtectedMailCollection,
    source: &ProtectedMailSource,
    record: &ProtectedMailRecord,
    receipt: &ProtectedMailReceipt,
) -> bool {
    record.owner == collection.owner
        && source.owner == collection.owner
        && receipt.owner == collection.owner
        && record.collection_id == collection.id
        && source.collection_id == collection.id
        && receipt.collection_id == collection.id
        && record.id == record_id(collection.id, &receipt.event_key)
        && receipt.id == record.id
        && receipt.record_id == record.id
        && receipt.mailbox_event_id == mailbox_event_id(collection.id, &record.message)
        && record.source_id == source_id(&record.id)
        && source.id == record.source_id
        && receipt.source_id == source.id
        && source.revision == SOURCE_REVISION
        && record.source_revision == source.revision
        && source.origin == ORIGIN
        && source.sanitization_version == record.message.sanitization_version
        && source.created_at == record.imported_at
        && source.digest == receipt.digest
        && source.digest == message_digest(&record.message)
}

/// Atomic immutable source + literal record + receipt. No ordinary pages,
/// components, snapshots, conversations, notifications or automation events.
#[reducer]
pub fn append_protected_mail_message(
    ctx: &ReducerContext,
    connection_id: u64,
    event_key: String,
    message: ProtectedMailInput,
) -> Result<(), String> {
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
    validate_message(&event_key, &message)?;
    validate_configured_source(
        &connection.inbox_folder,
        connection.sent_folder.as_deref(),
        &message,
    )?;
    let id = record_id(connection_id, &event_key);
    let source_id = source_id(&id);
    let digest = message_digest(&message);
    let mailbox_event_id = mailbox_event_id(connection_id, &message);
    if let Some(receipt) = ctx.db.protected_mail_receipt().id().find(id.clone()) {
        let record = ctx
            .db
            .protected_mail_record()
            .id()
            .find(id.clone())
            .ok_or("protected_mail_inconsistent_state")?;
        let source = ctx
            .db
            .protected_mail_source()
            .id()
            .find(source_id.clone())
            .ok_or("protected_mail_inconsistent_state")?;
        if !associated(&collection, &source, &record, &receipt) {
            return Err("protected_mail_inconsistent_state".into());
        }
        if receipt.digest != digest || record.message != message {
            return Err("protected_mail_event_conflict".into());
        }
        return Ok(());
    }
    if ctx
        .db
        .protected_mail_receipt()
        .mailbox_event_id()
        .find(mailbox_event_id.clone())
        .is_some()
    {
        return Err("protected_mail_event_conflict".into());
    }
    if ctx
        .db
        .protected_mail_record()
        .id()
        .find(id.clone())
        .is_some()
        || ctx
            .db
            .protected_mail_source()
            .id()
            .find(source_id.clone())
            .is_some()
    {
        return Err("protected_mail_inconsistent_state".into());
    }
    ctx.db.protected_mail_source().insert(ProtectedMailSource {
        id: source_id.clone(),
        owner: collection.owner,
        collection_id: connection_id,
        revision: SOURCE_REVISION,
        digest: digest.clone(),
        origin: ORIGIN.into(),
        sanitization_version: message.sanitization_version.clone(),
        created_at: ctx.timestamp,
    });
    ctx.db.protected_mail_record().insert(ProtectedMailRecord {
        id: id.clone(),
        owner: collection.owner,
        collection_id: connection_id,
        source_id: source_id.clone(),
        source_revision: SOURCE_REVISION,
        message,
        imported_at: ctx.timestamp,
    });
    ctx.db
        .protected_mail_receipt()
        .insert(ProtectedMailReceipt {
            id: id.clone(),
            owner: collection.owner,
            collection_id: connection_id,
            event_key,
            mailbox_event_id,
            record_id: id,
            source_id,
            digest,
        });
    Ok(())
}

fn authenticated_owner(ctx: &ViewContext) -> bool {
    let identity = ctx.sender();
    ctx.db
        .module_install_meta()
        .id()
        .find(0)
        .is_some_and(|m| m.publisher_identity != identity)
        && ctx.db.ai_user_config().identity().find(identity).is_none()
        && ctx.db.ai_user_profile().identity().find(identity).is_none()
        && ctx
            .db
            .user()
            .identity()
            .find(identity)
            .is_some_and(|u| u.is_authenticated)
}

#[view(accessor = my_protected_mail_collections, public)]
pub fn my_protected_mail_collections(ctx: &ViewContext) -> Vec<ProtectedMailCollectionRow> {
    if !authenticated_owner(ctx) {
        return vec![];
    }
    ctx.db
        .protected_mail_collection()
        .owner()
        .filter(ctx.sender())
        .map(|c| ProtectedMailCollectionRow {
            id: c.id,
            owner: c.owner,
            created_at: c.created_at,
        })
        .collect()
}

#[view(accessor = my_protected_mail, public)]
pub fn my_protected_mail(ctx: &ViewContext) -> Vec<ProtectedMailRow> {
    if !authenticated_owner(ctx) {
        return vec![];
    }
    let collections: BTreeMap<_, _> = ctx
        .db
        .protected_mail_collection()
        .owner()
        .filter(ctx.sender())
        .map(|c| (c.id, c))
        .collect();
    let sources: BTreeMap<_, _> = ctx
        .db
        .protected_mail_source()
        .owner()
        .filter(ctx.sender())
        .map(|s| (s.id.clone(), s))
        .collect();
    ctx.db
        .protected_mail_record()
        .owner()
        .filter(ctx.sender())
        .filter_map(|record| {
            let collection = collections.get(&record.collection_id)?;
            let source = sources.get(&record.source_id)?;
            let receipt = ctx
                .db
                .protected_mail_receipt()
                .id()
                .find(record.id.clone())?;
            if !associated(collection, source, &record, &receipt) {
                return None;
            }
            Some(ProtectedMailRow {
                id: record.id,
                collection_id: record.collection_id,
                source_id: record.source_id,
                source_revision: source.revision,
                digest: source.digest.clone(),
                sanitization_version: source.sanitization_version.clone(),
                origin: source.origin.clone(),
                imported_at: record.imported_at,
                message: record.message,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message() -> ProtectedMailInput {
        ProtectedMailInput {
            folder: "INBOX".into(),
            uid_validity: "7".into(),
            uid: 1,
            direction: ProtectedMailDirection::Received,
            message_date: "2026-10-19T12:00:00Z".into(),
            from: "Alice <alice@example.test>".into(),
            to: "owner@example.test".into(),
            cc: String::new(),
            subject: "Fixture".into(),
            body: "Literal émail\nNo action is authorized.\t".into(),
            note: String::new(),
            sanitization_version: "fixture-v1".into(),
        }
    }

    #[test]
    fn typed_plaintext_validates_utf8_bytes_and_control_boundaries() {
        let key = "a".repeat(64);
        let mut m = message();
        assert!(validate_message(&key, &m).is_ok());
        m.body = "é".repeat(80_000);
        assert!(validate_message(&key, &m).is_ok());
        m.body.push('é');
        assert_eq!(validate_message(&key, &m).unwrap_err(), INVALID_MESSAGE);
        for value in ["\0", "\u{1b}", "\u{7f}"] {
            m = message();
            m.body.push_str(value);
            assert_eq!(validate_message(&key, &m).unwrap_err(), INVALID_MESSAGE);
        }
        m = message();
        m.subject.push('\n');
        assert_eq!(validate_message(&key, &m).unwrap_err(), INVALID_MESSAGE);
    }

    #[test]
    fn invalid_identities_versions_and_metadata_fail_with_fixed_errors() {
        for key in ["a".repeat(63), "A".repeat(64), "g".repeat(64)] {
            assert_eq!(
                validate_message(&key, &message()).unwrap_err(),
                INVALID_MESSAGE
            );
        }
        let key = "a".repeat(64);
        for validity in ["", "0", "07", "-1", "18446744073709551616"] {
            let mut m = message();
            m.uid_validity = validity.into();
            assert_eq!(validate_message(&key, &m).unwrap_err(), INVALID_MESSAGE);
        }
        for version in [String::new(), "v1 secret".into(), "a".repeat(65)] {
            let mut m = message();
            m.sanitization_version = version;
            assert_eq!(validate_message(&key, &m).unwrap_err(), INVALID_MESSAGE);
        }
        let mut m = message();
        m.uid = 0;
        assert_eq!(validate_message(&key, &m).unwrap_err(), INVALID_MESSAGE);
        m = message();
        m.folder.clear();
        assert_eq!(validate_message(&key, &m).unwrap_err(), INVALID_MESSAGE);
        m = message();
        m.from = "x".repeat(2049);
        assert_eq!(validate_message(&key, &m).unwrap_err(), INVALID_MESSAGE);
    }

    #[test]
    fn source_direction_requires_exact_explicitly_configured_folder() {
        let mut m = message();
        assert!(validate_configured_source("INBOX", None, &m).is_ok());
        for folder in ["inbox", "Sent", "INBOX.other"] {
            m.folder = folder.into();
            assert_eq!(
                validate_configured_source("INBOX", Some("Sent"), &m).unwrap_err(),
                "protected_mail_source_mismatch"
            );
        }
        m.folder = "Sent".into();
        m.direction = ProtectedMailDirection::Sent;
        assert!(validate_configured_source("INBOX", Some("Sent"), &m).is_ok());
        assert_eq!(
            validate_configured_source("INBOX", None, &m).unwrap_err(),
            "protected_mail_source_mismatch"
        );
        m.folder = "INBOX".into();
        assert_eq!(
            validate_configured_source("INBOX", Some("Sent"), &m).unwrap_err(),
            "protected_mail_source_mismatch"
        );
    }

    #[test]
    fn digest_binds_every_message_field_and_field_boundaries() {
        let m = message();
        let digest = message_digest(&m);
        assert_eq!(digest.len(), 64);
        assert_eq!(digest, message_digest(&m.clone()));
        let mutations: Vec<Box<dyn Fn(&mut ProtectedMailInput)>> = vec![
            Box::new(|v| v.folder.push('x')),
            Box::new(|v| v.uid_validity.push('1')),
            Box::new(|v| v.uid += 1),
            Box::new(|v| v.direction = ProtectedMailDirection::Sent),
            Box::new(|v| v.message_date.push('x')),
            Box::new(|v| v.from.push('x')),
            Box::new(|v| v.to.push('x')),
            Box::new(|v| v.cc.push('x')),
            Box::new(|v| v.subject.push('x')),
            Box::new(|v| v.body.push('x')),
            Box::new(|v| v.note.push('x')),
            Box::new(|v| v.sanitization_version.push('x')),
        ];
        for mutate in mutations {
            let mut changed = m.clone();
            mutate(&mut changed);
            assert_ne!(digest, message_digest(&changed));
        }
        let mut first = m.clone();
        first.from = "a".into();
        first.to = "bc".into();
        let mut second = m;
        second.from = "ab".into();
        second.to = "c".into();
        assert_ne!(message_digest(&first), message_digest(&second));
        assert_ne!(record_id(1, "a"), record_id(11, "a"));
    }

    #[test]
    fn canonical_message_identity_is_bound_to_connection_folder_and_uid_epoch() {
        let m = message();
        let event = mailbox_event_id(1, &m);
        assert_ne!(event, mailbox_event_id(2, &m));
        for change in [0, 1, 2] {
            let mut other = m.clone();
            match change {
                0 => other.folder = "Sent".into(),
                1 => other.uid_validity = "8".into(),
                _ => other.uid = 2,
            }
            assert_ne!(event, mailbox_event_id(1, &other));
        }
        let mut same_event = m;
        same_event.body.push_str("changed content");
        assert_eq!(event, mailbox_event_id(1, &same_event));
    }

    #[test]
    fn joined_view_associations_fail_closed_for_owner_source_or_content_mismatch() {
        let fixture = || {
            let owner = Identity::from_byte_array([1; 32]);
            let created_at = Timestamp::from_micros_since_unix_epoch(1);
            let message = message();
            let event_key = "a".repeat(64);
            let id = record_id(1, &event_key);
            let source_id = source_id(&id);
            let digest = message_digest(&message);
            let mailbox_event_id = mailbox_event_id(1, &message);
            (
                ProtectedMailCollection {
                    id: 1,
                    owner,
                    created_at,
                },
                ProtectedMailSource {
                    id: source_id.clone(),
                    owner,
                    collection_id: 1,
                    revision: SOURCE_REVISION,
                    digest: digest.clone(),
                    origin: ORIGIN.into(),
                    sanitization_version: message.sanitization_version.clone(),
                    created_at,
                },
                ProtectedMailRecord {
                    id: id.clone(),
                    owner,
                    collection_id: 1,
                    source_id: source_id.clone(),
                    source_revision: SOURCE_REVISION,
                    message,
                    imported_at: created_at,
                },
                ProtectedMailReceipt {
                    id: id.clone(),
                    owner,
                    collection_id: 1,
                    event_key,
                    mailbox_event_id,
                    record_id: id,
                    source_id,
                    digest,
                },
            )
        };
        let (c, s, r, p) = fixture();
        assert!(associated(&c, &s, &r, &p));
        for mutation in 0..8 {
            let (c, mut s, mut r, mut p) = fixture();
            match mutation {
                0 => r.owner = Identity::from_byte_array([2; 32]),
                1 => s.origin = "derived".into(),
                2 => s.revision = 2,
                3 => s.sanitization_version = "unknown-v2".into(),
                4 => p.source_id.push('x'),
                5 => p.mailbox_event_id.push('x'),
                6 => r.message.body.push('x'),
                _ => p.digest.push('x'),
            }
            assert!(!associated(&c, &s, &r, &p));
        }
    }
}
