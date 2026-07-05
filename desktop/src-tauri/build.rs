fn main() {
    // App-defined commands must be declared here for Tauri v2's ACL to
    // generate their `allow-*` permissions, which the capability files
    // (capabilities/*.json) then grant per-origin. Keep in sync with
    // `tauri::generate_handler!` in lib.rs.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "engines_detect",
            "engine_bind",
            "engines_bindings",
            "session_start",
            "session_resume",
            "session_send",
            "session_cancel",
            "sessions_list",
            "session_meta",
            "local_workspace_start",
            "local_workspace_stop",
            "local_workspace_status",
            "bridge_local_pair_prepare",
            "bridge_local_start",
            "bridge_local_stop",
            "bridge_local_status",
        ]),
    ))
    .expect("failed to run tauri-build");
}
