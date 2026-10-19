use super::{conversation_message, require_message_ui_authority, ConversationMessage};
use spacetimedb::{reducer, ReducerContext};

pub(super) fn is_reference(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| {
            value["v"]
                .as_str()
                .map(|v| v.starts_with("pear_page_component_"))
        })
        .unwrap_or(false)
}
/// Atomically attach a live page-component reference to the author's message.
#[reducer]
pub fn set_message_page_component(
    ctx: &ReducerContext,
    message_id: String,
    component_id: String,
) -> Result<(), String> {
    let id = crate::pages::components::trellis_panel::state::id(&message_id)?;
    let message = require_message_ui_authority(ctx, id)?;
    let reference = crate::pages::components::trellis_panel::reference(ctx, &component_id)?;
    if let Some(current) = message.component_tree_json.as_deref() {
        if current == reference {
            return Ok(());
        }
        if !current.is_empty() {
            return Err("UI_OCCUPIED: use a fresh assistant message for another panel".into());
        }
    }
    ctx.db
        .conversation_message()
        .id()
        .update(ConversationMessage {
            component_tree_json: Some(reference),
            ..message
        });
    Ok(())
}
