use hex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use spacetimedb::{reducer, table, Identity, ReducerContext, SpacetimeType, Table, Timestamp};
use serde_json;

mod pear_import;

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
    Person,
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
    /// Identity hex strings of assigned users.
    Person(Vec<String>),
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ConversationStatus {
    Active,
    Closed,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum MessageSender {
    Human(Identity),
    AiUser(u64),
    /// System-generated messages — inner string is the event kind (e.g. "compaction").
    System(String),
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum MessageStatus {
    Complete,
    Thinking,
    ToolUse,
    Streaming,
    Error,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum InferenceProvider {
    Anthropic,
    OpenAI,
    Ollama,
    OpenAICompatible,
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
    /// Position within siblings. Spaced by 1000 so insertions rarely need a renumber.
    pub sort_order: u32,
    pub embedding: Option<Vec<f32>>,
    pub created_by: ActorType,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// None = active, Some = soft deleted. Hard purge after 30 days.
    pub deleted_at: Option<Timestamp>,
    /// Optional emoji/icon (single character or short string) for sidebar and header. Must be last for schema migration.
    #[default(Option::<String>::None)]
    pub icon: Option<String>,
}

/// Separated from Page so listing/filtering never loads content blobs.
#[table(accessor = page_content, public)]
pub struct PageContent {
    #[primary_key]
    pub page_id: u64,
    pub content: String,
    pub updated_at: Timestamp,
}

/// Single merged Yjs state blob per page.
/// Replaces the old PageYjsUpdate append-only log. Clients write the full
/// Y.encodeStateAsUpdate(doc) here periodically (on blur, on unmount, every ~30s).
/// On fresh load (IndexedDB empty), clients apply this blob to their Y.Doc.
/// IndexedDB (y-indexeddb) is the primary local cache; this is the cross-device
/// sync and backup layer.
#[table(accessor = page_yjs_state, public)]
pub struct PageYjsState {
    #[primary_key]
    pub page_id: u64,
    /// Full merged Yjs state (Y.encodeStateAsUpdate output).
    pub data: Vec<u8>,
    pub updated_at: Timestamp,
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
    /// JSON config for schema-level settings (e.g. name column default).
    #[default(None::<String>)]
    pub config: Option<String>,
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

/// File upload metadata. Blob lives in S3/MinIO at storage_key; this row is the source of truth for "what's attached to this page".
#[table(accessor = attachment, public)]
pub struct Attachment {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub filename: String,
    pub content_type: String,
    /// Key in the S3 bucket (e.g. "pages/123/abc-123.png").
    pub storage_key: String,
    pub size_bytes: u64,
    pub created_at: Timestamp,
}

/// AI user inference configuration. Private table — never synced to clients.
/// The presence of a row here means the associated AiUserProfile is an AI user.
/// Credentials are stored server-side only; the worker reads this table to
/// initialize the correct provider client per AI user.
#[table(accessor = ai_user_config, private)]
pub struct AiUserConfig {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// The human who created and owns this AI user.
    pub created_by: Identity,
    pub provider: InferenceProvider,
    pub model: String,
    /// Required for Ollama / OpenAICompatible providers.
    pub endpoint: Option<String>,
    /// Stored in a private table — never leaves the server.
    pub api_key: Option<String>,
    pub system_prompt: Option<String>,
    pub max_tokens: u32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Public projection of an AI user — display info only, no credentials.
/// Clients subscribe to this table for @mention autocomplete, avatars, etc.
#[table(accessor = ai_user_profile, public)]
pub struct AiUserProfile {
    #[primary_key]
    pub ai_user_id: u64,
    pub display_name: String,
    pub avatar_url: Option<String>,
    /// Human-readable provider name (e.g. "Anthropic", "OpenAI").
    pub provider_name: String,
    pub model_name: String,
    pub created_by: Identity,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// A conversation between a human and an AI user, attached to a page.
/// A page can have multiple conversations (different AI users, or separate threads).
#[table(accessor = conversation, public)]
pub struct Conversation {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    /// References AiUserProfile.ai_user_id / AiUserConfig.id.
    pub ai_user_id: u64,
    /// The human who started this conversation via @mention.
    pub initiated_by: Identity,
    pub status: ConversationStatus,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// A single message within a conversation. Sender can be human, AI, or system.
/// Messages that trigger Orcha jobs carry the job_id so the UI can show
/// execution status inline.
///
/// `tool_calls_json` is a round-trippable JSON array of content blocks in message
/// order, containing both `tool_use` and `tool_result` objects needed to reconstruct
/// the full Anthropic API context window on session resume. See FEATURE_ai_users.md
/// for the defined block schema.
#[table(accessor = conversation_message, public)]
pub struct ConversationMessage {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub conversation_id: u64,
    pub sender: MessageSender,
    /// Markdown-formatted message text.
    pub content: String,
    /// If this message spawned an Orcha job, link it here.
    pub job_id: Option<u64>,
    pub created_at: Timestamp,
    #[default(MessageStatus::Complete)]
    pub status: MessageStatus,
    /// Extended thinking output from the LLM.
    #[default(None::<String>)]
    pub thinking: Option<String>,
    /// Round-trippable JSON array of tool_use / tool_result content blocks.
    #[default(None::<String>)]
    pub tool_calls_json: Option<String>,
    /// Anthropic input tokens consumed by this assistant turn (0 for human/system).
    #[default(0u32)]
    pub input_tokens: u32,
    /// Anthropic output tokens produced by this assistant turn (0 for human/system).
    #[default(0u32)]
    pub output_tokens: u32,
    /// Tokens written to the prompt cache during this turn.
    #[default(0u32)]
    pub cache_creation_input_tokens: u32,
    /// Tokens read from the prompt cache during this turn.
    #[default(0u32)]
    pub cache_read_input_tokens: u32,
}

// ============================================================
// Lifecycle Reducers
// ============================================================

/// Manifest JSON for the built-in Pear workspace tools.
/// Mirrors extensions/pear-workspace-tools.json in the repository.
const PEAR_WORKSPACE_TOOLS_MANIFEST: &str = r#"{
  "builtin": {
    "tools": [
      "get_context", "web_search", "fetch_url",
      "create_page", "update_page_content", "update_page_title",
      "search_pages", "list_child_pages", "get_page",
      "get_schema_id", "list_properties", "add_property",
      "create_row", "set_property_value"
    ],
    "requested_permissions": [
      { "scope": "workspace", "action": "Read" },
      { "scope": "workspace", "action": "Write" },
      { "scope": "workspace", "action": "PropertyRead" },
      { "scope": "workspace", "action": "PropertyWrite" },
      { "scope": "workspace", "action": "HttpOutbound", "allowed_domains": ["*"] }
    ]
  }
}"#;

/// Seed the pear-workspace-tools built-in manifest + installed extension.
/// Idempotent — no-op if already seeded (checks by name).
fn seed_builtin_extensions_inner(ctx: &ReducerContext) {
    let already_seeded = ctx
        .db
        .extension_manifest()
        .iter()
        .any(|m| m.name == "pear-workspace-tools");
    if already_seeded {
        return;
    }

    let manifest_row = ctx.db.extension_manifest().insert(ExtensionManifest {
        id: next_extension_manifest_id(ctx),
        name: "pear-workspace-tools".to_string(),
        description: "Built-in Pear workspace tools. Read and write pages, databases, and properties. Copy extensions/pear-workspace-tools.json in the repo to define your own extension.".to_string(),
        extension_type: ExtensionType::Builtin,
        version: "1.0.0".to_string(),
        author_identity: None,
        manifest_json: PEAR_WORKSPACE_TOOLS_MANIFEST.to_string(),
        source_url: Some("https://raw.githubusercontent.com/EclosionTech/Pear/main/extensions/pear-workspace-tools.json".to_string()),
        created_at: ctx.timestamp,
    });

    let installed_row = ctx.db.installed_extension().insert(InstalledExtension {
        id: next_installed_extension_id(ctx),
        manifest_id: manifest_row.id,
        installed_by: ctx.sender(),
        install_status: InstallStatus::Active,
        ai_user_id: None,
        mcp_server_id: None,
        enabled: true,
        installed_at: ctx.timestamp,
        confirmed_at: Some(ctx.timestamp),
    });

    let permissions = [
        (PermissionScope::Workspace, PermissionAction::Read, None),
        (PermissionScope::Workspace, PermissionAction::Write, None),
        (PermissionScope::Workspace, PermissionAction::PropertyRead, None),
        (PermissionScope::Workspace, PermissionAction::PropertyWrite, None),
        (PermissionScope::Workspace, PermissionAction::HttpOutbound, Some("[\"*\"]".to_string())),
    ];
    for (scope, action, allowed_domains) in permissions {
        ctx.db.extension_permission().insert(ExtensionPermission {
            id: next_extension_permission_id(ctx),
            installed_extension_id: installed_row.id,
            scope,
            action,
            allowed_domains,
            granted_by: ctx.sender(),
            granted_at: ctx.timestamp,
        });
    }
}

#[reducer(init)]
pub fn init(ctx: &ReducerContext) {
    seed_builtin_extensions_inner(ctx);
}

/// Seed the pear-workspace-tools built-in extension for databases that were created
/// before this feature shipped. Safe to call multiple times — no-op if already seeded.
#[reducer]
pub fn seed_builtin_extensions(ctx: &ReducerContext) -> Result<(), String> {
    seed_builtin_extensions_inner(ctx);
    Ok(())
}

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
// Next-ID helpers — compute max(id)+1 from existing rows.
// The built-in #[auto_inc] sequence can get out of sync after
// a `spacetime publish --update`, so we compute IDs manually.
// Reducers are serialised, so there is no race condition.
// ============================================================

fn next_page_id(ctx: &ReducerContext) -> u64 {
    ctx.db.page().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_page_snapshot_id(ctx: &ReducerContext) -> u64 {
    ctx.db.page_snapshot().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_database_schema_id(ctx: &ReducerContext) -> u64 {
    ctx.db.database_schema().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_property_definition_id(ctx: &ReducerContext) -> u64 {
    ctx.db.property_definition().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_page_property_value_id(ctx: &ReducerContext) -> u64 {
    ctx.db.page_property_value().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_page_property_value_history_id(ctx: &ReducerContext) -> u64 {
    ctx.db.page_property_value_history().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_database_view_id(ctx: &ReducerContext) -> u64 {
    ctx.db.database_view().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_attachment_id(ctx: &ReducerContext) -> u64 {
    ctx.db.attachment().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_ai_user_config_id(ctx: &ReducerContext) -> u64 {
    ctx.db.ai_user_config().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_conversation_id(ctx: &ReducerContext) -> u64 {
    ctx.db.conversation().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_conversation_message_id(ctx: &ReducerContext) -> u64 {
    ctx.db.conversation_message().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_orcha_job_id(ctx: &ReducerContext) -> u64 {
    ctx.db.orcha_job().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_orcha_task_id(ctx: &ReducerContext) -> u64 {
    ctx.db.orcha_task().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_orcha_shared_context_id(ctx: &ReducerContext) -> u64 {
    ctx.db.orcha_shared_context().iter().map(|r| r.id).max().unwrap_or(0) + 1
}

// ============================================================
// AI User Reducers
// ============================================================

fn provider_display_name(provider: &InferenceProvider) -> &'static str {
    match provider {
        InferenceProvider::Anthropic => "Anthropic",
        InferenceProvider::OpenAI => "OpenAI",
        InferenceProvider::Ollama => "Ollama",
        InferenceProvider::OpenAICompatible => "OpenAI Compatible",
    }
}

/// Create an AI user with its inference configuration and public profile.
/// Only authenticated humans can create AI users.
#[reducer]
pub fn create_ai_user(
    ctx: &ReducerContext,
    display_name: String,
    provider: InferenceProvider,
    model: String,
    endpoint: Option<String>,
    api_key: Option<String>,
    system_prompt: Option<String>,
    max_tokens: Option<u32>,
    avatar_url: Option<String>,
) -> Result<(), String> {
    let display_name = display_name.trim().to_string();
    if display_name.is_empty() {
        return Err("Display name is required".to_string());
    }
    if model.trim().is_empty() {
        return Err("Model is required".to_string());
    }
    if matches!(provider, InferenceProvider::Ollama | InferenceProvider::OpenAICompatible)
        && endpoint.as_ref().map_or(true, |e| e.trim().is_empty())
    {
        return Err("Endpoint is required for Ollama and OpenAI Compatible providers".to_string());
    }

    let prov_name = provider_display_name(&provider).to_string();
    let model_name = model.trim().to_string();

    let config = ctx.db.ai_user_config().insert(AiUserConfig {
        id: next_ai_user_config_id(ctx),
        created_by: ctx.sender(),
        provider,
        model: model_name.clone(),
        endpoint,
        api_key,
        system_prompt,
        max_tokens: max_tokens.unwrap_or(8192),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });

    ctx.db.ai_user_profile().insert(AiUserProfile {
        ai_user_id: config.id,
        display_name,
        avatar_url,
        provider_name: prov_name,
        model_name,
        created_by: ctx.sender(),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });

    log::info!("AI user created: id={}", config.id);
    Ok(())
}

/// Update the public-facing profile of an AI user (display name, avatar).
#[reducer]
pub fn update_ai_user_profile(
    ctx: &ReducerContext,
    ai_user_id: u64,
    display_name: String,
    avatar_url: Option<String>,
) -> Result<(), String> {
    let display_name = display_name.trim().to_string();
    if display_name.is_empty() {
        return Err("Display name is required".to_string());
    }
    let profile = ctx
        .db
        .ai_user_profile()
        .ai_user_id()
        .find(&ai_user_id)
        .ok_or("AI user not found")?;
    ctx.db.ai_user_profile().ai_user_id().update(AiUserProfile {
        display_name,
        avatar_url,
        updated_at: ctx.timestamp,
        ..profile
    });
    Ok(())
}

/// Update the inference configuration of an AI user (provider, model, endpoint,
/// system prompt, max tokens). Does NOT update the API key — use
/// set_ai_user_api_key for that.
#[reducer]
pub fn update_ai_user_config(
    ctx: &ReducerContext,
    ai_user_id: u64,
    provider: InferenceProvider,
    model: String,
    endpoint: Option<String>,
    system_prompt: Option<String>,
    max_tokens: Option<u32>,
) -> Result<(), String> {
    if model.trim().is_empty() {
        return Err("Model is required".to_string());
    }
    if matches!(provider, InferenceProvider::Ollama | InferenceProvider::OpenAICompatible)
        && endpoint.as_ref().map_or(true, |e| e.trim().is_empty())
    {
        return Err("Endpoint is required for Ollama and OpenAI Compatible providers".to_string());
    }

    let config = ctx
        .db
        .ai_user_config()
        .id()
        .find(&ai_user_id)
        .ok_or("AI user config not found")?;

    let prov_name = provider_display_name(&provider).to_string();
    let model_name = model.trim().to_string();

    ctx.db.ai_user_config().id().update(AiUserConfig {
        provider,
        model: model_name.clone(),
        endpoint,
        system_prompt,
        max_tokens: max_tokens.unwrap_or(config.max_tokens),
        updated_at: ctx.timestamp,
        ..config
    });

    if let Some(profile) = ctx.db.ai_user_profile().ai_user_id().find(&ai_user_id) {
        ctx.db.ai_user_profile().ai_user_id().update(AiUserProfile {
            provider_name: prov_name,
            model_name,
            updated_at: ctx.timestamp,
            ..profile
        });
    }

    Ok(())
}

/// Set or clear the API key for an AI user. Separated from update_ai_user_config
/// so callers can update config without re-submitting the key.
#[reducer]
pub fn set_ai_user_api_key(
    ctx: &ReducerContext,
    ai_user_id: u64,
    api_key: Option<String>,
) -> Result<(), String> {
    let config = ctx
        .db
        .ai_user_config()
        .id()
        .find(&ai_user_id)
        .ok_or("AI user config not found")?;
    ctx.db.ai_user_config().id().update(AiUserConfig {
        api_key,
        updated_at: ctx.timestamp,
        ..config
    });
    Ok(())
}

/// Delete an AI user and its configuration. Removes both the private config
/// and the public profile.
#[reducer]
pub fn delete_ai_user(ctx: &ReducerContext, ai_user_id: u64) -> Result<(), String> {
    ctx.db
        .ai_user_config()
        .id()
        .find(&ai_user_id)
        .ok_or("AI user not found")?;
    ctx.db.ai_user_config().id().delete(&ai_user_id);
    ctx.db.ai_user_profile().ai_user_id().delete(&ai_user_id);
    log::info!("AI user deleted: id={}", ai_user_id);
    Ok(())
}

// ============================================================
// Conversation Reducers
// ============================================================

/// Start a new conversation on a page with an AI user.
/// Called when a human @mentions an AI user in page content.
#[reducer]
pub fn create_conversation(
    ctx: &ReducerContext,
    page_id: u64,
    ai_user_id: u64,
) -> Result<(), String> {
    ctx.db.page().id().find(&page_id).ok_or("Page not found")?;
    ctx.db
        .ai_user_profile()
        .ai_user_id()
        .find(&ai_user_id)
        .ok_or("AI user not found")?;

    let conv = ctx.db.conversation().insert(Conversation {
        id: next_conversation_id(ctx),
        page_id,
        ai_user_id,
        initiated_by: ctx.sender(),
        status: ConversationStatus::Active,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });

    log::info!(
        "Conversation created: id={}, page={}, ai_user={}",
        conv.id,
        page_id,
        ai_user_id
    );
    Ok(())
}

/// Add a message to an active conversation.
/// The sender is inferred from ctx.sender() for humans. For AI user messages,
/// the worker calls this with the AI user's id.
/// Token fields are zero for human messages — only populate for AI assistant turns.
#[reducer]
pub fn send_message(
    ctx: &ReducerContext,
    conversation_id: u64,
    content: String,
    sender_ai_user_id: Option<u64>,
    job_id: Option<u64>,
    status: Option<MessageStatus>,
    thinking: Option<String>,
    tool_calls_json: Option<String>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    cache_creation_input_tokens: Option<u32>,
    cache_read_input_tokens: Option<u32>,
) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(&conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        return Err("Conversation is closed".to_string());
    }

    let sender = match sender_ai_user_id {
        Some(ai_id) => {
            ctx.db
                .ai_user_profile()
                .ai_user_id()
                .find(&ai_id)
                .ok_or("AI user not found")?;
            MessageSender::AiUser(ai_id)
        }
        None => MessageSender::Human(ctx.sender()),
    };

    ctx.db.conversation_message().insert(ConversationMessage {
        id: next_conversation_message_id(ctx),
        conversation_id,
        sender,
        content,
        job_id,
        created_at: ctx.timestamp,
        status: status.unwrap_or(MessageStatus::Complete),
        thinking,
        tool_calls_json,
        input_tokens: input_tokens.unwrap_or(0),
        output_tokens: output_tokens.unwrap_or(0),
        cache_creation_input_tokens: cache_creation_input_tokens.unwrap_or(0),
        cache_read_input_tokens: cache_read_input_tokens.unwrap_or(0),
    });

    ctx.db.conversation().id().update(Conversation {
        updated_at: ctx.timestamp,
        ..conv
    });

    Ok(())
}

/// Update an in-progress AI message (for streaming content, thinking, tool calls, final token counts).
#[reducer]
pub fn update_message(
    ctx: &ReducerContext,
    message_id: u64,
    content: String,
    status: MessageStatus,
    thinking: Option<String>,
    tool_calls_json: Option<String>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    cache_creation_input_tokens: Option<u32>,
    cache_read_input_tokens: Option<u32>,
) -> Result<(), String> {
    let msg = ctx
        .db
        .conversation_message()
        .id()
        .find(&message_id)
        .ok_or("Message not found")?;

    if matches!(msg.sender, MessageSender::Human(_) | MessageSender::System(_)) {
        return Err("Cannot update a human or system message".to_string());
    }

    let conv = ctx
        .db
        .conversation()
        .id()
        .find(&msg.conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        return Err("Conversation is closed".to_string());
    }

    ctx.db.conversation_message().id().update(ConversationMessage {
        content,
        status,
        thinking,
        tool_calls_json,
        input_tokens: input_tokens.unwrap_or(msg.input_tokens),
        output_tokens: output_tokens.unwrap_or(msg.output_tokens),
        cache_creation_input_tokens: cache_creation_input_tokens
            .unwrap_or(msg.cache_creation_input_tokens),
        cache_read_input_tokens: cache_read_input_tokens.unwrap_or(msg.cache_read_input_tokens),
        ..msg
    });

    ctx.db.conversation().id().update(Conversation {
        updated_at: ctx.timestamp,
        ..conv
    });

    Ok(())
}

/// Close a conversation. No further messages can be added.
#[reducer]
pub fn close_conversation(
    ctx: &ReducerContext,
    conversation_id: u64,
) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(&conversation_id)
        .ok_or("Conversation not found")?;
    ctx.db.conversation().id().update(Conversation {
        status: ConversationStatus::Closed,
        updated_at: ctx.timestamp,
        ..conv
    });
    Ok(())
}

/// Record a claw-code compaction event for a conversation.
///
/// Inserts a `System("compaction")` message containing the summary text produced
/// by `compact_session()`. On session resume, the worker treats the most recent
/// compaction message as the context floor — all messages before it are discarded
/// and the summary is injected as a system prompt block.
#[reducer]
pub fn record_compaction(
    ctx: &ReducerContext,
    conversation_id: u64,
    summary: String,
) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(&conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        return Err("Conversation is closed".to_string());
    }
    ctx.db.conversation_message().insert(ConversationMessage {
        id: next_conversation_message_id(ctx),
        conversation_id,
        sender: MessageSender::System("compaction".to_string()),
        content: summary,
        job_id: None,
        created_at: ctx.timestamp,
        status: MessageStatus::Complete,
        thinking: None,
        tool_calls_json: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    });
    ctx.db.conversation().id().update(Conversation {
        updated_at: ctx.timestamp,
        ..conv
    });
    Ok(())
}

// ============================================================
// Page Reducers
// ============================================================

/// Returns the next sort_order for a new sibling under `parent_id`.
/// Scans all active siblings and returns max_order + 1000.
fn next_sort_order(ctx: &ReducerContext, parent_id: Option<u64>) -> u32 {
    ctx.db
        .page()
        .iter()
        .filter(|p| p.parent_id == parent_id && p.deleted_at.is_none())
        .map(|p| p.sort_order)
        .max()
        .unwrap_or(0)
        + 1000
}

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
    let sort_order = next_sort_order(ctx, parent_id);
    let page = ctx.db.page().insert(Page {
        id: next_page_id(ctx),
        parent_id,
        sort_order,
        page_type,
        title,
        icon: None,
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

/// Moves a page to a new parent and/or position.
///
/// `new_parent_id` — target parent (None = root).
/// `after_page_id` — place after this sibling (None = place first).
///
/// Renumbers all siblings of the new parent so sort_order stays clean.
#[reducer]
pub fn move_page(
    ctx: &ReducerContext,
    page_id: u64,
    new_parent_id: Option<u64>,
    after_page_id: Option<u64>,
) -> Result<(), String> {
    let page = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;

    // Collect and sort active siblings of the new parent (excluding the moving page).
    let mut siblings: Vec<Page> = ctx
        .db
        .page()
        .iter()
        .filter(|p| p.parent_id == new_parent_id && p.deleted_at.is_none() && p.id != page_id)
        .collect();
    siblings.sort_by_key(|p| p.sort_order);

    // Find the insertion index.
    let insert_after = match after_page_id {
        None => 0, // place first
        Some(after_id) => {
            siblings
                .iter()
                .position(|p| p.id == after_id)
                .map(|i| i + 1)
                .unwrap_or(siblings.len())
        }
    };

    // Splice the moving page into the sorted list (move, no Clone needed).
    siblings.insert(insert_after, page);

    // Renumber all siblings with clean multiples of 1000.
    for (i, sibling) in siblings.into_iter().enumerate() {
        let new_order = (i as u32 + 1) * 1000;
        if sibling.id == page_id {
            ctx.db.page().id().update(Page {
                parent_id: new_parent_id,
                sort_order: new_order,
                updated_at: ctx.timestamp,
                ..sibling
            });
        } else if sibling.sort_order != new_order {
            ctx.db.page().id().update(Page {
                sort_order: new_order,
                ..sibling
            });
        }
    }

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

/// Set or clear the page icon (emoji). Pass empty string to clear.
#[reducer]
pub fn update_page_icon(ctx: &ReducerContext, page_id: u64, icon: String) -> Result<(), String> {
    let page = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    let new_icon = if icon.trim().is_empty() {
        None
    } else {
        Some(icon.trim().to_string())
    };
    ctx.db.page().id().update(Page {
        icon: new_icon,
        updated_at: ctx.timestamp,
        ..page
    });
    Ok(())
}

/// Persists a semantic embedding for the page (384-dim, `all-MiniLM-L6-v2` / Xenova ONNX).
/// Used by the quick switcher for meaning-based search. Call after content changes (debounced).
#[reducer]
pub fn set_page_embedding(
    ctx: &ReducerContext,
    page_id: u64,
    embedding: Vec<f32>,
) -> Result<(), String> {
    if embedding.is_empty() {
        return Err("embedding must not be empty".to_string());
    }
    if embedding.len() != 384 {
        return Err(format!(
            "embedding must be 384 floats (MiniLM), got {}",
            embedding.len()
        ));
    }
    let page = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        embedding: Some(embedding),
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

/// Persist the full merged Yjs state for a page.
/// Called periodically by the client (on blur, on unmount, every ~30s).
/// Upserts the single PageYjsState row for the page so row count stays O(1).
/// Also touches the page's updated_at so the sidebar reflects recent activity.
#[reducer]
pub fn save_yjs_state(
    ctx: &ReducerContext,
    page_id: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    ctx.db.page().id().find(&page_id).ok_or("Page not found")?;

    if let Some(existing) = ctx.db.page_yjs_state().page_id().find(&page_id) {
        ctx.db.page_yjs_state().page_id().update(PageYjsState {
            data,
            updated_at: ctx.timestamp,
            ..existing
        });
    } else {
        ctx.db.page_yjs_state().insert(PageYjsState {
            page_id,
            data,
            updated_at: ctx.timestamp,
        });
    }

    if let Some(page) = ctx.db.page().id().find(&page_id) {
        ctx.db.page().id().update(Page {
            updated_at: ctx.timestamp,
            ..page
        });
    }
    Ok(())
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

/// Register a new attachment after the client uploads the blob to S3/MinIO.
/// Call this once the upload succeeds so the attachment is linked to the page.
#[reducer]
pub fn create_attachment(
    ctx: &ReducerContext,
    page_id: u64,
    filename: String,
    content_type: String,
    storage_key: String,
    size_bytes: u64,
) -> Result<(), String> {
    ctx.db.page().id().find(&page_id).ok_or("Page not found")?;
    if filename.is_empty() || storage_key.is_empty() {
        return Err("filename and storage_key are required".to_string());
    }
    ctx.db.attachment().insert(Attachment {
        id: next_attachment_id(ctx),
        page_id,
        filename,
        content_type,
        storage_key,
        size_bytes,
        created_at: ctx.timestamp,
    });
    Ok(())
}

/// Remove an attachment record. Call after deleting the blob from S3 (or leave orphaned blobs for later cleanup).
#[reducer]
pub fn delete_attachment(ctx: &ReducerContext, attachment_id: u64) -> Result<(), String> {
    ctx.db
        .attachment()
        .id()
        .find(&attachment_id)
        .ok_or("Attachment not found")?;
    ctx.db.attachment().id().delete(&attachment_id);
    Ok(())
}

/// Permanently delete a soft-deleted page and its direct data. Fails if page is not in trash.
/// Children are reparented to this page's parent (never purged) — we never cascade-delete
/// non-deleted content.
#[reducer]
pub fn purge_page(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    let page = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    if page.deleted_at.is_none() {
        return Err("Page is not in trash. Move to trash first.".to_string());
    }

    // Reparent children to our parent — never purge them (they may not be in trash)
    let child_ids: Vec<u64> = ctx
        .db
        .page()
        .iter()
        .filter(|p| p.parent_id == Some(page_id))
        .map(|p| p.id)
        .collect();
    for cid in child_ids {
        if let Some(child) = ctx.db.page().id().find(&cid) {
            ctx.db.page().id().update(Page {
                parent_id: page.parent_id,
                updated_at: ctx.timestamp,
                ..child
            });
        }
    }

    purge_page_inner(ctx, page_id)
}

fn purge_page_inner(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    // Delete linked data (PageContent is 1:1 with Page)
    ctx.db.page_content().page_id().delete(&page_id);

    // Delete the Yjs state blob (single row, primary key = page_id).
    ctx.db.page_yjs_state().page_id().delete(&page_id);

    let snapshot_ids: Vec<u64> = ctx.db.page_snapshot().page_id().filter(&page_id).map(|s| s.id).collect();
    for sid in snapshot_ids {
        ctx.db.page_snapshot().id().delete(&sid);
    }

    let pv_ids: Vec<u64> = ctx
        .db
        .page_property_value()
        .page_id()
        .filter(&page_id)
        .map(|v| v.id)
        .collect();
    for vid in pv_ids {
        ctx.db.page_property_value().id().delete(&vid);
    }

    let hist_ids: Vec<u64> = ctx
        .db
        .page_property_value_history()
        .page_id()
        .filter(&page_id)
        .map(|h| h.id)
        .collect();
    for hid in hist_ids {
        ctx.db.page_property_value_history().id().delete(&hid);
    }

    // If database page: delete views, property defs, schemas
    let schema_ids: Vec<u64> = ctx
        .db
        .database_schema()
        .page_id()
        .filter(&page_id)
        .map(|s| s.id)
        .collect();
    for schema_id in &schema_ids {
        let prop_ids: Vec<u64> = ctx
            .db
            .property_definition()
            .schema_id()
            .filter(schema_id)
            .map(|p| p.id)
            .collect();
        for pid in prop_ids {
            ctx.db.property_definition().id().delete(&pid);
        }
        ctx.db.database_schema().id().delete(schema_id);
    }

    let view_ids: Vec<u64> = ctx
        .db
        .database_view()
        .page_id()
        .filter(&page_id)
        .map(|v| v.id)
        .collect();
    for vid in view_ids {
        ctx.db.database_view().id().delete(&vid);
    }

    ctx.db.page().id().delete(&page_id);
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
        id: next_database_schema_id(ctx),
        page_id,
        name,
        config: None,
    });
    Ok(())
}

#[reducer]
pub fn update_database_schema_config(
    ctx: &ReducerContext,
    schema_id: u64,
    config: String,
) -> Result<(), String> {
    let mut schema = ctx
        .db
        .database_schema()
        .id()
        .find(&schema_id)
        .ok_or("Schema not found")?;
    schema.config = Some(config);
    ctx.db.database_schema().id().update(schema);
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
        id: next_property_definition_id(ctx),
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

/// Seed the agent_instruction PropertyDefinition for a database schema.
/// Idempotent — no-op if the property already exists for this schema.
/// Called for new schemas or as a one-time migration for pre-existing workspaces.
/// Workers call discover_instruction_pages gracefully if this property is absent.
#[reducer]
pub fn seed_agent_instruction_property(
    ctx: &ReducerContext,
    schema_id: u64,
) -> Result<(), String> {
    ctx.db
        .database_schema()
        .id()
        .find(&schema_id)
        .ok_or("Database schema not found")?;

    let already_exists = ctx
        .db
        .property_definition()
        .schema_id()
        .filter(&schema_id)
        .any(|p| p.name == "agent_instruction");

    if already_exists {
        return Ok(());
    }

    ctx.db.property_definition().insert(PropertyDefinition {
        id: next_property_definition_id(ctx),
        schema_id,
        name: "agent_instruction".to_string(),
        property_type: PropertyType::Checkbox,
        config: "{}".to_string(),
        order: 0,
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
            id: next_page_property_value_history_id(ctx),
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
                id: next_page_property_value_id(ctx),
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

/// Snapshot using whatever is currently in PageContent.
/// Used for manual "Save version" and for agent pre/post snapshots
/// where content is already materialised.
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
        id: next_page_snapshot_id(ctx),
        page_id,
        title: page.title,
        content,
        snapshot_at: ctx.timestamp,
        created_by: ActorType::Human,
        snapshot_type,
    });
    Ok(())
}

/// Snapshot with content supplied by the client (e.g. from the live Yjs editor).
/// Also syncs PageContent so it stays current — important because PageContent is
/// the source of truth for restore and for take_snapshot above.
/// Used for Periodic auto-saves: the editor serialises its live state and calls
/// this every N minutes while the page is open.
#[reducer]
pub fn take_snapshot_with_content(
    ctx: &ReducerContext,
    page_id: u64,
    snapshot_type: SnapshotType,
    content: String,
) -> Result<(), String> {
    let page = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;

    // Keep PageContent in sync with actual editor state.
    if let Some(existing) = ctx.db.page_content().page_id().find(&page_id) {
        ctx.db.page_content().page_id().update(PageContent {
            content: content.clone(),
            updated_at: ctx.timestamp,
            ..existing
        });
    }

    ctx.db.page_snapshot().insert(PageSnapshot {
        id: next_page_snapshot_id(ctx),
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

    // Clear the Yjs state blob so the client re-bootstraps from the restored
    // PageContent JSON on next open (the client will re-derive a Yjs state from it).
    if ctx.db.page_yjs_state().page_id().find(&page_id).is_some() {
        ctx.db.page_yjs_state().page_id().delete(&page_id);
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
        id: next_database_view_id(ctx),
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

// ============================================================
// Orcha Coordination Layer
// ============================================================
//
// Orcha tables and reducers are embedded directly in the Pear SpacetimeDB module
// so all Pear objects and Orcha coordination live in the same relational graph.
//
// To use an external Orcha instance instead, set ORCHA_SPACETIMEDB_URI and
// ORCHA_SPACETIMEDB_DB_NAME in your environment — workers and the Next.js server
// will connect there rather than using these embedded tables.
//
// Protocol: https://codeberg.org/Orcha/orcha

/// Deserialization helper for the task_graph_json argument to create_job.
/// Not a SpacetimeType — only used server-side during JSON parsing.
#[derive(Deserialize)]
struct TaskSpec {
    pub description: String,
    pub task_type: String,
    /// Indices into the task_specs array this task depends on (resolved to IDs on insert).
    pub depends_on: Vec<u64>,
    pub required_capabilities: Vec<String>,
}

/// A coordinated unit of AI/worker work. Parent of OrchaTask rows.
#[table(accessor = orcha_job, public)]
pub struct OrchaJob {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub user_id: String,
    pub prompt: String,
    /// Pear page linked to this job — enables native traversal from job → page content.
    #[index(btree)]
    pub page_id: Option<u64>,
    /// "executing" | "complete" | "failed"
    pub status: String,
    pub created_at: Timestamp,
}

/// Atomic unit of work within a job. Supports DAG dependencies via depends_on.
#[table(accessor = orcha_task, public)]
pub struct OrchaTask {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub job_id: u64,
    pub description: String,
    pub task_type: String,
    /// "pending" | "claimed" | "done" | "failed"
    pub status: String,
    /// OrchaTask IDs this task depends on — all must be "done" before this can be claimed.
    pub depends_on: Vec<u64>,
    pub required_capabilities: Vec<String>,
    /// agent_id of the claiming agent, or None if unclaimed.
    pub assigned_to: Option<String>,
    /// Serialized result from the agent, or "ERROR: ..." on failure.
    pub result: Option<String>,
}

/// A registered worker that can claim and execute tasks.
#[table(accessor = orcha_agent, public)]
pub struct OrchaAgent {
    #[primary_key]
    pub id: String,
    pub capabilities: Vec<String>,
    /// "idle" | "busy" | "offline"
    pub status: String,
}

/// Key/value handoff between workers on the same job.
/// Scoped to job_id so the same key name can be used across different jobs.
#[table(accessor = orcha_shared_context, public)]
pub struct OrchaSharedContext {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub job_id: u64,
    pub key: String,
    pub value: String,
    pub created_by: String,
}

/// Check whether all tasks for a job have reached a terminal state and update job status.
/// Called after every task state transition to "done" or "failed".
fn check_orcha_job_completion(ctx: &ReducerContext, job_id: u64) {
    let tasks: Vec<OrchaTask> = ctx.db.orcha_task().job_id().filter(&job_id).collect();
    if tasks.is_empty() {
        return;
    }
    let all_terminal = tasks.iter().all(|t| t.status == "done" || t.status == "failed");
    if !all_terminal {
        return;
    }
    let any_failed = tasks.iter().any(|t| t.status == "failed");
    if let Some(job) = ctx.db.orcha_job().id().find(job_id) {
        ctx.db.orcha_job().id().update(OrchaJob {
            status: if any_failed {
                "failed".to_string()
            } else {
                "complete".to_string()
            },
            ..job
        });
        log::info!("Orcha: job {} complete (any_failed={})", job_id, any_failed);
    }
}

/// Create a job with a full task graph.
///
/// `task_graph_json`: JSON array of objects with shape:
/// `{ "description": "...", "task_type": "...", "depends_on": [0, 1], "required_capabilities": ["llm"] }`
/// `depends_on` entries are zero-based indices into the array — resolved to actual task IDs on insert.
///
/// `page_id`: optional Pear page this job acts on (schema generation, summarization, NL filter, etc.)
#[reducer]
pub fn create_job(
    ctx: &ReducerContext,
    user_id: String,
    prompt: String,
    page_id: Option<u64>,
    task_graph_json: String,
) -> Result<(), String> {
    let specs: Vec<TaskSpec> = serde_json::from_str(&task_graph_json)
        .map_err(|e| format!("Invalid task graph JSON: {}", e))?;

    let job = ctx.db.orcha_job().insert(OrchaJob {
        id: next_orcha_job_id(ctx),
        user_id,
        prompt,
        page_id,
        status: "executing".to_string(),
        created_at: ctx.timestamp,
    });
    let job_id = job.id;

    // Insert tasks with empty depends_on first to get real IDs.
    let mut task_ids: Vec<u64> = Vec::with_capacity(specs.len());
    for spec in &specs {
        let task = ctx.db.orcha_task().insert(OrchaTask {
            id: next_orcha_task_id(ctx),
            job_id,
            description: spec.description.clone(),
            task_type: spec.task_type.clone(),
            status: "pending".to_string(),
            depends_on: vec![],
            required_capabilities: spec.required_capabilities.clone(),
            assigned_to: None,
            result: None,
        });
        task_ids.push(task.id);
    }

    // Second pass: resolve depends_on indices → actual OrchaTask IDs.
    for (i, &task_id) in task_ids.iter().enumerate() {
        let resolved: Vec<u64> = specs[i]
            .depends_on
            .iter()
            .filter_map(|&idx| task_ids.get(idx as usize).copied())
            .collect();
        if !resolved.is_empty() {
            if let Some(row) = ctx.db.orcha_task().id().find(task_id) {
                ctx.db.orcha_task().id().update(OrchaTask {
                    depends_on: resolved,
                    ..row
                });
            }
        }
    }

    log::info!("Orcha: created job {} with {} tasks", job_id, task_ids.len());
    Ok(())
}

/// Register or update an agent's capabilities. Safe to call on reconnect.
#[reducer]
pub fn register_agent(
    ctx: &ReducerContext,
    agent_id: String,
    capabilities: Vec<String>,
) -> Result<(), String> {
    if let Some(existing) = ctx.db.orcha_agent().id().find(agent_id.clone()) {
        ctx.db.orcha_agent().id().update(OrchaAgent {
            capabilities,
            status: "idle".to_string(),
            ..existing
        });
    } else {
        ctx.db.orcha_agent().insert(OrchaAgent {
            id: agent_id,
            capabilities,
            status: "idle".to_string(),
        });
    }
    Ok(())
}

/// Claim a pending task. Fails if already claimed, dependencies unmet, or agent lacks capabilities.
#[reducer]
pub fn claim_task(ctx: &ReducerContext, agent_id: String, task_id: u64) -> Result<(), String> {
    let task = ctx
        .db
        .orcha_task()
        .id()
        .find(task_id)
        .ok_or("Task not found")?;
    if task.assigned_to.is_some() {
        return Err("Task already claimed".to_string());
    }
    for &dep_id in &task.depends_on {
        let dep = ctx
            .db
            .orcha_task()
            .id()
            .find(dep_id)
            .ok_or_else(|| format!("Dependency task {} not found", dep_id))?;
        if dep.status != "done" {
            return Err(format!(
                "Dependency task {} not yet done (status: {})",
                dep_id, dep.status
            ));
        }
    }
    let agent = ctx
        .db
        .orcha_agent()
        .id()
        .find(agent_id.clone())
        .ok_or("Agent not found")?;
    for cap in &task.required_capabilities {
        if !agent.capabilities.contains(cap) {
            return Err(format!("Agent missing required capability: {}", cap));
        }
    }
    ctx.db.orcha_task().id().update(OrchaTask {
        assigned_to: Some(agent_id),
        status: "claimed".to_string(),
        ..task
    });
    Ok(())
}

/// Submit a completed task result. Triggers job completion check.
#[reducer]
pub fn submit_result(
    ctx: &ReducerContext,
    agent_id: String,
    task_id: u64,
    result: String,
) -> Result<(), String> {
    let task = ctx
        .db
        .orcha_task()
        .id()
        .find(task_id)
        .ok_or("Task not found")?;
    if task.assigned_to.as_deref() != Some(&agent_id) {
        return Err("Task not claimed by this agent".to_string());
    }
    let job_id = task.job_id;
    ctx.db.orcha_task().id().update(OrchaTask {
        result: Some(result),
        status: "done".to_string(),
        ..task
    });
    check_orcha_job_completion(ctx, job_id);
    Ok(())
}

/// Mark a task as failed. Triggers job completion check.
#[reducer]
pub fn fail_task(
    ctx: &ReducerContext,
    agent_id: String,
    task_id: u64,
    error: String,
) -> Result<(), String> {
    let task = ctx
        .db
        .orcha_task()
        .id()
        .find(task_id)
        .ok_or("Task not found")?;
    if task.assigned_to.as_deref() != Some(&agent_id) {
        return Err("Task not claimed by this agent".to_string());
    }
    let job_id = task.job_id;
    ctx.db.orcha_task().id().update(OrchaTask {
        result: Some(format!("ERROR: {}", error)),
        status: "failed".to_string(),
        ..task
    });
    check_orcha_job_completion(ctx, job_id);
    Ok(())
}

/// Dynamically add tasks to an existing job.
///
/// Called by an orchestrate worker after it has decomposed the user's prompt
/// into a task graph. The `task_graph_json` format is identical to `create_job`:
/// a JSON array of `{ description, task_type, depends_on: [index], required_capabilities }`.
/// `depends_on` indices are resolved relative to the NEW tasks in this batch —
/// they do not reference existing tasks in the job.
#[reducer]
pub fn add_tasks_to_job(
    ctx: &ReducerContext,
    job_id: u64,
    task_graph_json: String,
) -> Result<(), String> {
    ctx.db
        .orcha_job()
        .id()
        .find(job_id)
        .ok_or("Job not found")?;

    let specs: Vec<TaskSpec> = serde_json::from_str(&task_graph_json)
        .map_err(|e| format!("Invalid task graph JSON: {}", e))?;

    let mut new_task_ids: Vec<u64> = Vec::with_capacity(specs.len());
    for spec in &specs {
        let task = ctx.db.orcha_task().insert(OrchaTask {
            id: next_orcha_task_id(ctx),
            job_id,
            description: spec.description.clone(),
            task_type: spec.task_type.clone(),
            status: "pending".to_string(),
            depends_on: vec![],
            required_capabilities: spec.required_capabilities.clone(),
            assigned_to: None,
            result: None,
        });
        new_task_ids.push(task.id);
    }

    // Resolve depends_on indices → actual OrchaTask IDs within this batch.
    for (i, &task_id) in new_task_ids.iter().enumerate() {
        let resolved: Vec<u64> = specs[i]
            .depends_on
            .iter()
            .filter_map(|&idx| new_task_ids.get(idx as usize).copied())
            .collect();
        if !resolved.is_empty() {
            if let Some(row) = ctx.db.orcha_task().id().find(task_id) {
                ctx.db.orcha_task().id().update(OrchaTask {
                    depends_on: resolved,
                    ..row
                });
            }
        }
    }

    log::info!(
        "Orcha: added {} tasks to job {}",
        new_task_ids.len(),
        job_id
    );
    Ok(())
}

/// Write a key/value entry to the shared context for a job.
/// Overwrites any existing entry for the same job + key pair.
#[reducer]
pub fn set_shared_context(
    ctx: &ReducerContext,
    job_id: u64,
    key: String,
    value: String,
    created_by: String,
) -> Result<(), String> {
    ctx.db
        .orcha_job()
        .id()
        .find(job_id)
        .ok_or("Job not found")?;
    let existing = ctx
        .db
        .orcha_shared_context()
        .job_id()
        .filter(&job_id)
        .find(|e| e.key == key);
    match existing {
        Some(row) => {
            ctx.db
                .orcha_shared_context()
                .id()
                .update(OrchaSharedContext {
                    value,
                    created_by,
                    ..row
                });
        }
        None => {
            ctx.db.orcha_shared_context().insert(OrchaSharedContext {
                id: next_orcha_shared_context_id(ctx),
                job_id,
                key,
                value,
                created_by,
            });
        }
    }
    Ok(())
}

// ============================================================
// Extensions — Custom Types
// ============================================================

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ExtensionType {
    ConfigBundle,
    McpServer,
    Hybrid,
    /// Built-in static tools compiled into the worker. No MCP endpoint or AI config.
    /// Auto-seeded in init — always Active, never needs confirmation.
    Builtin,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AuthScheme {
    None,
    ApiKey,
    /// OAuth flow is deferred post-v1 — field reserved, not implemented.
    OAuth,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum InstallStatus {
    /// Install is complete and active.
    Active,
    /// Install is paused pending human confirmation of sensitive capabilities.
    /// Call confirm_extension_install to proceed or cancel_extension_install to abort.
    PendingConfirmation,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum PermissionScope {
    /// Single page id.
    Page(u64),
    /// Page id and all its descendants.
    Subtree(u64),
    /// All pages in the workspace — requires explicit confirmation, never default.
    Workspace,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum PermissionAction {
    Read,
    Write,
    /// Str-replace only — does not grant full Write.
    Edit,
    Delete,
    Snapshot,
    PropertyRead,
    PropertyWrite,
    SpawnJob,
    /// Must have allowed_domains populated — wildcard never permitted.
    HttpOutbound,
}

// ============================================================
// Extensions — Tables
// ============================================================

/// Published extension manifest. Public — must never contain credentials or API keys.
/// Validated on insert. Does not install — just makes the manifest available.
#[table(accessor = extension_manifest, public)]
pub struct ExtensionManifest {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
    pub description: String,
    pub extension_type: ExtensionType,
    pub version: String,
    /// None = built-in or imported from external registry.
    pub author_identity: Option<Identity>,
    /// Full manifest as JSON. Validated on insert — must not contain credentials.
    pub manifest_json: String,
    /// If fetched from a federated registry, the source URL.
    pub source_url: Option<String>,
    pub created_at: Timestamp,
}

/// An installed instance of an extension.
/// install_status drives the two-step install flow for sensitive capabilities.
/// Populated FKs depend on extension_type:
///   ConfigBundle → ai_user_id populated
///   McpServer    → mcp_server_id populated
///   Hybrid       → both populated
#[table(accessor = installed_extension, public)]
pub struct InstalledExtension {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub manifest_id: u64,
    pub installed_by: Identity,
    pub install_status: InstallStatus,
    /// FK to AiUserConfig.id / AiUserProfile.ai_user_id
    pub ai_user_id: Option<u64>,
    /// FK to McpServer.id (the extensions McpServer table, not a struct collision)
    pub mcp_server_id: Option<u64>,
    pub enabled: bool,
    pub installed_at: Timestamp,
    pub confirmed_at: Option<Timestamp>,
}

/// MCP server registration. Private — contains credentials.
/// capabilities stores ONLY what was confirmed at install time —
/// never the full set declared in the manifest.
///
/// Cross-workspace isolation is enforced via installed_by Identity:
/// reducers reject operations where ctx.sender() != installed_by.
#[table(accessor = extension_mcp_server, private)]
pub struct ExtensionMcpServer {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
    pub endpoint: String,
    pub auth_scheme: AuthScheme,
    pub api_key: Option<String>,
    /// Confirmed capability set only. Manifest-declared set is discarded after install.
    pub capabilities: Vec<String>,
    pub installed_by: Identity,
    pub enabled: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Explicit permission grant for an installed extension.
/// No row = no permission. Never defaulted — must be explicitly granted.
/// Private — never exposed to agents, extensions, or external tools.
#[table(accessor = extension_permission, private)]
pub struct ExtensionPermission {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub installed_extension_id: u64,
    pub scope: PermissionScope,
    pub action: PermissionAction,
    /// Required when action = HttpOutbound. JSON array of allowed domains.
    /// Empty array = deny all outbound HTTP. Wildcards rejected at insert time.
    /// Localhost and RFC 1918 ranges blocked at execution time regardless.
    #[default(None::<String>)]
    pub allowed_domains: Option<String>,
    pub granted_by: Identity,
    pub granted_at: Timestamp,
}

/// Immutable audit record of every tool call made by any agent worker.
/// Append-only — no delete or update reducers exist for this table.
/// Never exposed to agents, extensions, or external tools.
/// Retention policy: indefinite (review before production workloads).
#[table(accessor = tool_call_audit_log, private)]
pub struct ToolCallAuditLog {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub conversation_id: u64,
    pub job_id: Option<u64>,
    pub task_id: Option<u64>,
    pub agent_id: String,
    pub installed_extension_id: Option<u64>,
    pub tool_name: String,
    /// SHA-256 of raw input — not the input itself.
    pub input_hash: String,
    /// SHA-256 of raw output — not the output itself.
    pub output_hash: String,
    /// "allowed" | "denied" | "error"
    pub outcome: String,
    pub outcome_detail: Option<String>,
    pub called_at: Timestamp,
}

// ============================================================
// Extensions — ID Helpers
// ============================================================

fn next_extension_manifest_id(ctx: &ReducerContext) -> u64 {
    ctx.db.extension_manifest().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_installed_extension_id(ctx: &ReducerContext) -> u64 {
    ctx.db.installed_extension().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_extension_mcp_server_id(ctx: &ReducerContext) -> u64 {
    ctx.db.extension_mcp_server().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_extension_permission_id(ctx: &ReducerContext) -> u64 {
    ctx.db.extension_permission().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_tool_call_audit_log_id(ctx: &ReducerContext) -> u64 {
    ctx.db.tool_call_audit_log().iter().map(|r| r.id).max().unwrap_or(0) + 1
}

// ============================================================
// Extensions — Manifest Parsing
// ============================================================

#[derive(Deserialize, Clone, Debug, Default)]
struct ManifestPermission {
    scope: String,
    action: String,
    #[serde(default)]
    allowed_domains: Option<Vec<String>>,
}

#[derive(Deserialize, Debug, Default)]
struct ManifestConfigBundle {
    display_name: String,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    system_prompt: Option<String>,
    #[serde(default)]
    max_tokens: u32,
    #[serde(default)]
    requested_capabilities: Vec<String>,
    #[serde(default)]
    requested_permissions: Vec<ManifestPermission>,
}

#[derive(Deserialize, Debug, Default)]
struct ManifestMcpServer {
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    auth_scheme: String,
    #[serde(default)]
    requested_capabilities: Vec<String>,
    #[serde(default)]
    requested_permissions: Vec<ManifestPermission>,
}

#[derive(Deserialize, Debug, Default)]
struct ManifestBuiltin {
    /// Tool names — for display/documentation only; not used server-side.
    #[serde(default)]
    #[allow(dead_code)]
    tools: Vec<String>,
    #[serde(default)]
    requested_permissions: Vec<ManifestPermission>,
}

#[derive(Deserialize, Debug)]
struct ManifestDoc {
    #[serde(default)]
    config_bundle: Option<ManifestConfigBundle>,
    #[serde(default)]
    mcp_server: Option<ManifestMcpServer>,
    #[serde(default)]
    builtin: Option<ManifestBuiltin>,
}

/// Capabilities that require explicit human confirmation (PendingConfirmation path).
const SENSITIVE_CAPABILITIES: &[&str] = &[
    "tool-bash",
    "tool-http",
    "tool-spawn-job",
    "tool-property-write",
    "domain-casefloat-intake",
];

fn parse_permission_scope(s: &str) -> Result<PermissionScope, String> {
    if s == "workspace" {
        Ok(PermissionScope::Workspace)
    } else if let Some(id_str) = s.strip_prefix("subtree:") {
        let id = id_str
            .parse::<u64>()
            .map_err(|_| format!("Invalid subtree page id: {id_str}"))?;
        Ok(PermissionScope::Subtree(id))
    } else if let Some(id_str) = s.strip_prefix("page:") {
        let id = id_str
            .parse::<u64>()
            .map_err(|_| format!("Invalid page id: {id_str}"))?;
        Ok(PermissionScope::Page(id))
    } else {
        Err(format!("Unknown permission scope: {s}"))
    }
}

fn parse_permission_action(s: &str) -> Result<PermissionAction, String> {
    match s {
        "Read" => Ok(PermissionAction::Read),
        "Write" => Ok(PermissionAction::Write),
        "Edit" => Ok(PermissionAction::Edit),
        "Delete" => Ok(PermissionAction::Delete),
        "Snapshot" => Ok(PermissionAction::Snapshot),
        "PropertyRead" => Ok(PermissionAction::PropertyRead),
        "PropertyWrite" => Ok(PermissionAction::PropertyWrite),
        "SpawnJob" => Ok(PermissionAction::SpawnJob),
        "HttpOutbound" => Ok(PermissionAction::HttpOutbound),
        _ => Err(format!("Unknown permission action: {s}")),
    }
}

fn parse_auth_scheme(s: &str) -> Result<AuthScheme, String> {
    match s.to_lowercase().as_str() {
        "none" | "" => Ok(AuthScheme::None),
        "api_key" | "apikey" => Ok(AuthScheme::ApiKey),
        "oauth" => Ok(AuthScheme::OAuth),
        _ => Err(format!("Unknown auth scheme: {s}")),
    }
}

fn all_requested_capabilities(manifest: &ManifestDoc) -> Vec<String> {
    let mut caps = Vec::new();
    if let Some(cb) = &manifest.config_bundle {
        caps.extend(cb.requested_capabilities.iter().cloned());
    }
    if let Some(ms) = &manifest.mcp_server {
        caps.extend(ms.requested_capabilities.iter().cloned());
    }
    caps
}

fn all_requested_permissions(manifest: &ManifestDoc) -> Vec<ManifestPermission> {
    let mut perms = Vec::new();
    if let Some(cb) = &manifest.config_bundle {
        perms.extend(cb.requested_permissions.iter().cloned());
    }
    if let Some(ms) = &manifest.mcp_server {
        perms.extend(ms.requested_permissions.iter().cloned());
    }
    if let Some(b) = &manifest.builtin {
        perms.extend(b.requested_permissions.iter().cloned());
    }
    perms
}

/// Returns true if any capability or workspace-write permission requires PendingConfirmation.
fn has_sensitive_request(manifest: &ManifestDoc) -> bool {
    let caps = all_requested_capabilities(manifest);
    if caps.iter().any(|c| SENSITIVE_CAPABILITIES.contains(&c.as_str())) {
        return true;
    }
    let perms = all_requested_permissions(manifest);
    for perm in &perms {
        if perm.scope == "workspace" {
            if let Ok(action) = parse_permission_action(&perm.action) {
                if matches!(
                    action,
                    PermissionAction::Write
                        | PermissionAction::Edit
                        | PermissionAction::Delete
                        | PermissionAction::PropertyWrite
                        | PermissionAction::SpawnJob
                        | PermissionAction::HttpOutbound
                ) {
                    return true;
                }
            }
        }
    }
    false
}

/// Check that a manifest JSON string does not contain credential-like keys.
fn has_credential_fields(json: &str) -> bool {
    // Check for credential keys as JSON object keys (key followed by colon)
    ["\"api_key\":", "\"secret\":", "\"password\":", "\"private_key\":"]
        .iter()
        .any(|pattern| json.contains(pattern))
}

/// Check that no permission in the list uses a wildcard domain for HttpOutbound.
fn has_wildcard_domains(permissions: &[ManifestPermission]) -> bool {
    permissions.iter().any(|p| {
        p.allowed_domains
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|d| d.contains('*'))
    })
}

/// Create ExtensionPermission rows from a list of parsed permissions.
fn create_extension_permissions(
    ctx: &ReducerContext,
    installed_extension_id: u64,
    granted_by: Identity,
    permissions: &[ManifestPermission],
) -> Result<(), String> {
    for perm in permissions {
        let scope = parse_permission_scope(&perm.scope)?;
        let action = parse_permission_action(&perm.action)?;
        let allowed_domains = if matches!(action, PermissionAction::HttpOutbound) {
            let domains = perm.allowed_domains.as_deref().unwrap_or(&[]);
            if domains.is_empty() {
                return Err("HttpOutbound permission requires at least one allowed_domain".to_string());
            }
            Some(
                serde_json::to_string(domains)
                    .unwrap_or_else(|_| "[]".to_string()),
            )
        } else {
            None
        };
        ctx.db.extension_permission().insert(ExtensionPermission {
            id: next_extension_permission_id(ctx),
            installed_extension_id,
            scope,
            action,
            allowed_domains,
            granted_by,
            granted_at: ctx.timestamp,
        });
    }
    Ok(())
}

/// Create an AiUserConfig + AiUserProfile for a ConfigBundle extension.
/// Returns the new ai_user_id.
fn create_extension_ai_user(
    ctx: &ReducerContext,
    installed_by: Identity,
    cb: &ManifestConfigBundle,
    ai_api_key: Option<String>,
) -> Result<u64, String> {
    let provider = match cb.provider.as_str() {
        "Anthropic" | "anthropic" => InferenceProvider::Anthropic,
        "OpenAI" | "openai" => InferenceProvider::OpenAI,
        "Ollama" | "ollama" => InferenceProvider::Ollama,
        "OpenAICompatible" | "openai_compatible" => InferenceProvider::OpenAICompatible,
        _ => return Err(format!("Unknown inference provider: {}", cb.provider)),
    };
    let provider_name = provider_display_name(&provider).to_string();
    let model = if cb.model.is_empty() {
        return Err("config_bundle.model is required".to_string());
    } else {
        cb.model.clone()
    };
    let config_row = ctx.db.ai_user_config().insert(AiUserConfig {
        id: next_ai_user_config_id(ctx),
        created_by: installed_by,
        provider,
        model: model.clone(),
        endpoint: None,
        api_key: ai_api_key,
        system_prompt: cb
            .system_prompt
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        max_tokens: if cb.max_tokens == 0 { 8192 } else { cb.max_tokens },
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    ctx.db.ai_user_profile().insert(AiUserProfile {
        ai_user_id: config_row.id,
        display_name: cb.display_name.clone(),
        avatar_url: cb.avatar_url.clone(),
        provider_name,
        model_name: model,
        created_by: installed_by,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    Ok(config_row.id)
}

/// Create an ExtensionMcpServer row. Returns the new server id.
fn create_extension_mcp_server(
    ctx: &ReducerContext,
    installed_by: Identity,
    ms: &ManifestMcpServer,
    mcp_api_key: Option<String>,
    endpoint_override: Option<String>,
    confirmed_capabilities: Vec<String>,
) -> Result<u64, String> {
    let endpoint = endpoint_override
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| ms.endpoint.clone());
    if endpoint.is_empty() {
        return Err("mcp_server.endpoint is required".to_string());
    }
    let auth_scheme = parse_auth_scheme(&ms.auth_scheme)?;
    let server_row = ctx.db.extension_mcp_server().insert(ExtensionMcpServer {
        id: next_extension_mcp_server_id(ctx),
        name: endpoint.clone(),
        endpoint,
        auth_scheme,
        api_key: mcp_api_key,
        capabilities: confirmed_capabilities,
        installed_by,
        enabled: true,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });
    Ok(server_row.id)
}

// ============================================================
// Extensions — Reducers
// ============================================================

/// Publish or import an extension manifest. Validates manifest_json:
/// - Must parse as valid manifest JSON
/// - Must not contain credential fields (api_key, secret, password, private_key)
/// - Wildcard allowed_domains are rejected
/// Does not install — just makes the manifest available for install_extension.
#[reducer]
pub fn publish_extension(
    ctx: &ReducerContext,
    name: String,
    description: String,
    extension_type: ExtensionType,
    version: String,
    manifest_json: String,
    source_url: Option<String>,
) -> Result<(), String> {
    if name.is_empty() {
        return Err("Extension name cannot be empty".to_string());
    }
    if has_credential_fields(&manifest_json) {
        return Err(
            "manifest_json must not contain credential fields (api_key, secret, password, private_key)".to_string(),
        );
    }
    let manifest: ManifestDoc = serde_json::from_str(&manifest_json)
        .map_err(|e| format!("Invalid manifest JSON: {e}"))?;
    // Builtin extensions declare the worker's own outbound capabilities — wildcards are
    // permitted because the static tools (web_search, fetch_url) call arbitrary URLs.
    if !matches!(extension_type, ExtensionType::Builtin) {
        let all_perms = all_requested_permissions(&manifest);
        if has_wildcard_domains(&all_perms) {
            return Err(
                "Wildcard domains are not permitted in HttpOutbound permissions".to_string(),
            );
        }
    }
    ctx.db.extension_manifest().insert(ExtensionManifest {
        id: next_extension_manifest_id(ctx),
        name,
        description,
        extension_type,
        version,
        author_identity: Some(ctx.sender()),
        manifest_json,
        source_url,
        created_at: ctx.timestamp,
    });
    Ok(())
}

/// Begin installation of a published extension.
///
/// Non-sensitive path (no sensitive capabilities or workspace-write permissions):
///   - Creates AiUserConfig/AiUserProfile and/or ExtensionMcpServer rows
///   - Creates ExtensionPermission rows for all requested_permissions
///   - Sets install_status = Active
///
/// Sensitive path (tool-bash, tool-http, tool-spawn-job, tool-property-write,
///                 domain-casefloat-intake, or workspace-scoped write):
///   - Creates InstalledExtension with install_status = PendingConfirmation
///   - Does NOT create AiUserConfig, ExtensionMcpServer, or ExtensionPermission rows yet
///   - Client must check install_status and call confirm_extension_install
///
/// ai_api_key: for ConfigBundle / Hybrid — stored in private AiUserConfig.
/// mcp_api_key: for McpServer / Hybrid — stored in private ExtensionMcpServer.
/// endpoint_override: allows self-hosted MCP servers to replace the manifest endpoint.
#[reducer]
pub fn install_extension(
    ctx: &ReducerContext,
    manifest_id: u64,
    ai_api_key: Option<String>,
    mcp_api_key: Option<String>,
    endpoint_override: Option<String>,
) -> Result<(), String> {
    let manifest_row = ctx
        .db
        .extension_manifest()
        .id()
        .find(&manifest_id)
        .ok_or("Extension manifest not found")?;

    let manifest: ManifestDoc = serde_json::from_str(&manifest_row.manifest_json)
        .map_err(|e| format!("Manifest parse error: {e}"))?;

    // Builtin extensions always install immediately — no API keys, no MCP server,
    // no sensitive capability confirmation required.
    if matches!(manifest_row.extension_type, ExtensionType::Builtin) {
        let installed_row = ctx.db.installed_extension().insert(InstalledExtension {
            id: next_installed_extension_id(ctx),
            manifest_id,
            installed_by: ctx.sender(),
            install_status: InstallStatus::Active,
            ai_user_id: None,
            mcp_server_id: None,
            enabled: true,
            installed_at: ctx.timestamp,
            confirmed_at: Some(ctx.timestamp),
        });
        let all_perms = all_requested_permissions(&manifest);
        create_extension_permissions(ctx, installed_row.id, ctx.sender(), &all_perms)?;
        return Ok(());
    }

    let sensitive = has_sensitive_request(&manifest);

    if sensitive {
        ctx.db.installed_extension().insert(InstalledExtension {
            id: next_installed_extension_id(ctx),
            manifest_id,
            installed_by: ctx.sender(),
            install_status: InstallStatus::PendingConfirmation,
            ai_user_id: None,
            mcp_server_id: None,
            enabled: false,
            installed_at: ctx.timestamp,
            confirmed_at: None,
        });
        return Ok(());
    }

    // Non-sensitive path — create sub-resources immediately.
    let mut ai_user_id: Option<u64> = None;
    let mut mcp_server_id: Option<u64> = None;

    if matches!(
        manifest_row.extension_type,
        ExtensionType::ConfigBundle | ExtensionType::Hybrid
    ) {
        let cb = manifest
            .config_bundle
            .as_ref()
            .ok_or("config_bundle required for ConfigBundle/Hybrid extension")?;
        ai_user_id = Some(create_extension_ai_user(ctx, ctx.sender(), cb, ai_api_key)?);
    }

    if matches!(
        manifest_row.extension_type,
        ExtensionType::McpServer | ExtensionType::Hybrid
    ) {
        let ms = manifest
            .mcp_server
            .as_ref()
            .ok_or("mcp_server required for McpServer/Hybrid extension")?;
        let confirmed_caps = ms.requested_capabilities.clone();
        mcp_server_id = Some(create_extension_mcp_server(
            ctx,
            ctx.sender(),
            ms,
            mcp_api_key,
            endpoint_override,
            confirmed_caps,
        )?);
    }

    let installed_row = ctx.db.installed_extension().insert(InstalledExtension {
        id: next_installed_extension_id(ctx),
        manifest_id,
        installed_by: ctx.sender(),
        install_status: InstallStatus::Active,
        ai_user_id,
        mcp_server_id,
        enabled: true,
        installed_at: ctx.timestamp,
        confirmed_at: Some(ctx.timestamp),
    });

    let all_perms = all_requested_permissions(&manifest);
    create_extension_permissions(ctx, installed_row.id, ctx.sender(), &all_perms)?;

    Ok(())
}

/// Complete installation after human review of sensitive capabilities.
///
/// confirmed_capabilities: subset of requested_capabilities the human is granting.
/// confirmed_permissions_json: JSON array of ManifestPermission objects — subset of requested.
/// ai_api_key / mcp_api_key: credentials not stored during PendingConfirmation; supply here.
/// endpoint_override: optional self-hosted endpoint to replace the manifest default.
#[reducer]
pub fn confirm_extension_install(
    ctx: &ReducerContext,
    installed_extension_id: u64,
    confirmed_capabilities: Vec<String>,
    confirmed_permissions_json: String,
    ai_api_key: Option<String>,
    mcp_api_key: Option<String>,
    endpoint_override: Option<String>,
) -> Result<(), String> {
    let installed = ctx
        .db
        .installed_extension()
        .id()
        .find(&installed_extension_id)
        .ok_or("InstalledExtension not found")?;

    if installed.installed_by != ctx.sender() {
        return Err("Only the installer can confirm an extension install".to_string());
    }
    if installed.install_status != InstallStatus::PendingConfirmation {
        return Err("Extension is not in PendingConfirmation state".to_string());
    }

    let manifest_row = ctx
        .db
        .extension_manifest()
        .id()
        .find(&installed.manifest_id)
        .ok_or("Manifest not found")?;

    let manifest: ManifestDoc = serde_json::from_str(&manifest_row.manifest_json)
        .map_err(|e| format!("Manifest parse error: {e}"))?;

    let confirmed_perms: Vec<ManifestPermission> =
        serde_json::from_str(&confirmed_permissions_json)
            .map_err(|e| format!("Invalid confirmed_permissions_json: {e}"))?;

    if has_wildcard_domains(&confirmed_perms) {
        return Err("Wildcard domains are not permitted".to_string());
    }

    let mut ai_user_id: Option<u64> = None;
    let mut mcp_server_id: Option<u64> = None;

    if matches!(
        manifest_row.extension_type,
        ExtensionType::ConfigBundle | ExtensionType::Hybrid
    ) {
        let cb = manifest
            .config_bundle
            .as_ref()
            .ok_or("config_bundle required for ConfigBundle/Hybrid extension")?;
        ai_user_id = Some(create_extension_ai_user(ctx, ctx.sender(), cb, ai_api_key)?);
    }

    if matches!(
        manifest_row.extension_type,
        ExtensionType::McpServer | ExtensionType::Hybrid
    ) {
        let ms = manifest
            .mcp_server
            .as_ref()
            .ok_or("mcp_server required for McpServer/Hybrid extension")?;
        // Use confirmed_capabilities filtered to only those from mcp_server section
        let mcp_caps: Vec<String> = confirmed_capabilities
            .iter()
            .filter(|c| ms.requested_capabilities.contains(c))
            .cloned()
            .collect();
        mcp_server_id = Some(create_extension_mcp_server(
            ctx,
            ctx.sender(),
            ms,
            mcp_api_key,
            endpoint_override,
            mcp_caps,
        )?);
    }

    ctx.db.installed_extension().id().update(InstalledExtension {
        install_status: InstallStatus::Active,
        ai_user_id,
        mcp_server_id,
        enabled: true,
        confirmed_at: Some(ctx.timestamp),
        ..installed
    });

    create_extension_permissions(ctx, installed_extension_id, ctx.sender(), &confirmed_perms)?;

    Ok(())
}

/// Abort a PendingConfirmation install. Removes the InstalledExtension row.
/// No-op if install_status is already Active.
#[reducer]
pub fn cancel_extension_install(
    ctx: &ReducerContext,
    installed_extension_id: u64,
) -> Result<(), String> {
    let installed = ctx
        .db
        .installed_extension()
        .id()
        .find(&installed_extension_id)
        .ok_or("InstalledExtension not found")?;

    if installed.installed_by != ctx.sender() {
        return Err("Only the installer can cancel an extension install".to_string());
    }
    if installed.install_status != InstallStatus::PendingConfirmation {
        return Ok(());
    }

    ctx.db
        .installed_extension()
        .id()
        .delete(&installed_extension_id);
    Ok(())
}

/// Uninstall an extension. Removes all associated rows except:
/// - ExtensionManifest (can be reinstalled)
/// - ToolCallAuditLog (audit trail is permanent)
#[reducer]
pub fn uninstall_extension(
    ctx: &ReducerContext,
    installed_extension_id: u64,
) -> Result<(), String> {
    let installed = ctx
        .db
        .installed_extension()
        .id()
        .find(&installed_extension_id)
        .ok_or("InstalledExtension not found")?;

    if installed.installed_by != ctx.sender() {
        return Err("Only the installer can uninstall an extension".to_string());
    }

    // Remove AiUserConfig + AiUserProfile if present
    if let Some(ai_id) = installed.ai_user_id {
        ctx.db.ai_user_config().id().delete(&ai_id);
        ctx.db.ai_user_profile().ai_user_id().delete(&ai_id);
    }

    // Remove ExtensionMcpServer if present
    if let Some(server_id) = installed.mcp_server_id {
        ctx.db.extension_mcp_server().id().delete(&server_id);
    }

    // Remove all ExtensionPermission rows for this installation
    let permission_ids: Vec<u64> = ctx
        .db
        .extension_permission()
        .installed_extension_id()
        .filter(&installed_extension_id)
        .map(|p| p.id)
        .collect();
    for pid in permission_ids {
        ctx.db.extension_permission().id().delete(&pid);
    }

    ctx.db
        .installed_extension()
        .id()
        .delete(&installed_extension_id);

    Ok(())
}

/// Enable or disable an extension without uninstalling.
/// Disabled extensions: worker stops being assigned new tasks immediately.
#[reducer]
pub fn set_extension_enabled(
    ctx: &ReducerContext,
    installed_extension_id: u64,
    enabled: bool,
) -> Result<(), String> {
    let installed = ctx
        .db
        .installed_extension()
        .id()
        .find(&installed_extension_id)
        .ok_or("InstalledExtension not found")?;

    if installed.installed_by != ctx.sender() {
        return Err("Only the installer can enable/disable an extension".to_string());
    }

    ctx.db
        .installed_extension()
        .id()
        .update(InstalledExtension { enabled, ..installed });

    // Mirror enabled state on the MCP server row
    if let Some(server_id) = installed.mcp_server_id {
        if let Some(server) = ctx.db.extension_mcp_server().id().find(&server_id) {
            ctx.db
                .extension_mcp_server()
                .id()
                .update(ExtensionMcpServer { enabled, ..server });
        }
    }

    Ok(())
}

/// Grant an additional permission to an already-installed extension.
/// Requires authenticated human caller — cannot be called by a worker.
#[reducer]
pub fn grant_extension_permission(
    ctx: &ReducerContext,
    installed_extension_id: u64,
    scope: PermissionScope,
    action: PermissionAction,
    allowed_domains: Option<String>,
) -> Result<(), String> {
    let installed = ctx
        .db
        .installed_extension()
        .id()
        .find(&installed_extension_id)
        .ok_or("InstalledExtension not found")?;

    if installed.installed_by != ctx.sender() {
        return Err("Only the installer can grant permissions to an extension".to_string());
    }

    if matches!(action, PermissionAction::HttpOutbound) {
        let domains_str = allowed_domains.as_deref().unwrap_or("[]");
        let domains: Vec<String> = serde_json::from_str(domains_str)
            .map_err(|_| "allowed_domains must be a valid JSON array of strings".to_string())?;
        if domains.iter().any(|d| d.contains('*')) {
            return Err("Wildcard domains are not permitted".to_string());
        }
        if domains.is_empty() {
            return Err("HttpOutbound permission requires at least one allowed_domain".to_string());
        }
    }

    ctx.db.extension_permission().insert(ExtensionPermission {
        id: next_extension_permission_id(ctx),
        installed_extension_id,
        scope,
        action,
        allowed_domains,
        granted_by: ctx.sender(),
        granted_at: ctx.timestamp,
    });

    Ok(())
}

/// Revoke a specific permission grant.
#[reducer]
pub fn revoke_extension_permission(
    ctx: &ReducerContext,
    permission_id: u64,
) -> Result<(), String> {
    let perm = ctx
        .db
        .extension_permission()
        .id()
        .find(&permission_id)
        .ok_or("ExtensionPermission not found")?;

    let installed = ctx
        .db
        .installed_extension()
        .id()
        .find(&perm.installed_extension_id)
        .ok_or("InstalledExtension not found")?;

    if installed.installed_by != ctx.sender() {
        return Err("Only the installer can revoke permissions".to_string());
    }

    ctx.db.extension_permission().id().delete(&permission_id);
    Ok(())
}

/// Update MCP server API key. Separate from install so the key never passes
/// through the manifest (which is public).
#[reducer]
pub fn set_mcp_server_api_key(
    ctx: &ReducerContext,
    mcp_server_id: u64,
    api_key: Option<String>,
) -> Result<(), String> {
    let server = ctx
        .db
        .extension_mcp_server()
        .id()
        .find(&mcp_server_id)
        .ok_or("ExtensionMcpServer not found")?;

    if server.installed_by != ctx.sender() {
        return Err("Only the installer can update the MCP server API key".to_string());
    }

    ctx.db
        .extension_mcp_server()
        .id()
        .update(ExtensionMcpServer {
            api_key,
            updated_at: ctx.timestamp,
            ..server
        });

    Ok(())
}

/// Append an immutable audit record for a tool call made by an agent worker.
/// Called by the worker's AuditLogger — never by a human client.
/// Outcome must be "allowed", "denied", or "error".
#[reducer]
pub fn record_tool_call_audit(
    ctx: &ReducerContext,
    conversation_id: u64,
    job_id: Option<u64>,
    task_id: Option<u64>,
    agent_id: String,
    installed_extension_id: Option<u64>,
    tool_name: String,
    input_hash: String,
    output_hash: String,
    outcome: String,
    outcome_detail: Option<String>,
) -> Result<(), String> {
    if !["allowed", "denied", "error"].contains(&outcome.as_str()) {
        return Err(format!(
            "outcome must be 'allowed', 'denied', or 'error'; got '{outcome}'"
        ));
    }
    ctx.db.tool_call_audit_log().insert(ToolCallAuditLog {
        id: next_tool_call_audit_log_id(ctx),
        conversation_id,
        job_id,
        task_id,
        agent_id,
        installed_extension_id,
        tool_name,
        input_hash,
        output_hash,
        outcome,
        outcome_detail,
        called_at: ctx.timestamp,
    });
    Ok(())
}

/// Upgrade an existing installation to a newer manifest version.
///
/// Validates that the new manifest is compatible (same extension_type, same name,
/// newer semver). Requires the installed extension to be in Active or PendingConfirmation
/// status and owned by the caller.
///
/// If the new manifest introduces newly-sensitive capabilities compared to the current one,
/// the install_status is set to PendingConfirmation and the caller must confirm via
/// confirm_extension_install before the extension is re-enabled.
///
/// Otherwise the manifest_id is updated in-place and the extension remains enabled.
#[reducer]
pub fn update_extension(
    ctx: &ReducerContext,
    installed_extension_id: u64,
    new_manifest_id: u64,
) -> Result<(), String> {
    let installed = ctx
        .db
        .installed_extension()
        .id()
        .find(&installed_extension_id)
        .ok_or("InstalledExtension not found")?;

    if installed.installed_by != ctx.sender() {
        return Err("Only the installing user can update this extension".to_string());
    }

    if !matches!(
        installed.install_status,
        InstallStatus::Active | InstallStatus::PendingConfirmation
    ) {
        return Err("Extension must be Active or PendingConfirmation to upgrade".to_string());
    }

    let new_manifest = ctx
        .db
        .extension_manifest()
        .id()
        .find(&new_manifest_id)
        .ok_or("New ExtensionManifest not found")?;

    let old_manifest = ctx
        .db
        .extension_manifest()
        .id()
        .find(&installed.manifest_id)
        .ok_or("Current ExtensionManifest not found")?;

    if new_manifest.name != old_manifest.name {
        return Err(format!(
            "Manifest name mismatch: expected '{}', got '{}'",
            old_manifest.name, new_manifest.name
        ));
    }
    if new_manifest.extension_type != old_manifest.extension_type {
        return Err("Cannot change extension_type during an upgrade".to_string());
    }

    let new_manifest_doc: ManifestDoc = serde_json::from_str(&new_manifest.manifest_json)
        .map_err(|e| format!("New manifest parse error: {e}"))?;
    let new_sensitive = has_sensitive_request(&new_manifest_doc);

    let old_manifest_doc: ManifestDoc = serde_json::from_str(&old_manifest.manifest_json)
        .map_err(|e| format!("Current manifest parse error: {e}"))?;
    let old_sensitive = has_sensitive_request(&old_manifest_doc);

    // Upgrade introduces new sensitive capabilities → require re-confirmation.
    let needs_reconfirm = new_sensitive && !old_sensitive;

    let new_status = if needs_reconfirm {
        InstallStatus::PendingConfirmation
    } else {
        installed.install_status.clone()
    };
    let enabled = if needs_reconfirm { false } else { installed.enabled };

    ctx.db.installed_extension().id().update(InstalledExtension {
        manifest_id: new_manifest_id,
        install_status: new_status,
        enabled,
        ..installed
    });

    Ok(())
}

// ============================================================
// Custom API Endpoints — Custom Types
// ============================================================

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum HttpMethod {
    Get,
    Post,
    Patch,
    Delete,
}

// ============================================================
// Custom API Endpoints — Tables
// ============================================================

/// A user-defined REST API endpoint that projects a clean HTTP interface
/// onto a specific Pear database. External tools can interact with workspace
/// data via /api/e/{slug} without understanding Pear internals.
#[table(accessor = api_endpoint, public)]
pub struct ApiEndpoint {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// The database page this endpoint projects.
    pub database_page_id: u64,
    /// URL path segment: /api/e/{slug}. Must be unique, lowercase, alphanumeric + hyphens.
    #[unique]
    pub slug: String,
    pub display_name: String,
    pub description: String,
    pub allowed_methods: Vec<HttpMethod>,
    pub require_auth: bool,
    pub created_by: Identity,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Maps a database property to an external-facing API field name.
/// Decouples the Pear UI column name from the API contract so renaming
/// columns doesn't break external integrations.
#[table(accessor = api_field_mapping, public)]
pub struct ApiFieldMapping {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub endpoint_id: u64,
    pub property_definition_id: u64,
    /// External-facing field name (e.g. "priority"). Lowercase, alphanumeric + underscores.
    pub field_name: String,
    pub required_on_create: bool,
    /// JSON-encoded default PropertyValue, applied when field is absent on POST.
    pub default_value: Option<String>,
    pub read_only: bool,
    pub field_order: u32,
}

/// Scoped API key for authenticating external requests to a custom endpoint.
/// Private table — only the SHA-256 hash of the key is stored; the raw key
/// is shown once at creation and never persisted.
#[table(accessor = api_endpoint_key, private)]
pub struct ApiEndpointKey {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub endpoint_id: u64,
    /// SHA-256 hash of the actual API key (hex-encoded).
    pub key_hash: String,
    /// Human-readable label (e.g. "CI pipeline", "Zapier webhook").
    pub label: String,
    /// Which HTTP methods this key permits.
    pub allowed_methods: Vec<HttpMethod>,
    pub created_by: Identity,
    pub created_at: Timestamp,
    pub last_used_at: Option<Timestamp>,
    /// None = no expiry.
    pub expires_at: Option<Timestamp>,
}

// ============================================================
// Custom API Endpoints — ID Helpers
// ============================================================

fn next_api_endpoint_id(ctx: &ReducerContext) -> u64 {
    ctx.db.api_endpoint().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_api_field_mapping_id(ctx: &ReducerContext) -> u64 {
    ctx.db.api_field_mapping().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_api_endpoint_key_id(ctx: &ReducerContext) -> u64 {
    ctx.db.api_endpoint_key().iter().map(|r| r.id).max().unwrap_or(0) + 1
}

/// Validate a slug: lowercase, alphanumeric + hyphens, 1-64 chars, no leading/trailing hyphens.
fn validate_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty() || slug.len() > 64 {
        return Err("Slug must be 1-64 characters".to_string());
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("Slug must contain only lowercase letters, digits, and hyphens".to_string());
    }
    if slug.starts_with('-') || slug.ends_with('-') {
        return Err("Slug must not start or end with a hyphen".to_string());
    }
    Ok(())
}

/// Validate a field name: lowercase, alphanumeric + underscores, 1-64 chars.
fn validate_field_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("Field name must be 1-64 characters".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(
            "Field name must contain only lowercase letters, digits, and underscores".to_string(),
        );
    }
    if name.starts_with('_') {
        return Err("Field name must not start with an underscore".to_string());
    }
    Ok(())
}

/// Derive a snake_case field name from a property display name.
fn slugify_field_name(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    // Collapse consecutive underscores and trim leading/trailing ones
    let mut result = String::new();
    let mut prev_underscore = true; // treat start as underscore to trim leading
    for c in slug.chars() {
        if c == '_' {
            if !prev_underscore {
                result.push('_');
            }
            prev_underscore = true;
        } else {
            result.push(c);
            prev_underscore = false;
        }
    }
    if result.ends_with('_') {
        result.pop();
    }
    if result.is_empty() {
        "field".to_string()
    } else {
        result
    }
}

// ============================================================
// Custom API Endpoints — Reducers
// ============================================================

/// Create a custom API endpoint for a database.
/// Auto-generates field mappings for all existing PropertyDefinitions on the database.
/// The slug must be unique across all endpoints.
#[reducer]
pub fn create_api_endpoint(
    ctx: &ReducerContext,
    database_page_id: u64,
    slug: String,
    display_name: String,
    description: String,
    allowed_methods: Vec<HttpMethod>,
    require_auth: bool,
) -> Result<(), String> {
    validate_slug(&slug)?;

    if display_name.trim().is_empty() {
        return Err("Display name cannot be empty".to_string());
    }
    if allowed_methods.is_empty() {
        return Err("At least one HTTP method must be allowed".to_string());
    }

    // Verify the target page exists and is a Database.
    let page = ctx
        .db
        .page()
        .id()
        .find(&database_page_id)
        .ok_or("Page not found")?;
    if page.page_type != PageType::Database {
        return Err("Target page must be a Database".to_string());
    }
    if page.deleted_at.is_some() {
        return Err("Cannot create endpoint for a deleted database".to_string());
    }

    // Check slug uniqueness (the #[unique] attribute enforces this at the DB level,
    // but a clear error message is better than a raw constraint violation).
    let slug_taken = ctx
        .db
        .api_endpoint()
        .slug()
        .find(&slug)
        .is_some();
    if slug_taken {
        return Err(format!("Slug '{}' is already in use", slug));
    }

    let endpoint = ctx.db.api_endpoint().insert(ApiEndpoint {
        id: next_api_endpoint_id(ctx),
        database_page_id,
        slug,
        display_name,
        description,
        allowed_methods,
        require_auth,
        created_by: ctx.sender(),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
    });

    // Auto-generate field mappings for existing properties on this database.
    let schema = ctx
        .db
        .database_schema()
        .page_id()
        .filter(&database_page_id)
        .next();
    if let Some(schema) = schema {
        let mut props: Vec<PropertyDefinition> = ctx
            .db
            .property_definition()
            .schema_id()
            .filter(&schema.id)
            .collect();
        props.sort_by_key(|p| p.order);

        let mut used_names: Vec<String> = Vec::new();
        for (i, prop) in props.iter().enumerate() {
            let mut field_name = slugify_field_name(&prop.name);
            // Deduplicate: append _2, _3, etc. if name already used
            let base = field_name.clone();
            let mut suffix = 2u32;
            while used_names.contains(&field_name) {
                field_name = format!("{}_{}", base, suffix);
                suffix += 1;
            }
            used_names.push(field_name.clone());

            ctx.db.api_field_mapping().insert(ApiFieldMapping {
                id: next_api_field_mapping_id(ctx),
                endpoint_id: endpoint.id,
                property_definition_id: prop.id,
                field_name,
                required_on_create: false,
                default_value: None,
                read_only: false,
                field_order: i as u32,
            });
        }
    }

    Ok(())
}

/// Update a custom API endpoint's configuration.
#[reducer]
pub fn update_api_endpoint(
    ctx: &ReducerContext,
    endpoint_id: u64,
    slug: String,
    display_name: String,
    description: String,
    allowed_methods: Vec<HttpMethod>,
    require_auth: bool,
) -> Result<(), String> {
    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(&endpoint_id)
        .ok_or("API endpoint not found")?;

    if endpoint.created_by != ctx.sender() {
        return Err("Only the creator can update this endpoint".to_string());
    }

    validate_slug(&slug)?;
    if display_name.trim().is_empty() {
        return Err("Display name cannot be empty".to_string());
    }
    if allowed_methods.is_empty() {
        return Err("At least one HTTP method must be allowed".to_string());
    }

    // If slug changed, check uniqueness
    if slug != endpoint.slug {
        if ctx.db.api_endpoint().slug().find(&slug).is_some() {
            return Err(format!("Slug '{}' is already in use", slug));
        }
    }

    ctx.db.api_endpoint().id().update(ApiEndpoint {
        slug,
        display_name,
        description,
        allowed_methods,
        require_auth,
        updated_at: ctx.timestamp,
        ..endpoint
    });

    Ok(())
}

/// Delete a custom API endpoint and all its field mappings and API keys.
#[reducer]
pub fn delete_api_endpoint(ctx: &ReducerContext, endpoint_id: u64) -> Result<(), String> {
    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(&endpoint_id)
        .ok_or("API endpoint not found")?;

    if endpoint.created_by != ctx.sender() {
        return Err("Only the creator can delete this endpoint".to_string());
    }

    // Remove all field mappings
    let mapping_ids: Vec<u64> = ctx
        .db
        .api_field_mapping()
        .endpoint_id()
        .filter(&endpoint_id)
        .map(|m| m.id)
        .collect();
    for mid in mapping_ids {
        ctx.db.api_field_mapping().id().delete(&mid);
    }

    // Remove all API keys
    let key_ids: Vec<u64> = ctx
        .db
        .api_endpoint_key()
        .endpoint_id()
        .filter(&endpoint_id)
        .map(|k| k.id)
        .collect();
    for kid in key_ids {
        ctx.db.api_endpoint_key().id().delete(&kid);
    }

    ctx.db.api_endpoint().id().delete(&endpoint_id);
    Ok(())
}

/// Add or customize a field mapping on a custom API endpoint.
#[reducer]
pub fn create_api_field_mapping(
    ctx: &ReducerContext,
    endpoint_id: u64,
    property_definition_id: u64,
    field_name: String,
    required_on_create: bool,
    default_value: Option<String>,
    read_only: bool,
) -> Result<(), String> {
    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(&endpoint_id)
        .ok_or("API endpoint not found")?;

    if endpoint.created_by != ctx.sender() {
        return Err("Only the endpoint creator can manage field mappings".to_string());
    }

    validate_field_name(&field_name)?;

    // Verify property definition exists
    ctx.db
        .property_definition()
        .id()
        .find(&property_definition_id)
        .ok_or("Property definition not found")?;

    // Check field name uniqueness within this endpoint
    let name_taken = ctx
        .db
        .api_field_mapping()
        .endpoint_id()
        .filter(&endpoint_id)
        .any(|m| m.field_name == field_name);
    if name_taken {
        return Err(format!(
            "Field name '{}' is already used in this endpoint",
            field_name
        ));
    }

    let max_order = ctx
        .db
        .api_field_mapping()
        .endpoint_id()
        .filter(&endpoint_id)
        .map(|m| m.field_order)
        .max()
        .unwrap_or(0);

    ctx.db.api_field_mapping().insert(ApiFieldMapping {
        id: next_api_field_mapping_id(ctx),
        endpoint_id,
        property_definition_id,
        field_name,
        required_on_create,
        default_value,
        read_only,
        field_order: max_order + 1,
    });

    Ok(())
}

/// Update a field mapping's configuration.
#[reducer]
pub fn update_api_field_mapping(
    ctx: &ReducerContext,
    mapping_id: u64,
    field_name: String,
    required_on_create: bool,
    default_value: Option<String>,
    read_only: bool,
    field_order: u32,
) -> Result<(), String> {
    let mapping = ctx
        .db
        .api_field_mapping()
        .id()
        .find(&mapping_id)
        .ok_or("Field mapping not found")?;

    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(&mapping.endpoint_id)
        .ok_or("API endpoint not found")?;

    if endpoint.created_by != ctx.sender() {
        return Err("Only the endpoint creator can manage field mappings".to_string());
    }

    validate_field_name(&field_name)?;

    // Check field name uniqueness (excluding self)
    let name_taken = ctx
        .db
        .api_field_mapping()
        .endpoint_id()
        .filter(&mapping.endpoint_id)
        .any(|m| m.id != mapping_id && m.field_name == field_name);
    if name_taken {
        return Err(format!(
            "Field name '{}' is already used in this endpoint",
            field_name
        ));
    }

    ctx.db.api_field_mapping().id().update(ApiFieldMapping {
        field_name,
        required_on_create,
        default_value,
        read_only,
        field_order,
        ..mapping
    });

    Ok(())
}

/// Remove a field from the API endpoint.
#[reducer]
pub fn delete_api_field_mapping(ctx: &ReducerContext, mapping_id: u64) -> Result<(), String> {
    let mapping = ctx
        .db
        .api_field_mapping()
        .id()
        .find(&mapping_id)
        .ok_or("Field mapping not found")?;

    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(&mapping.endpoint_id)
        .ok_or("API endpoint not found")?;

    if endpoint.created_by != ctx.sender() {
        return Err("Only the endpoint creator can manage field mappings".to_string());
    }

    ctx.db.api_field_mapping().id().delete(&mapping_id);
    Ok(())
}

/// Register an API key for a custom endpoint.
/// The caller generates the raw key client-side and sends only the SHA-256 hash.
/// The raw key is shown to the user once in the UI and never stored.
#[reducer]
pub fn create_api_endpoint_key(
    ctx: &ReducerContext,
    endpoint_id: u64,
    key_hash: String,
    label: String,
    allowed_methods: Vec<HttpMethod>,
    expires_at: Option<Timestamp>,
) -> Result<(), String> {
    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(&endpoint_id)
        .ok_or("API endpoint not found")?;

    if endpoint.created_by != ctx.sender() {
        return Err("Only the endpoint creator can manage API keys".to_string());
    }

    if label.trim().is_empty() {
        return Err("Key label cannot be empty".to_string());
    }
    if key_hash.len() != 64 || !key_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("key_hash must be a 64-character hex-encoded SHA-256 hash".to_string());
    }
    if allowed_methods.is_empty() {
        return Err("At least one HTTP method must be allowed for the key".to_string());
    }

    // Check for duplicate hash (key reuse)
    let hash_exists = ctx
        .db
        .api_endpoint_key()
        .iter()
        .any(|k| k.key_hash == key_hash);
    if hash_exists {
        return Err("This key hash is already registered".to_string());
    }

    ctx.db.api_endpoint_key().insert(ApiEndpointKey {
        id: next_api_endpoint_key_id(ctx),
        endpoint_id,
        key_hash,
        label,
        allowed_methods,
        created_by: ctx.sender(),
        created_at: ctx.timestamp,
        last_used_at: None,
        expires_at,
    });

    Ok(())
}

/// Revoke (delete) an API key.
#[reducer]
pub fn revoke_api_endpoint_key(ctx: &ReducerContext, key_id: u64) -> Result<(), String> {
    let key = ctx
        .db
        .api_endpoint_key()
        .id()
        .find(&key_id)
        .ok_or("API key not found")?;

    let endpoint = ctx
        .db
        .api_endpoint()
        .id()
        .find(&key.endpoint_id)
        .ok_or("API endpoint not found")?;

    if endpoint.created_by != ctx.sender() {
        return Err("Only the endpoint creator can revoke API keys".to_string());
    }

    ctx.db.api_endpoint_key().id().delete(&key_id);
    Ok(())
}

/// Import a `pear-snapshot-v1` JSON file exported from the Pear web app.
/// Only succeeds when the database has **no pages** (empty workspace). Requires an authenticated user.
/// AI users are restored with **stub** private `AiUserConfig` rows (no API keys); reconfigure after import.
#[reducer]
pub fn import_pear_snapshot_v1(ctx: &ReducerContext, snapshot_json: String) -> Result<(), String> {
    pear_import::apply_snapshot(ctx, &snapshot_json)
}
