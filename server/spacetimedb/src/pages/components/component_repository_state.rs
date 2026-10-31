//! Deterministic export. No source page/document identity or transient surface state is exported.
use super::interface_state as state;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

fn invalid(message: &str) -> String {
    format!("INVALID_TEMPLATE: {message}")
}
pub(crate) fn canonical(value: &Value) -> Result<String, String> {
    // The current trusted UI catalog has integer numeric props only. Normalize
    // JSON integer spellings (1.0 / -0) to the same representation as JS.
    match value {
        Value::Object(map) => Ok(format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| Ok(format!(
                    "{}:{}",
                    serde_json::to_string(k).unwrap(),
                    canonical(v)?
                )))
                .collect::<Result<Vec<_>, String>>()?
                .join(",")
        )),
        Value::Array(items) => Ok(format!(
            "[{}]",
            items
                .iter()
                .map(canonical)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        Value::Number(number) => {
            let n = number.as_f64().ok_or_else(|| invalid("Invalid number"))?;
            if n.fract() != 0.0 || n.abs() > 9_007_199_254_740_991.0 {
                return Err(invalid("Template numeric values must be safe integers supported by the current host catalog"));
            }
            Ok(if n == 0.0 {
                "0".into()
            } else {
                format!("{n:.0}")
            })
        }
        _ => serde_json::to_string(value).map_err(|e| invalid(&e.to_string())),
    }
}
pub(crate) fn options(raw: &str) -> Result<Value, String> {
    let value = state::parse_json(raw)?;
    state::keys(&value, &["slug", "version", "name", "description", "tags"])?;
    let slug = state::text(&value["slug"])?;
    if slug.is_empty()
        || slug.len() > 64
        || !slug.as_bytes()[0].is_ascii_lowercase()
        || !slug
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(invalid("Use a lowercase template slug"));
    }
    version(state::text(&value["version"])?)?;
    bounded_text(&value["name"], 160, false)?;
    bounded_text(&value["description"], 4000, true)?;
    let tags = value["tags"]
        .as_array()
        .ok_or_else(|| invalid("Expected tags"))?;
    let mut seen = BTreeSet::new();
    if tags.len() > 8 {
        return Err(invalid("Too many tags"));
    }
    for tag in tags {
        bounded_text(tag, 32, false)?;
        if !seen.insert(state::text(tag)?) {
            return Err(invalid("Duplicate tag"));
        }
    }
    Ok(value)
}
fn bounded_text(value: &Value, max: usize, empty: bool) -> Result<(), String> {
    let s = state::text(value)?;
    if (!empty && s.trim().is_empty()) || s.encode_utf16().count() > max {
        return Err(invalid("Text outside bounds"));
    }
    Ok(())
}
pub(crate) fn version(value: &str) -> Result<Vec<u32>, String> {
    let fields: Vec<_> = value.split('.').collect();
    if fields.len() != 3
        || fields.iter().any(|v| {
            v.is_empty()
                || v.len() > 9
                || (v.len() > 1 && v.starts_with('0'))
                || !v.bytes().all(|c| c.is_ascii_digit())
        })
    {
        return Err(invalid("Use an exact major.minor.patch version"));
    }
    fields
        .into_iter()
        .map(|v| v.parse().map_err(|_| invalid("Invalid version")))
        .collect()
}
fn parameter(
    node: &Value,
    local_id: &str,
    property: &str,
    value: Value,
    schema: Value,
    schemas: &mut Map<String, Value>,
    defaults: &mut Map<String, Value>,
) -> Value {
    let base = node["key"].as_str().unwrap_or(local_id);
    let candidate = if property == "text" {
        base.to_string()
    } else {
        format!("{base}_{property}")
    };
    let mut name: String = candidate
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.len() > 256
        || !name
            .as_bytes()
            .first()
            .is_some_and(|c| c.is_ascii_alphabetic())
        || ["__proto__", "constructor", "prototype"].contains(&name.as_str())
        || schemas.contains_key(&name)
    {
        name = format!("{local_id}_{property}");
    }
    schemas.insert(name.clone(), schema);
    defaults.insert(name.clone(), value);
    json!({"$param":name})
}
pub(crate) fn prepare(
    existing: &str,
    registry: &Value,
    raw_options: &str,
) -> Result<Value, String> {
    let saved = state::parse_with_registry(existing, registry)?;
    let options = options(raw_options)?;
    let document = &saved["document"];
    let nodes = document["nodes"].as_array().unwrap();
    let origin = &document["template"];
    let source = state::definition(registry, &origin["id"], &origin["version"])?;
    let mut mapping = BTreeMap::new();
    let mut sequence = 0;
    for node in nodes {
        let local = if node["id"] == document["rootId"] {
            "root".into()
        } else {
            sequence += 1;
            format!("node_{sequence}")
        };
        mapping.insert(state::text(&node["id"])?.to_string(), local);
    }
    let mut used_keys: BTreeSet<String> = nodes
        .iter()
        .filter_map(|n| n["key"].as_str().map(str::to_string))
        .collect();
    let mut outputs = BTreeMap::new();
    let mut bindings = Map::new();
    let mut slots = BTreeMap::new();
    for node in nodes {
        let Some(action) = node.get("action") else {
            continue;
        };
        let action_name = state::text(&action["slot"])?;
        if slots.contains_key(action_name) {
            continue;
        }
        let (slot, policy) = state::object(&source["bindings"])?
            .iter()
            .find(|(_, b)| b["action"] == action_name)
            .ok_or_else(|| invalid("Unknown source action"))?;
        let mut binding = policy.clone();
        if binding["effect"]["kind"] == "setText" {
            let selector = &binding["effect"]["target"];
            let (key, value) = state::object(selector)?
                .iter()
                .next()
                .ok_or_else(|| invalid("Invalid target"))?;
            let target = nodes
                .iter()
                .find(|n| n.get(key) == Some(value))
                .ok_or_else(|| invalid("Output target missing"))?;
            let target_id = state::text(&target["id"])?;
            let output_key = if let Some(key) = target["key"].as_str() {
                key.to_string()
            } else {
                let mut key = format!("output_{}", mapping[target_id]);
                while used_keys.contains(&key) {
                    key.push('_');
                }
                used_keys.insert(key.clone());
                key
            };
            outputs.insert(target_id.to_string(), output_key.clone());
            binding["effect"]["target"] = json!({"key":output_key});
        }
        slots.insert(action_name.to_string(), slot.clone());
        bindings.insert(slot.clone(), binding);
    }
    let mut schemas = Map::new();
    let mut defaults = Map::new();
    let mut exported = Vec::new();
    for original in nodes {
        let source_id = state::text(&original["id"])?;
        let local_id = &mapping[source_id];
        let mut node = original.clone();
        node["id"] = json!(local_id);
        node["parentId"] = if original["parentId"].is_null() {
            Value::Null
        } else {
            json!(mapping[state::text(&original["parentId"])?])
        };
        if let Some(key) = outputs.get(source_id) {
            node["key"] = json!(key);
        }
        let component = &registry["catalog"]["components"][state::text(&original["type"])?];
        let props = node["props"].as_object_mut().unwrap();
        if component["field"] == true {
            props.insert("defaultValue".into(), json!(""));
        }
        if original["type"] == "ChecklistItem" {
            props.insert("checked".into(), json!(false));
        }
        for (key, value) in props.clone() {
            if key == "name" {
                continue;
            }
            if let Some(schema) = component["props"]["properties"].get(&key) {
                if !["object", "array"].contains(&schema["type"].as_str().unwrap_or("")) {
                    props.insert(
                        key.clone(),
                        parameter(
                            original,
                            local_id,
                            &key,
                            value,
                            schema.clone(),
                            &mut schemas,
                            &mut defaults,
                        ),
                    );
                }
            }
        }
        if outputs.contains_key(source_id) {
            node["text"] = json!([]);
        } else if let Some(runs) = original["text"].as_array() {
            if runs.len() == 1 && state::object(&runs[0])?.len() == 1 {
                node["text"] = json!([{"text":parameter(original, local_id, "text", runs[0]["text"].clone(), json!({"type":"string","maxLength":16384}), &mut schemas, &mut defaults)}]);
            }
        }
        if let Some(action) = node.get_mut("action") {
            action["slot"] = json!(slots[state::text(&original["action"]["slot"])?]);
        }
        exported.push(node);
    }
    let required: Vec<_> = nodes.iter().map(|n| n["type"].clone()).collect::<Vec<_>>();
    let required: BTreeSet<_> = required.iter().map(|v| v.as_str().unwrap()).collect();
    let mut template = json!({"id":format!("workspace:{}",options["slug"].as_str().unwrap()),"version":options["version"],"description":options["description"],"catalogVersion":registry["catalog"]["version"],"parameters":{"type":"object","properties":schemas,"required":schemas.keys().collect::<Vec<_>>()},"requiredComponents":required,"actionSlots":bindings.keys().collect::<Vec<_>>(),"rootId":"root","nodes":exported});
    template["hash"] = json!(state::hash(&canonical(&template)?));
    let entry = json!({"template":template,"defaults":defaults,"bindings":bindings});
    let mut candidate = registry.clone();
    candidate["definitions"]
        .as_array_mut()
        .unwrap()
        .retain(|e| {
            e["template"]["id"] != entry["template"]["id"]
                || e["template"]["version"] != entry["template"]["version"]
        });
    candidate["definitions"]
        .as_array_mut()
        .unwrap()
        .push(entry.clone());
    let probe = state::materialize(
        &entry,
        &entry["defaults"],
        "template:probe",
        "template:probe",
        0,
    )?;
    state::validate_document(&probe, &candidate)?;
    let package = json!({"format":"trellis_component_template_v1","repositoryId":"workspace","name":options["name"],"tags":options["tags"],"definition":entry,"origin":{"repositoryId":if origin["id"].as_str().unwrap().starts_with("workspace:"){ "workspace" } else { "builtin" },"templateId":origin["id"],"version":origin["version"],"templateHash":origin["hash"]}});
    if canonical(&package)?.len() > 262144 {
        return Err(invalid("Published template exceeds size limit"));
    }
    Ok(package)
}

/// Restore/adoption boundary: only packages expressible by the current exporter
/// and approved host policies are accepted. Never trust a snapshot's bindings.
pub(crate) fn validate_package(raw: &str, expected_hash: &str) -> Result<Value, String> {
    let package = state::parse_json(raw)?;
    state::keys(
        &package,
        &[
            "format",
            "repositoryId",
            "name",
            "tags",
            "definition",
            "origin",
        ],
    )?;
    if package["format"] != "trellis_component_template_v1"
        || package["repositoryId"] != "workspace"
    {
        return Err(invalid("Unsupported workspace package"));
    }
    if state::hash(&canonical(&package)?) != expected_hash {
        return Err("TEMPLATE_PINNED: Package hash changed".into());
    }
    let entry = &package["definition"];
    state::keys(entry, &["template", "defaults", "bindings"])?;
    let template = &entry["template"];
    state::keys(
        template,
        &[
            "id",
            "version",
            "hash",
            "description",
            "catalogVersion",
            "parameters",
            "requiredComponents",
            "actionSlots",
            "rootId",
            "nodes",
        ],
    )?;
    let template_id = state::text(&template["id"])?;
    let slug = template_id
        .strip_prefix("workspace:")
        .ok_or_else(|| invalid("Invalid workspace identity"))?;
    let opts = json!({"slug":slug,"version":template["version"],"name":package["name"],"description":template["description"],"tags":package["tags"]});
    let options_json = canonical(&opts)?;
    options(&options_json)?;
    state::keys(
        &package["origin"],
        &["repositoryId", "templateId", "version", "templateHash"],
    )?;
    for key in ["repositoryId", "templateId", "version"] {
        state::id(&package["origin"][key])?;
    }
    let source_hash = state::text(&package["origin"]["templateHash"])?;
    if source_hash.len() != 64
        || !source_hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(invalid("Invalid source hash"));
    }
    let mut body = template.clone();
    body.as_object_mut()
        .ok_or_else(|| invalid("Invalid template"))?
        .remove("hash");
    if template["hash"] != state::hash(&canonical(&body)?) {
        return Err("HASH_MISMATCH: Template hash changed".into());
    }
    let host = state::registry();
    let policy = |value: &Value| -> Result<Value, String> {
        state::keys(value, &["action", "input", "effect", "message"])?;
        let mut value = value.clone();
        state::object(&value["effect"])?;
        value["effect"].as_object_mut().unwrap().remove("target");
        Ok(value)
    };
    for binding in state::object(&entry["bindings"])?.values() {
        let candidate = policy(binding)?;
        let mut allowed = false;
        for original in host["definitions"].as_array().unwrap() {
            for approved in state::object(&original["bindings"])?.values() {
                if state::equal(&candidate, &policy(approved)?) {
                    allowed = true;
                }
            }
        }
        if !allowed {
            return Err(
                "UNSUPPORTED_CAPABILITY: Component package redefines a host action policy".into(),
            );
        }
    }
    for node in template["nodes"]
        .as_array()
        .ok_or_else(|| invalid("Missing template nodes"))?
    {
        state::object(node)?;
        state::object(&node["props"])?;
        if let Some(action) = node.get("action") {
            state::keys(action, &["slot", "input"])?;
            state::object(&action["input"])?;
        }
    }
    let mut registry = host;
    registry["definitions"]
        .as_array_mut()
        .unwrap()
        .push(entry.clone());
    let descriptor =
        json!({"templateId":template["id"],"templateVersion":template["version"],"parameters":{}});
    let saved = state::create_with_registry(
        0,
        0,
        "restore",
        "restore",
        "restore",
        &canonical(&descriptor)?,
        &registry,
    )?;
    let generated = prepare(&saved, &registry, &options_json)?;
    if !state::equal(&generated["definition"], entry) {
        return Err(invalid(
            "Package is not a portable template produced by this exporter",
        ));
    }
    Ok(package)
}
