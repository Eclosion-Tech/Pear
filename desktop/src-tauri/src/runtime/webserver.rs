//! Next standalone web server for local workspace mode.
//!
//! Dev builds run `web/.next/standalone/web/server.js` from the repo checkout
//! (pnpm-workspace standalone layout, same as web/Dockerfile) with system
//! Node. `next build` does NOT copy static assets into the standalone tree —
//! we mirror the Dockerfile's copy steps on first start. Packaged builds will
//! ship the standalone tree as a Tauri resource.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn which(bin: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|d| d.join(bin))
        .find(|p| p.is_file())
}

/// Recursive copy (small trees: .next/static + public).
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn ensure_static_assets(web_dir: &Path, standalone_web: &Path) -> Result<(), String> {
    // Dockerfile parity: .next/static → standalone/web/.next/static,
    // public → standalone/web/public.
    let static_src = web_dir.join(".next/static");
    let static_dst = standalone_web.join(".next/static");
    if static_src.is_dir() && !static_dst.is_dir() {
        copy_dir(&static_src, &static_dst).map_err(|e| format!("copy static assets: {e}"))?;
    }
    let public_src = web_dir.join("public");
    let public_dst = standalone_web.join("public");
    if public_src.is_dir() && !public_dst.is_dir() {
        copy_dir(&public_src, &public_dst).map_err(|e| format!("copy public assets: {e}"))?;
    }
    Ok(())
}

/// Start the standalone web server on 127.0.0.1:{port}. Returns the pid.
pub fn start(logs: &Path, port: u16, _stdb_port: u16) -> Result<u32, String> {
    let node = which("node").ok_or("node not found on PATH — install Node.js ≥ 18")?;
    let repo = crate::paths::pear_repo_dir();
    let web_dir = repo.join("web");
    let standalone_web = web_dir.join(".next/standalone/web");
    let server_js = standalone_web.join("server.js");
    if !server_js.is_file() {
        return Err(
            "web standalone build not found — run `pnpm --filter @pear/web build` in the pear \
             repo first (packaged builds will ship it built-in)"
                .to_string(),
        );
    }
    ensure_static_assets(&web_dir, &standalone_web)?;

    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("web.log"))
        .map_err(|e| e.to_string())?;
    let err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(node);
    cmd.arg(&server_js)
        .current_dir(&standalone_web)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        // The workspace target comes from the launcher's bootstrap query
        // params, not baked env — these just keep server-side defaults sane.
        .env("NODE_ENV", "production")
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("web server failed to spawn: {e}"))?;
    Ok(child.id())
}
