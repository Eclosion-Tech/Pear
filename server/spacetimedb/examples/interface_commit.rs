#[path = "../src/pages/components/trellis_interface_state.rs"]
mod state;
use serde_json::{json, Value};
use std::io::{self, BufRead};
fn run(request: Value) -> Result<Value, String> {
    let get = |key: &str| {
        request[key]
            .as_str()
            .ok_or_else(|| format!("Missing {key}"))
    };
    match get("operation")? {
        "create" => state::create(
            request["surfaceId"].as_u64().ok_or("surfaceId")?,
            request["componentId"].as_u64().ok_or("componentId")?,
            get("parentId")?,
            get("principal")?,
            get("requestId")?,
            get("intentJson")?,
        )
        .map(|saved| json!({"ok":true,"saved":saved})),
        "commit" => state::commit(
            get("existing")?,
            request["baseRevision"].as_u64().ok_or("baseRevision")?,
            get("principal")?,
            get("requestId")?,
            get("commandJson")?,
        )
        .map(|saved| json!({"ok":true,"saved":saved})),
        "parse" => state::parse(get("existing")?).map(|saved| json!({"ok":true,"state":saved})),
        _ => Err("Unknown operation".into()),
    }
}
fn main() {
    for line in io::stdin().lock().lines() {
        let result = line
            .map_err(|e| e.to_string())
            .and_then(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))
            .and_then(run);
        println!(
            "{}",
            result.unwrap_or_else(|error| json!({"ok":false,"error":error}))
        );
    }
}
