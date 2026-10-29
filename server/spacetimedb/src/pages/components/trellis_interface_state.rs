//! Portable retained-interface transitions. Host configuration owns definitions/actions.
//! No database, clock, network or client-supplied author is consulted here.
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
const BUNDLE: &str = include_str!("trellis_interfaces.json");
const MAX: u64 = 9_007_199_254_740_991;
const BYTES: usize = 262_144;
fn err(code: &str, message: &str) -> String {
    format!("{code}: {message}")
}
fn invalid(message: &str) -> String {
    err("INVALID_INTERFACE", message)
}
fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn registry() -> Value {
    serde_json::from_str(BUNDLE).expect("trusted interface registry")
}
fn object(value: &Value) -> Result<&Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| invalid("Expected an object"))
}
fn keys(value: &Value, allowed: &[&str]) -> Result<(), String> {
    if object(value)?
        .keys()
        .any(|key| !allowed.contains(&key.as_str()))
    {
        return Err(invalid("Unexpected fields"));
    }
    Ok(())
}
fn text(value: &Value) -> Result<&str, String> {
    value.as_str().ok_or_else(|| invalid("Expected a string"))
}
fn id(value: &Value) -> Result<&str, String> {
    let value = text(value)?;
    if value.is_empty()
        || value.len() > 256
        || ["__proto__", "constructor", "prototype"].contains(&value)
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
    {
        return Err(invalid("Invalid opaque identity"));
    }
    Ok(value)
}
fn rev(value: &Value) -> Result<u64, String> {
    value
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0 && *v <= MAX as f64 && v.fract() == 0.0)
        .map(|v| v as u64)
        .ok_or_else(|| invalid("Invalid safe revision"))
}
fn hex64(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn bounded(value: &Value, depth: usize, visited: &mut usize) -> Result<(), String> {
    *visited += 1;
    if depth > 64 || *visited > 100_000 {
        return Err(invalid("JSON expansion limit exceeded"));
    }
    match value {
        Value::String(s) if s.encode_utf16().count() > 16_384 => {
            return Err(invalid("String limit exceeded"))
        }
        Value::Object(map) => {
            for (key, child) in map {
                if ["__proto__", "constructor", "prototype"].contains(&key.as_str()) {
                    return Err(invalid("Unsafe property name"));
                }
                bounded(child, depth + 1, visited)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                bounded(item, depth + 1, visited)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn parse_json(raw: &str) -> Result<Value, String> {
    if raw.len() > BYTES {
        return Err(invalid("Payload limit exceeded"));
    }
    let value: Value = serde_json::from_str(raw).map_err(|e| invalid(&e.to_string()))?;
    bounded(&value, 0, &mut 0)?;
    Ok(value)
}
fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(k, v)| b.get(k).is_some_and(|w| equal(v, w)))
        }
        _ => a == b,
    }
}
fn validate_value(value: &Value, schema: &Value) -> Result<(), String> {
    if schema["enum"]
        .as_array()
        .is_some_and(|items| !items.iter().any(|v| equal(v, value)))
    {
        return Err(invalid("Value outside enumeration"));
    }
    match text(&schema["type"])? {
        "object" => {
            let map = object(value)?;
            let props = schema.get("properties").map(object).transpose()?;
            if schema["required"].as_array().is_some_and(|items| {
                items
                    .iter()
                    .any(|v| !map.contains_key(v.as_str().unwrap_or("")))
            }) {
                return Err(invalid("Missing required property"));
            }
            for (key, value) in map {
                validate_value(
                    value,
                    props
                        .and_then(|props| props.get(key))
                        .ok_or_else(|| invalid("Unknown property"))?,
                )?;
            }
        }
        "array" => {
            let items = value.as_array().ok_or_else(|| invalid("Expected array"))?;
            if items.len() as u64 > schema["maxItems"].as_u64().unwrap_or(500) {
                return Err(invalid("Array limit exceeded"));
            }
            for value in items {
                validate_value(value, &schema["items"])?;
            }
        }
        "string" => {
            let length = text(value)?.encode_utf16().count() as u64;
            if length < schema["minLength"].as_u64().unwrap_or(0)
                || length > schema["maxLength"].as_u64().unwrap_or(u64::MAX)
            {
                return Err(invalid("String bounds exceeded"));
            }
        }
        "boolean" => {
            if !value.is_boolean() {
                return Err(invalid("Expected boolean"));
            }
        }
        "null" => {
            if !value.is_null() {
                return Err(invalid("Expected null"));
            }
        }
        kind @ ("integer" | "number") => {
            let number = value.as_f64().ok_or_else(|| invalid("Expected number"))?;
            if !number.is_finite()
                || (kind == "integer" && (number.fract() != 0.0 || number.abs() > MAX as f64))
                || schema["minimum"].as_f64().is_some_and(|n| number < n)
                || schema["maximum"].as_f64().is_some_and(|n| number > n)
            {
                return Err(invalid("Number bounds exceeded"));
            }
        }
        _ => return Err(invalid("Unsupported schema")),
    }
    Ok(())
}
fn definition<'a>(
    registry: &'a Value,
    template_id: &Value,
    version: &Value,
) -> Result<&'a Value, String> {
    registry["definitions"]
        .as_array()
        .ok_or_else(|| invalid("Invalid registry"))?
        .iter()
        .find(|d| &d["template"]["id"] == template_id && &d["template"]["version"] == version)
        .ok_or_else(|| err("TEMPLATE_NOT_FOUND", "Exact definition unavailable"))
}
fn substitute(value: &Value, parameters: &Value) -> Value {
    match value {
        Value::Object(map) if map.len() == 1 && map.contains_key("$param") => {
            parameters[map["$param"].as_str().unwrap_or("")].clone()
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), substitute(v, parameters)))
                .collect(),
        ),
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| substitute(v, parameters)).collect())
        }
        _ => value.clone(),
    }
}
fn materialize(
    entry: &Value,
    parameters: &Value,
    document_id: &str,
    instance: &str,
    revision: u64,
) -> Result<Value, String> {
    let template = &entry["template"];
    validate_value(parameters, &template["parameters"])?;
    let raw_nodes = template["nodes"]
        .as_array()
        .ok_or_else(|| invalid("Invalid template"))?;
    let mapping: Map<String, Value> = raw_nodes
        .iter()
        .map(|n| {
            (
                n["id"].as_str().unwrap_or("").to_string(),
                json!(format!("{instance}:{}", n["id"].as_str().unwrap_or(""))),
            )
        })
        .collect();
    let bindings: Map<String, Value> = object(&entry["bindings"])?
        .iter()
        .map(|(slot, b)| (slot.clone(), b["action"].clone()))
        .collect();
    let mut nodes = Vec::new();
    for raw in raw_nodes {
        let mut node = substitute(raw, parameters);
        node["id"] = mapping[text(&raw["id"])?].clone();
        node["parentId"] = if raw["parentId"].is_null() {
            Value::Null
        } else {
            mapping[text(&raw["parentId"])?].clone()
        };
        if node.get("action").is_some() {
            node["action"]["slot"] = bindings[text(&raw["action"]["slot"])?].clone();
        }
        nodes.push(node);
    }
    Ok(
        json!({"protocol":"trellis_ui_v1","documentId":document_id,"revision":revision,"catalogVersion":template["catalogVersion"],"rootId":mapping[text(&template["rootId"])?],"nodes":nodes,"retiredIds":[],"template":{"id":template["id"],"version":template["version"],"hash":template["hash"],"instanceId":instance,"parameters":parameters,"mapping":mapping,"actionBindings":bindings,"state":"linked"}}),
    )
}
fn target<'a>(document: &'a Value, selector: &Value) -> Result<&'a Value, String> {
    keys(selector, &["id", "key"])?;
    let map = object(selector)?;
    if map.len() != 1 {
        return Err(invalid("Choose one target identity"));
    }
    let (key, value) = map.iter().next().ok_or_else(|| invalid("Missing target"))?;
    id(value)?;
    document["nodes"]
        .as_array()
        .ok_or_else(|| invalid("Missing nodes"))?
        .iter()
        .find(|n| n.get(key) == Some(value))
        .ok_or_else(|| err("UNKNOWN_NODE", "Target unavailable"))
}
fn safe_text(runs: &Value) -> Result<(), String> {
    let runs = runs
        .as_array()
        .ok_or_else(|| invalid("Expected text runs"))?;
    if runs.len() > 2000 {
        return Err(invalid("Too many text runs"));
    }
    for run in runs {
        keys(run, &["text", "marks", "href", "color", "backgroundColor"])?;
        text(&run["text"])?;
        if let Some(marks) = run.get("marks") {
            let marks = marks.as_array().ok_or_else(|| invalid("Invalid marks"))?;
            if marks.len() > 5
                || marks.iter().any(|m| {
                    !["bold", "italic", "underline", "strike", "code"]
                        .contains(&m.as_str().unwrap_or(""))
                })
            {
                return Err(invalid("Unsupported text mark"));
            }
        }
        if let Some(href) = run.get("href") {
            let url = url::Url::parse(text(href)?).map_err(|_| invalid("Invalid link"))?;
            if !["https", "http", "mailto"].contains(&url.scheme()) {
                return Err(invalid("Unsafe link"));
            }
        }
        for key in ["color", "backgroundColor"] {
            if let Some(value) = run.get(key) {
                let token = text(value)?;
                if ![4, 7].contains(&token.len())
                    || !token.starts_with('#')
                    || !token[1..].bytes().all(|c| c.is_ascii_hexdigit())
                {
                    return Err(invalid("Invalid color"));
                }
            }
        }
    }
    Ok(())
}
fn validate_document(document: &Value, registry: &Value) -> Result<(), String> {
    keys(
        document,
        &[
            "protocol",
            "documentId",
            "revision",
            "catalogVersion",
            "rootId",
            "nodes",
            "retiredIds",
            "template",
        ],
    )?;
    if document["protocol"] != "trellis_ui_v1"
        || document["catalogVersion"] != registry["catalog"]["version"]
    {
        return Err(invalid("Unsupported document/catalog"));
    }
    id(&document["documentId"])?;
    id(&document["rootId"])?;
    let revision = rev(&document["revision"])?;
    let origin = &document["template"];
    let entry = definition(registry, &origin["id"], &origin["version"])?;
    keys(
        origin,
        &[
            "id",
            "version",
            "hash",
            "instanceId",
            "parameters",
            "mapping",
            "actionBindings",
            "state",
        ],
    )?;
    if origin["hash"] != entry["template"]["hash"]
        || !["linked", "forked"].contains(&origin["state"].as_str().unwrap_or(""))
    {
        return Err(err("TEMPLATE_PINNED", "Invalid pinned provenance"));
    }
    id(&origin["id"])?;
    id(&origin["version"])?;
    id(&origin["instanceId"])?;
    let expected = materialize(
        entry,
        &origin["parameters"],
        text(&document["documentId"])?,
        text(&origin["instanceId"])?,
        revision,
    )?;
    if origin["mapping"] != expected["template"]["mapping"]
        || origin["actionBindings"] != expected["template"]["actionBindings"]
    {
        return Err(err(
            "TEMPLATE_PINNED",
            "Pinned bindings or identities changed",
        ));
    }
    if origin["state"] == "linked" && !equal(document, &expected) {
        return Err(err(
            "TEMPLATE_FORKED",
            "Linked content differs from its definition",
        ));
    }
    let nodes = document["nodes"]
        .as_array()
        .ok_or_else(|| invalid("Expected nodes"))?;
    let retired = document["retiredIds"]
        .as_array()
        .ok_or_else(|| invalid("Expected retired identities"))?;
    if nodes.is_empty() || nodes.len() > 200 || retired.len() > 1000 {
        return Err(invalid("Document limits exceeded"));
    }
    let mut ids = BTreeMap::new();
    let mut removed = BTreeSet::new();
    let mut semantic = BTreeSet::new();
    let mut fields = BTreeSet::new();
    for value in retired {
        if !removed.insert(id(value)?) {
            return Err(invalid("Duplicate retired identity"));
        }
    }
    for node in nodes {
        keys(
            node,
            &[
                "id", "key", "parentId", "type", "order", "props", "text", "action",
            ],
        )?;
        let node_id = id(&node["id"])?;
        if node.get("parentId").is_none() {
            return Err(invalid("Parent identity must be explicit"));
        }
        if ids.insert(node_id, node).is_some() || removed.contains(node_id) {
            return Err(err("DUPLICATE_ID", "Existing or retired identity reused"));
        }
        if let Some(key) = node.get("key") {
            if !semantic.insert(id(key)?) {
                return Err(invalid("Duplicate semantic key"));
            }
        }
        if !node["parentId"].is_null() {
            id(&node["parentId"])?;
        }
        rev(&node["order"])?;
        let component = registry["catalog"]["components"]
            .get(text(&node["type"])?)
            .ok_or_else(|| invalid("Component outside catalog"))?;
        validate_value(&node["props"], &component["props"])?;
        if let Some(runs) = node.get("text") {
            if component["text"] != true {
                return Err(invalid("Component does not accept text"));
            }
            safe_text(runs)?;
        }
        if component["field"] == true {
            if let Some(name) = node["props"].get("name") {
                if !fields.insert(id(name)?) {
                    return Err(invalid("Duplicate field name"));
                }
            }
        }
    }
    let roots: Vec<_> = nodes.iter().filter(|n| n["parentId"].is_null()).collect();
    if roots.len() != 1 || roots[0]["id"] != document["rootId"] {
        return Err(invalid("Exactly one matching root required"));
    }
    for node in nodes {
        let mut cursor = *ids
            .get(text(&node["id"])?)
            .ok_or_else(|| invalid("Missing node"))?;
        let mut seen = BTreeSet::new();
        loop {
            if !seen.insert(text(&cursor["id"])?) || seen.len() > 20 {
                return Err(invalid("Tree cycle or depth exceeded"));
            }
            if cursor["parentId"].is_null() {
                break;
            }
            cursor = *ids
                .get(text(&cursor["parentId"])?)
                .ok_or_else(|| invalid("Parent missing"))?;
            if registry["catalog"]["components"][text(&cursor["type"])?]["acceptsChildren"] != true
            {
                return Err(invalid("Parent cannot contain children"));
            }
        }
        if let Some(action) = node.get("action") {
            if registry["catalog"]["components"][text(&node["type"])?]["action"] != true {
                return Err(invalid("Component cannot dispatch actions"));
            }
            keys(action, &["slot", "input"])?;
            id(&action["slot"])?;
            let binding = object(&entry["bindings"])?
                .values()
                .find(|b| b["action"] == action["slot"])
                .ok_or_else(|| err("UNKNOWN_ACTION", "Action is not granted to this definition"))?;
            let input = object(&action["input"])?;
            let properties = binding["input"].get("properties").map(object).transpose()?;
            for (key, value) in input {
                let schema = properties
                    .and_then(|properties| properties.get(key))
                    .ok_or_else(|| invalid("Unexpected action input"))?;
                if value.is_object() {
                    keys(value, &["field"])?;
                    if object(value)?.len() != 1
                        || !fields.contains(id(&value["field"])?)
                        || schema["type"] != "string"
                    {
                        return Err(invalid("Invalid field binding"));
                    }
                } else {
                    if value.is_array() {
                        return Err(invalid("Action literals must be scalar"));
                    }
                    validate_value(value, schema)?;
                }
            }
            if binding["input"]["required"].as_array().is_some_and(|keys| {
                keys.iter()
                    .any(|key| !input.contains_key(key.as_str().unwrap_or("")))
            }) {
                return Err(invalid("Missing action input"));
            }
            let effect = &binding["effect"];
            if effect["kind"] == "setText" {
                let target = target(document, &effect["target"])?;
                if registry["catalog"]["components"][text(&target["type"])?]["text"] != true {
                    return Err(invalid("Action target cannot accept text"));
                }
            } else if effect["kind"] == "toggle" {
                if registry["catalog"]["components"][text(&node["type"])?]["props"]["properties"]
                    [text(&effect["property"])?]["type"]
                    != "boolean"
                {
                    return Err(invalid("Toggle property is not boolean"));
                }
            } else {
                return Err(invalid("Unknown host action effect"));
            }
        }
    }
    Ok(())
}
pub fn is_interface(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .is_some_and(|v| v["v"] == "trellis_instance_v1")
}
pub fn parse(raw: &str) -> Result<Value, String> {
    let saved = parse_json(raw)?;
    keys(
        &saved,
        &["v", "document", "creation", "updatedBy", "receipts"],
    )?;
    if saved["v"] != "trellis_instance_v1" {
        return Err(invalid("Unsupported retained version"));
    }
    let registry = registry();
    validate_document(&saved["document"], &registry)?;
    id(&saved["updatedBy"])?;
    keys(
        &saved["creation"],
        &["principal", "parentId", "requestId", "fingerprint"],
    )?;
    for key in ["principal", "parentId", "requestId"] {
        id(&saved["creation"][key])?;
    }
    if !hex64(&saved["creation"]["fingerprint"]) {
        return Err(invalid("Invalid creation receipt"));
    }
    let receipts = saved["receipts"]
        .as_array()
        .ok_or_else(|| invalid("Missing receipts"))?;
    if receipts.is_empty() || receipts.len() > 128 {
        return Err(invalid("Receipt limit exceeded"));
    }
    let mut seen = BTreeSet::new();
    for receipt in receipts {
        keys(
            receipt,
            &["principal", "requestId", "fingerprint", "revision"],
        )?;
        let principal = id(&receipt["principal"])?;
        let request = id(&receipt["requestId"])?;
        if !seen.insert((principal, request))
            || !hex64(&receipt["fingerprint"])
            || rev(&receipt["revision"])? > rev(&saved["document"]["revision"])?
        {
            return Err(invalid("Invalid retry receipt"));
        }
    }
    Ok(saved)
}
pub fn creation_fingerprint(raw: &str) -> Result<String, String> {
    let descriptor = parse_json(raw)?;
    keys(
        &descriptor,
        &["templateId", "templateVersion", "parameters"],
    )?;
    Ok(hash(&format!("trellis.create.v1\n{raw}")))
}
pub fn create(
    surface_id: u64,
    component_id: u64,
    parent_id: &str,
    principal: &str,
    request_id: &str,
    raw: &str,
) -> Result<String, String> {
    let descriptor = parse_json(raw)?;
    let registry = registry();
    keys(
        &descriptor,
        &["templateId", "templateVersion", "parameters"],
    )?;
    let entry = definition(
        &registry,
        &descriptor["templateId"],
        &descriptor["templateVersion"],
    )?;
    let mut parameters = object(&entry["defaults"])?.clone();
    parameters.extend(object(&descriptor["parameters"])?.clone());
    let document = materialize(
        entry,
        &Value::Object(parameters),
        &format!("pear-page:{surface_id}:component:{component_id}"),
        &format!("pear-component:{component_id}"),
        0,
    )?;
    let fingerprint = creation_fingerprint(raw)?;
    let saved=json!({"v":"trellis_instance_v1","document":document,"creation":{"principal":principal,"parentId":parent_id,"requestId":request_id,"fingerprint":fingerprint},"updatedBy":principal,"receipts":[{"principal":principal,"requestId":request_id,"fingerprint":fingerprint,"revision":0}]}).to_string();
    parse(&saved)?;
    Ok(saved)
}
fn patch(document: &Value, operations: &Value, registry: &Value) -> Result<Value, String> {
    let ops = operations
        .as_array()
        .ok_or_else(|| invalid("Expected patch operations"))?;
    if ops.is_empty() || ops.len() > 100 {
        return Err(invalid("Invalid operation count"));
    }
    let mut doc = document.clone();
    for op in ops {
        match text(&op["op"])? {
            "insertNode" => {
                keys(op, &["op", "node"])?;
                let node_id = id(&op["node"]["id"])?;
                if doc["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|n| n["id"] == node_id)
                    || doc["retiredIds"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|n| n == node_id)
                {
                    return Err(err("DUPLICATE_ID", "Existing or retired identity reused"));
                }
                doc["nodes"]
                    .as_array_mut()
                    .unwrap()
                    .push(op["node"].clone());
            }
            "removeSubtree" => {
                keys(op, &["op", "target"])?;
                let node_id = target(&doc, &op["target"])?["id"].clone();
                if node_id == doc["rootId"] {
                    return Err(invalid("Cannot remove root"));
                }
                let mut removed = BTreeSet::from([text(&node_id)?.to_string()]);
                let mut removed_order = vec![node_id];
                loop {
                    let before = removed.len();
                    for node in doc["nodes"].as_array().unwrap() {
                        if node["parentId"]
                            .as_str()
                            .is_some_and(|p| removed.contains(p))
                        {
                            if removed.insert(text(&node["id"])?.to_string()) {
                                removed_order.push(node["id"].clone());
                            }
                        }
                    }
                    if removed.len() == before {
                        break;
                    }
                }
                doc["nodes"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|n| !removed.contains(n["id"].as_str().unwrap_or("")));
                doc["retiredIds"]
                    .as_array_mut()
                    .unwrap()
                    .extend(removed_order);
            }
            kind @ ("setText" | "setProps" | "moveNode") => {
                keys(
                    op,
                    match kind {
                        "setText" => &["op", "target", "text"],
                        "setProps" => &["op", "target", "props"],
                        _ => &["op", "target", "parentId", "order"],
                    },
                )?;
                let node_id = target(&doc, &op["target"])?["id"].clone();
                if kind == "moveNode" && node_id == doc["rootId"] {
                    return Err(invalid("Cannot move root"));
                }
                let node = doc["nodes"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|n| n["id"] == node_id)
                    .ok_or_else(|| invalid("Missing node"))?;
                match kind {
                    "setText" => node["text"] = op["text"].clone(),
                    "setProps" => node["props"] = op["props"].clone(),
                    _ => {
                        id(&op["parentId"])?;
                        node["parentId"] = op["parentId"].clone();
                        node["order"] = op["order"].clone();
                    }
                }
            }
            _ => return Err(invalid("Unsupported patch operation")),
        }
    }
    doc["revision"] = json!(rev(&document["revision"])? + 1);
    doc["template"]["state"] = json!("forked");
    validate_document(&doc, registry)?;
    Ok(doc)
}
fn action_operations(doc: &Value, event: &Value, registry: &Value) -> Result<Value, String> {
    keys(
        event,
        &[
            "documentId",
            "revision",
            "nodeId",
            "slot",
            "invocationId",
            "input",
        ],
    )?;
    id(&event["invocationId"])?;
    let node = doc["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == event["nodeId"])
        .ok_or_else(|| err("STALE_ACTION", "Control unavailable"))?;
    if event["documentId"] != doc["documentId"]
        || rev(&event["revision"])? != rev(&doc["revision"])?
        || node.get("action").is_none()
        || node["action"]["slot"] != event["slot"]
    {
        return Err(err("STALE_ACTION", "The interface changed"));
    }
    let origin = &doc["template"];
    let entry = definition(registry, &origin["id"], &origin["version"])?;
    let binding = object(&entry["bindings"])?
        .values()
        .find(|b| b["action"] == event["slot"])
        .ok_or_else(|| invalid("Unknown action"))?;
    validate_value(&event["input"], &binding["input"])?;
    let input = object(&event["input"])?;
    let declared = object(&node["action"]["input"])?;
    if input.keys().collect::<Vec<_>>() != declared.keys().collect::<Vec<_>>() {
        return Err(invalid("Action inputs changed"));
    }
    for (key, value) in declared {
        if !value.is_object() && !equal(value, &input[key]) {
            return Err(invalid("Literal input changed"));
        }
        if value.is_object() {
            let field = doc["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| {
                    registry["catalog"]["components"][n["type"].as_str().unwrap_or("")]["field"]
                        == true
                        && n["props"]["name"] == value["field"]
                })
                .ok_or_else(|| invalid("Input unavailable"))?;
            if field["props"]["required"]==true && text(&input[key])?.chars().all(|c| matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')) { return Err(invalid("Required input is empty")); }
        }
    }
    let effect = &binding["effect"];
    if effect["kind"] == "setText" {
        Ok(
            json!([{"op":"setText","target":effect["target"],"text":[{"text":input[text(&effect["input"])?]}]}]),
        )
    } else {
        let property = text(&effect["property"])?;
        let mut props = object(&node["props"])?.clone();
        props.insert(
            property.to_string(),
            json!(!node["props"][property].as_bool().unwrap_or(false)),
        );
        Ok(json!([{"op":"setProps","target":{"id":node["id"]},"props":props}]))
    }
}
pub fn commit(
    existing: &str,
    base_revision: u64,
    principal: &str,
    request_id: &str,
    raw: &str,
) -> Result<Option<String>, String> {
    let mut saved = parse(existing)?;
    let command = parse_json(raw)?;
    let registry = registry();
    id(&json!(principal))?;
    id(&json!(request_id))?;
    let fingerprint = hash(&format!("trellis.command.v1\n{base_revision}\n{raw}"));
    if let Some(receipt) = saved["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["principal"] == principal && r["requestId"] == request_id)
    {
        return if receipt["fingerprint"] == fingerprint {
            Ok(None)
        } else {
            Err(err("REQUEST_REUSED", "Request ID has different arguments"))
        };
    }
    if base_revision != rev(&saved["document"]["revision"])? {
        return Err(err(
            "STALE_REVISION",
            "Read the current interface before updating",
        ));
    }
    if base_revision == MAX {
        return Err(invalid("Revision exhausted"));
    }
    let doc = &saved["document"];
    let next = match text(&command["kind"])? {
        "parameters" => {
            keys(&command, &["kind", "parameters"])?;
            if doc["template"]["state"] != "linked" {
                return Err(err(
                    "TEMPLATE_FORKED",
                    "Use explicit patches for a customized layout",
                ));
            }
            let entry = definition(
                &registry,
                &doc["template"]["id"],
                &doc["template"]["version"],
            )?;
            let mut params = object(&doc["template"]["parameters"])?.clone();
            params.extend(object(&command["parameters"])?.clone());
            let next = materialize(
                entry,
                &Value::Object(params),
                text(&doc["documentId"])?,
                text(&doc["template"]["instanceId"])?,
                base_revision + 1,
            )?;
            for node in next["nodes"].as_array().unwrap() {
                let old = doc["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|n| n["id"] == node["id"])
                    .ok_or_else(|| invalid("Missing pinned node"))?;
                if old.get("action") != node.get("action") {
                    return Err(err(
                        "UNSUPPORTED_UPDATE",
                        "Action mappings require a new instance",
                    ));
                }
            }
            validate_document(&next, &registry)?;
            next
        }
        "patch" => {
            keys(&command, &["kind", "operations"])?;
            patch(doc, &command["operations"], &registry)?
        }
        "action" => {
            keys(&command, &["kind", "event"])?;
            patch(
                doc,
                &action_operations(doc, &command["event"], &registry)?,
                &registry,
            )?
        }
        _ => return Err(invalid("Unsupported command")),
    };
    saved["document"] = next;
    saved["updatedBy"] = json!(principal);
    let receipts = saved["receipts"].as_array_mut().unwrap();
    receipts.push(json!({"principal":principal,"requestId":request_id,"fingerprint":fingerprint,"revision":base_revision+1}));
    if receipts.len() > 128 {
        receipts.drain(..receipts.len() - 128);
    }
    let raw = saved.to_string();
    parse(&raw)?;
    Ok(Some(raw))
}
