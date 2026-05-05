//! Conversation visibility and participant-state reducers
//! (`set_conversation_visibility`, `mark_conversation_read`,
//! `add_conversation_participant`, `remove_conversation_participant`).

use spacetimedb::{reducer, Identity, ReducerContext, Table};

use crate::auth::sender_is_admin;
use crate::conversations::{
    conversation, conversation_participant, next_conversation_participant_id, Conversation,
    ConversationParticipant, ConversationVisibility, ParticipantRole,
};

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
        .find(conversation_id)
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
        .find(conversation_id)
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

    ctx.db
        .conversation_participant()
        .insert(ConversationParticipant {
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
        .find(conversation_id)
        .ok_or("Conversation not found")?;
    let is_self = identity == ctx.sender();
    if !is_self && conv.initiated_by != ctx.sender() && !sender_is_admin(ctx) {
        return Err(
            "Only the initiator, admin, or the participant themselves can remove".to_string(),
        );
    }
    let participant = ctx
        .db
        .conversation_participant()
        .conversation_id()
        .filter(&conversation_id)
        .find(|p| p.identity == identity && p.left_at.is_none())
        .ok_or("Active participant not found")?;
    ctx.db
        .conversation_participant()
        .id()
        .update(ConversationParticipant {
            left_at: Some(ctx.timestamp),
            ..participant
        });
    Ok(())
}
