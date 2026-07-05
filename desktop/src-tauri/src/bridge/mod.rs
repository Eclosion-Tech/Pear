//! Embedded pear-bridge: services `tool_bash` in-process for the workspace
//! this desktop is connected to.
//!
//! Reuses the pear-bridge crate's transport-free core — `AllowlistEnforcer`
//! (with its non-removable baseline blocked-patterns floor), the PTY one-shot
//! executor with output/time caps + OS sandbox, and the hash-chained audit
//! log — and supplies a SpacetimeDB-HTTP `CommandSource`/`ResultSink`
//! (stdb.rs) connected AS the device's own STDB identity.
//!
//! Pairing (see commands.rs::bridge_local_pair_prepare + the web pair page's
//! desktop branch): Rust mints the device identity and device token and keeps
//! BOTH in the OS keychain — raw secrets never enter the webview; the
//! signed-in web app only ever sees the identity hex + token hash it needs to
//! call `pair_bridge_device` as the owner.
//!
//! Confirmation flow: commands matching `require_confirmation_for` (or
//! unlisted ones under the Prompt policy) are reported back as
//! `AwaitingConfirmation`; the owner Allows/Denies in the embedded Pear web
//! UI (the in-app dialog), and the confirmed re-dispatch is picked up by the
//! poller with the confirmation gate skipped — allowlist floor still applies.

pub mod stdb;

use pear_bridge::allowlist::{AllowlistConfig, AllowlistEnforcer, UnlistedPolicy};
use pear_bridge::audit::AuditLog;
use pear_bridge::daemon::{run_loop, ExecConfig};
use pear_bridge::pty::PtyLimits;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use stdb::{unwrap_option, StdbCommandSource, StdbHttp, StdbResultSink};

pub const DEVICE_TOKEN_KIND: &str = "device-token";
pub const DEVICE_STDB_TOKEN_KIND: &str = "device-stdb-token";

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    /// "stopped" | "running" | "error"
    pub status: String,
    pub message: String,
    pub workspace_key: Option<String>,
    /// Enforcer warnings (bad server regexes etc.) surfaced to the UI.
    pub warnings: Vec<String>,
}

pub struct LocalBridge {
    status: Mutex<BridgeStatus>,
    stop_tx: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    /// Kept for the shutdown call (close sessions by token hash).
    shutdown_ctx: Mutex<Option<(Arc<StdbHttp>, String)>>,
    audit_path: std::path::PathBuf,
}

pub fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

impl LocalBridge {
    pub fn new(app_data_dir: &std::path::Path) -> Self {
        Self {
            status: Mutex::new(BridgeStatus {
                status: "stopped".into(),
                message: "not running".into(),
                ..Default::default()
            }),
            stop_tx: Mutex::new(None),
            shutdown_ctx: Mutex::new(None),
            audit_path: app_data_dir.join("bridge/audit.log"),
        }
    }

    pub fn status(&self) -> BridgeStatus {
        self.status.lock().unwrap().clone()
    }

    fn set_status(&self, status: &str, message: impl Into<String>, warnings: Vec<String>) {
        let mut s = self.status.lock().unwrap();
        s.status = status.into();
        s.message = message.into();
        s.warnings = warnings;
    }

    /// Start servicing tool_bash for `workspace_key`. Loads the device secrets
    /// from the keychain (paired earlier), opens a bridge session, fetches the
    /// device's allowlist (device-scoped RLS), and runs the poll→execute loop
    /// until `stop`.
    pub async fn start(
        self: &Arc<Self>,
        workspace_key: &str,
        spacetimedb_uri: &str,
        db_name: &str,
    ) -> Result<BridgeStatus, String> {
        if self.stop_tx.lock().unwrap().is_some() {
            return Ok(self.status());
        }

        let device_token =
            crate::keychain::get_bridge_secret(workspace_key, DEVICE_TOKEN_KIND)
                .map_err(|_| "this workspace has no paired desktop bridge — pair it first")?;
        let stdb_token =
            crate::keychain::get_bridge_secret(workspace_key, DEVICE_STDB_TOKEN_KIND)?;

        let http = Arc::new(StdbHttp::new(spacetimedb_uri, db_name, &stdb_token));
        let device_token_hash = sha256_hex(&device_token);

        // Open a session (enqueue_bridge_command requires one connected).
        // Local "tunnel token" is synthetic — nothing dials in; give it a
        // week-long expiry and refresh implicitly by restart.
        let tunnel_hash = sha256_hex(&uuid::Uuid::new_v4().to_string());
        let expires_micros: i64 = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as i64)
            + 7 * 24 * 3600 * 1_000_000;
        http.call(
            "open_bridge_session",
            serde_json::json!([
                device_token_hash,
                tunnel_hash,
                expires_micros,
                "embedded-desktop"
            ]),
        )
        .await?;

        // Fetch this device's allowlist (visible via the device-identity RLS
        // filter added for the embed).
        let (enforcer, limits, warnings) = fetch_enforcer(&http).await?;

        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        *self.stop_tx.lock().unwrap() = Some(stop_tx);
        *self.shutdown_ctx.lock().unwrap() = Some((http.clone(), device_token_hash));

        let exec = ExecConfig {
            shell: std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()),
            limits,
            server_url: stdb::http_base(spacetimedb_uri),
        };
        let mut audit = AuditLog::open(&self.audit_path)
            .map_err(|e| format!("audit log open ({}): {e}", self.audit_path.display()))?;

        self.set_status(
            "running",
            format!("servicing tool_bash for {db_name}"),
            warnings.clone(),
        );
        {
            let mut s = self.status.lock().unwrap();
            s.workspace_key = Some(workspace_key.to_string());
        }

        let this = Arc::clone(self);
        let source = StdbCommandSource::new(http.clone(), stop_rx);
        let sink = StdbResultSink { http };
        tauri::async_runtime::spawn(async move {
            let result = run_loop(source, sink, &enforcer, &exec, &mut audit).await;
            if let Err(e) = &result {
                eprintln!("[bridge] loop ended with error: {e}");
                this.set_status("error", e.clone(), Vec::new());
            } else {
                this.set_status("stopped", "stopped", Vec::new());
            }
            *this.stop_tx.lock().unwrap() = None;
        });

        Ok(self.status())
    }

    /// Signal the loop to stop and close this device's open sessions.
    pub async fn stop(&self) {
        if let Some(tx) = self.stop_tx.lock().unwrap().take() {
            let _ = tx.send(true);
        }
        let ctx = self.shutdown_ctx.lock().unwrap().take();
        if let Some((http, token_hash)) = ctx {
            let _ = http
                .call(
                    "close_bridge_device_sessions",
                    serde_json::json!([token_hash]),
                )
                .await;
        }
        self.set_status("stopped", "stopped", Vec::new());
    }
}

/// Read the device's allowlist row and build the enforcer + PTY limits.
async fn fetch_enforcer(
    http: &StdbHttp,
) -> Result<(AllowlistEnforcer, PtyLimits, Vec<String>), String> {
    let (cols, rows) = http
        .sql(
            "SELECT allowed_commands, blocked_patterns, allowed_directories, \
             require_confirmation_for, max_output_bytes, max_runtime_seconds, \
             unlisted_command_policy FROM bridge_device_allowlist",
        )
        .await?;
    let row = rows
        .first()
        .ok_or("no allowlist visible for this device — was it paired with this identity?")?;
    let col = |name: &str| {
        cols.iter()
            .position(|c| c == name)
            .ok_or_else(|| format!("allowlist column {name} missing"))
    };
    let strings = |v: &serde_json::Value| -> Vec<String> {
        v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    // UnlistedCommandPolicy variant order: Prompt = 0, Reject = 1.
    let policy_raw = &row[col("unlisted_command_policy")?];
    let policy_idx = match policy_raw {
        serde_json::Value::Array(a) => a.first().and_then(|i| i.as_u64()).unwrap_or(0),
        serde_json::Value::Number(n) => n.as_u64().unwrap_or(0),
        _ => 0,
    };
    let config = AllowlistConfig {
        unlisted_policy: if policy_idx == 1 {
            UnlistedPolicy::Reject
        } else {
            UnlistedPolicy::Prompt
        },
        allowed_commands: strings(&row[col("allowed_commands")?]),
        blocked_patterns: strings(&row[col("blocked_patterns")?]),
        allowed_directories: strings(&row[col("allowed_directories")?]),
        require_confirmation_for: strings(&row[col("require_confirmation_for")?]),
    };
    let max_output = unwrap_option(&row[col("max_output_bytes")?])
        .and_then(|v| v.as_u64())
        .unwrap_or(65536);
    let max_runtime = unwrap_option(&row[col("max_runtime_seconds")?])
        .and_then(|v| v.as_u64())
        .unwrap_or(120);
    let enforcer = AllowlistEnforcer::new(config);
    let warnings = enforcer.warnings.clone();
    Ok((
        enforcer,
        PtyLimits {
            max_output_bytes: max_output as usize,
            max_runtime: std::time::Duration::from_secs(max_runtime),
        },
        warnings,
    ))
}
