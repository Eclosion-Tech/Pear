//! The PTY execution path — runs an allowlisted command in the user's real
//! environment and enforces the runtime limits.
//!
//! Per `PEAR_BRIDGE.md` § Architecture, the bridge spawns **one PTY per
//! command** via `portable-pty` (the same crate Zed's terminal uses). A PTY —
//! rather than plain piped `std::process::Command` — is deliberate: programs see
//! a real terminal, so version managers, colorized tools, and TTY-detecting
//! commands behave the way they do in the user's own shell.
//!
//! ## Consequence: stdout and stderr are combined
//!
//! A PTY has a single output stream, so stdout and stderr are interleaved into
//! one capture — exactly as they appear in a terminal. `BridgeCommandResult`
//! has separate `stdout`/`stderr` fields; under this model the combined output
//! goes in `stdout` and `stderr` is left empty. Separating the two would mean
//! giving up the real-terminal behavior (piped `Command` with two pipes), which
//! is the whole reason for the PTY. This is a documented trade-off, not a bug.
//!
//! ## What this module enforces (Layer 4 + limits)
//!
//! * `max_output_bytes` — output is captured up to the cap; the rest is drained
//!   (so the child never blocks on a full PTY buffer) and `truncated` is set.
//! * `max_runtime` — the child is killed once the deadline passes (`timed_out`).
//! * ANSI / terminal control sequences are stripped from the captured output
//!   before it leaves this module (`PEAR_BRIDGE.md` Layer 4).
//!
//! The allowlist decision ([`crate::allowlist`]) must already have passed before
//! calling [`run_command`]; this module does not re-check it.

use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use regex::Regex;

/// Runtime limits, mirrored from `BridgeDeviceAllowlist`
/// (`max_output_bytes` / `max_runtime_seconds`).
#[derive(Debug, Clone)]
pub struct PtyLimits {
    pub max_output_bytes: usize,
    pub max_runtime: Duration,
}

impl Default for PtyLimits {
    fn default() -> Self {
        // Matches the backend defaults (max_output_bytes 65536; the v1.1 default
        // runtime was raised to 120s — see bridge::reducers::pair_bridge_device).
        PtyLimits {
            max_output_bytes: 65_536,
            max_runtime: Duration::from_secs(120),
        }
    }
}

/// The captured result of one command execution. Maps onto
/// `complete_bridge_command(exit_code, stdout, stderr, duration_ms)`:
/// `stdout = output`, `stderr = ""` (see module docs on combined streams).
#[derive(Debug, Clone)]
pub struct CommandOutput {
    /// Exit code as reported by the child. `None` only if it could not be
    /// determined. On a timeout kill this is whatever the killed process
    /// returned; consult `timed_out` for the real signal.
    pub exit_code: Option<i32>,
    /// Combined stdout+stderr, ANSI-stripped, capped at `max_output_bytes`, with
    /// a truncation marker appended if it was cut.
    pub output: String,
    /// True if output exceeded `max_output_bytes` and was cut.
    pub truncated: bool,
    /// True if the command was killed for exceeding `max_runtime`.
    pub timed_out: bool,
    /// Wall-clock duration of the run.
    pub duration: Duration,
}

/// The shell to run commands through. Defaults to `$SHELL`, falling back to
/// `sh`. Commands are executed as `<shell> -c "<command>"` so chained commands
/// (`cd X && do-thing`), pipes, and quoting behave as the user expects.
pub fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string())
}

/// Run `command` in a PTY under `shell`, optionally in `cwd`, enforcing
/// `limits`, and confined to `allowed_dirs` by an OS sandbox
/// ([`crate::sandbox`]). The command should already have cleared the allowlist.
///
/// Filesystem confinement is mandatory: if no OS sandbox is available the
/// command is refused, unless the operator sets `PEAR_BRIDGE_NO_SANDBOX` (an
/// explicit, logged escape hatch — runs commands with the daemon's full
/// filesystem access).
pub fn run_command(
    command: &str,
    cwd: Option<&Path>,
    shell: &str,
    limits: &PtyLimits,
    allowed_dirs: &[std::path::PathBuf],
) -> Result<CommandOutput, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let master = pair.master;
    let slave = pair.slave;

    // Build the (sandboxed) invocation. `HOME` is redirected to the jail when
    // sandboxed so tools don't read/leak the real home.
    let unsandboxed = std::env::var_os("PEAR_BRIDGE_NO_SANDBOX").is_some();
    let (program, args, home): (String, Vec<String>, Option<std::path::PathBuf>) = if unsandboxed {
        (
            shell.to_string(),
            vec!["-c".to_string(), command.to_string()],
            None,
        )
    } else {
        let s = crate::sandbox::wrap(shell, command, allowed_dirs)?;
        (s.program, s.args, Some(s.home))
    };

    let mut builder = CommandBuilder::new(&program);
    for a in &args {
        builder.arg(a);
    }
    // Propagate the daemon's environment (so the shell finds PATH etc.),
    // overriding HOME to the jail and ensuring a TERM for PTY-aware tools.
    for (k, v) in std::env::vars() {
        if k == "HOME" {
            continue;
        }
        builder.env(k, v);
    }
    if let Some(h) = &home {
        builder.env("HOME", h.to_string_lossy().to_string());
    }
    if std::env::var_os("TERM").is_none() {
        builder.env("TERM", "xterm-256color");
    }
    if let Some(dir) = cwd {
        builder.cwd(dir);
    }

    let mut child = slave
        .spawn_command(builder)
        .map_err(|e| format!("spawn failed: {e}"))?;

    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("could not read PTY: {e}"))?;

    // Drop the slave so that when the child exits, the read side sees EOF.
    drop(slave);

    let cap = limits.max_output_bytes;
    // Reader thread: keep the first `cap` bytes, drain the rest so the child
    // never blocks on a full PTY buffer. It writes into a SHARED buffer as it
    // reads, so the main thread can recover the captured output even if the
    // reader never unblocks (see the bounded-join note below).
    let captured: Arc<Mutex<Captured>> = Arc::new(Mutex::new(Captured::default()));
    let reader_captured = captured.clone();
    let reader_handle = std::thread::spawn(move || read_capped(reader, cap, reader_captured));

    let start = Instant::now();
    let mut timed_out = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.exit_code() as i32),
            Ok(None) => {
                if start.elapsed() >= limits.max_runtime {
                    let _ = child.kill();
                    timed_out = true;
                    // Reap; ignore the post-kill status for the code.
                    let code = child.wait().ok().map(|s| s.exit_code() as i32);
                    break code;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    };
    let duration = start.elapsed();

    // The child has exited. Drop the master to try to unblock the reader — but
    // on macOS a *cloned* PTY reader keeps its own dup'd fd and may NOT see EOF
    // when the master is dropped, leaving `read()` blocked forever. So we wait
    // only a short grace period for the reader to drain naturally, then take the
    // captured output from the shared buffer and move on rather than joining
    // indefinitely (which previously hung the whole daemon loop on commands like
    // `ls`). The reader thread is abandoned; its blocked `read()` returns when
    // the OS eventually closes the fd.
    drop(master);
    let grace = Instant::now() + Duration::from_millis(750);
    while !reader_handle.is_finished() && Instant::now() < grace {
        std::thread::sleep(Duration::from_millis(10));
    }
    let (raw, truncated) = {
        let c = captured.lock().unwrap_or_else(|e| e.into_inner());
        (c.kept.clone(), c.truncated)
    };

    let mut output = strip_ansi(&String::from_utf8_lossy(&raw));
    if truncated {
        output.push_str(&format!("\n[output truncated at {cap} bytes]"));
    }
    if timed_out {
        output.push_str(&format!(
            "\n[command timed out after {}s and was terminated]",
            limits.max_runtime.as_secs()
        ));
    }

    Ok(CommandOutput {
        exit_code,
        output,
        truncated,
        timed_out,
        duration,
    })
}

/// Output captured by the reader thread, shared with the main thread so the
/// latter can recover it even if the reader is still blocked on `read()`.
#[derive(Default)]
struct Captured {
    /// First `cap` bytes of output.
    kept: Vec<u8>,
    /// Output exceeded `cap` and was cut.
    truncated: bool,
}

/// Read from `reader` to EOF, writing the first `cap` bytes into `out` (and
/// draining the rest so the writer never blocks). Updates `out` incrementally so
/// a blocked reader still leaves the already-read output visible to the caller.
fn read_capped(mut reader: Box<dyn Read + Send>, cap: usize, out: Arc<Mutex<Captured>>) {
    let mut chunk = [0u8; 8192];
    let mut total = 0usize;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                total += n;
                let mut c = out.lock().unwrap_or_else(|e| e.into_inner());
                if c.kept.len() < cap {
                    let take = std::cmp::min(n, cap - c.kept.len());
                    c.kept.extend_from_slice(&chunk[..take]);
                }
                if total > cap {
                    c.truncated = true;
                }
            }
            // EIO is the normal way a PTY master signals the slave closed on
            // some platforms; treat any read error as end of stream.
            Err(_) => break,
        }
    }
}

/// Strip ANSI / terminal control sequences and stray control characters from
/// captured output (`PEAR_BRIDGE.md` Layer 4). Keeps newlines and tabs.
pub fn strip_ansi(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        // CSI sequences (e.g. colors, cursor moves), OSC sequences (terminated
        // by BEL or ST), and two-byte escapes.
        Regex::new(
            r"(?x)
            \x1b \[ [0-9;:?]* [ -/]* [@-~]      # CSI
            | \x1b \] [^\x07\x1b]* (?: \x07 | \x1b \\ )  # OSC ... BEL|ST
            | \x1b [@-Z\\-_]                    # two-byte escape
            ",
        )
        .expect("ANSI strip regex must compile")
    });
    let no_escapes = re.replace_all(s, "");
    // Drop remaining control chars except newline and tab (e.g. lone \r).
    no_escapes
        .chars()
        .filter(|&c| c == '\n' || c == '\t' || !c.is_control())
        .collect()
}
