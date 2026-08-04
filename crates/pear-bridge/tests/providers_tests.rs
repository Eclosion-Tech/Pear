//! Inference provider adapter tests. All env-override seams
//! (`PEAR_BRIDGE_CLAUDE_BIN` / `_CODEX_BIN` / `_OLLAMA_URL`) are process-global,
//! so every test that touches them serializes on [`ENV_LOCK`] — same reasoning
//! as the separate confinement test binary for `PEAR_BRIDGE_NO_SANDBOX`.

#![cfg(unix)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Mutex;

use pear_bridge::allowlist::{AllowlistConfig, AllowlistEnforcer};
use pear_bridge::audit::AuditLog;
use pear_bridge::daemon::{process_incoming, ExecConfig, IncomingCommand, Outcome};
use pear_bridge::providers::{
    detect_capabilities, run_inference, run_inference_json, InferencePayload, InferenceResult,
    ProviderCapability,
};
use pear_bridge::pty::PtyLimits;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn write_script(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).unwrap();
    path
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pear-bridge-providers-{tag}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn payload(provider: &str, prompt: &str) -> InferencePayload {
    serde_json::from_value(serde_json::json!({
        "provider": provider,
        "prompt": prompt,
    }))
    .unwrap()
}

/// Serve exactly `n` canned HTTP responses on an ephemeral port, then stop.
fn canned_http(body: &'static str, n: usize) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for _ in 0..n {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });
    format!("http://{addr}")
}

// ── claude adapter ─────────────────────────────────────────────────────────

#[tokio::test]
async fn claude_adapter_parses_result_envelope_and_pipes_prompt_via_stdin() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = temp_dir("claude-ok");
    // Echoes the stdin body back inside the claude JSON envelope.
    let bin = write_script(
        &dir,
        "claude",
        r#"in=$(cat)
printf '{"type":"result","subtype":"success","is_error":false,"result":"echo: %s"}' "$in""#,
    );
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", &bin);

    let result = run_inference(&payload("claude-code", "hello world")).await;
    std::env::remove_var("PEAR_BRIDGE_CLAUDE_BIN");

    assert!(result.ok, "expected ok, got {:?}", result.error);
    assert_eq!(result.output, "echo: hello world");
    assert_eq!(result.provider, "claude-code");
}

#[tokio::test]
async fn claude_adapter_surfaces_is_error_envelopes_as_failures() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = temp_dir("claude-err");
    let bin = write_script(
        &dir,
        "claude",
        r#"printf '{"type":"result","is_error":true,"result":"credit exhausted"}'"#,
    );
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", &bin);

    let result = run_inference(&payload("claude-code", "hi")).await;
    std::env::remove_var("PEAR_BRIDGE_CLAUDE_BIN");

    assert!(!result.ok);
    assert!(result.error.as_deref().unwrap().contains("credit exhausted"));
}

#[tokio::test]
async fn nonzero_exit_is_an_honest_failure_with_stderr_excerpt() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = temp_dir("claude-exit");
    let bin = write_script(&dir, "claude", "echo 'not logged in' >&2; exit 1");
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", &bin);

    let result = run_inference(&payload("claude-code", "hi")).await;
    std::env::remove_var("PEAR_BRIDGE_CLAUDE_BIN");

    assert!(!result.ok);
    let err = result.error.unwrap();
    assert!(err.contains("not logged in"), "stderr not surfaced: {err}");
}

#[tokio::test]
async fn timeout_kills_the_child_and_reports_failure() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = temp_dir("claude-slow");
    let bin = write_script(&dir, "claude", "sleep 30");
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", &bin);

    let p: InferencePayload = serde_json::from_value(serde_json::json!({
        "provider": "claude-code",
        "prompt": "hi",
        "timeout_seconds": 1,
    }))
    .unwrap();
    let started = std::time::Instant::now();
    let result = run_inference(&p).await;
    std::env::remove_var("PEAR_BRIDGE_CLAUDE_BIN");

    assert!(!result.ok);
    assert!(result.error.unwrap().contains("timed out"));
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}

// ── codex adapter ──────────────────────────────────────────────────────────

#[tokio::test]
async fn codex_adapter_prepends_system_and_reads_stdout() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = temp_dir("codex-ok");
    let bin = write_script(&dir, "codex", r#"in=$(cat); printf 'codex says: %s' "$in""#);
    std::env::set_var("PEAR_BRIDGE_CODEX_BIN", &bin);

    let p: InferencePayload = serde_json::from_value(serde_json::json!({
        "provider": "codex",
        "prompt": "question",
        "system": "be terse",
    }))
    .unwrap();
    let result = run_inference(&p).await;
    std::env::remove_var("PEAR_BRIDGE_CODEX_BIN");

    assert!(result.ok, "{:?}", result.error);
    assert_eq!(result.output, "codex says: be terse\n\nquestion");
}

// ── ollama adapter ─────────────────────────────────────────────────────────

#[tokio::test]
async fn ollama_adapter_posts_generate_and_requires_model() {
    let _guard = ENV_LOCK.lock().unwrap();
    let url = canned_http(r#"{"model":"llama3","response":"the answer","done":true}"#, 1);
    std::env::set_var("PEAR_BRIDGE_OLLAMA_URL", &url);

    // Missing model → explicit error, no request made.
    let no_model = run_inference(&payload("ollama", "hi")).await;
    assert!(!no_model.ok);
    assert!(no_model.error.unwrap().contains("requires an explicit model"));

    let p: InferencePayload = serde_json::from_value(serde_json::json!({
        "provider": "ollama",
        "model": "llama3",
        "prompt": "hi",
    }))
    .unwrap();
    let result = run_inference(&p).await;
    std::env::remove_var("PEAR_BRIDGE_OLLAMA_URL");

    assert!(result.ok, "{:?}", result.error);
    assert_eq!(result.output, "the answer");
}

// ── payload / envelope plumbing ────────────────────────────────────────────

#[tokio::test]
async fn missing_or_malformed_payload_yields_honest_failure() {
    let none = run_inference_json(None).await;
    assert!(!none.ok);
    assert!(none.error.unwrap().contains("no payload_json"));

    let bad = run_inference_json(Some("{not json")).await;
    assert!(!bad.ok);
    assert!(bad.error.unwrap().contains("invalid inference payload"));

    let unknown = run_inference_json(Some(r#"{"provider":"gpt9","prompt":"x"}"#)).await;
    assert!(!unknown.ok);
    assert!(unknown.error.unwrap().contains("unknown inference provider"));
}

#[test]
fn inference_result_envelope_round_trips() {
    let r = InferenceResult {
        ok: true,
        provider: "claude-code".into(),
        model: Some("m".into()),
        output: "out".into(),
        duration_ms: 12,
        error: None,
    };
    let parsed: InferenceResult = serde_json::from_str(&r.to_json()).unwrap();
    assert_eq!(parsed, r);
    // `error`/`model` are omitted when None so the envelope stays compact.
    let r2 = InferenceResult { model: None, ..r };
    assert!(!r2.to_json().contains("\"model\""));
}

#[test]
fn capabilities_frame_shape_is_stable() {
    let frame = pear_bridge::transport::capabilities_frame(&[ProviderCapability {
        provider: "ollama".into(),
        available: true,
        version: None,
        models: Some(vec!["llama3".into()]),
    }]);
    let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(v["type"], "capabilities");
    assert_eq!(v["capabilities"][0]["provider"], "ollama");
    assert_eq!(v["capabilities"][0]["available"], true);
    assert_eq!(v["capabilities"][0]["models"][0], "llama3");
    assert!(v["capabilities"][0].get("version").is_none());
}

// ── detection ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn detection_reports_installed_clis_and_serving_ollama() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = temp_dir("detect");
    let claude = write_script(&dir, "claude", "echo '2.1.221 (Claude Code)'");
    // codex --version fails → treated as not installed → no row.
    let codex = write_script(&dir, "codex", "exit 1");
    let url = canned_http(r#"{"models":[{"name":"llama3:8b"},{"name":"qwen2"}]}"#, 1);
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", &claude);
    std::env::set_var("PEAR_BRIDGE_CODEX_BIN", &codex);
    std::env::set_var("PEAR_BRIDGE_OLLAMA_URL", &url);

    let caps = detect_capabilities().await;
    std::env::remove_var("PEAR_BRIDGE_CLAUDE_BIN");
    std::env::remove_var("PEAR_BRIDGE_CODEX_BIN");
    std::env::remove_var("PEAR_BRIDGE_OLLAMA_URL");

    let claude_cap = caps.iter().find(|c| c.provider == "claude-code").unwrap();
    assert!(claude_cap.available);
    assert_eq!(claude_cap.version.as_deref(), Some("2.1.221 (Claude Code)"));
    assert!(caps.iter().all(|c| c.provider != "codex"));
    let ollama_cap = caps.iter().find(|c| c.provider == "ollama").unwrap();
    assert!(ollama_cap.available);
    assert_eq!(
        ollama_cap.models.as_deref(),
        Some(&["llama3:8b".to_string(), "qwen2".to_string()][..])
    );
}

// ── dispatch through the daemon engine ─────────────────────────────────────

fn engine(tag: &str) -> (AllowlistEnforcer, ExecConfig, AuditLog, PathBuf) {
    let dir = temp_dir(tag);
    let enforcer = AllowlistEnforcer::new(AllowlistConfig {
        allowed_directories: vec![dir.to_string_lossy().to_string()],
        ..AllowlistConfig::default()
    });
    let exec = ExecConfig {
        shell: "sh".to_string(),
        limits: PtyLimits::default(),
        server_url: "https://test.invalid".to_string(),
    };
    let audit_path = dir.join("audit.log");
    let audit = AuditLog::open(&audit_path).unwrap();
    (enforcer, exec, audit, audit_path)
}

fn inference_cmd(id: u64, payload: serde_json::Value) -> IncomingCommand {
    IncomingCommand {
        command_id: id,
        device_id: 1,
        session_id: 42,
        conversation_id: 99,
        requested_by: "0xai".to_string(),
        command: "infer:claude-code".to_string(),
        cwd: None,
        confirmed: false,
        kind: Some("inference".to_string()),
        payload_json: Some(payload.to_string()),
    }
}

#[tokio::test]
async fn process_incoming_dispatches_inference_and_audits_with_kind() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = temp_dir("dispatch");
    let bin = write_script(
        &dir,
        "claude",
        r#"printf '{"type":"result","is_error":false,"result":"dispatched"}'"#,
    );
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", &bin);

    let (enforcer, exec, mut audit, audit_path) = engine("dispatch-engine");
    let cmd = inference_cmd(
        7,
        serde_json::json!({"provider": "claude-code", "prompt": "hi"}),
    );
    let outcome = process_incoming(&cmd, &enforcer, &exec, &mut audit).await;
    std::env::remove_var("PEAR_BRIDGE_CLAUDE_BIN");

    let Outcome::Completed { exit_code, stdout, .. } = outcome else {
        panic!("expected Completed, got {outcome:?}");
    };
    assert_eq!(exit_code, Some(0));
    let envelope: InferenceResult = serde_json::from_str(&stdout).unwrap();
    assert!(envelope.ok);
    assert_eq!(envelope.output, "dispatched");

    // The audit line records the kind and the summary — never the prompt.
    let log = std::fs::read_to_string(&audit_path).unwrap();
    let line: serde_json::Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
    assert_eq!(line["kind"], "inference");
    assert_eq!(line["command"], "infer:claude-code");
    assert!(!log.contains("\"hi\""));
}

#[tokio::test]
async fn process_incoming_rejects_unknown_kinds_and_keeps_bash_path() {
    let (enforcer, exec, mut audit, _) = engine("unknown-kind");

    let mut cmd = inference_cmd(8, serde_json::json!({}));
    cmd.kind = Some("harness".to_string());
    let outcome = process_incoming(&cmd, &enforcer, &exec, &mut audit).await;
    let Outcome::Rejected { reason } = outcome else {
        panic!("expected Rejected, got {outcome:?}");
    };
    assert!(reason.contains("harness"));

    // kind=None still goes through the classic allowlist path (default config
    // has an empty allowlist + Reject policy → denied, proving the branch).
    let bash = IncomingCommand {
        kind: None,
        payload_json: None,
        command: "definitely-not-allowlisted".to_string(),
        ..inference_cmd(9, serde_json::json!({}))
    };
    let outcome = process_incoming(&bash, &enforcer, &exec, &mut audit).await;
    assert!(matches!(outcome, Outcome::Rejected { .. }));
}
