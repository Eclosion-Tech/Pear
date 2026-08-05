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
    canned_http_capture(body, n).0
}

/// Like [`canned_http`] but also captures each raw request (headers + body)
/// so tests can assert the endpoint path and verbatim payload forwarding.
fn canned_http_capture(
    body: &'static str,
    n: usize,
) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let captured = std::sync::Arc::new(Mutex::new(Vec::new()));
    let cap = std::sync::Arc::clone(&captured);
    std::thread::spawn(move || {
        for _ in 0..n {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut buf = vec![0u8; 65536];
            let read = stream.read(&mut buf).unwrap_or(0);
            cap.lock()
                .unwrap()
                .push(String::from_utf8_lossy(&buf[..read]).into_owned());
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
        }
    });
    (format!("http://{addr}"), captured)
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

// ── structured chat (v2 tool calling) ──────────────────────────────────────

#[tokio::test]
async fn ollama_chat_forwards_messages_and_tools_verbatim_and_maps_tool_calls() {
    let _guard = ENV_LOCK.lock().unwrap();
    let (url, captured) = canned_http_capture(
        r#"{"message":{"role":"assistant","content":"","thinking":"let me look","tool_calls":[{"function":{"name":"get_page","arguments":{"page_id":68}}}]},"done":true,"prompt_eval_count":43000,"eval_count":120}"#,
        1,
    );
    std::env::set_var("PEAR_BRIDGE_OLLAMA_URL", &url);

    let p: InferencePayload = serde_json::from_value(serde_json::json!({
        "provider": "ollama",
        "model": "llama3.1:8b",
        "num_ctx": 65536,
        "think": true,
        "chat": {
            "messages": [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "open the pear page"}
            ],
            "tools": [{"type": "function", "function": {"name": "get_page", "description": "d", "parameters": {"type": "object"}}}]
        }
    }))
    .unwrap();
    let result = run_inference(&p).await;
    std::env::remove_var("PEAR_BRIDGE_OLLAMA_URL");

    assert!(result.ok, "{:?}", result.error);
    assert_eq!(
        result.tool_calls,
        Some(vec![pear_bridge::providers::ToolCallOut {
            name: "get_page".into(),
            arguments: serde_json::json!({"page_id": 68}),
        }])
    );
    assert_eq!(result.thinking.as_deref(), Some("let me look"));
    let usage = result.usage.expect("usage mapped from eval counts");
    assert_eq!(usage.input_tokens, 43000);
    assert_eq!(usage.output_tokens, 120);

    let req = captured.lock().unwrap().join("");
    assert!(req.starts_with("POST /api/chat "), "endpoint: {}", req.lines().next().unwrap_or(""));
    let body_start = req.find("\r\n\r\n").unwrap() + 4;
    let body: serde_json::Value = serde_json::from_str(&req[body_start..]).unwrap();
    assert_eq!(body["model"], "llama3.1:8b");
    assert_eq!(body["stream"], false);
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][1]["content"], "open the pear page");
    assert_eq!(body["tools"][0]["function"]["name"], "get_page");
    assert_eq!(body["options"]["num_ctx"], 65536, "binding num_ctx must reach ollama");
    assert_eq!(body["think"], true, "explicit thinking control must be sent");
}

#[tokio::test]
async fn ollama_num_ctx_defaults_and_think_stays_absent_when_unconfigured() {
    let _guard = ENV_LOCK.lock().unwrap();
    let (url, captured) = canned_http_capture(
        r#"{"message":{"role":"assistant","content":"hi"},"done":true}"#,
        1,
    );
    std::env::set_var("PEAR_BRIDGE_OLLAMA_URL", &url);

    let p: InferencePayload = serde_json::from_value(serde_json::json!({
        "provider": "ollama",
        "model": "llama3.1:8b",
        "chat": {"messages": [{"role": "user", "content": "hi"}]}
    }))
    .unwrap();
    let result = run_inference(&p).await;
    std::env::remove_var("PEAR_BRIDGE_OLLAMA_URL");
    assert!(result.ok, "{:?}", result.error);

    let req = captured.lock().unwrap().join("");
    let body_start = req.find("\r\n\r\n").unwrap() + 4;
    let body: serde_json::Value = serde_json::from_str(&req[body_start..]).unwrap();
    assert_eq!(body["options"]["num_ctx"], 32768, "default num_ctx must apply");
    assert!(
        body.get("think").is_none(),
        "think must be ABSENT when unconfigured — ollama errors on it for non-thinking models"
    );
}

#[tokio::test]
async fn ollama_chat_without_tool_calls_returns_plain_content() {
    let _guard = ENV_LOCK.lock().unwrap();
    let url = canned_http(
        r#"{"message":{"role":"assistant","content":"just words"},"done":true}"#,
        1,
    );
    std::env::set_var("PEAR_BRIDGE_OLLAMA_URL", &url);

    let p: InferencePayload = serde_json::from_value(serde_json::json!({
        "provider": "ollama",
        "model": "llama3.1:8b",
        "chat": {"messages": [{"role": "user", "content": "hi"}]}
    }))
    .unwrap();
    let result = run_inference(&p).await;
    std::env::remove_var("PEAR_BRIDGE_OLLAMA_URL");

    assert!(result.ok, "{:?}", result.error);
    assert_eq!(result.output, "just words");
    assert_eq!(result.tool_calls, None);
}

#[tokio::test]
async fn structured_chat_is_rejected_for_claude_and_codex() {
    for provider in ["claude-code", "codex"] {
        let p: InferencePayload = serde_json::from_value(serde_json::json!({
            "provider": provider,
            "chat": {"messages": []}
        }))
        .unwrap();
        let result = run_inference(&p).await;
        assert!(!result.ok);
        assert!(
            result.error.as_deref().unwrap().contains("does not support structured chat"),
            "{provider}: {:?}",
            result.error
        );
    }
}

#[tokio::test]
async fn payload_must_carry_exactly_one_of_prompt_or_chat() {
    let neither = run_inference_json(Some(r#"{"provider":"ollama","model":"m"}"#)).await;
    assert!(!neither.ok);
    assert!(neither.error.unwrap().contains("either \"prompt\" or \"chat\""));

    let both = run_inference_json(Some(
        r#"{"provider":"ollama","model":"m","prompt":"p","chat":{"messages":[]}}"#,
    ))
    .await;
    assert!(!both.ok);
    assert!(both.error.unwrap().contains("not both"));
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
        tool_calls: None,
        thinking: None,
        usage: None,
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
    cmd.kind = Some("quantum".to_string());
    let outcome = process_incoming(&cmd, &enforcer, &exec, &mut audit).await;
    let Outcome::Rejected { reason } = outcome else {
        panic!("expected Rejected, got {outcome:?}");
    };
    assert!(reason.contains("quantum"));

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
