//! Conformance harness: the same pure transition called by the real reducer.
//! Reads JSON lines from stdin and emits JSON results. No database or network.
#[path = "../src/conversations/trellis_state.rs"]
mod state;
use serde_json::{json, Value};
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let output = (|| -> Result<Value, String> {
            let value: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let message_id = value["messageId"]
                .as_str()
                .ok_or("messageId required")?
                .parse::<u64>()
                .map_err(|e| e.to_string())?;
            let base = value["baseRevision"].as_u64();
            let saved = state::commit(
                value["existing"].as_str(),
                message_id,
                base,
                value["requestId"].as_str().ok_or("requestId required")?,
                value["intentJson"].as_str().ok_or("intentJson required")?,
                value["payloadJson"]
                    .as_str()
                    .ok_or("payloadJson required")?,
            )?;
            Ok(json!({"ok":true,"saved":saved}))
        })();
        println!(
            "{}",
            output.unwrap_or_else(|error| json!({"ok":false,"error":error}))
        );
    }
}
