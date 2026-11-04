//! One page-owned component. Its ordinary ComponentNode.props is authoritative.
use super::*;
use crate::access_control::helpers::require_page_read;
use crate::ai::ai_user_profile;
use crate::component_repository::component_template_version;
#[path = "authored_component_state.rs"]
pub(crate) mod authored_state;
#[path = "trellis_interface_state.rs"]
pub(crate) mod interface_state;
#[path = "component_repository_state.rs"]
pub(crate) mod repository_state;
#[path = "trellis_panel_state.rs"]
pub(crate) mod state;
pub const COMPONENT_TYPE: &str = "TrellisPanel";
pub(super) fn initialize(
    ctx: &ReducerContext,
    parent_id: u64,
    node_id: u64,
    parameters_json: &str,
) -> Result<String, String> {
    if is_authored_descriptor(parameters_json) {
        let parent = require_live_node(ctx, parent_id)?;
        use crate::component_repository::component_template_family;
        let descriptor = interface_state::parse_json(parameters_json)?;
        if descriptor["kind"] == "component-template"
            && ctx
                .db
                .component_template_family()
                .template_id()
                .find(interface_state::text(&descriptor["templateId"])?.to_string())
                .is_some_and(|f| f.archived)
        {
            return Err(
                "TEMPLATE_ARCHIVED: This template cannot be used for new components".into(),
            );
        }
        return authored_create(
            ctx,
            parent.surface_id,
            node_id,
            &parent_id.to_string(),
            &format!("insert:{node_id}"),
            parameters_json,
        );
    }
    if serde_json::from_str::<serde_json::Value>(parameters_json)
        .ok()
        .is_some_and(|v| v.get("templateId").is_some())
    {
        let parent = require_live_node(ctx, parent_id)?;
        return interface_state::create_with_registry(
            parent.surface_id,
            node_id,
            &parent_id.to_string(),
            &ctx.sender().to_hex().to_string(),
            &format!("insert:{node_id}"),
            parameters_json,
            &crate::component_repository::registry_for_create(ctx, parameters_json)?,
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
    if is_authored_descriptor(&parameters_json) {
        return create_authored(ctx, &parent_id, &request_id, &parameters_json);
    }
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
    let update = if authored_state::is_component(&node.props) {
        validate_authored_owner(&node)?;
        let command = interface_state::parse_json(&parameters_json)?;
        // Recheck source authorization even for a duplicate request after revocation.
        let writes = if command["kind"] == "source-write" {
            Some(workspace_writes(
                ctx,
                &authored_state::parse(&node.props)?,
                &command["write"],
            )?)
        } else {
            None
        };
        let mut update = authored_state::commit(
            &node.props,
            base_revision,
            &ctx.sender().to_hex().to_string(),
            &request_id,
            &parameters_json,
        )?;
        if command["kind"] == "source-create" {
            let saved = authored_state::parse(&node.props)?;
            let (source, values) =
                authored_state::create_intent(&saved, &command["event"], update.is_none())?;
            // Creation authority is rechecked before accepting even a matching
            // durable receipt. A retry never creates a second page.
            let (database, properties) = workspace_create_values(ctx, &saved, &source, &values)?;
            if let Some(props) = update.as_mut() {
                let title = values
                    .as_object()
                    .and_then(|values| {
                        values
                            .values()
                            .find_map(|value| value.as_str().filter(|text| !text.trim().is_empty()))
                    })
                    .unwrap_or("New entry")
                    .chars()
                    .take(200)
                    .collect();
                let row = crate::pages::create_component_tree_page_inner(
                    ctx,
                    Some(database),
                    crate::pages::PageType::Doc,
                    title,
                    actor(ctx),
                )?;
                for (property, value) in properties {
                    crate::pages::schemas::set_property_value_inner(
                        ctx,
                        row,
                        property,
                        value,
                        actor(ctx),
                    )?;
                }
                let mut committed = interface_state::parse_json(props)?;
                let receipt = committed["receipts"]
                    .as_array_mut()
                    .and_then(|receipts| receipts.last_mut())
                    .ok_or("INVALID_RECEIPT: Creation receipt unavailable")?;
                receipt["recordId"] = serde_json::json!(row.to_string());
                *props = committed.to_string();
                authored_state::parse(props)?;
            }
        }
        if update.is_some() {
            if let Some((row, values)) = writes {
                for (property, value) in values {
                    crate::pages::schemas::set_property_value_inner(
                        ctx,
                        row,
                        property,
                        value,
                        actor(ctx),
                    )?;
                }
            }
        }
        update
    } else if interface_state::is_interface(&node.props) {
        validate_interface_owner(ctx, &node)?;
        interface_state::commit_with_registry(
            &node.props,
            base_revision,
            &ctx.sender().to_hex().to_string(),
            &request_id,
            &parameters_json,
            &crate::component_repository::registry_for_props(ctx, &node.props)?,
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
    if authored_state::is_component(&node.props) {
        validate_authored_owner(&node)?;
    } else if interface_state::is_interface(&node.props) {
        validate_interface_owner(ctx, &node)?;
    } else {
        state::parse(&node.props)?;
    }
    Ok(serde_json::json!({"v":"pear_page_component_v1", "surfaceId":node.surface_id.to_string(), "blockId":component_id}).to_string())
}
fn validate_interface_owner(ctx: &ReducerContext, node: &ComponentNode) -> Result<(), String> {
    let saved = interface_state::parse_with_registry(
        &node.props,
        &crate::component_repository::registry_for_props(ctx, &node.props)?,
    )?;
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
    let props = interface_state::create_with_registry(
        page.id,
        id,
        &parent_id.to_string(),
        &principal,
        request_id,
        descriptor,
        &crate::component_repository::registry_for_create(ctx, descriptor)?,
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
        let creation = if authored_state::is_component(&node.props) {
            let Ok(saved) = authored_state::parse(&node.props) else {
                continue;
            };
            saved["creation"].clone()
        } else if interface_state::is_interface(&node.props) {
            let Ok(registry) = crate::component_repository::registry_for_props(ctx, &node.props)
            else {
                continue;
            };
            let Ok(saved) = interface_state::parse_with_registry(&node.props, &registry) else {
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

fn is_authored_descriptor(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .is_some_and(|v| v["kind"] == "component" || v["kind"] == "component-template")
}
fn validate_authored_owner(node: &ComponentNode) -> Result<(), String> {
    let saved = authored_state::parse(&node.props)?;
    if saved["document"]["documentId"]
        != format!("pear-page:{}:component:{}", node.surface_id, node.id)
    {
        return Err("INVALID_COMPONENT: Document belongs to another component".into());
    }
    Ok(())
}
fn authored_create(
    ctx: &ReducerContext,
    page: u64,
    id: u64,
    parent: &str,
    request: &str,
    raw: &str,
) -> Result<String, String> {
    let descriptor = interface_state::parse_json(raw)?;
    let principal = ctx.sender().to_hex().to_string();
    match descriptor["kind"].as_str() {
        Some("component") => {
            interface_state::keys(&descriptor, &["kind", "title"])?;
            authored_state::create(
                page,
                id,
                parent,
                &principal,
                request,
                interface_state::text(&descriptor["title"])?,
            )
        }
        Some("component-template") => {
            interface_state::keys(&descriptor, &["kind", "templateId", "version", "hash"])?;
            let template = interface_state::text(&descriptor["templateId"])?;
            let version = interface_state::text(&descriptor["version"])?;
            let row = ctx
                .db
                .component_template_version()
                .key()
                .find(format!("{template}@{version}"))
                .ok_or("TEMPLATE_NOT_FOUND: Exact component version unavailable")?;
            if row.content_hash != interface_state::text(&descriptor["hash"])? {
                return Err("TEMPLATE_PINNED: Package hash changed".into());
            }
            authored_state::instantiate(
                page,
                id,
                parent,
                &principal,
                request,
                &row.package_json,
                &row.content_hash,
            )
        }
        _ => Err("INVALID_COMPONENT: Unsupported creation descriptor".into()),
    }
}
fn create_authored(
    ctx: &ReducerContext,
    parent: &str,
    request: &str,
    descriptor: &str,
) -> Result<(), String> {
    use crate::component_repository::component_template_family;
    let parent_id = state::id(parent)?;
    let parent_node = require_live_node(ctx, parent_id)?;
    let page = require_component_tree_page(ctx, parent_node.surface_id)?;
    require_page_write(ctx, page.id)?;
    if !require_type_def(ctx, &parent_node.component_type)?.accepts_children {
        return Err("Parent cannot contain a component".into());
    }
    require_type_def(ctx, COMPONENT_TYPE)?;
    let id = next_component_node_id(ctx);
    let props = authored_create(ctx, page.id, id, parent, request, descriptor)?;
    let saved = authored_state::parse(&props)?;
    if existing_creation(
        ctx,
        page.id,
        parent,
        &ctx.sender().to_hex().to_string(),
        request,
        interface_state::text(&saved["creation"]["fingerprint"])?,
    )? {
        return Ok(());
    }
    let value = interface_state::parse_json(descriptor)?;
    if value["kind"] == "component-template"
        && ctx
            .db
            .component_template_family()
            .template_id()
            .find(interface_state::text(&value["templateId"])?.to_string())
            .is_some_and(|f| f.archived)
    {
        return Err("TEMPLATE_ARCHIVED: Existing instances remain available".into());
    }
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
// All fields are checked before any write. The reducer transaction commits the
// property history, automation triggers and component retry receipt together.
fn workspace_writes(
    ctx: &ReducerContext,
    saved: &serde_json::Value,
    write: &serde_json::Value,
) -> Result<(u64, Vec<(u64, crate::pages::schemas::PropertyValue)>), String> {
    use crate::pages::schemas::{
        database_schema, property_definition, PropertyType, PropertyValue,
    };
    authored_state::authorize_write(saved, write)?;
    let source = &saved["sources"][interface_state::text(&write["source"])?];
    let connection = &source["connection"];
    if connection["adapter"] != "pear.database" {
        return Err("SOURCE_WRITE_REQUIRED: Source adapter must confirm external writes".into());
    }
    let schema = ctx
        .db
        .database_schema()
        .id()
        .find(state::id(interface_state::text(&connection["schemaId"])?)?)
        .ok_or("READ_ONLY_SOURCE: Database unavailable")?;
    ctx.db
        .page()
        .id()
        .find(schema.page_id)
        .filter(|page| page.deleted_at.is_none())
        .ok_or("READ_ONLY_SOURCE: Source database is deleted")?;
    require_page_read(ctx, schema.page_id)?;
    let first = ctx
        .db
        .page()
        .parent_pk()
        .filter(schema.page_id)
        .filter(|page| page.deleted_at.is_none() && require_page_read(ctx, page.id).is_ok())
        .map(|page| page.id)
        .min()
        .map(|id| id.to_string());
    authored_state::authorize_write_for_record(saved, write, first.as_deref())?;
    let row_id = state::id(interface_state::text(&write["recordId"])?)?;
    let row = ctx
        .db
        .page()
        .id()
        .find(row_id)
        .filter(|p| p.deleted_at.is_none() && p.parent_id == Some(schema.page_id))
        .ok_or("READ_ONLY_SOURCE: Record is not in the connected database")?;
    require_page_write(ctx, row.id)?;
    let mut seen = std::collections::BTreeSet::new();
    let mut values = Vec::new();
    for (field, value) in interface_state::object(&write["values"])? {
        let id = state::id(interface_state::text(&connection["mapping"][field])?)?;
        let property = ctx
            .db
            .property_definition()
            .id()
            .find(id)
            .filter(|p| p.schema_id == schema.id)
            .ok_or("READ_ONLY_SOURCE: Field is not in the connected schema")?;
        if !seen.insert(id) {
            return Err("INVALID_BINDING: Multiple source fields target the same property".into());
        }
        let value =
            match property.property_type {
                PropertyType::Text => PropertyValue::Text(interface_state::text(value)?.into()),
                PropertyType::Url => PropertyValue::Url(interface_state::text(value)?.into()),
                PropertyType::Number => PropertyValue::Number(
                    value
                        .as_f64()
                        .filter(|v| v.is_finite())
                        .ok_or("INVALID_BINDING: Expected finite number")?,
                ),
                PropertyType::Checkbox => PropertyValue::Checkbox(
                    value.as_bool().ok_or("INVALID_BINDING: Expected boolean")?,
                ),
                _ => return Err(
                    "READ_ONLY_SOURCE: This property has no supported component write operation"
                        .into(),
                ),
            };
        values.push((id, value));
    }
    Ok((row.id, values))
}
fn workspace_create_values(
    ctx: &ReducerContext,
    saved: &serde_json::Value,
    source_id: &str,
    values: &serde_json::Value,
) -> Result<(u64, Vec<(u64, crate::pages::schemas::PropertyValue)>), String> {
    use crate::pages::schemas::{
        database_schema, property_definition, PropertyType, PropertyValue,
    };
    crate::access_control::helpers::require_workspace_principal(ctx)?;
    let source = &saved["sources"][source_id];
    let connection = &source["connection"];
    if connection["adapter"] != "pear.database" {
        return Err("SOURCE_WRITE_REQUIRED: External creation requires its source adapter".into());
    }
    let schema = ctx
        .db
        .database_schema()
        .id()
        .find(state::id(interface_state::text(&connection["schemaId"])?)?)
        .ok_or("READ_ONLY_SOURCE: Database unavailable")?;
    ctx.db
        .page()
        .id()
        .find(schema.page_id)
        .filter(|page| page.deleted_at.is_none())
        .ok_or("READ_ONLY_SOURCE: Source database is deleted")?;
    require_page_read(ctx, schema.page_id)?;
    require_page_write(ctx, schema.page_id)?;
    let mut properties = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for (field, value) in interface_state::object(values)? {
        if source["fields"][field]["writable"] != true {
            return Err("READ_ONLY_SOURCE: Field is read-only".into());
        }
        let id = state::id(interface_state::text(&connection["mapping"][field])?)?;
        let property = ctx
            .db
            .property_definition()
            .id()
            .find(id)
            .filter(|p| p.schema_id == schema.id)
            .ok_or("READ_ONLY_SOURCE: Field is not in the connected schema")?;
        if !seen.insert(id) {
            return Err("INVALID_BINDING: Multiple source fields target one property".into());
        }
        let value = match property.property_type {
            PropertyType::Text => PropertyValue::Text(interface_state::text(value)?.into()),
            PropertyType::Url => PropertyValue::Url(interface_state::text(value)?.into()),
            PropertyType::Number => PropertyValue::Number(
                value
                    .as_f64()
                    .filter(|v| v.is_finite())
                    .ok_or("INVALID_BINDING: Expected finite number")?,
            ),
            PropertyType::Checkbox => {
                PropertyValue::Checkbox(value.as_bool().ok_or("INVALID_BINDING: Expected boolean")?)
            }
            _ => return Err("READ_ONLY_SOURCE: Field has no supported creation operation".into()),
        };
        properties.push((id, value));
    }
    if properties.is_empty() {
        return Err("INVALID_BINDING: Choose fields for the new record".into());
    }
    Ok((schema.page_id, properties))
}
