//! Real OS-sandbox confinement (`crate::sandbox`). macOS only — uses
//! `sandbox-exec`. Separate test binary (own process) so it never inherits the
//! `PEAR_BRIDGE_NO_SANDBOX` escape hatch that `pty_tests.rs` sets.

#![cfg(target_os = "macos")]

use std::path::Path;
use std::time::Duration;

use pear_bridge::pty::{run_command, PtyLimits};

fn limits() -> PtyLimits {
    PtyLimits {
        max_output_bytes: 65_536,
        max_runtime: Duration::from_secs(30),
    }
}

#[test]
fn sandbox_confines_to_allowed_dir() {
    std::env::remove_var("PEAR_BRIDGE_NO_SANDBOX");

    // A granted dir UNDER the real home, so "outside" reads/writes target real
    // user data (which the sandbox must block).
    let real_home = std::env::var("HOME").expect("HOME");
    let base = std::fs::canonicalize(&real_home).expect("canonicalize home");
    let allowed = base.join(format!(".pear-bridge-confine-{}", std::process::id()));
    std::fs::create_dir_all(&allowed).unwrap();
    std::fs::write(allowed.join("inside.txt"), "secret-inside").unwrap();
    let dirs = vec![allowed.clone()];
    let sh = "/bin/sh";

    // 1. Read a file INSIDE the granted dir → allowed.
    let out = run_command("cat inside.txt", Some(&allowed), sh, &limits(), &dirs).unwrap();
    assert!(
        out.output.contains("secret-inside"),
        "read inside the jail should work, got: {:?}",
        out.output
    );

    // 2. Write INSIDE → allowed and visible on disk.
    let out = run_command(
        "echo wrote > made.txt && cat made.txt",
        Some(&allowed),
        sh,
        &limits(),
        &dirs,
    )
    .unwrap();
    assert!(
        out.output.contains("wrote"),
        "write inside the jail should work: {:?}",
        out.output
    );
    assert!(allowed.join("made.txt").exists());

    // 3. Read OUTSIDE (the real home dir listing) → denied.
    let out = run_command(
        &format!("ls '{}'", real_home),
        Some(&allowed),
        sh,
        &limits(),
        &dirs,
    )
    .unwrap();
    assert!(
        out.exit_code != Some(0) || out.output.to_lowercase().contains("not permitted"),
        "listing real home should be denied, got exit={:?} out={:?}",
        out.exit_code,
        out.output
    );

    // 4. Write OUTSIDE → blocked; the file must NOT appear on disk. (Strongest,
    //    machine-independent assertion.)
    let pwn = base.join(format!("pear-bridge-pwn-{}.txt", std::process::id()));
    let _ = run_command(
        &format!("echo pwned > '{}'", pwn.display()),
        Some(&allowed),
        sh,
        &limits(),
        &dirs,
    )
    .unwrap();
    let escaped = pwn.exists();
    if escaped {
        let _ = std::fs::remove_file(&pwn);
    }
    assert!(
        !escaped,
        "SANDBOX BREACH: command wrote outside the jail at {}",
        pwn.display()
    );

    let _ = std::fs::remove_dir_all(&allowed);
    let _ = Path::new(&allowed); // silence unused on some toolchains
}
