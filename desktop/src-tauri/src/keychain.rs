//! OS-keychain storage for engine AI-user worker tokens.
//!
//! Key convention `pear-desktop / {workspace_key}/{ai_user_hex}` — kept
//! deliberately close to crates/pear-bridge/src/keychain.rs so the M5
//! bridge-embed consolidation is mechanical. Tokens never travel back to the
//! webview: the web app stores them here once (engine_bind) and the Rust side
//! materializes them only into per-session 0600 files at spawn.

const SERVICE: &str = "pear-desktop";

fn entry(workspace_key: &str, ai_user_hex: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &format!("{workspace_key}/{ai_user_hex}"))
        .map_err(|e| format!("keychain entry: {e}"))
}

pub fn store_token(workspace_key: &str, ai_user_hex: &str, token: &str) -> Result<(), String> {
    entry(workspace_key, ai_user_hex)?
        .set_password(token)
        .map_err(|e| format!("keychain store: {e}"))
}

pub fn get_token(workspace_key: &str, ai_user_hex: &str) -> Result<String, String> {
    entry(workspace_key, ai_user_hex)?
        .get_password()
        .map_err(|e| format!("keychain read: {e}"))
}

// ── Embedded bridge (M5) ────────────────────────────────────────────────────
// Two secrets per workspace: the long-lived bridge device token (auth for
// open/close session — its hash lives server-side) and the device's own STDB
// token (the identity the embedded bridge connects as). Same service, bridge-
// prefixed accounts.

fn bridge_entry(workspace_key: &str, kind: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &format!("bridge/{workspace_key}/{kind}"))
        .map_err(|e| format!("keychain entry: {e}"))
}

pub fn store_bridge_secret(workspace_key: &str, kind: &str, value: &str) -> Result<(), String> {
    bridge_entry(workspace_key, kind)?
        .set_password(value)
        .map_err(|e| format!("keychain store: {e}"))
}

pub fn get_bridge_secret(workspace_key: &str, kind: &str) -> Result<String, String> {
    bridge_entry(workspace_key, kind)?
        .get_password()
        .map_err(|e| format!("keychain read: {e}"))
}

pub fn delete_bridge_secret(workspace_key: &str, kind: &str) -> Result<(), String> {
    bridge_entry(workspace_key, kind)?
        .delete_credential()
        .map_err(|e| format!("keychain delete: {e}"))
}
