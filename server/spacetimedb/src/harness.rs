//! Harness templates, review agent bindings, auto-apply bindings, and
//! review annotations. Templates package "an AI user with a job to do";
//! review/auto-apply bindings hang governance off `AiUserConfig`.

use spacetimedb::{reducer, table, Identity, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::access_control::helpers::require_creator_or_admin;
use crate::ai::{ai_user_config, AiUserRole, InferenceProvider};
use crate::auth::sender_is_admin;
use crate::id_counters::alloc_id;
use crate::pages::snapshots::page_snapshot;
use crate::stable_ids::generate_external_id;

pub(crate) fn next_harness_template_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "harness_template", || {
        ctx.db
            .harness_template()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_review_agent_binding_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "review_agent_binding", || {
        ctx.db
            .review_agent_binding()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_review_annotation_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "review_annotation", || {
        ctx.db
            .review_annotation()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_auto_apply_binding_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "auto_apply_binding", || {
        ctx.db
            .auto_apply_binding()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

// ============================================================
// Harness templates, review bindings, auto-apply, preferences
// ============================================================

/// Subject of a `ReviewAgentBinding`. Replaces the prior
/// `subject_kind: u8 + subject_ai_user_id: u64` pair so the type system —
/// not a comment — encodes the discriminator.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ReviewSubject {
    /// Review every action by this specific AI user.
    AiUser(u64),
    /// Review every action in the workspace.
    Workspace,
    // Future: Page(u64), Database(u64), ...
}

/// Context of an `AutoApplyBinding`. Replaces the prior
/// `context_kind: u8 + context_id: u64` pair for the same reason as
/// `ReviewSubject`.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AutoApplyContext {
    /// Auto-apply within a single page (and its descendants).
    Page(u64),
    /// Auto-apply across the entire workspace.
    Workspace,
    // Future: Database(u64), ...
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum HarnessTemplateSource {
    /// Ships with the application; cannot be deleted, only forked.
    Builtin,
    /// Authored in this workspace.
    Workspace,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ReviewMode {
    Pre,
    Post,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ReviewSeverity {
    Pass,
    Warn,
    Fail,
}

/// Versioned packaging of "an AI user with a job to do" — what
/// `ConfigBundle` will eventually be promoted into. Wraps:
///   - system prompt fragment
///   - default model (still overridable per AI user)
///   - default `instruction_pages` (relation to Page rows)
///   - default `allowed_tools` (relation to ExtensionPermission scopes)
///   - default `review_agent_template_ids`
///   - default `default_context_scope` (which pages the AI user can see)
///
/// All "default_*" fields land as JSON for now; once we have richer
/// relation tables we can split them out without a schema-breaking change
/// to consumers.
#[table(accessor = harness_template, public,
        index(accessor = harness_template_external_id, btree(columns = [external_id])))]
pub struct HarnessTemplate {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Stable cross-database identifier (sha256-derived hex). Set on insert
    /// and never rotated; survives forking, exporting, or re-importing the
    /// template. Use this — not `id` — when referencing a template from
    /// outside the workspace (e.g. shared marketplaces, audit trails).
    pub external_id: String,
    /// Human-friendly name ("Prospect Researcher", "Copy Editor", ...).
    pub name: String,
    /// One-paragraph description shown in the picker.
    pub description: String,
    /// Authoring source: `Builtin` for shipped reference templates,
    /// `Workspace` for ones a workspace admin built locally.
    pub source: HarnessTemplateSource,
    /// `system_prompt` to seed `AiUserConfig.system_prompt`.
    pub system_prompt: String,
    /// Suggested `provider` + `model` defaults (worker may override).
    pub default_provider: InferenceProvider,
    pub default_model: String,
    pub default_max_tokens: u32,
    /// JSON: { "instruction_page_titles": [...], "allowed_tool_scopes":
    /// [...], "default_context_scope": "...", "review_agent_template_ids":
    /// [...] }. UI parses lazily.
    pub config_json: String,
    /// Bumped every time the operator edits a template; AI users
    /// provisioned from earlier versions display a "template updated"
    /// affordance.
    pub version: u32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Binds a review agent (an `AiUserConfig` with `role = Reviewer`) to a
/// scope where its review runs. `Pre` reviews run on the proposed
/// mutation before it lands in the snapshot pair; `Post` reviews run on
/// the `PostAgentEdit` snapshot.
///
/// The `subject` field encodes the scope as a typed `ReviewSubject` enum:
/// `AiUser(id)` reviews actions by a specific AI user; `Workspace` reviews
/// every action in the workspace. Future variants (Page, Database) will
/// extend the enum without a schema migration.
#[table(accessor = review_agent_binding, public)]
pub struct ReviewAgentBinding {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// `AiUserConfig.id` of the reviewer.
    #[index(btree)]
    pub reviewer_ai_user_id: u64,
    /// Typed scope; replaces the prior `subject_kind: u8 + subject_ai_user_id: u64` pair.
    pub subject: ReviewSubject,
    pub mode: ReviewMode,
    /// What to do when the reviewer itself fails (timeout, model error).
    /// Doc default is fail-open (the proposed mutation goes through with a
    /// warning marker), to avoid one flaky reviewer wedging all writes.
    pub fail_open: bool,
    pub created_by: Identity,
    pub created_at: Timestamp,
}

/// A reviewer's annotation on a specific `PostAgentEdit` snapshot.
/// `severity` controls how the diff review surface displays it:
///   - Pass: green check, no friction
///   - Warn: yellow badge, human can still one-click apply
///   - Fail: red badge, auto-apply suspended until reviewed
#[table(accessor = review_annotation, public)]
pub struct ReviewAnnotation {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// `PageSnapshot.id` of the `PostAgentEdit` snapshot being annotated.
    #[index(btree)]
    pub snapshot_id: u64,
    pub reviewer_ai_user_id: u64,
    pub severity: ReviewSeverity,
    pub comment: String,
    pub created_at: Timestamp,
}

/// "Auto-apply mode" granted to an AI user within a context. The `context`
/// field is a typed `AutoApplyContext` enum (`Page(id)` or `Workspace`).
/// A row's *presence* grants auto-apply; absence means human review is
/// required. A reviewer `Fail` annotation overrides this regardless.
///
/// `allowed_action_kinds` narrows the *capability* of the grant: when
/// `Some(list)`, only mutations whose primitive action kind appears in the
/// list may auto-apply; everything else falls back to human review.
/// `None` means "all action kinds" (current behaviour, kept for back-compat
/// during the rollout). Capability-bounded grants are the foundation for
/// safer automation — see PEAR_PROGRAMMING.md "Foundational decisions" #6.
#[table(accessor = auto_apply_binding, public,
        index(accessor = auto_apply_binding_principal,
              btree(columns = [ai_user_id])))]
pub struct AutoApplyBinding {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub ai_user_id: u64,
    /// Typed scope; replaces the prior `context_kind: u8 + context_id: u64` pair.
    pub context: AutoApplyContext,
    /// Optional capability scope. `None` = all action kinds (legacy).
    /// `Some(list)` = only the listed primitive action kinds may auto-apply.
    /// Action kind strings are the same identifiers used by the AI tool
    /// registry (e.g. `"create_page"`, `"set_property_value"`,
    /// `"upsert_block"`).
    pub allowed_action_kinds: Option<Vec<String>>,
    pub granted_by: Identity,
    pub granted_at: Timestamp,
}

// ============================================================
// Harness templates / review bindings / auto-apply / preferences
// ============================================================

/// Create or update a `HarnessTemplate`. `Builtin` source is reserved for
/// init-time seeding; user-callable updates are restricted to admins.
#[reducer]
pub fn upsert_harness_template(
    ctx: &ReducerContext,
    id: Option<u64>,
    name: String,
    description: String,
    system_prompt: String,
    default_provider: InferenceProvider,
    default_model: String,
    default_max_tokens: u32,
    config_json: String,
) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("Only workspace admins can edit harness templates".to_string());
    }
    if name.trim().is_empty() {
        return Err("Template name is required".to_string());
    }
    if let Some(template_id) = id {
        let existing = ctx
            .db
            .harness_template()
            .id()
            .find(template_id)
            .ok_or("HarnessTemplate not found")?;
        if matches!(existing.source, HarnessTemplateSource::Builtin) {
            return Err("Builtin templates cannot be edited; fork and re-save".to_string());
        }
        ctx.db.harness_template().id().update(HarnessTemplate {
            name,
            description,
            system_prompt,
            default_provider,
            default_model,
            default_max_tokens,
            config_json,
            version: existing.version + 1,
            updated_at: ctx.timestamp,
            ..existing
        });
    } else {
        let external_id = generate_external_id(ctx, "harness_template", &name);
        ctx.db.harness_template().insert(HarnessTemplate {
            id: next_harness_template_id(ctx),
            external_id,
            name,
            description,
            source: HarnessTemplateSource::Workspace,
            system_prompt,
            default_provider,
            default_model,
            default_max_tokens,
            config_json,
            version: 1,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        });
    }
    Ok(())
}

#[reducer]
pub fn delete_harness_template(ctx: &ReducerContext, template_id: u64) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("Only workspace admins can delete harness templates".to_string());
    }
    let existing = ctx
        .db
        .harness_template()
        .id()
        .find(template_id)
        .ok_or("HarnessTemplate not found")?;
    if matches!(existing.source, HarnessTemplateSource::Builtin) {
        return Err("Builtin templates cannot be deleted".to_string());
    }
    ctx.db.harness_template().id().delete(template_id);
    Ok(())
}

#[reducer]
pub fn create_review_agent_binding(
    ctx: &ReducerContext,
    reviewer_ai_user_id: u64,
    subject: ReviewSubject,
    mode: ReviewMode,
    fail_open: bool,
) -> Result<(), String> {
    let reviewer = ctx
        .db
        .ai_user_config()
        .id()
        .find(reviewer_ai_user_id)
        .ok_or("Reviewer AI user not found")?;
    if !matches!(reviewer.role, AiUserRole::Reviewer) {
        return Err("Selected AI user is not a reviewer".to_string());
    }
    if let ReviewSubject::AiUser(subject_ai_user_id) = subject {
        if ctx
            .db
            .ai_user_config()
            .id()
            .find(subject_ai_user_id)
            .is_none()
        {
            return Err("Subject AI user not found".to_string());
        }
    }
    require_creator_or_admin(ctx, reviewer.created_by, "create review bindings")?;

    ctx.db.review_agent_binding().insert(ReviewAgentBinding {
        id: next_review_agent_binding_id(ctx),
        reviewer_ai_user_id,
        subject,
        mode,
        fail_open,
        created_by: ctx.sender(),
        created_at: ctx.timestamp,
    });
    Ok(())
}

#[reducer]
pub fn delete_review_agent_binding(ctx: &ReducerContext, binding_id: u64) -> Result<(), String> {
    let binding = ctx
        .db
        .review_agent_binding()
        .id()
        .find(binding_id)
        .ok_or("Binding not found")?;
    require_creator_or_admin(ctx, binding.created_by, "delete review bindings")?;
    ctx.db.review_agent_binding().id().delete(binding_id);
    Ok(())
}

/// Worker-callable: persist a review annotation against a snapshot.
#[reducer]
pub fn record_review_annotation(
    ctx: &ReducerContext,
    snapshot_id: u64,
    reviewer_ai_user_id: u64,
    severity: ReviewSeverity,
    comment: String,
) -> Result<(), String> {
    ctx.db
        .page_snapshot()
        .id()
        .find(snapshot_id)
        .ok_or("Snapshot not found")?;
    ctx.db
        .ai_user_config()
        .id()
        .find(reviewer_ai_user_id)
        .ok_or("Reviewer AI user not found")?;
    ctx.db.review_annotation().insert(ReviewAnnotation {
        id: next_review_annotation_id(ctx),
        snapshot_id,
        reviewer_ai_user_id,
        severity,
        comment,
        created_at: ctx.timestamp,
    });
    Ok(())
}

#[reducer]
pub fn grant_auto_apply(
    ctx: &ReducerContext,
    ai_user_id: u64,
    context: AutoApplyContext,
    allowed_action_kinds: Option<Vec<String>>,
) -> Result<(), String> {
    let ai_user = ctx
        .db
        .ai_user_config()
        .id()
        .find(ai_user_id)
        .ok_or("AI user not found")?;
    require_creator_or_admin(ctx, ai_user.created_by, "grant auto-apply")?;

    if let Some(ref kinds) = allowed_action_kinds {
        if kinds.is_empty() {
            return Err(
                "allowed_action_kinds is empty — pass None to grant all kinds, \
                 or list at least one"
                    .to_string(),
            );
        }
        for k in kinds {
            if k.trim().is_empty() {
                return Err("allowed_action_kinds contains an empty string".to_string());
            }
        }
    }

    let already = ctx
        .db
        .auto_apply_binding()
        .iter()
        .any(|b| b.ai_user_id == ai_user_id && b.context == context);
    if already {
        return Ok(());
    }
    ctx.db.auto_apply_binding().insert(AutoApplyBinding {
        id: next_auto_apply_binding_id(ctx),
        ai_user_id,
        context,
        allowed_action_kinds,
        granted_by: ctx.sender(),
        granted_at: ctx.timestamp,
    });
    Ok(())
}

#[reducer]
pub fn revoke_auto_apply(ctx: &ReducerContext, binding_id: u64) -> Result<(), String> {
    let binding = ctx
        .db
        .auto_apply_binding()
        .id()
        .find(binding_id)
        .ok_or("Binding not found")?;
    let ai_user = ctx
        .db
        .ai_user_config()
        .id()
        .find(binding.ai_user_id)
        .ok_or("AI user not found")?;
    require_creator_or_admin(ctx, ai_user.created_by, "revoke auto-apply")?;
    ctx.db.auto_apply_binding().id().delete(binding_id);
    Ok(())
}
