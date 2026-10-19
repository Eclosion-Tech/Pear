//! One page-owned component. Its ordinary ComponentNode.props is authoritative.
use super::*;
use crate::access_control::helpers::require_page_read;
use crate::ai::ai_user_profile;
#[path = "trellis_panel_state.rs"]
pub(crate) mod state;
pub const COMPONENT_TYPE: &str = "TrellisPanel";
pub(super) fn initialize(
    ctx: &ReducerContext,
    parent_id: u64,
    node_id: u64,
    parameters_json: &str,
) -> Result<String, String> {
    state::create(
        &parent_id.to_string(),
        &ctx.sender().to_hex().to_string(),
        &format!("insert:{node_id}"),
        parameters_json,
    )
}
fn actor(ctx: &ReducerContext) -> ActorType {
    if ctx
        .db
        .ai_user_profile()
        .identity()
        .find(ctx.sender())
        .is_some()
    {
        ActorType::Agent(ctx.sender().to_hex().to_string())
    } else {
        ActorType::Human
    }
}
#[reducer]
pub fn create_trellis_panel(
    ctx: &ReducerContext,
    parent_id: String,
    request_id: String,
    parameters_json: String,
) -> Result<(), String> {
    let parent_id = state::id(&parent_id)?;
    let parent = require_live_node(ctx, parent_id)?;
    let page = require_component_tree_page(ctx, parent.surface_id)?;
    require_page_write(ctx, page.id)?;
    if !require_type_def(ctx, &parent.component_type)?.accepts_children {
        return Err("Parent cannot contain a panel".into());
    }
    require_type_def(ctx, COMPONENT_TYPE)?;
    let principal = ctx.sender().to_hex().to_string();
    let props = state::create(
        &parent_id.to_string(),
        &principal,
        &request_id,
        &parameters_json,
    )?;
    let expected = state::creation_fingerprint(&parameters_json)?;
    for node in ctx.db.component_node().surface_id().filter(page.id) {
        if node.component_type != COMPONENT_TYPE {
            continue;
        }
        let Ok(saved) = state::parse(&node.props) else {
            continue;
        };
        if saved.creation.principal == principal
            && saved.creation.parent_id == parent_id.to_string()
            && saved.creation.request_id == request_id
        {
            if saved.creation.fingerprint != expected {
                return Err("REQUEST_REUSED: create request has different arguments".into());
            }
            if node.deleted_at.is_some() {
                return Err("PANEL_DELETED: the created panel was deleted".into());
            }
            return Ok(());
        }
    }
    let siblings = live_siblings_sorted(ctx, page.id, parent_id, None);
    let count = siblings.len();
    let order = renumber_with_gap(ctx, siblings, count);
    let author = actor(ctx);
    ctx.db.component_node().insert(ComponentNode {
        id: next_component_node_id(ctx),
        surface_id: page.id,
        parent_id: Some(parent_id),
        component_type: COMPONENT_TYPE.into(),
        props,
        order,
        created_by: author.clone(),
        updated_by: author,
        created_at: ctx.timestamp,
        updated_at: ctx.timestamp,
        deleted_at: None,
    });
    touch_page(ctx, page);
    Ok(())
}
#[reducer]
pub fn commit_trellis_panel(
    ctx: &ReducerContext,
    component_id: String,
    base_revision: u64,
    request_id: String,
    parameters_json: String,
) -> Result<(), String> {
    let node = require_live_node(ctx, state::id(&component_id)?)?;
    let page = require_component_tree_page(ctx, node.surface_id)?;
    require_page_write(ctx, page.id)?;
    if node.component_type != COMPONENT_TYPE {
        return Err("INVALID_PAGE_PANEL: target is not a Trellis panel".into());
    }
    if let Some(props) = state::commit(
        &node.props,
        base_revision,
        &ctx.sender().to_hex().to_string(),
        &request_id,
        &parameters_json,
    )? {
        ctx.db.component_node().id().update(ComponentNode {
            props,
            updated_by: actor(ctx),
            updated_at: ctx.timestamp,
            ..node
        });
        touch_page(ctx, page);
    }
    Ok(())
}
pub(crate) fn reference(ctx: &ReducerContext, component_id: &str) -> Result<String, String> {
    let node = require_live_node(ctx, state::id(component_id)?)?;
    require_page_read(ctx, node.surface_id)?;
    if node.component_type != COMPONENT_TYPE {
        return Err("INVALID_PAGE_PANEL: reference is not a Trellis panel".into());
    }
    state::parse(&node.props)?;
    Ok(serde_json::json!({"v":"pear_page_component_v1", "surfaceId":node.surface_id.to_string(), "blockId":component_id}).to_string())
}
