use hex;
use sha2::{Digest, Sha256};
use spacetimedb::{reducer, table, Identity, ReducerContext, SpacetimeType, Table, Timestamp};
use serde_json;

// ============================================================
// Custom Types
// ============================================================

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum PageType {
    Doc,
    Database,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ActorType {
    Human,
    Agent(String),
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ViewType {
    Grid,
    List,
    Kanban,
    Calendar,
    Gallery,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum SnapshotType {
    Manual,
    Periodic,
    PreAgentEdit,
    PostAgentEdit,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum PropertyType {
    Text,
    Number,
    Date,
    Select,
    MultiSelect,
    Relation,
    Checkbox,
    Url,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum PropertyValue {
    Text(String),
    Number(f64),
    Date(u64),
    Select(String),
    MultiSelect(Vec<String>),
    Relation(Vec<u64>),
    Checkbox(bool),
    Url(String),
}

// ============================================================
// Tables
// ============================================================

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

/// Universal atom — every piece of content is a Page.
/// Content lives separately in PageContent (fetched only when opened).
#[table(accessor = page, public)]
pub struct Page {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub parent_id: Option<u64>,
    pub page_type: PageType,
    pub title: String,
    pub embedding: Option<Vec<f32>>,
    pub created_by: ActorType,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// None = active, Some = soft deleted. Hard purge after 30 days.
    pub deleted_at: Option<Timestamp>,
}

/// Separated from Page so listing/filtering never loads content blobs.
#[table(accessor = page_content, public)]
pub struct PageContent {
    #[primary_key]
    pub page_id: u64,
    pub content: String,
    pub updated_at: Timestamp,
}

/// Append-only log of Yjs CRDT updates for collaborative doc editing.
/// Clients apply all updates in id order to reconstruct the live document.
/// page_content is kept as a materialised read-only snapshot; this table
/// is the authoritative source for collaborative editing.
#[table(accessor = page_yjs_update, public)]
pub struct PageYjsUpdate {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    /// Binary-encoded Yjs update (output of Y.encodeStateAsUpdate / doc.on('update')).
    pub data: Vec<u8>,
}

/// Point-in-time snapshot of a page. Backbone of version history.
#[table(accessor = page_snapshot, public)]
pub struct PageSnapshot {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub title: String,
    pub content: String,
    pub snapshot_at: Timestamp,
    pub created_by: ActorType,
    pub snapshot_type: SnapshotType,
}

/// Column structure definition for a Database page.
#[table(accessor = database_schema, public)]
pub struct DatabaseSchema {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub name: String,
}

/// Each column in a database schema.
#[table(accessor = property_definition, public)]
pub struct PropertyDefinition {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub schema_id: u64,
    pub name: String,
    pub property_type: PropertyType,
    pub config: String,
    pub order: u32,
}

/// Current property value for a page (row).
#[table(accessor = page_property_value, public)]
pub struct PagePropertyValue {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    #[index(btree)]
    pub property_definition_id: u64,
    pub value: PropertyValue,
}

/// Append-only history of every property value change.
#[table(accessor = page_property_value_history, public)]
pub struct PagePropertyValueHistory {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    #[index(btree)]
    pub property_definition_id: u64,
    pub value: PropertyValue,
    pub is_current: bool,
    pub changed_at: Timestamp,
    pub changed_by: ActorType,
}

/// Saved view config on a database page. Synced across devices.
#[table(accessor = database_view, public)]
pub struct DatabaseView {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub name: String,
    pub view_type: ViewType,
    /// JSON string: filters, sorts, column visibility, column widths.
    pub config: String,
    pub is_default: bool,
    /// None = shared view, Some(identity_hex) = personal view.
    pub owner_identity: Option<String>,
    pub created_by: ActorType,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

// ============================================================
// Lifecycle Reducers
// ============================================================

#[reducer(init)]
pub fn init(_ctx: &ReducerContext) {}

/// Called by SpacetimeDB whenever a client connects.
/// If the client presents an OIDC JWT, extracts the profile and marks the session
/// as authenticated immediately. Otherwise creates an unauthenticated row for
/// the native login flow to handle.
#[reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    let identity = ctx.sender();
    let (email, name) = extract_oidc_profile(ctx);
    let via_oidc = !email.is_empty() || !name.is_empty();

    if let Some(existing) = ctx.db.user().identity().find(&identity) {
        ctx.db.user().identity().update(User {
            email: if email.is_empty() { existing.email } else { email },
            name: if name.is_empty() { existing.name } else { name },
            is_authenticated: existing.is_authenticated || via_oidc,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    } else {
        ctx.db.user().insert(User {
            identity,
            name,
            email,
            is_authenticated: via_oidc,
            created_at: ctx.timestamp,
            last_seen_at: ctx.timestamp,
        });
    }
}

#[reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    let identity = ctx.sender();
    if let Some(existing) = ctx.db.user().identity().find(&identity) {
        ctx.db.user().identity().update(User {
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
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
    if let Some(existing) = ctx.db.user().identity().find(&identity) {
        ctx.db.user().identity().update(User {
            email,
            name,
            is_authenticated: true,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
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
    if let Some(existing) = ctx.db.user().identity().find(&identity) {
        ctx.db.user().identity().update(User {
            email,
            name: cred.name,
            is_authenticated: true,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
    Ok(())
}

/// Marks the current identity as logged out.
#[reducer]
pub fn logout(ctx: &ReducerContext) {
    let identity = ctx.sender();
    if let Some(existing) = ctx.db.user().identity().find(&identity) {
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
    if let Some(existing) = ctx.db.user().identity().find(&identity) {
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

/// Parses OIDC `email` and `name`/`preferred_username` claims from the sender's JWT.
/// Returns empty strings when no OIDC token is present (anonymous connection).
fn extract_oidc_profile(ctx: &ReducerContext) -> (String, String) {
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

// ============================================================
// Page Reducers
// ============================================================

/// Atomically creates a Page and its companion PageContent row.
#[reducer]
pub fn create_page(
    ctx: &ReducerContext,
    parent_id: Option<u64>,
    page_type: PageType,
    title: String,
) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("Title cannot be empty".to_string());
    }
    let page = ctx.db.page().insert(Page {
        id: 0,
        parent_id,
        page_type,
        title,
        embedding: None,
        created_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
    });
    ctx.db.page_content().insert(PageContent {
        page_id: page.id,
        content: String::new(),
        updated_at: ctx.timestamp,
    });
    Ok(())
}

#[reducer]
pub fn update_page_title(ctx: &ReducerContext, page_id: u64, title: String) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("Title cannot be empty".to_string());
    }
    let page = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        title,
        updated_at: ctx.timestamp,
        ..page
    });
    Ok(())
}

/// Updates PageContent (not Page) — content is separate from metadata.
#[reducer]
pub fn update_page_content(
    ctx: &ReducerContext,
    page_id: u64,
    content: String,
) -> Result<(), String> {
    let existing = ctx
        .db
        .page_content()
        .page_id()
        .find(&page_id)
        .ok_or("PageContent not found")?;
    ctx.db.page_content().page_id().update(PageContent {
        content,
        updated_at: ctx.timestamp,
        ..existing
    });
    if let Some(page) = ctx.db.page().id().find(&page_id) {
        ctx.db.page().id().update(Page {
            updated_at: ctx.timestamp,
            ..page
        });
    }
    Ok(())
}

/// Append a Yjs CRDT update for a page.
/// All connected clients receive this via their subscription and apply it to
/// their local Y.Doc, converging to the same document state without conflicts.
#[reducer]
pub fn apply_yjs_update(ctx: &ReducerContext, page_id: u64, data: Vec<u8>) {
    ctx.db.page_yjs_update().insert(PageYjsUpdate {
        id: 0, // auto_inc
        page_id,
        data,
    });
    // Touch the page's updated_at so the sidebar reflects recent activity.
    if let Some(page) = ctx.db.page().id().find(&page_id) {
        ctx.db.page().id().update(Page {
            updated_at: ctx.timestamp,
            ..page
        });
    }
}

/// Soft delete — sets deleted_at, never hard deletes.
#[reducer]
pub fn delete_page(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    let page = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        deleted_at: Some(ctx.timestamp),
        updated_at: ctx.timestamp,
        ..page
    });
    Ok(())
}

#[reducer]
pub fn restore_page(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    let page = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        deleted_at: None,
        updated_at: ctx.timestamp,
        ..page
    });
    Ok(())
}

// ============================================================
// Schema Reducers
// ============================================================

#[reducer]
pub fn create_database_schema(
    ctx: &ReducerContext,
    page_id: u64,
    name: String,
) -> Result<(), String> {
    ctx.db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    ctx.db.database_schema().insert(DatabaseSchema {
        id: 0,
        page_id,
        name,
    });
    Ok(())
}

#[reducer]
pub fn add_property(
    ctx: &ReducerContext,
    schema_id: u64,
    name: String,
    property_type: PropertyType,
    config: String,
) -> Result<(), String> {
    ctx.db
        .database_schema()
        .id()
        .find(&schema_id)
        .ok_or("Schema not found")?;
    let max_order = ctx
        .db
        .property_definition()
        .schema_id()
        .filter(&schema_id)
        .map(|p| p.order)
        .max()
        .unwrap_or(0);
    ctx.db.property_definition().insert(PropertyDefinition {
        id: 0,
        schema_id,
        name,
        property_type,
        config,
        order: max_order + 1,
    });
    Ok(())
}

#[reducer]
pub fn reorder_property(
    ctx: &ReducerContext,
    property_definition_id: u64,
    new_order: u32,
) -> Result<(), String> {
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(&property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition {
            order: new_order,
            ..prop
        });
    Ok(())
}

#[reducer]
pub fn delete_property(ctx: &ReducerContext, property_definition_id: u64) -> Result<(), String> {
    ctx.db
        .property_definition()
        .id()
        .delete(&property_definition_id);
    Ok(())
}

#[reducer]
pub fn rename_property(
    ctx: &ReducerContext,
    property_definition_id: u64,
    name: String,
) -> Result<(), String> {
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(&property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition { name, ..prop });
    Ok(())
}

#[reducer]
pub fn update_property_config(
    ctx: &ReducerContext,
    property_definition_id: u64,
    config: String,
) -> Result<(), String> {
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(&property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition { config, ..prop });
    Ok(())
}

#[reducer]
pub fn update_property_type(
    ctx: &ReducerContext,
    property_definition_id: u64,
    property_type: PropertyType,
) -> Result<(), String> {
    let prop = ctx
        .db
        .property_definition()
        .id()
        .find(&property_definition_id)
        .ok_or("PropertyDefinition not found")?;
    ctx.db
        .property_definition()
        .id()
        .update(PropertyDefinition {
            property_type,
            config: "{}".to_string(),
            ..prop
        });
    Ok(())
}

// ============================================================
// Property Value Reducers
// ============================================================

/// Upserts the current value and appends an immutable history row.
#[reducer]
pub fn set_property_value(
    ctx: &ReducerContext,
    page_id: u64,
    property_definition_id: u64,
    value: PropertyValue,
) -> Result<(), String> {
    // Collect existing current-history entries before mutating
    let stale_history: Vec<PagePropertyValueHistory> = ctx
        .db
        .page_property_value_history()
        .page_id()
        .filter(&page_id)
        .filter(|h| h.property_definition_id == property_definition_id && h.is_current)
        .collect();

    for hist in stale_history {
        ctx.db
            .page_property_value_history()
            .id()
            .update(PagePropertyValueHistory {
                is_current: false,
                ..hist
            });
    }

    // Append new history entry (clone value — it's also needed for upsert below)
    ctx.db
        .page_property_value_history()
        .insert(PagePropertyValueHistory {
            id: 0,
            page_id,
            property_definition_id,
            value: value.clone(),
            is_current: true,
            changed_at: ctx.timestamp,
            changed_by: ActorType::Human,
        });

    // Collect existing current value before mutating
    let existing_value: Option<PagePropertyValue> = ctx
        .db
        .page_property_value()
        .page_id()
        .filter(&page_id)
        .find(|v| v.property_definition_id == property_definition_id);

    match existing_value {
        Some(existing) => {
            ctx.db
                .page_property_value()
                .id()
                .update(PagePropertyValue { value, ..existing });
        }
        None => {
            ctx.db.page_property_value().insert(PagePropertyValue {
                id: 0,
                page_id,
                property_definition_id,
                value,
            });
        }
    }

    Ok(())
}

#[reducer]
pub fn clear_property_value(
    ctx: &ReducerContext,
    page_id: u64,
    property_definition_id: u64,
) -> Result<(), String> {
    let existing: Option<PagePropertyValue> = ctx
        .db
        .page_property_value()
        .page_id()
        .filter(&page_id)
        .find(|v| v.property_definition_id == property_definition_id);

    if let Some(row) = existing {
        ctx.db.page_property_value().id().delete(&row.id);
    }
    Ok(())
}

// ============================================================
// Snapshot Reducers
// ============================================================

#[reducer]
pub fn take_snapshot(
    ctx: &ReducerContext,
    page_id: u64,
    snapshot_type: SnapshotType,
) -> Result<(), String> {
    let page = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    let content = ctx
        .db
        .page_content()
        .page_id()
        .find(&page_id)
        .map(|c| c.content)
        .unwrap_or_default();
    ctx.db.page_snapshot().insert(PageSnapshot {
        id: 0,
        page_id,
        title: page.title,
        content,
        snapshot_at: ctx.timestamp,
        created_by: ActorType::Human,
        snapshot_type,
    });
    Ok(())
}

/// Rolls page title and content back to a previous snapshot.
#[reducer]
pub fn restore_page_to_snapshot(
    ctx: &ReducerContext,
    page_id: u64,
    snapshot_id: u64,
) -> Result<(), String> {
    let snapshot = ctx
        .db
        .page_snapshot()
        .id()
        .find(&snapshot_id)
        .ok_or("Snapshot not found")?;
    if snapshot.page_id != page_id {
        return Err("Snapshot does not belong to this page".to_string());
    }
    let restored_title = snapshot.title.clone();
    let restored_content = snapshot.content.clone();

    let page = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        title: restored_title,
        updated_at: ctx.timestamp,
        ..page
    });

    if let Some(existing_content) = ctx.db.page_content().page_id().find(&page_id) {
        ctx.db.page_content().page_id().update(PageContent {
            content: restored_content,
            updated_at: ctx.timestamp,
            ..existing_content
        });
    }
    Ok(())
}

// ============================================================
// View Reducers
// ============================================================

/// Creates a view. First view for a page is automatically set as default.
#[reducer]
pub fn create_view(
    ctx: &ReducerContext,
    page_id: u64,
    name: String,
    view_type: ViewType,
    owner_identity: Option<String>,
) -> Result<(), String> {
    ctx.db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    let is_default = ctx
        .db
        .database_view()
        .page_id()
        .filter(&page_id)
        .next()
        .is_none();
    ctx.db.database_view().insert(DatabaseView {
        id: 0,
        page_id,
        name,
        view_type,
        config: "{}".to_string(),
        is_default,
        owner_identity,
        created_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    Ok(())
}

#[reducer]
pub fn update_view_config(ctx: &ReducerContext, view_id: u64, config: String) -> Result<(), String> {
    let view = ctx
        .db
        .database_view()
        .id()
        .find(&view_id)
        .ok_or("View not found")?;
    ctx.db.database_view().id().update(DatabaseView {
        config,
        updated_at: ctx.timestamp,
        ..view
    });
    Ok(())
}

#[reducer]
pub fn rename_view(ctx: &ReducerContext, view_id: u64, name: String) -> Result<(), String> {
    let view = ctx
        .db
        .database_view()
        .id()
        .find(&view_id)
        .ok_or("View not found")?;
    ctx.db.database_view().id().update(DatabaseView {
        name,
        updated_at: ctx.timestamp,
        ..view
    });
    Ok(())
}

/// Clears is_default on all other views for this page, then sets the target.
#[reducer]
pub fn set_default_view(ctx: &ReducerContext, view_id: u64) -> Result<(), String> {
    let target = ctx
        .db
        .database_view()
        .id()
        .find(&view_id)
        .ok_or("View not found")?;
    let page_id = target.page_id;

    // Collect other current-default views before mutating
    let current_defaults: Vec<DatabaseView> = ctx
        .db
        .database_view()
        .page_id()
        .filter(&page_id)
        .filter(|v| v.is_default && v.id != view_id)
        .collect();

    for view in current_defaults {
        ctx.db.database_view().id().update(DatabaseView {
            is_default: false,
            updated_at: ctx.timestamp,
            ..view
        });
    }

    ctx.db.database_view().id().update(DatabaseView {
        is_default: true,
        updated_at: ctx.timestamp,
        ..target
    });
    Ok(())
}

#[reducer]
pub fn delete_view(ctx: &ReducerContext, view_id: u64) -> Result<(), String> {
    ctx.db.database_view().id().delete(&view_id);
    Ok(())
}
