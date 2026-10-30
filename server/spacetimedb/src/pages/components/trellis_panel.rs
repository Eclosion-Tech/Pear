//! One page-owned component. Its ordinary ComponentNode.props is authoritative.
use super::*;
use crate::access_control::helpers::require_page_read;
use crate::ai::ai_user_profile;
#[path = "trellis_interface_state.rs"]
pub(crate) mod interface_state;
#[path = "trellis_panel_state.rs"]
pub(crate) mod state;
pub const COMPONENT_TYPE: &str = "TrellisPanel";
pub(super) fn initialize(
    ctx: &ReducerContext,
    parent_id: u64,
    node_id: u64,
    parameters_json: &str,
) -> Result<String, String> {
    if serde_json::from_str::<serde_json::Value>(parameters_json)
        .ok()
        .is_some_and(|v| v.get("templateId").is_some())
    {
        let parent = require_live_node(ctx, parent_id)?;
        return interface_state::create(
            parent.surface_id,
            node_id,
            &parent_id.to_string(),
            &ctx.sender().to_hex().to_string(),
            &format!("insert:{node_id}"),
            parameters_json,
        );
    }
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
    if serde_json::from_str::<serde_json::Value>(&parameters_json)
        .ok()
        .is_some_and(|v| v.get("templateId").is_some())
    {
        return create_interface(ctx, &parent_id, &request_id, &parameters_json);
    }
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
    if existing_creation(
        ctx,
        page.id,
        &parent_id.to_string(),
        &principal,
        &request_id,
        &expected,
    )? {
        return Ok(());
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
    let update = if interface_state::is_interface(&node.props) {
        validate_interface_owner(&node)?;
        interface_state::commit(
            &node.props,
            base_revision,
            &ctx.sender().to_hex().to_string(),
            &request_id,
            &parameters_json,
        )?
    } else {
        state::commit(
            &node.props,
            base_revision,
            &ctx.sender().to_hex().to_string(),
            &request_id,
            &parameters_json,
        )?
    };
    if let Some(props) = update {
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
    if interface_state::is_interface(&node.props) {
        validate_interface_owner(&node)?;
    } else {
        state::parse(&node.props)?;
    }
    Ok(serde_json::json!({"v":"pear_page_component_v1", "surfaceId":node.surface_id.to_string(), "blockId":component_id}).to_string())
}
fn validate_interface_owner(node: &ComponentNode) -> Result<(), String> {
    let saved = interface_state::parse(&node.props)?;
    if saved["document"]["documentId"]
        != format!("pear-page:{}:component:{}", node.surface_id, node.id)
        || saved["document"]["template"]["instanceId"] != format!("pear-component:{}", node.id)
    {
        return Err("INVALID_INTERFACE: document belongs to another component".into());
    }
    Ok(())
}
fn create_interface(
    ctx: &ReducerContext,
    parent_id: &str,
    request_id: &str,
    descriptor: &str,
) -> Result<(), String> {
    let parent_id = state::id(parent_id)?;
    let parent = require_live_node(ctx, parent_id)?;
    let page = require_component_tree_page(ctx, parent.surface_id)?;
    require_page_write(ctx, page.id)?;
    if !require_type_def(ctx, &parent.component_type)?.accepts_children {
        return Err("Parent cannot contain an interface".into());
    }
    require_type_def(ctx, COMPONENT_TYPE)?;
    let principal = ctx.sender().to_hex().to_string();
    let fingerprint = interface_state::creation_fingerprint(descriptor)?;
    if existing_creation(
        ctx,
        page.id,
        &parent_id.to_string(),
        &principal,
        request_id,
        &fingerprint,
    )? {
        return Ok(());
    }
    let id = next_component_node_id(ctx);
    let props = interface_state::create(
        page.id,
        id,
        &parent_id.to_string(),
        &principal,
        request_id,
        descriptor,
    )?;
    let siblings = live_siblings_sorted(ctx, page.id, parent_id, None);
    let count = siblings.len();
    let order = renumber_with_gap(ctx, siblings, count);
    let author = actor(ctx);
    ctx.db.component_node().insert(ComponentNode {
        id,
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

// Creation requests share one namespace across legacy and registered definitions.
fn existing_creation(
    ctx: &ReducerContext,
    page_id: u64,
    parent_id: &str,
    principal: &str,
    request_id: &str,
    fingerprint: &str,
) -> Result<bool, String> {
    for node in ctx.db.component_node().surface_id().filter(page_id) {
        if node.component_type != COMPONENT_TYPE {
            continue;
        }
        let creation = if interface_state::is_interface(&node.props) {
            let Ok(saved) = interface_state::parse(&node.props) else {
                continue;
            };
            saved["creation"].clone()
        } else {
            let Ok(saved) = state::parse(&node.props) else {
                continue;
            };
            serde_json::to_value(saved.creation).map_err(|e| e.to_string())?
        };
        if creation["principal"] == principal
            && creation["parentId"] == parent_id
            && creation["requestId"] == request_id
        {
            if creation["fingerprint"] != fingerprint {
                return Err("REQUEST_REUSED: create request has different arguments".into());
            }
            if node.deleted_at.is_some() {
                return Err("PANEL_DELETED: created interface was deleted".into());
            }
            return Ok(true);
        }
    }
    Ok(false)
}
