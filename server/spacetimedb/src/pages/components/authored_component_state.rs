//! Template-independent component authoring. All behaviors are bounded local
//! effects or explicit data-source intents; this module never performs I/O.
use super::{interface_state as core, repository_state as repository};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

fn error(code: &str, message: &str) -> String {
    format!("{code}: {message}")
}
fn invalid(message: &str) -> String {
    error("INVALID_COMPONENT", message)
}
fn exact(value: &Value, names: &[&str]) -> Result<(), String> {
    core::keys(value, names)?;
    if names.iter().any(|name| value.get(name).is_none()) {
        return Err(invalid("Required fields are missing"));
    }
    Ok(())
}
fn string(value: &Value, max: usize) -> Result<&str, String> {
    let value = core::text(value)?;
    if value.encode_utf16().count() > max {
        return Err(invalid("Text limit exceeded"));
    }
    Ok(value)
}
fn map(value: &Value, max: usize) -> Result<&Map<String, Value>, String> {
    let values = core::object(value)?;
    if values.len() > max {
        return Err(invalid("Named map limit exceeded"));
    }
    for key in values.keys() {
        core::id(&json!(key))?;
    }
    Ok(values)
}
fn hex(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
pub(crate) fn catalog() -> Value {
    let mut catalog = core::registry()["catalog"].clone();
    catalog["components"]["ChecklistItem"]["action"] = json!(true);
    catalog["components"]["DataTable"] = json!({"acceptsChildren":false,"props":{"type":"object","properties":{"source":{"type":"string"},"columns":{"type":"array","items":{"type":"string"},"maxItems":32},"emptyText":{"type":"string","maxLength":500}},"required":["source","columns"]}});
    catalog
}
pub fn is_component(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .is_some_and(|v| v["v"] == "trellis_component_v1")
}
fn schema(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 4 {
        return Err(invalid("Input schema nesting exceeds limit"));
    }
    core::keys(
        value,
        &[
            "type",
            "properties",
            "required",
            "items",
            "enum",
            "minLength",
            "maxLength",
            "minimum",
            "maximum",
            "maxItems",
        ],
    )?;
    let kind = core::text(&value["type"])?;
    if ![
        "string", "number", "integer", "boolean", "null", "object", "array",
    ]
    .contains(&kind)
    {
        return Err(invalid("Unsupported input type"));
    }
    if kind == "object" {
        let empty = json!({});
        let properties = map(value.get("properties").unwrap_or(&empty), 32)?;
        for child in properties.values() {
            schema(child, depth + 1)?;
        }
        if let Some(required) = value.get("required") {
            for key in required
                .as_array()
                .ok_or_else(|| invalid("Required inputs must be an array"))?
            {
                if !properties.contains_key(core::text(key)?) {
                    return Err(invalid("Required input is not declared"));
                }
            }
        }
    }
    if kind == "array" {
        schema(&value["items"], depth + 1)?;
    }
    for name in ["minimum", "maximum", "minLength", "maxLength", "maxItems"] {
        if let Some(value) = value.get(name) {
            if value.as_f64().is_none() {
                return Err(invalid("Input bounds must be finite numbers"));
            }
        }
    }
    if let Some(values) = value.get("enum") {
        let values = values
            .as_array()
            .ok_or_else(|| invalid("Expected enum array"))?;
        if values.len() > 100 || values.iter().any(|v| v.is_object() || v.is_array()) {
            return Err(invalid("Expected bounded scalar enum"));
        }
    }
    Ok(())
}
fn record_target(value: &Value) -> Result<(), String> {
    if value.is_object() {
        exact(value, &["first"])?;
        if value["first"] != true {
            return Err(invalid("Select first record explicitly"));
        }
    } else if string(value, 256)?.is_empty() {
        return Err(invalid("Record identity is required"));
    }
    Ok(())
}
fn connection(value: &Value) -> Result<(), String> {
    match core::text(&value["adapter"])? {
        "pear.database" => {
            exact(value, &["adapter", "schemaId", "mapping"])?;
            let id = core::text(&value["schemaId"])?;
            if id.starts_with('0') || id.parse::<u64>().ok().filter(|v| *v > 0).is_none() {
                return Err(invalid("Choose a database schema"));
            }
            for property in map(&value["mapping"], 32)?.values() {
                let id = core::text(property)?;
                if id.starts_with('0') || id.parse::<u64>().ok().filter(|v| *v > 0).is_none() {
                    return Err(invalid("Map source fields to properties"));
                }
            }
        }
        "external.json" => {
            core::keys(
                value,
                &["adapter", "readUrl", "recordsPath", "idField", "write"],
            )?;
            fn url(raw: &Value) -> Result<(), String> {
                let raw = string(raw, 2048)?.replace("{id}", "record");
                let parsed = url::Url::parse(&raw)
                    .map_err(|_| invalid("Expected an absolute source URL"))?;
                let local = matches!(
                    parsed.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                );
                if !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.fragment().is_some()
                    || !(parsed.scheme() == "https" || parsed.scheme() == "http" && local)
                {
                    return Err(invalid("Use HTTPS with private connection credentials"));
                }
                Ok(())
            }
            url(&value["readUrl"])?;
            let path = string(&value["recordsPath"], 256)?;
            if !path.is_empty() {
                for segment in path.split('.') {
                    core::id(&json!(segment))?;
                }
            }
            core::id(&value["idField"])?;
            if let Some(write) = value.get("write") {
                exact(write, &["url", "method"])?;
                url(&write["url"])?;
                if !["PUT", "PATCH"].contains(&core::text(&write["method"])?) {
                    return Err(invalid("Declare PUT or PATCH for write-back"));
                }
            }
        }
        _ => return Err(error("UNSUPPORTED_SOURCE", "Unsupported data adapter")),
    }
    Ok(())
}
pub fn parse(raw: &str) -> Result<Value, String> {
    let saved = core::parse_json(raw)?;
    exact(
        &saved,
        &[
            "v",
            "title",
            "document",
            "actions",
            "sources",
            "bindings",
            "creation",
            "updatedBy",
            "receipts",
            "origin",
        ],
    )?;
    if saved["v"] != "trellis_component_v1" {
        return Err(invalid("Unsupported authored component"));
    }
    string(&saved["title"], 160)?;
    let actions = map(&saved["actions"], 32)?;
    let sources = map(&saved["sources"], 32)?;
    let bindings = map(&saved["bindings"], 200)?;
    let catalog = catalog();
    let document = &saved["document"];
    for source in sources.values() {
        exact(source, &["label", "fields", "connection"])?;
        string(&source["label"], 160)?;
        for field in map(&source["fields"], 32)?.values() {
            core::keys(field, &["type", "writable"])?;
            if !["string", "number", "boolean"].contains(&core::text(&field["type"])?)
                || field.get("writable").is_some_and(|v| !v.is_boolean())
            {
                return Err(invalid("Invalid source field"));
            }
        }
        if !source["connection"].is_null() {
            connection(&source["connection"])?;
            if source["connection"]["adapter"] == "pear.database" {
                let mapping = core::object(&source["connection"]["mapping"])?;
                let mut properties = BTreeSet::new();
                for (field, id) in mapping {
                    if source["fields"].get(field).is_none() || !properties.insert(core::text(id)?)
                    {
                        return Err(invalid("Map declared fields to distinct properties"));
                    }
                }
            }
        }
    }
    for action in actions.values() {
        let kind = core::text(&action["kind"])?;
        exact(
            action,
            if kind == "local" {
                &["kind", "input", "message", "effects"]
            } else {
                &["kind", "input", "message", "source", "recordId", "fields"]
            },
        )?;
        schema(&action["input"], 0)?;
        string(&action["message"], 500)?;
        if action["input"]["type"] != "object" {
            return Err(invalid("Action input must be an object"));
        }
    }
    core::validate_component_document(document, &catalog, &saved["actions"])?;
    for action in actions.values() {
        match core::text(&action["kind"])? {
            "local" => {
                let effects = action["effects"]
                    .as_array()
                    .ok_or_else(|| invalid("Expected local effects"))?;
                if effects.is_empty() || effects.len() > 16 {
                    return Err(invalid("Use bounded local effects"));
                }
                for effect in effects {
                    let kind = core::text(&effect["kind"])?;
                    exact(
                        effect,
                        match kind {
                            "setText" => &["kind", "target", "input"],
                            "toggle" => &["kind", "target", "property"],
                            _ => &["kind", "target", "property", "input"],
                        },
                    )?;
                    let target = core::target(document, &effect["target"])?;
                    let definition = &catalog["components"][core::text(&target["type"])?];
                    match kind {
                        "setText" => {
                            if definition["text"] != true
                                || action["input"]["properties"][core::text(&effect["input"])?]
                                    ["type"]
                                    != "string"
                            {
                                return Err(invalid(
                                    "Text actions need a string input and text target",
                                ));
                            }
                        }
                        "setProp" | "toggle" => {
                            let property = core::id(&effect["property"])?;
                            let schema = &definition["props"]["properties"][property];
                            if schema.is_null()
                                || (kind == "toggle" && schema["type"] != "boolean")
                                || (kind == "setProp"
                                    && schema["type"]
                                        != action["input"]["properties"]
                                            [core::text(&effect["input"])?]["type"])
                            {
                                return Err(invalid("Action target/input type mismatch"));
                            }
                        }
                        _ => return Err(invalid("Unsupported local effect")),
                    }
                }
            }
            "source" => {
                let source = sources
                    .get(core::text(&action["source"])?)
                    .ok_or_else(|| invalid("Action source missing"))?;
                if action["recordId"].is_object() && action["recordId"].get("input").is_some() {
                    exact(&action["recordId"], &["input"])?;
                    if action["input"]["properties"][core::text(&action["recordId"]["input"])?]
                        ["type"]
                        != "string"
                    {
                        return Err(invalid("Record input must be a string"));
                    }
                } else {
                    record_target(&action["recordId"])?;
                }
                let fields = map(&action["fields"], 32)?;
                if fields.is_empty() {
                    return Err(invalid("Choose fields to write"));
                }
                for (field, input) in fields {
                    if source["fields"][field]["writable"] != true
                        || source["fields"][field]["type"]
                            != action["input"]["properties"][core::text(input)?]["type"]
                    {
                        return Err(invalid("Write fields must have compatible declared inputs"));
                    }
                }
            }
            _ => return Err(invalid("Unsupported action")),
        }
    }
    for node in document["nodes"].as_array().unwrap() {
        if node["type"] == "DataTable" {
            let source = sources
                .get(core::text(&node["props"]["source"])?)
                .ok_or_else(|| invalid("Table source missing"))?;
            let columns = node["props"]["columns"].as_array().unwrap();
            if columns.is_empty()
                || columns
                    .iter()
                    .any(|c| source["fields"].get(c.as_str().unwrap_or("")).is_none())
            {
                return Err(invalid("Table columns must belong to its source"));
            }
        }
    }
    for (node_id, binding) in bindings {
        exact(
            binding,
            &["source", "recordId", "field", "property", "writeBack"],
        )?;
        let node = document["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == node_id.as_str())
            .ok_or_else(|| invalid("Bound control missing"))?;
        let source = sources
            .get(core::text(&binding["source"])?)
            .ok_or_else(|| invalid("Bound source missing"))?;
        let field = source["fields"]
            .get(core::text(&binding["field"])?)
            .ok_or_else(|| invalid("Bound field missing"))?;
        record_target(&binding["recordId"])?;
        if !binding["writeBack"].is_boolean()
            || binding["writeBack"] == true && field["writable"] != true
            || node.get("action").is_some()
        {
            return Err(invalid(
                "A bound control cannot mutate a local copy or invent write access",
            ));
        }
        let definition = &catalog["components"][core::text(&node["type"])?];
        let compatible = match core::text(&binding["property"])? {
            "text" => definition["text"] == true,
            "value" => definition["field"] == true && field["type"] == "string",
            "checked" => node["type"] == "ChecklistItem" && field["type"] == "boolean",
            _ => false,
        };
        if !compatible {
            return Err(invalid("Control and bound field are incompatible"));
        }
    }
    exact(
        &saved["creation"],
        &["principal", "parentId", "requestId", "fingerprint"],
    )?;
    for key in ["principal", "parentId", "requestId"] {
        core::id(&saved["creation"][key])?;
    }
    core::id(&saved["updatedBy"])?;
    let receipts = saved["receipts"]
        .as_array()
        .ok_or_else(|| invalid("Expected receipts"))?;
    if !hex(&saved["creation"]["fingerprint"]) || receipts.is_empty() || receipts.len() > 128 {
        return Err(invalid("Invalid retry receipts"));
    }
    let mut seen = BTreeSet::new();
    for receipt in receipts {
        exact(
            receipt,
            &["principal", "requestId", "fingerprint", "revision"],
        )?;
        let key = (
            core::id(&receipt["principal"])?,
            core::id(&receipt["requestId"])?,
        );
        if !seen.insert(key)
            || !hex(&receipt["fingerprint"])
            || core::rev(&receipt["revision"])? > core::rev(&document["revision"])?
        {
            return Err(invalid("Invalid retry receipt"));
        }
    }
    if !saved["origin"].is_null() {
        exact(&saved["origin"], &["templateId", "version", "hash"])?;
        core::id(&saved["origin"]["templateId"])?;
        core::id(&saved["origin"]["version"])?;
        if !hex(&saved["origin"]["hash"]) {
            return Err(invalid("Invalid pinned template reference"));
        }
    }
    Ok(saved)
}
pub fn create(
    page_id: u64,
    node_id: u64,
    parent_id: &str,
    principal: &str,
    request_id: &str,
    title: &str,
) -> Result<String, String> {
    let fingerprint = core::hash(&format!(
        "trellis.component.create.v1\n{}",
        repository::canonical(&json!({"title":title}))?
    ));
    let root = format!("pear-component:{node_id}:root");
    let saved=json!({"v":"trellis_component_v1","title":title,"document":{"protocol":"trellis_ui_v1","documentId":format!("pear-page:{page_id}:component:{node_id}"),"revision":0,"catalogVersion":catalog()["version"],"rootId":root,"nodes":[{"id":root,"parentId":null,"type":"Container","order":0,"props":{"direction":"column"}}],"retiredIds":[]},"actions":{},"sources":{},"bindings":{},"origin":null,"creation":{"principal":principal,"parentId":parent_id,"requestId":request_id,"fingerprint":fingerprint},"updatedBy":principal,"receipts":[{"principal":principal,"requestId":request_id,"fingerprint":fingerprint,"revision":0}]}).to_string();
    parse(&saved)?;
    Ok(saved)
}
// Validate intent against visible, persisted controls before a host writes any data.
pub(crate) fn authorize_write(saved: &Value, write: &Value) -> Result<(), String> {
    authorize_write_for_record(saved, write, None)
}
pub(crate) fn authorize_write_for_record(
    saved: &Value,
    write: &Value,
    first_record: Option<&str>,
) -> Result<(), String> {
    exact(write, &["source", "recordId", "values", "requestId"])?;
    core::id(&write["requestId"])?;
    let source = core::text(&write["source"])?;
    let record = string(&write["recordId"], 256)?;
    if record.is_empty() {
        return Err(invalid("Record identity required"));
    }
    let values = map(&write["values"], 32)?;
    if values.is_empty() {
        return Err(invalid("Choose fields to write"));
    }
    for (field, value) in values {
        let definition = &saved["sources"][source]["fields"][field];
        if definition["writable"] != true {
            return Err(error("READ_ONLY_SOURCE", "Field is read only"));
        }
        core::validate_value(value, &json!({"type":definition["type"]}))?;
    }
    let matches = |target: &Value| {
        if target["first"] == true {
            first_record.is_none_or(|first| first == record)
        } else {
            target.is_object() || target == record
        }
    };
    for node in saved["document"]["nodes"].as_array().unwrap() {
        if node["type"] == "DataTable"
            && node["props"]["source"] == source
            && values.keys().all(|field| {
                node["props"]["columns"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(field))
            })
        {
            return Ok(());
        }
        let binding = &saved["bindings"][core::text(&node["id"])?];
        if binding["source"] == source
            && binding["writeBack"] == true
            && matches(&binding["recordId"])
            && values.len() == 1
            && values.contains_key(binding["field"].as_str().unwrap_or(""))
        {
            return Ok(());
        }
        if let Some(slot) = node["action"]["slot"].as_str() {
            let action = &saved["actions"][slot];
            if action["kind"] != "source"
                || action["source"] != source
                || !matches(&action["recordId"])
            {
                continue;
            }
            let fields = core::object(&action["fields"])?;
            if fields.len() != values.len()
                || !values.keys().all(|field| fields.contains_key(field))
            {
                continue;
            }
            let mut input = Map::new();
            for (field, key) in fields {
                input.insert(core::text(key)?.into(), values[field].clone());
            }
            if let Some(key) = action["recordId"]["input"].as_str() {
                input.insert(key.into(), json!(record));
            }
            let value = Value::Object(input);
            if core::validate_value(&value, &action["input"]).is_err() {
                continue;
            }
            if core::object(&value)?
                .keys()
                .ne(core::object(&node["action"]["input"])?.keys())
            {
                continue;
            }
            if core::object(&node["action"]["input"])?
                .iter()
                .any(|(key, literal)| !literal.is_object() && !core::equal(literal, &value[key]))
            {
                continue;
            }
            return Ok(());
        }
    }
    Err(error(
        "READ_ONLY_SOURCE",
        "No saved control permits this source write",
    ))
}
pub fn commit(
    existing: &str,
    base_revision: u64,
    principal: &str,
    request_id: &str,
    raw: &str,
) -> Result<Option<String>, String> {
    let mut saved = parse(existing)?;
    let command = core::parse_json(raw)?;
    core::id(&json!(principal))?;
    core::id(&json!(request_id))?;
    let fingerprint = core::hash(&format!(
        "trellis.component.command.v1\n{base_revision}\n{raw}"
    ));
    if let Some(receipt) = saved["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["principal"] == principal && r["requestId"] == request_id)
    {
        return if receipt["fingerprint"] == fingerprint {
            Ok(None)
        } else {
            Err(error("REQUEST_REUSED", "Request has different arguments"))
        };
    }
    if base_revision != core::rev(&saved["document"]["revision"])? {
        return Err(error("STALE_REVISION", "Read the component again"));
    }
    if base_revision == 9_007_199_254_740_991 {
        return Err(invalid("Revision exhausted"));
    }
    let document = saved["document"].clone();
    match core::text(&command["kind"])? {
        "edit" => {
            core::keys(&command, &["kind", "operations", "configuration"])?;
            let operations = command["operations"]
                .as_array()
                .ok_or_else(|| invalid("Expected patch operations"))?;
            if operations.len() > 100
                || operations.is_empty() && command.get("configuration").is_none()
            {
                return Err(invalid("Expected edits or configuration"));
            }
            if let Some(config) = command.get("configuration") {
                exact(config, &["title", "actions", "sources", "bindings"])?;
                for key in ["title", "actions", "sources", "bindings"] {
                    saved[key] = config[key].clone();
                }
            }
            saved["document"] = if operations.is_empty() {
                let mut d = document.clone();
                d["revision"] = json!(base_revision + 1);
                d
            } else {
                core::patch_nodes(&document, &command["operations"])?
            };
        }
        "action" => {
            exact(&command, &["kind", "event"])?;
            let event = &command["event"];
            exact(
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
            core::id(&event["invocationId"])?;
            let node = document["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| n["id"] == event["nodeId"])
                .ok_or_else(|| error("STALE_ACTION", "Control unavailable"))?;
            if event["documentId"] != document["documentId"]
                || event["revision"] != document["revision"]
                || node["action"]["slot"] != event["slot"]
            {
                return Err(error("STALE_ACTION", "Component changed"));
            }
            let action = &saved["actions"][core::text(&event["slot"])?];
            core::validate_value(&event["input"], &action["input"])?;
            if core::object(&event["input"])?
                .keys()
                .ne(core::object(&node["action"]["input"])?.keys())
            {
                return Err(invalid("Action inputs differ from saved control"));
            }
            for (key, value) in core::object(&node["action"]["input"])? {
                if value.is_object() {
                    let field = document["nodes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|n| n["type"] == "Input" && n["props"]["name"] == value["field"]);
                    if field.is_some_and(|f| f["props"]["required"] == true)
                        && event["input"][key]
                            .as_str()
                            .is_none_or(|s| s.trim().is_empty())
                    {
                        return Err(error("REQUIRED_PROP", "An input is required"));
                    }
                } else if !core::equal(value, &event["input"][key]) {
                    return Err(invalid("A literal action input changed"));
                }
            }
            if action["kind"] != "local" {
                return Err(error(
                    "SOURCE_WRITE_REQUIRED",
                    "Confirm the write through its source; do not save a local copy",
                ));
            }
            let mut operations = Vec::new();
            let mut properties: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
            for effect in action["effects"].as_array().unwrap() {
                if effect["kind"] == "setText" {
                    operations.push(json!({"op":"setText","target":effect["target"],"text":[{"text":event["input"][core::text(&effect["input"])?]}]}));
                } else {
                    let target = core::target(&document, &effect["target"])?;
                    let id = core::text(&target["id"])?;
                    let mut props = properties
                        .get(id)
                        .cloned()
                        .unwrap_or(core::object(&target["props"])?.clone());
                    let property = core::text(&effect["property"])?;
                    let value = if effect["kind"] == "toggle" {
                        json!(props.get(property) != Some(&json!(true)))
                    } else {
                        event["input"][core::text(&effect["input"])?].clone()
                    };
                    props.insert(property.into(), value);
                    properties.insert(id.into(), props.clone());
                    operations
                        .push(json!({"op":"setProps","target":effect["target"],"props":props}));
                }
            }
            saved["document"] = core::patch_nodes(&document, &json!(operations))?;
        }
        "source-write" => {
            exact(&command, &["kind", "write"])?;
            authorize_write(&saved, &command["write"])?;
            if saved["sources"][core::text(&command["write"]["source"])?]["connection"]["adapter"]
                != "pear.database"
            {
                return Err(error(
                    "SOURCE_WRITE_REQUIRED",
                    "External writes require their source adapter",
                ));
            }
            saved["document"]["revision"] = json!(base_revision + 1);
        }
        _ => return Err(invalid("Unsupported component command")),
    }
    saved["updatedBy"] = json!(principal);
    let receipts = saved["receipts"].as_array_mut().unwrap();
    receipts.push(json!({"principal":principal,"requestId":request_id,"fingerprint":fingerprint,"revision":base_revision+1}));
    if receipts.len() > 128 {
        receipts.drain(..receipts.len() - 128);
    }
    let result = saved.to_string();
    parse(&result)?;
    Ok(Some(result))
}
pub(crate) fn package_hash(value: &Value) -> Result<String, String> {
    fn encode(value: &Value) -> Result<String, String> {
        Ok(match value {
            Value::Null => "z;".into(),
            Value::Bool(v) => if *v { "b1;" } else { "b0;" }.into(),
            Value::String(v) => format!("s{}:{v}", v.len()),
            Value::Number(v) => {
                let n = v
                    .as_f64()
                    .ok_or_else(|| invalid("Invalid package number"))?;
                format!(
                    "n{:016x};",
                    if n == 0.0 {
                        0.0f64.to_bits()
                    } else {
                        n.to_bits()
                    }
                )
            }
            Value::Array(values) => {
                let mut out = format!("a{}:", values.len());
                for value in values {
                    out.push_str(&encode(value)?);
                }
                out
            }
            Value::Object(values) => {
                let mut keys: Vec<_> = values.keys().collect();
                keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                let mut out = format!("o{}:", keys.len());
                for key in keys {
                    out.push_str(&encode(&json!(key))?);
                    out.push_str(&encode(&values[key])?);
                }
                out
            }
        })
    }
    Ok(core::hash(&format!(
        "trellis.authored.package.v1\n{}",
        encode(value)?
    )))
}
fn blueprint_state(blueprint: &Value) -> Result<Value, String> {
    exact(
        blueprint,
        &[
            "title",
            "catalogVersion",
            "rootId",
            "nodes",
            "actions",
            "sources",
            "bindings",
        ],
    )?;
    let mut state: Value = serde_json::from_str(&create(
        1,
        1,
        "validation",
        "validation",
        "validate",
        core::text(&blueprint["title"])?,
    )?)
    .map_err(|_| invalid("Validation state failed"))?;
    for key in ["title", "actions", "sources", "bindings"] {
        state[key] = blueprint[key].clone();
    }
    for key in ["catalogVersion", "rootId", "nodes"] {
        state["document"][key] = blueprint[key].clone();
    }
    parse(&state.to_string())
}
pub(crate) fn validate_package(raw: &str, expected_hash: Option<&str>) -> Result<Value, String> {
    let package = core::parse_json(raw)?;
    exact(
        &package,
        &[
            "format",
            "repositoryId",
            "templateId",
            "version",
            "name",
            "description",
            "tags",
            "blueprint",
        ],
    )?;
    if package["format"] != "trellis_authored_template_v1" || package["repositoryId"] != "workspace"
    {
        return Err(invalid("Unsupported authored template package"));
    }
    let template = core::text(&package["templateId"])?;
    let slug = template
        .strip_prefix("workspace:")
        .ok_or_else(|| invalid("Expected workspace template identity"))?;
    repository::options(&json!({"slug":slug,"version":package["version"],"name":package["name"],"description":package["description"],"tags":package["tags"]}).to_string())?;
    blueprint_state(&package["blueprint"])?;
    for source in core::object(&package["blueprint"]["sources"])?.values() {
        if !source["connection"].is_null() {
            return Err(invalid(
                "Published templates must not contain source connections",
            ));
        }
    }
    if expected_hash.is_some_and(|expected| package_hash(&package).as_deref() != Ok(expected)) {
        return Err(error("TEMPLATE_PINNED", "Authored template hash changed"));
    }
    Ok(package)
}
fn remap(blueprint: &mut Value, ids: &BTreeMap<String, String>) -> Result<(), String> {
    blueprint["rootId"] = json!(ids
        .get(core::text(&blueprint["rootId"])?)
        .ok_or_else(|| invalid("Root mapping missing"))?);
    for node in blueprint["nodes"]
        .as_array_mut()
        .ok_or_else(|| invalid("Expected blueprint nodes"))?
    {
        node["id"] = json!(ids
            .get(core::text(&node["id"])?)
            .ok_or_else(|| invalid("Node mapping missing"))?);
        if !node["parentId"].is_null() {
            node["parentId"] = json!(ids
                .get(core::text(&node["parentId"])?)
                .ok_or_else(|| invalid("Parent mapping missing"))?);
        }
    }
    let mut bindings = Map::new();
    for (id, binding) in core::object(&blueprint["bindings"])? {
        bindings.insert(
            ids.get(id)
                .ok_or_else(|| invalid("Binding mapping missing"))?
                .clone(),
            binding.clone(),
        );
    }
    blueprint["bindings"] = Value::Object(bindings);
    for action in blueprint["actions"].as_object_mut().unwrap().values_mut() {
        if action["kind"] == "local" {
            for effect in action["effects"].as_array_mut().unwrap() {
                if let Some(id) = effect["target"].get("id").and_then(Value::as_str) {
                    effect["target"] =
                        json!({"id":ids.get(id).ok_or_else(||invalid("Effect mapping missing"))?});
                }
            }
        }
    }
    Ok(())
}
pub(crate) fn prepare_template(raw: &str, options_raw: &str) -> Result<Value, String> {
    let saved = parse(raw)?;
    let options = repository::options(options_raw)?;
    let mut blueprint = json!({"title":saved["title"],"catalogVersion":saved["document"]["catalogVersion"],"rootId":saved["document"]["rootId"],"nodes":saved["document"]["nodes"],"actions":saved["actions"],"sources":saved["sources"],"bindings":saved["bindings"]});
    let nodes = saved["document"]["nodes"].as_array().unwrap();
    let ids: BTreeMap<_, _> = nodes
        .iter()
        .enumerate()
        .map(|(i, node)| {
            (
                node["id"].as_str().unwrap().to_string(),
                if node["id"] == saved["document"]["rootId"] {
                    "root".into()
                } else {
                    format!("node-{i}")
                },
            )
        })
        .collect();
    let action_ids: BTreeMap<_, _> = core::object(&saved["actions"])?
        .keys()
        .enumerate()
        .map(|(i, key)| (key.clone(), format!("action-{}", i + 1)))
        .collect();
    let field_ids: BTreeMap<_, _> = nodes
        .iter()
        .filter(|node| node["type"] == "Input" && node["props"]["name"].is_string())
        .enumerate()
        .map(|(i, node)| {
            (
                node["props"]["name"].as_str().unwrap().to_string(),
                format!("field-{}", i + 1),
            )
        })
        .collect();
    for action in core::object(&saved["actions"])?.values() {
        if action["kind"] == "local" {
            for effect in action["effects"].as_array().unwrap() {
                let target = core::target(&saved["document"], &effect["target"])?;
                let node = blueprint["nodes"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|node| node["id"] == target["id"])
                    .unwrap();
                if effect["kind"] == "setText" {
                    node["text"] = json!([]);
                } else {
                    let catalog = catalog();
                    let property = core::text(&effect["property"])?;
                    let schema = &catalog["components"][core::text(&node["type"])?]["props"]
                        ["properties"][property];
                    node["props"][property] = schema["enum"]
                        .as_array()
                        .and_then(|v| v.first())
                        .cloned()
                        .unwrap_or_else(|| match schema["type"].as_str() {
                            Some("boolean") => json!(false),
                            Some("number" | "integer") => {
                                schema.get("minimum").cloned().unwrap_or(json!(0))
                            }
                            _ => json!(""),
                        });
                }
            }
        }
    }
    for node in blueprint["nodes"].as_array_mut().unwrap() {
        if node["type"] == "Input" {
            node["props"]["defaultValue"] = json!("");
            if let Some(original) = nodes
                .iter()
                .find(|old| old["id"] == node["id"])
                .and_then(|old| old["props"]["name"].as_str())
            {
                node["props"]["name"] = json!(field_ids[original]);
            }
        }
        if node["type"] == "ChecklistItem" {
            node["props"]["checked"] = json!(false);
        }
        if let Some(action) = node.get_mut("action") {
            action["slot"] = json!(action_ids[core::text(&action["slot"])?]);
            for input in action["input"].as_object_mut().unwrap().values_mut() {
                if let Some(field) = input.get("field").and_then(Value::as_str) {
                    *input = json!({"field":field_ids[field]});
                }
            }
        }
    }
    let mut actions = Map::new();
    for (id, action) in core::object(&blueprint["actions"])? {
        let mut action = action.clone();
        if action["kind"] == "source" && action["recordId"].is_string() {
            action["recordId"] = json!({"first":true});
        }
        actions.insert(action_ids[id].clone(), action);
    }
    blueprint["actions"] = Value::Object(actions);
    for source in blueprint["sources"].as_object_mut().unwrap().values_mut() {
        source["connection"] = Value::Null;
    }
    for binding in blueprint["bindings"].as_object_mut().unwrap().values_mut() {
        binding["recordId"] = json!({"first":true});
    }
    remap(&mut blueprint, &ids)?;
    let package = json!({"format":"trellis_authored_template_v1","repositoryId":"workspace","templateId":format!("workspace:{}",core::text(&options["slug"]) ?),"version":options["version"],"name":options["name"],"description":options["description"],"tags":options["tags"],"blueprint":blueprint});
    validate_package(&package.to_string(), None)
}
pub(crate) fn instantiate(
    page_id: u64,
    node_id: u64,
    parent_id: &str,
    principal: &str,
    request_id: &str,
    raw: &str,
    expected_hash: &str,
) -> Result<String, String> {
    let package = validate_package(raw, Some(expected_hash))?;
    let mut blueprint = package["blueprint"].clone();
    let ids = blueprint["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| {
            let id = node["id"].as_str().unwrap();
            (id.to_string(), format!("pear-component:{node_id}:{id}"))
        })
        .collect();
    remap(&mut blueprint, &ids)?;
    let mut saved: Value = serde_json::from_str(&create(
        page_id,
        node_id,
        parent_id,
        principal,
        request_id,
        core::text(&blueprint["title"])?,
    )?)
    .unwrap();
    for key in ["title", "actions", "sources", "bindings"] {
        saved[key] = blueprint[key].clone();
    }
    for key in ["rootId", "nodes"] {
        saved["document"][key] = blueprint[key].clone();
    }
    let fingerprint = core::hash(&repository::canonical(
        &json!({"templateId":package["templateId"],"version":package["version"],"hash":expected_hash}),
    )?);
    saved["creation"]["fingerprint"] = json!(fingerprint);
    saved["receipts"][0]["fingerprint"] = json!(fingerprint);
    saved["origin"] = json!({"templateId":package["templateId"],"version":package["version"],"hash":expected_hash});
    let result = saved.to_string();
    parse(&result)?;
    Ok(result)
}
