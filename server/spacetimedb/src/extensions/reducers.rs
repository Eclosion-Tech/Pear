//! Extension publish/install/grant/audit reducers. Cross-workspace
//! isolation is enforced via `installed_by` Identity in private tables.

use spacetimedb::{reducer, Identity, ReducerContext, Table};

use crate::extensions::manifest::{
    all_requested_permissions, create_extension_ai_user, create_extension_mcp_server,
    create_extension_permissions, has_credential_fields, has_sensitive_request,
    has_wildcard_domains, ManifestDoc, ManifestPermission,
};
use crate::ai::{ai_user_config, ai_user_profile};
use crate::extensions::{
    extension_manifest, extension_mcp_server, extension_permission, installed_extension,
    next_extension_manifest_id, next_extension_permission_id, next_installed_extension_id,
    next_tool_call_audit_log_id, tool_call_audit_log, ExtensionManifest, ExtensionMcpServer,
    ExtensionPermission, ExtensionType, InstallStatus, InstalledExtension, PermissionAction,
    PermissionScope, ToolCallAuditLog,
};
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
    // ai_user_identity is required when the manifest's extension_type is
    // ConfigBundle or Hybrid. Lifecycle (pear-cloud) mints this Identity per
    // install; self-hosted Pear callers must supply one minted via the
    // SpacetimeDB HTTP identity API.
    ai_user_identity: Option<Identity>,
) -> Result<(), String> {
    let manifest_row = ctx
        .db
        .extension_manifest()
        .id()
        .find(manifest_id)
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
        let ident = ai_user_identity.ok_or(
            "ai_user_identity is required for ConfigBundle/Hybrid extensions",
        )?;
        ai_user_id = Some(create_extension_ai_user(
            ctx,
            ctx.sender(),
            ident,
            cb,
            ai_api_key,
        )?);
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
    // ai_user_identity is required when the manifest's extension_type is
    // ConfigBundle or Hybrid. See `install_extension` for the rationale.
    ai_user_identity: Option<Identity>,
) -> Result<(), String> {
    let installed = ctx
        .db
        .installed_extension()
        .id()
        .find(installed_extension_id)
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
        .find(installed.manifest_id)
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
        let ident = ai_user_identity.ok_or(
            "ai_user_identity is required for ConfigBundle/Hybrid extensions",
        )?;
        ai_user_id = Some(create_extension_ai_user(
            ctx,
            ctx.sender(),
            ident,
            cb,
            ai_api_key,
        )?);
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
        .find(installed_extension_id)
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
        .delete(installed_extension_id);
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
        .find(installed_extension_id)
        .ok_or("InstalledExtension not found")?;

    if installed.installed_by != ctx.sender() {
        return Err("Only the installer can uninstall an extension".to_string());
    }

    // Remove AiUserConfig + AiUserProfile if present
    if let Some(ai_id) = installed.ai_user_id {
        ctx.db.ai_user_config().id().delete(ai_id);
        ctx.db.ai_user_profile().ai_user_id().delete(ai_id);
    }

    // Remove ExtensionMcpServer if present
    if let Some(server_id) = installed.mcp_server_id {
        ctx.db.extension_mcp_server().id().delete(server_id);
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
        ctx.db.extension_permission().id().delete(pid);
    }

    ctx.db
        .installed_extension()
        .id()
        .delete(installed_extension_id);

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
        .find(installed_extension_id)
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
        if let Some(server) = ctx.db.extension_mcp_server().id().find(server_id) {
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
        .find(installed_extension_id)
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
        .find(permission_id)
        .ok_or("ExtensionPermission not found")?;

    let installed = ctx
        .db
        .installed_extension()
        .id()
        .find(perm.installed_extension_id)
        .ok_or("InstalledExtension not found")?;

    if installed.installed_by != ctx.sender() {
        return Err("Only the installer can revoke permissions".to_string());
    }

    ctx.db.extension_permission().id().delete(permission_id);
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
        .find(mcp_server_id)
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
        .find(installed_extension_id)
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
        .find(new_manifest_id)
        .ok_or("New ExtensionManifest not found")?;

    let old_manifest = ctx
        .db
        .extension_manifest()
        .id()
        .find(installed.manifest_id)
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

