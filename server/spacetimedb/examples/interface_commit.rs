#[path = "../src/pages/components/trellis_interface_state.rs"]
mod state;
use state as interface_state;
#[path = "../src/pages/components/authored_component_state.rs"]
mod authored_state;
#[path = "../src/pages/components/component_repository_state.rs"]
mod repository_state;
use serde_json::{json, Value};
use std::io::{self, BufRead};
fn run(request: Value) -> Result<Value, String> {
    let registry = request
        .get("registry")
        .cloned()
        .unwrap_or_else(state::registry);
    let get = |key: &str| {
        request[key]
            .as_str()
            .ok_or_else(|| format!("Missing {key}"))
    };
    match get("operation")? {
        "create-component" => authored_state::create(request["surfaceId"].as_u64().ok_or("surfaceId")?, request["componentId"].as_u64().ok_or("componentId")?, get("parentId")?, get("principal")?, get("requestId")?, get("title")?).map(|saved|json!({"ok":true,"saved":saved})),
        "export-authored-template" => authored_state::prepare_template(get("existing")?,get("optionsJson")?).map(|package|json!({"ok":true,"hash":authored_state::package_hash(&package).unwrap(),"package":package})),
        "validate-authored-package" => authored_state::validate_package(get("packageJson")?,Some(get("hash")?)).map(|package|json!({"ok":true,"package":package})),
        "instantiate-component" => authored_state::instantiate(request["surfaceId"].as_u64().ok_or("surfaceId")?,request["componentId"].as_u64().ok_or("componentId")?,get("parentId")?,get("principal")?,get("requestId")?,get("packageJson")?,get("hash")?).map(|saved|json!({"ok":true,"saved":saved})),
        "package-hash" => authored_state::package_hash(&request["value"]).map(|hash|json!({"ok":true,"hash":hash})),
        "authorize-write" => authored_state::authorize_write(&authored_state::parse(get("existing")?)?,&request["write"]).map(|_|json!({"ok":true})),
        "create-intent" => authored_state::create_intent(&authored_state::parse(get("existing")?)?,&request["event"],false).map(|(source,values)|json!({"ok":true,"source":source,"values":values})),
        "parse-component" => authored_state::parse(get("existing")?).map(|saved|json!({"ok":true,"state":saved})),
        "commit-component" => authored_state::commit(get("existing")?, request["baseRevision"].as_u64().ok_or("baseRevision")?, get("principal")?, get("requestId")?, get("commandJson")?).map(|saved|json!({"ok":true,"saved":saved})),
        "export-template" => repository_state::prepare(get("existing")?, &request.get("registry").cloned().unwrap_or_else(state::registry), get("optionsJson")?).map(|package| json!({"ok":true,"package":package})),
        "validate-package" => repository_state::validate_package(get("packageJson")?,get("hash")?).map(|package|json!({"ok":true,"package":package})),
        "create" => state::create_with_registry(
            request["surfaceId"].as_u64().ok_or("surfaceId")?,
            request["componentId"].as_u64().ok_or("componentId")?,
            get("parentId")?,
            get("principal")?,
            get("requestId")?,
            get("intentJson")?,
            &registry,
        )
        .map(|saved| json!({"ok":true,"saved":saved})),
        "commit" => state::commit_with_registry(
            get("existing")?,
            request["baseRevision"].as_u64().ok_or("baseRevision")?,
            get("principal")?,
            get("requestId")?,
            get("commandJson")?,
            &registry,
        )
        .map(|saved| json!({"ok":true,"saved":saved})),
        "parse" => state::parse_with_registry(get("existing")?, &registry).map(|saved| json!({"ok":true,"state":saved})),
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
