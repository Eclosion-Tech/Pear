//! Optional worktree-per-session: isolate an engine's edits on its own branch
//! (`agent/{short-session-id}`) in a worktree under the session dir, leaving
//! the user's checkout untouched. The worktree is a work product — it is NOT
//! removed on session end; the user merges or discards it with normal git.

use std::path::{Path, PathBuf};

/// Create a worktree for `session_id` off the repo at `repo_dir`. Returns the
/// worktree path to use as the session cwd. Errors if `repo_dir` is not a git
/// repository or the branch already exists.
pub fn create(repo_dir: &str, session_dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    let path = session_dir.join("worktree");
    let short = &session_id[..session_id.len().min(8)];
    let branch = format!("agent/{short}");
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(["worktree", "add", "-b", &branch])
        .arg(&path)
        .output()
        .map_err(|e| format!("git worktree add: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join("pear-desktop-tests")
            .join(format!("{name}-{}", uuid::Uuid::new_v4()))
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn creates_worktree_on_agent_branch() {
        let repo = temp_dir("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root"]);

        let session_dir = temp_dir("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let wt = create(repo.to_str().unwrap(), &session_dir, "abcdef12-3456")
            .expect("create worktree");

        assert!(wt.join(".git").exists());
        let head = std::process::Command::new("git")
            .arg("-C")
            .arg(&wt)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&head.stdout).trim(),
            "agent/abcdef12"
        );

        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["worktree", "remove", "--force"])
            .arg(&wt)
            .output();
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&session_dir);
    }

    #[test]
    fn errors_outside_a_git_repo() {
        let not_repo = temp_dir("plain");
        std::fs::create_dir_all(&not_repo).unwrap();
        let session_dir = temp_dir("session");
        std::fs::create_dir_all(&session_dir).unwrap();

        let err = create(not_repo.to_str().unwrap(), &session_dir, "s1").unwrap_err();
        assert!(err.contains("git worktree add failed"), "{err}");

        let _ = std::fs::remove_dir_all(&not_repo);
        let _ = std::fs::remove_dir_all(&session_dir);
    }
}
