//! SpacetimeDB process management for local workspace mode.
//!
//! The binary is located on PATH (deliberately not bundled — BSL
//! redistribution posture; download-on-first-run is a packaged-build
//! follow-up). Data dir lives under app data and persists across restarts.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn locate() -> Result<PathBuf, String> {
    which("spacetime").ok_or_else(|| {
        "spacetime CLI not found on PATH — install it from https://spacetimedb.com/install \
         and restart the app"
            .to_string()
    })
}

fn which(bin: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|d| d.join(bin))
        .find(|p| p.is_file())
}

fn log_file(logs: &Path, name: &str) -> Result<std::fs::File, String> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join(name))
        .map_err(|e| e.to_string())
}

/// Start `spacetime start` on 127.0.0.1:{port} with a persistent data dir.
/// Returns the child's pid (its own process group, for group TERM on stop).
pub fn start(data_dir: &Path, logs: &Path, port: u16) -> Result<u32, String> {
    let bin = locate()?;
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let log = log_file(logs, "stdb.log")?;
    let err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(bin);
    cmd.arg("start")
        .arg("--listen-addr")
        .arg(format!("127.0.0.1:{port}"))
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--non-interactive")
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
        .map_err(|e| format!("spacetime start failed to spawn: {e}"))?;
    Ok(child.id())
}

/// Publish the pear module to the local instance (idempotent update).
/// Dev builds: prefer a prebuilt wasm in the repo target dir (fast), else
/// build-and-publish from `server/spacetimedb` (first run compiles the
/// module — minutes, surfaced in the launcher progress line).
pub fn publish(port: u16, db_name: &str, logs: &Path) -> Result<(), String> {
    let bin = locate()?;
    let repo = crate::paths::pear_repo_dir();
    let module_dir = repo.join("server/spacetimedb");
    let prebuilt = find_prebuilt_wasm(&module_dir);

    let log = log_file(logs, "publish.log")?;
    let err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(bin);
    cmd.arg("publish")
        .arg("--server")
        .arg(format!("http://127.0.0.1:{port}"))
        // Same policy as the self-host docker entrypoint: allow rolling the
        // module forward on an existing local db.
        .arg("--break-clients")
        .arg("--yes");
    match &prebuilt {
        Some(wasm) => {
            cmd.arg("--bin-path").arg(wasm);
        }
        None => {
            cmd.arg("--module-path").arg(&module_dir);
        }
    }
    cmd.arg(db_name)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err);

    let status = cmd
        .status()
        .map_err(|e| format!("spacetime publish failed to spawn: {e}"))?;
    if !status.success() {
        return Err(format!(
            "spacetime publish failed (see local-workspace/logs/publish.log){}",
            if prebuilt.is_none() {
                " — building the module from source requires the Rust wasm toolchain"
            } else {
                ""
            }
        ));
    }
    Ok(())
}

/// Newest wasm under the module's release target dir, if any.
fn find_prebuilt_wasm(module_dir: &Path) -> Option<PathBuf> {
    let release = module_dir.join("target/wasm32-unknown-unknown/release");
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(release).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("wasm") {
            continue;
        }
        let modified = entry.metadata().ok()?.modified().ok()?;
        if best.as_ref().is_none_or(|(t, _)| modified > *t) {
            best = Some((modified, path));
        }
    }
    best.map(|(_, p)| p)
}
