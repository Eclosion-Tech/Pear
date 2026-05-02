//! Pear SpacetimeDB module: workspace persistence layer.
//!
//! This crate is split by subsystem (auth, pages, conversations, AI users,
//! harness templates, structural sensors, extensions, custom API endpoints,
//! and the Orcha coordination layer). Each subsystem owns its own tables,
//! reducers, and helpers. Cross-cutting types live in `types`; the three
//! module hooks (`init`, `client_connected`, `client_disconnected`)
//! and the import bridge (`import`) are wired up here.

use spacetimedb::{reducer, ReducerContext, Table};

mod access_control;
mod ai;
mod api_endpoints;
mod auth;
mod automations;
mod conversations;
mod extensions;
mod harness;
mod id_counters;
mod import;
mod migrations;
mod module_install;
mod orcha;
mod pages;
mod sensors;
mod stable_ids;
mod types;

// Re-exports kept at the crate root so the import modules (and other
// historical call sites that addressed everything as `crate::*`) keep
// compiling unchanged.
pub use crate::access_control::{
    block_access_rule, page_access_rule, BlockAccessRule, PageAccessRule,
};
pub use crate::ai::evaluations::{ai_evaluation, AiEvaluation};
pub use crate::ai::memory::{ai_user_memory, AiUserMemory};
pub use crate::ai::{
    ai_user_config, ai_user_profile, AiUserConfig, AiUserProfile, AiUserRole, InferenceProvider,
};
pub use crate::api_endpoints::{
    api_call_log, api_endpoint, api_endpoint_key, api_field_mapping, database_row_marker,
    ApiCallLog, ApiEndpoint, ApiEndpointKey, ApiEndpointKeyLookupRow, ApiFieldMapping,
    DatabaseRowMarker, HttpMethod, PropertyValueInput,
};
pub use crate::auth::{
    user, user_credential, user_preference, User, UserCredential, UserPreference,
};
pub use crate::automations::{
    automation_action, automation_capability, automation_condition, automation_event_queue,
    automation_primitive, automation_rule, automation_run_log, AutomationAction,
    AutomationActionKind, AutomationCapability, AutomationCapabilityKind, AutomationCondition,
    AutomationConditionKind, AutomationEventQueue, AutomationEventStatus, AutomationMode,
    AutomationPrimitive, AutomationPrimitiveKind, AutomationRule, AutomationRunLog,
    AutomationScheduleKind, AutomationTriggerKind,
};
pub use crate::conversations::ConversationVisibility;
pub use crate::conversations::{
    conversation, conversation_message, conversation_participant, Conversation,
    ConversationMessage, ConversationParticipant, ConversationStatus, MessageSender, MessageStatus,
    ParticipantRole,
};
pub use crate::extensions::{
    extension_manifest, extension_mcp_server, extension_permission, installed_extension,
    tool_call_audit_log, AuthScheme, ExtensionManifest, ExtensionMcpServer, ExtensionPermission,
    ExtensionType, InstallStatus, InstalledExtension, PermissionAction, PermissionScope,
    ToolCallAuditLog,
};
pub use crate::harness::{
    auto_apply_binding, harness_template, review_agent_binding, review_annotation,
    AutoApplyBinding, HarnessTemplate, ReviewAgentBinding, ReviewAnnotation,
};
pub use crate::harness::{
    AutoApplyContext, HarnessTemplateSource, ReviewMode, ReviewSeverity, ReviewSubject,
};
pub use crate::id_counters::{id_counter, IdCounter};
pub use crate::migrations::{migration_state, MigrationState};
pub use crate::module_install::{module_install_meta, ModuleInstallMeta};
pub use crate::orcha::{
    orcha_agent, orcha_job, orcha_shared_context, orcha_task, orcha_usage_event, OrchaAgent,
    OrchaJob, OrchaSharedContext, OrchaTask, OrchaUsageEvent,
};
pub use crate::pages::schemas::{
    database_schema, page_property_value, page_property_value_history, property_definition,
    AiPrimitive, AiPropertyValue, DatabaseSchema, InvalidationPolicy, PagePropertyValue,
    PagePropertyValueHistory, PropertyDefinition, PropertyType, PropertyValue,
};
pub use crate::pages::snapshots::{page_snapshot, PageSnapshot, SnapshotType};
pub use crate::pages::views::{database_view, DatabaseView, ViewType};
pub use crate::pages::{
    attachment, page, page_content, page_yjs_state, Attachment, Page, PageContent, PageType,
    PageYjsState,
};
pub use crate::sensors::{
    sensor_registry, structural_sensor_finding, SensorRegistry, StructuralSensorFinding,
};
pub use crate::types::{ActorType, Permission, Principal};

use crate::auth::{extract_oidc_profile, workspace_has_no_admin};
use crate::automations::seed_automation_primitives_inner;
use crate::extensions::seed_builtin_extensions_inner;
use crate::module_install::ensure_publisher_identity_recorded;
use crate::sensors::seed_sensor_registry_inner;

// ============================================================
// Module hooks (SpacetimeDB reducer entry points)
// ============================================================

#[reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ensure_publisher_identity_recorded(ctx);
    seed_builtin_extensions_inner(ctx);
    seed_sensor_registry_inner(ctx);
    seed_automation_primitives_inner(ctx);
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

    // Bootstrap: the first authenticated user on a fresh database is
    // auto-promoted to admin. We compute this once before the User row is
    // inserted/updated so the new row itself can be the bootstrap.
    let needs_bootstrap_admin = via_oidc && workspace_has_no_admin(ctx);

    if let Some(existing) = ctx.db.user().identity().find(identity) {
        ctx.db.user().identity().update(User {
            email: if email.is_empty() {
                existing.email.clone()
            } else {
                email
            },
            name: if name.is_empty() {
                existing.name.clone()
            } else {
                name
            },
            is_authenticated: existing.is_authenticated || via_oidc,
            is_admin: existing.is_admin || needs_bootstrap_admin,
            last_seen_at: ctx.timestamp,
            ..existing
        });
    } else {
        ctx.db.user().insert(User {
            identity,
            name,
            email,
            is_authenticated: via_oidc,
            is_admin: needs_bootstrap_admin,
            created_at: ctx.timestamp,
            last_seen_at: ctx.timestamp,
        });
    }
}

#[reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    let identity = ctx.sender();
    if let Some(existing) = ctx.db.user().identity().find(identity) {
        ctx.db.user().identity().update(User {
            last_seen_at: ctx.timestamp,
            ..existing
        });
    }
}
