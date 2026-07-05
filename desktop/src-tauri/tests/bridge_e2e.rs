//! Live E2E for the embedded bridge (M5 milestone verification). Ignored by
//! default — needs a running SpacetimeDB with the pear module published and
//! an operator token:
//!
//!   PEAR_E2E_URI=http://127.0.0.1:3100 PEAR_E2E_DB=pear-dev \
//!   PEAR_E2E_ADMIN_TOKEN=$(spacetime login show --token | tail -1 | awk '{print $NF}') \
//!   cargo test -p pear-desktop --test bridge_e2e -- --ignored --nocapture
//!
//! Covers: desktop pairing (identity mint + pair_bridge_device), device-scoped
//! RLS (source reads only its own commands + allowlist), tool_bash execution
//! with audit, the baseline blocked-patterns floor, and the human-confirmation
//! round-trip. Uses the OS keychain under a throwaway workspace key.

use pear_desktop_lib::bridge::{self, stdb::StdbHttp, LocalBridge};
use pear_desktop_lib::keychain;
use std::sync::Arc;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for this test"))
}

async fn wait_result(
    http: &StdbHttp,
    nonce: &str,
    timeout_secs: u64,
) -> (u64, String, serde_json::Value) {
    // Find the command id by nonce, then its result row.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let mut command_id = 0u64;
    while std::time::Instant::now() < deadline {
        if command_id == 0 {
            let (cols, rows) = http
                .sql("SELECT id, nonce FROM bridge_command")
                .await
                .expect("sql bridge_command");
            let c_id = cols.iter().position(|c| c == "id").unwrap();
            let c_nonce = cols.iter().position(|c| c == "nonce").unwrap();
            for row in rows {
                let n = bridge::stdb::unwrap_option(&row[c_nonce])
                    .and_then(|v| v.as_str().map(String::from));
                if n.as_deref() == Some(nonce) {
                    command_id = row[c_id].as_u64().unwrap_or(0);
                }
            }
        }
        if command_id != 0 {
            let (cols, rows) = http
                .sql(&format!(
                    "SELECT command_id, stdout, rejection_reason, exit_code FROM \
                     bridge_command_result WHERE command_id = {command_id}"
                ))
                .await
                .expect("sql result");
            if let Some(row) = rows.first() {
                let c_out = cols.iter().position(|c| c == "stdout").unwrap();
                let c_rej = cols.iter().position(|c| c == "rejection_reason").unwrap();
                let stdout = row[c_out].as_str().unwrap_or("").to_string();
                return (command_id, stdout, row[c_rej].clone());
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    panic!("no result for nonce {nonce} within {timeout_secs}s (command_id={command_id})");
}

async fn command_status(http: &StdbHttp, command_id: u64) -> String {
    let (cols, rows) = http
        .sql(&format!(
            "SELECT id, status FROM bridge_command WHERE id = {command_id}"
        ))
        .await
        .expect("sql status");
    let c_status = cols.iter().position(|c| c == "status").unwrap();
    bridge::stdb::status_tag(&rows[0][c_status]).to_string()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "live E2E — needs a local SpacetimeDB with the pear module (see module docs)"]
async fn bridge_embed_e2e() {
    let uri = env("PEAR_E2E_URI");
    let db = env("PEAR_E2E_DB");
    let admin_token = env("PEAR_E2E_ADMIN_TOKEN");
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let workspace_key = format!("e2e-bridge-{run_id}");

    let admin = StdbHttp::new(&uri, &db, &admin_token);
    let client = reqwest::Client::new();

    // ── Pair: mint device identity + token, pair as the operator (owner) ──
    let mint = |label: &'static str| {
        let client = client.clone();
        let base = bridge::stdb::http_base(&uri);
        async move {
            let v: serde_json::Value = client
                .post(format!("{base}/v1/identity"))
                .send()
                .await
                .unwrap_or_else(|e| panic!("{label} mint: {e}"))
                .json()
                .await
                .expect("mint json");
            (
                v["identity"].as_str().expect("identity").to_string(),
                v["token"].as_str().expect("token").to_string(),
            )
        }
    };
    let (device_hex, device_stdb_token) = mint("device").await;
    let device_token = format!("{run_id}{run_id}");
    let device_token_hash = bridge::sha256_hex(&device_token);

    let jail = std::env::temp_dir().join(format!("pear-bridge-e2e-{run_id}"));
    std::fs::create_dir_all(&jail).unwrap();
    let jail_str = jail.canonicalize().unwrap().to_string_lossy().into_owned();
    let device_name = format!("E2E {run_id}");

    admin
        .call(
            "pair_bridge_device",
            serde_json::json!([
                device_name,
                device_token_hash,
                "test",
                "desktop-embed/e2e",
                [format!("0x{device_hex}")],
                "embedded-desktop",
                [jail_str.clone()]
            ]),
        )
        .await
        .expect("pair_bridge_device");

    // Device id from the public summary (newest row with our name).
    let (cols, rows) = admin
        .sql("SELECT id, name FROM bridge_device_summary")
        .await
        .expect("sql summary");
    let c_id = cols.iter().position(|c| c == "id").unwrap();
    let c_name = cols.iter().position(|c| c == "name").unwrap();
    let device_id = rows
        .iter()
        .filter(|r| r[c_name].as_str() == Some(device_name.as_str()))
        .filter_map(|r| r[c_id].as_u64())
        .max()
        .expect("paired device id");

    // ── Requester: a real AI user (grants are checked against ai_user rows) ──
    let (req_hex, req_token) = mint("requester").await;
    admin
        .call(
            "create_ai_user",
            serde_json::json!([
                [format!("0x{req_hex}")],
                [format!("0x{req_hex}")],
                format!("E2E Requester {run_id}"),
                { "anthropic": [] },
                "external-mcp-client",
                { "none": [] },
                { "none": [] },
                { "none": [] },
                { "none": [] },
                { "none": [] }
            ]),
        )
        .await
        .expect("create_ai_user");
    admin
        .call(
            "grant_bridge_device",
            serde_json::json!([device_id, [format!("0x{req_hex}")]]),
        )
        .await
        .expect("grant_bridge_device");
    let requester = StdbHttp::new(&uri, &db, &req_token);

    // ── Start the embedded bridge through the real manager ──
    keychain::store_bridge_secret(&workspace_key, bridge::DEVICE_TOKEN_KIND, &device_token)
        .expect("keychain device token");
    keychain::store_bridge_secret(
        &workspace_key,
        bridge::DEVICE_STDB_TOKEN_KIND,
        &device_stdb_token,
    )
    .expect("keychain stdb token");

    let app_data = std::env::temp_dir().join(format!("pear-desktop-e2e-{run_id}"));
    let manager = Arc::new(LocalBridge::new(&app_data));
    let status = manager.start(&workspace_key, &uri, &db).await.expect("bridge start");
    assert_eq!(status.status, "running", "{}", status.message);

    let enqueue = |cmd: &str, nonce: &str| {
        let requester = &requester;
        let jail = jail_str.clone();
        let cmd = cmd.to_string();
        let nonce = nonce.to_string();
        async move {
            requester
                .call(
                    "enqueue_bridge_command",
                    serde_json::json!([
                        device_id,
                        cmd,
                        { "some": jail },
                        1u64,
                        { "none": [] },
                        { "none": [] },
                        nonce
                    ]),
                )
                .await
                .expect("enqueue");
        }
    };

    // 1. Allowed command executes; output lands in the result row.
    enqueue(&format!("echo bridge-says-{run_id}"), "n-echo").await;
    let (_, stdout, rejection) = wait_result(&requester, "n-echo", 30).await;
    assert!(
        stdout.contains(&format!("bridge-says-{run_id}")),
        "stdout: {stdout} rejection: {rejection}"
    );

    // 2. Baseline blocked-patterns floor: sudo is rejected even though the
    //    allowlist would never list it — the floor cannot be configured away.
    enqueue("sudo whoami", "n-sudo").await;
    let (_, _, rejection) = wait_result(&requester, "n-sudo", 30).await;
    assert!(
        bridge::stdb::unwrap_option(&rejection).is_some(),
        "sudo must be rejected: {rejection}"
    );

    // 3. Confirmation round-trip: "git push" matches the default
    //    require_confirmation_for → AwaitingConfirmation → owner confirms →
    //    re-dispatch executes (fails in an empty dir, but it RAN).
    enqueue("git push", "n-push").await;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut push_id = 0u64;
    while std::time::Instant::now() < deadline && push_id == 0 {
        let (cols, rows) = requester
            .sql("SELECT id, nonce, status FROM bridge_command")
            .await
            .expect("sql");
        let c_id = cols.iter().position(|c| c == "id").unwrap();
        let c_nonce = cols.iter().position(|c| c == "nonce").unwrap();
        let c_status = cols.iter().position(|c| c == "status").unwrap();
        for row in rows {
            let n = bridge::stdb::unwrap_option(&row[c_nonce])
                .and_then(|v| v.as_str().map(String::from));
            if n.as_deref() == Some("n-push")
                && bridge::stdb::status_tag(&row[c_status]) == "AwaitingConfirmation"
            {
                push_id = row[c_id].as_u64().unwrap();
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    assert_ne!(push_id, 0, "git push never reached AwaitingConfirmation");
    admin
        .call("confirm_bridge_command", serde_json::json!([push_id, false]))
        .await
        .expect("confirm");
    let (_, _, _) = wait_result(&requester, "n-push", 30).await;
    let final_status = command_status(&requester, push_id).await;
    assert!(
        final_status == "Completed" || final_status == "Failed",
        "confirmed command must have executed, got {final_status}"
    );

    // ── Stop: sessions close, summary flips to disconnected ──
    manager.stop().await;
    let (cols, rows) = admin
        .sql(&format!(
            "SELECT id, connected FROM bridge_device_summary WHERE id = {device_id}"
        ))
        .await
        .expect("sql summary");
    let c_conn = cols.iter().position(|c| c == "connected").unwrap();
    assert_eq!(rows[0][c_conn].as_bool(), Some(false), "session must be closed");

    // Audit chain must verify.
    let verify = pear_bridge::audit::verify(app_data.join("bridge/audit.log"))
        .expect("audit log readable");
    match verify {
        pear_bridge::audit::VerifyResult::Ok { entries } => assert!(entries >= 2),
        other => panic!("audit chain broken: {other:?}"),
    }

    let _ = keychain::delete_bridge_secret(&workspace_key, bridge::DEVICE_TOKEN_KIND);
    let _ = keychain::delete_bridge_secret(&workspace_key, bridge::DEVICE_STDB_TOKEN_KIND);
    let _ = std::fs::remove_dir_all(&jail);
    let _ = std::fs::remove_dir_all(&app_data);
}
