//! Run-loop engine tests: real AllowlistEnforcer + real PTY + real audit log,
//! driven through in-memory CommandSource/ResultSink doubles. Unix-gated (spawns
//! a shell via the PTY).

#![cfg(unix)]

use std::collections::VecDeque;
use std::path::PathBuf;

use pear_bridge::allowlist::{AllowlistConfig, AllowlistEnforcer, UnlistedPolicy};
use pear_bridge::audit::{verify, AuditLog, VerifyResult};
use pear_bridge::daemon::{
    run_loop, CommandSource, ExecConfig, IncomingCommand, Outcome, ResultSink,
};
use pear_bridge::pty::PtyLimits;

// ── transport doubles ──────────────────────────────────────────────────────

struct VecSource(VecDeque<IncomingCommand>);
impl CommandSource for VecSource {
    async fn next_command(&mut self) -> Option<IncomingCommand> {
        self.0.pop_front()
    }
}

#[derive(Default)]
struct RecordingSink(Vec<(u64, Outcome)>);
impl ResultSink for RecordingSink {
    async fn send_outcome(&mut self, command_id: u64, outcome: Outcome) -> Result<(), String> {
        self.0.push((command_id, outcome));
        Ok(())
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

fn enforcer() -> AllowlistEnforcer {
    AllowlistEnforcer::new(AllowlistConfig {
        unlisted_policy: UnlistedPolicy::Reject,
        allowed_commands: ["echo", "git", "cat", "ls"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        blocked_patterns: Vec::new(),
        allowed_directories: Vec::new(),
        // A confirmation pattern that's safe to actually run when confirmed.
        require_confirmation_for: vec!["echo danger".to_string()],
    })
}

fn exec_config() -> ExecConfig {
    // These tests exercise the engine's allow/reject/confirmation routing, not
    // the OS sandbox (confinement is covered by `tests/confinement_tests.rs`).
    // Run commands unconfined so they don't need a real allowed directory.
    std::env::set_var("PEAR_BRIDGE_NO_SANDBOX", "1");
    ExecConfig {
        shell: "sh".to_string(),
        limits: PtyLimits::default(),
        server_url: "https://mypear.example.com".to_string(),
    }
}

fn temp_audit(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "pear-bridge-daemon-{tag}-{}-{}.log",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_file(&p);
    p
}

fn cmd(id: u64, command: &str, confirmed: bool) -> IncomingCommand {
    IncomingCommand {
        command_id: id,
        device_id: 1,
        session_id: 42,
        conversation_id: 99,
        requested_by: "0xai".to_string(),
        command: command.to_string(),
        cwd: None,
        confirmed,
        kind: None,
        payload_json: None,
    }
}

// ── tests ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn handles_allow_reject_and_confirmation() {
    use pear_bridge::daemon::process_command;

    let path = temp_audit("loop");
    let mut audit = AuditLog::open(&path).unwrap();
    let enf = enforcer();
    let exec = exec_config();

    let mut source = VecSource(VecDeque::from(vec![
        cmd(1, "echo hello", false),                // allowed → runs
        cmd(2, "curl https://evil.example", false), // not allowlisted → rejected
        cmd(3, "echo danger", false),               // require_confirmation_for, unconfirmed
        cmd(4, "echo danger", true),                // same, confirmed → runs
    ]));
    let mut sink = RecordingSink::default();

    // Drive process_command directly so we can inspect each outcome.
    while let Some(c) = source.next_command().await {
        let o = process_command(&c, &enf, &exec, &mut audit);
        sink.send_outcome(c.command_id, o).await.unwrap();
    }

    let outcomes = sink.0;
    assert_eq!(outcomes.len(), 4);

    // 1: allowed and ran
    match &outcomes[0] {
        (
            1,
            Outcome::Completed {
                exit_code, stdout, ..
            },
        ) => {
            assert_eq!(*exit_code, Some(0));
            assert!(stdout.contains("hello"), "got {stdout:?}");
        }
        other => panic!("cmd1 expected Completed, got {other:?}"),
    }
    // 2: rejected by allowlist (never executed)
    assert!(matches!(&outcomes[1], (2, Outcome::Rejected { .. })));
    // 3: awaiting confirmation, did NOT run
    match &outcomes[2] {
        (3, Outcome::AwaitingConfirmation { matched }) => assert_eq!(matched, "echo danger"),
        other => panic!("cmd3 expected AwaitingConfirmation, got {other:?}"),
    }
    // 4: confirmed → ran
    match &outcomes[3] {
        (4, Outcome::Completed { stdout, .. }) => {
            assert!(stdout.contains("danger"), "got {stdout:?}")
        }
        other => panic!("cmd4 expected Completed, got {other:?}"),
    }

    // Audit recorded every command, chain intact, written before execution.
    assert_eq!(verify(&path).unwrap(), VerifyResult::Ok { entries: 4 });
    std::fs::remove_file(&path).ok();
}

#[tokio::test]
async fn run_loop_drives_source_to_completion() {
    let path = temp_audit("drive");
    let mut audit = AuditLog::open(&path).unwrap();
    let enf = enforcer();
    let exec = exec_config();

    let source = VecSource(VecDeque::from(vec![
        cmd(10, "echo one", false),
        cmd(11, "ls", false),
    ]));
    let sink = RecordingSink::default();
    let result = run_loop(source, sink, &enf, &exec, &mut audit).await;
    assert!(result.is_ok());
    assert_eq!(verify(&path).unwrap(), VerifyResult::Ok { entries: 2 });
    std::fs::remove_file(&path).ok();
}

#[tokio::test]
async fn rejected_command_is_not_executed() {
    use pear_bridge::daemon::process_command;
    let path = temp_audit("reject");
    let mut audit = AuditLog::open(&path).unwrap();
    let enf = enforcer();
    let exec = exec_config();

    // `rm` is not allowlisted; even though it would "succeed" as a shell command,
    // the enforcer must reject before any PTY spawn.
    let o = process_command(
        &cmd(1, "rm -rf /tmp/should-not-run", false),
        &enf,
        &exec,
        &mut audit,
    );
    match o {
        Outcome::Rejected { reason } => assert!(reason.contains("rm"), "got {reason}"),
        other => panic!("expected Rejected, got {other:?}"),
    }
    std::fs::remove_file(&path).ok();
}
