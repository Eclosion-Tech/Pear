//! The `AllowlistEnforcer` — the bridge's local, in-binary enforcement point.
//!
//! This is the trust boundary described in `PEAR_BRIDGE.md` § Security, Layer 3.
//! It is re-run before every PTY call regardless of what the server sent. The
//! server is the authoritative *source* of allowlist configuration; this code is
//! the *enforcement*. A compromised server can change the config but cannot make
//! the enforcer skip a check, and it cannot remove the in-binary baseline of
//! blocked patterns.
//!
//! ## Honest framing (read this)
//!
//! Per the doc: the allowlist is a **human-configured speed bump, not a security
//! boundary.** Any allowlisted interpreter (`python3`, `node`, `ruby`, …) can
//! read anything the user can read. `npm install` runs arbitrary lifecycle
//! scripts. Command substitution (`$(...)`, backticks) is *not* parsed for an
//! inner command in v1 — `git $(curl evil)` passes the prefix check because the
//! leading token is `git`. These are inherent, documented bypasses; the enforcer
//! stops accidents and the obvious-malicious cases, not a determined or
//! prompt-injected agent. See `PEAR_BRIDGE.md` § "This is not a sandbox".
//!
//! ## Enforcement order (Layer 3)
//!
//! 1. **Prefix allowlist** — the leading command of *every* `&&`/`;`/`|`-
//!    separated segment must be in `allowed_commands` (v1 decision #1).
//!    Navigation builtins (`cd`/`pushd`/`popd`) are implicitly allowed so the
//!    documented `cd X && do-thing` single-call CWD pattern works.
//! 2. **Blocked patterns** — the full command string is tested against the
//!    in-binary baseline plus the server's additive patterns. Any match rejects.
//! 3. **CWD jail** — an explicitly requested `cwd` must canonicalize to within
//!    one of `allowed_directories`.
//! 4. **Confirmation gate** — the full command is tested against
//!    `require_confirmation_for`; a match yields [`Decision::AwaitingConfirmation`].

use std::path::{Path, PathBuf};

use regex::Regex;

/// The result of enforcing the allowlist against a single command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Cleared all checks; the bridge may execute it.
    Allow,
    /// Matched a `require_confirmation_for` entry; the bridge must hold the
    /// command in `AwaitingConfirmation` until a human confirms in the Pear UI.
    AwaitingConfirmation {
        /// The `require_confirmation_for` entry that matched.
        matched: String,
    },
    /// Blocked. `reason` is surfaced to the AI user as the rejection reason and
    /// recorded via `reject_bridge_command`.
    Reject { reason: String },
}

impl Decision {
    pub fn is_allow(&self) -> bool {
        matches!(self, Decision::Allow)
    }
    pub fn is_reject(&self) -> bool {
        matches!(self, Decision::Reject { .. })
    }
    pub fn is_awaiting_confirmation(&self) -> bool {
        matches!(self, Decision::AwaitingConfirmation { .. })
    }
}

/// How to treat a command whose leading token is not in `allowed_commands`
/// (and is not caught by the baseline-blocked floor). Mirrors the
/// `unlisted_command_policy` field on the `BridgeDeviceAllowlist` STDB row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlistedPolicy {
    /// Hard-reject unlisted commands (the original strict behavior).
    Reject,
    /// Route unlisted commands to `AwaitingConfirmation` so a human can Allow /
    /// Deny in the Pear UI. The baseline-blocked floor + CWD jail still
    /// hard-reject regardless.
    Prompt,
}

impl Default for UnlistedPolicy {
    /// Fail safe: if the server config omits the policy (e.g. an older module),
    /// behave strictly. New `BridgeDeviceAllowlist` rows default to `Prompt`.
    fn default() -> Self {
        UnlistedPolicy::Reject
    }
}

/// Allowlist configuration. Mirrors the `BridgeDeviceAllowlist` STDB row the
/// bridge fetches at connect time (see `PEAR_BRIDGE.md` § Data model). The
/// `max_output_bytes` / `max_runtime_seconds` limits live on the same row but
/// are enforced during PTY execution, not in the allow/reject decision, so they
/// are intentionally absent here.
#[derive(Debug, Clone, Default)]
pub struct AllowlistConfig {
    /// Policy for commands whose leader is not in `allowed_commands`.
    pub unlisted_policy: UnlistedPolicy,
    /// Exact command tokens permitted as a segment leader, e.g. `["git", "npm"]`.
    pub allowed_commands: Vec<String>,
    /// Server-side regex patterns rejected regardless of the allowlist. Additive
    /// to the in-binary baseline; the baseline cannot be removed by the server.
    pub blocked_patterns: Vec<String>,
    /// CWD jail. An explicitly requested `cwd` must resolve to within one of
    /// these. Empty means: no jail configured, so any *explicit* `cwd` request
    /// is rejected (fail closed — v1 decision #2: directories are chosen at pair
    /// time, never defaulted to unrestricted).
    pub allowed_directories: Vec<String>,
    /// Substrings that require human confirmation before execution, e.g.
    /// `["git push", "npm publish"]`.
    pub require_confirmation_for: Vec<String>,
}

/// Navigation builtins always permitted as a segment leader. The CWD jail (not
/// the command allowlist) is the control on *where* a command may run; without
/// these the documented `cd X && do-thing` pattern — the only way to carry CWD
/// state in the stateless one-PTY-per-command model — could not work.
///
/// NOTE (v1 gap, see `PEAR_BRIDGE.md` Open questions): the jail validates the
/// requested `cwd` argument, not a `cd` *inside* the command line. `cd /etc &&
/// cat hosts` is not jail-blocked by this enforcer. This matches the doc's
/// "jail is a guardrail, not a filesystem boundary" framing but should be
/// tightened if/when cd-target inspection is added.
const NAV_BUILTINS: &[&str] = &["cd", "pushd", "popd"];

/// Commands that *launch another command* and whose own arguments we can skip to
/// re-check the real command. Deliberately minimal: only wrappers of the shape
/// `WRAPPER [VAR=val | -flags]... <command> ...` with no positional argument
/// before the command. This closes `env curl …` (wrapped command re-checked and
/// rejected) while keeping `env VAR=1 git …` working.
///
/// Excluded on purpose: `sudo`/`doas` (must stay rejected, never recursed into),
/// and arg-taking wrappers like `timeout`/`nice`/`xargs`/`watch` (not on the
/// default allowlist anyway, so they reject as a leader; if a user allowlists
/// one, the wrapped command is not re-checked — a documented limitation).
const EXEC_WRAPPERS: &[&str] = &["env", "command", "nohup", "setsid"];

/// The in-binary baseline of blocked patterns. Applied unconditionally and
/// additively to the server's `blocked_patterns`; the server cannot remove these
/// (`PEAR_BRIDGE.md` § Security, Layer 3). These are mostly defense-in-depth
/// behind the prefix allowlist (e.g. `sudo`/`rm` are not on the default
/// allowlist and reject at the prefix check first), but they hold even if a user
/// allowlists an interpreter — e.g. `… | sh` stays blocked even with `sh`
/// allowed.
const BASELINE_BLOCKED_PATTERNS: &[&str] = &[
    r"\brm\s+-[a-z]*r[a-z]*f\b", // rm -rf / -fr / -Rf etc.
    r"\brm\s+-[a-z]*f[a-z]*r\b",
    r"\bsudo\b",
    r"\bdoas\b",
    r"\bchmod\s+[0-7]*7[0-7][0-7]\b", // world-writable/exec bits, e.g. 777
    // Pipe into any interpreter — v1 decision #1 extension. Covers the doc's
    // explicit `curl … | sh` / `wget … | sh` and generalizes them.
    r"\|\s*(sh|bash|zsh|dash|ksh|fish|python3?|node|ruby|perl|php)\b",
    // Classic fork bomb: :(){ :|:& };:
    r":\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*&[^}]*\}",
];

/// The local enforcement core. Construct once per connect (regexes compile
/// here), then call [`AllowlistEnforcer::enforce`] per command.
pub struct AllowlistEnforcer {
    allowed_commands: Vec<String>,
    blocked: Vec<Regex>,
    /// Canonicalized allowed directories. Entries that do not currently resolve
    /// on disk are dropped (and noted in [`AllowlistEnforcer::warnings`]).
    allowed_dirs: Vec<PathBuf>,
    require_confirmation_for: Vec<String>,
    unlisted_policy: UnlistedPolicy,
    /// Non-fatal construction notes (e.g. an invalid server regex, or an
    /// allowed directory that does not exist). The bridge should log these.
    pub warnings: Vec<String>,
}

impl AllowlistEnforcer {
    /// Build an enforcer from a config. Never fails: an invalid server-supplied
    /// regex or a non-existent allowed directory is skipped and recorded in
    /// [`AllowlistEnforcer::warnings`] rather than bricking the bridge. The
    /// baseline patterns are constants and are expected to always compile.
    pub fn new(config: AllowlistConfig) -> Self {
        let mut warnings = Vec::new();
        let mut blocked = Vec::new();

        for pat in BASELINE_BLOCKED_PATTERNS {
            match Regex::new(pat) {
                Ok(re) => blocked.push(re),
                // A broken baseline constant is a programming error; surface it
                // loudly rather than silently weakening the baseline.
                Err(e) => warnings.push(format!(
                    "BUG: baseline pattern {pat:?} failed to compile: {e}"
                )),
            }
        }
        for pat in &config.blocked_patterns {
            match Regex::new(pat) {
                Ok(re) => blocked.push(re),
                Err(e) => warnings.push(format!(
                    "ignoring invalid server blocked_pattern {pat:?}: {e}"
                )),
            }
        }

        let mut allowed_dirs = Vec::new();
        for dir in &config.allowed_directories {
            // Server-side config commonly says `~/Projects/...`; Rust's
            // canonicalize does NOT expand tilde, which used to silently drop
            // the entry — shrinking the jail and leaving the device with no
            // usable directories at all when every entry was tilde-prefixed.
            let dir = expand_tilde(dir);
            match std::fs::canonicalize(&dir) {
                Ok(p) => allowed_dirs.push(p),
                Err(e) => warnings.push(format!(
                    "allowed directory {dir:?} does not resolve, ignoring: {e}"
                )),
            }
        }

        AllowlistEnforcer {
            allowed_commands: config.allowed_commands,
            blocked,
            allowed_dirs,
            require_confirmation_for: config.require_confirmation_for,
            unlisted_policy: config.unlisted_policy,
            warnings,
        }
    }

    /// The directory a command runs in when it requests no explicit `cwd`: the
    /// first configured allowed directory. This keeps commands (and any files
    /// they create) inside the jail and in a predictable place, instead of
    /// wherever the daemon process happened to be launched. `None` only if no
    /// allowed directory resolved on disk.
    pub fn primary_dir(&self) -> Option<&Path> {
        self.allowed_dirs.first().map(|p| p.as_path())
    }

    /// The canonicalized allowed directories, for the OS sandbox that confines
    /// command execution to them ([`crate::sandbox`]).
    pub fn allowed_dirs(&self) -> &[PathBuf] {
        &self.allowed_dirs
    }

    /// Decide whether `command` (optionally requesting `cwd`) may run. Pure and
    /// side-effect free except for resolving `cwd` on the filesystem.
    pub fn enforce(&self, command: &str, cwd: Option<&str>) -> Decision {
        let trimmed = command.trim();
        if trimmed.is_empty() {
            return reject("empty command");
        }

        // 1. Prefix allowlist on every segment. Under `Reject` policy an unlisted
        //    leader hard-rejects here. Under `Prompt` policy we instead remember
        //    the first unlisted leader and *defer* — the command still has to clear
        //    the baseline-blocked floor (step 2) and CWD jail (step 3), which
        //    hard-reject regardless of policy, before it can become a confirmation
        //    prompt (step 5). So `Prompt` never weakens the hard floor.
        let mut unlisted_leader: Option<String> = None;
        for segment in split_segments(trimmed) {
            match leading_command(&segment) {
                None => {
                    // A connector with nothing after it, e.g. `git status &&`.
                    return reject("malformed command: empty segment between operators");
                }
                Some(leader) => {
                    if !self.is_leader_allowed(&leader) {
                        match self.unlisted_policy {
                            UnlistedPolicy::Reject => {
                                return reject(&format!(
                                    "command '{leader}' is not in the allowed_commands list for this device"
                                ));
                            }
                            UnlistedPolicy::Prompt => {
                                if unlisted_leader.is_none() {
                                    unlisted_leader = Some(leader);
                                }
                            }
                        }
                    }
                }
            }
        }

        // 2. Blocked patterns (baseline + server), on the full command string.
        for re in &self.blocked {
            if re.is_match(trimmed) {
                return reject(&format!(
                    "command matches a blocked pattern (/{}/)",
                    re.as_str()
                ));
            }
        }

        // 3. CWD jail — only when a cwd is explicitly requested.
        if let Some(requested) = cwd {
            match std::fs::canonicalize(requested) {
                Ok(resolved) => {
                    if !within_jail(&resolved, &self.allowed_dirs) {
                        return reject(&format!(
                            "requested cwd {requested:?} is not within the allowed_directories jail"
                        ));
                    }
                }
                Err(e) => {
                    return reject(&format!(
                        "requested cwd {requested:?} does not resolve: {e}"
                    ));
                }
            }
        }

        // 4. Confirmation gate (explicit `require_confirmation_for` matches).
        for needle in &self.require_confirmation_for {
            if !needle.is_empty() && trimmed.contains(needle.as_str()) {
                return Decision::AwaitingConfirmation {
                    matched: needle.clone(),
                };
            }
        }

        // 5. Unlisted-command confirmation (Prompt policy). Reached only after the
        //    command cleared the baseline-blocked floor and the CWD jail, so this
        //    is a "not pre-approved" prompt, never a bypass of a hard block.
        if let Some(leader) = unlisted_leader {
            return Decision::AwaitingConfirmation {
                matched: format!("unlisted command: {leader}"),
            };
        }

        Decision::Allow
    }

    fn is_leader_allowed(&self, leader: &str) -> bool {
        NAV_BUILTINS.contains(&leader) || self.allowed_commands.iter().any(|c| c == leader)
    }
}

/// Expand a leading `~` / `~/` to `$HOME`. Rust's `canonicalize` does not
/// expand tilde, and server-side `allowed_directories` commonly say
/// `~/Projects/...` — without this every such entry was silently dropped,
/// shrinking the jail to nothing. Only the current user's home is supported;
/// `~other` is left as-is and fails canonicalization with a clear warning.
pub(crate) fn expand_tilde(dir: &str) -> PathBuf {
    if dir == "~" {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home);
        }
    } else if let Some(rest) = dir.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return Path::new(&home).join(rest);
        }
    }
    PathBuf::from(dir)
}

fn reject(reason: &str) -> Decision {
    Decision::Reject {
        reason: reason.to_string(),
    }
}

/// True if `cwd` is one of, or nested within, an allowed directory. Both sides
/// are expected to already be canonicalized. Pure (no filesystem access) so it
/// can be unit-tested directly.
fn within_jail(cwd: &Path, allowed: &[PathBuf]) -> bool {
    allowed.iter().any(|dir| cwd == dir || cwd.starts_with(dir))
}

/// Split a command line into command segments at top-level (unquoted) shell
/// connectors: `&&`, `||`, `;`, `|`, and background `&`. Quote-aware so that
/// connectors inside `'…'` or `"…"` (and backslash-escaped ones) are not split
/// on. Command substitution (`$(…)`, backticks) is *not* descended into — see
/// the module docs on documented bypasses.
fn split_segments(cmd: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;

    let chars: Vec<char> = cmd.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];

        if escaped {
            current.push(c);
            escaped = false;
            i += 1;
            continue;
        }
        if c == '\\' && !in_single {
            current.push(c);
            escaped = true;
            i += 1;
            continue;
        }
        if c == '\'' && !in_double {
            in_single = !in_single;
            current.push(c);
            i += 1;
            continue;
        }
        if c == '"' && !in_single {
            in_double = !in_double;
            current.push(c);
            i += 1;
            continue;
        }

        if !in_single && !in_double {
            let next = chars.get(i + 1).copied();
            match c {
                '&' if next == Some('&') => {
                    push_segment(&mut segments, &mut current);
                    i += 2;
                    continue;
                }
                '|' if next == Some('|') => {
                    push_segment(&mut segments, &mut current);
                    i += 2;
                    continue;
                }
                '|' | ';' | '&' => {
                    push_segment(&mut segments, &mut current);
                    i += 1;
                    continue;
                }
                _ => {}
            }
        }

        current.push(c);
        i += 1;
    }
    push_segment(&mut segments, &mut current);
    segments
}

fn push_segment(segments: &mut Vec<String>, current: &mut String) {
    let seg = current.trim().to_string();
    if !seg.is_empty() {
        segments.push(seg);
    }
    current.clear();
}

/// The command token that leads a segment, for the prefix-allowlist check.
/// Skips leading `VAR=val` environment assignments, and descends through a small
/// set of [`EXEC_WRAPPERS`] (e.g. `env`) so the *wrapped* command is the one
/// checked. Returns the raw token (not basenamed): `/usr/bin/git` is returned
/// as-is and so will not match the allowlist entry `git` — path-form invocations
/// are rejected by design. Returns `None` for an empty segment.
fn leading_command(segment: &str) -> Option<String> {
    let tokens = tokenize(segment);
    let mut idx = 0;
    let mut wrapper_hops = 0;

    loop {
        // Skip leading env-assignments (NAME=VALUE).
        while idx < tokens.len() && is_env_assignment(&tokens[idx]) {
            idx += 1;
        }
        let token = tokens.get(idx)?;

        if EXEC_WRAPPERS.contains(&token.as_str()) && wrapper_hops < 8 {
            // Step over the wrapper and any of its own flags, then re-evaluate
            // (handles e.g. `env -i VAR=1 git …`, `nohup setsid git …`).
            idx += 1;
            while idx < tokens.len() && tokens[idx].starts_with('-') {
                idx += 1;
            }
            // If the wrapper has no following command (e.g. bare `env` to print
            // the environment), fall through and treat the wrapper itself as the
            // leader.
            if idx >= tokens.len() {
                return Some(token.clone());
            }
            wrapper_hops += 1;
            continue;
        }

        return Some(token.clone());
    }
}

/// True if a token is a leading `NAME=VALUE` shell environment assignment.
fn is_env_assignment(token: &str) -> bool {
    match token.find('=') {
        Some(0) | None => false,
        Some(eq) => {
            let name = &token[..eq];
            let mut chars = name.chars();
            let first_ok = chars
                .next()
                .map(|c| c.is_ascii_alphabetic() || c == '_')
                .unwrap_or(false);
            first_ok && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
    }
}

/// Whitespace tokenizer that respects single/double quotes and backslash
/// escapes — enough to find a segment's leading command without a full shell
/// parser.
fn tokenize(segment: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let mut has_token = false;

    for c in segment.chars() {
        if escaped {
            current.push(c);
            escaped = false;
            has_token = true;
            continue;
        }
        if c == '\\' && !in_single {
            escaped = true;
            has_token = true;
            continue;
        }
        if c == '\'' && !in_double {
            in_single = !in_single;
            has_token = true;
            continue;
        }
        if c == '"' && !in_single {
            in_double = !in_double;
            has_token = true;
            continue;
        }
        if c.is_whitespace() && !in_single && !in_double {
            if has_token {
                tokens.push(std::mem::take(&mut current));
                has_token = false;
            }
            continue;
        }
        current.push(c);
        has_token = true;
    }
    if has_token {
        tokens.push(current);
    }
    tokens
}

#[cfg(test)]
mod policy_tests {
    use super::*;

    fn enforcer(allowed: &[&str], policy: UnlistedPolicy) -> AllowlistEnforcer {
        AllowlistEnforcer::new(AllowlistConfig {
            allowed_commands: allowed.iter().map(|s| s.to_string()).collect(),
            unlisted_policy: policy,
            ..Default::default()
        })
    }

    #[test]
    fn reject_policy_hard_rejects_unlisted() {
        let e = enforcer(&["ls"], UnlistedPolicy::Reject);
        assert!(e.enforce("pwd", None).is_reject());
    }

    #[test]
    fn prompt_policy_routes_unlisted_to_confirmation() {
        let e = enforcer(&["ls"], UnlistedPolicy::Prompt);
        let d = e.enforce("pwd", None);
        assert!(
            d.is_awaiting_confirmation(),
            "expected AwaitingConfirmation, got {d:?}"
        );
        match d {
            Decision::AwaitingConfirmation { matched } => assert!(matched.contains("pwd")),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn prompt_policy_still_allows_listed_commands() {
        let e = enforcer(&["ls"], UnlistedPolicy::Prompt);
        assert!(e.enforce("ls -la", None).is_allow());
    }

    #[test]
    fn prompt_policy_does_not_weaken_the_baseline_floor() {
        // Leader `foo` is unlisted (would prompt) but the segment pipes into an
        // interpreter — a baseline-blocked pattern. The hard floor must win:
        // this is a Reject, never a confirmation prompt.
        let e = enforcer(&["ls"], UnlistedPolicy::Prompt);
        let d = e.enforce("foo | sh", None);
        assert!(
            d.is_reject(),
            "baseline floor must hard-reject under Prompt, got {d:?}"
        );
    }

    #[test]
    fn prompt_policy_sudo_still_rejected() {
        let e = enforcer(&["ls"], UnlistedPolicy::Prompt);
        assert!(e.enforce("sudo rm x", None).is_reject());
    }
}
