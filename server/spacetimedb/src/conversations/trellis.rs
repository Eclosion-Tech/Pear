use super::trellis_state::commit;
use super::{conversation_message, require_message_ui_authority, ConversationMessage};
use spacetimedb::{reducer, ReducerContext};

#[reducer]
pub fn commit_message_trellis(
    ctx: &ReducerContext,
    message_id: u64,
    base_revision: Option<u64>,
    request_id: String,
    intent_json: String,
    payload_json: String,
) -> Result<(), String> {
    let msg = require_message_ui_authority(ctx, message_id)?;
    if let Some(saved) = commit(
        msg.component_tree_json.as_deref(),
        message_id,
        base_revision,
        &request_id,
        &intent_json,
        &payload_json,
    )? {
        ctx.db
            .conversation_message()
            .id()
            .update(ConversationMessage {
                component_tree_json: Some(saved),
                ..msg
            });
    }
    Ok(())
}
