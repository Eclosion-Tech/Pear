//! AI users: configuration, public profile, and the reducers that
//! create / update / delete them. The module publisher identity (see
//! [`crate::module_install::ModuleInstallMeta`]) bypasses `ai_user_config` RLS
//! the same way as in other SpacetimeDB deployments.

use spacetimedb::{
    client_visibility_filter, reducer, table, Filter, Identity, ReducerContext, SpacetimeType,
    Table, Timestamp,
};

use crate::access_control::helpers::require_creator_or_admin;
use crate::id_counters::alloc_id;
use serde_json::Value;

pub(crate) fn next_ai_user_config_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "ai_user_config", || {
        ctx.db
            .ai_user_config()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) mod evaluations;
pub(crate) mod memory;
pub(crate) mod routines;
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum InferenceProvider {
    Anthropic,
    OpenAI,
    Ollama,
    OpenAICompatible,
}

/// AI user inference configuration. Public table guarded by an RLS rule
/// (`AI_USER_CONFIG_FILTER` below) that exposes each row only to the matching
/// AI user identity. Other clients (including the human who created the AI
/// user) do not receive this row over subscriptions.
///
/// The module publisher identity bypasses this filter (SpacetimeDB host
/// behavior), which tooling such as workers or HTTP gateways rely on.
#[table(accessor = ai_user_config, public)]
pub struct AiUserConfig {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// SpacetimeDB identity for this AI user (distinct from human members).
    /// RLS on this table keys off this column.
    #[unique]
    pub identity: Identity,
    /// The workspace member identity that created this AI user. Reducers use
    /// this with [`crate::access_control::helpers::require_creator_or_admin`].
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
    /// Opaque JSON for per-tool settings (e.g. `{"serperApiKey":"…"}` for
    /// web search). Like `api_key`, only the AI user identity and module
    /// publisher see the raw value. Use `set_ai_user_tool_secrets_json`.
    #[default(None::<String>)]
    pub tool_secrets_json: Option<String>,
    /// SpacetimeDB JWT that authenticates *as this AI user's identity*, stored
    /// so the worker can spawn an `AiUserWorker` that connects as the AI user
    /// (required for `MessageSender::User(<ai>)` on conversation reducers).
    ///
    /// Self-hosted Pear mints this in the web client and writes it here via
    /// `set_ai_user_worker_token`; pear-cloud's lifecycle stores it out-of-band
    /// and may also write it here. Same visibility as `api_key` (publisher +
    /// the AI user's own identity only) — never echoed to other members.
    #[default(None::<String>)]
    pub worker_token: Option<String>,
    /// Optional inference-backend binding overriding the cloud `provider` /
    /// `api_key` transport. JSON:
    /// `{"mode":"bridge","device_id":1,"provider":"claude-code","model":"…"}`.
    /// `None` (or `mode:"cloud-api"`) = existing behavior. When bound to a
    /// bridge device, the worker routes this AI user's completions through
    /// `enqueue_bridge_inference` on that device — the device must also GRANT
    /// this AI user (`BridgeDeviceGrant`, enforced at enqueue). Offline device
    /// = explicit turn error, never a silent fallback to the cloud path.
    /// Set via `set_ai_user_inference_backend`.
    ///
    /// Must remain last for schema migration (STDB only allows additive
    /// changes at the end of a struct).
    #[default(None::<String>)]
    pub inference_backend_json: Option<String>,
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
/// its own row; the module publisher bypasses this filter.
#[client_visibility_filter]
const AI_USER_CONFIG_FILTER: Filter =
    Filter::Sql("SELECT * FROM ai_user_config WHERE identity = :sender");

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
    /// Mirrored from `ai_user_config.inference_backend_json` (same reason: the
    /// RLS-guarded config row is invisible to humans). No secrets — device id,
    /// provider, model, optional cwd — but visible workspace-wide like the
    /// rest of the profile. Kept in sync by `set_ai_user_inference_backend`.
    ///
    /// Must remain last for schema migration (STDB only allows additive
    /// changes at the end of a struct).
    #[default(None::<String>)]
    pub inference_backend_json: Option<String>,
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

/// Provider name written to the public profile. Well-known OpenAI-compatible
/// aggregators get their own display name so the settings UI can show (and
/// map back to) the right preset — the enum stays unchanged.
pub(crate) fn provider_profile_name(
    provider: &InferenceProvider,
    endpoint: Option<&str>,
) -> String {
    if matches!(provider, InferenceProvider::OpenAICompatible) {
        if endpoint.is_some_and(|e| e.contains("openrouter.ai")) {
            return "OpenRouter".to_string();
        }
        if endpoint.is_some_and(|e| e.contains("api.meta.ai")) {
            return "Meta".to_string();
        }
    }
    provider_display_name(provider).to_string()
}

/// Create an AI user with its inference configuration and public profile.
///
/// Callers supply `ai_user_identity` and `created_by_identity` explicitly.
/// Deployments that mint AI identities out-of-band (separate credential store,
/// HTTP gateway, etc.) typically invoke this reducer with the **module publisher**
/// credential so clients cannot forge arbitrary identity pairs.
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
    if matches!(
        provider,
        InferenceProvider::Ollama | InferenceProvider::OpenAICompatible
    ) && endpoint.as_ref().is_none_or(|e| e.trim().is_empty())
    {
        return Err("Endpoint is required for Ollama and OpenAI Compatible providers".to_string());
    }
    if ai_user_identity == Identity::ZERO {
        return Err("ai_user_identity must be a non-zero Identity".to_string());
    }
    if created_by_identity == Identity::ZERO {
        return Err("created_by_identity must be a non-zero Identity".to_string());
    }

    let prov_name = provider_profile_name(&provider, endpoint.as_deref());
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
        tool_secrets_json: None,
        worker_token: None,
        inference_backend_json: None,
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
        inference_backend_json: None,
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

/// Set or clear the per-AI-user system prompt only. Authorized like other
/// `created_by`-gated AI user mutators (creator, workspace admin, or module
/// publisher).
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
/// `set_ai_user_api_key` for that — and does NOT touch the inference-backend
/// binding: while a binding is live this edits the *dormant* cloud config, so
/// the profile's provider/model display is left on the active backend (see
/// `set_ai_user_inference_backend`). Clear the binding to switch to cloud.
///
/// Intentionally has no `require_creator_or_admin` guard: some deployments
/// restrict who may call reducers entirely at the HTTP/API layer.
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
    if matches!(
        provider,
        InferenceProvider::Ollama | InferenceProvider::OpenAICompatible
    ) && endpoint.as_ref().is_none_or(|e| e.trim().is_empty())
    {
        return Err("Endpoint is required for Ollama and OpenAI Compatible providers".to_string());
    }

    let config = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user config not found")?;

    let prov_name = provider_profile_name(&provider, endpoint.as_deref());
    let model_name = model.trim().to_string();
    let system_prompt_for_profile = system_prompt.clone();
    let binding_live = config.inference_backend_json.is_some();

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
        if binding_live {
            // A bridge/harness binding is live: only the dormant cloud config
            // changed, so the profile keeps displaying the ACTIVE backend's
            // provider/model (invariant of `set_ai_user_inference_backend`).
            ctx.db.ai_user_profile().ai_user_id().update(AiUserProfile {
                system_prompt: system_prompt_for_profile,
                updated_at: ctx.timestamp,
                ..profile
            });
        } else {
            ctx.db.ai_user_profile().ai_user_id().update(AiUserProfile {
                provider_name: prov_name,
                model_name,
                system_prompt: system_prompt_for_profile,
                updated_at: ctx.timestamp,
                ..profile
            });
        }
    }

    Ok(())
}

/// Change only the default model for an AI user, preserving the provider, key,
/// endpoint, and max tokens. The chosen model must be reachable by the existing
/// key (same provider family). Mirrors the new model to the public profile.
///
/// Unguarded at the reducer level like the other AI-user config updates;
/// deployments restrict callers at the HTTP/API layer.
#[reducer]
pub fn set_ai_user_model(
    ctx: &ReducerContext,
    ai_user_id: u64,
    model: String,
) -> Result<(), String> {
    let model_name = model.trim().to_string();
    if model_name.is_empty() {
        return Err("Model is required".to_string());
    }
    let config = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user config not found")?;
    let binding_live = config.inference_backend_json.is_some();
    ctx.db.ai_user_config().id().update(AiUserConfig {
        model: model_name.clone(),
        updated_at: ctx.timestamp,
        ..config
    });
    // While a binding is live only the dormant cloud model changed; the
    // profile keeps displaying the ACTIVE backend's model (invariant of
    // `set_ai_user_inference_backend`).
    if !binding_live {
        if let Some(profile) = ctx.db.ai_user_profile().ai_user_id().find(ai_user_id) {
            ctx.db.ai_user_profile().ai_user_id().update(AiUserProfile {
                model_name,
                updated_at: ctx.timestamp,
                ..profile
            });
        }
    }
    Ok(())
}

/// Set or clear the API key for an AI user. Separated from `update_ai_user_config`
/// so callers can update config without re-submitting the key. The secret is not
/// exposed on subscriptions (RLS on `ai_user_config` limits visibility to the AI
/// user's own identity and the module publisher).
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

/// Store (or clear) the SpacetimeDB worker token for an AI user, keyed by the
/// AI user's identity (not its `id`, so self-hosted callers can set it right
/// after `create_ai_user` without first reading back the auto-inc id). The
/// worker reads this from its publisher connection to spawn an `AiUserWorker`
/// that connects as the AI user. Same visibility posture as
/// `set_ai_user_api_key` — RLS on `ai_user_config` keeps the secret off other
/// members' subscriptions.
#[reducer]
pub fn set_ai_user_worker_token(
    ctx: &ReducerContext,
    ai_user_identity: Identity,
    worker_token: Option<String>,
) -> Result<(), String> {
    let config = ctx
        .db
        .ai_user_config()
        .identity()
        .find(ai_user_identity)
        .ok_or("AI user config not found for identity")?;
    ctx.db.ai_user_config().id().update(AiUserConfig {
        worker_token,
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
        .find(ai_user_id)
        .ok_or("AI user not found")?;
    ctx.db.ai_user_config().id().delete(ai_user_id);
    ctx.db.ai_user_profile().ai_user_id().delete(ai_user_id);
    log::info!("AI user deleted: id={}", ai_user_id);
    Ok(())
}

/// Set or clear opaque JSON for built-in tool settings (e.g. Serper API key
/// for `web_search`). Not echoed on normal subscriptions; same visibility as
/// `api_key`. Does not change `has_api_key` on the profile.
#[reducer]
pub fn set_ai_user_tool_secrets_json(
    ctx: &ReducerContext,
    ai_user_id: u64,
    tool_secrets_json: Option<String>,
) -> Result<(), String> {
    let config = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user config not found")?;
    ctx.db.ai_user_config().id().update(AiUserConfig {
        tool_secrets_json,
        updated_at: ctx.timestamp,
        ..config
    });
    Ok(())
}

/// Set or clear the per-AI-user inference-backend binding (see
/// `AiUserConfig::inference_backend_json`). Sanity caps only — the worker
/// validates the JSON shape and the enqueue reducer enforces the device grant.
/// Mirrored onto `AiUserProfile` so the settings UI (which cannot read the
/// RLS-guarded config row as a human) can display the current binding.
#[reducer]
pub fn set_ai_user_inference_backend(
    ctx: &ReducerContext,
    ai_user_id: u64,
    inference_backend_json: Option<String>,
) -> Result<(), String> {
    if inference_backend_json.as_deref().is_some_and(|j| j.len() > 4096) {
        return Err("Inference backend binding too large (max 4 KiB)".to_string());
    }
    let inference_backend_json =
        inference_backend_json.filter(|j| !j.trim().is_empty());
    let config = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user config not found")?;
    // Captured before the update consumes `config` — used to restore the
    // profile's display names when the binding is cleared.
    let cloud_provider_name = provider_profile_name(&config.provider, config.endpoint.as_deref());
    let cloud_model = config.model.clone();
    ctx.db.ai_user_config().id().update(AiUserConfig {
        inference_backend_json: inference_backend_json.clone(),
        updated_at: ctx.timestamp,
        ..config
    });
    if let Some(profile) = ctx.db.ai_user_profile().ai_user_id().find(ai_user_id) {
        // The profile's provider/model are what the chat header and mention UI
        // display — they must follow the ACTIVE backend, not the dormant cloud
        // config (a bound-to-ollama user must not read "OpenRouter · kimi").
        // External MCP profiles keep their `external-mcp-client` model marker:
        // isExternalMcpProfile (web) keys off it.
        let is_external_mcp = profile.model_name == "external-mcp-client";
        let (provider_name, model_name) = if is_external_mcp {
            (profile.provider_name.clone(), profile.model_name.clone())
        } else if let Some(raw) = inference_backend_json.as_deref() {
            match serde_json::from_str::<Value>(raw) {
                Ok(b) => {
                    let mode = b.get("mode").and_then(|m| m.as_str()).unwrap_or("");
                    let dev_provider = b.get("provider").and_then(|p| p.as_str()).unwrap_or("device");
                    let model = b.get("model").and_then(|m| m.as_str());
                    if mode == "harness" {
                        (
                            "Pear Bridge (harness)".to_string(),
                            model.unwrap_or("claude-code").to_string(),
                        )
                    } else {
                        (
                            format!("Pear Bridge ({dev_provider})"),
                            model.map(|m| m.to_string()).unwrap_or_else(|| cloud_model.clone()),
                        )
                    }
                }
                // Unparseable binding: leave the display unchanged.
                Err(_) => (profile.provider_name.clone(), profile.model_name.clone()),
            }
        } else {
            (cloud_provider_name.to_string(), cloud_model.clone())
        };
        ctx.db.ai_user_profile().ai_user_id().update(AiUserProfile {
            inference_backend_json,
            provider_name,
            model_name,
            updated_at: ctx.timestamp,
            ..profile
        });
    }
    Ok(())
}

/// Set or clear the [Serper](https://serper.dev) API key for the built-in
/// `web_search` tool, without replacing other keys in `tool_secrets_json`.
/// Pass `None` or an empty string to remove the key.
#[reducer]
pub fn set_ai_user_serper_api_key(
    ctx: &ReducerContext,
    ai_user_id: u64,
    serper_api_key: Option<String>,
) -> Result<(), String> {
    let config = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user config not found")?;

    let mut map = match &config.tool_secrets_json {
        Some(s) if !s.trim().is_empty() => match serde_json::from_str::<Value>(s) {
            Ok(Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        },
        _ => serde_json::Map::new(),
    };

    let key = serper_api_key.unwrap_or_default();
    if key.trim().is_empty() {
        map.remove("serperApiKey");
    } else {
        map.insert("serperApiKey".to_string(), Value::String(key));
    }

    let tool_secrets_json = if map.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&Value::Object(map)).unwrap_or_else(|_| "{}".to_string()))
    };

    ctx.db.ai_user_config().id().update(AiUserConfig {
        tool_secrets_json,
        updated_at: ctx.timestamp,
        ..config
    });
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
