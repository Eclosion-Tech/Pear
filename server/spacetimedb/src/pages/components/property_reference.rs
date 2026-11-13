//! Versioned read-only Trellis binding. No resolved values or source labels are stored.
use serde_json::Value;
fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|v| v.len() == keys.len() && keys.iter().all(|k| v.contains_key(*k)))
}
fn id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.parse::<u64>()
            .is_ok_and(|id| id > 0 && id.to_string() == s)
    })
}
pub fn validate(raw: &str) -> Result<(), String> {
    let v: Value = serde_json::from_str(raw).map_err(|_| "Invalid property reference JSON")?;
    if v.as_object().is_some_and(|v| v.is_empty()) {
        return Ok(());
    }
    let b = &v["binding"];
    let target = &b["recordId"];
    if !exact(&v, &["v", "schemaId", "binding"])
        || v["v"] != 1
        || !id(&v["schemaId"])
        || !exact(b, &["source", "recordId", "field", "property", "writeBack"])
        || b["source"] != "property"
        || b["property"] != "text"
        || b["writeBack"] != false
        || !id(&b["field"])
        || !(id(target) || (exact(target, &["param"]) && target["param"] == "record"))
    {
        return Err("Invalid or unsupported property reference; expected read-only text binding with stable IDs".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn validates_self_and_explicit_without_cached_data() {
        for target in [json!({"param":"record"}), json!("123")] {
            let v = json!({"v":1,"schemaId":"9","binding":{"source":"property","recordId":target,"field":"12","property":"text","writeBack":false}});
            assert!(validate(&v.to_string()).is_ok());
            for (key, bad) in [
                ("writeBack", json!(true)),
                ("field", json!("Summary")),
                ("recordId", json!({"first":true})),
            ] {
                let mut b = v.clone();
                b["binding"][key] = bad;
                assert!(validate(&b.to_string()).is_err());
            }
            let mut cached = v.clone();
            cached["value"] = json!("private");
            assert!(validate(&cached.to_string()).is_err());
        }
        assert!(validate("{}").is_ok());
    }
}
