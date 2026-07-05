//! OS-level filesystem confinement for command execution.
//!
//! The allowlist + CWD jail are NOT a filesystem boundary: a command's
//! *arguments* (`ls /Users/you`, `cat ~/.ssh/id_rsa`) are not jailed, so an
//! allowlisted command can read/write anywhere the daemon's user can. This
//! module adds the real boundary — commands run wrapped in an OS sandbox that
//! denies reading file contents / listing directories / writing **user data**
//! outside the granted `allowed_directories`, while still permitting the system
//! access needed to run programs.
//!
//! Platforms:
//! * **macOS** — `sandbox-exec` with a generated SBPL profile (always present).
//! * **Linux** — `bubblewrap` (`bwrap`) if installed.
//! * **Other / unavailable** — fail closed: the caller refuses to run the
//!   command rather than run it unconfined (unless the operator sets the
//!   `PEAR_BRIDGE_NO_SANDBOX` escape hatch, handled by the caller).
//!
//! Companion: `HOME` is redirected to the primary allowed dir so tools read
//! their config from inside the jail (empty → defaults) instead of hitting — and
//! leaking — the real home (`~/.npmrc`, `~/.ssh`, `~/.gitconfig`).

use std::path::PathBuf;

/// A sandboxed command invocation: spawn `program` with `args` (which end with
/// `<shell> -c <command>`) instead of the shell directly. `home` is the HOME to
/// run with.
pub struct Sandboxed {
    pub program: String,
    pub args: Vec<String>,
    pub home: PathBuf,
}

/// Wrap `<shell> -c <command>` in an OS sandbox confined to `allowed_dirs`
/// (must be non-empty, absolute, canonical). `Err` on a platform with no
/// supported sandbox so the caller can fail closed.
pub fn wrap(shell: &str, command: &str, allowed_dirs: &[PathBuf]) -> Result<Sandboxed, String> {
    let home = allowed_dirs
        .first()
        .cloned()
        .ok_or_else(|| "no allowed directory to confine to".to_string())?;

    #[cfg(target_os = "macos")]
    {
        let args = vec![
            "-p".to_string(),
            macos_profile(allowed_dirs),
            shell.to_string(),
            "-c".to_string(),
            command.to_string(),
        ];
        Ok(Sandboxed {
            program: "/usr/bin/sandbox-exec".to_string(),
            args,
            home,
        })
    }

    #[cfg(target_os = "linux")]
    {
        let Some(bwrap) = which("bwrap") else {
            return Err(
                "filesystem confinement requires bubblewrap (bwrap) on Linux; install it \
                 (e.g. `apt install bubblewrap`) or set PEAR_BRIDGE_NO_SANDBOX=1 to run unconfined"
                    .to_string(),
            );
        };
        // Read-only-bind the system dirs needed to run programs; writable-bind
        // the granted dirs; a private /tmp. Home and other user data are NOT
        // bound, so they are invisible inside the sandbox.
        let mut args: Vec<String> = Vec::new();
        for ro in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"] {
            if std::path::Path::new(ro).exists() {
                args.push("--ro-bind".into());
                args.push(ro.into());
                args.push(ro.into());
            }
        }
        args.push("--proc".into());
        args.push("/proc".into());
        args.push("--dev".into());
        args.push("/dev".into());
        args.push("--tmpfs".into());
        args.push("/tmp".into());
        args.push("--die-with-parent".into());
        for d in allowed_dirs {
            let s = d.to_string_lossy().to_string();
            args.push("--bind".into());
            args.push(s.clone());
            args.push(s);
        }
        args.push("--setenv".into());
        args.push("HOME".into());
        args.push(home.to_string_lossy().to_string());
        args.push(shell.to_string());
        args.push("-c".to_string());
        args.push(command.to_string());
        Ok(Sandboxed {
            program: bwrap.to_string_lossy().to_string(),
            args,
            home,
        })
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (shell, command);
        Err("filesystem confinement is not supported on this platform".to_string())
    }
}

/// Generate the SBPL profile: deny read-contents + write to user data
/// (`/Users`, `/Volumes`) — but NOT metadata, so directory traversal and tools
/// like `git` still work — then re-allow read+write within the granted dirs.
/// Validated live: granted dirs read/write/git work; `ls ~`, `cat ~/.zshrc`,
/// writes to home are denied. SBPL precedence: a more-specific-operation deny
/// beats a family allow, so the granted-dir allow uses the same `file-read-data`
/// specificity as the deny to override it.
#[cfg(target_os = "macos")]
fn macos_profile(allowed_dirs: &[PathBuf]) -> String {
    let mut p = String::from(
        "(version 1)(allow default)\
         (deny file-read-data file-write* (subpath \"/Users\") (subpath \"/Volumes\"))\
         (allow file-read-data file-write*",
    );
    for d in allowed_dirs {
        p.push_str(" (subpath \"");
        p.push_str(&sbpl_escape(&d.to_string_lossy()));
        p.push_str("\")");
    }
    p.push(')');
    p
}

#[cfg(target_os = "macos")]
fn sbpl_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "linux")]
fn which(bin: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            let p = dir.join(bin);
            if p.is_file() {
                Some(p)
            } else {
                None
            }
        })
    })
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn profile_denies_users_and_allows_granted_dir() {
        let dirs = vec![PathBuf::from("/Users/me/proj")];
        let p = macos_profile(&dirs);
        assert!(p.contains("(deny file-read-data file-write* (subpath \"/Users\")"));
        assert!(p.contains("(allow file-read-data file-write* (subpath \"/Users/me/proj\"))"));
    }

    #[test]
    fn wrap_targets_sandbox_exec_with_command_last() {
        let s = wrap("/bin/zsh", "ls -la", &[PathBuf::from("/Users/me/proj")]).unwrap();
        assert_eq!(s.program, "/usr/bin/sandbox-exec");
        assert_eq!(s.args.last().unwrap(), "ls -la");
        assert_eq!(s.args[s.args.len() - 2], "-c");
        assert_eq!(s.home, PathBuf::from("/Users/me/proj"));
    }

    #[test]
    fn sbpl_escape_handles_quotes_and_backslashes() {
        assert_eq!(sbpl_escape(r#"/a/b"c\d"#), r#"/a/b\"c\\d"#);
    }
}
