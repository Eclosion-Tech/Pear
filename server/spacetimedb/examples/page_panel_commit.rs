//! The production page-panel transition, executable without a database.
#[path = "../src/pages/components/trellis_panel_state.rs"]
mod state;
use serde_json::{json, Value};
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let output = (|| -> Result<Value, String> {
            let value: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let string = |key: &str| value[key].as_str().ok_or_else(|| format!("{key} required"));
            let saved = if value["operation"] == "create" {
                Some(state::create(
                    string("parentId")?,
                    string("principal")?,
                    string("requestId")?,
                    string("parametersJson")?,
                )?)
            } else {
                state::commit(
                    string("existing")?,
                    value["baseRevision"]
                        .as_u64()
                        .ok_or("baseRevision required")?,
                    string("principal")?,
                    string("requestId")?,
                    string("parametersJson")?,
                )?
            };
            Ok(json!({"ok":true,"saved":saved}))
        })();
        println!(
            "{}",
            output.unwrap_or_else(|error| json!({"ok":false,"error":error}))
        );
    }
}
