//! IPC surface exposed to the launcher (app origin) and the embedded pear web
//! app (remote origin, gated by capabilities/remote-workspace.json).
//!
//! Keep the command list in sync with build.rs (app_manifest) and both
//! capability files.

use crate::engines::adapter::{ScribeSpec, SessionSpec};
use crate::engines::events::EngineEvent;
use crate::keychain;
use crate::mcp_config;
use crate::sessions::store::{now_ms, EngineBinding, SessionMeta};
use crate::sessions::SessionManager;
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
    pub version: Option<String>,
}

fn detect_one(id: &str, display_name: &str, bin: &str) -> EngineInfo {
    let version = Command::new(bin)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    EngineInfo {
        id: id.to_string(),
        display_name: display_name.to_string(),
        installed: version.is_some(),
        version,
    }
}

/// Detect installed agent CLIs.
#[tauri::command]
pub fn engines_detect() -> Vec<EngineInfo> {
    vec![
        detect_one("claude-code", "Claude Code", "claude"),
        detect_one("codex", "Codex", "codex"),
    ]
}

/// Bind an engine to a pear AI user for a workspace: token → keychain,
/// binding → state. The token never comes back out over IPC.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn engine_bind(
    manager: State<'_, Arc<SessionManager>>,
    engine: String,
    workspace_key: String,
    ai_user_hex: String,
    ai_user_id: u64,
    display_name: String,
    token: String,
) -> Result<(), String> {
    keychain::store_token(&workspace_key, &ai_user_hex, &token)?;
    {
        let mut state = manager.state.lock().unwrap();
        state
            .engines
            .retain(|b| !(b.engine == engine && b.workspace_key == workspace_key));
        state.engines.push(EngineBinding {
            engine,
            workspace_key,
            ai_user_hex,
            ai_user_id,
            display_name,
        });
    }
    manager.persist();
    Ok(())
}

/// Bindings for a workspace (token-free view).
#[tauri::command]
pub fn engines_bindings(
    manager: State<'_, Arc<SessionManager>>,
    workspace_key: String,
) -> Vec<EngineBinding> {
    manager
        .state
        .lock()
        .unwrap()
        .engines
        .iter()
        .filter(|b| b.workspace_key == workspace_key)
        .cloned()
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartArgs {
    pub engine: String,
    pub cwd: String,
    pub prompt: String,
    pub title: String,
    pub workspace_key: String,
    /// SpacetimeDB URI + db the MCP server should target (the web app knows
    /// its own workspace connection settings).
    pub spacetimedb_uri: String,
    pub db_name: String,
    pub permission_mode: Option<String>,
    /// Optional model override for the engine (`--model` / `-m`).
    pub model: Option<String>,
    /// Run the session in a fresh `git worktree` on branch
    /// `agent/{short-session-id}` instead of directly in `cwd`.
    pub use_worktree: Option<bool>,
}

fn binding_for(
    manager: &SessionManager,
    engine: &str,
    workspace_key: &str,
) -> Result<EngineBinding, String> {
    manager
        .state
        .lock()
        .unwrap()
        .engines
        .iter()
        .find(|b| b.engine == engine && b.workspace_key == workspace_key)
        .cloned()
        .ok_or("engine is not set up for this workspace — run the setup wizard first".to_string())
}

fn split_workspace_key(workspace_key: &str) -> Result<(&str, &str), String> {
    workspace_key
        .split_once("::")
        .ok_or("workspace key is missing SpacetimeDB URI/database name".to_string())
}

/// Write the MCP config in the shape the engine expects and return
/// `(mcp_config_path, codex_home)` for the SessionSpec. Claude uses a JSON
/// `mcp.json`; Codex uses an ephemeral `CODEX_HOME/config.toml`.
fn write_engine_mcp(
    engine: &str,
    session_dir: &std::path::Path,
    spacetimedb_uri: &str,
    db_name: &str,
    token: &str,
) -> Result<(std::path::PathBuf, Option<std::path::PathBuf>), String> {
    let cfg = mcp_config::McpConfigArgs {
        session_dir,
        spacetimedb_uri,
        db_name,
        worker_token: token,
        pear_repo_dir: &crate::paths::pear_repo_dir(),
    };
    if engine == "codex" {
        Ok((Default::default(), Some(mcp_config::write_codex_home(&cfg)?)))
    } else {
        Ok((mcp_config::write(&cfg)?, None))
    }
}

/// Default per-engine permission/sandbox mode.
fn default_permission_mode(engine: &str) -> String {
    if engine == "codex" {
        "workspace-write".to_string()
    } else {
        "acceptEdits".to_string()
    }
}

#[tauri::command]
pub fn session_start(
    manager: State<'_, Arc<SessionManager>>,
    args: SessionStartArgs,
    on_event: Channel<EngineEvent>,
) -> Result<SessionMeta, String> {
    let binding = binding_for(&manager, &args.engine, &args.workspace_key)?;

    let token = keychain::get_token(&args.workspace_key, &binding.ai_user_hex)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let session_dir = manager.paths.session_dir(&session_id);
    let (mcp_path, codex_home) = write_engine_mcp(
        &args.engine,
        &session_dir,
        &args.spacetimedb_uri,
        &args.db_name,
        &token,
    )?;

    // Worktree option: the session (and its resumes — meta.cwd) live in the
    // worktree; args.cwd is only the repo to branch from.
    let cwd = if args.use_worktree.unwrap_or(false) {
        crate::worktree::create(&args.cwd, &session_dir, &session_id)?
            .to_string_lossy()
            .into_owned()
    } else {
        args.cwd
    };

    let meta = SessionMeta {
        id: session_id.clone(),
        engine: args.engine.clone(),
        cwd: cwd.clone(),
        workspace_key: args.workspace_key,
        title: args.title,
        status: "running".to_string(),
        engine_session_id: None,
        created_at_ms: now_ms(),
        model: args.model.clone(),
        transcript_page_id: None,
    };

    let spec = SessionSpec {
        session_id,
        cwd,
        mcp_config_path: mcp_path,
        codex_home,
        prompt: args.prompt,
        permission_mode: args
            .permission_mode
            .unwrap_or_else(|| default_permission_mode(&args.engine)),
        model: args.model,
        resume_engine_session_id: None,
        scribe: Some(ScribeSpec {
            spacetimedb_uri: args.spacetimedb_uri,
            db_name: args.db_name,
            token,
        }),
    };

    let result = meta.clone();
    manager.inner().start(spec, args.engine, meta, on_event)?;
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeArgs {
    pub session_id: String,
    pub prompt: String,
    pub permission_mode: Option<String>,
}

#[tauri::command]
pub fn session_resume(
    manager: State<'_, Arc<SessionManager>>,
    args: SessionResumeArgs,
    on_event: Channel<EngineEvent>,
) -> Result<SessionMeta, String> {
    let mut meta = manager
        .state
        .lock()
        .unwrap()
        .sessions
        .iter()
        .find(|s| s.id == args.session_id)
        .cloned()
        .ok_or("session not found".to_string())?;

    let engine_session_id = meta
        .engine_session_id
        .clone()
        .ok_or("session has no engine resume id yet".to_string())?;
    let binding = binding_for(&manager, &meta.engine, &meta.workspace_key)?;
    let token = keychain::get_token(&meta.workspace_key, &binding.ai_user_hex)?;
    let (spacetimedb_uri, db_name) = split_workspace_key(&meta.workspace_key)?;
    let session_dir = manager.paths.session_dir(&meta.id);
    let (mcp_path, codex_home) =
        write_engine_mcp(&meta.engine, &session_dir, spacetimedb_uri, db_name, &token)?;

    meta.status = "running".to_string();
    let spec = SessionSpec {
        session_id: meta.id.clone(),
        cwd: meta.cwd.clone(),
        mcp_config_path: mcp_path,
        codex_home,
        prompt: args.prompt,
        permission_mode: args
            .permission_mode
            .unwrap_or_else(|| default_permission_mode(&meta.engine)),
        model: meta.model.clone(),
        resume_engine_session_id: Some(engine_session_id),
        scribe: Some(ScribeSpec {
            spacetimedb_uri: spacetimedb_uri.to_string(),
            db_name: db_name.to_string(),
            token,
        }),
    };

    let result = meta.clone();
    manager
        .inner()
        .start(spec, meta.engine.clone(), meta, on_event)?;
    Ok(result)
}

#[tauri::command]
pub fn session_send(
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    manager.inner().send(&session_id, &text)
}

#[tauri::command]
pub fn session_cancel(
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.cancel(&session_id)
}

#[tauri::command]
pub fn sessions_list(
    manager: State<'_, Arc<SessionManager>>,
    workspace_key: String,
) -> Vec<SessionMeta> {
    manager
        .state
        .lock()
        .unwrap()
        .sessions
        .iter()
        .filter(|s| s.workspace_key == workspace_key)
        .cloned()
        .collect()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BridgePairPrep {
    /// The freshly-minted device STDB identity (hex) — the web pair page
    /// passes this to `pair_bridge_device` as the signed-in owner.
    pub device_identity_hex: String,
    /// SHA-256 of the device token (the raw token stays in the keychain).
    pub device_token_hash: String,
    pub platform: String,
    pub bridge_version: String,
}

/// Mint the embedded bridge's device credentials for a workspace: a dedicated
/// STDB identity (via `POST /v1/identity`) and a random device token. Both go
/// straight to the OS keychain — the webview only receives the identity hex +
/// token hash it needs to call `pair_bridge_device` as the owner.
#[tauri::command]
pub async fn bridge_local_pair_prepare(
    workspace_key: String,
    spacetimedb_uri: String,
) -> Result<BridgePairPrep, String> {
    let base = crate::bridge::stdb::http_base(&spacetimedb_uri);
    let res = reqwest::Client::new()
        .post(format!("{base}/v1/identity"))
        .send()
        .await
        .map_err(|e| format!("identity mint: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("identity mint failed ({})", res.status()));
    }
    let minted: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let identity_hex = minted
        .get("identity")
        .and_then(|v| v.as_str())
        .ok_or("identity mint: no identity in response")?
        .trim_start_matches("0x")
        .to_string();
    let stdb_token = minted
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or("identity mint: no token in response")?
        .to_string();

    let device_token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    keychain::store_bridge_secret(&workspace_key, crate::bridge::DEVICE_TOKEN_KIND, &device_token)?;
    keychain::store_bridge_secret(
        &workspace_key,
        crate::bridge::DEVICE_STDB_TOKEN_KIND,
        &stdb_token,
    )?;

    Ok(BridgePairPrep {
        device_identity_hex: identity_hex,
        device_token_hash: crate::bridge::sha256_hex(&device_token),
        platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        bridge_version: format!("desktop-embed/{}", env!("CARGO_PKG_VERSION")),
    })
}

/// Start the embedded bridge for a paired workspace.
#[tauri::command]
pub async fn bridge_local_start(
    bridge: State<'_, Arc<crate::bridge::LocalBridge>>,
    workspace_key: String,
    spacetimedb_uri: String,
    db_name: String,
) -> Result<crate::bridge::BridgeStatus, String> {
    bridge
        .inner()
        .start(&workspace_key, &spacetimedb_uri, &db_name)
        .await
}

#[tauri::command]
pub async fn bridge_local_stop(
    bridge: State<'_, Arc<crate::bridge::LocalBridge>>,
) -> Result<(), String> {
    bridge.stop().await;
    Ok(())
}

#[tauri::command]
pub fn bridge_local_status(
    bridge: State<'_, Arc<crate::bridge::LocalBridge>>,
) -> crate::bridge::BridgeStatus {
    bridge.status()
}

/// Start the app-managed local workspace (SpacetimeDB + module + web).
/// Long-running: first start may compile/publish the module.
#[tauri::command]
pub async fn local_workspace_start(
    runtime: State<'_, Arc<crate::runtime::LocalRuntime>>,
) -> Result<crate::runtime::LocalWorkspaceInfo, String> {
    let rt = Arc::clone(&runtime);
    tauri::async_runtime::spawn_blocking(move || rt.start())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn local_workspace_stop(runtime: State<'_, Arc<crate::runtime::LocalRuntime>>) {
    runtime.stop();
}

#[tauri::command]
pub fn local_workspace_status(
    runtime: State<'_, Arc<crate::runtime::LocalRuntime>>,
) -> crate::runtime::LocalWorkspaceInfo {
    runtime.status()
}

#[tauri::command]
pub fn session_meta(
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> Result<SessionMeta, String> {
    manager
        .state
        .lock()
        .unwrap()
        .sessions
        .iter()
        .find(|s| s.id == session_id)
        .cloned()
        .ok_or("session not found".to_string())
}
