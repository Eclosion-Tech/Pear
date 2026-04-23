//! AI users: configuration, public profile, and the reducers that
//! create / update / delete them. Module owners (the workspace admin
//! Identity used by lifecycle/worker for orchestration) bypass RLS and
//! can see every row.

use spacetimedb::{
    client_visibility_filter, reducer, table, Filter, Identity, ReducerContext, SpacetimeType,
    Table, Timestamp,
};

use crate::access_control::helpers::require_creator_or_admin;
use crate::id_counters::alloc_id;

pub(crate) fn next_ai_user_config_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "ai_user_config", || {
        ctx.db.ai_user_config().iter().map(|r| r.id).max().unwrap_or(0)
    })
}

pub(crate) mod evaluations;
pub(crate) mod memory;
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum InferenceProvider {
    Anthropic,
    OpenAI,
    Ollama,
    OpenAICompatible,
}

/// AI user inference configuration. Public table guarded by an RLS rule
/// (`AI_USER_CONFIG_FILTER` below) that exposes each row only to the matching
/// AI user identity. The worker connects as the AI user and reads its own row;
/// no other client (including the human creator) can see this row.
///
/// Module owners (the workspace admin Identity used by lifecycle/worker for
/// orchestration) bypass RLS and can see every row — that's how the worker
/// can also inventory configs when needed.
#[table(accessor = ai_user_config, public)]
pub struct AiUserConfig {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// SpacetimeDB Identity owned by this AI user. Minted by lifecycle and
    /// stored in pear-cloud's Postgres alongside the corresponding token.
    /// This is the field RLS keys on.
    #[unique]
    pub identity: Identity,
    /// The human who created this AI user. Workspace owners/admins inherit
    /// management rights via lifecycle's Postgres-side authz.
    pub created_by: Identity,
    pub provider: InferenceProvider,
    pub model: String,
    /// Required for Ollama / OpenAICompatible providers.
    pub endpoint: Option<String>,
    /// Per-AI-user secret. Visible only to the matching identity (and module
    /// owner). Never echoed back via web or worker code paths.
    pub api_key: Option<String>,
    pub system_prompt: Option<String>,
    pub max_tokens: u32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// Soft + hard budget cap per calendar month, in token units (input +
    /// output). `None` = unlimited. The Orcha scheduler refuses to claim
    /// new tasks for this AI user once the running 30d total reaches this
    /// number; a UI warning fires at 80%.
    ///
    /// Must remain last for schema migration (STDB only allows additive
    /// changes at the end of a struct).
    #[default(None::<u64>)]
    pub monthly_token_cap: Option<u64>,
    /// Distinguishes regular AI users from review agents. Review agents
    /// run between proposed mutation and human diff surface and produce
    /// structured annotations rather than direct edits.
    #[default(AiUserRole::Standard)]
    pub role: AiUserRole,
    /// Optional `HarnessTemplate.id` this AI user was provisioned from.
    /// Lets the UI offer "reset to template" and lets the harness layer
    /// surface drift between configured behavior and the template's
    /// recommendations. `None` for hand-rolled AI users.
    #[default(None::<u64>)]
    pub harness_template_id: Option<u64>,
    /// Per-AI-user opt-in flag: when `true`, evaluations from this AI user
    /// that use a non-sensitive primitive (currently `Classify`,
    /// `Summarize`, `Sentiment`, `Translate` — never `Extract`) MAY be
    /// surfaced to *any* external evaluation cache, index, or
    /// federation that happens to be wired in. Pear core does nothing
    /// with this flag itself; it is a generic authority gate that
    /// downstream consumers (federation services, hosted caches,
    /// research mirrors, internal cost-pooling tooling, etc.) check
    /// before reading rows.
    ///
    /// Cache key shape (`sha256(primitive + inputs + model +
    /// prompt_version)`) is intentionally portable so it can be used by
    /// anyone running such a service. Defaults to `false`.
    ///
    /// Must remain last for schema migration (STDB only allows additive
    /// changes at the end of a struct).
    #[default(false)]
    pub allow_evaluation_sharing: bool,
}

/// Distinguishes ordinary "do work" AI users from "review work" AI users.
///
/// Review agents are scheduled by the harness between a proposed mutation
/// and the human diff surface; their output is structured annotations
/// (Pass / Warn / Fail + comment) attached to the corresponding
/// `PostAgentEdit` snapshot, not direct edits to the page.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AiUserRole {
    Standard,
    Reviewer,
}

/// Row-level visibility filter for `ai_user_config`. Each AI user sees only
/// its own row; module owners (workspace admin / worker) bypass this filter.
#[client_visibility_filter]
const AI_USER_CONFIG_FILTER: Filter = Filter::Sql(
    "SELECT * FROM ai_user_config WHERE identity = :sender",
);

/// Public projection of an AI user — display info only, no credentials.
/// Clients subscribe to this table for @mention autocomplete, avatars, etc.
/// `has_api_key` is the only signal exposed to the human creator about the
/// state of the AI user's secret.
#[table(accessor = ai_user_profile, public)]
pub struct AiUserProfile {
    #[primary_key]
    pub ai_user_id: u64,
    /// Mirrors `AiUserConfig.identity` so clients can resolve
    /// `MessageSender::User(identity)` back to a profile without server help.
    #[unique]
    pub identity: Identity,
    pub display_name: String,
    pub avatar_url: Option<String>,
    /// Human-readable provider name (e.g. "Anthropic", "OpenAI").
    pub provider_name: String,
    pub model_name: String,
    /// Public indicator that an api_key is currently configured. Updated in
    /// lockstep with `set_ai_user_api_key`. Never reveals the key itself.
    pub has_api_key: bool,
    pub created_by: Identity,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// Mirrored from `ai_user_config.system_prompt` so human clients can read
    /// and edit instructions without subscribing to the RLS-guarded config row.
    #[default(None::<String>)]
    pub system_prompt: Option<String>,
}


// ============================================================
// AI User Reducers
// ============================================================

pub(crate) fn provider_display_name(provider: &InferenceProvider) -> &'static str {
    match provider {
        InferenceProvider::Anthropic => "Anthropic",
        InferenceProvider::OpenAI => "OpenAI",
        InferenceProvider::Ollama => "Ollama",
        InferenceProvider::OpenAICompatible => "OpenAI Compatible",
    }
}

/// Create an AI user with its inference configuration and public profile.
///
/// All authz lives in lifecycle (workspace member check + Syntropy session).
/// Lifecycle mints a fresh SpacetimeDB Identity for the AI user, persists the
/// token in its Postgres, and calls this reducer with a workspace admin token.
/// The reducer trusts the supplied identity params; the only protection
/// against spoofing is that lifecycle is the sole holder of the admin token.
#[reducer]
pub fn create_ai_user(
    ctx: &ReducerContext,
    ai_user_identity: Identity,
    created_by_identity: Identity,
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
        && endpoint.as_ref().is_none_or(|e| e.trim().is_empty())
    {
        return Err("Endpoint is required for Ollama and OpenAI Compatible providers".to_string());
    }
    if ai_user_identity == Identity::ZERO {
        return Err("ai_user_identity must be a non-zero Identity".to_string());
    }
    if created_by_identity == Identity::ZERO {
        return Err("created_by_identity must be a non-zero Identity".to_string());
    }

    let prov_name = provider_display_name(&provider).to_string();
    let model_name = model.trim().to_string();
    let has_api_key = api_key.is_some();
    let system_prompt_for_profile = system_prompt.clone();

    let config = ctx.db.ai_user_config().insert(AiUserConfig {
        id: next_ai_user_config_id(ctx),
        identity: ai_user_identity,
        created_by: created_by_identity,
        provider,
        model: model_name.clone(),
        endpoint,
        api_key,
        system_prompt,
        max_tokens: max_tokens.unwrap_or(8192),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        monthly_token_cap: None,
        role: AiUserRole::Standard,
        harness_template_id: None,
        allow_evaluation_sharing: false,
    });

    ctx.db.ai_user_profile().insert(AiUserProfile {
        ai_user_id: config.id,
        identity: ai_user_identity,
        display_name,
        avatar_url,
        provider_name: prov_name,
        model_name,
        has_api_key,
        created_by: created_by_identity,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        system_prompt: system_prompt_for_profile,
    });

    log::info!(
        "AI user created: id={}, identity={}",
        config.id,
        ai_user_identity
    );
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
        .find(ai_user_id)
        .ok_or("AI user not found")?;
    ctx.db.ai_user_profile().ai_user_id().update(AiUserProfile {
        display_name,
        avatar_url,
        updated_at: ctx.timestamp,
        ..profile
    });
    Ok(())
}

/// Set or clear the per-AI-user system prompt only. Creator or workspace admin.
#[reducer]
pub fn update_ai_user_system_prompt(
    ctx: &ReducerContext,
    ai_user_id: u64,
    system_prompt: Option<String>,
) -> Result<(), String> {
    let cfg = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or_else(|| "AI user config not found".to_string())?;
    require_creator_or_admin(ctx, cfg.created_by, "update AI user system prompt")?;
    let system_prompt_for_profile = system_prompt.clone();
    ctx.db.ai_user_config().id().update(AiUserConfig {
        system_prompt,
        updated_at: ctx.timestamp,
        ..cfg
    });
    if let Some(profile) = ctx.db.ai_user_profile().ai_user_id().find(ai_user_id) {
        ctx.db.ai_user_profile().ai_user_id().update(AiUserProfile {
            system_prompt: system_prompt_for_profile,
            updated_at: ctx.timestamp,
            ..profile
        });
    }
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
        && endpoint.as_ref().is_none_or(|e| e.trim().is_empty())
    {
        return Err("Endpoint is required for Ollama and OpenAI Compatible providers".to_string());
    }

    let config = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user config not found")?;

    let prov_name = provider_display_name(&provider).to_string();
    let model_name = model.trim().to_string();
    let system_prompt_for_profile = system_prompt.clone();

    ctx.db.ai_user_config().id().update(AiUserConfig {
        provider,
        model: model_name.clone(),
        endpoint,
        system_prompt,
        max_tokens: max_tokens.unwrap_or(config.max_tokens),
        updated_at: ctx.timestamp,
        ..config
    });

    if let Some(profile) = ctx.db.ai_user_profile().ai_user_id().find(ai_user_id) {
        ctx.db.ai_user_profile().ai_user_id().update(AiUserProfile {
            provider_name: prov_name,
            model_name,
            system_prompt: system_prompt_for_profile,
            updated_at: ctx.timestamp,
            ..profile
        });
    }

    Ok(())
}

/// Set or clear the API key for an AI user. Separated from update_ai_user_config
/// so callers can update config without re-submitting the key. Lifecycle gates
/// access; the key itself is never read back through any client subscription
/// path (RLS on `ai_user_config` ensures only the AI user identity can see it).
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
        .find(ai_user_id)
        .ok_or("AI user config not found")?;
    let has_api_key = api_key.is_some();
    ctx.db.ai_user_config().id().update(AiUserConfig {
        api_key,
        updated_at: ctx.timestamp,
        ..config
    });
    if let Some(profile) = ctx.db.ai_user_profile().ai_user_id().find(ai_user_id) {
        ctx.db.ai_user_profile().ai_user_id().update(AiUserProfile {
            has_api_key,
            updated_at: ctx.timestamp,
            ..profile
        });
    }
    Ok(())
}

/// Delete an AI user and its configuration. Removes both the private config
/// and the public profile.
#[reducer]
pub fn delete_ai_user(ctx: &ReducerContext, ai_user_id: u64) -> Result<(), String> {
    ctx.db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user not found")?;
    ctx.db.ai_user_config().id().delete(ai_user_id);
    ctx.db.ai_user_profile().ai_user_id().delete(ai_user_id);
    log::info!("AI user deleted: id={}", ai_user_id);
    Ok(())
}

/// Toggle the generic "evaluations from this AI user may be shared with
/// external caches / indexes" opt-in. Pear core does nothing with the
/// flag; it is purely an authority gate that downstream services check
/// before reading rows. Creator/admin gated.
#[reducer]
pub fn set_allow_evaluation_sharing(
    ctx: &ReducerContext,
    ai_user_id: u64,
    allow: bool,
) -> Result<(), String> {
    let cfg = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user not found")?;
    require_creator_or_admin(ctx, cfg.created_by, "toggle allow_evaluation_sharing")?;
    ctx.db.ai_user_config().id().update(AiUserConfig {
        allow_evaluation_sharing: allow,
        updated_at: ctx.timestamp,
        ..cfg
    });
    Ok(())
}

