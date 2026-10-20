//! Staged retained connection epochs. A matching epoch or snapshot digest is
//! not a grant, admission, owner-eligibility check, or execution authority.
//! Enrollment is explicit; legacy/un-enrolled mutations remain unchanged.

use sha2::{Digest, Sha256};
use spacetimedb::{reducer, table, Identity, ReducerContext, Table, Timestamp};

use super::accounts::{
    mail_connection, mail_connection_secret, mail_encryption_key, validate_credential,
    MailConnection, MailEncryptionKey,
};
use super::protected::{protected_mail_collection, ProtectedMailCollection};
use crate::ai::{ai_user_config, ai_user_profile};
use crate::auth::user;
use crate::module_install::sender_is_module_publisher;

const INCONSISTENT: &str = "protected_mail_connection_authority_inconsistent";
const BINDING: &str = "protected_mail_connection_authority_binding_mismatch";
const TERMINAL: &str = "protected_mail_connection_authority_tombstoned";
const INITIALIZED: &str = "initialized";
const PAUSED: &str = "paused";
const CREDENTIAL_CHANGED: &str = "credential_changed";
const KEY_CHANGED: &str = "encryption_key_changed";
const DELETED: &str = "deleted";

#[table(accessor = protected_mail_connection_authority_head, private)]
pub struct ProtectedMailConnectionAuthorityHead {
    #[primary_key]
    pub connection_id: u64,
    pub collection_id: u64,
    pub owner: Identity,
    pub epoch: u64,
    pub snapshot_digest: String,
    pub tombstoned: bool,
    pub initialized_at: Timestamp,
    pub updated_at: Timestamp,
}

#[table(accessor = protected_mail_connection_authority_history, private)]
pub struct ProtectedMailConnectionAuthorityHistory {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub connection_id: u64,
    pub collection_id: u64,
    pub owner: Identity,
    pub epoch: u64,
    /// Private commitment to configuration/ciphertext/key bytes, not raw data
    /// or anonymization. No label, username, endpoint or credential is copied.
    pub snapshot_digest: String,
    pub tombstoned: bool,
    pub reason: String,
    pub actor: Identity,
    pub created_at: Timestamp,
}

fn hash_fields(domain: &str, fields: &[String]) -> String {
    let mut hash = Sha256::new();
    for field in std::iter::once(domain).chain(fields.iter().map(String::as_str)) {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    hex::encode(hash.finalize())
}

fn history_id(connection_id: u64, collection_id: u64, owner: Identity, epoch: u64) -> String {
    format!(
        "mail-connection-authority-history:{}",
        hash_fields(
            "pear-protected-mail-connection-authority-history-v1",
            &[
                connection_id.to_string(),
                collection_id.to_string(),
                owner.to_hex().to_string(),
                epoch.to_string()
            ],
        )
    )
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Exact versioned representation of protected connector configuration.
/// Deliberately excludes legacy label/page/AI selection, status, lease and sync
/// counters. Future mutations of any included field must advance this epoch.
fn snapshot_digest(
    connection: &MailConnection,
    collection: &ProtectedMailCollection,
    encrypted_password: &str,
    key: &MailEncryptionKey,
    enabled: bool,
) -> String {
    let mut fields = vec![
        connection.id.to_string(),
        collection.id.to_string(),
        connection.owner.to_hex().to_string(),
        collection.owner.to_hex().to_string(),
        connection.host.clone(),
        connection.port.to_string(),
        connection.username.clone(),
        connection.inbox_folder.clone(),
        if connection.sent_folder.is_some() {
            "some"
        } else {
            "none"
        }
        .into(),
    ];
    if let Some(sent) = &connection.sent_folder {
        fields.push(sent.clone());
    }
    fields.extend([
        connection.backfill.to_string(),
        enabled.to_string(),
        encrypted_password.into(),
        key.id.to_string(),
        key.key_id.clone(),
        key.public_key_jwk.clone(),
    ]);
    hash_fields("pear-protected-mail-connection-snapshot-v1", &fields)
}

fn history_matches(
    history: &ProtectedMailConnectionAuthorityHistory,
    head: &ProtectedMailConnectionAuthorityHead,
) -> bool {
    history.id
        == history_id(
            head.connection_id,
            head.collection_id,
            head.owner,
            history.epoch,
        )
        && history.connection_id == head.connection_id
        && history.collection_id == head.collection_id
        && history.owner == head.owner
        && history.epoch > 0
        && valid_digest(&history.snapshot_digest)
        && match history.reason.as_str() {
            INITIALIZED => history.epoch == 1 && !history.tombstoned,
            PAUSED | CREDENTIAL_CHANGED => {
                history.epoch > 1 && !history.tombstoned && history.actor == head.owner
            }
            KEY_CHANGED => history.epoch > 1 && !history.tombstoned,
            DELETED => history.epoch > 1 && history.tombstoned && history.actor == head.owner,
            _ => false,
        }
}

fn retained_matches(
    head: &ProtectedMailConnectionAuthorityHead,
    collection: &ProtectedMailCollection,
    current: &ProtectedMailConnectionAuthorityHistory,
    initial: &ProtectedMailConnectionAuthorityHistory,
) -> bool {
    head.connection_id == collection.id
        && head.collection_id == collection.id
        && head.owner == collection.owner
        && head.epoch > 0
        && history_matches(current, head)
        && history_matches(initial, head)
        && initial.epoch == 1
        && initial.reason == INITIALIZED
        && initial.created_at == head.initialized_at
        && current.epoch == head.epoch
        && current.snapshot_digest == head.snapshot_digest
        && current.tombstoned == head.tombstoned
        && current.created_at == head.updated_at
}

fn checked_retained(
    ctx: &ReducerContext,
    head: &ProtectedMailConnectionAuthorityHead,
) -> Result<ProtectedMailCollection, String> {
    let collection = ctx
        .db
        .protected_mail_collection()
        .id()
        .find(head.collection_id)
        .ok_or(INCONSISTENT)?;
    let current = ctx
        .db
        .protected_mail_connection_authority_history()
        .id()
        .find(history_id(
            head.connection_id,
            head.collection_id,
            head.owner,
            head.epoch,
        ))
        .ok_or(INCONSISTENT)?;
    let initial = ctx
        .db
        .protected_mail_connection_authority_history()
        .id()
        .find(history_id(
            head.connection_id,
            head.collection_id,
            head.owner,
            1,
        ))
        .ok_or(INCONSISTENT)?;
    if !retained_matches(head, &collection, &current, &initial) {
        return Err(INCONSISTENT.into());
    }
    Ok(collection)
}

fn credential_snapshot(
    ctx: &ReducerContext,
    connection: &MailConnection,
) -> Result<(String, MailEncryptionKey), String> {
    let secret = ctx
        .db
        .mail_connection_secret()
        .connection_id()
        .find(connection.id)
        .ok_or("protected_mail_connection_authority_credential_required")?;
    validate_credential(ctx, &secret.encrypted_password)
        .map_err(|_| "protected_mail_connection_authority_credential_required".to_string())?;
    let key = ctx
        .db
        .mail_encryption_key()
        .id()
        .find(0)
        .ok_or("protected_mail_connection_authority_credential_required")?;
    Ok((secret.encrypted_password, key))
}

fn next_epoch(epoch: u64, tombstoned: bool) -> Result<u64, String> {
    if tombstoned {
        return Err(TERMINAL.into());
    }
    epoch
        .checked_add(1)
        .ok_or_else(|| "protected_mail_connection_authority_epoch_exhausted".into())
}

fn write_transition(
    ctx: &ReducerContext,
    head: ProtectedMailConnectionAuthorityHead,
    digest: String,
    tombstoned: bool,
    reason: &str,
) -> Result<(), String> {
    let epoch = next_epoch(head.epoch, head.tombstoned)?;
    let id = history_id(head.connection_id, head.collection_id, head.owner, epoch);
    if ctx
        .db
        .protected_mail_connection_authority_history()
        .id()
        .find(id.clone())
        .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    ctx.db.protected_mail_connection_authority_history().insert(
        ProtectedMailConnectionAuthorityHistory {
            id,
            connection_id: head.connection_id,
            collection_id: head.collection_id,
            owner: head.owner,
            epoch,
            snapshot_digest: digest.clone(),
            tombstoned,
            reason: reason.into(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        },
    );
    ctx.db
        .protected_mail_connection_authority_head()
        .connection_id()
        .update(ProtectedMailConnectionAuthorityHead {
            epoch,
            snapshot_digest: digest,
            tombstoned,
            updated_at: ctx.timestamp,
            ..head
        });
    Ok(())
}

/// Verify old enrollment and its exact pre-mutation configuration. Eligibility
/// (including current owner authentication) must still be rechecked by a future
/// admission; a safety mutation must remain possible after owner logout.
fn checked_live(
    ctx: &ReducerContext,
    head: &ProtectedMailConnectionAuthorityHead,
    connection: &MailConnection,
) -> Result<(ProtectedMailCollection, String, MailEncryptionKey), String> {
    let collection = checked_retained(ctx, head)?;
    if head.tombstoned {
        return Err(TERMINAL.into());
    }
    if connection.id != head.connection_id || connection.owner != head.owner {
        return Err(BINDING.into());
    }
    let (credential, key) = credential_snapshot(ctx, connection)?;
    if snapshot_digest(
        connection,
        &collection,
        &credential,
        &key,
        connection.enabled,
    ) != head.snapshot_digest
    {
        return Err("protected_mail_connection_authority_snapshot_mismatch".into());
    }
    Ok((collection, credential, key))
}

/// Internal authority projection. Credentials are validated transiently and
/// never returned to an admission, receipt, service or ordinary read surface.
pub(super) fn checked_current_authority(
    ctx: &ReducerContext,
    connection_id: u64,
) -> Result<ProtectedMailConnectionAuthorityHead, String> {
    let head = ctx.db.protected_mail_connection_authority_head().connection_id()
        .find(connection_id).ok_or("protected_mail_connection_authority_required")?;
    let connection = ctx.db.mail_connection().id().find(connection_id)
        .ok_or("protected_mail_connection_authority_connection_required")?;
    checked_live(ctx, &head, &connection)?;
    if connection.enabled {
        return Err("protected_mail_connection_authority_connection_not_paused".into());
    }
    Ok(head)
}

#[reducer]
pub fn initialize_protected_mail_connection_authority(
    ctx: &ReducerContext,
    connection_id: u64,
) -> Result<(), String> {
    if !sender_is_module_publisher(ctx) {
        return Err("protected_mail_publisher_required".into());
    }
    if let Some(head) = ctx
        .db
        .protected_mail_connection_authority_head()
        .connection_id()
        .find(connection_id)
    {
        checked_retained(ctx, &head)?;
        // No live lookup or repair: a retry cannot reset a later epoch, revive a
        // tombstone, or turn this bookkeeping into a current eligibility check.
        return Ok(());
    }
    let collection = ctx
        .db
        .protected_mail_collection()
        .id()
        .find(connection_id)
        .ok_or("protected_mail_collection_required")?;
    let connection = ctx
        .db
        .mail_connection()
        .id()
        .find(connection_id)
        .ok_or("protected_mail_connection_authority_connection_required")?;
    if connection.owner != collection.owner {
        return Err(BINDING.into());
    }
    if connection.enabled {
        return Err("protected_mail_connection_authority_connection_not_paused".into());
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
        return Err("protected_mail_connection_authority_owner_unavailable".into());
    }
    let (credential, key) = credential_snapshot(ctx, &connection)?;
    let digest = snapshot_digest(
        &connection,
        &collection,
        &credential,
        &key,
        connection.enabled,
    );
    let id = history_id(connection_id, collection.id, collection.owner, 1);
    if ctx
        .db
        .protected_mail_connection_authority_history()
        .id()
        .find(id.clone())
        .is_some()
    {
        return Err(INCONSISTENT.into());
    }
    ctx.db.protected_mail_connection_authority_history().insert(
        ProtectedMailConnectionAuthorityHistory {
            id,
            connection_id,
            collection_id: collection.id,
            owner: collection.owner,
            epoch: 1,
            snapshot_digest: digest.clone(),
            tombstoned: false,
            reason: INITIALIZED.into(),
            actor: ctx.sender(),
            created_at: ctx.timestamp,
        },
    );
    ctx.db.protected_mail_connection_authority_head().insert(
        ProtectedMailConnectionAuthorityHead {
            connection_id,
            collection_id: collection.id,
            owner: collection.owner,
            epoch: 1,
            snapshot_digest: digest,
            tombstoned: false,
            initialized_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        },
    );
    Ok(())
}

pub(super) fn advance_for_pause(
    ctx: &ReducerContext,
    connection: &MailConnection,
) -> Result<(), String> {
    let Some(head) = ctx
        .db
        .protected_mail_connection_authority_head()
        .connection_id()
        .find(connection.id)
    else {
        return Ok(());
    };
    let (collection, credential, key) = checked_live(ctx, &head, connection)?;
    let digest = snapshot_digest(connection, &collection, &credential, &key, false);
    write_transition(ctx, head, digest, false, PAUSED)
}

pub(super) fn advance_for_credential_change(
    ctx: &ReducerContext,
    connection: &MailConnection,
    encrypted_password: &str,
) -> Result<(), String> {
    let Some(head) = ctx
        .db
        .protected_mail_connection_authority_head()
        .connection_id()
        .find(connection.id)
    else {
        return Ok(());
    };
    let (collection, _, key) = checked_live(ctx, &head, connection)?;
    let digest = snapshot_digest(
        connection,
        &collection,
        encrypted_password,
        &key,
        connection.enabled,
    );
    write_transition(ctx, head, digest, false, CREDENTIAL_CHANGED)
}

pub(super) fn tombstone_for_deletion(
    ctx: &ReducerContext,
    connection: &MailConnection,
) -> Result<(), String> {
    let Some(head) = ctx
        .db
        .protected_mail_connection_authority_head()
        .connection_id()
        .find(connection.id)
    else {
        return Ok(());
    };
    let (collection, credential, key) = checked_live(ctx, &head, connection)?;
    let digest = snapshot_digest(
        connection,
        &collection,
        &credential,
        &key,
        connection.enabled,
    );
    write_transition(ctx, head, digest, true, DELETED)
}

fn descriptor_changed(previous: Option<&MailEncryptionKey>, next: &MailEncryptionKey) -> bool {
    previous.is_none_or(|previous| {
        previous.id != next.id
            || previous.key_id != next.key_id
            || previous.public_key_jwk != next.public_key_jwk
    })
}

pub(super) fn advance_for_key_descriptor_change(
    ctx: &ReducerContext,
    next: &MailEncryptionKey,
) -> Result<(), String> {
    let previous = ctx.db.mail_encryption_key().id().find(0);
    if !descriptor_changed(previous.as_ref(), next) {
        return Ok(());
    }
    // Scan only private enrollments, never auto-enroll ordinary connections.
    // Terminal rows retain their final history and cannot dispatch again.
    let heads: Vec<_> = ctx
        .db
        .protected_mail_connection_authority_head()
        .iter()
        .collect();
    for head in heads {
        if head.tombstoned {
            continue;
        }
        let connection = ctx
            .db
            .mail_connection()
            .id()
            .find(head.connection_id)
            .ok_or(INCONSISTENT)?;
        let (collection, credential, _) = checked_live(ctx, &head, &connection)?;
        let digest = snapshot_digest(
            &connection,
            &collection,
            &credential,
            next,
            connection.enabled,
        );
        write_transition(ctx, head, digest, false, KEY_CHANGED)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> Identity {
        Identity::from_byte_array([1; 32])
    }
    fn time(epoch: u64) -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(epoch as i64)
    }
    fn collection() -> ProtectedMailCollection {
        ProtectedMailCollection {
            id: 7,
            owner: owner(),
            created_at: time(1),
        }
    }
    fn connection() -> MailConnection {
        MailConnection {
            id: 7,
            owner: owner(),
            label: "Private fixture label".into(),
            host: "imap.example.test".into(),
            port: 993,
            username: "fixture@example.test".into(),
            inbox_folder: "INBOX".into(),
            sent_folder: Some("Sent".into()),
            ai_user_id: None,
            root_page_id: 100,
            backfill: 0,
            enabled: false,
            status: "Paused".into(),
            last_sync_at: None,
            imported_count: 0,
            lease: String::new(),
            lease_until: None,
        }
    }
    fn key() -> MailEncryptionKey {
        MailEncryptionKey {
            id: 0,
            public_key_jwk: "{\"kty\":\"fixture\"}".into(),
            key_id: "a".repeat(64),
        }
    }
    fn fixture(
        epoch: u64,
        reason: &str,
        tombstoned: bool,
        digest: &str,
    ) -> (
        ProtectedMailConnectionAuthorityHead,
        ProtectedMailConnectionAuthorityHistory,
    ) {
        let head = ProtectedMailConnectionAuthorityHead {
            connection_id: 7,
            collection_id: 7,
            owner: owner(),
            epoch,
            snapshot_digest: digest.into(),
            tombstoned,
            initialized_at: time(1),
            updated_at: time(epoch),
        };
        let history = ProtectedMailConnectionAuthorityHistory {
            id: history_id(7, 7, owner(), epoch),
            connection_id: 7,
            collection_id: 7,
            owner: owner(),
            epoch,
            snapshot_digest: digest.into(),
            tombstoned,
            reason: reason.into(),
            actor: if reason == INITIALIZED || reason == KEY_CHANGED {
                Identity::from_byte_array([9; 32])
            } else {
                owner()
            },
            created_at: time(epoch),
        };
        (head, history)
    }

    #[test]
    fn snapshot_binds_every_live_connector_credential_and_key_field() {
        let credential = "synthetic-credential-A";
        let base = snapshot_digest(&connection(), &collection(), credential, &key(), false);
        for field in 0..10 {
            let mut changed = connection();
            match field {
                0 => changed.id += 1,
                1 => changed.owner = Identity::from_byte_array([2; 32]),
                2 => changed.host.push('x'),
                3 => changed.port += 1,
                4 => changed.username.push('x'),
                5 => changed.inbox_folder.push('x'),
                6 => changed.sent_folder = None,
                7 => changed.sent_folder = Some("Other".into()),
                8 => changed.backfill += 1,
                _ => changed.enabled = true,
            }
            assert_ne!(
                base,
                snapshot_digest(&changed, &collection(), credential, &key(), changed.enabled)
            );
        }
        let mut changed_collection = collection();
        changed_collection.id += 1;
        assert_ne!(
            base,
            snapshot_digest(
                &connection(),
                &changed_collection,
                credential,
                &key(),
                false
            )
        );
        changed_collection = collection();
        changed_collection.owner = Identity::from_byte_array([2; 32]);
        assert_ne!(
            base,
            snapshot_digest(
                &connection(),
                &changed_collection,
                credential,
                &key(),
                false
            )
        );
        assert_ne!(
            base,
            snapshot_digest(
                &connection(),
                &collection(),
                "synthetic-credential-B",
                &key(),
                false
            )
        );
        for field in 0..3 {
            let mut changed = key();
            match field {
                0 => changed.id += 1,
                1 => changed.key_id = "b".repeat(64),
                _ => changed.public_key_jwk.push(' '),
            }
            assert_ne!(
                base,
                snapshot_digest(&connection(), &collection(), credential, &changed, false)
            );
        }
    }

    #[test]
    fn legacy_labels_pages_assistants_and_runtime_counters_are_not_authority_config() {
        let before = connection();
        let digest = snapshot_digest(&before, &collection(), "ciphertext", &key(), false);
        let after = MailConnection {
            label: "Another label".into(),
            root_page_id: 200,
            ai_user_id: Some(88),
            status: "Waiting".into(),
            last_sync_at: Some(time(9)),
            imported_count: 123,
            lease: "new-lease".into(),
            lease_until: Some(time(10)),
            ..before
        };
        assert_eq!(
            digest,
            snapshot_digest(&after, &collection(), "ciphertext", &key(), false)
        );
    }

    #[test]
    fn snapshot_encoding_preserves_exact_bytes_option_presence_and_boundaries() {
        let base = snapshot_digest(&connection(), &collection(), "ab", &key(), false);
        let mut changed = connection();
        changed.username.push(' ');
        assert_ne!(
            base,
            snapshot_digest(&changed, &collection(), "ab", &key(), false)
        );
        changed = connection();
        changed.sent_folder = None;
        let absent = snapshot_digest(&changed, &collection(), "ab", &key(), false);
        changed.sent_folder = Some(String::new());
        assert_ne!(
            absent,
            snapshot_digest(&changed, &collection(), "ab", &key(), false)
        );
        let mut key_a = key();
        key_a.public_key_jwk = "c".into();
        let mut key_b = key();
        key_b.public_key_jwk = "bc".into();
        assert_ne!(
            snapshot_digest(&connection(), &collection(), "ab", &key_a, false),
            snapshot_digest(&connection(), &collection(), "a", &key_b, false)
        );
    }

    #[test]
    fn equal_snapshot_does_not_make_pause_identical_password_or_aba_reusable() {
        let a = snapshot_digest(&connection(), &collection(), "A", &key(), false);
        let b = snapshot_digest(&connection(), &collection(), "B", &key(), false);
        assert_ne!(a, b);
        assert_eq!(
            a,
            snapshot_digest(&connection(), &collection(), "A", &key(), false)
        );
        let first = next_epoch(1, false).unwrap();
        let second = next_epoch(first, false).unwrap();
        let third = next_epoch(second, false).unwrap();
        assert_eq!((first, second, third), (2, 3, 4));
        assert_ne!(
            history_id(7, 7, owner(), 1),
            history_id(7, 7, owner(), third)
        );
        assert_ne!(
            history_id(7, 7, owner(), first),
            history_id(7, 7, owner(), second)
        );
    }

    #[test]
    fn descriptor_changes_compare_exact_bytes_and_catch_same_id_edit_revert() {
        let a = key();
        let mut b = key();
        b.public_key_jwk.push(' ');
        assert!(!descriptor_changed(Some(&a), &key()));
        assert!(descriptor_changed(Some(&a), &b));
        assert!(descriptor_changed(Some(&b), &a));
        assert!(descriptor_changed(None, &a));
        let mut other_id = key();
        other_id.key_id = "b".repeat(64);
        assert!(descriptor_changed(Some(&a), &other_id));
    }

    #[test]
    fn retained_history_and_terminal_rows_validate_without_live_credentials() {
        let (_, initial) = fixture(1, INITIALIZED, false, &"a".repeat(64));
        let (head, current) = fixture(4, DELETED, true, &"b".repeat(64));
        assert!(retained_matches(&head, &collection(), &current, &initial));
        assert_eq!(
            next_epoch(head.epoch, head.tombstoned).unwrap_err(),
            TERMINAL
        );
        assert_eq!(
            next_epoch(u64::MAX, false).unwrap_err(),
            "protected_mail_connection_authority_epoch_exhausted"
        );
    }

    #[test]
    fn retained_associations_fail_closed_on_identity_epoch_snapshot_reason_or_tombstone_mismatch() {
        let (_, initial) = fixture(1, INITIALIZED, false, &"a".repeat(64));
        for field in 0..9 {
            let (head, mut current) = fixture(2, PAUSED, false, &"b".repeat(64));
            match field {
                0 => current.owner = Identity::from_byte_array([2; 32]),
                1 => current.collection_id += 1,
                2 => current.connection_id += 1,
                3 => current.epoch += 1,
                4 => current.snapshot_digest = "c".repeat(64),
                5 => current.tombstoned = true,
                6 => current.reason = "untrusted-error-text".into(),
                7 => current.actor = Identity::from_byte_array([2; 32]),
                _ => current.created_at = time(8),
            }
            assert!(!retained_matches(&head, &collection(), &current, &initial));
        }
    }

    #[test]
    fn history_identity_is_domain_separated_and_scope_epoch_bound() {
        let id = history_id(7, 7, owner(), 1);
        assert_ne!(id, history_id(8, 7, owner(), 1));
        assert_ne!(id, history_id(7, 8, owner(), 1));
        assert_ne!(id, history_id(7, 7, Identity::from_byte_array([2; 32]), 1));
        assert_ne!(id, history_id(7, 7, owner(), 2));
        assert!(id.starts_with("mail-connection-authority-history:"));
        assert_eq!(id.len(), "mail-connection-authority-history:".len() + 64);
    }
}
