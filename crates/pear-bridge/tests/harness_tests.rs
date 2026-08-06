//! Harness-session tests (kind = "harness"). Same env-override serialization
//! pattern as providers_tests.rs — PEAR_BRIDGE_CLAUDE_BIN is process-global.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Mutex;

use pear_bridge::allowlist::{AllowlistConfig, AllowlistEnforcer};
use pear_bridge::audit::AuditLog;
use pear_bridge::daemon::{process_incoming, ExecConfig, IncomingCommand, Outcome};
use pear_bridge::harness::{run_harness_json, HarnessResult};
use pear_bridge::pty::PtyLimits;

static ENV_LOCK: Mutex<()> = Mutex::new(());

const SID: &str = "3f2c8a10-1234-4abc-9def-0123456789ab";

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pear-bridge-harness-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

/// Fake claude: reads stdin, logs argv, and simulates session state via a
/// marker file — `--resume` fails with claude's unknown-session error until a
/// turn has run; any successful turn creates the marker.
fn fake_claude(dir: &std::path::Path) -> PathBuf {
    let marker = dir.join("session-exists");
    let log = dir.join("args.log");
    let path = dir.join("claude");
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\nin=$(cat)\necho \"$@\" >> {log}\ncase \"$@\" in\n  *--resume*)\n    if [ ! -f {marker} ]; then\n      echo 'No conversation found with session ID: {SID}' >&2\n      exit 1\n    fi\n    printf '{{\"type\":\"result\",\"is_error\":false,\"result\":\"resumed turn: %s\",\"session_id\":\"{SID}\"}}' \"$in\"\n    ;;\n  *)\n    touch {marker}\n    printf '{{\"type\":\"result\",\"is_error\":false,\"result\":\"fresh turn: %s\",\"session_id\":\"{SID}\"}}' \"$in\"\n    ;;\nesac\n",
            log = log.display(),
            marker = marker.display(),
        ),
    )
    .unwrap();
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).unwrap();
    path
}

fn payload(dir: &std::path::Path, prompt: &str) -> String {
    serde_json::json!({
        "provider": "claude-code",
        "session_id": SID,
        "prompt": prompt,
        "cwd": dir.to_string_lossy(),
    })
    .to_string()
}

#[tokio::test]
async fn first_turn_starts_session_then_second_turn_resumes_it() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = temp_dir("resume");
    let bin = fake_claude(&dir);
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", &bin);

    let allowed = vec![dir.clone()];
    let first = run_harness_json(Some(&payload(&dir, "hello")), &allowed, None).await;
    assert!(first.ok, "{:?}", first.error);
    assert!(!first.resumed, "first turn must report a fresh session");
    assert_eq!(first.output, "fresh turn: hello");

    let second = run_harness_json(Some(&payload(&dir, "and again")), &allowed, None).await;
    std::env::remove_var("PEAR_BRIDGE_CLAUDE_BIN");
    assert!(second.ok, "{:?}", second.error);
    assert!(second.resumed, "second turn must resume");
    assert_eq!(second.output, "resumed turn: and again");

    // Argv contract: resume attempt, then --session-id fallback, then resume.
    let log = std::fs::read_to_string(dir.join("args.log")).unwrap();
    let lines: Vec<&str> = log.lines().collect();
    assert_eq!(lines.len(), 3, "log: {log}");
    assert!(lines[0].contains("--resume") && lines[0].contains(SID));
    assert!(lines[1].contains("--session-id") && lines[1].contains(SID));
    assert!(lines[2].contains("--resume"));
    // Tools stay ENABLED (no --tools flag) under a bounded permission mode.
    assert!(!log.contains("--tools"));
    assert!(log.contains("--permission-mode acceptEdits"));
}

#[tokio::test]
async fn cwd_is_jailed_to_allowed_directories() {
    let dir = temp_dir("jail");
    let outside = temp_dir("jail-outside");
    let allowed = vec![dir.clone()];

    let body = serde_json::json!({
        "provider": "claude-code",
        "session_id": SID,
        "prompt": "hi",
        "cwd": outside.to_string_lossy(),
    })
    .to_string();
    let result = run_harness_json(Some(&body), &allowed, None).await;
    assert!(!result.ok);
    assert!(result.error.as_deref().unwrap().contains("outside this device's allowed_directories"));

    let none = run_harness_json(Some(&payload(&dir, "hi")), &[], None).await;
    assert!(!none.ok);
    assert!(none.error.as_deref().unwrap().contains("no allowed_directories"));
}

#[tokio::test]
async fn refuses_bypass_permissions_bad_uuids_and_unknown_providers() {
    let dir = temp_dir("refuse");
    let allowed = vec![dir.clone()];

    let bypass = serde_json::json!({
        "provider": "claude-code",
        "session_id": SID,
        "prompt": "hi",
        "permission_mode": "bypassPermissions",
    })
    .to_string();
    let r = run_harness_json(Some(&bypass), &allowed, None).await;
    assert!(!r.ok);
    assert!(r.error.as_deref().unwrap().contains("bypassPermissions"));

    let bad_sid = serde_json::json!({
        "provider": "claude-code",
        "session_id": "not-a-uuid",
        "prompt": "hi",
    })
    .to_string();
    let r = run_harness_json(Some(&bad_sid), &allowed, None).await;
    assert!(!r.ok);
    assert!(r.error.as_deref().unwrap().contains("UUID"));

    let codex = serde_json::json!({
        "provider": "codex",
        "session_id": SID,
        "prompt": "hi",
    })
    .to_string();
    let r = run_harness_json(Some(&codex), &allowed, None).await;
    assert!(!r.ok);
    assert!(r.error.as_deref().unwrap().contains("not supported yet"));
}

#[tokio::test]
async fn process_incoming_dispatches_harness_and_audits_with_kind() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = temp_dir("dispatch");
    let bin = fake_claude(&dir);
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", &bin);

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
    let mut audit = AuditLog::open(&audit_path).unwrap();

    let cmd = IncomingCommand {
        command_id: 21,
        device_id: 1,
        session_id: 42,
        conversation_id: 99,
        requested_by: "0xai".to_string(),
        command: "harness:claude-code".to_string(),
        cwd: None,
        confirmed: false,
        kind: Some("harness".to_string()),
        payload_json: Some(payload(&dir, "do the thing")),
    };
    let outcome = process_incoming(&cmd, &enforcer, &exec, &mut audit, None).await;
    std::env::remove_var("PEAR_BRIDGE_CLAUDE_BIN");

    let Outcome::Completed { exit_code, stdout, .. } = outcome else {
        panic!("expected Completed, got {outcome:?}");
    };
    assert_eq!(exit_code, Some(0));
    let envelope: HarnessResult = serde_json::from_str(&stdout).unwrap();
    assert!(envelope.ok);
    assert_eq!(envelope.session_id, SID);
    assert_eq!(envelope.output, "fresh turn: do the thing");

    let log = std::fs::read_to_string(&audit_path).unwrap();
    let line: serde_json::Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
    assert_eq!(line["kind"], "harness");
    assert_eq!(line["command"], "harness:claude-code");
    assert!(!log.contains("do the thing"), "prompt must not reach the local audit log");
}
