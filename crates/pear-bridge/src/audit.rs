//! The local, append-only, tamper-evident audit log (`PEAR_BRIDGE.md` § Security,
//! Layer 5).
//!
//! Every command execution is recorded in two places; this module is the second:
//! a newline-delimited JSON file (default `~/.local/share/pear-bridge/audit.log`)
//! written by the bridge **before** the command is relayed to the PTY. Writing
//! before execution means that even if the relay or the machine dies mid-command,
//! there is a durable local record that the command was about to run.
//!
//! ## Hash chain
//!
//! Each entry carries `prev_hash` (the previous entry's `self_hash`) and
//! `self_hash` (the SHA-256 of this entry's content, with `prev_hash` included
//! and `self_hash` itself excluded). The first entry's `prev_hash` is
//! [`GENESIS_HASH`]. Because each `self_hash` covers the `prev_hash`, editing or
//! deleting any earlier entry breaks every link after it — [`verify`] walks the
//! file and reports the first broken link, backing the `pear-bridge verify-audit`
//! subcommand (the CLI wiring lands with `main.rs`).
//!
//! The hash is computed over a canonical JSON form (keys sorted, `self_hash`
//! removed) so that write-time and verify-time hashing are byte-identical
//! regardless of struct field order.

use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The chain root: the `prev_hash` of the very first entry. `sha256:` followed
/// by 64 zeros.
pub const GENESIS_HASH: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";

/// The default local audit-log path: `$XDG_DATA_HOME/pear-bridge/audit.log`,
/// falling back to `$HOME/.local/share/pear-bridge/audit.log` (`PEAR_BRIDGE.md`
/// Layer 5).
pub fn default_audit_path() -> PathBuf {
    audit_path_from(
        std::env::var("XDG_DATA_HOME").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

/// Pure path builder behind [`default_audit_path`], for testing without mutating
/// process environment variables.
pub fn audit_path_from(xdg_data_home: Option<&str>, home: Option<&str>) -> PathBuf {
    let base = match xdg_data_home {
        Some(x) if !x.is_empty() => PathBuf::from(x),
        _ => PathBuf::from(home.unwrap_or("."))
            .join(".local")
            .join("share"),
    };
    base.join("pear-bridge").join("audit.log")
}

/// One audit log line. Field set matches `PEAR_BRIDGE.md` Layer 5.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AuditEntry {
    /// RFC 3339 timestamp, supplied by the caller.
    pub ts: String,
    pub device_id: String,
    pub session_id: u64,
    pub command_id: u64,
    pub server: String,
    pub requested_by_identity: String,
    pub conversation_id: u64,
    pub command: String,
    pub cwd: Option<String>,
    /// "allowed" | "denied" | "awaiting_confirmation".
    pub allowlist_result: String,
    /// Command kind: `None` ≡ "bash" (and for all pre-kind log lines);
    /// "inference" for provider-adapter runs. Skipped when `None` so the
    /// canonical JSON — and therefore the hash chain — of legacy entries is
    /// byte-identical to what older binaries wrote.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The previous entry's `self_hash`, or [`GENESIS_HASH`] for the first entry.
    pub prev_hash: String,
    /// SHA-256 of this entry's canonical content (see module docs).
    pub self_hash: String,
}

/// The content of an entry to append — everything except the chain hashes, which
/// [`AuditLog::append`] fills in.
#[derive(Clone, Debug)]
pub struct NewAuditRecord {
    pub ts: String,
    pub device_id: String,
    pub session_id: u64,
    pub command_id: u64,
    pub server: String,
    pub requested_by_identity: String,
    pub conversation_id: u64,
    pub command: String,
    pub cwd: Option<String>,
    pub allowlist_result: String,
    /// See [`AuditEntry::kind`]. `None` for bash commands.
    pub kind: Option<String>,
}

/// Append-only writer that maintains the hash chain across appends and across
/// process restarts (it reads the last entry's `self_hash` on [`AuditLog::open`]).
pub struct AuditLog {
    path: PathBuf,
    last_hash: String,
}

impl AuditLog {
    /// Open (creating parent dirs and the file lazily) and resume the chain from
    /// the last entry. A missing or empty file starts at [`GENESIS_HASH`].
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let last_hash = match fs::read_to_string(&path) {
            Ok(contents) => match contents.lines().filter(|l| !l.trim().is_empty()).last() {
                Some(line) => {
                    let last: AuditEntry = serde_json::from_str(line)
                        .map_err(|e| io::Error::new(ErrorKind::InvalidData, e))?;
                    last.self_hash
                }
                None => GENESIS_HASH.to_string(),
            },
            Err(e) if e.kind() == ErrorKind::NotFound => GENESIS_HASH.to_string(),
            Err(e) => return Err(e),
        };
        Ok(AuditLog { path, last_hash })
    }

    /// The hash the next appended entry will chain from. Equals [`GENESIS_HASH`]
    /// for a fresh log.
    pub fn last_hash(&self) -> &str {
        &self.last_hash
    }

    /// Append a record, computing its chain hashes and writing one JSON line.
    /// Returns the fully-populated entry that was written.
    pub fn append(&mut self, rec: NewAuditRecord) -> io::Result<AuditEntry> {
        let mut entry = AuditEntry {
            ts: rec.ts,
            device_id: rec.device_id,
            session_id: rec.session_id,
            command_id: rec.command_id,
            server: rec.server,
            requested_by_identity: rec.requested_by_identity,
            conversation_id: rec.conversation_id,
            command: rec.command,
            cwd: rec.cwd,
            allowlist_result: rec.allowlist_result,
            kind: rec.kind,
            prev_hash: self.last_hash.clone(),
            self_hash: String::new(),
        };
        entry.self_hash = compute_self_hash(&entry);

        let line =
            serde_json::to_string(&entry).map_err(|e| io::Error::new(ErrorKind::InvalidData, e))?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(file, "{line}")?;
        file.flush()?;

        self.last_hash = entry.self_hash.clone();
        Ok(entry)
    }
}

/// Compute an entry's `self_hash`: `sha256:` + hex SHA-256 over the canonical
/// JSON of the entry with the `self_hash` key removed (and `prev_hash` kept).
/// Pure; used by both append and verify so the two always agree.
pub fn compute_self_hash(entry: &AuditEntry) -> String {
    // Go through serde_json::Value so the key set is canonical (serde_json's
    // default Map is a sorted BTreeMap) and independent of struct field order.
    let mut value = serde_json::to_value(entry).expect("AuditEntry serializes");
    if let Some(obj) = value.as_object_mut() {
        obj.remove("self_hash");
    }
    let canonical = serde_json::to_string(&value).expect("Value serializes");
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

/// The outcome of walking a log file's hash chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyResult {
    /// The chain is intact across `entries` records (0 for an empty log).
    Ok { entries: usize },
    /// The chain is broken. `line` is 1-based; `reason` explains the first break.
    Broken { line: usize, reason: String },
}

/// Walk the hash chain in `path` and report whether it is intact, or the first
/// broken link. A missing or empty file verifies as `Ok { entries: 0 }`.
pub fn verify(path: impl AsRef<Path>) -> io::Result<VerifyResult> {
    let contents = match fs::read_to_string(path.as_ref()) {
        Ok(c) => c,
        Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };

    let mut expected_prev = GENESIS_HASH.to_string();
    let mut count = 0usize;

    for (idx, raw) in contents.lines().enumerate() {
        let line_no = idx + 1;
        if raw.trim().is_empty() {
            continue;
        }
        let entry: AuditEntry = match serde_json::from_str(raw) {
            Ok(e) => e,
            Err(e) => {
                return Ok(VerifyResult::Broken {
                    line: line_no,
                    reason: format!("not valid JSON for an audit entry: {e}"),
                })
            }
        };

        if entry.prev_hash != expected_prev {
            return Ok(VerifyResult::Broken {
                line: line_no,
                reason: format!(
                    "prev_hash {} does not match the previous entry's self_hash {}",
                    entry.prev_hash, expected_prev
                ),
            });
        }

        let recomputed = compute_self_hash(&entry);
        if recomputed != entry.self_hash {
            return Ok(VerifyResult::Broken {
                line: line_no,
                reason: format!(
                    "self_hash mismatch: stored {}, recomputed {} (entry content was altered)",
                    entry.self_hash, recomputed
                ),
            });
        }

        expected_prev = entry.self_hash;
        count += 1;
    }

    Ok(VerifyResult::Ok { entries: count })
}
