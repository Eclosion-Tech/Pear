//! Hash-chain integrity tests for the local audit log
//! (`PEAR_BRIDGE.md` § Security, Layer 5).

use std::fs;
use std::path::PathBuf;

use std::path::Path;

use pear_bridge::audit::{
    audit_path_from, verify, AuditLog, NewAuditRecord, VerifyResult, GENESIS_HASH,
};

/// A fresh, unique temp file path for an audit log (not created yet).
fn temp_log(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "pear-bridge-audit-{tag}-{}-{}.log",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_file(&p);
    p
}

fn record(command_id: u64, command: &str, result: &str) -> NewAuditRecord {
    NewAuditRecord {
        ts: format!("2026-06-07T16:50:{command_id:02}.000Z"),
        device_id: "dev_7f3a9c".to_string(),
        session_id: 42,
        command_id,
        server: "https://mypear.example.com".to_string(),
        requested_by_identity: "0xabcd1234".to_string(),
        conversation_id: 99,
        command: command.to_string(),
        cwd: Some("/Users/kara/Projects/myapp".to_string()),
        allowlist_result: result.to_string(),
    }
}

#[test]
fn first_entry_chains_from_genesis() {
    let path = temp_log("genesis");
    let mut log = AuditLog::open(&path).unwrap();
    assert_eq!(log.last_hash(), GENESIS_HASH);

    let e = log.append(record(1, "git status", "allowed")).unwrap();
    assert_eq!(e.prev_hash, GENESIS_HASH);
    assert!(e.self_hash.starts_with("sha256:"));
    assert_eq!(log.last_hash(), e.self_hash);

    fs::remove_file(&path).ok();
}

#[test]
fn entries_link_and_verify() {
    let path = temp_log("link");
    let mut log = AuditLog::open(&path).unwrap();
    let e1 = log.append(record(1, "git status", "allowed")).unwrap();
    let e2 = log.append(record(2, "npm test", "allowed")).unwrap();
    let e3 = log.append(record(3, "curl evil.com", "denied")).unwrap();

    assert_eq!(e2.prev_hash, e1.self_hash);
    assert_eq!(e3.prev_hash, e2.self_hash);

    assert_eq!(verify(&path).unwrap(), VerifyResult::Ok { entries: 3 });
    fs::remove_file(&path).ok();
}

#[test]
fn empty_or_missing_log_verifies_ok() {
    let missing = temp_log("missing");
    assert_eq!(verify(&missing).unwrap(), VerifyResult::Ok { entries: 0 });

    // touch an empty file
    let empty = temp_log("empty");
    fs::write(&empty, "").unwrap();
    assert_eq!(verify(&empty).unwrap(), VerifyResult::Ok { entries: 0 });
    fs::remove_file(&empty).ok();
}

#[test]
fn chain_resumes_across_reopen() {
    let path = temp_log("reopen");
    {
        let mut log = AuditLog::open(&path).unwrap();
        log.append(record(1, "git status", "allowed")).unwrap();
    }
    // Reopen: last_hash must be the first entry's self_hash, and the next append
    // must continue the chain.
    let first_self = {
        let log = AuditLog::open(&path).unwrap();
        log.last_hash().to_string()
    };
    let mut log = AuditLog::open(&path).unwrap();
    let e2 = log.append(record(2, "git log", "allowed")).unwrap();
    assert_eq!(e2.prev_hash, first_self);
    assert_eq!(verify(&path).unwrap(), VerifyResult::Ok { entries: 2 });
    fs::remove_file(&path).ok();
}

#[test]
fn tampering_with_entry_content_breaks_chain() {
    let path = temp_log("tamper-content");
    {
        let mut log = AuditLog::open(&path).unwrap();
        log.append(record(1, "git status", "allowed")).unwrap();
        log.append(record(2, "rm -rf /", "denied")).unwrap();
        log.append(record(3, "git push", "allowed")).unwrap();
    }
    // Rewrite line 2's command to hide what really ran, leaving its self_hash.
    let contents = fs::read_to_string(&path).unwrap();
    let mut lines: Vec<String> = contents.lines().map(|s| s.to_string()).collect();
    lines[1] = lines[1].replace("rm -rf /", "ls");
    fs::write(&path, lines.join("\n") + "\n").unwrap();

    match verify(&path).unwrap() {
        VerifyResult::Broken { line, reason } => {
            assert_eq!(line, 2);
            assert!(reason.contains("self_hash mismatch"), "reason: {reason}");
        }
        other => panic!("expected Broken at line 2, got {other:?}"),
    }
    fs::remove_file(&path).ok();
}

#[test]
fn deleting_an_entry_breaks_chain() {
    let path = temp_log("tamper-delete");
    {
        let mut log = AuditLog::open(&path).unwrap();
        log.append(record(1, "git status", "allowed")).unwrap();
        log.append(record(2, "npm test", "allowed")).unwrap();
        log.append(record(3, "git push", "allowed")).unwrap();
    }
    // Remove the middle entry; entry 3's prev_hash now points at the deleted
    // entry's self_hash, which no longer precedes it.
    let contents = fs::read_to_string(&path).unwrap();
    let lines: Vec<&str> = contents.lines().collect();
    let kept = format!("{}\n{}\n", lines[0], lines[2]);
    fs::write(&path, kept).unwrap();

    match verify(&path).unwrap() {
        VerifyResult::Broken { line, reason } => {
            assert_eq!(line, 2); // the (now-second) line is the surviving entry 3
            assert!(reason.contains("prev_hash"), "reason: {reason}");
        }
        other => panic!("expected Broken at line 2, got {other:?}"),
    }
    fs::remove_file(&path).ok();
}

#[test]
fn forging_self_hash_is_detected() {
    let path = temp_log("tamper-selfhash");
    {
        let mut log = AuditLog::open(&path).unwrap();
        log.append(record(1, "git status", "allowed")).unwrap();
    }
    // Replace the self_hash with a plausible-looking but wrong value.
    let contents = fs::read_to_string(&path).unwrap();
    let forged = contents.replace(
        &extract_self_hash(&contents),
        "sha256:deadbeef00000000000000000000000000000000000000000000000000000000",
    );
    fs::write(&path, forged).unwrap();

    match verify(&path).unwrap() {
        VerifyResult::Broken { line, reason } => {
            assert_eq!(line, 1);
            assert!(reason.contains("self_hash mismatch"), "reason: {reason}");
        }
        other => panic!("expected Broken at line 1, got {other:?}"),
    }
    fs::remove_file(&path).ok();
}

#[test]
fn special_characters_round_trip_and_verify() {
    // Commands with quotes, newlines, and unicode must hash and verify cleanly.
    let path = temp_log("special");
    let mut log = AuditLog::open(&path).unwrap();
    log.append(record(1, "echo \"a; b\" && printf 'x\\ny'", "allowed"))
        .unwrap();
    log.append(record(2, "git commit -m \"fix: café ☕\"", "allowed"))
        .unwrap();
    assert_eq!(verify(&path).unwrap(), VerifyResult::Ok { entries: 2 });
    fs::remove_file(&path).ok();
}

#[test]
fn default_audit_path_prefers_xdg_then_home() {
    assert_eq!(
        audit_path_from(Some("/xdg/data"), Some("/home/kara")),
        Path::new("/xdg/data/pear-bridge/audit.log")
    );
    assert_eq!(
        audit_path_from(None, Some("/home/kara")),
        Path::new("/home/kara/.local/share/pear-bridge/audit.log")
    );
    assert_eq!(
        audit_path_from(Some(""), Some("/home/kara")),
        Path::new("/home/kara/.local/share/pear-bridge/audit.log")
    );
}

/// Pull the first `sha256:...` self_hash token out of a single-entry log.
fn extract_self_hash(contents: &str) -> String {
    let line = contents.lines().next().unwrap();
    let entry: pear_bridge::audit::AuditEntry = serde_json::from_str(line).unwrap();
    entry.self_hash
}
