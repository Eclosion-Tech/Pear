use spacetimedb::{client_visibility_filter, reducer, table, Filter, Identity, ReducerContext, Table, Timestamp};
use crate::access_control::{next_page_access_rule_id, page_access_rule, PageAccessRule};
use crate::access_control::helpers::{can_write_page, require_workspace_principal};
use crate::ai::ai_user_config;
use crate::auth::{sender_is_admin, user};
use crate::module_install::sender_is_module_publisher;
use crate::pages::{create_component_tree_page_inner, PageType};
use crate::types::{ActorType, Permission, Principal};

#[client_visibility_filter]
const MAIL_CONNECTION_FILTER: Filter = Filter::Sql("SELECT * FROM mail_connection WHERE owner = :sender");

#[table(accessor = mail_connection, public)]
pub struct MailConnection {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub owner: Identity,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub inbox_folder: String,
    pub sent_folder: Option<String>,
    pub ai_user_id: Option<u64>,
    pub root_page_id: u64,
    pub backfill: u32,
    pub enabled: bool,
    pub status: String,
    pub last_sync_at: Option<Timestamp>,
    pub imported_count: u64,
    pub lease: String,
    pub lease_until: Option<Timestamp>,
}

#[table(accessor = mail_encryption_key, public)]
pub struct MailEncryptionKey {
    #[primary_key]
    pub id: u8,
    pub public_key_jwk: String,
    pub key_id: String,
}

#[reducer]
pub fn publish_mail_encryption_key(ctx: &ReducerContext, public_key_jwk: String, key_id: String) -> Result<(), String> {
    if !sender_is_module_publisher(ctx) { return Err("Only the workspace worker may publish its mail key".into()); }
    if public_key_jwk.len() > 4096 || key_id.len() != 64 { return Err("Invalid mail encryption key".into()); }
    if ctx.db.mail_encryption_key().id().find(0).is_some_and(|k| k.key_id != key_id) &&
        ctx.db.mail_connection().iter().next().is_some() {
        return Err("Disconnect mailboxes before changing the mail encryption key".into());
    }
    let next = MailEncryptionKey { id: 0, public_key_jwk, key_id };
    super::authority::advance_for_key_descriptor_change(ctx, &next)?;
    if ctx.db.mail_encryption_key().id().find(0).is_some() { ctx.db.mail_encryption_key().id().update(next); }
    else { ctx.db.mail_encryption_key().insert(next); }
    Ok(())
}

pub(super) fn validate_credential(ctx: &ReducerContext, encrypted: &str) -> Result<(), String> {
    if encrypted.len() > 16384 { return Err("Mail credential is too large".into()); }
    let value: serde_json::Value = serde_json::from_str(encrypted).map_err(|_| "Invalid encrypted mail credential")?;
    let key = ctx.db.mail_encryption_key().id().find(0).ok_or("Mail monitoring is not enabled on this host")?;
    if value["v"] != 1 || value["keyId"].as_str() != Some(key.key_id.as_str()) ||
        ["key", "nonce", "ciphertext"].iter().any(|field| value[field].as_str().is_none_or(|s| s.is_empty())) {
        return Err("Invalid encrypted mail credential or changed worker key".into());
    }
    Ok(())
}

// Private tables hold ciphertext only. The decryption key lives in the worker
// secret store, never in reducers, transaction arguments, or workspace exports.
#[table(accessor = mail_connection_secret)]
pub struct MailConnectionSecret {
    #[primary_key]
    pub connection_id: u64,
    pub encrypted_password: String,
}

#[table(accessor = mail_sync_cursor)]
pub struct MailSyncCursor {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub connection_id: u64,
    pub folder: String,
    pub uid_validity: String,
    pub last_uid: u32,
}

fn owned(ctx: &ReducerContext, id: u64) -> Result<MailConnection, String> {
    let connection = ctx.db.mail_connection().id().find(id).ok_or("Mail connection not found")?;
    if connection.owner != ctx.sender() { return Err("Only the mailbox owner can change this connection".into()); }
    Ok(connection)
}

pub(super) fn leased(ctx: &ReducerContext, id: u64, lease: &str) -> Result<MailConnection, String> {
    if !sender_is_module_publisher(ctx) { return Err("Only the workspace worker can sync mail".into()); }
    super::protected::require_legacy_connection(ctx, id)?;
    let connection = ctx.db.mail_connection().id().find(id).ok_or("Mail connection not found")?;
    if !connection.enabled || connection.lease != lease ||
        connection.lease_until.is_none_or(|until| until <= ctx.timestamp) {
        return Err("Mail sync lease expired or connection paused".into());
    }
    if !can_write_page(ctx, connection.root_page_id, connection.owner) {
        return Err("Mailbox owner no longer has access to the destination".into());
    }
    if let Some(id) = connection.ai_user_id {
        let ai = ctx.db.ai_user_config().id().find(id).ok_or("Mail assistant no longer exists")?;
        if !can_write_page(ctx, connection.root_page_id, ai.identity) {
            return Err("Mail assistant no longer has access to the destination".into());
        }
    }
    Ok(connection)
}

#[reducer]
#[allow(clippy::too_many_arguments)]
pub fn create_mail_connection(
    ctx: &ReducerContext, label: String, host: String, port: u16, username: String,
    encrypted_password: String, inbox_folder: String, sent_folder: Option<String>, ai_user_id: Option<u64>, backfill: u32,
) -> Result<(), String> {
    require_workspace_principal(ctx)?;
    if !ctx.db.user().identity().find(ctx.sender()).is_some_and(|u| u.is_authenticated) {
        return Err("Sign in as a person to connect a mailbox".into());
    }
    if label.trim().is_empty() || label.len() > 100 || host.is_empty() || host.len() > 253 ||
        host.contains(|c: char| c.is_whitespace() || "/@?#".contains(c)) || port == 0 ||
        username.trim().is_empty() || username.len() > 320 ||
        inbox_folder.is_empty() || inbox_folder.len() > 512 ||
        sent_folder.as_ref().is_some_and(|f| f.is_empty() || f.len() > 512 || f == &inbox_folder) || backfill > 1000 {
        return Err("Check the mailbox name, server, credentials, folders, and history limit".into());
    }
    validate_credential(ctx, &encrypted_password)?;
    if ctx.db.mail_connection().iter().filter(|c| c.owner == ctx.sender()).count() >= 20 {
        return Err("At most 20 mail connections per person per workspace".into());
    }
    let ai_identity = if let Some(id) = ai_user_id {
        let ai = ctx.db.ai_user_config().id().find(id).ok_or("AI user not found")?;
        if ai.created_by != ctx.sender() && !sender_is_admin(ctx) {
            return Err("Choose an AI user you manage".into());
        }
        Some(ai.identity)
    } else { None };
    let root_page_id = create_component_tree_page_inner(ctx, None, PageType::Doc,
        format!("{} — mail", label.trim()), ActorType::Human)?;
    for identity in std::iter::once(ctx.sender()).chain(ai_identity) {
        ctx.db.page_access_rule().insert(PageAccessRule {
            id: next_page_access_rule_id(ctx), page_id: root_page_id,
            principal: Principal::WorkspaceMember(identity), permission: Permission::Write,
            granted_by: ctx.sender(), granted_at: ctx.timestamp,
        });
    }
    let connection = ctx.db.mail_connection().insert(MailConnection {
        id: 0, owner: ctx.sender(), label: label.trim().into(), host: host.to_lowercase(), port,
        username, inbox_folder, sent_folder, ai_user_id, root_page_id, backfill,
        enabled: true, status: "Waiting for worker".into(), last_sync_at: None, imported_count: 0,
        lease: String::new(), lease_until: None,
    });
    ctx.db.mail_connection_secret().insert(MailConnectionSecret { connection_id: connection.id, encrypted_password });
    Ok(())
}

#[reducer]
pub fn set_mail_connection_enabled(ctx: &ReducerContext, connection_id: u64, enabled: bool) -> Result<(), String> {
    let connection = owned(ctx, connection_id)?;
    if enabled { super::protected::require_legacy_connection(ctx, connection_id)?; }
    else { super::authority::advance_for_pause(ctx, &connection)?; }
    ctx.db.mail_connection().id().update(MailConnection {
        enabled, lease: String::new(), lease_until: None,
        status: if enabled { "Waiting for worker" } else { "Paused" }.into(), ..connection
    });
    Ok(())
}

#[reducer]
pub fn update_mail_connection_password(ctx: &ReducerContext, connection_id: u64, encrypted_password: String) -> Result<(), String> {
    let connection = owned(ctx, connection_id)?;
    validate_credential(ctx, &encrypted_password)?;
    super::authority::advance_for_credential_change(ctx, &connection, &encrypted_password)?;
    ctx.db.mail_connection_secret().connection_id().update(MailConnectionSecret { connection_id, encrypted_password });
    ctx.db.mail_connection().id().update(MailConnection {
        lease: String::new(), lease_until: None,
        status: if connection.enabled { "Waiting for worker" } else { "Paused" }.into(), ..connection
    });
    Ok(())
}

#[reducer]
pub fn delete_mail_connection(ctx: &ReducerContext, connection_id: u64) -> Result<(), String> {
    let connection = owned(ctx, connection_id)?;
    super::authority::tombstone_for_deletion(ctx, &connection)?;
    ctx.db.mail_connection_secret().connection_id().delete(connection_id);
    for cursor in ctx.db.mail_sync_cursor().connection_id().filter(connection_id) {
        ctx.db.mail_sync_cursor().id().delete(cursor.id);
    }
    ctx.db.mail_connection().id().delete(connection_id);
    // Imported pages remain user-owned workspace content.
    Ok(())
}

#[reducer]
pub fn claim_mail_sync(ctx: &ReducerContext, connection_id: u64, lease: String) -> Result<(), String> {
    if !sender_is_module_publisher(ctx) { return Err("Only the workspace worker can sync mail".into()); }
    super::protected::require_legacy_connection(ctx, connection_id)?;
    let connection = ctx.db.mail_connection().id().find(connection_id).ok_or("Mail connection not found")?;
    if !connection.enabled || lease.is_empty() || lease.len() > 128 { return Err("Mail connection is paused or invalid lease".into()); }
    if connection.lease != lease && connection.lease_until.is_some_and(|until| until > ctx.timestamp) {
        return Err("Mail connection is already being synced".into());
    }
    ctx.db.mail_connection().id().update(MailConnection {
        lease: lease.clone(), lease_until: Some(ctx.timestamp + std::time::Duration::from_secs(120)),
        status: "Checking mail".into(), ..connection
    });
    leased(ctx, connection_id, &lease)?;
    Ok(())
}

#[reducer]
pub fn renew_mail_sync(ctx: &ReducerContext, connection_id: u64, lease: String) -> Result<(), String> {
    let connection = leased(ctx, connection_id, &lease)?;
    ctx.db.mail_connection().id().update(MailConnection {
        lease_until: Some(ctx.timestamp + std::time::Duration::from_secs(120)), ..connection
    });
    Ok(())
}

#[reducer]
pub fn checkpoint_mail_sync(ctx: &ReducerContext, connection_id: u64, lease: String,
    folder: String, uid_validity: String, last_uid: u32) -> Result<(), String> {
    leased(ctx, connection_id, &lease)?;
    if folder.is_empty() || folder.len() > 512 || uid_validity.parse::<u64>().is_err() {
        return Err("Invalid mail checkpoint".into());
    }
    let id = format!("{connection_id}:{folder}");
    let next = MailSyncCursor { id: id.clone(), connection_id, folder, uid_validity, last_uid };
    if let Some(previous) = ctx.db.mail_sync_cursor().id().find(id) {
        if previous.uid_validity != next.uid_validity || previous.last_uid > last_uid {
            return Err("Mail UID epoch changed or checkpoint moved backwards".into());
        }
        ctx.db.mail_sync_cursor().id().update(next);
    } else { ctx.db.mail_sync_cursor().insert(next); }
    Ok(())
}

#[reducer]
pub fn authorize_mail_triage(ctx: &ReducerContext, connection_id: u64, lease: String) -> Result<(), String> {
    let connection = leased(ctx, connection_id, &lease)?;
    let id = connection.ai_user_id.ok_or("No mail assistant selected")?;
    if crate::orcha::ai_user_at_hard_cap(ctx, id) { return Err("Mail assistant has reached its monthly token cap".into()); }
    Ok(())
}

#[reducer]
pub fn finish_mail_sync(ctx: &ReducerContext, connection_id: u64, lease: String, status: String) -> Result<(), String> {
    let connection = leased(ctx, connection_id, &lease)?;
    const STATUSES: &[&str] = &["Up to date", "Catching up", "Connection failed — check server and app password", "Assistant unavailable — check its model settings", "Mailbox changed — reconnect to rescan recent mail", "Sent folder not found — reconnect with its exact name", "Sync failed — will retry"];
    if !STATUSES.contains(&status.as_str()) { return Err("Unknown mail sync status".into()); }
    let last_sync_at = if status == "Up to date" { Some(ctx.timestamp) } else { connection.last_sync_at };
    ctx.db.mail_connection().id().update(MailConnection {
        status, last_sync_at, lease: String::new(), lease_until: None, ..connection
    });
    Ok(())
}
