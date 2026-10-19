//! A bounded, host-owned commit path for bundled Trellis template instances.
//! No row/schema changes: the saved envelope travels with the existing message.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const VERSION: &str = "pear_trellis_ui_v1";
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const TEMPLATES: &str = include_str!("trellis_templates.json");

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    request_id: String,
    intent_hash: String,
    payload_hash: String,
    revision: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    v: String,
    document: Value,
    bindings: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    v: String,
    document: Value,
    bindings: Value,
    receipts: Vec<Receipt>,
}

pub(super) fn is_saved_ui(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v["v"].as_str().map(|s| s.starts_with("pear_trellis_ui_")))
        .unwrap_or(false)
}
fn hash(raw: &str) -> String {
    hex::encode(Sha256::digest(raw.as_bytes()))
}
fn bounded_parse<T: serde::de::DeserializeOwned>(raw: &str, limit: usize) -> Result<T, String> {
    if raw.len() > limit {
        return Err("UI_LIMIT: interface request exceeds its size limit".into());
    }
    serde_json::from_str(raw).map_err(|e| format!("INVALID_UI: {e}"))
}
fn parameterize(value: &Value, parameters: &Value) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| parameterize(v, parameters)).collect())
        }
        Value::Object(map) if map.len() == 1 && map.contains_key("$param") => {
            parameters[map["$param"].as_str().unwrap_or("")].clone()
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), parameterize(v, parameters)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
fn expected_document(
    message_id: u64,
    revision: u64,
    template: &Value,
    parameters: &Value,
) -> Result<Value, String> {
    let props = template["parameters"]["properties"]
        .as_object()
        .ok_or("INVALID_UI: invalid bundled schema")?;
    let params = parameters
        .as_object()
        .ok_or("INVALID_UI: parameters must be an object")?;
    if params.len() != props.len() || params.keys().any(|k| !props.contains_key(k)) {
        return Err("INVALID_UI: unexpected parameters".into());
    }
    for (name, schema) in props {
        let value = params[name]
            .as_str()
            .ok_or("INVALID_UI: expected string parameter")?;
        let length = value.encode_utf16().count() as u64;
        if length < schema["minLength"].as_u64().unwrap_or(0)
            || length > schema["maxLength"].as_u64().unwrap_or(4000)
        {
            return Err(format!("INVALID_UI: invalid parameter {name}"));
        }
    }
    let instance = format!("pear-ui:{message_id}");
    let raw_nodes = template["nodes"]
        .as_array()
        .ok_or("INVALID_UI: invalid bundled nodes")?;
    let mapping: serde_json::Map<String, Value> = raw_nodes
        .iter()
        .map(|n| {
            let id = n["id"].as_str().unwrap_or("");
            (id.to_string(), json!(format!("{instance}:{id}")))
        })
        .collect();
    let mut nodes = Vec::new();
    for raw in raw_nodes {
        let mut node = parameterize(raw, parameters);
        node["id"] = mapping[raw["id"].as_str().unwrap_or("")].clone();
        node["parentId"] = if raw["parentId"].is_null() {
            Value::Null
        } else {
            mapping[raw["parentId"].as_str().unwrap_or("")].clone()
        };
        if node.get("action").is_some() {
            node["action"]["slot"] = json!("pear.manual-automation");
        }
        nodes.push(node);
    }
    let actions = if template["actionSlots"]
        .as_array()
        .is_some_and(|s| !s.is_empty())
    {
        json!({"submit":"pear.manual-automation"})
    } else {
        json!({})
    };
    Ok(
        json!({"protocol":"trellis_ui_v1", "documentId":format!("pear-message:{message_id}"), "revision":revision,
        "catalogVersion":template["catalogVersion"], "rootId":mapping[template["rootId"].as_str().unwrap_or("")], "nodes":nodes, "retiredIds":[],
        "template":{"id":template["id"], "version":template["version"], "hash":template["hash"], "instanceId":instance,
            "parameters":parameters, "mapping":mapping, "actionBindings":actions, "state":"linked"}}),
    )
}
fn validate_binding(bindings: &Value, has_action: bool) -> Result<(), String> {
    let map = bindings
        .as_object()
        .ok_or("INVALID_UI: bindings must be an object")?;
    if !has_action {
        return if map.is_empty() {
            Ok(())
        } else {
            Err("INVALID_UI: template has no action slot".into())
        };
    }
    if map.len() != 1 || !map.contains_key("submit") {
        return Err("INVALID_UI: missing submit binding".into());
    }
    let action = map["submit"]
        .as_object()
        .ok_or("INVALID_UI: invalid action")?;
    if action
        .keys()
        .any(|k| !["automationId", "input", "confirmation"].contains(&k.as_str()))
    {
        return Err("INVALID_UI: unexpected action field".into());
    }
    let id = action
        .get("automationId")
        .and_then(Value::as_str)
        .ok_or("INVALID_UI: missing automation ID")?;
    if id.starts_with('0')
        || !id.bytes().all(|b| b.is_ascii_digit())
        || id.parse::<u64>().ok().filter(|v| *v > 0).is_none()
    {
        return Err("INVALID_UI: invalid automation ID".into());
    }
    if let Some(confirmation) = action.get("confirmation") {
        let text = confirmation
            .as_str()
            .ok_or("INVALID_UI: invalid confirmation")?;
        if text.trim().is_empty() || text.encode_utf16().count() > 500 {
            return Err("INVALID_UI: invalid confirmation".into());
        }
    }
    let input = action
        .get("input")
        .and_then(Value::as_object)
        .ok_or("INVALID_UI: expected input mappings")?;
    if input.len() > 32 {
        return Err("UI_LIMIT: too many input mappings".into());
    }
    for (key, value) in input {
        if key.is_empty()
            || key.len() > 64
            || !key.as_bytes()[0].is_ascii_alphabetic()
            || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            || ["constructor", "prototype", "__proto__"].contains(&key.as_str())
        {
            return Err("INVALID_UI: invalid input name".into());
        }
        match value {
            Value::String(s)
                if s.encode_utf16().count() <= 4000
                    && (!s.starts_with("$form.") || s == "$form.value") => {}
            Value::Number(_) | Value::Bool(_) | Value::Null => {}
            _ => return Err("INVALID_UI: invalid scalar or form binding".into()),
        }
    }
    Ok(())
}
fn validate_payload(payload: &Payload, message_id: u64) -> Result<u64, String> {
    if payload.v != VERSION {
        return Err("INVALID_UI: unsupported envelope version".into());
    }
    let revision = payload.document["revision"]
        .as_u64()
        .filter(|r| *r <= MAX_REVISION)
        .ok_or("INVALID_UI: invalid revision")?;
    let origin = &payload.document["template"];
    let definitions: Vec<Value> = serde_json::from_str(TEMPLATES).map_err(|e| e.to_string())?;
    let template = definitions
        .iter()
        .find(|t| t["id"] == origin["id"] && t["version"] == origin["version"])
        .ok_or("INVALID_UI: template version is not bundled")?;
    let expected = expected_document(message_id, revision, template, &origin["parameters"])?;
    if payload.document != expected {
        return Err("INVALID_UI: document differs from its pinned template".into());
    }
    validate_binding(
        &payload.bindings,
        !template["actionSlots"]
            .as_array()
            .ok_or("INVALID_UI: invalid bundled actions")?
            .is_empty(),
    )?;
    Ok(revision)
}

/// Pure transition used by the transactional reducer and conformance tests.
pub(super) fn commit(
    existing: Option<&str>,
    message_id: u64,
    base_revision: Option<u64>,
    request_id: &str,
    intent_json: &str,
    payload_json: &str,
) -> Result<Option<String>, String> {
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id.as_bytes()[0].is_ascii_alphanumeric()
        || !request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
    {
        return Err("INVALID_UI: invalid request ID".into());
    }
    let _: Value = bounded_parse(intent_json, 16000)?;
    let payload: Payload = bounded_parse(payload_json, 128000)?;
    let revision = validate_payload(&payload, message_id)?;
    let mut receipts = Vec::new();
    if let Some(raw) = existing {
        let current: Saved = bounded_parse(raw, 160000)
            .map_err(|_| "UI_OCCUPIED: message already contains another interface")?;
        if current.v != VERSION {
            return Err("UI_OCCUPIED: message already contains another interface".into());
        }
        let intent_hash = hash(intent_json);
        let payload_hash = hash(payload_json);
        if let Some(receipt) = current.receipts.iter().find(|r| r.request_id == request_id) {
            return if receipt.intent_hash == intent_hash && receipt.payload_hash == payload_hash {
                Ok(None)
            } else {
                Err("REQUEST_REUSED: request ID has different content".into())
            };
        }
        let old_revision = current.document["revision"]
            .as_u64()
            .ok_or("INVALID_UI: invalid saved revision")?;
        if base_revision != Some(old_revision) || revision != old_revision + 1 {
            return Err(format!(
                "STALE_REVISION: current revision is {old_revision}"
            ));
        }
        if current.document["template"]["id"] != payload.document["template"]["id"]
            || current.document["template"]["version"] != payload.document["template"]["version"]
            || current.document["template"]["hash"] != payload.document["template"]["hash"]
            || current.bindings != payload.bindings
        {
            return Err("TEMPLATE_PINNED: template and action bindings cannot change in an active interface".into());
        }
        receipts = current.receipts;
    } else if base_revision.is_some() || revision != 0 {
        return Err("STALE_REVISION: interface does not exist".into());
    }
    receipts.push(Receipt {
        request_id: request_id.into(),
        intent_hash: hash(intent_json),
        payload_hash: hash(payload_json),
        revision,
    });
    if receipts.len() > 32 {
        receipts.drain(..receipts.len() - 32);
    }
    serde_json::to_string(&Saved {
        v: payload.v,
        document: payload.document,
        bindings: payload.bindings,
        receipts,
    })
    .map(Some)
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../tests/trellis-fixtures.json")).unwrap()
    }
    fn create() -> String {
        commit(
            None,
            123,
            None,
            "create-1",
            "{}",
            &fixture()["create"].to_string(),
        )
        .unwrap()
        .unwrap()
    }
    #[test]
    fn typescript_document_roundtrips_and_duplicate_commit_does_not_advance() {
        let raw = create();
        let saved: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(saved["document"], fixture()["create"]["document"]);
        assert!(commit(
            Some(&raw),
            123,
            None,
            "create-1",
            "{}",
            &fixture()["create"].to_string()
        )
        .unwrap()
        .is_none());
    }
    #[test]
    fn stale_updates_and_changed_retries_are_rejected_atomically() {
        let raw = create();
        let updated = fixture()["update"].to_string();
        assert!(commit(Some(&raw), 123, Some(1), "update-1", "{}", &updated)
            .unwrap_err()
            .contains("STALE_REVISION"));
        assert!(commit(Some(&raw), 123, Some(0), "create-1", "{}", &updated)
            .unwrap_err()
            .contains("REQUEST_REUSED"));
        let saved = commit(Some(&raw), 123, Some(0), "update-1", "{}", &updated)
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&saved).unwrap()["document"]["revision"],
            1
        );
    }
    #[test]
    fn forged_structure_actions_and_document_identity_are_rejected() {
        for path in ["node", "action", "identity", "provenance"] {
            let mut payload = fixture()["create"].clone();
            match path {
                "node" => payload["document"]["nodes"][1]["text"][0]["text"] = json!("forged"),
                "action" => {
                    payload["document"]["nodes"][4]["action"]["slot"] = json!("other-action")
                }
                "identity" => payload["document"]["documentId"] = json!("pear-message:999"),
                _ => payload["document"]["template"]["hash"] = json!("0".repeat(64)),
            }
            assert!(
                commit(None, 123, None, "create-1", "{}", &payload.to_string()).is_err(),
                "{path}"
            );
        }
    }
    #[test]
    fn bindings_are_immutable_and_legacy_panels_cannot_be_overwritten() {
        let raw = create();
        let mut payload = fixture()["update"].clone();
        payload["bindings"]["submit"]["automationId"] = json!("18");
        assert!(commit(
            Some(&raw),
            123,
            Some(0),
            "update-1",
            "{}",
            &payload.to_string()
        )
        .unwrap_err()
        .contains("TEMPLATE_PINNED"));
        assert!(commit(
            Some("{\"v\":\"component_tree_v1\"}"),
            123,
            None,
            "create-1",
            "{}",
            &fixture()["create"].to_string()
        )
        .unwrap_err()
        .contains("UI_OCCUPIED"));
    }
    #[test]
    fn invalid_fields_and_oversized_requests_are_rejected() {
        let mut payload = fixture()["create"].clone();
        payload["bindings"]["submit"]["input"]["value"] = json!("$form.secret");
        assert!(commit(None, 123, None, "create-1", "{}", &payload.to_string()).is_err());
        assert!(commit(
            None,
            123,
            None,
            "create-1",
            &" ".repeat(16001),
            &fixture()["create"].to_string()
        )
        .is_err());
    }
}
