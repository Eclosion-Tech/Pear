//! Authentication: User, UserCredential, UserPreference tables and the
//! native register/login/admin reducers. Session hooks
//! (`client_connected`, `client_disconnected`) live in `lib.rs` but call
//! into `extract_oidc_profile` here.

use sha2::{Digest, Sha256};
use spacetimedb::{reducer, table, Identity, ReducerContext, Table, Timestamp};

use crate::id_counters::alloc_id;

pub(crate) fn next_user_preference_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "user_preference", || {
        ctx.db
            .user_preference()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

/// Connected user — upserted on every client_connected event.
/// is_authenticated is set to true only after a successful login/register call.
#[table(accessor = user, public)]
pub struct User {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub email: String,
    pub is_authenticated: bool,
    pub created_at: Timestamp,
    pub last_seen_at: Timestamp,
    /// Workspace admin flag.
    ///
    /// In Pear's trust model an authenticated user can read and edit any
    /// workspace content (Pages have no per-row ownership check). Admins
    /// additionally inherit management rights over shared *infrastructure*
    /// rows that DO have a `created_by` field — `api_endpoint`,
    /// `api_field_mapping`, `api_endpoint_key` — so a co-worker can clean
    /// up an orphaned endpoint after a teammate leaves the workspace, a
    /// stale-tab/wipe accident leaves a row owned by an unreachable
    /// identity, or an OIDC `sub` rotation strands the original creator.
    ///
    /// Bootstrap: the first user to authenticate (native register/login
    /// or OIDC connect) on a fresh database is auto-promoted to admin.
    /// After that, only existing admins can promote or demote others via
    /// `set_user_admin`. The reducer also forbids removing the last admin
    /// so a workspace can never end up with zero admins.
    ///
    /// Extension and AI-user rows deliberately do NOT honor this flag —
    /// they're per-installer / per-creator by design (see
    /// `docs/PEAR_EXTENSIONS_SECURITY.MD`).
    #[default(false)]
    pub is_admin: bool,
}

/// Stores hashed credentials — never synced to clients (private).
#[table(accessor = user_credential, private)]
pub struct UserCredential {
    #[primary_key]
    pub email: String,
    pub name: String,
    /// SHA-256( email + NUL + password + NUL + "pear-auth-v1" ) as lowercase hex.
    pub password_hash: String,
    pub created_at: Timestamp,
}

/// Per-human user preferences. Sparse — only stores the keys the user has
/// explicitly set; defaults live in code. The `key` namespace is dotted
/// (e.g. `mention.thread_behavior`).
#[table(accessor = user_preference, public,
        index(accessor = user_preference_identity_key,
              btree(columns = [identity, key])))]
pub struct UserPreference {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub identity: Identity,
    pub key: String,
    pub value_json: String,
    pub updated_at: Timestamp,
}
// ============================================================
// Auth Reducers
// ============================================================

/// Creates a new account and marks the current identity as authenticated.
/// Returns an error if the email is already registered.
#[reducer]
pub fn register(
    ctx: &ReducerContext,
    email: String,
    name: String,
    password: String,
) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Err("Email is required".to_string());
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name is required".to_string());
    }
    if password.len() < 6 {
        return Err("Password must be at least 6 characters".to_string());
    }
    if ctx.db.user_credential().email().find(&email).is_some() {
        return Err("Email already registered".to_string());
    }

    ctx.db.user_credential().insert(UserCredential {
        email: email.clone(),
        name: name.clone(),
        password_hash: hash_password(&email, &password),
        created_at: ctx.timestamp,
    });

    let identity = ctx.sender();
    let needs_bootstrap_admin = workspace_has_no_admin(ctx);
    if let Some(existing) = ctx.db.user().identity().find(identity) {
        ctx.db.user().identity().update(User {
            email,
            name,
            is_authenticated: true,
            is_admin: existing.is_admin || needs_bootstrap_admin,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
    Ok(())
}

/// Admin-created native-login account for self-hosted/dev workspaces.
///
/// This intentionally creates only a `UserCredential` row. The human's actual
/// `User` row is tied to the SpacetimeDB identity they connect with, so it is
/// created/authenticated when they first log in with this credential.
#[reducer]
pub fn create_local_user(
    ctx: &ReducerContext,
    email: String,
    name: String,
    password: String,
) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("Only workspace admins can add local users".to_string());
    }

    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Err("Email is required".to_string());
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name is required".to_string());
    }
    if password.len() < 6 {
        return Err("Password must be at least 6 characters".to_string());
    }
    if ctx.db.user_credential().email().find(&email).is_some() {
        return Err("Email already registered".to_string());
    }

    ctx.db.user_credential().insert(UserCredential {
        email: email.clone(),
        name,
        password_hash: hash_password(&email, &password),
        created_at: ctx.timestamp,
    });
    Ok(())
}

/// Verifies credentials and marks the current identity as authenticated.
#[reducer]
pub fn login(ctx: &ReducerContext, email: String, password: String) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let cred = ctx
        .db
        .user_credential()
        .email()
        .find(&email)
        .ok_or_else(|| "Invalid email or password".to_string())?;

    if cred.password_hash != hash_password(&email, &password) {
        return Err("Invalid email or password".to_string());
    }

    let identity = ctx.sender();
    let needs_bootstrap_admin = workspace_has_no_admin(ctx);
    if let Some(existing) = ctx.db.user().identity().find(identity) {
        ctx.db.user().identity().update(User {
            email,
            name: cred.name,
            is_authenticated: true,
            is_admin: existing.is_admin || needs_bootstrap_admin,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
    Ok(())
}

/// Promote or demote a workspace user. Only existing admins can call this.
///
/// Refuses to demote the last remaining admin so the workspace can never
/// end up admin-less (which would lock everyone out of orphan-cleanup
/// operations on shared infrastructure rows).
#[reducer]
pub fn set_user_admin(
    ctx: &ReducerContext,
    target_identity: Identity,
    is_admin: bool,
) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("Only workspace admins can change admin status".to_string());
    }

    let target = ctx
        .db
        .user()
        .identity()
        .find(target_identity)
        .ok_or("Target user not found")?;

    if target.is_admin == is_admin {
        return Ok(());
    }

    if !is_admin && target.is_admin {
        let other_admins = ctx
            .db
            .user()
            .iter()
            .filter(|u| u.identity != target_identity && u.is_admin && u.is_authenticated)
            .count();
        if other_admins == 0 {
            return Err("Cannot demote the last admin — promote another user first".to_string());
        }
    }

    ctx.db.user().identity().update(User { is_admin, ..target });
    Ok(())
}

/// Marks the current identity as logged out.
#[reducer]
pub fn logout(ctx: &ReducerContext) {
    let identity = ctx.sender();
    if let Some(existing) = ctx.db.user().identity().find(identity) {
        ctx.db.user().identity().update(User {
            is_authenticated: false,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
}

/// Allows the client to push updated OIDC profile claims after reconnect.
/// No-op when called by an unauthenticated identity.
#[reducer]
pub fn set_user_profile(ctx: &ReducerContext, name: String, email: String) {
    let identity = ctx.sender();
    if let Some(existing) = ctx.db.user().identity().find(identity) {
        if !existing.is_authenticated {
            return;
        }
        ctx.db.user().identity().update(User {
            name,
            email,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
}

/// True iff the calling identity is an authenticated workspace admin.
///
/// Used by ownership-gated reducers that want to grant admins a management
/// override on shared infrastructure rows (currently the `api_endpoint`,
/// `api_field_mapping`, and `api_endpoint_key` family). Anyone querying
/// this MUST also separately enforce that the row is the right *kind* of
/// resource for an admin override — extension and AI-user rows are
/// per-installer / per-creator by design and don't honor this flag.
pub(crate) fn sender_is_admin(ctx: &ReducerContext) -> bool {
    ctx.db
        .user()
        .identity()
        .find(ctx.sender())
        .map(|u| u.is_admin && u.is_authenticated)
        .unwrap_or(false)
}

/// True iff there is currently zero authenticated admin in the workspace.
/// Drives the bootstrap rule: the first user to authenticate on a fresh
/// database is auto-promoted, so a workspace can never be admin-less.
pub(crate) fn workspace_has_no_admin(ctx: &ReducerContext) -> bool {
    !ctx.db
        .user()
        .iter()
        .any(|u| u.is_admin && u.is_authenticated)
}

/// Parses OIDC `email` and `name`/`preferred_username` claims from the sender's JWT.
/// Returns empty strings when no OIDC token is present (anonymous connection).
pub(crate) fn extract_oidc_profile(ctx: &ReducerContext) -> (String, String) {
    let Some(jwt) = ctx.sender_auth().jwt() else {
        return (String::new(), String::new());
    };
    let Ok(claims) = serde_json::from_str::<serde_json::Value>(jwt.raw_payload()) else {
        return (String::new(), String::new());
    };
    let email = claims["email"].as_str().unwrap_or("").to_string();
    let name = claims["name"]
        .as_str()
        .or_else(|| claims["preferred_username"].as_str())
        .unwrap_or("")
        .to_string();
    (email, name)
}
/// SHA-256( email + NUL + password + NUL + "pear-auth-v1" ) as lowercase hex.
/// The email acts as a per-user salt — simple and deterministic, fine for local use.
fn hash_password(email: &str, password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(email.as_bytes());
    hasher.update(b"\x00");
    hasher.update(password.as_bytes());
    hasher.update(b"\x00");
    hasher.update(b"pear-auth-v1");
    hex::encode(hasher.finalize())
}
/// Set / clear a per-user preference. `value_json` of empty string clears
/// (matches the typical "set to default" UI gesture).
#[reducer]
pub fn set_user_preference(
    ctx: &ReducerContext,
    key: String,
    value_json: String,
) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("preference key cannot be empty".to_string());
    }
    let identity = ctx.sender();
    let existing: Option<UserPreference> = ctx
        .db
        .user_preference()
        .identity()
        .filter(&identity)
        .find(|p| p.key == key);

    if value_json.is_empty() {
        if let Some(existing) = existing {
            ctx.db.user_preference().id().delete(existing.id);
        }
        return Ok(());
    }

    match existing {
        Some(existing) => {
            ctx.db.user_preference().id().update(UserPreference {
                value_json,
                updated_at: ctx.timestamp,
                ..existing
            });
        }
        None => {
            ctx.db.user_preference().insert(UserPreference {
                id: next_user_preference_id(ctx),
                identity,
                key,
                value_json,
                updated_at: ctx.timestamp,
            });
        }
    }
    Ok(())
}
