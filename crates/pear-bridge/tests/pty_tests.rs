//! Tests for the PTY execution path. These spawn real subprocesses through a
//! PTY, so they require a POSIX shell (`sh`); they are gated to Unix.

#![cfg(unix)]

use std::path::Path;
use std::time::Duration;

use pear_bridge::pty::{run_command, strip_ansi, CommandOutput, PtyLimits};

fn limits(max_bytes: usize, secs: u64) -> PtyLimits {
    PtyLimits {
        max_output_bytes: max_bytes,
        max_runtime: Duration::from_secs(secs),
    }
}

/// These tests exercise the PTY layer (capture, truncation, timeout, cwd, ANSI),
/// not the OS sandbox — so run commands unconfined. The sandbox is covered by
/// `sandbox.rs` unit tests + `tests/confinement_tests.rs`. Idempotent; every
/// test in this (single-process) binary wants it.
fn unsandboxed() {
    std::env::set_var("PEAR_BRIDGE_NO_SANDBOX", "1");
}

fn run(cmd: &str) -> CommandOutput {
    unsandboxed();
    run_command(cmd, None, "sh", &limits(65_536, 30), &[]).expect("run_command failed")
}

#[test]
fn captures_stdout_and_exit_zero() {
    let out = run("echo hello world");
    assert!(out.output.contains("hello world"), "got: {:?}", out.output);
    assert_eq!(out.exit_code, Some(0));
    assert!(!out.truncated);
    assert!(!out.timed_out);
}

#[test]
fn captures_nonzero_exit_code() {
    let out = run("exit 3");
    assert_eq!(out.exit_code, Some(3));
    assert!(!out.timed_out);
}

#[test]
fn stderr_is_combined_into_output() {
    // A PTY merges stderr into the single output stream.
    let out = run("echo to-stderr 1>&2");
    assert!(out.output.contains("to-stderr"), "got: {:?}", out.output);
    assert_eq!(out.exit_code, Some(0));
}

#[test]
fn output_is_truncated_at_cap() {
    // Produce far more than the cap; expect a cut + marker, and no hang.
    unsandboxed();
    let out = run_command(
        "for i in $(seq 1 100000); do echo 0123456789; done",
        None,
        "sh",
        &limits(1024, 30),
        &[],
    )
    .expect("run_command failed");
    assert!(out.truncated, "expected truncation");
    assert!(out.output.contains("[output truncated at 1024 bytes]"));
}

#[test]
fn runtime_timeout_kills_command() {
    unsandboxed();
    let out =
        run_command("sleep 10", None, "sh", &limits(65_536, 1), &[]).expect("run_command failed");
    assert!(out.timed_out, "expected timeout");
    assert!(
        out.duration < Duration::from_secs(5),
        "should not wait the full sleep"
    );
    assert!(out.output.contains("timed out"));
}

#[test]
fn ansi_escapes_are_stripped_from_output() {
    // printf interprets the escape; the captured output must be plain text.
    let out = run(r"printf '\033[31mred\033[0m\n'");
    assert!(out.output.contains("red"), "got: {:?}", out.output);
    assert!(
        !out.output.contains('\u{1b}'),
        "ESC should be stripped: {:?}",
        out.output
    );
    assert!(
        !out.output.contains("[31m"),
        "CSI should be stripped: {:?}",
        out.output
    );
}

#[test]
fn runs_in_requested_cwd() {
    let dir = std::env::temp_dir();
    let canonical = std::fs::canonicalize(&dir).unwrap();
    unsandboxed();
    let out = run_command("pwd", Some(Path::new(&dir)), "sh", &limits(65_536, 30), &[])
        .expect("run_command failed");
    let printed = out.output.trim();
    // On macOS /tmp and /var are symlinked; compare canonicalized forms.
    let printed_canon = std::fs::canonicalize(printed).unwrap();
    assert_eq!(printed_canon, canonical, "pwd was {printed:?}");
}

#[test]
fn chained_command_carries_cwd() {
    // The `cd X && do-thing` pattern the allowlist supports must work end-to-end.
    let out = run("cd / && pwd");
    assert_eq!(out.output.trim(), "/", "got: {:?}", out.output);
}

// ---- strip_ansi unit coverage ----

#[test]
fn strip_ansi_removes_csi_osc_and_keeps_text() {
    assert_eq!(strip_ansi("\x1b[1;32mok\x1b[0m"), "ok");
    assert_eq!(strip_ansi("a\x1b]0;title\x07b"), "ab"); // OSC title set
    assert_eq!(strip_ansi("line1\nline2\tx"), "line1\nline2\tx"); // newline/tab kept
    assert_eq!(strip_ansi("drop\rcarriage"), "dropcarriage"); // lone CR dropped
}

#[test]
fn external_command_ls_returns_promptly() {
    use pear_bridge::pty::{run_command, PtyLimits};
    use std::time::Instant;
    unsandboxed();
    let start = Instant::now();
    let out = run_command("ls -la /", None, "/bin/sh", &PtyLimits::default(), &[])
        .expect("ls should run");
    assert!(
        start.elapsed().as_secs() < 5,
        "ls hung: took {:?}",
        start.elapsed()
    );
    assert_eq!(out.exit_code, Some(0));
    assert!(
        out.output.contains("usr") || out.output.contains("bin"),
        "got: {}",
        out.output
    );
}

#[test]
fn external_command_under_zsh_returns_promptly() {
    use pear_bridge::pty::{run_command, PtyLimits};
    use std::time::Instant;
    let zsh = "/bin/zsh";
    if !std::path::Path::new(zsh).exists() {
        return;
    }
    unsandboxed();
    let start = Instant::now();
    let out = run_command("ls -la /Users", None, zsh, &PtyLimits::default(), &[])
        .expect("ls under zsh should run");
    assert!(
        start.elapsed().as_secs() < 5,
        "zsh ls hung: {:?}",
        start.elapsed()
    );
    assert_eq!(out.exit_code, Some(0));
}
