//! Manifest parsing helpers shared by the extension install path. Pure
//! functions over the JSON `manifest_json` plus the create-row helpers
//! they call into.

use serde::Deserialize;
use spacetimedb::{Identity, ReducerContext, Table};

use crate::ai::{
    ai_user_config, ai_user_profile, next_ai_user_config_id, provider_display_name, AiUserConfig,
    AiUserProfile, AiUserRole, InferenceProvider,
};
use crate::extensions::{
    extension_mcp_server, extension_permission, next_extension_mcp_server_id,
    next_extension_permission_id, AuthScheme, ExtensionMcpServer, ExtensionPermission,
    PermissionAction, PermissionScope,
};
// ============================================================
// Extensions — Manifest Parsing
// ============================================================

#[derive(Deserialize, Clone, Debug, Default)]
pub(crate) struct ManifestPermission {
    scope: String,
    action: String,
    #[serde(default)]
    allowed_domains: Option<Vec<String>>,
}

#[derive(Deserialize, Debug, Default)]
pub(crate) struct ManifestConfigBundle {
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
pub(crate) struct ManifestMcpServer {
    #[serde(default)]
    pub(crate) endpoint: String,
    #[serde(default)]
    pub(crate) auth_scheme: String,
    #[serde(default)]
    pub(crate) requested_capabilities: Vec<String>,
    #[serde(default)]
    pub(crate) requested_permissions: Vec<ManifestPermission>,
}

#[derive(Deserialize, Debug, Default)]
pub(crate) struct ManifestBuiltin {
    /// Tool names — for display/documentation only; not used server-side.
    #[serde(default)]
    #[allow(dead_code)]
    tools: Vec<String>,
    #[serde(default)]
    requested_permissions: Vec<ManifestPermission>,
}

#[derive(Deserialize, Debug)]
pub(crate) struct ManifestDoc {
    #[serde(default)]
    pub(crate) config_bundle: Option<ManifestConfigBundle>,
    #[serde(default)]
    pub(crate) mcp_server: Option<ManifestMcpServer>,
    #[serde(default)]
    pub(crate) builtin: Option<ManifestBuiltin>,
}

/// Capabilities that require explicit human confirmation (PendingConfirmation path).
const SENSITIVE_CAPABILITIES: &[&str] = &[
    "tool-bash",
    "tool-http",
    "tool-spawn-job",
    "tool-property-write",
    "domain-casefloat-intake",
];

pub(crate) fn parse_permission_scope(s: &str) -> Result<PermissionScope, String> {
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
    } else if let Some(id_str) = s.strip_prefix("bridge-device:") {
        let id = id_str
            .parse::<u64>()
            .map_err(|_| format!("Invalid bridge device id: {id_str}"))?;
        Ok(PermissionScope::BridgeDevice(id))
    } else {
        Err(format!("Unknown permission scope: {s}"))
    }
}

pub(crate) fn parse_permission_action(s: &str) -> Result<PermissionAction, String> {
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

pub(crate) fn parse_auth_scheme(s: &str) -> Result<AuthScheme, String> {
    match s.to_lowercase().as_str() {
        "none" | "" => Ok(AuthScheme::None),
        "api_key" | "apikey" => Ok(AuthScheme::ApiKey),
        "oauth" => Ok(AuthScheme::OAuth),
        _ => Err(format!("Unknown auth scheme: {s}")),
    }
}

pub(crate) fn all_requested_capabilities(manifest: &ManifestDoc) -> Vec<String> {
    let mut caps = Vec::new();
    if let Some(cb) = &manifest.config_bundle {
        caps.extend(cb.requested_capabilities.iter().cloned());
    }
    if let Some(ms) = &manifest.mcp_server {
        caps.extend(ms.requested_capabilities.iter().cloned());
    }
    caps
}

pub(crate) fn all_requested_permissions(manifest: &ManifestDoc) -> Vec<ManifestPermission> {
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
pub(crate) fn has_sensitive_request(manifest: &ManifestDoc) -> bool {
    let caps = all_requested_capabilities(manifest);
    if caps
        .iter()
        .any(|c| SENSITIVE_CAPABILITIES.contains(&c.as_str()))
    {
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
pub(crate) fn has_credential_fields(json: &str) -> bool {
    // Check for credential keys as JSON object keys (key followed by colon)
    [
        "\"api_key\":",
        "\"secret\":",
        "\"password\":",
        "\"private_key\":",
    ]
    .iter()
    .any(|pattern| json.contains(pattern))
}

/// Check that no permission in the list uses a wildcard domain for HttpOutbound.
pub(crate) fn has_wildcard_domains(permissions: &[ManifestPermission]) -> bool {
    permissions.iter().any(|p| {
        p.allowed_domains
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|d| d.contains('*'))
    })
}

/// Create ExtensionPermission rows from a list of parsed permissions.
pub(crate) fn create_extension_permissions(
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
                return Err(
                    "HttpOutbound permission requires at least one allowed_domain".to_string(),
                );
            }
            Some(serde_json::to_string(domains).unwrap_or_else(|_| "[]".to_string()))
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
///
/// `ai_user_identity` must be a freshly minted SpacetimeDB Identity for the new
/// AI user (some hosts mint this when installing; others require the
/// extension-install caller to supply one). It's the field RLS keys on for
/// reading the per-AI-user api_key.
pub(crate) fn create_extension_ai_user(
    ctx: &ReducerContext,
    installed_by: Identity,
    ai_user_identity: Identity,
    cb: &ManifestConfigBundle,
    ai_api_key: Option<String>,
) -> Result<u64, String> {
    if ai_user_identity == Identity::ZERO {
        return Err("ai_user_identity must be a non-zero Identity".to_string());
    }
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
    let has_api_key = ai_api_key.is_some();
    let config_row = ctx.db.ai_user_config().insert(AiUserConfig {
        id: next_ai_user_config_id(ctx),
        identity: ai_user_identity,
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
        max_tokens: if cb.max_tokens == 0 {
            8192
        } else {
            cb.max_tokens
        },
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        monthly_token_cap: None,
        role: AiUserRole::Standard,
        harness_template_id: None,
        allow_evaluation_sharing: false,
        tool_secrets_json: None,
        worker_token: None,
        inference_backend_json: None,
    });
    ctx.db.ai_user_profile().insert(AiUserProfile {
        ai_user_id: config_row.id,
        identity: ai_user_identity,
        display_name: cb.display_name.clone(),
        avatar_url: cb.avatar_url.clone(),
        provider_name,
        model_name: model,
        has_api_key,
        created_by: installed_by,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        system_prompt: config_row.system_prompt,
    });
    Ok(config_row.id)
}

/// Create an ExtensionMcpServer row. Returns the new server id.
pub(crate) fn create_extension_mcp_server(
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
