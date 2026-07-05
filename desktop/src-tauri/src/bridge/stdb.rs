//! SpacetimeDB HTTP transport for the embedded bridge: a `CommandSource`
//! that polls `bridge_command` and a `ResultSink` that calls the lifecycle
//! reducers — both AS THE DEVICE's own STDB identity, so RLS
//! (`BRIDGE_COMMAND_DEVICE_FILTER`) scopes reads to this device and the
//! `require_executing_device` gate accepts the writes.
//!
//! HTTP polling (not the Rust SDK WebSocket) is deliberate: multi-filter RLS
//! is known to drop incremental WS updates (see project notes on the worker's
//! bridge-sql fix), and polling keeps this crate free of STDB SDK coupling —
//! same rationale as the worker's `bridge-sql.ts`.
//!
//! Wire shapes match `web/src/lib/mcp/encode.ts` / `worker/src/bridge-sql.ts`:
//! reducer args are a positional JSON array (u64 = number, Option =
//! {"some":v}/{"none":[]}); `/sql` enum columns come back as
//! `[variantIndex, payload]`, Options as `[0,v]`/`[1,[]]` (or keyed objects).

use pear_bridge::daemon::{CommandSource, IncomingCommand, Outcome, ResultSink};
use std::collections::HashMap;
use std::time::Duration;

pub const POLL_INTERVAL: Duration = Duration::from_millis(1000);

/// `BridgeCommandStatus` variant order — MUST match the module enum.
const STATUS_TAGS: [&str; 7] = [
    "Pending",
    "AwaitingConfirmation",
    "Running",
    "Completed",
    "Failed",
    "Rejected",
    "TimedOut",
];

pub struct StdbHttp {
    base: String,
    db: String,
    token: String,
    client: reqwest::Client,
}

impl StdbHttp {
    pub fn new(ws_or_http_uri: &str, db: &str, token: &str) -> Self {
        Self {
            base: http_base(ws_or_http_uri),
            db: db.to_string(),
            token: token.to_string(),
            client: reqwest::Client::new(),
        }
    }

    /// One `/sql` query → (column names, row value-arrays).
    pub async fn sql(
        &self,
        query: &str,
    ) -> Result<(Vec<String>, Vec<Vec<serde_json::Value>>), String> {
        let res = self
            .client
            .post(format!("{}/v1/database/{}/sql", self.base, self.db))
            .bearer_auth(&self.token)
            .header("Content-Type", "text/plain")
            .body(query.to_string())
            .send()
            .await
            .map_err(|e| format!("stdb /sql: {e}"))?;
        let status = res.status();
        let text = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("stdb /sql {status}: {}", &text[..text.len().min(200)]));
        }
        let parsed: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("stdb /sql parse: {e}"))?;
        let result = parsed
            .get(0)
            .ok_or("stdb /sql: empty result set")?;
        let columns = result
            .pointer("/schema/elements")
            .and_then(|v| v.as_array())
            .map(|els| {
                els.iter()
                    .map(|el| {
                        el.pointer("/name/some")
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string()
                    })
                    .collect()
            })
            .unwrap_or_default();
        let rows = result
            .get("rows")
            .and_then(|v| v.as_array())
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| r.as_array().cloned())
                    .collect()
            })
            .unwrap_or_default();
        Ok((columns, rows))
    }

    /// Call a reducer with positional SATS-JSON args. Reducer failures are
    /// synchronous non-2xx with the `Err(String)` text as the body.
    pub async fn call(&self, reducer: &str, args: serde_json::Value) -> Result<(), String> {
        let res = self
            .client
            .post(format!(
                "{}/v1/database/{}/call/{}",
                self.base, self.db, reducer
            ))
            .bearer_auth(&self.token)
            .json(&args)
            .send()
            .await
            .map_err(|e| format!("stdb /call/{reducer}: {e}"))?;
        let status = res.status();
        if status.is_success() {
            return Ok(());
        }
        let text = res.text().await.unwrap_or_default();
        Err(format!(
            "{reducer} failed ({status}): {}",
            &text[..text.len().min(300)]
        ))
    }
}

pub fn http_base(uri: &str) -> String {
    let t = uri.trim().trim_end_matches('/');
    if let Some(rest) = t.strip_prefix("wss://") {
        return format!("https://{rest}");
    }
    if let Some(rest) = t.strip_prefix("ws://") {
        return format!("http://{rest}");
    }
    if t.starts_with("http://") || t.starts_with("https://") {
        return t.to_string();
    }
    format!("http://{t}")
}

// ── SQL value decoding ─────────────────────────────────────────────────────

/// Option column → the inner value, or None. Accepts `[0,v]` / `{"some":v}`
/// (Some) and `[1,[]]` / `{"none":[]}` / null (None); bare scalars pass through.
pub fn unwrap_option(v: &serde_json::Value) -> Option<serde_json::Value> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::Array(a) => match a.first().and_then(|i| i.as_u64()) {
            Some(0) => a.get(1).cloned(),
            Some(1) => None,
            _ => Some(v.clone()),
        },
        serde_json::Value::Object(o) => {
            if let Some(inner) = o.get("some") {
                Some(inner.clone())
            } else if o.contains_key("none") {
                None
            } else {
                Some(v.clone())
            }
        }
        other => Some(other.clone()),
    }
}

/// Enum column → variant tag name via `STATUS_TAGS`.
pub fn status_tag(v: &serde_json::Value) -> &'static str {
    let idx = match v {
        serde_json::Value::Array(a) => a.first().and_then(|i| i.as_u64()),
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::Object(o) => o
            .keys()
            .next()
            .and_then(|k| STATUS_TAGS.iter().position(|t| t.eq_ignore_ascii_case(k)))
            .map(|i| i as u64),
        _ => None,
    };
    idx.and_then(|i| STATUS_TAGS.get(i as usize))
        .copied()
        .unwrap_or("Pending")
}

fn as_u64(v: &serde_json::Value) -> u64 {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0)
}

fn as_string(v: &serde_json::Value) -> String {
    v.as_str()
        .map(String::from)
        .unwrap_or_else(|| v.to_string())
}

// ── CommandSource ──────────────────────────────────────────────────────────

/// Polls `bridge_command` (RLS-scoped to this device) and yields commands to
/// run. Delivery bookkeeping: a command is delivered once unconfirmed; if it
/// later returns to `Pending` with `confirmed_at` set (human pressed Allow),
/// it is delivered again with `confirmed = true`.
pub struct StdbCommandSource {
    pub http: std::sync::Arc<StdbHttp>,
    /// command id → was it last delivered as confirmed?
    delivered: HashMap<u64, bool>,
    queue: std::collections::VecDeque<IncomingCommand>,
    stop: tokio::sync::watch::Receiver<bool>,
    /// Set once at startup: ids that already have terminal status are skipped,
    /// but genuinely Pending backlog IS picked up (offline queueing).
    primed: bool,
}

impl StdbCommandSource {
    pub fn new(http: std::sync::Arc<StdbHttp>, stop: tokio::sync::watch::Receiver<bool>) -> Self {
        Self {
            http,
            delivered: HashMap::new(),
            queue: std::collections::VecDeque::new(),
            stop,
            primed: false,
        }
    }

    async fn poll_once(&mut self) -> Result<(), String> {
        let (cols, rows) = self
            .http
            .sql(
                "SELECT id, device_id, session_id, conversation_id, requested_by, command, \
                 cwd, status, confirmed_at FROM bridge_command",
            )
            .await?;
        let col = |name: &str| cols.iter().position(|c| c == name);
        let (Some(c_id), Some(c_dev), Some(c_sess), Some(c_conv), Some(c_req), Some(c_cmd), Some(c_cwd), Some(c_status), Some(c_conf)) = (
            col("id"),
            col("device_id"),
            col("session_id"),
            col("conversation_id"),
            col("requested_by"),
            col("command"),
            col("cwd"),
            col("status"),
            col("confirmed_at"),
        ) else {
            return Err(format!("bridge_command columns missing in {cols:?}"));
        };

        for row in rows {
            let id = as_u64(&row[c_id]);
            let status = status_tag(&row[c_status]);
            if status != "Pending" {
                // Terminal or awaiting-confirmation rows are never (re)run. Mark
                // terminal ones as handled so a later poll can't resurrect them.
                if status != "AwaitingConfirmation" {
                    self.delivered.insert(id, true);
                }
                continue;
            }
            let confirmed = unwrap_option(&row[c_conf]).is_some();
            match self.delivered.get(&id) {
                None => {}
                Some(false) if confirmed => {} // re-deliver post-confirmation
                Some(_) => continue,           // already delivered at this level
            }
            self.delivered.insert(id, confirmed);
            self.queue.push_back(IncomingCommand {
                command_id: id,
                device_id: as_u64(&row[c_dev]),
                session_id: as_u64(&row[c_sess]),
                conversation_id: as_u64(&row[c_conv]),
                requested_by: as_string(&row[c_req]),
                command: as_string(&row[c_cmd]),
                cwd: unwrap_option(&row[c_cwd]).map(|v| as_string(&v)),
                confirmed,
            });
        }
        self.primed = true;
        Ok(())
    }
}

impl CommandSource for StdbCommandSource {
    async fn next_command(&mut self) -> Option<IncomingCommand> {
        loop {
            if let Some(cmd) = self.queue.pop_front() {
                return Some(cmd);
            }
            if *self.stop.borrow() {
                return None;
            }
            if let Err(e) = self.poll_once().await {
                eprintln!("[bridge] poll: {e}");
            }
            let mut stop = self.stop.clone();
            tokio::select! {
                _ = tokio::time::sleep(POLL_INTERVAL) => {}
                _ = stop.changed() => {}
            }
        }
    }
}

// ── ResultSink ─────────────────────────────────────────────────────────────

pub struct StdbResultSink {
    pub http: std::sync::Arc<StdbHttp>,
}

impl ResultSink for StdbResultSink {
    async fn send_outcome(&mut self, command_id: u64, outcome: Outcome) -> Result<(), String> {
        match outcome {
            Outcome::Completed {
                exit_code,
                stdout,
                stderr,
                duration_ms,
            } => {
                let exit = match exit_code {
                    Some(c) => serde_json::json!({ "some": c }),
                    None => serde_json::json!({ "none": [] }),
                };
                self.http
                    .call(
                        "complete_bridge_command",
                        serde_json::json!([command_id, exit, stdout, stderr, duration_ms]),
                    )
                    .await
            }
            Outcome::Rejected { reason } => {
                self.http
                    .call(
                        "reject_bridge_command",
                        serde_json::json!([command_id, reason]),
                    )
                    .await
            }
            Outcome::AwaitingConfirmation { .. } => {
                self.http
                    .call(
                        "await_bridge_command_confirmation",
                        serde_json::json!([command_id]),
                    )
                    .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwraps_option_wire_shapes() {
        assert_eq!(
            unwrap_option(&serde_json::json!([0, "v"])),
            Some(serde_json::json!("v"))
        );
        assert_eq!(unwrap_option(&serde_json::json!([1, []])), None);
        assert_eq!(
            unwrap_option(&serde_json::json!({ "some": 5 })),
            Some(serde_json::json!(5))
        );
        assert_eq!(unwrap_option(&serde_json::json!({ "none": [] })), None);
        assert_eq!(unwrap_option(&serde_json::Value::Null), None);
        assert_eq!(
            unwrap_option(&serde_json::json!("bare")),
            Some(serde_json::json!("bare"))
        );
    }

    #[test]
    fn decodes_status_variants() {
        assert_eq!(status_tag(&serde_json::json!([0, []])), "Pending");
        assert_eq!(status_tag(&serde_json::json!([1, []])), "AwaitingConfirmation");
        assert_eq!(status_tag(&serde_json::json!([5, []])), "Rejected");
        assert_eq!(status_tag(&serde_json::json!({ "pending": [] })), "Pending");
    }

    #[test]
    fn normalizes_http_base() {
        assert_eq!(http_base("ws://localhost:3100"), "http://localhost:3100");
        assert_eq!(http_base("wss://spacetime.example.com/"), "https://spacetime.example.com");
        assert_eq!(http_base("http://127.0.0.1:3100"), "http://127.0.0.1:3100");
        assert_eq!(http_base("host:3000"), "http://host:3000");
    }
}
