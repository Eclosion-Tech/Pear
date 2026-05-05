//! Conversation threads, messages, and participant join rows. Messages
//! can be attached to a page (today's @mention flow) or detached (future
//! channel/DM threads).

use spacetimedb::{reducer, table, Identity, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::ai::ai_user_profile;
use crate::id_counters::alloc_id;
use crate::pages::page;

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
        ctx.db.page().id().find(pid).ok_or("Page not found")?;
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
        kind: ConversationKind::ContextThread,
        canonical_key: None,
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
        linked_conversation_id,
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
pub fn close_conversation(ctx: &ReducerContext, conversation_id: u64) -> Result<(), String> {
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(conversation_id)
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
        .find(conversation_id)
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
    });

    insert_dm_participants(ctx, conv.id, me, ai_identity);
    Ok(())
}
