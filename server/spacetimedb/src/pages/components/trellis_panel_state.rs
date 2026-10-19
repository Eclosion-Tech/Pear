//! Pure transition shared by the reducer and native conformance tests.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

pub const VERSION: &str = "pear_trellis_panel_v1";
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const BUNDLE: &str = include_str!("trellis_panel_template.json");

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub principal: String,
    pub request_id: String,
    pub fingerprint: String,
    pub revision: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Creation {
    pub principal: String,
    pub parent_id: String,
    pub request_id: String,
    pub fingerprint: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub v: String,
    pub template_id: String,
    pub template_version: String,
    pub template_hash: String,
    pub revision: u64,
    pub parameters: BTreeMap<String, String>,
    pub creation: Creation,
    pub updated_by: String,
    pub receipts: Vec<Receipt>,
}
fn invalid(message: &str) -> String {
    format!("INVALID_PAGE_PANEL: {message}")
}
fn hash(value: &Value) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(value).expect("JSON value"),
    ))
}
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn id(value: &str) -> Result<u64, String> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| invalid("Expected a decimal page/component ID"))?;
    if parsed == 0 || parsed.to_string() != value {
        return Err(invalid("Expected a positive canonical ID"));
    }
    Ok(parsed)
}
fn request(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
    {
        return Err(invalid("Expected a bounded stable request ID"));
    }
    Ok(())
}
fn bundle() -> Value {
    serde_json::from_str(BUNDLE).expect("bundled page-panel template")
}
fn validate_parameters(
    parameters: &BTreeMap<String, String>,
    complete: bool,
) -> Result<(), String> {
    let bundled = bundle();
    let properties = bundled["template"]["parameters"]["properties"]
        .as_object()
        .expect("bundled schema");
    if complete && parameters.len() != properties.len() {
        return Err(invalid("Missing panel parameters"));
    }
    for (key, value) in parameters {
        let schema = properties
            .get(key)
            .ok_or_else(|| invalid("Only declared panel parameters can change"))?;
        let length = value.encode_utf16().count() as u64;
        if length < schema["minLength"].as_u64().unwrap_or(0)
            || length > schema["maxLength"].as_u64().unwrap_or(4000)
        {
            return Err(invalid(&format!("Invalid panel parameter {key}")));
        }
    }
    Ok(())
}
fn changes(raw: &str) -> Result<BTreeMap<String, String>, String> {
    if raw.len() > 16000 {
        return Err(invalid("Panel changes exceed the size limit"));
    }
    let parsed = serde_json::from_str(raw).map_err(|e| invalid(&e.to_string()))?;
    validate_parameters(&parsed, false)?;
    Ok(parsed)
}
pub fn parse(raw: &str) -> Result<State, String> {
    if raw.len() > 128000 {
        return Err(invalid("Saved panel exceeds the size limit"));
    }
    let state: State = serde_json::from_str(raw).map_err(|e| invalid(&e.to_string()))?;
    let bundled = bundle();
    let template = &bundled["template"];
    if state.v != VERSION
        || state.template_id != template["id"]
        || state.template_version != template["version"]
        || state.template_hash != template["hash"]
    {
        return Err(invalid("Unsupported pinned template"));
    }
    validate_parameters(&state.parameters, true)?;
    if state.revision > MAX_REVISION
        || !hex64(&state.updated_by)
        || !hex64(&state.creation.principal)
        || !hex64(&state.creation.fingerprint)
    {
        return Err(invalid("Invalid revision/author"));
    }
    id(&state.creation.parent_id)?;
    request(&state.creation.request_id)?;
    if state.receipts.is_empty() || state.receipts.len() > 32 {
        return Err(invalid("Invalid receipt window"));
    }
    let mut seen = HashSet::new();
    for receipt in &state.receipts {
        request(&receipt.request_id)?;
        if !hex64(&receipt.principal)
            || !hex64(&receipt.fingerprint)
            || receipt.revision > state.revision
            || !seen.insert((&receipt.principal, &receipt.request_id))
        {
            return Err(invalid("Invalid receipt"));
        }
    }
    Ok(state)
}
pub fn creation_fingerprint(raw: &str) -> Result<String, String> {
    Ok(hash(
        &json!({"operation":"create", "parameters":changes(raw)?}),
    ))
}
pub fn create(
    parent_id: &str,
    principal: &str,
    request_id: &str,
    raw: &str,
) -> Result<String, String> {
    id(parent_id)?;
    request(request_id)?;
    if !hex64(principal) {
        return Err(invalid("Invalid principal"));
    }
    let bundled = bundle();
    let mut parameters: BTreeMap<String, String> =
        serde_json::from_value(bundled["defaults"].clone()).expect("bundled defaults");
    parameters.extend(changes(raw)?);
    validate_parameters(&parameters, true)?;
    let fingerprint = creation_fingerprint(raw)?;
    let state = State {
        v: VERSION.into(),
        template_id: bundled["template"]["id"].as_str().unwrap().into(),
        template_version: bundled["template"]["version"].as_str().unwrap().into(),
        template_hash: bundled["template"]["hash"].as_str().unwrap().into(),
        revision: 0,
        parameters,
        creation: Creation {
            principal: principal.into(),
            parent_id: parent_id.into(),
            request_id: request_id.into(),
            fingerprint: fingerprint.clone(),
        },
        updated_by: principal.into(),
        receipts: vec![Receipt {
            principal: principal.into(),
            request_id: request_id.into(),
            fingerprint,
            revision: 0,
        }],
    };
    serde_json::to_string(&state).map_err(|e| invalid(&e.to_string()))
}
/// An identical retry returns None without touching the page or repeating an action.
pub fn commit(
    current: &str,
    base_revision: u64,
    principal: &str,
    request_id: &str,
    raw: &str,
) -> Result<Option<String>, String> {
    request(request_id)?;
    if !hex64(principal) {
        return Err(invalid("Invalid principal"));
    }
    let changes = changes(raw)?;
    let fingerprint =
        hash(&json!({"operation":"update", "baseRevision":base_revision, "parameters":changes}));
    let mut state = parse(current)?;
    if let Some(receipt) = state
        .receipts
        .iter()
        .find(|r| r.principal == principal && r.request_id == request_id)
    {
        return if receipt.fingerprint == fingerprint {
            Ok(None)
        } else {
            Err("REQUEST_REUSED: request ID has different arguments".into())
        };
    }
    if state.creation.principal == principal && state.creation.request_id == request_id {
        return Err("REQUEST_REUSED: request ID was used to create this panel".into());
    }
    if base_revision != state.revision {
        return Err(format!(
            "STALE_REVISION: current revision is {}",
            state.revision
        ));
    }
    if state.revision == MAX_REVISION {
        return Err(invalid("Revision space exhausted"));
    }
    state.parameters.extend(changes);
    validate_parameters(&state.parameters, true)?;
    state.revision += 1;
    state.updated_by = principal.into();
    state.receipts.push(Receipt {
        principal: principal.into(),
        request_id: request_id.into(),
        fingerprint,
        revision: state.revision,
    });
    if state.receipts.len() > 32 {
        state.receipts.remove(0);
    }
    Ok(Some(
        serde_json::to_string(&state).map_err(|e| invalid(&e.to_string()))?,
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn principal() -> String {
        "a".repeat(64)
    }
    fn initial() -> String {
        create("10", &principal(), "create-1", "{}").unwrap()
    }
    #[test]
    fn bounded_declared_parameters_only() {
        for raw in [r#"{"other":"x"}"#, r#"{"title":""}"#, r#"{"body":false}"#] {
            assert!(create("10", &principal(), "create", raw).is_err());
        }
        assert!(create(
            "10",
            &principal(),
            "create",
            &json!({"body":"😀".repeat(2001)}).to_string()
        )
        .is_err());
    }
    #[test]
    fn both_principals_edit_and_retries_do_not_advance() {
        let saved = initial();
        let args = r#"{"title":"Revised"}"#;
        let next = commit(&saved, 0, &"b".repeat(64), "human-edit", args)
            .unwrap()
            .unwrap();
        let state = parse(&next).unwrap();
        assert_eq!(state.parameters["title"], "Revised");
        assert_eq!(state.revision, 1);
        assert!(commit(&next, 0, &"b".repeat(64), "human-edit", args)
            .unwrap()
            .is_none());
        assert!(commit(&next, 0, &principal(), "new-edit", args)
            .unwrap_err()
            .starts_with("STALE_REVISION:"));
        assert!(commit(&next, 0, &"b".repeat(64), "human-edit", "{}")
            .unwrap_err()
            .starts_with("REQUEST_REUSED:"));
    }
    #[test]
    fn no_op_is_durable_and_old_requests_remain_stale() {
        let mut raw = initial();
        for revision in 0..35 {
            raw = commit(
                &raw,
                revision,
                &principal(),
                &format!("update-{revision}"),
                "{}",
            )
            .unwrap()
            .unwrap();
        }
        assert_eq!(parse(&raw).unwrap().receipts.len(), 32);
        assert!(commit(&raw, 0, &principal(), "update-0", "{}")
            .unwrap_err()
            .starts_with("STALE_REVISION:"));
        assert!(commit(&raw, 35, &principal(), "create-1", "{}")
            .unwrap_err()
            .starts_with("REQUEST_REUSED:"));
    }
    #[test]
    fn pinned_state_cannot_be_forged() {
        let mut state: Value = serde_json::from_str(&initial()).unwrap();
        state["templateHash"] = json!("0".repeat(64));
        assert!(parse(&state.to_string()).is_err());
        assert!(id("01").is_err());
        assert!(id("18446744073709551616").is_err());
    }
}
