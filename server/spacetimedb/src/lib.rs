use hex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use spacetimedb::{
    client_visibility_filter, reducer, table, view, AnonymousViewContext, Filter, Identity,
    ReducerContext, SpacetimeType, Table, Timestamp,
};
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
    /// Computed by an AI primitive over other columns of the same row.
    /// Configuration (primitive, model, prompt, output schema, invalidation
    /// policy) lives in `PropertyDefinition.config` as JSON; current
    /// materialised value lives in the same `PagePropertyValue` row as
    /// any other column. Evaluation history (cache + cost) lives in
    /// `AiEvaluation`.
    Ai,
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
    /// Materialised AI primitive output, paired with the `AiEvaluation.id`
    /// it was produced by so the UI can show provenance and cost without a
    /// separate query.
    Ai(AiPropertyValue),
}

/// Materialised value of an AI column. The output is intentionally a
/// `String` even for "extract" / "classify" — the rendering layer reads
/// the column's `output_schema_json` to decide how to display it (chip,
/// number, sub-table, etc.). Storing as a string also keeps the cell
/// schema-stable when the prompt's output schema evolves.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct AiPropertyValue {
    pub output: String,
    pub evaluation_id: u64,
    pub is_stale: bool,
}

/// Set of supported AI primitives. Each maps to a worker handler that
/// validates output against `AiColumnConfig.output_schema_json` before
/// committing.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AiPrimitive {
    /// Pick one of N labels.
    Classify,
    /// Pull structured fields out of input text.
    Extract,
    /// Compress to N words/sentences.
    Summarize,
    /// Score Positive / Negative / Neutral with confidence.
    Sentiment,
    /// Translate to a target language.
    Translate,
}

/// Controls when a materialised `AiPropertyValue` is considered stale.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum InvalidationPolicy {
    /// Recompute whenever any column referenced by `AiColumnConfig.input_columns`
    /// changes on the row. Default for most primitives.
    OnInputChange,
    /// Never auto-recompute — only manual `recompute_ai_cell`. Useful for
    /// expensive primitives where the operator wants to manage cost.
    Manual,
    /// Never invalidate. Useful for one-shot enrichment.
    Never,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ConversationStatus {
    Active,
    Closed,
}

/// Sender of a conversation message. After the AI-user-identity refactor, both
/// humans and AI users are represented by `User(Identity)`; clients tell them
/// apart by joining against `ai_user_profile.identity`. `System(...)` is reserved
/// for server-generated events (e.g. "compaction").
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum MessageSender {
    User(Identity),
    System(String),
}

/// Role within a conversation. Today we only distinguish the initiator (the
/// human who started the thread) from regular members, but this leaves room
/// for future channel/DM models with admins, observers, etc.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ParticipantRole {
    Initiator,
    Member,
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

/// Access permission level on a Page or Block.
///
/// `Write` implies `Read` — a principal that can write necessarily can also
/// read. The two variants exist so rule storage stays compact (one row per
/// principal, not per action).
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum Permission {
    Read,
    Write,
}

/// A grantee on an access rule. Today only `WorkspaceMember(Identity)` is
/// populated; future variants (`EndUser(u64)`, etc.) can be appended without
/// migrating existing rows because SpacetimeDB enums are forward-compatible
/// when only adding variants. See PEAR_PROGRAMMING.md "Foundational
/// decisions" #2 for the rationale.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum Principal {
    /// A workspace member identified by their SpacetimeDB Identity.
    WorkspaceMember(Identity),
    // Future: EndUser(u64), ApiKey(u64), ServiceAccount(u64), ...
}

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

/// Visibility scope for a `Conversation`. Conversations get their own
/// permission model independent of page permissions because the common case
/// is "I want a private side conversation about a public page".
///
/// Visibility is monotonically expanding (`Private` → `Participants` →
/// `PageInheriting`) and cannot retroactively contract — see
/// `set_conversation_visibility` for the guard.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ConversationVisibility {
    /// Only the initiator and AI user(s) can see the thread.
    Private,
    /// Initiator + AI user(s) + the explicit list in `conversation_participant`.
    Participants,
    /// Mirrors the attached page's effective access rules. Detached
    /// (`page_id = None`) conversations cannot use this variant.
    PageInheriting,
}

// ============================================================
// Tables
// ============================================================

/// Records which one-shot data migrations have already run on this database.
///
/// CONTRACT: lifecycle's provisioner calls `run_pending_migrations` after
/// every successful `publish_module` (both new provisions and version
/// upgrades). The reducer is responsible for deciding what's new based on
/// rows in this table — it MUST NOT re-run a migration whose key is
/// already recorded. See `run_pending_migrations` for the canonical list.
///
/// Keys are free-form strings (e.g. `"page_parent_pk_backfill_v1"`) and
/// MUST be unique-and-stable across releases — once recorded, the same
/// key will never re-run, so changing data semantics requires a new key.
#[table(accessor = migration_state, public)]
pub struct MigrationState {
    #[primary_key]
    pub key: String,
    pub completed_at: Timestamp,
    /// Module version (`Cargo.toml`'s `[package].version`) that introduced
    /// this migration. Stored for forensics — not used for dispatch.
    pub module_version: String,
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
    /// Optional emoji/icon (single character or short string) for sidebar and header.
    #[default(Option::<String>::None)]
    pub icon: Option<String>,
    /// Indexed shadow of `parent_id` with `0` representing root.
    ///
    /// WHY: SpacetimeDB's SQL HTTP subset cannot filter `Option<T>` columns by
    /// literal — `WHERE parent_id = 1` errors with `"The literal expression
    /// '1' cannot be parsed as type '(some: U64 | none: ())'"` (see
    /// clockworklabs/SpacetimeDB#2696, closed wontfix). Custom API endpoint
    /// dispatch needs to scan all rows of a database page (= "child rows of
    /// parent X"), so we mirror `parent_id` into a non-nullable indexed
    /// column that the SQL planner is happy to filter on.
    ///
    /// INVARIANT: every reducer that writes `parent_id` MUST also write
    /// `parent_pk = parent_id.unwrap_or(0)`. The `page_parent_pk_backfill_v1`
    /// migration step (in `run_pending_migrations`) one-shots existing rows
    /// after a deploy.
    ///
    #[index(btree)]
    #[default(0u64)]
    pub parent_pk: u64,
    /// Excludes this page (and conventionally its subtree) from sidebar
    /// navigation and search by default. Used to host AI-user memory
    /// subtrees and other "infrastructure" pages users don't need to see.
    /// Access rules still apply normally — this is a visibility hint, not
    /// a permission.
    ///
    /// Must be last for schema migration (STDB only allows additive changes
    /// at the end of a struct).
    #[default(false)]
    pub is_hidden: bool,
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
}

// ============================================================
// Harness templates, review bindings, auto-apply, preferences
// ============================================================

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

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum HarnessTemplateSource {
    /// Ships with the application; cannot be deleted, only forked.
    Builtin,
    /// Authored in this workspace.
    Workspace,
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

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ReviewMode {
    Pre,
    Post,
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

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ReviewSeverity {
    Pass,
    Warn,
    Fail,
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

/// AI-user memory: a hidden subtree per AI user, two-tier (working /
/// long-term). `working` memory stays small and is rewritten freely;
/// `long_term` is consolidated by a weekly Orcha job. Both are just Page
/// rows under `root_page_id` (which has `is_hidden = true` — see Phase 0).
#[table(accessor = ai_user_memory, public)]
pub struct AiUserMemory {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[unique]
    pub ai_user_id: u64,
    /// Hidden Page that hosts the memory subtree.
    pub root_page_id: u64,
    /// Page under root that holds the working-memory snapshot (small,
    /// frequently rewritten). Nullable until first write.
    pub working_page_id: Option<u64>,
    /// Page under root that holds the consolidated long-term memory.
    pub long_term_page_id: Option<u64>,
    pub created_at: Timestamp,
    pub last_consolidated_at: Option<Timestamp>,
}

/// A conversation thread. May be attached to a page (today's @mention flow) or
/// detached (future workspace channels / DMs — `page_id = None`). Participants
/// are tracked via `conversation_participant`; the legacy `ai_user_id` FK has
/// been removed in favor of the more general participant model.
#[table(accessor = conversation, public)]
pub struct Conversation {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// `Some(page_id)` for page-attached conversations (current behavior).
    /// `None` for future channel/DM-style threads.
    #[index(btree)]
    pub page_id: Option<u64>,
    /// The Identity that opened the thread (a human today; could be any
    /// participant in future flows).
    pub initiated_by: Identity,
    pub status: ConversationStatus,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    /// Visibility scope. Defaults to `Private` (initiator + AI user(s) only)
    /// even when the host page is public — most conversations are thinking,
    /// not conclusions. Can only be expanded via `set_conversation_visibility`,
    /// never retroactively contracted.
    ///
    /// Must be last for schema migration (STDB only allows additive changes
    /// at the end of a struct).
    #[default(ConversationVisibility::Private)]
    pub visibility: ConversationVisibility,
}

/// Membership join between conversations and identities. The worker
/// subscribes to `conversation_participant WHERE identity = self` to discover
/// every thread an AI user is part of, regardless of whether it's attached to
/// a page or (future) a channel/DM.
#[table(accessor = conversation_participant, public)]
pub struct ConversationParticipant {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub conversation_id: u64,
    #[index(btree)]
    pub identity: Identity,
    pub role: ParticipantRole,
    pub joined_at: Timestamp,
    /// `id` of the last `conversation_message` row this participant has
    /// viewed. Drives unread-count UI in Inbox mode. `None` until the
    /// participant first opens the thread.
    ///
    /// Must remain last for schema migration (STDB only allows additive
    /// changes at the end of a struct).
    #[default(None::<u64>)]
    pub last_viewed_message_id: Option<u64>,
    /// `Some(timestamp)` once the participant has been removed from the
    /// thread. Removal is honest — the row stays so the audit trail
    /// records who saw what before they were removed; new messages stop
    /// flowing to them.
    #[default(None::<Timestamp>)]
    pub left_at: Option<Timestamp>,
}

/// Registry of valid structural-sensor `(sensor_kind, code)` pairs. This
/// turns the previously open string fields on `StructuralSensorFinding`
/// into a closed vocabulary: the `upsert_finding` helper validates
/// against this table and refuses unknown kinds/codes, so a typo in a
/// sensor reducer can't quietly produce a finding the UI doesn't know how
/// to render.
///
/// Seeded at `init` time with every shipped sensor; new sensors register
/// by adding a row in `seed_sensor_registry_inner`. Callers (other than
/// the seed) cannot insert here — admins can adjust `default_severity`
/// or `description` via reducers added later if needed.
#[table(
    accessor = sensor_registry,
    public,
    index(accessor = sensor_registry_kind_code, btree(columns = [sensor_kind, code])),
)]
pub struct SensorRegistry {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Sensor identifier (e.g. `"orphan_detector"`).
    pub sensor_kind: String,
    /// Specific rule code within the sensor (e.g. `"page_parent_missing"`).
    pub code: String,
    /// Human-readable name shown in the Inbox / settings UI.
    pub display_name: String,
    /// One-paragraph explanation of what this finding means.
    pub description: String,
    /// Default severity emitted by the sensor: `"info"`, `"warn"`, `"error"`.
    /// The sensor may override per-finding, but this is the canonical class.
    pub default_severity: String,
}

/// Findings emitted by computational structural sensors (orphan detector,
/// relational integrity, schema consistency, convention sensor). These are
/// cheap deterministic checks over the relational substrate; an Orcha worker
/// invokes the corresponding `run_*_sensor` reducer on a schedule and the
/// reducer (re)writes findings here.
///
/// `sensor_kind` + `code` MUST appear in `SensorRegistry`; the
/// `upsert_finding` helper enforces this. This makes the sensor surface a
/// closed, governed vocabulary rather than an open string-typed sink.
///
/// Findings are *advisory* — they surface in the Inbox / Members tab and
/// optionally feed review agents; they do not block writes. Each row is
/// keyed by `(sensor_kind, target_kind, target_id, code)` so re-runs
/// upsert rather than spam.
#[table(
    accessor = structural_sensor_finding,
    public,
    index(accessor = structural_sensor_finding_kind,
          btree(columns = [sensor_kind])),
    index(accessor = structural_sensor_finding_target,
          btree(columns = [target_kind, target_id])),
)]
pub struct StructuralSensorFinding {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Short stable identifier for the sensor that produced this finding.
    /// Examples: `"orphan_detector"`, `"relational_integrity"`,
    /// `"schema_consistency"`, `"convention"`.
    pub sensor_kind: String,
    /// Short stable code identifying the rule that fired (e.g.
    /// `"page_no_parent"`, `"relation_dangling"`, `"property_type_mismatch"`).
    pub code: String,
    /// Target entity kind, e.g. `"page"`, `"property_value"`,
    /// `"property_definition"`, `"database_schema"`.
    pub target_kind: String,
    /// Primary key of the target entity (best-effort u64 coercion;
    /// strings are not used as targets today).
    pub target_id: u64,
    /// Human-readable summary of the finding, intended for the Inbox.
    pub message: String,
    /// Severity: `"info"`, `"warn"`, `"error"`. Sensor-defined.
    pub severity: String,
    /// JSON bag of additional context (e.g. expected vs. actual type).
    pub details_json: String,
    pub created_at: Timestamp,
    pub last_seen_at: Timestamp,
    /// Set when the finding has been acknowledged (manual dismiss or fixed).
    #[default(None::<Timestamp>)]
    pub resolved_at: Option<Timestamp>,
}

// ============================================================
// Access Control Tables
// ============================================================

/// Per-page, per-principal access grant. Rules *restrict* — the absence of
/// any rule for a page means the open model applies (any authenticated
/// caller can read and write). When at least one rule exists for a page,
/// only listed principals (with the appropriate `Permission`) plus
/// workspace admins may act on it.
///
/// `principal` is an `Identity`, which generalises across human and AI
/// users — both are first-class principals per `FEATURE_ai_users.md`.
#[table(accessor = page_access_rule, public)]
pub struct PageAccessRule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    /// Typed grantee. Today only `Principal::WorkspaceMember(Identity)` is
    /// populated; future end-user / API-key variants slot in without
    /// schema migration.
    pub principal: Principal,
    pub permission: Permission,
    pub granted_by: Identity,
    pub granted_at: Timestamp,
}

/// Cached evaluation of an AI primitive over a specific row. The cache key
/// is `input_hash = sha256(primitive || NUL || model || NUL || prompt_version || NUL || serialized_inputs)`.
/// The same `(primitive, inputs, model, prompt_version)` produces the same
/// `input_hash`, so two `Ai` cells in different rows that happened to have
/// the same inputs share an evaluation for free. Cross-workspace
/// sharing is opt-in via `ai_user_config.allow_evaluation_sharing` and
/// is the responsibility of whatever external service consumes those
/// rows; pear core itself never publishes them.
///
/// `is_stale` flips to `true` when an upstream input changes; recompute
/// inserts a fresh row and the prior row is preserved as history (cost +
/// provenance trail). Retention policy: keep all eval rows for now;
/// thinning is a Phase B/C polish concern once volume is real.
#[table(
    accessor = ai_evaluation,
    public,
    index(accessor = ai_evaluation_input_hash, btree(columns = [input_hash])),
    index(accessor = ai_evaluation_property_page,
          btree(columns = [property_definition_id, page_id])),
)]
pub struct AiEvaluation {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// PropertyDefinition.id of the AI column this evaluation belongs to.
    #[index(btree)]
    pub property_definition_id: u64,
    /// Page (row) the evaluation is for.
    #[index(btree)]
    pub page_id: u64,
    /// SHA-256 hex of the canonicalised cache key.
    pub input_hash: String,
    pub primitive: AiPrimitive,
    pub model: String,
    /// Monotonically incremented when the operator edits `prompt_template`
    /// in the column config. Distinguishes "same inputs, new prompt".
    pub prompt_version: u32,
    /// Final tool output as serialized JSON string.
    pub output: String,
    /// Tokens consumed (prompt + completion).
    pub input_tokens: u32,
    pub output_tokens: u32,
    /// Cost in USD micro-cents (10^-6 USD) — integer storage avoids
    /// floating-point drift in aggregations.
    pub cost_microcents: u64,
    pub wall_clock_ms: u32,
    pub created_at: Timestamp,
    /// Identity of the AI user this primitive ran under (for cost
    /// attribution + per-AI-user budget tracking).
    pub ai_user_identity: Identity,
    /// Marked `true` when an upstream input changes; UI shows a "stale"
    /// badge. Manual recompute clears by inserting a fresh row.
    pub is_stale: bool,
}

/// Per-block, per-principal access grant. Same restrict-not-grant semantic
/// as `page_access_rule`. The combination `(page_id, block_id)` identifies
/// a block within a page; `block_id` is the BlockNote block id (a string,
/// since BlockNote uses uuid-style ids).
///
/// Block-level enforcement against the live Yjs blob is partial — see the
/// Phase A discussion in `FEATURE_ai_users.md`. The MVP enforcement point
/// is the context payload assembled for AI users; the field exists in
/// schema today so we can subscribe and query against it from clients.
#[table(
    accessor = block_access_rule,
    public,
)]
pub struct BlockAccessRule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub page_id: u64,
    pub block_id: String,
    /// Typed grantee. See `PageAccessRule.principal` for the enum
    /// extensibility rationale.
    pub principal: Principal,
    pub permission: Permission,
    pub granted_by: Identity,
    pub granted_at: Timestamp,
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
    seed_sensor_registry_inner(ctx);
}

/// Seed the pear-workspace-tools built-in extension for databases that were created
/// before this feature shipped. Safe to call multiple times — no-op if already seeded.
#[reducer]
pub fn seed_builtin_extensions(ctx: &ReducerContext) -> Result<(), String> {
    seed_builtin_extensions_inner(ctx);
    Ok(())
}

/// Idempotent seed for `SensorRegistry`. Safe to call repeatedly — every
/// (sensor_kind, code) pair is upserted only if missing. Add new rows here
/// when shipping a new sensor; the corresponding `run_*` reducer will then
/// be allowed to emit findings with that code.
#[reducer]
pub fn seed_sensor_registry(ctx: &ReducerContext) -> Result<(), String> {
    seed_sensor_registry_inner(ctx);
    Ok(())
}

fn seed_sensor_registry_inner(ctx: &ReducerContext) {
    // (sensor_kind, code, display_name, description, default_severity)
    const ROWS: &[(&str, &str, &str, &str, &str)] = &[
        (
            "orphan_detector",
            "page_parent_missing",
            "Orphaned page",
            "A page references a parent that no longer exists (deleted or never created).",
            "warn",
        ),
        (
            "relational_integrity",
            "relation_dangling",
            "Dangling relation",
            "A relation property points at one or more pages that no longer exist.",
            "warn",
        ),
        (
            "schema_consistency",
            "property_definition_missing",
            "Missing property definition",
            "A property value row references a property definition that no longer exists.",
            "error",
        ),
        (
            "schema_consistency",
            "property_type_mismatch",
            "Property value type mismatch",
            "A property value's variant does not match its definition's declared type.",
            "warn",
        ),
        (
            "convention",
            "property_definition_unnamed",
            "Unnamed property definition",
            "A column was created without a name. The UI will display it as a placeholder.",
            "info",
        ),
        (
            "convention",
            "schema_no_columns",
            "Empty database schema",
            "A database schema has zero columns and cannot store any property values.",
            "info",
        ),
        (
            "denied_tool_calls",
            "tool_denied",
            "Repeatedly denied tool call",
            "An agent is being denied access to a tool. Either grant the permission or confirm the deny is correct.",
            "info",
        ),
    ];

    for (kind, code, display, desc, sev) in ROWS {
        let exists = ctx
            .db
            .sensor_registry()
            .iter()
            .any(|r| r.sensor_kind == *kind && r.code == *code);
        if exists {
            continue;
        }
        ctx.db.sensor_registry().insert(SensorRegistry {
            id: next_sensor_registry_id(ctx),
            sensor_kind: kind.to_string(),
            code: code.to_string(),
            display_name: display.to_string(),
            description: desc.to_string(),
            default_severity: sev.to_string(),
        });
    }
}

fn sensor_registry_contains(ctx: &ReducerContext, sensor_kind: &str, code: &str) -> bool {
    ctx.db
        .sensor_registry()
        .iter()
        .any(|r| r.sensor_kind == sensor_kind && r.code == code)
}

// ----------------------------------------------------------------------
// Migrations: standardised post-upgrade hook
// ----------------------------------------------------------------------
//
// CONTRACT (lifecycle ↔ pear module):
//
//   After every successful `publish_module` call (both fresh provisions
//   and version upgrades), pear-cloud's lifecycle calls the
//   `run_pending_migrations` reducer with the workspace's admin token.
//
//   Each migration step:
//     1. Has a stable, unique key (string).
//     2. Checks `MigrationState` for that key — skips if already recorded.
//     3. Runs its work (typically a backfill or one-shot data transform).
//     4. Inserts a `MigrationState` row to mark itself complete.
//
// Keys are append-only — once shipped, NEVER rename or re-use one. To
// re-run the SAME logic on already-migrated databases, define a new key
// with a `_v2` suffix.
//
// New migrations are added by:
//   - Implementing the body as a private `fn` returning `Result<(), String>`.
//   - Appending a `run_step!(ctx, "<key>", <fn>);` line to
//     `run_pending_migrations` below.
//
// Failure of any step short-circuits the whole reducer — the next tick of
// the lifecycle upgrader will retry. State is committed per-step, so a
// partial failure doesn't roll back already-completed migrations.

/// Standardised post-publish hook called by lifecycle after every
/// `publish_module`. Idempotent and safe to call repeatedly. Adds new
/// `MigrationState` rows for any unfinished migrations.
#[reducer]
pub fn run_pending_migrations(ctx: &ReducerContext) -> Result<(), String> {
    macro_rules! run_step {
        ($ctx:expr, $key:expr, $body:expr) => {{
            let key: &str = $key;
            if $ctx.db.migration_state().key().find(&key.to_string()).is_none() {
                $body($ctx)?;
                $ctx.db.migration_state().insert(MigrationState {
                    key: key.to_string(),
                    completed_at: $ctx.timestamp,
                    module_version: env!("CARGO_PKG_VERSION").to_string(),
                });
                log::info!("migration completed: {key}");
            }
        }};
    }

    run_step!(ctx, "page_parent_pk_backfill_v1", backfill_page_parent_pk_inner);
    run_step!(ctx, "sensor_registry_seed_v1", |ctx: &ReducerContext| {
        seed_sensor_registry_inner(ctx);
        Ok::<(), String>(())
    });
    run_step!(
        ctx,
        "harness_template_external_id_backfill_v1",
        backfill_harness_template_external_id_inner
    );
    Ok(())
}

/// Backfill `HarnessTemplate.external_id` for rows that predate the field.
/// Empty strings are replaced with a deterministic hash over the template's
/// `(source, name, created_at)` so re-running is a no-op.
fn backfill_harness_template_external_id_inner(
    ctx: &ReducerContext,
) -> Result<(), String> {
    let stale: Vec<HarnessTemplate> = ctx
        .db
        .harness_template()
        .iter()
        .filter(|t| t.external_id.is_empty())
        .collect();
    let n = stale.len();
    for tmpl in stale {
        let mut hasher = Sha256::new();
        hasher.update(format!("{:?}", tmpl.source).as_bytes());
        hasher.update(b"\x00");
        hasher.update(tmpl.name.as_bytes());
        hasher.update(b"\x00");
        hasher.update(
            tmpl.created_at
                .to_micros_since_unix_epoch()
                .to_le_bytes(),
        );
        let external_id = hex::encode(hasher.finalize());
        ctx.db.harness_template().id().update(HarnessTemplate {
            external_id,
            ..tmpl
        });
    }
    log::info!("harness_template_external_id_backfill_v1: updated {n} rows");
    Ok(())
}

/// Backfill `Page.parent_pk` from `Page.parent_id` for rows that predate
/// the field. Skips soft-deleted pages (the API gateway never queries
/// them) so the on-disk diff stays small.
fn backfill_page_parent_pk_inner(ctx: &ReducerContext) -> Result<(), String> {
    let stale: Vec<Page> = ctx
        .db
        .page()
        .iter()
        .filter(|p| p.deleted_at.is_none() && p.parent_pk != p.parent_id.unwrap_or(0))
        .collect();

    let n = stale.len();
    for page in stale {
        let parent_pk = page.parent_id.unwrap_or(0);
        ctx.db.page().id().update(Page { parent_pk, ..page });
    }
    log::info!("page_parent_pk_backfill_v1: updated {n} rows");
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

    // Bootstrap: the first authenticated user on a fresh database is
    // auto-promoted to admin. We compute this once before the User row is
    // inserted/updated so the new row itself can be the bootstrap.
    let needs_bootstrap_admin = via_oidc && workspace_has_no_admin(ctx);

    if let Some(existing) = ctx.db.user().identity().find(&identity) {
        ctx.db.user().identity().update(User {
            email: if email.is_empty() { existing.email.clone() } else { email },
            name: if name.is_empty() { existing.name.clone() } else { name },
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
    let needs_bootstrap_admin = workspace_has_no_admin(ctx);
    if let Some(existing) = ctx.db.user().identity().find(&identity) {
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
    if let Some(existing) = ctx.db.user().identity().find(&identity) {
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
        .find(&target_identity)
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
            return Err(
                "Cannot demote the last admin — promote another user first".to_string(),
            );
        }
    }

    ctx.db.user().identity().update(User {
        is_admin,
        ..target
    });
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

/// True iff the calling identity is an authenticated workspace admin.
///
/// Used by ownership-gated reducers that want to grant admins a management
/// override on shared infrastructure rows (currently the `api_endpoint`,
/// `api_field_mapping`, and `api_endpoint_key` family). Anyone querying
/// this MUST also separately enforce that the row is the right *kind* of
/// resource for an admin override — extension and AI-user rows are
/// per-installer / per-creator by design and don't honor this flag.
fn sender_is_admin(ctx: &ReducerContext) -> bool {
    ctx.db
        .user()
        .identity()
        .find(&ctx.sender())
        .map(|u| u.is_admin && u.is_authenticated)
        .unwrap_or(false)
}

/// True iff there is currently zero authenticated admin in the workspace.
/// Drives the bootstrap rule: the first user to authenticate on a fresh
/// database is auto-promoted, so a workspace can never be admin-less.
fn workspace_has_no_admin(ctx: &ReducerContext) -> bool {
    !ctx.db.user().iter().any(|u| u.is_admin && u.is_authenticated)
}

/// Authorization helper for `created_by`-gated infrastructure reducers.
/// Returns `Ok(())` if the sender is the original creator OR an admin,
/// otherwise the standard rejection used by the API endpoint family.
fn require_creator_or_admin(
    ctx: &ReducerContext,
    created_by: Identity,
    action: &str,
) -> Result<(), String> {
    if created_by == ctx.sender() || sender_is_admin(ctx) {
        Ok(())
    } else {
        Err(format!(
            "Only the creator or a workspace admin can {action}"
        ))
    }
}

// ============================================================
// Access control helpers
// ============================================================
//
// Semantics: rules *restrict* rather than grant. If zero rules exist for a
// page, the open model applies and any authenticated principal can read or
// write. Once any rule exists for a page, only principals with an explicit
// matching rule (or admins) may act. `Write` implies `Read`.

fn page_has_any_rule(ctx: &ReducerContext, page_id: u64) -> bool {
    ctx.db.page_access_rule().page_id().filter(&page_id).next().is_some()
}

fn principal_has_page_permission(
    ctx: &ReducerContext,
    page_id: u64,
    principal: Identity,
    needed: &Permission,
) -> bool {
    for rule in ctx.db.page_access_rule().page_id().filter(&page_id) {
        if !principal_matches_identity(&rule.principal, principal) {
            continue;
        }
        match (&rule.permission, needed) {
            // Write implies Read.
            (Permission::Write, _) => return true,
            (Permission::Read, Permission::Read) => return true,
            _ => continue,
        }
    }
    false
}

/// True iff `identity` may read `page_id`. Open-by-default.
pub fn can_read_page(ctx: &ReducerContext, page_id: u64, identity: Identity) -> bool {
    if !page_has_any_rule(ctx, page_id) {
        return true;
    }
    if let Some(u) = ctx.db.user().identity().find(&identity) {
        if u.is_admin && u.is_authenticated {
            return true;
        }
    }
    principal_has_page_permission(ctx, page_id, identity, &Permission::Read)
}

/// True iff `identity` may write `page_id`. Open-by-default.
pub fn can_write_page(ctx: &ReducerContext, page_id: u64, identity: Identity) -> bool {
    if !page_has_any_rule(ctx, page_id) {
        return true;
    }
    if let Some(u) = ctx.db.user().identity().find(&identity) {
        if u.is_admin && u.is_authenticated {
            return true;
        }
    }
    principal_has_page_permission(ctx, page_id, identity, &Permission::Write)
}

/// Reducer guard: ensures the caller may write the page or returns the
/// canonical rejection string used by every page-mutating reducer below.
fn require_page_write(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    if can_write_page(ctx, page_id, ctx.sender()) {
        Ok(())
    } else {
        Err("Caller lacks write access on this page".to_string())
    }
}

/// Reducer guard: ensures the caller may read the page (used by reducers
/// that surface page state through side effects, e.g. snapshotting).
#[allow(dead_code)]
fn require_page_read(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    if can_read_page(ctx, page_id, ctx.sender()) {
        Ok(())
    } else {
        Err("Caller lacks read access on this page".to_string())
    }
}

/// True iff `identity` may read a specific block. Falls back to page-level
/// access when no block rule exists. Useful for the AI context assembler;
/// the live Yjs blob is not server-filtered today.
pub fn can_read_block(
    ctx: &ReducerContext,
    page_id: u64,
    block_id: &str,
    identity: Identity,
) -> bool {
    let block_rules: Vec<BlockAccessRule> = ctx
        .db
        .block_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| r.block_id == block_id)
        .collect();

    if block_rules.is_empty() {
        return can_read_page(ctx, page_id, identity);
    }
    if let Some(u) = ctx.db.user().identity().find(&identity) {
        if u.is_admin && u.is_authenticated {
            return true;
        }
    }
    block_rules
        .iter()
        .any(|r| principal_matches_identity(&r.principal, identity))
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
fn next_conversation_participant_id(ctx: &ReducerContext) -> u64 {
    ctx.db
        .conversation_participant()
        .iter()
        .map(|r| r.id)
        .max()
        .unwrap_or(0)
        + 1
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
fn next_orcha_usage_event_id(ctx: &ReducerContext) -> u64 {
    ctx.db.orcha_usage_event().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_page_access_rule_id(ctx: &ReducerContext) -> u64 {
    ctx.db.page_access_rule().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_block_access_rule_id(ctx: &ReducerContext) -> u64 {
    ctx.db.block_access_rule().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_ai_evaluation_id(ctx: &ReducerContext) -> u64 {
    ctx.db.ai_evaluation().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_harness_template_id(ctx: &ReducerContext) -> u64 {
    ctx.db.harness_template().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_review_agent_binding_id(ctx: &ReducerContext) -> u64 {
    ctx.db.review_agent_binding().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_review_annotation_id(ctx: &ReducerContext) -> u64 {
    ctx.db.review_annotation().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_auto_apply_binding_id(ctx: &ReducerContext) -> u64 {
    ctx.db.auto_apply_binding().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_user_preference_id(ctx: &ReducerContext) -> u64 {
    ctx.db.user_preference().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_ai_user_memory_id(ctx: &ReducerContext) -> u64 {
    ctx.db.ai_user_memory().iter().map(|r| r.id).max().unwrap_or(0) + 1
}

fn next_structural_sensor_finding_id(ctx: &ReducerContext) -> u64 {
    ctx.db
        .structural_sensor_finding()
        .iter()
        .map(|r| r.id)
        .max()
        .unwrap_or(0)
        + 1
}

fn next_sensor_registry_id(ctx: &ReducerContext) -> u64 {
    ctx.db.sensor_registry().iter().map(|r| r.id).max().unwrap_or(0) + 1
}

// ============================================================
// Cross-database stable IDs.
// ============================================================
// SHA-256 over (sender || NUL || timestamp_micros || NUL || kind || NUL ||
// extra) and hex-encoded. Deterministic for the same inputs but in
// practice unique because the timestamp component is always present.
// Used for entities (HarnessTemplate, etc.) that may travel between
// workspaces — `id` is a per-database surrogate and is unstable across
// imports, but `external_id` is the entity's true identity.
fn generate_external_id(ctx: &ReducerContext, kind: &str, extra: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{:?}", ctx.sender()).as_bytes());
    hasher.update(b"\x00");
    hasher.update(
        ctx.timestamp
            .to_micros_since_unix_epoch()
            .to_le_bytes(),
    );
    hasher.update(b"\x00");
    hasher.update(kind.as_bytes());
    hasher.update(b"\x00");
    hasher.update(extra.as_bytes());
    hex::encode(hasher.finalize())
}

// ============================================================
// Principal helpers.
// ============================================================
// During the rev-3 access-rule refactor, `PageAccessRule.principal` and
// `BlockAccessRule.principal` flipped from `Identity` to the typed
// `Principal` enum. These helpers keep the call sites readable while only
// the `WorkspaceMember` variant exists; future variants slot in here.

/// Returns true iff this principal represents the given workspace-member
/// identity. End-user / API-key variants always return `false` today.
fn principal_matches_identity(principal: &Principal, identity: Identity) -> bool {
    match principal {
        Principal::WorkspaceMember(id) => *id == identity,
    }
}

/// Convenience: wrap an `Identity` as a workspace-member principal.
fn workspace_member(identity: Identity) -> Principal {
    Principal::WorkspaceMember(identity)
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
        && endpoint.as_ref().map_or(true, |e| e.trim().is_empty())
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
        .find(&ai_user_id)
        .ok_or("AI user config not found")?;
    let has_api_key = api_key.is_some();
    ctx.db.ai_user_config().id().update(AiUserConfig {
        api_key,
        updated_at: ctx.timestamp,
        ..config
    });
    if let Some(profile) = ctx.db.ai_user_profile().ai_user_id().find(&ai_user_id) {
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

/// Start a new conversation. Today this is called when a human @mentions an
/// AI user in page content (`page_id = Some(...)`, `participant_identities`
/// contains the AI user's Identity), but the same shape supports future
/// channel/DM threads (`page_id = None`, multiple participants).
///
/// The caller's Identity (`ctx.sender()`) is automatically added as the
/// `Initiator` participant in addition to whatever `participant_identities`
/// supplies.
#[reducer]
pub fn create_conversation(
    ctx: &ReducerContext,
    page_id: Option<u64>,
    participant_identities: Vec<Identity>,
) -> Result<(), String> {
    if let Some(pid) = page_id {
        ctx.db.page().id().find(&pid).ok_or("Page not found")?;
    }

    for ident in &participant_identities {
        if *ident == Identity::ZERO {
            return Err("participant_identities must not contain the zero Identity".to_string());
        }
    }

    let conv = ctx.db.conversation().insert(Conversation {
        id: next_conversation_id(ctx),
        page_id,
        initiated_by: ctx.sender(),
        status: ConversationStatus::Active,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        // Default to Private even on public pages — most conversations are
        // thinking, not conclusions. Initiator can expand later.
        visibility: ConversationVisibility::Private,
    });

    let mut seen: Vec<Identity> = Vec::new();
    let initiator = ctx.sender();
    ctx.db.conversation_participant().insert(ConversationParticipant {
        id: next_conversation_participant_id(ctx),
        conversation_id: conv.id,
        identity: initiator,
        role: ParticipantRole::Initiator,
        joined_at: ctx.timestamp,
        last_viewed_message_id: None,
        left_at: None,
    });
    seen.push(initiator);

    for ident in participant_identities {
        if seen.contains(&ident) {
            continue;
        }
        ctx.db.conversation_participant().insert(ConversationParticipant {
            id: next_conversation_participant_id(ctx),
            conversation_id: conv.id,
            identity: ident,
            role: ParticipantRole::Member,
            joined_at: ctx.timestamp,
            last_viewed_message_id: None,
            left_at: None,
        });
        seen.push(ident);
    }

    log::info!(
        "Conversation created: id={}, page={:?}, participants={}",
        conv.id,
        page_id,
        seen.len()
    );
    Ok(())
}

/// Add a message to an active conversation. The sender is *always* derived
/// from `ctx.sender()` — humans, AI users, and any future participant write
/// as themselves. Clients distinguish AI from human by joining against
/// `ai_user_profile.identity`.
///
/// Token fields are zero for human messages — only populate for AI assistant turns.
#[reducer]
pub fn send_message(
    ctx: &ReducerContext,
    conversation_id: u64,
    content: String,
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

    ctx.db.conversation_message().insert(ConversationMessage {
        id: next_conversation_message_id(ctx),
        conversation_id,
        sender: MessageSender::User(ctx.sender()),
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

    let sender_identity = match &msg.sender {
        MessageSender::User(id) => *id,
        MessageSender::System(_) => {
            return Err("Cannot update a system message".to_string());
        }
    };
    if sender_identity != ctx.sender() {
        return Err("Only the original sender can update this message".to_string());
    }
    if ctx
        .db
        .ai_user_profile()
        .identity()
        .find(&sender_identity)
        .is_none()
    {
        return Err("Cannot update a human message".to_string());
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
    // Creating a child page is a write to the parent — guard it.
    if let Some(pid) = parent_id {
        require_page_write(ctx, pid)?;
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
        parent_pk: parent_id.unwrap_or(0),
        is_hidden: false,
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
    require_page_write(ctx, page_id)?;
    if let Some(pid) = new_parent_id {
        require_page_write(ctx, pid)?;
    }
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
                parent_pk: new_parent_id.unwrap_or(0),
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
    require_page_write(ctx, page_id)?;
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
    require_page_write(ctx, page_id)?;
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
    require_page_write(ctx, page_id)?;
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
    require_page_write(ctx, page_id)?;
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
    require_page_write(ctx, page_id)?;
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
    require_page_write(ctx, page_id)?;
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
    require_page_write(ctx, page_id)?;
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
                parent_pk: page.parent_id.unwrap_or(0),
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
    require_page_write(ctx, page_id)?;
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
    require_page_write(ctx, page_id)?;
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

/// Per-task usage telemetry. Workers write a row after each task or conversation
/// response completes. Tracks three dimensions:
///   - task count (implicit: one row = one execution)
///   - LLM tokens (zero for non-LLM automations)
///   - wall-clock time
#[table(accessor = orcha_usage_event, public)]
pub struct OrchaUsageEvent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// The Orcha task this event relates to, or 0 for conversation responses.
    pub task_id: u64,
    /// "orchestrate" | "llm" | "conversation" | custom task types
    pub task_type: String,
    pub agent_id: String,
    /// The AI user whose provider/key was used (if applicable).
    pub ai_user_id: Option<u64>,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub wall_clock_ms: u64,
    pub created_at: Timestamp,
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

/// Record a usage event for a completed task or conversation response.
///
/// Phase A cost-cap surface: when the AI user has a `monthly_token_cap` set,
/// the reducer logs (but does not refuse) the event so the UI can render
/// the warning / hard-stop pills. Refusal happens at task acceptance time
/// in `claim_task`; recording usage *after* the work is done would penalise
/// honest reporting, so we always insert the row.
#[reducer]
pub fn record_usage_event(
    ctx: &ReducerContext,
    task_id: u64,
    task_type: String,
    agent_id: String,
    ai_user_id: Option<u64>,
    tokens_in: u64,
    tokens_out: u64,
    wall_clock_ms: u64,
) -> Result<(), String> {
    if let Some(uid) = ai_user_id {
        if let Some(cap) = ctx
            .db
            .ai_user_config()
            .id()
            .find(uid)
            .and_then(|c| c.monthly_token_cap)
        {
            let used = month_to_date_tokens(ctx, uid);
            let projected = used + tokens_in + tokens_out;
            if projected > cap {
                log::warn!(
                    "[cost] ai_user {} projected to exceed monthly_token_cap ({} > {})",
                    uid,
                    projected,
                    cap,
                );
            } else if projected * 5 >= cap * 4 {
                log::info!(
                    "[cost] ai_user {} at {}% of monthly_token_cap ({} of {})",
                    uid,
                    projected * 100 / cap.max(1),
                    projected,
                    cap,
                );
            }
        }
    }
    ctx.db.orcha_usage_event().insert(OrchaUsageEvent {
        id: next_orcha_usage_event_id(ctx),
        task_id,
        task_type,
        agent_id,
        ai_user_id,
        tokens_in,
        tokens_out,
        wall_clock_ms,
        created_at: ctx.timestamp,
    });
    Ok(())
}

/// Sum tokens_in + tokens_out for `ai_user_id` for the current calendar
/// month (UTC). O(N) over events; for a per-AI-user btree index this drops
/// to O(month-rows) but the ergonomics of `iter().filter` are fine until
/// the table grows past ~10k rows per workspace.
fn month_to_date_tokens(ctx: &ReducerContext, ai_user_id: u64) -> u64 {
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    // Roughly the first of the month at UTC midnight; we err on the side of
    // including a few extra days at month boundaries rather than dropping
    // events the user can see in their dashboard.
    let micros_per_day: i64 = 86_400 * 1_000_000;
    let month_start = now_micros.saturating_sub(31 * micros_per_day);
    ctx.db
        .orcha_usage_event()
        .iter()
        .filter(|e| e.ai_user_id == Some(ai_user_id))
        .filter(|e| e.created_at.to_micros_since_unix_epoch() >= month_start)
        .map(|e| e.tokens_in + e.tokens_out)
        .sum()
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
///
/// `ai_user_identity` must be a freshly minted SpacetimeDB Identity for the new
/// AI user (in pear-cloud, lifecycle mints this; in self-hosted Pear, the
/// extension-install caller must supply one). It's the field RLS keys on for
/// reading the per-AI-user api_key.
fn create_extension_ai_user(
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
        max_tokens: if cb.max_tokens == 0 { 8192 } else { cb.max_tokens },
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        monthly_token_cap: None,
        role: AiUserRole::Standard,
        harness_template_id: None,
        allow_evaluation_sharing: false,
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

/// A `(property_definition_id, value)` pair passed to the atomic row
/// reducers. Tuples aren't `SpacetimeType`, so we wrap them in a struct.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct PropertyValueInput {
    pub property_definition_id: u64,
    pub value: PropertyValue,
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
/// Public table with row-level visibility — only the SHA-256 hash of the
/// key is stored; the raw key is shown once at creation and never
/// persisted.
///
/// RLS (see `API_ENDPOINT_KEY_FILTER` below): each row is visible to the
/// `created_by` identity (the human who minted it) and to module owners
/// (lifecycle / worker / per-workspace service identity used by the API
/// gateway). That lets the workspace UI render label / created_at /
/// last_used_at to the operator who created the key, without leaking
/// those fields to other workspace members.
///
/// Anonymous Bearer-token validation by the API gateway uses the separate
/// `api_endpoint_key_lookup` view below — see its doc comment for why both
/// shapes exist.
///
/// History note: `api_endpoint_key` shipped as `private` through 0.5.1,
/// flipped to `public` in 0.5.2 (no RLS filter, transitional state),
/// then gained the RLS filter in 0.5.3. The split was forced by STDB's
/// WASM publish validator rejecting private→public + add-RLS atomically;
/// see `docs/RUNBOOKS/README.md` for the full history.
#[table(accessor = api_endpoint_key, public)]
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

/// Public projection of `api_endpoint_key` for anonymous Bearer-token
/// validation by the HTTP API gateway.
///
/// Why this still exists after `api_endpoint_key` went public-with-RLS:
/// the gateway authenticates as the per-workspace service identity (NOT
/// the human creator), which is unrelated to any `created_by`. The RLS
/// filter on the real table correctly hides every row from it. This view
/// is anonymous public and bypasses RLS, re-exposing only the fields a
/// Bearer-token check needs (`key_hash`, `endpoint_id`, `allowed_methods`,
/// `expires_at`, plus the row id for audit logging). Callers query it via
/// SQL with a `WHERE key_hash = '…'` filter.
///
/// Security note: `key_hash` is the SHA-256 of a 256-bit random secret, so
/// publishing it in this projection does not let an attacker forge auth — the
/// plaintext token is still required in the `Authorization` header. Fields
/// that DO leak metadata (`label`, `created_by`, `created_at`, `last_used_at`)
/// stay on the underlying table behind RLS.
#[derive(SpacetimeType, Clone, Debug)]
pub struct ApiEndpointKeyLookupRow {
    pub id: u64,
    pub endpoint_id: u64,
    pub key_hash: String,
    pub allowed_methods: Vec<HttpMethod>,
    pub expires_at: Option<Timestamp>,
}

/// Row-level visibility filter for `api_endpoint_key`. Each row is visible
/// to the `created_by` identity (the human who minted the key); module
/// owners (lifecycle / worker / per-workspace gateway service identity)
/// bypass this filter automatically and see every row, which is required
/// for the gateway's bearer-token resolution and for backfills.
///
/// We deliberately do NOT join through `api_endpoint.created_by` here:
/// keys are scoped per-mint, not per-endpoint. If endpoint ownership
/// changes (today there's no UI for this; tomorrow there might be), each
/// minter still controls their own keys until they explicitly revoke.
///
/// **DO NOT remove this filter without also flipping the table back to
/// `private`.** Adding RLS to a table that was `private` in the previous
/// published WASM trips STDB's publish validator with
/// `Cannot define RLS rule on private table` and blocks the upgrade for
/// every workspace on the pool — that's how this filter was forced into
/// its own 0.5.3 release in the first place.
#[client_visibility_filter]
const API_ENDPOINT_KEY_FILTER: Filter = Filter::Sql(
    "SELECT * FROM api_endpoint_key WHERE created_by = :sender",
);

#[view(accessor = api_endpoint_key_lookup, public)]
fn api_endpoint_key_lookup(ctx: &AnonymousViewContext) -> Vec<ApiEndpointKeyLookupRow> {
    // View bodies can't call `.iter()` (the view handle deliberately omits
    // `Table`); we full-scan via the `endpoint_id` btree index with an
    // unbounded range. The materialised vec is then SQL-filterable by callers
    // (`SELECT … WHERE key_hash = '…' AND endpoint_id = …`).
    ctx.db
        .api_endpoint_key()
        .endpoint_id()
        .filter(0u64..)
        .map(|k| ApiEndpointKeyLookupRow {
            id: k.id,
            endpoint_id: k.endpoint_id,
            key_hash: k.key_hash,
            allowed_methods: k.allowed_methods,
            expires_at: k.expires_at,
        })
        .collect()
}

/// Audit log for every external HTTP call made through a custom API endpoint.
/// Public so the workspace UI can render a "Recent calls" panel without
/// admin privileges. Insert-only; older rows are pruned by ops tooling.
#[table(accessor = api_call_log, public)]
pub struct ApiCallLog {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub endpoint_id: u64,
    /// None when the request authenticated via session instead of an API key.
    pub key_id: Option<u64>,
    pub method: HttpMethod,
    /// Original request path (e.g. "/e/fruit/42"). Truncated to 1024 chars.
    pub path: String,
    pub status_code: u16,
    pub latency_ms: u32,
    /// Best-effort caller IP (X-Forwarded-For first hop).
    pub caller_ip: Option<String>,
    /// Short error string when `status_code >= 400`. None on success.
    pub error_message: Option<String>,
    #[index(btree)]
    pub at: Timestamp,
}

/// Idempotency + id-resolution marker for atomic database-row creation
/// from the HTTP handler. Reducers can't return values to HTTP callers,
/// so the handler generates a UUID, passes it as `client_request_id`, and
/// then SQL-queries this table for the resulting `page_id`.
///
/// A second `create_database_row` call with the same key is a no-op.
#[table(accessor = database_row_marker, public)]
pub struct DatabaseRowMarker {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[unique]
    pub client_request_id: String,
    pub page_id: u64,
    pub created_at: Timestamp,
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
fn next_api_call_log_id(ctx: &ReducerContext) -> u64 {
    ctx.db.api_call_log().iter().map(|r| r.id).max().unwrap_or(0) + 1
}
fn next_database_row_marker_id(ctx: &ReducerContext) -> u64 {
    ctx.db.database_row_marker().iter().map(|r| r.id).max().unwrap_or(0) + 1
}

/// Slugs that would collide with system routes the HTTP handler reserves
/// (`/_schema`, `/_health`, `/_meta`) or with namespace conventions an
/// operator might add later. The leading-underscore variants are belt-and-
/// braces — the slug regex below already rejects underscores.
const RESERVED_API_SLUGS: &[&str] = &[
    "_schema", "_health", "_meta", "_admin", "_internal",
    "schema", "health", "meta", "admin", "internal", "system",
    "api", "auth", "openapi", "docs",
];

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
    if slug.starts_with('_') {
        return Err("Slug must not start with an underscore (reserved)".to_string());
    }
    if RESERVED_API_SLUGS.contains(&slug) {
        return Err(format!("Slug '{}' is reserved", slug));
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

    require_creator_or_admin(ctx, endpoint.created_by, "update this endpoint")?;

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

    require_creator_or_admin(ctx, endpoint.created_by, "delete this endpoint")?;

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

    require_creator_or_admin(ctx, endpoint.created_by, "manage field mappings")?;

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

    require_creator_or_admin(ctx, endpoint.created_by, "manage field mappings")?;

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

    require_creator_or_admin(ctx, endpoint.created_by, "manage field mappings")?;

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

    require_creator_or_admin(ctx, endpoint.created_by, "manage API keys")?;

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

    require_creator_or_admin(ctx, endpoint.created_by, "revoke API keys")?;

    ctx.db.api_endpoint_key().id().delete(&key_id);
    Ok(())
}

// ============================================================
// Custom API Endpoints — Atomic row reducers (HTTP-handler facing)
// ============================================================
//
// These reducers exist so the HTTP layer can mutate database rows in a
// single transaction instead of chaining `create_page` + N x
// `set_property_value`. They intentionally do **not** check `created_by`
// ownership — the HTTP handler authenticates the request (session or API
// key) before invoking them and runs as the workspace's service identity.
//
// Reducers can't return values to HTTP callers, so `create_database_row`
// records the new `page_id` against a caller-supplied `client_request_id`
// in `database_row_marker`. The handler then looks up the id via SQL.

/// Atomically create a row in a database page along with all its property values.
///
/// Idempotent on `client_request_id`: a second call with the same key is a
/// no-op (still resolves to the same `page_id` via `database_row_marker`).
#[reducer]
pub fn create_database_row(
    ctx: &ReducerContext,
    database_page_id: u64,
    title: String,
    values: Vec<PropertyValueInput>,
    client_request_id: String,
) -> Result<(), String> {
    if client_request_id.is_empty() || client_request_id.len() > 128 {
        return Err("client_request_id must be 1-128 characters".to_string());
    }
    if title.trim().is_empty() {
        return Err("Title cannot be empty".to_string());
    }

    let database = ctx
        .db
        .page()
        .id()
        .find(&database_page_id)
        .ok_or("Database page not found")?;
    if database.page_type != PageType::Database {
        return Err("Target page must be a Database".to_string());
    }
    if database.deleted_at.is_some() {
        return Err("Cannot create row in a deleted database".to_string());
    }

    if let Some(existing) = ctx
        .db
        .database_row_marker()
        .client_request_id()
        .find(&client_request_id)
    {
        if ctx.db.page().id().find(&existing.page_id).is_some() {
            return Ok(());
        }
    }

    let sort_order = next_sort_order(ctx, Some(database_page_id));
    let row = ctx.db.page().insert(Page {
        id: next_page_id(ctx),
        parent_id: Some(database_page_id),
        sort_order,
        page_type: PageType::Database,
        title,
        icon: None,
        embedding: None,
        created_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
        parent_pk: database_page_id,
        is_hidden: false,
    });
    ctx.db.page_content().insert(PageContent {
        page_id: row.id,
        content: String::new(),
        updated_at: ctx.timestamp,
    });

    for PropertyValueInput {
        property_definition_id,
        value,
    } in values
    {
        ctx.db
            .page_property_value_history()
            .insert(PagePropertyValueHistory {
                id: next_page_property_value_history_id(ctx),
                page_id: row.id,
                property_definition_id,
                value: value.clone(),
                is_current: true,
                changed_at: ctx.timestamp,
                changed_by: ActorType::Human,
            });
        ctx.db.page_property_value().insert(PagePropertyValue {
            id: next_page_property_value_id(ctx),
            page_id: row.id,
            property_definition_id,
            value,
        });
    }

    ctx.db.database_row_marker().insert(DatabaseRowMarker {
        id: next_database_row_marker_id(ctx),
        client_request_id,
        page_id: row.id,
        created_at: ctx.timestamp,
    });

    Ok(())
}

/// Atomically update a row's title and a set of property values.
///
/// `set_values` upserts the given `(property_definition_id, value)` pairs
/// (with full history entries). `clear_values` deletes the current
/// `PagePropertyValue` for the given property ids. Pass `None` for `title`
/// to leave it unchanged.
#[reducer]
pub fn update_database_row(
    ctx: &ReducerContext,
    page_id: u64,
    title: Option<String>,
    set_values: Vec<PropertyValueInput>,
    clear_values: Vec<u64>,
) -> Result<(), String> {
    let row = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    if row.page_type != PageType::Database {
        return Err("Target page must be a database row".to_string());
    }
    if row.deleted_at.is_some() {
        return Err("Cannot update a deleted row".to_string());
    }

    let new_title = match title {
        Some(t) => {
            if t.trim().is_empty() {
                return Err("Title cannot be empty".to_string());
            }
            t
        }
        None => row.title.clone(),
    };

    ctx.db.page().id().update(Page {
        title: new_title,
        updated_at: ctx.timestamp,
        ..row
    });

    for PropertyValueInput {
        property_definition_id,
        value,
    } in set_values
    {
        let stale: Vec<PagePropertyValueHistory> = ctx
            .db
            .page_property_value_history()
            .page_id()
            .filter(&page_id)
            .filter(|h| h.property_definition_id == property_definition_id && h.is_current)
            .collect();
        for h in stale {
            ctx.db
                .page_property_value_history()
                .id()
                .update(PagePropertyValueHistory {
                    is_current: false,
                    ..h
                });
        }
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

        let existing: Option<PagePropertyValue> = ctx
            .db
            .page_property_value()
            .page_id()
            .filter(&page_id)
            .find(|v| v.property_definition_id == property_definition_id);
        match existing {
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
    }

    for property_definition_id in clear_values {
        let existing: Option<PagePropertyValue> = ctx
            .db
            .page_property_value()
            .page_id()
            .filter(&page_id)
            .find(|v| v.property_definition_id == property_definition_id);
        if let Some(pv) = existing {
            ctx.db.page_property_value().id().delete(&pv.id);
        }
    }

    Ok(())
}

/// Soft-delete a database row by setting `deleted_at`.
/// Idempotent — already-deleted rows succeed without modification.
#[reducer]
pub fn delete_database_row(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    let row = ctx
        .db
        .page()
        .id()
        .find(&page_id)
        .ok_or("Page not found")?;
    if row.page_type != PageType::Database {
        return Err("Target page must be a database row".to_string());
    }
    if row.deleted_at.is_some() {
        return Ok(());
    }
    ctx.db.page().id().update(Page {
        deleted_at: Some(ctx.timestamp),
        updated_at: ctx.timestamp,
        ..row
    });
    Ok(())
}

/// Bump `last_used_at` on an API key. Called fire-and-forget by the HTTP
/// handler after a successful authenticated request.
#[reducer]
pub fn touch_api_endpoint_key(ctx: &ReducerContext, key_id: u64) -> Result<(), String> {
    let key = ctx
        .db
        .api_endpoint_key()
        .id()
        .find(&key_id)
        .ok_or("API key not found")?;
    ctx.db.api_endpoint_key().id().update(ApiEndpointKey {
        last_used_at: Some(ctx.timestamp),
        ..key
    });
    Ok(())
}

/// Append an entry to the `ApiCallLog`. Called fire-and-forget by the HTTP
/// handler after every request (success or failure).
#[reducer]
pub fn log_api_call(
    ctx: &ReducerContext,
    endpoint_id: u64,
    key_id: Option<u64>,
    method: HttpMethod,
    path: String,
    status_code: u16,
    latency_ms: u32,
    caller_ip: Option<String>,
    error_message: Option<String>,
) -> Result<(), String> {
    if path.len() > 1024 {
        return Err("path too long".to_string());
    }
    if let Some(ref msg) = error_message {
        if msg.len() > 2048 {
            return Err("error_message too long".to_string());
        }
    }
    ctx.db.api_call_log().insert(ApiCallLog {
        id: next_api_call_log_id(ctx),
        endpoint_id,
        key_id,
        method,
        path,
        status_code,
        latency_ms,
        caller_ip,
        error_message,
        at: ctx.timestamp,
    });
    Ok(())
}

/// Import a `pear-snapshot-v1` JSON file exported from the Pear web app.
/// Only succeeds when the database has **no pages** (empty workspace). Requires an authenticated user.
/// AI users are restored with **stub** private `AiUserConfig` rows (no API keys); reconfigure after import.
#[reducer]
pub fn import_pear_snapshot_v1(ctx: &ReducerContext, snapshot_json: String) -> Result<(), String> {
    pear_import::apply_snapshot(ctx, &snapshot_json)
}

// ============================================================
// Access Control Reducers
// ============================================================
//
// "Mutating the rules of the page" is itself a write on the page. Once a
// page has any rule, only existing writers (or admins) can change the rule
// set — otherwise a single mistake could lock the workspace out. A page
// with zero rules is open, so anyone can install the *first* rule.

fn require_rule_authority(ctx: &ReducerContext, page_id: u64) -> Result<(), String> {
    if !page_has_any_rule(ctx, page_id) {
        return Ok(());
    }
    require_page_write(ctx, page_id)
}

/// Grants `principal` `permission` on `page_id`. Upserts: if a rule already
/// exists for the principal it is replaced (so promoting Read → Write is
/// idempotent and Write → Read is a true demotion).
#[reducer]
pub fn set_page_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    principal: Identity,
    permission: Permission,
) -> Result<(), String> {
    ctx.db.page().id().find(&page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;

    let existing: Vec<PageAccessRule> = ctx
        .db
        .page_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| principal_matches_identity(&r.principal, principal))
        .collect();
    for rule in existing {
        ctx.db.page_access_rule().id().delete(&rule.id);
    }

    ctx.db.page_access_rule().insert(PageAccessRule {
        id: next_page_access_rule_id(ctx),
        page_id,
        principal: workspace_member(principal),
        permission,
        granted_by: ctx.sender(),
        granted_at: ctx.timestamp,
    });
    Ok(())
}

/// Removes any rule for `principal` on `page_id`. If this drops the rule
/// count to zero the page returns to the open model.
#[reducer]
pub fn clear_page_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    principal: Identity,
) -> Result<(), String> {
    ctx.db.page().id().find(&page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;

    let to_delete: Vec<PageAccessRule> = ctx
        .db
        .page_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| principal_matches_identity(&r.principal, principal))
        .collect();
    for rule in to_delete {
        ctx.db.page_access_rule().id().delete(&rule.id);
    }
    Ok(())
}

#[reducer]
pub fn set_block_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    block_id: String,
    principal: Identity,
    permission: Permission,
) -> Result<(), String> {
    if block_id.trim().is_empty() {
        return Err("block_id cannot be empty".to_string());
    }
    ctx.db.page().id().find(&page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;

    let existing: Vec<BlockAccessRule> = ctx
        .db
        .block_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| {
            r.block_id == block_id && principal_matches_identity(&r.principal, principal)
        })
        .collect();
    for rule in existing {
        ctx.db.block_access_rule().id().delete(&rule.id);
    }

    ctx.db.block_access_rule().insert(BlockAccessRule {
        id: next_block_access_rule_id(ctx),
        page_id,
        block_id,
        principal: workspace_member(principal),
        permission,
        granted_by: ctx.sender(),
        granted_at: ctx.timestamp,
    });
    Ok(())
}

#[reducer]
pub fn clear_block_access_rule(
    ctx: &ReducerContext,
    page_id: u64,
    block_id: String,
    principal: Identity,
) -> Result<(), String> {
    ctx.db.page().id().find(&page_id).ok_or("Page not found")?;
    require_rule_authority(ctx, page_id)?;
    let to_delete: Vec<BlockAccessRule> = ctx
        .db
        .block_access_rule()
        .page_id()
        .filter(&page_id)
        .filter(|r| {
            r.block_id == block_id && principal_matches_identity(&r.principal, principal)
        })
        .collect();
    for rule in to_delete {
        ctx.db.block_access_rule().id().delete(&rule.id);
    }
    Ok(())
}

/// Toggles the sidebar/search visibility hint on a page (used to host
/// AI-user memory subtrees, etc.). Requires write access.
#[reducer]
pub fn set_page_hidden(
    ctx: &ReducerContext,
    page_id: u64,
    hidden: bool,
) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let page = ctx.db.page().id().find(&page_id).ok_or("Page not found")?;
    ctx.db.page().id().update(Page {
        is_hidden: hidden,
        updated_at: ctx.timestamp,
        ..page
    });
    Ok(())
}

// ============================================================
// Conversation Visibility & Participant State
// ============================================================

fn visibility_rank(v: &ConversationVisibility) -> u8 {
    match v {
        ConversationVisibility::Private => 0,
        ConversationVisibility::Participants => 1,
        ConversationVisibility::PageInheriting => 2,
    }
}

/// Expands the visibility of a conversation. Visibility is monotonically
/// expanding — `Private` → `Participants` → `PageInheriting` only.
/// Re-narrowing would retroactively hide messages the new excluded
/// principal already saw, which is not honest behavior; do `close` +
/// `create_new` instead.
#[reducer]
pub fn set_conversation_visibility(
    ctx: &ReducerContext,
    conversation_id: u64,
    visibility: ConversationVisibility,
) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(&conversation_id)
        .ok_or("Conversation not found")?;

    if conv.initiated_by != ctx.sender() && !sender_is_admin(ctx) {
        return Err("Only the initiator or an admin can change visibility".to_string());
    }

    if matches!(visibility, ConversationVisibility::PageInheriting) && conv.page_id.is_none() {
        return Err("Detached conversations cannot use PageInheriting visibility".to_string());
    }

    if visibility_rank(&visibility) < visibility_rank(&conv.visibility) {
        return Err(format!(
            "Visibility cannot contract ({:?} -> {:?}); start a new conversation instead",
            conv.visibility, visibility
        ));
    }

    ctx.db.conversation().id().update(Conversation {
        visibility,
        updated_at: ctx.timestamp,
        ..conv
    });
    Ok(())
}

/// Mark this caller as having read up to `message_id`. Drives unread
/// counts in Inbox mode.
#[reducer]
pub fn mark_conversation_read(
    ctx: &ReducerContext,
    conversation_id: u64,
    message_id: u64,
) -> Result<(), String> {
    let participant = ctx
        .db
        .conversation_participant()
        .conversation_id()
        .filter(&conversation_id)
        .find(|p| p.identity == ctx.sender() && p.left_at.is_none())
        .ok_or("Caller is not an active participant")?;

    ctx.db
        .conversation_participant()
        .id()
        .update(ConversationParticipant {
            last_viewed_message_id: Some(message_id),
            ..participant
        });
    Ok(())
}

/// Add a participant to an existing conversation. Promotes visibility to
/// at least `Participants` (because the new addition wouldn't see anything
/// otherwise).
#[reducer]
pub fn add_conversation_participant(
    ctx: &ReducerContext,
    conversation_id: u64,
    identity: Identity,
) -> Result<(), String> {
    if identity == Identity::ZERO {
        return Err("Cannot add the zero Identity".to_string());
    }
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(&conversation_id)
        .ok_or("Conversation not found")?;
    if conv.initiated_by != ctx.sender() && !sender_is_admin(ctx) {
        return Err("Only the initiator or an admin can add participants".to_string());
    }

    let existing = ctx
        .db
        .conversation_participant()
        .conversation_id()
        .filter(&conversation_id)
        .any(|p| p.identity == identity && p.left_at.is_none());
    if existing {
        return Ok(());
    }

    ctx.db.conversation_participant().insert(ConversationParticipant {
        id: next_conversation_participant_id(ctx),
        conversation_id,
        identity,
        role: ParticipantRole::Member,
        joined_at: ctx.timestamp,
        last_viewed_message_id: None,
        left_at: None,
    });

    if visibility_rank(&conv.visibility) < visibility_rank(&ConversationVisibility::Participants) {
        ctx.db.conversation().id().update(Conversation {
            visibility: ConversationVisibility::Participants,
            updated_at: ctx.timestamp,
            ..conv
        });
    }
    Ok(())
}

// ============================================================
// AI Evaluation Reducers (Phase B primitives)
// ============================================================

/// Persist a fresh evaluation result and (atomically) update the
/// `PagePropertyValue` on the row to point at it. Workers call this from
/// the `ai_primitive` task handler; the worker is responsible for output
/// schema validation before invocation.
#[reducer]
pub fn record_ai_evaluation(
    ctx: &ReducerContext,
    property_definition_id: u64,
    page_id: u64,
    input_hash: String,
    primitive: AiPrimitive,
    model: String,
    prompt_version: u32,
    output: String,
    input_tokens: u32,
    output_tokens: u32,
    cost_microcents: u64,
    wall_clock_ms: u32,
    ai_user_identity: Identity,
) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    ctx.db
        .property_definition()
        .id()
        .find(&property_definition_id)
        .ok_or("PropertyDefinition not found")?;

    // Mark any prior evaluation rows for this (property, page) stale.
    let prior: Vec<AiEvaluation> = ctx
        .db
        .ai_evaluation()
        .property_definition_id()
        .filter(&property_definition_id)
        .filter(|r| r.page_id == page_id && !r.is_stale)
        .collect();
    for row in prior {
        ctx.db
            .ai_evaluation()
            .id()
            .update(AiEvaluation { is_stale: true, ..row });
    }

    let row = ctx.db.ai_evaluation().insert(AiEvaluation {
        id: next_ai_evaluation_id(ctx),
        property_definition_id,
        page_id,
        input_hash,
        primitive,
        model,
        prompt_version,
        output: output.clone(),
        input_tokens,
        output_tokens,
        cost_microcents,
        wall_clock_ms,
        created_at: ctx.timestamp,
        ai_user_identity,
        is_stale: false,
    });

    set_property_value_inner(
        ctx,
        page_id,
        property_definition_id,
        PropertyValue::Ai(AiPropertyValue {
            output,
            evaluation_id: row.id,
            is_stale: false,
        }),
    )
}

/// Internal upsert used by both the human-driven `set_property_value` and
/// the AI-driven `record_ai_evaluation`. Skips the access guard because
/// callers already enforce it (and AI evaluations may run under a service
/// identity).
fn set_property_value_inner(
    ctx: &ReducerContext,
    page_id: u64,
    property_definition_id: u64,
    value: PropertyValue,
) -> Result<(), String> {
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
    ctx.db
        .page_property_value_history()
        .insert(PagePropertyValueHistory {
            id: next_page_property_value_history_id(ctx),
            page_id,
            property_definition_id,
            value: value.clone(),
            is_current: true,
            changed_at: ctx.timestamp,
            changed_by: ActorType::Agent("ai-primitive".to_string()),
        });
    let existing: Option<PagePropertyValue> = ctx
        .db
        .page_property_value()
        .page_id()
        .filter(&page_id)
        .find(|v| v.property_definition_id == property_definition_id);
    match existing {
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

/// Mark every `AiEvaluation` for `(property_definition_id, page_id)` as
/// stale. Called when an upstream input column changes (the worker
/// scheduler reads this to know what to recompute under
/// `InvalidationPolicy::OnInputChange`).
#[reducer]
pub fn invalidate_ai_evaluations_for_row(
    ctx: &ReducerContext,
    property_definition_id: u64,
    page_id: u64,
) -> Result<(), String> {
    require_page_write(ctx, page_id)?;
    let live: Vec<AiEvaluation> = ctx
        .db
        .ai_evaluation()
        .property_definition_id()
        .filter(&property_definition_id)
        .filter(|r| r.page_id == page_id && !r.is_stale)
        .collect();
    for row in live {
        ctx.db
            .ai_evaluation()
            .id()
            .update(AiEvaluation { is_stale: true, ..row });
    }
    Ok(())
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
            .find(&template_id)
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
        .find(&template_id)
        .ok_or("HarnessTemplate not found")?;
    if matches!(existing.source, HarnessTemplateSource::Builtin) {
        return Err("Builtin templates cannot be deleted".to_string());
    }
    ctx.db.harness_template().id().delete(&template_id);
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
        .find(&reviewer_ai_user_id)
        .ok_or("Reviewer AI user not found")?;
    if !matches!(reviewer.role, AiUserRole::Reviewer) {
        return Err("Selected AI user is not a reviewer".to_string());
    }
    if let ReviewSubject::AiUser(subject_ai_user_id) = subject {
        if ctx
            .db
            .ai_user_config()
            .id()
            .find(&subject_ai_user_id)
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
        .find(&binding_id)
        .ok_or("Binding not found")?;
    require_creator_or_admin(ctx, binding.created_by, "delete review bindings")?;
    ctx.db.review_agent_binding().id().delete(&binding_id);
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
        .find(&snapshot_id)
        .ok_or("Snapshot not found")?;
    ctx.db
        .ai_user_config()
        .id()
        .find(&reviewer_ai_user_id)
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
        .find(&ai_user_id)
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
        .find(&binding_id)
        .ok_or("Binding not found")?;
    let ai_user = ctx
        .db
        .ai_user_config()
        .id()
        .find(&binding.ai_user_id)
        .ok_or("AI user not found")?;
    require_creator_or_admin(ctx, ai_user.created_by, "revoke auto-apply")?;
    ctx.db.auto_apply_binding().id().delete(&binding_id);
    Ok(())
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
            ctx.db.user_preference().id().delete(&existing.id);
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

/// Provision the per-AI-user memory subtree. Idempotent — returns OK if
/// the row already exists. The subtree root is created with
/// `is_hidden = true` so it never shows up in regular sidebar nav.
#[reducer]
pub fn provision_ai_user_memory(ctx: &ReducerContext, ai_user_id: u64) -> Result<(), String> {
    let ai_user = ctx
        .db
        .ai_user_config()
        .id()
        .find(&ai_user_id)
        .ok_or("AI user not found")?;
    require_creator_or_admin(ctx, ai_user.created_by, "provision memory")?;

    if ctx
        .db
        .ai_user_memory()
        .ai_user_id()
        .find(&ai_user_id)
        .is_some()
    {
        return Ok(());
    }

    let profile = ctx
        .db
        .ai_user_profile()
        .ai_user_id()
        .find(&ai_user_id)
        .ok_or("AI user profile missing")?;

    let root = ctx.db.page().insert(Page {
        id: next_page_id(ctx),
        parent_id: None,
        sort_order: next_sort_order(ctx, None),
        page_type: PageType::Doc,
        title: format!("Memory · {}", profile.display_name),
        icon: Some("brain".to_string()),
        embedding: None,
        created_by: ActorType::Agent("memory".to_string()),
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
        parent_pk: 0,
        is_hidden: true,
    });
    ctx.db.page_content().insert(PageContent {
        page_id: root.id,
        content: String::new(),
        updated_at: ctx.timestamp,
    });
    ctx.db.ai_user_memory().insert(AiUserMemory {
        id: next_ai_user_memory_id(ctx),
        ai_user_id,
        root_page_id: root.id,
        working_page_id: None,
        long_term_page_id: None,
        created_at: ctx.timestamp,
        last_consolidated_at: None,
    });
    Ok(())
}

/// Marks a participant as having left (rather than deleting the row, so
/// the audit trail of who saw what is preserved).
#[reducer]
pub fn remove_conversation_participant(
    ctx: &ReducerContext,
    conversation_id: u64,
    identity: Identity,
) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(&conversation_id)
        .ok_or("Conversation not found")?;
    let is_self = identity == ctx.sender();
    if !is_self && conv.initiated_by != ctx.sender() && !sender_is_admin(ctx) {
        return Err("Only the initiator, admin, or the participant themselves can remove".to_string());
    }
    let participant = ctx
        .db
        .conversation_participant()
        .conversation_id()
        .filter(&conversation_id)
        .find(|p| p.identity == identity && p.left_at.is_none())
        .ok_or("Active participant not found")?;
    ctx.db.conversation_participant().id().update(ConversationParticipant {
        left_at: Some(ctx.timestamp),
        ..participant
    });
    Ok(())
}

// ============================================================
// Structural Sensors
// ============================================================
//
// Computational structural sensors are cheap deterministic checks over the
// relational substrate. An Orcha worker invokes the corresponding `run_*`
// reducer on a schedule (cron-style; see `worker/src/structural-sensors.ts`)
// and the reducer (re-)writes findings into `structural_sensor_finding`.
//
// Each sensor follows the same upsert pattern: clear prior unresolved
// findings for that `sensor_kind`, then re-insert the current snapshot.
// This keeps the table size proportional to live findings, not to runs.

fn upsert_finding(
    ctx: &ReducerContext,
    sensor_kind: &str,
    code: &str,
    target_kind: &str,
    target_id: u64,
    severity: &str,
    message: String,
    details_json: String,
) {
    if !sensor_registry_contains(ctx, sensor_kind, code) {
        log::warn!(
            "upsert_finding: ({sensor_kind}, {code}) not in SensorRegistry; skipping"
        );
        return;
    }
    let existing = ctx
        .db
        .structural_sensor_finding()
        .iter()
        .find(|f| {
            f.sensor_kind == sensor_kind
                && f.code == code
                && f.target_kind == target_kind
                && f.target_id == target_id
                && f.resolved_at.is_none()
        });
    if let Some(prior) = existing {
        ctx.db
            .structural_sensor_finding()
            .id()
            .update(StructuralSensorFinding {
                last_seen_at: ctx.timestamp,
                message,
                severity: severity.to_string(),
                details_json,
                ..prior
            });
    } else {
        ctx.db
            .structural_sensor_finding()
            .insert(StructuralSensorFinding {
                id: next_structural_sensor_finding_id(ctx),
                sensor_kind: sensor_kind.to_string(),
                code: code.to_string(),
                target_kind: target_kind.to_string(),
                target_id,
                message,
                severity: severity.to_string(),
                details_json,
                created_at: ctx.timestamp,
                last_seen_at: ctx.timestamp,
                resolved_at: None,
            });
    }
}

/// Mark all live findings for `sensor_kind` whose `last_seen_at` is older
/// than this run as resolved (they didn't reproduce). Call once at the end
/// of every sensor run, with `run_started_at` captured before the upserts.
fn auto_resolve_stale_findings(
    ctx: &ReducerContext,
    sensor_kind: &str,
    run_started_at: Timestamp,
) {
    let stale: Vec<_> = ctx
        .db
        .structural_sensor_finding()
        .iter()
        .filter(|f| {
            f.sensor_kind == sensor_kind
                && f.resolved_at.is_none()
                && f.last_seen_at.to_micros_since_unix_epoch()
                    < run_started_at.to_micros_since_unix_epoch()
        })
        .collect();
    for f in stale {
        ctx.db
            .structural_sensor_finding()
            .id()
            .update(StructuralSensorFinding {
                resolved_at: Some(ctx.timestamp),
                ..f
            });
    }
}

/// Orphan detector: pages whose `parent_id` references a deleted or
/// missing parent. (Top-level pages with `parent_id = None` are not
/// orphans — they are roots.)
#[reducer]
pub fn run_orphan_detector(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to run orphan detector".to_string());
    }
    let run_started_at = ctx.timestamp;
    let kind = "orphan_detector";

    let live_page_ids: std::collections::HashSet<u64> = ctx
        .db
        .page()
        .iter()
        .filter(|p| p.deleted_at.is_none())
        .map(|p| p.id)
        .collect();

    for page in ctx.db.page().iter().filter(|p| p.deleted_at.is_none()) {
        if let Some(parent_id) = page.parent_id {
            if !live_page_ids.contains(&parent_id) {
                upsert_finding(
                    ctx,
                    kind,
                    "page_parent_missing",
                    "page",
                    page.id,
                    "warn",
                    format!(
                        "Page #{} ({}) references missing parent #{}",
                        page.id, page.title, parent_id
                    ),
                    format!(
                        "{{\"page_id\":{},\"parent_id\":{}}}",
                        page.id, parent_id
                    ),
                );
            }
        }
    }

    auto_resolve_stale_findings(ctx, kind, run_started_at);
    Ok(())
}

/// Relational integrity sensor: `PropertyValue::Relation(Vec<u64>)` entries
/// that point to deleted or missing pages.
#[reducer]
pub fn run_relational_integrity_sensor(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to run relational integrity sensor".to_string());
    }
    let run_started_at = ctx.timestamp;
    let kind = "relational_integrity";

    let live_page_ids: std::collections::HashSet<u64> = ctx
        .db
        .page()
        .iter()
        .filter(|p| p.deleted_at.is_none())
        .map(|p| p.id)
        .collect();

    for ppv in ctx.db.page_property_value().iter() {
        if let PropertyValue::Relation(targets) = &ppv.value {
            let dangling: Vec<u64> = targets
                .iter()
                .copied()
                .filter(|t| !live_page_ids.contains(t))
                .collect();
            if !dangling.is_empty() {
                upsert_finding(
                    ctx,
                    kind,
                    "relation_dangling",
                    "page_property_value",
                    ppv.id,
                    "warn",
                    format!(
                        "Relation on page #{} property #{} references {} missing page(s)",
                        ppv.page_id,
                        ppv.property_definition_id,
                        dangling.len()
                    ),
                    format!(
                        "{{\"page_id\":{},\"property_definition_id\":{},\"missing\":{:?}}}",
                        ppv.page_id, ppv.property_definition_id, dangling
                    ),
                );
            }
        }
    }

    auto_resolve_stale_findings(ctx, kind, run_started_at);
    Ok(())
}

/// Schema consistency sensor: `PagePropertyValue` rows whose `value` variant
/// does not match their `PropertyDefinition.property_type`. Catches stale
/// rows after a column type change.
#[reducer]
pub fn run_schema_consistency_sensor(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to run schema consistency sensor".to_string());
    }
    let run_started_at = ctx.timestamp;
    let kind = "schema_consistency";

    let defs: std::collections::HashMap<u64, PropertyType> = ctx
        .db
        .property_definition()
        .iter()
        .map(|d| (d.id, d.property_type))
        .collect();

    for ppv in ctx.db.page_property_value().iter() {
        let Some(expected) = defs.get(&ppv.property_definition_id) else {
            upsert_finding(
                ctx,
                kind,
                "property_definition_missing",
                "page_property_value",
                ppv.id,
                "error",
                format!(
                    "Property value #{} (page #{}) has no matching definition #{}",
                    ppv.id, ppv.page_id, ppv.property_definition_id
                ),
                format!(
                    "{{\"page_id\":{},\"property_definition_id\":{}}}",
                    ppv.page_id, ppv.property_definition_id
                ),
            );
            continue;
        };

        let actual_tag = match &ppv.value {
            PropertyValue::Text(_) => PropertyType::Text,
            PropertyValue::Number(_) => PropertyType::Number,
            PropertyValue::Date(_) => PropertyType::Date,
            PropertyValue::Select(_) => PropertyType::Select,
            PropertyValue::MultiSelect(_) => PropertyType::MultiSelect,
            PropertyValue::Relation(_) => PropertyType::Relation,
            PropertyValue::Checkbox(_) => PropertyType::Checkbox,
            PropertyValue::Url(_) => PropertyType::Url,
            PropertyValue::Person(_) => PropertyType::Person,
            PropertyValue::Ai(_) => PropertyType::Ai,
        };

        if &actual_tag != expected {
            upsert_finding(
                ctx,
                kind,
                "property_type_mismatch",
                "page_property_value",
                ppv.id,
                "warn",
                format!(
                    "Property value #{} (page #{}) is {:?} but definition #{} expects {:?}",
                    ppv.id, ppv.page_id, actual_tag, ppv.property_definition_id, expected
                ),
                format!(
                    "{{\"page_id\":{},\"property_definition_id\":{},\"actual\":\"{:?}\",\"expected\":\"{:?}\"}}",
                    ppv.page_id, ppv.property_definition_id, actual_tag, expected
                ),
            );
        }
    }

    auto_resolve_stale_findings(ctx, kind, run_started_at);
    Ok(())
}

/// Convention sensor: workspace-wide naming / structural conventions. Today
/// it flags property definitions with empty names and database schemas that
/// have zero columns. Operators can extend this to enforce custom conventions.
#[reducer]
pub fn run_convention_sensor(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to run convention sensor".to_string());
    }
    let run_started_at = ctx.timestamp;
    let kind = "convention";

    for def in ctx.db.property_definition().iter() {
        if def.name.trim().is_empty() {
            upsert_finding(
                ctx,
                kind,
                "property_definition_unnamed",
                "property_definition",
                def.id,
                "info",
                format!(
                    "Property definition #{} (schema #{}) has an empty name",
                    def.id, def.schema_id
                ),
                format!("{{\"schema_id\":{}}}", def.schema_id),
            );
        }
    }

    let mut counts: std::collections::HashMap<u64, u32> =
        std::collections::HashMap::new();
    for def in ctx.db.property_definition().iter() {
        *counts.entry(def.schema_id).or_insert(0) += 1;
    }
    for schema in ctx.db.database_schema().iter() {
        if counts.get(&schema.id).copied().unwrap_or(0) == 0 {
            upsert_finding(
                ctx,
                kind,
                "schema_no_columns",
                "database_schema",
                schema.id,
                "info",
                format!(
                    "Database schema #{} ({}) has zero columns",
                    schema.id, schema.name
                ),
                format!("{{\"page_id\":{}}}", schema.page_id),
            );
        }
    }

    auto_resolve_stale_findings(ctx, kind, run_started_at);
    Ok(())
}

/// Refine-permissions sensor (steering loop). Mines the private
/// `tool_call_audit_log` for `outcome = "denied"` entries, groups by
/// `(agent_id, tool_name)`, and emits one finding per group. Surfaces
/// in the same Inbox feed so operators can grant the missing permission
/// (or confirm the denial was correct) without poking at the audit log
/// directly.
#[reducer]
pub fn run_denied_tool_calls_sensor(ctx: &ReducerContext) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to run denied tool calls sensor".to_string());
    }
    let run_started_at = ctx.timestamp;
    let kind = "denied_tool_calls";

    let mut counts: std::collections::HashMap<(String, String), (u64, Timestamp)> =
        std::collections::HashMap::new();
    for entry in ctx.db.tool_call_audit_log().iter() {
        if entry.outcome != "denied" {
            continue;
        }
        let key = (entry.agent_id.clone(), entry.tool_name.clone());
        let slot = counts
            .entry(key)
            .or_insert((0u64, entry.called_at));
        slot.0 += 1;
        if entry.called_at.to_micros_since_unix_epoch()
            > slot.1.to_micros_since_unix_epoch()
        {
            slot.1 = entry.called_at;
        }
    }

    for ((agent_id, tool_name), (count, last_at)) in counts {
        let target_id_hash = stable_hash_pair(&agent_id, &tool_name);
        upsert_finding(
            ctx,
            kind,
            "tool_denied",
            "agent_tool",
            target_id_hash,
            "info",
            format!(
                "Agent `{}` was denied `{}` {} time(s) (last at {})",
                agent_id,
                tool_name,
                count,
                last_at.to_micros_since_unix_epoch(),
            ),
            format!(
                "{{\"agent_id\":{:?},\"tool_name\":{:?},\"count\":{}}}",
                agent_id, tool_name, count
            ),
        );
    }

    auto_resolve_stale_findings(ctx, kind, run_started_at);
    Ok(())
}

fn stable_hash_pair(a: &str, b: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    a.hash(&mut h);
    b.hash(&mut h);
    h.finish()
}

/// Steering loop: turn an in-the-moment correction into a durable
/// instruction page. Creates a `Doc` page with the given title and content
/// under `parent_page_id` (caller chooses an "Instructions" parent to keep
/// them organised). The page is a regular Doc — instruction discovery is a
/// worker concern (it walks the parent subtree).
#[reducer]
pub fn promote_to_instruction(
    ctx: &ReducerContext,
    parent_page_id: u64,
    title: String,
    content: String,
) -> Result<(), String> {
    let parent = ctx
        .db
        .page()
        .id()
        .find(&parent_page_id)
        .ok_or("Parent page not found")?;
    if parent.deleted_at.is_some() {
        return Err("Parent page is deleted".to_string());
    }
    if !can_write_page(ctx, parent_page_id, ctx.sender()) {
        return Err("missing write permission on parent page".to_string());
    }

    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Err("Title required".to_string());
    }

    let new_page = ctx.db.page().insert(Page {
        id: next_page_id(ctx),
        parent_id: Some(parent_page_id),
        sort_order: next_sort_order(ctx, Some(parent_page_id)),
        page_type: PageType::Doc,
        title: trimmed_title.to_string(),
        icon: Some("📌".to_string()),
        embedding: None,
        created_by: ActorType::Human,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
        parent_pk: parent_page_id,
        is_hidden: false,
    });
    ctx.db.page_content().insert(PageContent {
        page_id: new_page.id,
        content,
        updated_at: ctx.timestamp,
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
        .find(&ai_user_id)
        .ok_or("AI user not found")?;
    require_creator_or_admin(ctx, cfg.created_by, "toggle allow_evaluation_sharing")?;
    ctx.db.ai_user_config().id().update(AiUserConfig {
        allow_evaluation_sharing: allow,
        updated_at: ctx.timestamp,
        ..cfg
    });
    Ok(())
}

/// Manually mark a finding as resolved (e.g. when the user fixes the
/// underlying issue and wants to clear the inbox entry).
#[reducer]
pub fn resolve_structural_finding(ctx: &ReducerContext, finding_id: u64) -> Result<(), String> {
    if !sender_is_admin(ctx) {
        return Err("admin required to resolve structural finding".to_string());
    }
    let f = ctx
        .db
        .structural_sensor_finding()
        .id()
        .find(&finding_id)
        .ok_or("Finding not found")?;
    ctx.db
        .structural_sensor_finding()
        .id()
        .update(StructuralSensorFinding {
            resolved_at: Some(ctx.timestamp),
            ..f
        });
    Ok(())
}
