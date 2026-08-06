//! Conversation threads, messages, and participant join rows. Messages
//! can be attached to a page (today's @mention flow) or detached (future
//! channel/DM threads).

use spacetimedb::{
    client_visibility_filter, reducer, table, Filter, Identity, ReducerContext, SpacetimeType,
    Table, Timestamp,
};

use crate::access_control::helpers::require_page_write;
use crate::ai::ai_user_profile;
use crate::auth::user;
use crate::id_counters::alloc_id;
use crate::pages::page;

/// Resolve `@name` spans in `content` to AI-user and human identities.
///
/// Server-side on purpose. Addressing drives AI-to-AI wake gating (and, later,
/// notifications), so there must be exactly one implementation — a client and a
/// worker each parsing their own way would drift, and a mention that resolves
/// differently depending on who sent it is a bug nobody can reproduce. Doing it
/// here also means humans get structured mentions with no client changes at all.
///
/// Longest name first so `@Kiran` beats `@Kira`, and a match must not run into
/// another word character, which is what stops `@Kira` claiming `@Kiran`.
/// Substring matching alone fires on the wrong agent, and a brake that fires on
/// the wrong agent is not a brake.
pub(crate) fn resolve_mentions_in_content(
    ctx: &ReducerContext,
    content: &str,
) -> Vec<Identity> {
    let ai_profiles: Vec<(String, Identity)> = ctx
        .db
        .ai_user_profile()
        .iter()
        .map(|p| (p.display_name.clone(), p.identity))
        .collect();
    let human_users: Vec<(String, Identity)> = ctx
        .db
        .user()
        .iter()
        .map(|u| (u.name.clone(), u.identity))
        .collect();
    match_mentions(content, merge_mention_candidates(ai_profiles, human_users))
}

/// Merge the two mention namespaces while making the collision rule explicit:
/// an AI display name wins over a case-insensitively identical human name.
fn merge_mention_candidates(
    ai_profiles: Vec<(String, Identity)>,
    human_users: Vec<(String, Identity)>,
) -> Vec<(String, Identity)> {
    let mut candidates: Vec<(String, Identity)> = ai_profiles
        .into_iter()
        .filter(|(name, _)| !name.trim().is_empty())
        .collect();
    let ai_match_names: Vec<String> = candidates
        .iter()
        .map(|(name, _)| name.to_lowercase())
        .collect();

    candidates.extend(human_users.into_iter().filter(|(name, _)| {
        !name.trim().is_empty() && !ai_match_names.contains(&name.to_lowercase())
    }));
    candidates
}

/// The matcher itself, split from table access so it is unit-testable without a
/// `ReducerContext`.
pub(crate) fn match_mentions(
    content: &str,
    profiles: Vec<(String, Identity)>,
) -> Vec<Identity> {
    let lower = content.to_lowercase();

    let mut profiles: Vec<(String, Identity)> = profiles
        .into_iter()
        .filter(|(name, _)| !name.trim().is_empty())
        .map(|(name, id)| (name.to_lowercase(), id))
        .collect();
    profiles.sort_by(|a, b| b.0.len().cmp(&a.0.len()));

    let mut claimed: Vec<(usize, usize)> = Vec::new();
    let mut out: Vec<Identity> = Vec::new();

    for (name, identity) in profiles {
        let needle = format!("@{name}");
        let mut from = 0usize;
        while let Some(rel) = lower[from..].find(&needle) {
            let start = from + rel;
            let end = start + needle.len();
            from = end;

            // Reject when the name runs into more word characters.
            let runs_on = lower[end..]
                .chars()
                .next()
                .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '-');
            if runs_on {
                continue;
            }
            // Reject overlaps with a longer name already matched here.
            if claimed.iter().any(|(s, e)| start < *e && end > *s) {
                continue;
            }
            claimed.push((start, end));
            if !out.contains(&identity) {
                out.push(identity);
            }
            break;
        }
    }
    out
}

/// Choose which AI participants should consider a new human message.
///
/// This is deliberately deterministic. Semantic group arbitration can replace
/// the ambiguous fallback later, but the routing decision must already be
/// shared and durable before any independent AI worker posts a placeholder.
///
/// Priority:
/// 1. Explicit AI mentions (and only those mentions).
/// 2. The AI who authored the immediately preceding terminal message.
/// 3. The targets already chosen for an immediately preceding human message
///    (rapid messages sent while the selected AI is still working).
/// 4. The first/oldest active AI participant supplied by the caller.
pub(crate) fn choose_human_response_targets(
    explicit_mentions: &[Identity],
    ai_identities: &[Identity],
    active_ai_participants: &[Identity],
    previous_ai_sender: Option<Identity>,
    previous_response_targets: Option<&[Identity]>,
) -> Vec<Identity> {
    let active = |identity: &Identity| active_ai_participants.contains(identity);
    let filtered_unique = |identities: &[Identity]| {
        let mut out = Vec::new();
        for identity in identities {
            if active(identity) && !out.contains(identity) {
                out.push(*identity);
            }
        }
        out
    };

    // Only AI mentions are routing instructions. Human mentions are durable
    // annotation data, but must not suppress the normal AI fallback. Fail
    // closed when a named AI is not in this thread instead of waking unrelated
    // participants.
    let explicit_ai_mentions: Vec<Identity> = explicit_mentions
        .iter()
        .filter(|identity| ai_identities.contains(identity))
        .copied()
        .collect();
    if !explicit_ai_mentions.is_empty() {
        return filtered_unique(&explicit_ai_mentions);
    }

    if let Some(identity) = previous_ai_sender {
        if active(&identity) {
            return vec![identity];
        }
    }

    if let Some(previous) = previous_response_targets {
        let inherited = filtered_unique(previous);
        if !inherited.is_empty() {
            return inherited;
        }
    }

    active_ai_participants
        .first()
        .copied()
        .into_iter()
        .collect()
}

fn is_ai_user(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db
        .ai_user_profile()
        .identity()
        .find(identity)
        .is_some()
}

/// Resolve and persist the responder assignment for a human-authored message.
///
/// Active AI participants are sorted by join time so the fallback remains the
/// thread's original AI rather than depending on table iteration order.
fn human_response_targets(
    ctx: &ReducerContext,
    conversation_id: u64,
    explicit_mentions: &[Identity],
) -> Vec<Identity> {
    let ai_identities: Vec<Identity> = ctx
        .db
        .ai_user_profile()
        .iter()
        .map(|profile| profile.identity)
        .collect();
    let mut active_ai_rows: Vec<_> = ctx
        .db
        .conversation_participant()
        .conversation_id()
        .filter(&conversation_id)
        .filter(|participant| {
            participant.left_at.is_none()
                && ai_identities.contains(&participant.identity)
        })
        .collect();
    active_ai_rows.sort_by_key(|participant| {
        (
            participant.joined_at.to_micros_since_unix_epoch(),
            participant.id,
        )
    });
    let active_ai_participants: Vec<Identity> = active_ai_rows
        .iter()
        .map(|participant| participant.identity)
        .collect();

    let previous = ctx
        .db
        .conversation_message()
        .conversation_id()
        .filter(&conversation_id)
        .filter(|message| {
            matches!(message.sender, MessageSender::User(_))
                && matches!(
                    message.status,
                    MessageStatus::Complete | MessageStatus::Error
                )
        })
        .max_by_key(|message| {
            (
                message.created_at.to_micros_since_unix_epoch(),
                message.id,
            )
        });

    let mut previous_ai_sender = None;
    let mut previous_response_targets = None;
    if let Some(previous) = &previous {
        if let MessageSender::User(identity) = previous.sender {
            if ai_identities.contains(&identity) {
                previous_ai_sender = Some(identity);
            } else {
                previous_response_targets = previous.response_targets.as_deref();
            }
        }
    }

    choose_human_response_targets(
        explicit_mentions,
        &ai_identities,
        &active_ai_participants,
        previous_ai_sender,
        previous_response_targets,
    )
}

/// True when `identity` is a *current* participant of `conversation_id`.
///
/// Excludes members who have left. Removal is honest — the row stays for the
/// audit trail (`left_at`) — so a membership check that ignored it would keep
/// granting authority to someone already removed from the thread. Matches the
/// filtering in `visibility.rs` and `access_control/reducers.rs`.
pub(crate) fn is_conversation_participant(
    ctx: &ReducerContext,
    conversation_id: u64,
    identity: Identity,
) -> bool {
    ctx.db.conversation_participant().iter().any(|p| {
        p.conversation_id == conversation_id && p.identity == identity && p.left_at.is_none()
    })
}

/// Authority to change a conversation's lifecycle (resolve / reopen).
///
/// Participants always qualify. For a page-attached thread, page-write holders
/// also qualify — a comment thread on a page you can edit is yours to resolve,
/// and this is what keeps workspace admins working without a separate admin
/// concept.
///
/// This exists because `close_conversation` was deliberately unguarded at the
/// reducer level, relying on deployments to restrict callers at the HTTP/API
/// layer. That assumption stops holding the moment an AI user can call it
/// through a tool: without this, any AI could close any conversation in the
/// workspace, including a human's private DM.
fn require_conversation_authority(
    ctx: &ReducerContext,
    conv: &Conversation,
) -> Result<(), String> {
    if is_conversation_participant(ctx, conv.id, ctx.sender()) {
        return Ok(());
    }
    if let Some(page_id) = conv.page_id {
        if require_page_write(ctx, page_id).is_ok() {
            return Ok(());
        }
    }
    Err("Not a participant in this conversation".to_string())
}

pub(crate) fn next_conversation_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "conversation", || {
        ctx.db
            .conversation()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_conversation_message_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "conversation_message", || {
        ctx.db
            .conversation_message()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_conversation_participant_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "conversation_participant", || {
        ctx.db
            .conversation_participant()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_conversation_attachment_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "conversation_attachment", || {
        ctx.db
            .conversation_attachment()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) fn next_message_feedback_id(ctx: &ReducerContext) -> u64 {
    alloc_id(ctx, "message_feedback", || {
        ctx.db
            .message_feedback()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    })
}

pub(crate) mod visibility;

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

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ConversationStatus {
    Active,
    Closed,
}

/// What kind of conversation this is. Determines routing, canonical-key
/// semantics, and which participants are allowed.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum ConversationKind {
    /// Page/block/row/database-originated thread (current default behavior).
    ContextThread,
    /// Stable human-human 1:1 DM. Identified by a canonical key derived from
    /// the sorted pair of participant identity hex strings.
    Dm,
    /// Stable human-AI 1:1 DM. Same canonical-key scheme as `Dm`.
    AiDm,
    /// Direct group conversation (multiple humans, no page origin).
    GroupDm,
    /// AI or project conversation explicitly shared with other humans.
    SharedThread,
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
    /// What kind of conversation this is. Existing rows default to
    /// `ContextThread` (the historic page-attached behaviour).
    #[default(ConversationKind::ContextThread)]
    pub kind: ConversationKind,
    /// Stable key for DM and AiDm conversations: sorted hex pair joined by
    /// `-`. `None` for ContextThread and SharedThread.
    #[default(None::<String>)]
    pub canonical_key: Option<String>,
    /// Anchor to a specific block within `page_id`, for block-scoped
    /// Mention/ContextThread comments rendered in the page gutter. Holds the
    /// `ComponentNode.id` (the pulp component-tree node) the @mention was placed
    /// on. `None` for page-level threads and DMs.
    #[default(None::<u64>)]
    pub block_anchor: Option<u64>,
    /// Optional per-conversation model override. When `Some`, the worker uses
    /// this model id for replies in this thread instead of the AI user's
    /// configured default; the provider, API key, and max tokens still come from
    /// `ai_user_config`, so the override must name a model that key can reach.
    /// `None` (the default) means "use the AI user's configured model".
    #[default(None::<String>)]
    pub model_override: Option<String>,
    /// Optional per-conversation reasoning-effort override (e.g. "low"|"medium"|
    /// "high"|…), set by the AI user via `set_conversation_effort`. Applied only
    /// when the resolved model supports an effort knob; ignored otherwise.
    /// `None` (the default) means "use the model's default effort".
    ///
    #[default(None::<String>)]
    pub effort_override: Option<String>,
    /// Who resolved this thread, when `status == Closed`. Drives the gutter's
    /// "Resolved by X" attribution — which matters most once AI users can
    /// resolve threads themselves, since otherwise a thread silently vanishes
    /// from the page with no indication of who decided it was done.
    ///
    /// Cleared on `reopen_conversation`.
    #[default(None::<Identity>)]
    pub resolved_by: Option<Identity>,
    /// When it was resolved. Paired with `resolved_by`.
    ///
    /// Must remain last for schema migration (STDB only allows additive
    /// changes at the end of a struct).
    #[default(None::<Timestamp>)]
    pub resolved_at: Option<Timestamp>,
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
    /// Optional back-link to a source conversation (e.g. when a summary is
    /// forwarded to a DM via the handoff panel). Rendered as a navigable card
    /// in the thread view.
    #[default(None::<u64>)]
    pub linked_conversation_id: Option<u64>,
    /// Render-only ordered timeline of the assistant turn: a JSON array of
    /// `{"t":"text","text":...}` and `{"t":"tool","id":...}` blocks, in the order
    /// they occurred, so the client can interleave tool cards between text
    /// segments instead of stacking all tools at the top. Ignored by session
    /// reconstruction (which uses `content` + `tool_calls_json`); purely cosmetic.
    #[default(None::<String>)]
    pub timeline_json: Option<String>,
    /// Optional inline generative-UI payload: a `component_tree_v1` JSON blob
    /// (same shape as `serialize_component_tree`) that the client renders
    /// read-only in the thread via `<StaticComponentTree>` / pulp `<BlockView>`.
    /// Authored by an AI turn (see `set_message_component_tree`); render-only,
    /// no interactive return-path yet (custom-view runtime ADR D7).
    #[default(None::<String>)]
    pub component_tree_json: Option<String>,
    /// Identities this message explicitly addresses.
    ///
    /// Structured rather than parsed out of `content` at read time, because it
    /// is load-bearing for AI-to-AI wake gating (ticket 14264): an AI wakes
    /// another AI only when addressed, so "who is addressed" must be exact.
    /// Substring matching on display names over-matches — "Kira" inside
    /// "Kiran" — and a brake that fires on the wrong agent is not a brake.
    ///
    /// Resolved once at send time against the known profile list and stored, so
    /// the wake decision is a set-membership test rather than text analysis, and
    /// a later display-name change cannot retroactively rewrite who a past
    /// message addressed.
    ///
    /// Human and AI messages both populate this when their text contains a
    /// mention. Wake routing additionally consults `response_targets`.
    ///
    /// `None` on rows that predate the column, and on messages that address
    /// nobody. Treated identically to an empty list by every consumer.
    ///
    /// Modelled as `Option<Vec<_>>` rather than a bare `Vec` for a hard-won
    /// reason: AutoMigrate refuses a new column without a `#[default]`
    /// annotation ("Adding a column mentions to table conversation_message
    /// requires a default value annotation"), and `#[default(Vec::new())]` does
    /// not compile — a `Vec` destructor cannot run in const context (E0493).
    /// `Option` has a const-evaluable default, which is why every other column
    /// added to this module uses one. A bare `Vec` compiles fine and then
    /// dead-letters every workspace at publish, because `cargo check` never
    /// exercises the migration planner.
    ///
    /// Kept for exact addressing even though wake routing now uses the durable
    /// `response_targets` decision below.
    #[default(None::<Vec<Identity>>)]
    pub mentions: Option<Vec<Identity>>,
    /// AI identities selected to consider this human-authored message.
    ///
    /// Stored on the message so every independently running AI-user worker sees
    /// the same decision before it creates a `Thinking` placeholder. `Some`
    /// (including an empty vector) means routing was evaluated. `None` is used
    /// for AI/system messages and legacy rows; workers retain the legacy
    /// broadcast fallback only for those older human rows.
    ///
    /// MUST stay last: AutoMigrate only supports columns appended at the end.
    #[default(None::<Vec<Identity>>)]
    pub response_targets: Option<Vec<Identity>>,
}

/// What a `ConversationAttachment` carries.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AttachmentKind {
    /// An uploaded image (S3 `object_key`); the AI receives it as a vision block.
    Image,
    /// A reference to a page (`page_id`); the AI reads the page's *current*
    /// content as context at turn time (live, not frozen).
    Page,
    /// A snapshot of selected blocks (`content_snapshot` markdown) from a source
    /// `page_id`, captured at drag time.
    Blocks,
}

/// One attachment passed into `send_user_message`. The id/timestamps/keys are
/// assigned by the reducer; this is just the caller-supplied payload.
#[derive(SpacetimeType, Clone, Debug)]
pub struct AttachmentSpec {
    pub kind: AttachmentKind,
    /// Image: the S3 object key of the uploaded image.
    pub object_key: Option<String>,
    pub mime_type: Option<String>,
    pub file_name: Option<String>,
    /// Page: the referenced page. Blocks: the source page the blocks came from.
    pub page_id: Option<u64>,
    /// Blocks: markdown of the selected blocks. (Optional for Page.)
    pub content_snapshot: Option<String>,
}

/// An attachment on a `ConversationMessage` — an image, a page reference, or a
/// snapshot of selected blocks dragged in as context. Public with advisory
/// visibility, mirroring `conversation_message` (the image bytes themselves stay
/// behind presigned S3 URLs; `object_key` alone is not the image).
#[table(accessor = conversation_attachment, public)]
pub struct ConversationAttachment {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub message_id: u64,
    pub conversation_id: u64,
    pub kind: AttachmentKind,
    pub object_key: Option<String>,
    pub mime_type: Option<String>,
    pub file_name: Option<String>,
    pub page_id: Option<u64>,
    pub content_snapshot: Option<String>,
    pub created_at: Timestamp,
    pub created_by: Identity,
}

/// A human's thumbs up/down rating on a single (assistant) message.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum MessageFeedbackRating {
    Up,
    Down,
}

/// Durable human-review signal on a message — the thumbs up/down a rater can
/// set, change, or clear. This replaces the old inline, self-graded LLM "intent
/// check" banner with a real governed record of human judgment on agent actions
/// (on-strategy for the governed-substrate direction). One row per (message,
/// rater); RLS scopes each row to the identity that left it, so the control
/// reflects the current user's own rating without exposing others' feedback.
#[client_visibility_filter]
const MESSAGE_FEEDBACK_RATER_FILTER: Filter =
    Filter::Sql("SELECT * FROM message_feedback WHERE rater = :sender");

#[table(accessor = message_feedback, public)]
pub struct MessageFeedback {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub message_id: u64,
    pub conversation_id: u64,
    /// The human (or any identity) who left this rating; backs the RLS filter.
    pub rater: Identity,
    pub rating: MessageFeedbackRating,
    /// Optional free-text note accompanying the rating (e.g. why a thumbs-down).
    pub note: String,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

// ============================================================
// Conversation Reducers
// ============================================================

fn validate_participant_identities(
    participant_identities: &[Identity],
    mut identity_exists: impl FnMut(Identity) -> bool,
) -> Result<(), String> {
    for identity in participant_identities {
        if *identity == Identity::ZERO {
            return Err("participant_identities must not contain the zero Identity".to_string());
        }
        if !identity_exists(*identity) {
            return Err("participant_identities contains an unknown identity".to_string());
        }
    }
    Ok(())
}

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
    block_anchor: Option<u64>,
) -> Result<(), String> {
    if let Some(pid) = page_id {
        ctx.db.page().id().find(pid).ok_or("Page not found")?;
        // Starting a thread on a page is a write to that page's surface, so it
        // needs the same authority as editing it. Previously unguarded, which
        // was survivable only because no agent could reach this reducer — that
        // stops being true the moment `create_thread` is on the MCP surface.
        // Open-by-default, so this is a no-op on pages without access rules.
        require_page_write(ctx, pid)?;
    }
    // A block anchor only makes sense for a page-attached thread.
    if block_anchor.is_some() && page_id.is_none() {
        return Err("block_anchor requires a page_id".to_string());
    }

    validate_participant_identities(&participant_identities, |identity| {
        ctx.db.user().identity().find(identity).is_some()
            || ctx
                .db
                .ai_user_profile()
                .identity()
                .find(identity)
                .is_some()
    })?;

    let conv = ctx.db.conversation().insert(Conversation {
        id: next_conversation_id(ctx),
        page_id,
        initiated_by: ctx.sender(),
        status: ConversationStatus::Active,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        // Default to Private even on public pages — most conversations are
        // thinking, not conclusions. Initiator can expand later.
        // A block-anchored thread is a *comment on the page*, and a comment is
        // expected to be visible to anyone who can see what it is attached to.
        // Anyone wanting a private conversation with an AI user about a page
        // uses the AI sidebar, which stays `Private`.
        //
        // This is also what makes `conversation_participant` mean the right
        // thing for comments: on a `PageInheriting` thread, participants are a
        // *wake list* (who gets notified / responds), not an access-control
        // list, so adding someone is no longer a sharing decision.
        //
        // NB: neither value is enforced today — the conversation tables have no
        // `client_visibility_filter`. See the RLS ticket; this sets the correct
        // intent so the fix is a filter rather than also a data migration.
        visibility: if block_anchor.is_some() {
            ConversationVisibility::PageInheriting
        } else {
            ConversationVisibility::Private
        },
        kind: ConversationKind::ContextThread,
        canonical_key: None,
        block_anchor,
        model_override: None,
        effort_override: None,
        resolved_by: None,
        resolved_at: None,
    });

    let mut seen: Vec<Identity> = Vec::new();
    let initiator = ctx.sender();
    ctx.db
        .conversation_participant()
        .insert(ConversationParticipant {
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
        ctx.db
            .conversation_participant()
            .insert(ConversationParticipant {
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
    linked_conversation_id: Option<u64>,
) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        return Err("Conversation is closed".to_string());
    }

    // Resolved here too, so a plain human send from the composer records the
    // same structured addressing as the attachment path — the two client
    // branches must not disagree about who a message mentions.
    let mentions = resolve_mentions_in_content(ctx, &content);
    let response_targets = if is_ai_user(ctx, ctx.sender()) {
        None
    } else {
        Some(human_response_targets(ctx, conversation_id, &mentions))
    };

    ctx.db.conversation_message().insert(ConversationMessage {
        id: next_conversation_message_id(ctx),
        conversation_id,
        sender: MessageSender::User(ctx.sender()),
        content,
        job_id,
        component_tree_json: None,
        mentions: Some(mentions),
        response_targets,
        created_at: ctx.timestamp,
        status: status.unwrap_or(MessageStatus::Complete),
        thinking,
        tool_calls_json,
        timeline_json: None,
        input_tokens: input_tokens.unwrap_or(0),
        output_tokens: output_tokens.unwrap_or(0),
        cache_creation_input_tokens: cache_creation_input_tokens.unwrap_or(0),
        cache_read_input_tokens: cache_read_input_tokens.unwrap_or(0),
        linked_conversation_id,
    });

    ctx.db.conversation().id().update(Conversation {
        updated_at: ctx.timestamp,
        ..conv
    });

    Ok(())
}

fn validate_addressed_mentions(
    mentions: &[Identity],
    mut is_ai: impl FnMut(Identity) -> bool,
    mut is_human: impl FnMut(Identity) -> bool,
    mut is_participant: impl FnMut(Identity) -> bool,
) -> Result<(), String> {
    for mention in mentions {
        // Human mentions are additive annotation data. They do not wake an AI,
        // and newly resolving one must not make a formerly valid addressed send
        // fail merely because that person is not a thread participant.
        if !is_participant(*mention) && (is_ai(*mention) || !is_human(*mention)) {
            return Err(
                "Cannot address an identity that is not a participant in this conversation"
                    .to_string(),
            );
        }
    }
    Ok(())
}

/// Send a message that explicitly addresses other participants.
///
/// A separate reducer from `send_message` for the same reason
/// `send_user_message` is: `send_message` has many worker call sites and
/// widening its signature would touch all of them.
///
/// This is the path an AI user takes to address another AI user. The `mentions`
/// list is what makes AI-to-AI wake gating exact — see `ConversationMessage.mentions`
/// and the worker's `shouldWakeFor`. Callers resolve display names to identities
/// *before* calling, so the stored record cannot be re-interpreted later by a
/// display-name change.
///
/// Only participants may post, matching `send_message`'s effective contract.
#[reducer]
pub fn send_addressed_message(
    ctx: &ReducerContext,
    conversation_id: u64,
    content: String,
    mentions: Vec<Identity>,
) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        // The brake: a resolved thread refuses new messages, which is what stops
        // two AI users ping-ponging in a comment thread.
        return Err("Conversation is closed".to_string());
    }
    if !is_conversation_participant(ctx, conversation_id, ctx.sender()) {
        return Err("Not a participant in this conversation".to_string());
    }
    // Union the caller's explicit list with anything written as `@name`, so an
    // agent that simply writes the mention is addressed correctly without having
    // to also populate the parameter.
    let mut mentions = mentions;
    for m in resolve_mentions_in_content(ctx, &content) {
        if !mentions.contains(&m) {
            mentions.push(m);
        }
    }

    // An addressed AI must be able to act on the message. Human mentions are
    // stored for notification/display parity but are not AI addressing.
    validate_addressed_mentions(
        &mentions,
        |identity| is_ai_user(ctx, identity),
        |identity| ctx.db.user().identity().find(identity).is_some(),
        |identity| is_conversation_participant(ctx, conversation_id, identity),
    )?;
    let response_targets = if is_ai_user(ctx, ctx.sender()) {
        None
    } else {
        Some(human_response_targets(ctx, conversation_id, &mentions))
    };

    ctx.db.conversation_message().insert(ConversationMessage {
        id: next_conversation_message_id(ctx),
        conversation_id,
        sender: MessageSender::User(ctx.sender()),
        content,
        job_id: None,
        created_at: ctx.timestamp,
        status: MessageStatus::Complete,
        thinking: None,
        tool_calls_json: None,
        timeline_json: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        linked_conversation_id: None,
        component_tree_json: None,
        mentions: Some(mentions),
        response_targets,
    });

    ctx.db.conversation().id().update(Conversation {
        updated_at: ctx.timestamp,
        ..conv
    });

    Ok(())
}

/// Send a human message with optional attachments (images, page references,
/// block snapshots). Inserts the message, then one `ConversationAttachment` per
/// spec linked to it, and bumps the conversation. The worker reacts to the new
/// message via subscription (same as `send_message`) and resolves the
/// attachments into the model turn. A separate reducer from `send_message` so
/// the worker's many `send_message` call sites are untouched.
#[reducer]
pub fn send_user_message(
    ctx: &ReducerContext,
    conversation_id: u64,
    content: String,
    attachments: Vec<AttachmentSpec>,
) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        return Err("Conversation is closed".to_string());
    }
    if content.trim().is_empty() && attachments.is_empty() {
        return Err("Message must have text or at least one attachment".to_string());
    }

    // Humans get structured mentions with no client work: the reducer resolves
    // them, so `@Kira` in the composer becomes an addressable record usable for
    // notifications later.
    let mentions = resolve_mentions_in_content(ctx, &content);
    let response_targets = if is_ai_user(ctx, ctx.sender()) {
        None
    } else {
        Some(human_response_targets(ctx, conversation_id, &mentions))
    };

    let message = ctx.db.conversation_message().insert(ConversationMessage {
        id: next_conversation_message_id(ctx),
        conversation_id,
        sender: MessageSender::User(ctx.sender()),
        content,
        job_id: None,
        created_at: ctx.timestamp,
        status: MessageStatus::Complete,
        thinking: None,
        tool_calls_json: None,
        timeline_json: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        linked_conversation_id: None,
        component_tree_json: None,
        mentions: Some(mentions),
        response_targets,
    });

    for spec in attachments {
        ctx.db.conversation_attachment().insert(ConversationAttachment {
            id: next_conversation_attachment_id(ctx),
            message_id: message.id,
            conversation_id,
            kind: spec.kind,
            object_key: spec.object_key,
            mime_type: spec.mime_type,
            file_name: spec.file_name,
            page_id: spec.page_id,
            content_snapshot: spec.content_snapshot,
            created_at: ctx.timestamp,
            created_by: ctx.sender(),
        });
    }

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
    timeline_json: Option<String>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    cache_creation_input_tokens: Option<u32>,
    cache_read_input_tokens: Option<u32>,
    // Link this message to an Orcha job it spawned (e.g. an AI user delegating a
    // multi-step subtask). `None` preserves any existing link. Rendered inline
    // in the conversation thread as a subagent-style job card.
    job_id: Option<u64>,
) -> Result<(), String> {
    let msg = ctx
        .db
        .conversation_message()
        .id()
        .find(message_id)
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
        .find(sender_identity)
        .is_none()
    {
        return Err("Cannot update a human message".to_string());
    }

    let conv = ctx
        .db
        .conversation()
        .id()
        .find(msg.conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        return Err("Conversation is closed".to_string());
    }

    ctx.db
        .conversation_message()
        .id()
        .update(ConversationMessage {
            content,
            status,
            thinking,
            tool_calls_json,
            timeline_json,
            input_tokens: input_tokens.unwrap_or(msg.input_tokens),
            output_tokens: output_tokens.unwrap_or(msg.output_tokens),
            cache_creation_input_tokens: cache_creation_input_tokens
                .unwrap_or(msg.cache_creation_input_tokens),
            cache_read_input_tokens: cache_read_input_tokens.unwrap_or(msg.cache_read_input_tokens),
            job_id: job_id.or(msg.job_id),
            ..msg
        });

    ctx.db.conversation().id().update(Conversation {
        updated_at: ctx.timestamp,
        ..conv
    });

    Ok(())
}

/// Set (or clear, with `None`) the inline `component_tree_v1` generative-UI
/// payload on an assistant message. Same authority model as `update_message`
/// (only the original AI sender may write it); kept separate so streaming
/// `update_message` flushes don't have to thread the blob and so `..msg`
/// preserves it across them. Idempotent; render-only per ADR D7.
#[reducer]
pub fn set_message_component_tree(
    ctx: &ReducerContext,
    message_id: u64,
    component_tree_json: Option<String>,
) -> Result<(), String> {
    let msg = ctx
        .db
        .conversation_message()
        .id()
        .find(message_id)
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
        .find(sender_identity)
        .is_none()
    {
        return Err("Cannot update a human message".to_string());
    }

    let conv = ctx
        .db
        .conversation()
        .id()
        .find(msg.conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        return Err("Conversation is closed".to_string());
    }

    ctx.db
        .conversation_message()
        .id()
        .update(ConversationMessage {
            component_tree_json,
            ..msg
        });

    Ok(())
}

/// Close a conversation. No further messages can be added.
#[reducer]
pub fn close_conversation(ctx: &ReducerContext, conversation_id: u64) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(conversation_id)
        .ok_or("Conversation not found")?;
    require_conversation_authority(ctx, &conv)?;

    // Resolving is a real brake, not just a UI state: `send_message` refuses
    // any conversation that is not Active, so a resolved thread cannot be
    // posted to. That is what stops two AI users ping-ponging in a comment
    // thread — the affordance and the safety mechanism are the same mechanism.
    ctx.db.conversation().id().update(Conversation {
        status: ConversationStatus::Closed,
        resolved_by: Some(ctx.sender()),
        resolved_at: Some(ctx.timestamp),
        updated_at: ctx.timestamp,
        ..conv
    });
    Ok(())
}

/// Reopen a resolved conversation, restoring it to `Active`.
///
/// Google-Docs semantics: resolving is reversible. Without this, `close` is a
/// one-way door and "resolve" becomes a trap rather than a tidy-up — the thread
/// can never be continued, only recreated, losing its history and anchor.
///
/// Same authority as closing: participants, or page-write holders on a
/// page-attached thread.
#[reducer]
pub fn reopen_conversation(ctx: &ReducerContext, conversation_id: u64) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(conversation_id)
        .ok_or("Conversation not found")?;
    require_conversation_authority(ctx, &conv)?;

    // Attribution is cleared: a reopened thread has no resolution to attribute,
    // and leaving stale `resolved_by` behind would make the gutter claim the
    // thread was resolved by someone who has since been overruled.
    ctx.db.conversation().id().update(Conversation {
        status: ConversationStatus::Active,
        resolved_by: None,
        resolved_at: None,
        updated_at: ctx.timestamp,
        ..conv
    });
    Ok(())
}

/// Set or clear the per-conversation model override. `Some(model)` pins replies
/// in this thread to `model`; `None` — or a blank/whitespace string — reverts to
/// the AI user's configured default. Only the model changes: provider and API
/// key are untouched, so the override must name a model the AI user's existing
/// key can reach. Like `close_conversation`, this is intentionally unguarded at
/// the reducer level (deployments restrict callers at the HTTP/API layer).
#[reducer]
pub fn set_conversation_model(
    ctx: &ReducerContext,
    conversation_id: u64,
    model: Option<String>,
) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(conversation_id)
        .ok_or("Conversation not found")?;
    let model_override = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    ctx.db.conversation().id().update(Conversation {
        model_override,
        updated_at: ctx.timestamp,
        ..conv
    });
    Ok(())
}

/// Set (or clear, with `None`/blank) the per-conversation reasoning-effort
/// override. The AI user adjusts this for its own thread; it's applied only when
/// the resolved model supports an effort knob. Like `set_conversation_model`,
/// intentionally unguarded at the reducer level (callers restricted at the API layer).
#[reducer]
pub fn set_conversation_effort(
    ctx: &ReducerContext,
    conversation_id: u64,
    effort: Option<String>,
) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(conversation_id)
        .ok_or("Conversation not found")?;
    let effort_override = effort
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty());
    ctx.db.conversation().id().update(Conversation {
        effort_override,
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
        .find(conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        return Err("Conversation is closed".to_string());
    }
    ctx.db.conversation_message().insert(ConversationMessage {
        id: next_conversation_message_id(ctx),
        conversation_id,
        sender: MessageSender::System("compaction".to_string()),
        component_tree_json: None,
        mentions: None,
        response_targets: None,
        content: summary,
        job_id: None,
        created_at: ctx.timestamp,
        status: MessageStatus::Complete,
        thinking: None,
        tool_calls_json: None,
        timeline_json: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        linked_conversation_id: None,
    });
    ctx.db.conversation().id().update(Conversation {
        updated_at: ctx.timestamp,
        ..conv
    });
    Ok(())
}

// ── DM helpers ───────────────────────────────────────────────────────────────

/// Canonical key for a DM between two identities: alphabetically sorted hex
/// strings joined by `-`. Deterministic regardless of call order.
fn canonical_dm_key(a: Identity, b: Identity) -> String {
    let a_hex = a.to_hex().to_string();
    let b_hex = b.to_hex().to_string();
    if a_hex < b_hex {
        format!("{}-{}", a_hex, b_hex)
    } else {
        format!("{}-{}", b_hex, a_hex)
    }
}

fn insert_dm_participants(
    ctx: &ReducerContext,
    conversation_id: u64,
    initiator: Identity,
    other: Identity,
) {
    for (identity, role) in [
        (initiator, ParticipantRole::Initiator),
        (other, ParticipantRole::Member),
    ] {
        ctx.db.conversation_participant().insert(ConversationParticipant {
            id: next_conversation_participant_id(ctx),
            conversation_id,
            identity,
            role,
            joined_at: ctx.timestamp,
            last_viewed_message_id: None,
            left_at: None,
        });
    }
}

/// Find or create the canonical human-human DM between the caller and
/// `other_identity`. Idempotent — safe to call on every navigation.
/// The client discovers the conversation via its existing subscription.
#[reducer]
pub fn find_or_create_dm(
    ctx: &ReducerContext,
    other_identity: Identity,
) -> Result<(), String> {
    let me = ctx.sender();
    if other_identity == Identity::ZERO {
        return Err("other_identity must not be zero".to_string());
    }
    if me == other_identity {
        return Err("Cannot DM yourself".to_string());
    }

    let key = canonical_dm_key(me, other_identity);
    if ctx
        .db
        .conversation()
        .iter()
        .any(|c| c.canonical_key.as_deref() == Some(key.as_str()))
    {
        return Ok(());
    }

    let conv = ctx.db.conversation().insert(Conversation {
        id: next_conversation_id(ctx),
        page_id: None,
        initiated_by: me,
        status: ConversationStatus::Active,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        visibility: ConversationVisibility::Participants,
        kind: ConversationKind::Dm,
        canonical_key: Some(key),
        block_anchor: None,
        model_override: None,
        effort_override: None,
        resolved_by: None,
        resolved_at: None,
    });

    insert_dm_participants(ctx, conv.id, me, other_identity);
    Ok(())
}

/// Find or create the canonical human-AI DM between the caller and
/// `ai_identity`. Idempotent — safe to call on every navigation.
#[reducer]
pub fn find_or_create_ai_dm(
    ctx: &ReducerContext,
    ai_identity: Identity,
) -> Result<(), String> {
    let me = ctx.sender();
    if ai_identity == Identity::ZERO {
        return Err("ai_identity must not be zero".to_string());
    }
    ctx.db
        .ai_user_profile()
        .identity()
        .find(ai_identity)
        .ok_or("Target identity is not an AI user")?;

    let key = canonical_dm_key(me, ai_identity);
    if ctx
        .db
        .conversation()
        .iter()
        .any(|c| c.canonical_key.as_deref() == Some(key.as_str()))
    {
        return Ok(());
    }

    let conv = ctx.db.conversation().insert(Conversation {
        id: next_conversation_id(ctx),
        page_id: None,
        initiated_by: me,
        status: ConversationStatus::Active,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        visibility: ConversationVisibility::Private,
        kind: ConversationKind::AiDm,
        canonical_key: Some(key),
        block_anchor: None,
        model_override: None,
        effort_override: None,
        resolved_by: None,
        resolved_at: None,
    });

    insert_dm_participants(ctx, conv.id, me, ai_identity);
    Ok(())
}

/// Set (or change) the calling user's thumbs up/down rating on a message.
/// Upserts the single (message, rater) row so re-clicking a different rating
/// flips it in place rather than stacking rows. `note` is optional context.
#[reducer]
pub fn set_message_feedback(
    ctx: &ReducerContext,
    message_id: u64,
    rating: MessageFeedbackRating,
    note: Option<String>,
) -> Result<(), String> {
    let msg = ctx
        .db
        .conversation_message()
        .id()
        .find(message_id)
        .ok_or("Message not found")?;

    let rater = ctx.sender();
    let note = note.unwrap_or_default();

    // Fire a learning trigger only when a rating newly *becomes* a thumbs-down
    // that carries a note — the actionable signal. Editing the note on an
    // existing down-vote, or an up-vote, does not re-trigger (avoids spam).
    let existing = ctx
        .db
        .message_feedback()
        .message_id()
        .filter(message_id)
        .find(|f| f.rater == rater);
    let was_down = existing
        .as_ref()
        .map(|e| e.rating == MessageFeedbackRating::Down)
        .unwrap_or(false);
    let should_trigger =
        rating == MessageFeedbackRating::Down && !note.trim().is_empty() && !was_down;

    if let Some(existing) = existing {
        ctx.db.message_feedback().id().update(MessageFeedback {
            rating: rating.clone(),
            note: note.clone(),
            updated_at: ctx.timestamp,
            ..existing
        });
    } else {
        ctx.db.message_feedback().insert(MessageFeedback {
            id: next_message_feedback_id(ctx),
            message_id,
            conversation_id: msg.conversation_id,
            rater,
            rating,
            note: note.clone(),
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
        });
    }

    if should_trigger {
        post_feedback_trigger(ctx, msg.conversation_id, &note);
    }
    Ok(())
}

/// Post a `System("feedback")` trigger into the conversation so the AI user's
/// worker wakes and addresses a thumbs-down. Mirrors the job-completion /
/// routine triggers: `message_feedback` is RLS-scoped to its rater, so the AI's
/// own connection can't read it — the actionable content is delivered as a
/// visible conversation message instead. The AI reconstructs it as a user-role
/// note and responds (and records a corrective memory when durable).
fn post_feedback_trigger(ctx: &ReducerContext, conversation_id: u64, note: &str) {
    let bounded: String = note.chars().take(1000).collect();
    let body = format!(
        "A human gave a thumbs-down on your earlier reply in this conversation, with this note:\n\n\
         \"{}\"\n\n\
         Take it seriously: acknowledge the correction, fix or redo what they flagged where you can, \
         and briefly say what you'll do differently. If this reflects a durable preference or a \
         correction worth remembering, record it as a memory page (create or update one) so you \
         apply it next time. Don't be defensive.",
        bounded
    );
    ctx.db.conversation_message().insert(ConversationMessage {
        id: next_conversation_message_id(ctx),
        conversation_id,
        sender: MessageSender::System("feedback".to_string()),
        component_tree_json: None,
        mentions: None,
        response_targets: None,
        content: body,
        job_id: None,
        created_at: ctx.timestamp,
        status: MessageStatus::Complete,
        thinking: None,
        tool_calls_json: None,
        timeline_json: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        linked_conversation_id: None,
    });
    if let Some(conv) = ctx.db.conversation().id().find(conversation_id) {
        ctx.db.conversation().id().update(Conversation {
            updated_at: ctx.timestamp,
            ..conv
        });
    }
}

/// Remove the calling user's rating on a message (toggle off). No-op if none.
#[reducer]
pub fn clear_message_feedback(ctx: &ReducerContext, message_id: u64) -> Result<(), String> {
    let rater = ctx.sender();
    let ids: Vec<u64> = ctx
        .db
        .message_feedback()
        .message_id()
        .filter(message_id)
        .filter(|f| f.rater == rater)
        .map(|f| f.id)
        .collect();
    for id in ids {
        ctx.db.message_feedback().id().delete(&id);
    }
    Ok(())
}

#[cfg(test)]
mod mention_tests {
    use super::{
        choose_human_response_targets, match_mentions, merge_mention_candidates,
        validate_addressed_mentions, validate_participant_identities,
    };
    use spacetimedb::Identity;

    fn id(byte: u8) -> Identity {
        Identity::from_byte_array([byte; 32])
    }

    fn profiles() -> Vec<(String, Identity)> {
        vec![("Kira".to_string(), id(1)), ("Scribe".to_string(), id(2))]
    }

    #[test]
    fn resolves_a_simple_mention() {
        assert_eq!(match_mentions("hey @Kira take a look", profiles()), vec![id(1)]);
    }

    #[test]
    fn resolves_a_human_name() {
        let candidates = merge_mention_candidates(profiles(), vec![("Maya".to_string(), id(7))]);
        assert_eq!(match_mentions("thanks @Maya", candidates), vec![id(7)]);
    }

    #[test]
    fn resolves_a_multi_word_human_name() {
        let candidates = merge_mention_candidates(
            profiles(),
            vec![("Ada Lovelace".to_string(), id(8))],
        );
        assert_eq!(
            match_mentions("@Ada Lovelace, can you review?", candidates),
            vec![id(8)]
        );
    }

    #[test]
    fn ai_display_name_wins_a_human_name_collision() {
        let candidates = merge_mention_candidates(
            vec![("Kira".to_string(), id(1))],
            vec![("kIrA".to_string(), id(7))],
        );
        assert_eq!(match_mentions("@KIRA please review", candidates), vec![id(1)]);
    }

    #[test]
    fn is_case_insensitive() {
        assert_eq!(match_mentions("@kira", profiles()), vec![id(1)]);
        assert_eq!(match_mentions("@KIRA", profiles()), vec![id(1)]);
    }

    #[test]
    fn a_bare_name_is_not_a_mention() {
        assert!(match_mentions("Kira should look", profiles()).is_empty());
    }

    /// The case that motivated structured mentions: substring matching would
    /// have `@Kiran` wake Kira, and a brake that fires on the wrong agent is
    /// not a brake.
    #[test]
    fn longer_name_wins_and_shorter_does_not_over_match() {
        let p = vec![("Kira".to_string(), id(1)), ("Kiran".to_string(), id(3))];
        assert_eq!(match_mentions("@Kiran please review", p.clone()), vec![id(3)]);
        assert_eq!(match_mentions("@Kira please review", p), vec![id(1)]);
    }

    #[test]
    fn resolves_several_distinct_mentions() {
        let out = match_mentions("@Kira and @Scribe both", profiles());
        assert_eq!(out.len(), 2);
        assert!(out.contains(&id(1)));
        assert!(out.contains(&id(2)));
    }

    #[test]
    fn unknown_names_resolve_to_nothing() {
        assert!(match_mentions("@Nobody around", profiles()).is_empty());
    }

    #[test]
    fn a_mention_is_not_duplicated() {
        assert_eq!(match_mentions("@Kira @Kira @Kira", profiles()), vec![id(1)]);
    }

    #[test]
    fn punctuation_after_a_name_still_matches() {
        assert_eq!(match_mentions("@Kira, thoughts?", profiles()), vec![id(1)]);
        assert_eq!(match_mentions("(@Kira)", profiles()), vec![id(1)]);
    }

    #[test]
    fn empty_display_names_are_ignored() {
        assert!(match_mentions("@ anyone", vec![("  ".to_string(), id(9))]).is_empty());
    }

    #[test]
    fn explicit_mentions_are_the_exact_response_targets() {
        let active = vec![id(1), id(2)];
        assert_eq!(
            choose_human_response_targets(&[id(2)], &active, &active, Some(id(1)), None),
            vec![id(2)]
        );
    }

    #[test]
    fn a_mention_of_an_absent_ai_fails_closed() {
        let active = vec![id(1), id(2)];
        let known_ai = vec![id(1), id(2), id(9)];
        assert!(
            choose_human_response_targets(&[id(9)], &known_ai, &active, Some(id(1)), None)
                .is_empty()
        );
    }

    #[test]
    fn a_human_mention_does_not_alter_response_targets() {
        let active = vec![id(1), id(2)];
        assert_eq!(
            choose_human_response_targets(&[id(7)], &active, &active, Some(id(2)), None),
            vec![id(2)]
        );
    }

    #[test]
    fn an_unaddressed_reply_continues_with_the_previous_ai_speaker() {
        let active = vec![id(1), id(2)];
        assert_eq!(
            choose_human_response_targets(&[], &active, &active, Some(id(2)), None),
            vec![id(2)]
        );
    }

    #[test]
    fn rapid_human_messages_inherit_the_pending_assignment() {
        let active = vec![id(1), id(2)];
        assert_eq!(
            choose_human_response_targets(&[], &active, &active, None, Some(&[id(2)])),
            vec![id(2)]
        );
    }

    #[test]
    fn a_new_group_turn_falls_back_to_the_original_ai() {
        let active = vec![id(1), id(2)];
        assert_eq!(
            choose_human_response_targets(&[], &active, &active, None, None),
            vec![id(1)]
        );
    }

    #[test]
    fn a_nonparticipant_human_mention_is_additive() {
        assert!(validate_addressed_mentions(
            &[id(7)],
            |identity| identity == id(1),
            |identity| identity == id(7),
            |_| false,
        )
        .is_ok());
        assert!(validate_addressed_mentions(
            &[id(1)],
            |identity| identity == id(1),
            |identity| identity == id(7),
            |_| false,
        )
        .is_err());
        assert!(validate_addressed_mentions(
            &[id(9)],
            |identity| identity == id(1),
            |identity| identity == id(7),
            |_| false,
        )
        .is_err());
    }

    #[test]
    fn unknown_conversation_participant_is_rejected() {
        let known = [id(1), id(2)];
        let err = validate_participant_identities(&[id(9)], |identity| known.contains(&identity))
            .expect_err("unknown identity should be rejected");
        assert_eq!(err, "participant_identities contains an unknown identity");
    }
}
