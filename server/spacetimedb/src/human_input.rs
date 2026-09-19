//! Explicit questions from agents. Answers are addressed conversation messages,
//! so the normal worker wake path resumes the same agent/conversation.
use crate::conversations::is_ai_user;
use crate::conversations::{
    is_conversation_participant, send_addressed_message, ConversationStatus,
};
use crate::{conversation, user};
use spacetimedb::{
    client_visibility_filter, reducer, table, Filter, Identity, ReducerContext, Table, Timestamp,
};

#[client_visibility_filter]
const INPUT_RECIPIENT: Filter = Filter::Sql("SELECT human_input_request.* FROM human_input_request JOIN readable_conversations ON human_input_request.conversation_id = readable_conversations.id WHERE human_input_request.recipient = :sender");
#[client_visibility_filter]
const INPUT_REQUESTER: Filter = Filter::Sql("SELECT human_input_request.* FROM human_input_request JOIN readable_conversations ON human_input_request.conversation_id = readable_conversations.id WHERE human_input_request.requester = :sender");

#[table(accessor = human_input_request, public)]
pub struct HumanInputRequest {
    #[primary_key]
    pub id: u64,
    #[index(btree)]
    pub conversation_id: u64,
    pub requester: Identity,
    pub recipient: Identity,
    pub request_key: String,
    pub question: String,
    pub answer: Option<String>,
    pub created_at: Timestamp,
    pub answered_at: Option<Timestamp>,
}

#[reducer]
pub fn request_human_input(
    ctx: &ReducerContext,
    conversation_id: u64,
    recipient: Identity,
    request_key: String,
    question: String,
) -> Result<(), String> {
    crate::access_control::helpers::require_workspace_principal(ctx)?;
    if !is_ai_user(ctx, ctx.sender()) {
        return Err("Only an AI user may request input".into());
    }
    validate_question(&request_key, &question)?;
    let conv = ctx
        .db
        .conversation()
        .id()
        .find(conversation_id)
        .ok_or("Conversation not found")?;
    if conv.status != ConversationStatus::Active {
        return Err("Conversation is closed".into());
    }
    if !is_conversation_participant(ctx, conversation_id, ctx.sender())
        || !is_conversation_participant(ctx, conversation_id, recipient)
    {
        return Err("Both sender and recipient must be active participants".into());
    }
    if is_ai_user(ctx, recipient)
        || !ctx
            .db
            .user()
            .identity()
            .find(recipient)
            .map(|u| u.is_authenticated)
            .unwrap_or(false)
    {
        return Err("Recipient must be an authenticated human".into());
    }
    if let Some(previous) = ctx
        .db
        .human_input_request()
        .conversation_id()
        .filter(conversation_id)
        .find(|r| r.requester == ctx.sender() && r.request_key == request_key)
    {
        return if previous.recipient == recipient && previous.question == question {
            Ok(())
        } else {
            Err("Request key already used with different content".into())
        };
    }
    let id = crate::id_counters::alloc_id(ctx, "human_input_request", || {
        ctx.db
            .human_input_request()
            .iter()
            .map(|r| r.id)
            .max()
            .unwrap_or(0)
    });
    // Makes the question part of the agent's future conversation context, too.
    send_addressed_message(ctx, conversation_id, question.clone(), vec![recipient])?;
    ctx.db.human_input_request().insert(HumanInputRequest {
        id,
        conversation_id,
        requester: ctx.sender(),
        recipient,
        request_key,
        question,
        answer: None,
        created_at: ctx.timestamp,
        answered_at: None,
    });
    Ok(())
}

#[reducer]
pub fn answer_human_input(
    ctx: &ReducerContext,
    request_id: u64,
    answer: String,
) -> Result<(), String> {
    crate::access_control::helpers::require_workspace_principal(ctx)?;
    let request = ctx
        .db
        .human_input_request()
        .id()
        .find(request_id)
        .ok_or("Request not found")?;
    if ctx.sender() != request.recipient || is_ai_user(ctx, ctx.sender()) {
        return Err("Only the recipient can answer".into());
    }
    if request.answered_at.is_some() {
        return Err("Request already answered".into());
    }
    if answer.trim().is_empty() || answer.len() > 16_384 {
        return Err("Answer must contain 1–16384 bytes".into());
    }
    // Reducer enforces current participation and active conversation. This and
    // the state change commit atomically; a double tap cannot wake twice.
    send_addressed_message(
        ctx,
        request.conversation_id,
        answer.clone(),
        vec![request.requester],
    )?;
    ctx.db.human_input_request().id().update(HumanInputRequest {
        answer: Some(answer),
        answered_at: Some(ctx.timestamp),
        ..request
    });
    Ok(())
}

fn validate_question(key: &str, question: &str) -> Result<(), String> {
    if key.trim().is_empty() || key.len() > 128 {
        return Err("Request key must contain 1–128 bytes".into());
    }
    if question.trim().is_empty() || question.len() > 16_384 {
        return Err("Question must contain 1–16384 bytes".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_nonempty_questions() {
        assert!(validate_question("turn-1", "Which branch?").is_ok());
        assert!(validate_question(" ", "Question").is_err());
        assert!(validate_question("key", " ").is_err());
        assert!(validate_question("key", &"é".repeat(8193)).is_err());
    }
}
