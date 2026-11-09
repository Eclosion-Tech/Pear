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
    catalog["components"]["Input"]["props"]["properties"]["inputType"] =
        json!({"type":"string","enum":["text","email","url","number"]});
    catalog["components"]["Input"]["props"]["properties"]["multiline"] = json!({"type":"boolean"});
    let filter = json!({"type":"array","maxItems":8,"items":{"type":"object","properties":{"field":{"type":"string"},"op":{"type":"string","enum":["eq","neq","lt","gt","contains","isEmpty"]},"value":{"type":["string","number","boolean","null"]}},"required":["field","op"]}});
    let sort = json!({"type":"array","maxItems":3,"items":{"type":"object","properties":{"field":{"type":"string"},"direction":{"type":"string","enum":["asc","desc"]}},"required":["field","direction"]}});
    catalog["components"]["DataTable"] = json!({"acceptsChildren":false,"props":{"type":"object","properties":{"source":{"type":"string"},"columns":{"type":"array","items":{"type":"string"},"maxItems":32},"filter":filter,"sort":sort,"limit":{"type":"integer","minimum":1,"maximum":200},"emptyText":{"type":"string","maxLength":500},"rowAction":{"type":"string"}},"required":["source","columns"]}});
    catalog["components"]["RecordList"] = json!({"acceptsChildren":false,"props":{"type":"object","properties":{"source":{"type":"string"},"titleField":{"type":"string"},"detailFields":{"type":"array","items":{"type":"string"},"maxItems":4},"filter":filter,"sort":sort,"limit":{"type":"integer","minimum":1,"maximum":200},"emptyText":{"type":"string","maxLength":500},"rowAction":{"type":"string"}},"required":["source","titleField"]}});
    catalog["components"]["CalendarGrid"] = json!({"acceptsChildren":false,"props":{"type":"object","properties":{"source":{"type":"string"},"startField":{"type":"string"},"endField":{"type":"string"},"titleField":{"type":"string"},"emptyText":{"type":"string","maxLength":500},"rowAction":{"type":"string"}},"required":["source","startField","titleField"]}});
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
                if !["$title", "$id"].contains(&id)
                    && (id.starts_with('0')
                        || !id.bytes().all(|c| c.is_ascii_digit())
                        || id.parse::<u64>().ok().filter(|v| *v > 0).is_none())
                {
                    return Err(invalid("Map source fields to properties"));
                }
            }
        }
        "external.json" => {
            core::keys(
                value,
                &[
                    "adapter",
                    "readUrl",
                    "recordsPath",
                    "idField",
                    "write",
                    "create",
                ],
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
            if let Some(create) = value.get("create") {
                exact(create, &["url", "method", "idempotency"])?;
                url(&create["url"])?;
                if create["method"] != "POST" || create["idempotency"] != "key" {
                    return Err(invalid(
                        "Creation requires POST and provider Idempotency-Key support",
                    ));
                }
            }
        }
        _ => return Err(error("UNSUPPORTED_SOURCE", "Unsupported data adapter")),
    }
    Ok(())
}
fn is_civil_date(value: &Value) -> bool {
    let Some(date) = value.as_str() else {
        return false;
    };
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes.iter().enumerate().any(|(i, c)| {
            if i == 4 || i == 7 {
                *c != b'-'
            } else {
                !c.is_ascii_digit()
            }
        })
    {
        return false;
    }
    let year: u32 = date[..4].parse().unwrap();
    let month: u32 = date[5..7].parse().unwrap();
    let day: u32 = date[8..].parse().unwrap();
    let days = match month {
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    (1..=days).contains(&day)
}

fn validate_view_request(source: &Value, fields: &[Value], props: &Value) -> Result<(), String> {
    let field = |name: &Value| {
        name.as_str()
            .and_then(|name| source["fields"].get(name))
            .ok_or_else(|| {
                error(
                    "INVALID_BINDING",
                    "Query fields must be declared by the source.",
                )
            })
    };
    // Preserve the first occurrence, as componentViewRequest does in TypeScript.
    let mut seen = BTreeSet::new();
    let fields: Vec<_> = fields
        .iter()
        .filter(|name| seen.insert(name.as_str()))
        .collect();
    if fields.is_empty() || fields.len() > 32 {
        return Err(error("LIMIT", "Choose between one and 32 query fields."));
    }
    for name in fields {
        field(name)?;
    }
    if let Some(filter) = props.get("filter") {
        let predicates = filter
            .as_array()
            .ok_or_else(|| error("INVALID_BINDING", "Expected a query list."))?;
        if predicates.len() > 8 {
            return Err(error("LIMIT", "Query list exceeds the limit."));
        }
        for predicate in predicates {
            core::keys(predicate, &["field", "op", "value"])?;
            let kind = core::text(&field(&predicate["field"])?["type"])?;
            let op = predicate["op"].as_str().unwrap_or("");
            if !["eq", "neq", "lt", "gt", "contains", "isEmpty"].contains(&op)
                || (op == "contains" && kind != "string")
                || (["lt", "gt"].contains(&op) && kind == "boolean")
            {
                return Err(error(
                    "INVALID_BINDING",
                    "This operator does not apply to the field type.",
                ));
            }
            if op == "isEmpty" {
                if predicate.get("value").is_some() {
                    return Err(error("INVALID_BINDING", "isEmpty takes no value."));
                }
            } else if !predicate.get("value").is_some_and(|value| {
                if value.is_null() {
                    return ["eq", "neq"].contains(&op);
                }
                match kind {
                    "date" => is_civil_date(value),
                    "string" => value.is_string(),
                    "number" => value.as_f64().is_some_and(|n| n.is_finite()),
                    "boolean" => value.is_boolean(),
                    _ => false,
                }
            }) {
                return Err(error(
                    "INVALID_BINDING",
                    "Query values must match the declared field type.",
                ));
            }
        }
    }
    if let Some(sort) = props.get("sort") {
        let sorts = sort
            .as_array()
            .ok_or_else(|| error("INVALID_BINDING", "Expected a query list."))?;
        if sorts.len() > 3 {
            return Err(error("LIMIT", "Query list exceeds the limit."));
        }
        for sort in sorts {
            core::keys(sort, &["field", "direction"])?;
            field(&sort["field"])?;
            if sort["direction"] != "asc" && sort["direction"] != "desc" {
                return Err(error(
                    "INVALID_BINDING",
                    "Choose ascending or descending order.",
                ));
            }
        }
    }
    if props.get("limit").is_some_and(|limit| {
        !limit
            .as_f64()
            .is_some_and(|n| n.fract() == 0.0 && (1.0..=200.0).contains(&n))
    }) {
        return Err(error(
            "LIMIT",
            "Query limit must be an integer between one and 200.",
        ));
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
        let mut keys = vec!["label", "fields", "connection"];
        if let Some(mode) = source.get("mode") {
            keys.push("mode");
            if mode != "snapshot" && mode != "query" {
                return Err(error(
                    "INVALID_BINDING",
                    "Choose snapshot or query source mode.",
                ));
            }
        }
        exact(source, &keys)?;
        string(&source["label"], 160)?;
        for field in map(&source["fields"], 32)?.values() {
            core::keys(field, &["type", "writable"])?;
            if !["string", "number", "boolean", "date"].contains(&core::text(&field["type"])?)
                || field.get("writable").is_some_and(|v| !v.is_boolean())
            {
                return Err(invalid("Invalid source field"));
            }
            if field["type"] == "date" && field["writable"] == true {
                return Err(error(
                    "INVALID_BINDING",
                    "Date fields are read-only in this version.",
                ));
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
                for (field, id) in mapping {
                    if (id == "$title" || id == "$id")
                        && (source["fields"][field]["type"] != "string"
                            || source["fields"][field]["writable"] == true)
                    {
                        return Err(error(
                            "INVALID_BINDING",
                            "Native record attributes are read-only text fields.",
                        ));
                    }
                }
            }
        }
    }
    for action in actions.values() {
        let kind = core::text(&action["kind"])?;
        match kind {
            "local" => exact(action, &["kind", "input", "message", "effects"])?,
            "refresh" => exact(action, &["kind", "input", "message", "source"])?,
            "open" => {
                let mut keys = vec!["kind", "input", "message", "source", "recordId"];
                if action.get("layout").is_some() {
                    keys.push("layout");
                }
                exact(action, &keys)?;
            }
            "create" => {
                core::keys(
                    action,
                    &[
                        "kind",
                        "input",
                        "message",
                        "source",
                        "fields",
                        "clearOnSuccess",
                    ],
                )?;
                for key in ["kind", "input", "message", "source", "fields"] {
                    if action.get(key).is_none() {
                        return Err(invalid("Required action fields are missing"));
                    }
                }
                if action
                    .get("clearOnSuccess")
                    .is_some_and(|v| !v.is_boolean())
                {
                    return Err(invalid("Clear-on-success must be a boolean"));
                }
            }
            _ => exact(
                action,
                &["kind", "input", "message", "source", "recordId", "fields"],
            )?,
        }
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
            "source" | "create" | "refresh" | "open" => {
                let source = sources.get(core::text(&action["source"])?).ok_or_else(|| {
                    if action["kind"] == "open" {
                        error("INVALID_BINDING", "Action source is not declared.")
                    } else {
                        invalid("Action source missing")
                    }
                })?;
                // Query sources are read-only end to end; mirrors the TypeScript validator.
                if source["mode"] == "query" && (action["kind"] == "source" || action["kind"] == "create") {
                    return Err(error("READ_ONLY_SOURCE", "Query sources are read-only."));
                }
                if action["kind"] == "open" {
                    exact(&action["recordId"], &["row"])?;
                    if action["recordId"]["row"] != true {
                        return Err(error(
                            "INVALID_BINDING",
                            "Open actions must select the current row.",
                        ));
                    }
                    if action["input"]
                        .get("properties")
                        .is_some_and(|v| v.as_object().is_some_and(|v| !v.is_empty()))
                    {
                        return Err(error("INVALID_BINDING", "Opening a record takes no input."));
                    }
                    if let Some(layout) = action.get("layout") {
                        exact(layout, &["templateId", "version"])?;
                        let template = core::id(&layout["templateId"])?;
                        // Match the exact decimal version syntax without imposing a numeric size limit.
                        let version = layout["version"].as_str().unwrap_or("");
                        let parts: Vec<_> = version.split('.').collect();
                        if !template.starts_with("workspace:")
                            || parts.len() != 3
                            || parts.iter().any(|part| {
                                part.is_empty()
                                    || !part.bytes().all(|c| c.is_ascii_digit())
                                    || (part.len() > 1 && part.starts_with('0'))
                            })
                        {
                            return Err(error(
                                "INVALID_BINDING",
                                "Choose an exact workspace layout version.",
                            ));
                        }
                    }
                    continue;
                }
                if action["kind"] == "refresh" {
                    if !core::object(&action["input"]["properties"])?.is_empty() {
                        return Err(invalid("Refresh takes no input"));
                    }
                    continue;
                }
                if action["kind"] == "source" {
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
        if node["type"] == "CalendarGrid" {
            let source = &saved["sources"][core::text(&node["props"]["source"])?];
            let typed = |property: &str, kind: &str| {
                node["props"][property]
                    .as_str()
                    .is_some_and(|field| source["fields"][field]["type"] == kind)
            };
            if !typed("startField", "date")
                || (node["props"].get("endField").is_some() && !typed("endField", "date"))
                || !typed("titleField", "string")
            {
                return Err(error("INVALID_BINDING", "Calendar fields must belong to its declared source and have the required types."));
            }
        }
        if node["type"] == "DataTable"
            || node["type"] == "CalendarGrid"
            || node["type"] == "RecordList"
        {
            if let Some(slot) = node["props"].get("rowAction") {
                let action = &saved["actions"][core::text(slot)?];
                if action["kind"] != "open" || action["source"] != node["props"]["source"] {
                    return Err(error(
                        "INVALID_BINDING",
                        "Row actions must open a record from the same source.",
                    ));
                }
            }
        }
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
            validate_view_request(source, columns, &node["props"])?;
        }
        if node["type"] == "RecordList" {
            let props = &node["props"];
            let source = sources
                .get(core::text(&props["source"])?)
                .ok_or_else(|| invalid("List source missing"))?;
            let field_error = || {
                error(
                    "INVALID_BINDING",
                    "List fields must be distinct fields of its declared source.",
                )
            };
            let title = props["titleField"].as_str().ok_or_else(field_error)?;
            let empty = vec![];
            let details = match props.get("detailFields") {
                Some(value) => value.as_array().ok_or_else(field_error)?,
                None => &empty,
            };
            let mut seen = BTreeSet::from([title]);
            if source["fields"].get(title).is_none()
                || details.iter().any(|field| {
                    field.as_str().is_none_or(|field| {
                        source["fields"].get(field).is_none() || !seen.insert(field)
                    })
                })
            {
                return Err(field_error());
            }
            let mut fields = vec![props["titleField"].clone()];
            fields.extend_from_slice(details);
            validate_view_request(source, &fields, props)?;
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
        if binding["recordId"].get("param").is_some() {
            exact(&binding["recordId"], &["param"])?;
            if binding["recordId"]["param"] != "record" || binding["writeBack"] != false {
                return Err(error(
                    "INVALID_BINDING",
                    "Record parameter bindings are read-only and must select record.",
                ));
            }
        } else {
            record_target(&binding["recordId"])?;
        }
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
        core::keys(
            receipt,
            &[
                "principal",
                "requestId",
                "fingerprint",
                "revision",
                "recordId",
            ],
        )?;
        if let Some(id) = receipt.get("recordId") {
            if string(id, 256)?.is_empty() {
                return Err(invalid("Created record identity is empty"));
            }
        }
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
    if saved["sources"][source]["mode"] == "query" {
        return Err(error("READ_ONLY_SOURCE", "Query sources are read-only."));
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
            target.is_string() && target == record
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
                || !(action["recordId"].get("input").is_some() || matches(&action["recordId"]))
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
fn validate_field_input(field: &Value, value: &Value) -> Result<(), String> {
    if field["props"]["required"] == true
        && (value.is_null() || value.as_str().is_some_and(|s| s.trim().is_empty()))
    {
        return Err(error("REQUIRED_PROP", "An input is required"));
    }
    if let Some(value) = value.as_str().filter(|s| !s.is_empty()) {
        if field["props"]["inputType"] == "email" {
            let valid = value.split_once('@').is_some_and(|(name, domain)| {
                !name.is_empty()
                    && !domain.contains('@')
                    && domain
                        .rsplit_once('.')
                        .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
            }) && !value.chars().any(char::is_whitespace);
            if !valid {
                return Err(error("INVALID_INPUT", "Enter a valid email address"));
            }
        }
        if field["props"]["inputType"] == "url"
            && url::Url::parse(value)
                .ok()
                .filter(|url| ["http", "https"].contains(&url.scheme()))
                .is_none()
        {
            return Err(error(
                "INVALID_INPUT",
                "Enter an absolute HTTP or HTTPS URL",
            ));
        }
    }
    Ok(())
}
fn action_input<'a>(
    saved: &'a Value,
    event: &Value,
    allow_stale: bool,
) -> Result<&'a Value, String> {
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
    if event["slot"]
        .as_str()
        .is_some_and(|slot| saved["actions"][slot]["kind"] == "open")
    {
        return Err(error(
            "INVALID_OPERATION",
            "Open actions navigate; they do not commit.",
        ));
    }
    let document = &saved["document"];
    let node = document["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == event["nodeId"])
        .ok_or_else(|| error("STALE_ACTION", "Control unavailable"))?;
    if event["documentId"] != document["documentId"]
        || (!allow_stale && event["revision"] != document["revision"])
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
                    .is_some_and(|s| s.trim().is_empty())
            {
                return Err(error("REQUIRED_PROP", "An input is required"));
            }
            if let Some(field) = field {
                validate_field_input(field, &event["input"][key])?;
            }
        } else if !core::equal(value, &event["input"][key]) {
            return Err(invalid("A literal action input changed"));
        }
    }

    Ok(action)
}
pub(crate) fn create_intent(
    saved: &Value,
    event: &Value,
    allow_stale: bool,
) -> Result<(String, Value), String> {
    let action = action_input(saved, event, allow_stale)?;
    if action["kind"] != "create" {
        return Err(invalid("This control does not create a source record"));
    }
    if saved["sources"][core::text(&action["source"])?]["mode"] == "query" {
        return Err(error("READ_ONLY_SOURCE", "Query sources are read-only."));
    }
    let mut values = Map::new();
    for (field, input) in core::object(&action["fields"])? {
        values.insert(field.clone(), event["input"][core::text(input)?].clone());
    }
    Ok((core::text(&action["source"])?.into(), Value::Object(values)))
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
            let action = action_input(&saved, event, false)?;
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
        "source-create" => {
            if command["event"]["slot"]
                .as_str()
                .is_some_and(|slot| saved["actions"][slot]["kind"] == "open")
            {
                return Err(error(
                    "INVALID_OPERATION",
                    "Open actions navigate; they do not commit.",
                ));
            }
            exact(&command, &["kind", "event"])?;
            let (source, _) = create_intent(&saved, &command["event"], false)?;
            if saved["sources"][&source]["connection"]["adapter"] != "pear.database" {
                return Err(error(
                    "SOURCE_WRITE_REQUIRED",
                    "External creation requires its source adapter",
                ));
            }
            saved["document"]["revision"] = json!(base_revision + 1);
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
        if node["type"] == "DataTable"
            || node["type"] == "CalendarGrid"
            || node["type"] == "RecordList"
        {
            if let Some(slot) = node["props"]["rowAction"].as_str() {
                node["props"]["rowAction"] = json!(action_ids[slot]);
            }
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
        if binding["recordId"].get("param").is_none() {
            binding["recordId"] = json!({"first":true});
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        let mut saved =
            parse(&create(1, 2, "parent", "author", "initial", "Calendar").unwrap()).unwrap();
        saved["sources"]["events"] = json!({"label":"Events","fields":{
            "title":{"type":"string","writable":true},
            "start":{"type":"date"},"end":{"type":"date","writable":false}
        },"connection":null});
        saved["actions"]["open-record"] = json!({"kind":"open","input":{"type":"object","properties":{}},"message":"","source":"events","recordId":{"row":true}});
        let root = saved["document"]["rootId"].clone();
        saved["document"]["nodes"].as_array_mut().unwrap().extend([
            json!({"id":"calendar","parentId":root,"order":0,"type":"CalendarGrid","props":{"source":"events","startField":"start","endField":"end","titleField":"title","rowAction":"open-record"}}),
            json!({"id":"table","parentId":root,"order":1,"type":"DataTable","props":{"source":"events","columns":["title"],"rowAction":"open-record"}}),
            json!({"id":"detail","parentId":root,"order":2,"type":"Input","props":{"name":"title"}}),
        ]);
        saved["bindings"]["detail"] = json!({"source":"events","recordId":{"param":"record"},"field":"title","property":"value","writeBack":false});
        parse(&saved.to_string()).unwrap()
    }

    fn accepts(saved: &Value) {
        parse(&saved.to_string()).unwrap();
    }

    fn view_fixture() -> Value {
        let mut saved = fixture();
        saved["sources"]["asks"] = json!({"label":"Asks","mode":"query","fields":{
            "title":{"type":"string"},"id":{"type":"string"},
            "status":{"type":"string"},"raised":{"type":"date"},
            "detail":{"type":"string","writable":true},"done":{"type":"boolean"},
            "score":{"type":"number"}
        },"connection":{"adapter":"pear.database","schemaId":"333","mapping":{
            "title":"$title","id":"$id","status":"1467","raised":"1466","detail":"1463"
        }}});
        saved["actions"]["open-ask"] = json!({"kind":"open","input":{"type":"object","properties":{}},"message":"","source":"asks","recordId":{"row":true}});
        let root = saved["document"]["rootId"].clone();
        saved["document"]["nodes"].as_array_mut().unwrap().extend([
            json!({"id":"asks-table","parentId":root,"order":3,"type":"DataTable","props":{
                "source":"asks","columns":["title","status","raised"],
                "filter":[{"field":"status","op":"eq","value":"Open"}],
                "sort":[{"field":"raised","direction":"asc"}],"limit":50,"rowAction":"open-ask"
            }}),
            json!({"id":"asks-list","parentId":root,"order":4,"type":"RecordList","props":{
                "source":"asks","titleField":"title","detailFields":["status","raised"],
                "filter":[{"field":"status","op":"eq","value":"Open"}],
                "sort":[{"field":"raised","direction":"asc"}],"limit":50,
                "emptyText":"Nothing needs your judgment.","rowAction":"open-ask"
            }}),
        ]);
        saved
    }

    fn view_props<'a>(saved: &'a mut Value, id: &str) -> &'a mut Value {
        &mut saved["document"]["nodes"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|node| node["id"] == id)
            .unwrap()["props"]
    }

    #[test]
    fn query_views_parse_without_changing_saved_props() {
        let saved = view_fixture();
        assert_eq!(parse(&saved.to_string()).unwrap(), saved);
    }

    #[test]
    fn native_record_attributes_require_read_only_text() {
        for field in ["title", "id"] {
            for definition in [
                json!({"type":"string","writable":true}),
                json!({"type":"number"}),
            ] {
                let mut saved = view_fixture();
                saved["sources"]["asks"]["fields"][field] = definition;
                assert_eq!(
                    parse(&saved.to_string()).unwrap_err(),
                    "INVALID_BINDING: Native record attributes are read-only text fields."
                );
            }
        }
        let mut saved = view_fixture();
        saved["sources"]["asks"]["fields"]["title"]["writable"] = json!(false);
        accepts(&saved);
    }

    #[test]
    fn database_mappings_admit_only_native_attributes_or_positive_decimal_ids() {
        for id in ["$other", "0", "01", "+1", "-1", "", "18446744073709551616"] {
            let mut saved = view_fixture();
            saved["sources"]["asks"]["connection"]["mapping"]["status"] = json!(id);
            rejects(&saved);
        }
        let mut saved = view_fixture();
        saved["sources"]["asks"]["connection"]["mapping"]["status"] = json!("18446744073709551615");
        accepts(&saved);
        saved["sources"]["asks"]["connection"]["mapping"]["status"] = json!("$title");
        assert_eq!(
            parse(&saved.to_string()).unwrap_err(),
            "INVALID_COMPONENT: Map declared fields to distinct properties"
        );
    }

    #[test]
    fn view_filters_validate_declared_fields_operators_and_values() {
        let cases = [
            (
                json!({"field":"missing","op":"eq","value":"Open"}),
                "Query fields must be declared by the source.",
            ),
            (
                json!({"field":"status","op":"eq","value":true}),
                "Query values must match the declared field type.",
            ),
            (
                json!({"field":"status","op":"eq"}),
                "Query values must match the declared field type.",
            ),
            (
                json!({"field":"status","op":"isEmpty","value":null}),
                "isEmpty takes no value.",
            ),
            (
                json!({"field":"raised","op":"contains","value":"2026"}),
                "This operator does not apply to the field type.",
            ),
            (
                json!({"field":"done","op":"lt","value":true}),
                "This operator does not apply to the field type.",
            ),
            (
                json!({"field":"done","op":"gt","value":false}),
                "This operator does not apply to the field type.",
            ),
            (
                json!({"field":"raised","op":"eq","value":"2026-02-30"}),
                "Query values must match the declared field type.",
            ),
            (
                json!({"field":"raised","op":"eq","value":"soon"}),
                "Query values must match the declared field type.",
            ),
            (
                json!({"field":"status","op":"contains","value":null}),
                "Query values must match the declared field type.",
            ),
            (
                json!({"field":"score","op":"eq","value":"3"}),
                "Query values must match the declared field type.",
            ),
        ];
        for id in ["asks-table", "asks-list"] {
            for (predicate, message) in &cases {
                let mut saved = view_fixture();
                view_props(&mut saved, id)["filter"] = json!([predicate]);
                assert_eq!(
                    parse(&saved.to_string()).unwrap_err(),
                    format!("INVALID_BINDING: {message}"),
                    "{id}: {predicate}"
                );
            }
        }
    }

    #[test]
    fn view_filters_accept_matching_scalars_null_and_empty_checks() {
        for predicate in [
            json!({"field":"status","op":"contains","value":"Open"}),
            json!({"field":"score","op":"gt","value":3}),
            json!({"field":"done","op":"eq","value":false}),
            json!({"field":"raised","op":"lt","value":"2024-02-29"}),
            json!({"field":"raised","op":"eq","value":null}),
            json!({"field":"status","op":"neq","value":null}),
            json!({"field":"done","op":"isEmpty"}),
        ] {
            let mut saved = view_fixture();
            for id in ["asks-table", "asks-list"] {
                view_props(&mut saved, id)["filter"] = json!([predicate]);
            }
            accepts(&saved);
        }
    }

    #[test]
    fn view_sort_fields_must_be_declared() {
        for id in ["asks-table", "asks-list"] {
            let mut saved = view_fixture();
            view_props(&mut saved, id)["sort"] = json!([{"field":"missing","direction":"asc"}]);
            assert_eq!(
                parse(&saved.to_string()).unwrap_err(),
                "INVALID_BINDING: Query fields must be declared by the source."
            );
        }
    }

    #[test]
    fn view_catalog_rejects_invalid_shapes_and_bounds() {
        let cases = [
            (
                "filter",
                json!(vec![json!({"field":"status","op":"eq","value":"Open"}); 9]),
            ),
            ("limit", json!(0)),
            ("limit", json!(201)),
            ("limit", json!(1.5)),
            (
                "filter",
                json!([{"field":"status","op":"between","value":"Open"}]),
            ),
            ("filter", json!([{"field":"status","op":"eq","value":{}}])),
            (
                "filter",
                json!([{"field":"status","op":"eq","value":"Open","extra":true}]),
            ),
            (
                "sort",
                json!(vec![json!({"field":"status","direction":"asc"}); 4]),
            ),
            ("sort", json!([{"field":"status","direction":"up"}])),
            (
                "sort",
                json!([{"field":"status","direction":"asc","extra":true}]),
            ),
        ];
        for (id, kind) in [("asks-table", "DataTable"), ("asks-list", "RecordList")] {
            for (key, value) in &cases {
                let mut saved = view_fixture();
                let props = view_props(&mut saved, id);
                props[*key] = value.clone();
                assert!(
                    core::validate_value(props, &catalog()["components"][kind]["props"]).is_err(),
                    "{kind}: {key} = {value}"
                );
                rejects(&saved);
            }
        }
        let mut saved = view_fixture();
        let props = view_props(&mut saved, "asks-list");
        props["detailFields"] = json!(["id", "status", "raised", "detail", "done"]);
        assert!(
            core::validate_value(props, &catalog()["components"]["RecordList"]["props"]).is_err()
        );
        rejects(&saved);
    }

    #[test]
    fn list_fields_are_distinct_and_declared() {
        for details in [
            json!(["status", "status"]),
            json!(["title"]),
            json!(["missing"]),
        ] {
            let mut saved = view_fixture();
            view_props(&mut saved, "asks-list")["detailFields"] = details;
            assert_eq!(
                parse(&saved.to_string()).unwrap_err(),
                "INVALID_BINDING: List fields must be distinct fields of its declared source."
            );
        }
        let mut saved = view_fixture();
        view_props(&mut saved, "asks-list")["titleField"] = json!("missing");
        rejects(&saved);
        view_props(&mut saved, "asks-list")["titleField"] = json!("title");
        view_props(&mut saved, "asks-list")
            .as_object_mut()
            .unwrap()
            .remove("detailFields");
        accepts(&saved);
    }

    #[test]
    fn snapshot_views_and_duplicate_table_columns_remain_valid() {
        let mut saved = view_fixture();
        saved["sources"]["asks"]["mode"] = json!("snapshot");
        accepts(&saved);
        view_props(&mut saved, "asks-table")["columns"] = json!(["status", "title", "status"]);
        assert_eq!(parse(&saved.to_string()).unwrap(), saved);
        view_props(&mut saved, "asks-table")["columns"] = json!([]);
        rejects(&saved);
        assert_eq!(
            validate_view_request(&saved["sources"]["asks"], &[], &json!({})).unwrap_err(),
            "LIMIT: Choose between one and 32 query fields."
        );
    }

    #[test]
    fn list_row_actions_must_open_the_same_source() {
        for action in ["refresh-asks", "open-record"] {
            let mut saved = view_fixture();
            saved["actions"]["refresh-asks"] = json!({"kind":"refresh","input":{"type":"object","properties":{}},"message":"","source":"asks"});
            view_props(&mut saved, "asks-list")["rowAction"] = json!(action);
            assert_eq!(
                parse(&saved.to_string()).unwrap_err(),
                "INVALID_BINDING: Row actions must open a record from the same source."
            );
        }
    }

    #[test]
    fn templates_remap_list_row_actions_and_preserve_view_settings() {
        let mut saved = view_fixture();
        let options =
            json!({"slug":"asks","version":"1.0.0","name":"Asks","description":"","tags":[]});
        let package = prepare_template(&saved.to_string(), &options.to_string()).unwrap();
        for (id, kind) in [("asks-table", "DataTable"), ("asks-list", "RecordList")] {
            let node = package["blueprint"]["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| node["type"] == kind && node["props"]["source"] == "asks")
                .unwrap();
            assert_eq!(node["props"]["rowAction"], "action-1");
            for key in ["filter", "sort", "limit"] {
                assert_eq!(node["props"][key], view_props(&mut saved, id)[key]);
            }
        }
        assert_eq!(
            package["blueprint"]["actions"]["action-1"]["source"],
            "asks"
        );
    }

    #[test]
    fn scalar_unions_validate_members_and_skip_bounds() {
        let schema = json!({"type":["string","number","boolean","null"],"minimum":10,"maximum":20,"minLength":10,"maxLength":1});
        for value in [json!("Open"), json!(3), json!(false), Value::Null] {
            core::validate_value(&value, &schema).unwrap();
        }
        for value in [json!({}), json!([])] {
            assert!(core::validate_value(&value, &schema)
                .unwrap_err()
                .contains("Value outside the allowed scalar types"));
        }
        for types in [
            json!([]),
            json!(["string", "object"]),
            json!(["integer"]),
            json!([true]),
        ] {
            assert!(core::validate_value(&json!("Open"), &json!({"type":types}))
                .unwrap_err()
                .contains("Unions admit scalar types only"));
        }
        assert!(core::validate_value(
            &json!(3),
            &json!({"type":["string","number"],"enum":["Open"]})
        )
        .is_err());
        assert!(core::validate_value(&json!(false), &json!({"type":["string","null"]})).is_err());
    }

    #[test]
    fn civil_dates_require_exact_format_and_valid_calendar_days() {
        for date in [
            "0000-02-29",
            "2000-02-29",
            "2024-02-29",
            "2026-04-30",
            "9999-12-31",
        ] {
            assert!(is_civil_date(&json!(date)), "{date}");
        }
        for date in [
            "1900-02-29",
            "2026-02-30",
            "2026-04-31",
            "2026-00-01",
            "2026-13-01",
            "2026-01-00",
            "2026-2-01",
            "soon",
            "２０２６-02-01",
        ] {
            assert!(!is_civil_date(&json!(date)), "{date}");
        }
    }

    fn rejects(saved: &Value) {
        assert!(parse(&saved.to_string()).is_err());
    }
    fn write() -> Value {
        json!({"source":"events","recordId":"11","values":{"title":"Changed"},"requestId":"write"})
    }
    fn event(saved: &Value) -> Value {
        json!({"documentId":saved["document"]["documentId"],"revision":0,"nodeId":"calendar","slot":"open-record","invocationId":"open","input":{}})
    }

    #[test]
    fn source_modes_are_optional_and_exact() {
        let mut saved = fixture();
        for mode in ["snapshot", "query"] {
            saved["sources"]["events"]["mode"] = json!(mode);
            accepts(&saved);
        }
        for mode in [json!(null), json!(true), json!("other")] {
            saved["sources"]["events"]["mode"] = mode;
            assert!(parse(&saved.to_string())
                .unwrap_err()
                .starts_with("INVALID_BINDING:"));
        }
        saved["sources"]["events"]
            .as_object_mut()
            .unwrap()
            .remove("mode");
        accepts(&saved);
        saved["sources"]["events"]["extra"] = json!(true);
        rejects(&saved);
        saved["sources"]["events"]
            .as_object_mut()
            .unwrap()
            .remove("extra");
        saved["sources"]["events"]
            .as_object_mut()
            .unwrap()
            .remove("connection");
        rejects(&saved);
    }

    #[test]
    fn date_fields_are_read_only() {
        let mut saved = fixture();
        saved["sources"]["events"]["fields"]["start"]["writable"] = json!(false);
        accepts(&saved);
        saved["sources"]["events"]["fields"]["start"]["writable"] = json!(true);
        assert_eq!(
            parse(&saved.to_string()).unwrap_err(),
            "INVALID_BINDING: Date fields are read-only in this version."
        );
        saved["sources"]["events"]["fields"]["start"] = json!({"type":"datetime"});
        rejects(&saved);
    }

    #[test]
    fn calendar_catalog_enforces_props_and_children() {
        let saved = fixture();
        for required in ["source", "startField", "titleField"] {
            let mut bad = saved.clone();
            bad["document"]["nodes"][1]["props"]
                .as_object_mut()
                .unwrap()
                .remove(required);
            rejects(&bad);
        }
        let mut changed = saved.clone();
        changed["document"]["nodes"][1]["props"]
            .as_object_mut()
            .unwrap()
            .remove("endField");
        changed["document"]["nodes"][1]["props"]["emptyText"] = json!("x".repeat(500));
        accepts(&changed);
        changed["document"]["nodes"][1]["props"]["emptyText"] = json!("x".repeat(501));
        rejects(&changed);
        changed = saved.clone();
        changed["document"]["nodes"][3]["parentId"] = json!("calendar");
        rejects(&changed);
        changed = saved;
        changed["document"]["nodes"][1]["props"]["unknown"] = json!(true);
        rejects(&changed);
    }

    #[test]
    fn calendar_fields_must_have_declared_types() {
        let saved = fixture();
        for (property, value) in [
            ("source", "missing"),
            ("startField", "missing"),
            ("startField", "title"),
            ("endField", "missing"),
            ("endField", "title"),
            ("titleField", "missing"),
            ("titleField", "start"),
        ] {
            let mut bad = saved.clone();
            bad["document"]["nodes"][1]["props"][property] = json!(value);
            assert!(parse(&bad.to_string())
                .unwrap_err()
                .starts_with("INVALID_BINDING:"));
        }
    }

    #[test]
    fn open_actions_require_exact_row_and_empty_input() {
        let saved = fixture();
        let mut minimal = saved.clone();
        minimal["actions"]["open-record"]["input"] = json!({"type":"object"});
        accepts(&minimal);
        for target in [
            json!({"row":false}),
            json!({"first":true}),
            json!({"row":true,"extra":true}),
            json!("11"),
        ] {
            let mut bad = saved.clone();
            bad["actions"]["open-record"]["recordId"] = target;
            rejects(&bad);
        }
        for key in ["kind", "input", "message", "source", "recordId"] {
            let mut bad = saved.clone();
            bad["actions"]["open-record"]
                .as_object_mut()
                .unwrap()
                .remove(key);
            rejects(&bad);
        }
        let mut bad = saved.clone();
        bad["actions"]["open-record"]["fields"] = json!({});
        rejects(&bad);
        bad = saved.clone();
        bad["actions"]["open-record"]["source"] = json!("missing");
        rejects(&bad);
        bad = saved;
        bad["actions"]["open-record"]["input"]["properties"] = json!({"value":{"type":"string"}});
        rejects(&bad);
    }

    #[test]
    fn open_layouts_require_exact_workspace_versions() {
        let mut saved = fixture();
        for version in ["0.0.0", "1.23.456", "9999999999999999999999999.0.1"] {
            saved["actions"]["open-record"]["layout"] =
                json!({"templateId":"workspace:detail","version":version});
            accepts(&saved);
        }
        for version in [
            "01.0.0",
            "1.00.0",
            "1.0.01",
            "1.0",
            "1.0.0-beta",
            "1.0.0+build",
            "-1.0.0",
            "1.0.0\n",
            "1.0.x",
        ] {
            saved["actions"]["open-record"]["layout"]["version"] = json!(version);
            rejects(&saved);
        }
        for layout in [
            json!(null),
            json!({"templateId":"external:detail","version":"1.0.0"}),
            json!({"templateId":"workspace:bad name","version":"1.0.0"}),
            json!({"templateId":"workspace:detail","version":1}),
            json!({"templateId":"workspace:detail"}),
            json!({"templateId":"workspace:detail","version":"1.0.0","extra":true}),
        ] {
            saved["actions"]["open-record"]["layout"] = layout;
            rejects(&saved);
        }
    }

    #[test]
    fn row_actions_must_open_the_same_source() {
        let saved = fixture();
        for index in [1, 2] {
            let mut changed = saved.clone();
            changed["document"]["nodes"][index]["props"]
                .as_object_mut()
                .unwrap()
                .remove("rowAction");
            accepts(&changed);
            changed["document"]["nodes"][index]["props"]["rowAction"] = json!("missing");
            rejects(&changed);
            changed["actions"]["refresh"] = json!({"kind":"refresh","source":"events","message":"","input":{"type":"object","properties":{}}});
            changed["document"]["nodes"][index]["props"]["rowAction"] = json!("refresh");
            rejects(&changed);
            changed["sources"]["other"] = changed["sources"]["events"].clone();
            changed["actions"]["other-open"] = changed["actions"]["open-record"].clone();
            changed["actions"]["other-open"]["source"] = json!("other");
            changed["document"]["nodes"][index]["props"]["rowAction"] = json!("other-open");
            rejects(&changed);
        }
    }

    #[test]
    fn parameter_bindings_are_exact_and_read_only() {
        let mut saved = fixture();
        for target in [
            json!({"param":"record"}),
            json!({"first":true}),
            json!("11"),
        ] {
            saved["bindings"]["detail"]["recordId"] = target;
            accepts(&saved);
        }
        for target in [
            json!({"param":"other"}),
            json!({"param":"record","first":true}),
            json!({"param":"record","extra":true}),
            json!({"first":false}),
            json!(""),
        ] {
            saved["bindings"]["detail"]["recordId"] = target;
            rejects(&saved);
        }
        saved["bindings"]["detail"]["recordId"] = json!({"param":"record"});
        saved["bindings"]["detail"]["writeBack"] = json!(true);
        rejects(&saved);
        // Parameter selectors are bindings only, not source-write action targets.
        saved["bindings"]["detail"]["writeBack"] = json!(false);
        saved["actions"]["write"] = json!({"kind":"source","source":"events","recordId":{"param":"record"},"message":"","input":{"type":"object","properties":{"title":{"type":"string"}}},"fields":{"title":"title"}});
        rejects(&saved);
    }

    #[test]
    fn open_actions_never_commit_even_for_stale_controls() {
        let saved = fixture();
        let mut event = event(&saved);
        event["nodeId"] = json!("missing");
        for kind in ["action", "source-create"] {
            let result = commit(
                &saved.to_string(),
                0,
                "author",
                "next",
                &json!({"kind":kind,"event":event}).to_string(),
            );
            assert_eq!(
                result.unwrap_err(),
                "INVALID_OPERATION: Open actions navigate; they do not commit."
            );
        }
        assert_eq!(
            create_intent(&saved, &event, true).unwrap_err(),
            "INVALID_OPERATION: Open actions navigate; they do not commit."
        );
        // source-create rejects an open slot before requiring the full action event.
        assert_eq!(
            commit(
                &saved.to_string(),
                0,
                "author",
                "next",
                &json!({"kind":"source-create","event":{"slot":"open-record"}}).to_string()
            )
            .unwrap_err(),
            "INVALID_OPERATION: Open actions navigate; they do not commit."
        );
    }

    #[test]
    fn query_sources_cannot_authorize_writes() {
        let mut saved = fixture();
        authorize_write(&saved, &write()).unwrap();
        saved["sources"]["events"]["mode"] = json!("snapshot");
        authorize_write(&saved, &write()).unwrap();
        saved["sources"]["events"]["mode"] = json!("query");
        accepts(&saved);
        assert_eq!(
            authorize_write(&saved, &write()).unwrap_err(),
            "READ_ONLY_SOURCE: Query sources are read-only."
        );
    }

    #[test]
    fn write_targets_match_only_strings_and_first_bindings() {
        let mut saved = fixture();
        saved["document"]["nodes"].as_array_mut().unwrap().remove(2);
        saved["bindings"]["detail"]["writeBack"] = json!(true);
        // Defense in depth: even an unvalidated parameter binding cannot grant a write.
        assert!(authorize_write(&saved, &write()).is_err());
        saved["bindings"]["detail"]["recordId"] = json!({"first":true});
        accepts(&saved);
        authorize_write_for_record(&saved, &write(), Some("11")).unwrap();
        assert!(authorize_write_for_record(&saved, &write(), Some("12")).is_err());
        saved["bindings"]["detail"]["recordId"] = json!("11");
        authorize_write(&saved, &write()).unwrap();
        saved["bindings"]["detail"]["recordId"] = json!("12");
        assert!(authorize_write(&saved, &write()).is_err());
    }

    #[test]
    fn source_actions_keep_input_record_targets() {
        let mut saved = fixture();
        saved["document"]["nodes"].as_array_mut().unwrap().remove(2);
        saved["bindings"] = json!({});
        saved["document"]["nodes"][2] = json!({"id":"button","parentId":saved["document"]["rootId"],"order":2,"type":"Button","props":{},"action":{"slot":"write","input":{"title":"Changed","id":"11"}}});
        saved["actions"]["write"] = json!({"kind":"source","source":"events","recordId":{"input":"id"},"message":"","input":{"type":"object","properties":{"title":{"type":"string"},"id":{"type":"string"}},"required":["title","id"]},"fields":{"title":"title"}});
        accepts(&saved);
        authorize_write(&saved, &write()).unwrap();
        let mut wrong = write();
        wrong["recordId"] = json!("12");
        assert!(authorize_write(&saved, &wrong).is_err());
    }

    #[test]
    fn templates_preserve_query_ports_params_and_remap_row_actions() {
        let mut saved = fixture();
        saved["sources"]["events"]["mode"] = json!("query");
        saved["sources"]["events"]["connection"] =
            json!({"adapter":"pear.database","schemaId":"5","mapping":{"title":"7"}});
        let options = json!({"slug":"calendar","version":"1.0.0","name":"Calendar","description":"","tags":[]});
        let package = prepare_template(&saved.to_string(), &options.to_string()).unwrap();
        let blueprint = &package["blueprint"];
        assert_eq!(blueprint["sources"]["events"]["mode"], "query");
        assert!(blueprint["sources"]["events"]["connection"].is_null());
        assert_eq!(
            blueprint["bindings"]["node-3"]["recordId"],
            json!({"param":"record"})
        );
        for index in [1, 2] {
            assert_eq!(blueprint["nodes"][index]["props"]["rowAction"], "action-1");
        }
        assert_eq!(blueprint["actions"]["action-1"]["kind"], "open");
        let hash = package_hash(&package).unwrap();
        let instance = parse(
            &instantiate(
                3,
                4,
                "parent",
                "author",
                "instance",
                &package.to_string(),
                &hash,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            instance["bindings"]["pear-component:4:node-3"]["recordId"],
            json!({"param":"record"})
        );
        assert_eq!(instance["sources"]["events"]["mode"], "query");
        let mut connected = package.clone();
        connected["blueprint"]["sources"]["events"]["connection"] =
            saved["sources"]["events"]["connection"].clone();
        assert!(validate_package(&connected.to_string(), None).is_err());
        let mut invalid_mode = package.clone();
        invalid_mode["blueprint"]["sources"]["events"]["mode"] = json!("other");
        assert!(validate_package(&invalid_mode.to_string(), None).is_err());
        let mut writable_param = package.clone();
        writable_param["blueprint"]["bindings"]["node-3"]["writeBack"] = json!(true);
        assert!(validate_package(&writable_param.to_string(), None).is_err());
        for target in [json!("11"), json!({"first":true})] {
            saved["bindings"]["detail"]["recordId"] = target;
            let package = prepare_template(&saved.to_string(), &options.to_string()).unwrap();
            assert_eq!(
                package["blueprint"]["bindings"]["node-3"]["recordId"],
                json!({"first":true})
            );
        }
    }

    #[test]
    fn query_sources_reject_write_and_create_actions_and_intents() {
        let mut saved = fixture();
        saved["sources"]["events"]["mode"] = json!("query");
        accepts(&saved);
        let mut with_create = saved.clone();
        with_create["actions"]["add"] = json!({"kind":"create","input":{"type":"object","properties":{"title":{"type":"string"}}},"message":"","source":"events","fields":{"title":"title"}});
        assert_eq!(parse(&with_create.to_string()).unwrap_err(), "READ_ONLY_SOURCE: Query sources are read-only.");
        let mut with_write = saved.clone();
        with_write["actions"]["edit"] = json!({"kind":"source","input":{"type":"object","properties":{"title":{"type":"string"}}},"message":"","source":"events","recordId":{"first":true},"fields":{"title":"title"}});
        assert_eq!(parse(&with_write.to_string()).unwrap_err(), "READ_ONLY_SOURCE: Query sources are read-only.");
        // A definition saved before a source became query-mode cannot create through a stale intent either.
        let mut legacy = fixture();
        legacy["actions"]["add"] = json!({"kind":"create","input":{"type":"object","properties":{"title":{"type":"string"}}},"message":"","source":"events","fields":{"title":"title"}});
        let root = legacy["document"]["rootId"].clone();
        legacy["document"]["nodes"].as_array_mut().unwrap().push(json!({"id":"add-button","parentId":root,"order":3,"type":"Button","props":{"label":"Add"},"action":{"slot":"add","input":{"title":"x"}}}));
        let legacy = parse(&legacy.to_string()).unwrap();
        let mut flipped = legacy.clone();
        flipped["sources"]["events"]["mode"] = json!("query");
        let event = json!({"documentId":flipped["document"]["documentId"],"revision":flipped["document"]["revision"],"nodeId":"add-button","slot":"add","invocationId":"add","input":{"title":"x"}});
        assert_eq!(create_intent(&flipped, &event, true).unwrap_err(), "READ_ONLY_SOURCE: Query sources are read-only.");
    }
}
