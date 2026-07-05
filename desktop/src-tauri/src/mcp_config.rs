//! Per-session MCP config files.
//!
//! Each engine session gets its own `mcp.json` pointing at pear's stdio MCP
//! server with that engine's AI-user worker token in env. 0600 on unix; the
//! file is deleted when the session ends (`cleanup`). The token deliberately
//! never appears in argv (visible in `ps`) or in the webview.

use std::path::{Path, PathBuf};

pub struct McpConfigArgs<'a> {
    pub session_dir: &'a Path,
    pub spacetimedb_uri: &'a str,
    pub db_name: &'a str,
    pub worker_token: &'a str,
    pub pear_repo_dir: &'a Path,
}

pub fn write(args: &McpConfigArgs) -> Result<PathBuf, String> {
    std::fs::create_dir_all(args.session_dir).map_err(|e| e.to_string())?;
    let stdio_host = args.pear_repo_dir.join("worker/src/mcp/stdio.ts");
    // The engine (e.g. Claude Code) spawns this MCP server with the SESSION's
    // working directory — the user's project dir — NOT the pear repo. A bare
    // `--import tsx/esm` therefore resolves tsx against the wrong node_modules
    // and the server fails to start. Point `--import` at tsx's loader by
    // absolute path so resolution is cwd-independent. (Packaged builds ship a
    // bundled host in M3 and won't need tsx at all.)
    let tsx_loader = args
        .pear_repo_dir
        .join("worker/node_modules/tsx/dist/esm/index.mjs");
    let config = serde_json::json!({
        "mcpServers": {
            "pear": {
                "command": "node",
                "args": ["--import", tsx_loader.to_string_lossy(), stdio_host.to_string_lossy()],
                "env": {
                    "SPACETIMEDB_URI": args.spacetimedb_uri,
                    "SPACETIMEDB_DB_NAME": args.db_name,
                    "PEAR_MCP_TOKEN": args.worker_token,
                }
            }
        }
    });
    let path = args.session_dir.join("mcp.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&config).unwrap())
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(path)
}

pub fn cleanup(session_dir: &Path) {
    let _ = std::fs::remove_file(session_dir.join("mcp.json"));
    let _ = std::fs::remove_dir_all(session_dir.join("codex-home"));
}

/// Codex reads MCP servers from `CODEX_HOME/config.toml`, not a CLI flag.
/// Write an ephemeral CODEX_HOME under the session dir with a 0600 config.toml
/// carrying the pear MCP server (token in env only, never argv). Returns the
/// CODEX_HOME path to set on the spawn.
///
/// Two behaviors verified live against codex 0.142.5:
/// - `default_tools_approval_mode = "approve"` is REQUIRED: `codex exec`
///   auto-cancels MCP tool-approval elicitations ("user cancelled MCP tool
///   call"), so pear's tools must be pre-approved at the server level.
/// - `auth.json` also lives in CODEX_HOME, so an ephemeral home would log the
///   user out. Symlink the real auth file in — token refreshes write through,
///   and cleanup removes only the link.
pub fn write_codex_home(args: &McpConfigArgs) -> Result<PathBuf, String> {
    let home = args.session_dir.join("codex-home");
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let stdio_host = args.pear_repo_dir.join("worker/src/mcp/stdio.ts");
    // Absolute tsx loader — same cwd-independence fix as the Claude path.
    let tsx_loader = args
        .pear_repo_dir
        .join("worker/node_modules/tsx/dist/esm/index.mjs");
    // Build the TOML by hand (no toml dep): all values are strings we control
    // except the token, which we escape defensively.
    let config = format!(
        "[mcp_servers.pear]\n\
         command = \"node\"\n\
         args = [\"--import\", {tsx}, {host}]\n\
         default_tools_approval_mode = \"approve\"\n\n\
         [mcp_servers.pear.env]\n\
         SPACETIMEDB_URI = {uri}\n\
         SPACETIMEDB_DB_NAME = {db}\n\
         PEAR_MCP_TOKEN = {token}\n",
        tsx = toml_str(&tsx_loader.to_string_lossy()),
        host = toml_str(&stdio_host.to_string_lossy()),
        uri = toml_str(args.spacetimedb_uri),
        db = toml_str(args.db_name),
        token = toml_str(args.worker_token),
    );
    let path = home.join("config.toml");
    std::fs::write(&path, config).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    link_codex_auth(&home);
    Ok(home)
}

/// Symlink the user's real Codex `auth.json` into the ephemeral home so the
/// spawned codex stays logged in. Honors a user-set CODEX_HOME, else ~/.codex.
/// Best-effort: a missing auth file just means codex prompts to log in.
fn link_codex_auth(home: &Path) {
    let real_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")));
    let Some(auth) = real_home.map(|d| d.join("auth.json")) else {
        return;
    };
    if !auth.exists() {
        return;
    }
    let link = home.join("auth.json");
    let _ = std::fs::remove_file(&link);
    #[cfg(unix)]
    let _ = std::os::unix::fs::symlink(&auth, &link);
    #[cfg(windows)]
    let _ = std::fs::copy(&auth, &link);
}

/// Minimal TOML basic-string quoting (escape backslash and double-quote).
fn toml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_session_dir() -> PathBuf {
        std::env::temp_dir()
            .join("pear-desktop-tests")
            .join(uuid::Uuid::new_v4().to_string())
    }

    #[test]
    fn writes_token_only_to_env_not_argv_and_cleans_up() {
        let session_dir = temp_session_dir();
        let token = "secret-worker-token";
        let path = write(&McpConfigArgs {
            session_dir: &session_dir,
            spacetimedb_uri: "ws://localhost:3000",
            db_name: "pear-dev",
            worker_token: token,
            pear_repo_dir: Path::new("/repo/pear"),
        })
        .expect("write mcp config");

        let bytes = std::fs::read(&path).expect("read mcp config");
        let json: serde_json::Value = serde_json::from_slice(&bytes).expect("valid json");
        let server = &json["mcpServers"]["pear"];

        assert_eq!(server["command"], "node");
        assert_eq!(server["env"]["PEAR_MCP_TOKEN"], token);
        assert_eq!(server["env"]["SPACETIMEDB_URI"], "ws://localhost:3000");
        assert_eq!(server["env"]["SPACETIMEDB_DB_NAME"], "pear-dev");
        assert!(
            !server["args"].to_string().contains(token),
            "worker token must not be visible in argv"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        cleanup(&session_dir);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(session_dir);
    }

    #[test]
    fn codex_home_preapproves_tools_and_keeps_token_out_of_args() {
        let session_dir = temp_session_dir();
        let token = "secret-worker-token";
        let home = write_codex_home(&McpConfigArgs {
            session_dir: &session_dir,
            spacetimedb_uri: "ws://localhost:3000",
            db_name: "pear-dev",
            worker_token: token,
            pear_repo_dir: Path::new("/repo/pear"),
        })
        .expect("write codex home");

        let config = std::fs::read_to_string(home.join("config.toml")).expect("read config");
        // codex exec auto-cancels MCP approval elicitations — tools must be
        // pre-approved (verified live against codex 0.142.5).
        assert!(config.contains("default_tools_approval_mode = \"approve\""));
        let args_line = config
            .lines()
            .find(|l| l.starts_with("args = "))
            .expect("args line");
        assert!(
            !args_line.contains(token),
            "worker token must not be visible in argv"
        );
        assert!(config.contains(&format!("PEAR_MCP_TOKEN = \"{token}\"")));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(home.join("config.toml"))
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        cleanup(&session_dir);
        assert!(!home.exists(), "cleanup removes the whole codex-home");
        let _ = std::fs::remove_dir_all(session_dir);
    }
}
