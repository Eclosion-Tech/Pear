//! Extensions: published manifests, installed instances, MCP server
//! registrations, per-install permission grants, and the immutable
//! tool-call audit log.

use spacetimedb::{reducer, table, Identity, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::id_counters::alloc_id;

pub(crate) mod manifest;
pub(crate) mod reducers;

pub(crate) fn next_extension_manifest_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "extension_manifest", || {
        ctx.db.extension_manifest().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_installed_extension_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "installed_extension", || {
        ctx.db.installed_extension().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_extension_mcp_server_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "extension_mcp_server", || {
        ctx.db.extension_mcp_server().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_extension_permission_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "extension_permission", || {
        ctx.db.extension_permission().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) fn next_tool_call_audit_log_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "tool_call_audit_log", || {
        ctx.db.tool_call_audit_log().iter().map(|r| r.id).max().unwrap_or(0)
    })
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


const PEAR_WORKSPACE_TOOLS_MANIFEST: &str = r#"{
  "builtin": {
    "tools": [
      "get_context", "web_search", "fetch_url",
      "create_page", "update_page_content", "update_page_title",
      "search_pages", "list_child_pages", "get_page",
      "get_schema_id", "list_properties", "add_property",
      "create_row", "set_property_value", "set_property_values"
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
pub(crate) fn seed_builtin_extensions_inner(ctx: &ReducerContext) {
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

/// Seed the pear-workspace-tools built-in extension for databases that were created
/// before this feature shipped. Safe to call multiple times — no-op if already seeded.
#[reducer]
pub fn seed_builtin_extensions(ctx: &ReducerContext) -> Result<(), String> {
    seed_builtin_extensions_inner(ctx);
    Ok(())
}
