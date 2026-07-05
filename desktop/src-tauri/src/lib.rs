//! Pear desktop shell.
//!
//! The main window starts on an app-origin launcher page (workspace picker,
//! `desktop/src/`), which navigates to the chosen pear workspace URL. The
//! embedded web app then drives the engine manager over IPC — granted to that
//! remote origin by `capabilities/remote-workspace.json`.

// bridge + keychain are pub for the ignored live-E2E integration test
// (tests/bridge_e2e.rs); everything else stays crate-private.
pub mod bridge;
mod commands;
mod engines;
pub mod keychain;
mod mcp_config;
mod paths;
mod runtime;
mod sessions;
mod worktree;

use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let paths = paths::AppPaths::new(&app.handle().clone())?;
            app.manage(Arc::new(runtime::LocalRuntime::new(&paths.data_dir)));
            app.manage(Arc::new(bridge::LocalBridge::new(&paths.data_dir)));
            app.manage(Arc::new(sessions::SessionManager::new(paths)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::engines_detect,
            commands::engine_bind,
            commands::engines_bindings,
            commands::session_start,
            commands::session_resume,
            commands::session_send,
            commands::session_cancel,
            commands::sessions_list,
            commands::session_meta,
            commands::local_workspace_start,
            commands::local_workspace_stop,
            commands::local_workspace_status,
            commands::bridge_local_pair_prepare,
            commands::bridge_local_start,
            commands::bridge_local_stop,
            commands::bridge_local_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building pear desktop")
        .run(|app, event| {
            // Local workspace children must not outlive the app.
            if let tauri::RunEvent::Exit = event {
                if let Some(rt) = app.try_state::<Arc<runtime::LocalRuntime>>() {
                    rt.stop();
                }
            }
        });
}
