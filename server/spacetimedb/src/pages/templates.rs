//! A readable page can be used as a database record template or duplicated.
//! References are copied as identities, never materialized source text.
use super::components::{
    component_node, component_yjs_state, next_component_node_id, ComponentNode, ComponentYjsState,
};
use super::schemas::{page_property_value, set_property_value_inner};
use super::{create_component_tree_page_inner, page, ActorType, PageContentFormat, PageType};
use crate::access_control::helpers::{can_read_block, require_page_read, require_page_write};
use serde_json::{json, Value};
use spacetimedb::{reducer, ReducerContext, Table};
use std::collections::BTreeMap;

fn copy_props(
    kind: &str,
    raw: &str,
    page_id: u64,
    node_id: u64,
    parent_id: Option<u64>,
    principal: &str,
) -> Result<String, String> {
    // Includes PropertyReference: self parameters and explicit source IDs stay byte-for-byte intact.
    if kind != "TrellisPanel" {
        return Ok(raw.into());
    }
    let mut saved: Value = serde_json::from_str(raw).map_err(|_| "Invalid saved component")?;
    if !matches!(
        saved["v"].as_str(),
        Some("trellis_component_v1" | "trellis_instance_v1" | "pear_trellis_panel_v1")
    ) {
        return Err("This saved component version cannot be copied by this client".into());
    }
    let request = format!("copy:{node_id}");
    saved["creation"]["parentId"] = json!(parent_id.unwrap_or(0).to_string());
    saved["creation"]["principal"] = json!(principal);
    saved["creation"]["requestId"] = json!(request);
    saved["updatedBy"] = json!(principal);
    saved["receipts"] = json!([{ "principal":principal,"requestId":request,"fingerprint":saved["creation"]["fingerprint"],"revision":0 }]);
    if saved["v"] == "pear_trellis_panel_v1" {
        saved["revision"] = json!(0);
        return Ok(saved.to_string());
    }
    let nodes = saved["document"]["nodes"]
        .as_array()
        .ok_or("Invalid component nodes")?;
    let fresh_prefix = if saved["v"] == "trellis_instance_v1" {
        format!("pear-copy:{node_id}")
    } else {
        format!("pear-component:{node_id}")
    };
    let mut ids: BTreeMap<String, String> = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            (
                n["id"].as_str().unwrap_or("").to_string(),
                format!("{fresh_prefix}:n{i}"),
            )
        })
        .collect();
    // Registered templates pin semantic-node suffixes, including retired nodes
    // in forked instances. Preserve that mapping under the new instance ID.
    if let Some(retired) = saved["document"]["retiredIds"].as_array() {
        for (i, id) in retired.iter().enumerate() {
            ids.insert(
                id.as_str().ok_or("Invalid retired node ID")?.into(),
                format!("{fresh_prefix}:retired-{i}"),
            );
        }
    }
    if let Some(mapping) = saved["document"]["template"]["mapping"].as_object() {
        for (key, id) in mapping {
            ids.insert(
                id.as_str().ok_or("Invalid template mapping")?.into(),
                format!("pear-component:{node_id}:{key}"),
            );
        }
    }
    let map = |v: &Value| -> Result<Value, String> {
        Ok(json!(ids
            .get(v.as_str().ok_or("Invalid node ID")?)
            .ok_or("Missing node mapping")?))
    };
    saved["document"]["rootId"] = map(&saved["document"]["rootId"])?;
    for node in saved["document"]["nodes"].as_array_mut().unwrap() {
        node["id"] = map(&node["id"])?;
        if !node["parentId"].is_null() {
            node["parentId"] = map(&node["parentId"])?;
        }
    }
    if let Some(bindings) = saved.get_mut("bindings").and_then(Value::as_object_mut) {
        *bindings = bindings
            .iter()
            .map(|(id, b)| {
                Ok((
                    ids.get(id).ok_or("Missing binding mapping")?.clone(),
                    b.clone(),
                ))
            })
            .collect::<Result<_, &str>>()?;
    }
    if let Some(actions) = saved.get_mut("actions").and_then(Value::as_object_mut) {
        for action in actions.values_mut() {
            if action["kind"] == "local" {
                if let Some(effects) = action["effects"].as_array_mut() {
                    for effect in effects {
                        if effect["target"].get("id").is_some() {
                            effect["target"]["id"] = map(&effect["target"]["id"])?;
                        }
                    }
                }
            }
        }
    }
    let doc = &mut saved["document"];
    doc["documentId"] = json!(format!("pear-page:{page_id}:component:{node_id}"));
    doc["revision"] = json!(0);
    doc["retiredIds"] = Value::Array(
        doc["retiredIds"]
            .as_array()
            .ok_or("Invalid retired IDs")?
            .iter()
            .map(map)
            .collect::<Result<Vec<_>, _>>()?,
    );
    if let Some(template) = doc.get_mut("template") {
        template["instanceId"] = json!(format!("pear-component:{node_id}"));
        if let Some(mapping) = template["mapping"].as_object_mut() {
            for id in mapping.values_mut() {
                *id = map(id)?;
            }
        }
    }
    Ok(saved.to_string())
}

#[reducer]
pub fn create_page_from_template(
    ctx: &ReducerContext,
    source_page_id: u64,
    parent_id: Option<u64>,
    title: String,
) -> Result<(), String> {
    require_page_read(ctx, source_page_id)?;
    if let Some(parent) = parent_id {
        require_page_write(ctx, parent)?;
    }
    let source = ctx
        .db
        .page()
        .id()
        .find(source_page_id)
        .ok_or("Template unavailable")?;
    if source.deleted_at.is_some()
        || source.content_format != PageContentFormat::ComponentTree
        || source.page_type != PageType::Doc
    {
        return Err("Choose a live document page as a template".into());
    }
    // Snapshot only reachable live nodes: deleted ancestors must not resurrect their children.
    let all: Vec<_> = ctx
        .db
        .component_node()
        .surface_id()
        .filter(source_page_id)
        .filter(|n| n.deleted_at.is_none())
        .collect();
    let root = all
        .iter()
        .find(|n| n.parent_id.is_none())
        .ok_or("Template has no document root")?;
    let mut ordered = vec![root];
    let mut index = 0;
    while index < ordered.len() {
        let parent = ordered[index].id;
        ordered.extend(all.iter().filter(|n| n.parent_id == Some(parent)));
        index += 1;
        if ordered.len() > all.len() {
            return Err("Invalid template tree".into());
        }
    }
    for n in &ordered {
        if !can_read_block(ctx, source_page_id, &n.id.to_string(), ctx.sender()) {
            return Err("Template contains unavailable content".into());
        }
    }
    let page_id =
        create_component_tree_page_inner(ctx, parent_id, PageType::Doc, title, ActorType::Human)?;
    let defaults: Vec<_> = ctx
        .db
        .component_node()
        .surface_id()
        .filter(page_id)
        .collect();
    for node in defaults {
        ctx.db.component_node().id().delete(node.id);
    }
    let ids: BTreeMap<_, _> = ordered
        .iter()
        .map(|n| (n.id, next_component_node_id(ctx)))
        .collect();
    let principal = ctx.sender().to_hex().to_string();
    for n in ordered {
        let id = ids[&n.id];
        let parent = n.parent_id.map(|old| ids[&old]);
        let props = copy_props(&n.component_type, &n.props, page_id, id, parent, &principal)?;
        ctx.db.component_node().insert(ComponentNode {
            id,
            surface_id: page_id,
            parent_id: parent,
            component_type: n.component_type.clone(),
            props,
            order: n.order,
            created_by: ActorType::Human,
            updated_by: ActorType::Human,
            created_at: ctx.timestamp,
            updated_at: ctx.timestamp,
            deleted_at: None,
        });
        if let Some(state) = ctx.db.component_yjs_state().component_node_id().find(n.id) {
            ctx.db.component_yjs_state().insert(ComponentYjsState {
                component_node_id: id,
                data: state.data,
                updated_at: ctx.timestamp,
            });
        }
    }
    // Column identities belong to a database. Copy defaults only within that same database.
    if source.parent_id == parent_id {
        let values: Vec<_> = ctx
            .db
            .page_property_value()
            .page_id()
            .filter(source_page_id)
            .collect();
        for value in values {
            set_property_value_inner(
                ctx,
                page_id,
                value.property_definition_id,
                value.value,
                ActorType::Human,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copied_authored_components_keep_valid_state_and_fresh_identity() {
        let raw = super::super::components::trellis_panel::authored_state::create(
            1,
            2,
            "3",
            "viewer",
            "original",
            "Component",
        )
        .unwrap();
        let copied = copy_props("TrellisPanel", &raw, 11, 12, Some(13), "viewer").unwrap();
        let parsed =
            super::super::components::trellis_panel::authored_state::parse(&copied).unwrap();
        assert_eq!(
            parsed["document"]["documentId"],
            "pear-page:11:component:12"
        );
        assert_eq!(parsed["document"]["rootId"], "pear-component:12:n0");
        assert_eq!(parsed["creation"]["parentId"], "13");
    }
    #[test]
    fn copied_registered_components_preserve_valid_template_provenance() {
        let raw = super::super::components::trellis_panel::interface_state::create(
            1,
            2,
            "3",
            "viewer",
            "original",
            r#"{"templateId":"trellis.note-form","templateVersion":"1.0.0","parameters":{}}"#,
        )
        .unwrap();
        let copied = copy_props("TrellisPanel", &raw, 11, 12, Some(13), "viewer").unwrap();
        let parsed =
            super::super::components::trellis_panel::interface_state::parse(&copied).unwrap();
        assert_eq!(
            parsed["document"]["template"]["instanceId"],
            "pear-component:12"
        );
    }
    #[test]
    fn template_and_duplicate_never_rewrite_reference_targets_or_literal_text() {
        for target in [json!({"param":"record"}), json!("321")] {
            let raw = json!({"v":1,"schemaId":"5","binding":{"source":"property","recordId":target,"field":"7","property":"text","writeBack":false}}).to_string();
            for record in [11, 12] {
                assert_eq!(
                    copy_props(
                        "PropertyReference",
                        &raw,
                        record,
                        record + 100,
                        Some(90),
                        "viewer"
                    )
                    .unwrap(),
                    raw
                );
            }
        }
        assert_eq!(
            copy_props(
                "RichText",
                r#"{"text":"{{this.summary}}"}"#,
                1,
                2,
                None,
                "viewer"
            )
            .unwrap(),
            r#"{"text":"{{this.summary}}"}"#
        );
    }
}
