//! The device-token store (`PEAR_BRIDGE.md` § Auth model, Layer 2).
//!
//! The long-lived device token proves "this binary on this machine was paired by
//! this user." It is stored **only in the OS keychain** — never on disk, never
//! in env vars, never logged. Only its SHA-256 hash lives server-side
//! (`BridgeDevice.device_token_hash`). The token is keyed per server URL so one
//! machine can pair with several Pear servers independently.
//!
//! [`TokenStore`] abstracts the store so the rest of the daemon (and tests) does
//! not depend on a real keychain: [`KeyringStore`] is the production backend
//! (`keyring` crate → Keychain / SecretService / DPAPI), and [`InMemoryStore`]
//! is a test double.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

/// The keychain service name for a given server's device token, e.g.
/// `pear-bridge::https://mypear.example.com`. (`PEAR_BRIDGE.md`: key
/// `pear-bridge::{server_url}`.)
pub fn keychain_key(server_url: &str) -> String {
    format!("pear-bridge::{server_url}")
}

/// The account/user component stored under the per-server service key.
const DEVICE_TOKEN_ACCOUNT: &str = "device-token";

/// Abstraction over a secret store for the device token.
pub trait TokenStore {
    /// Store (or replace) the device token for `server_url`.
    fn store(&self, server_url: &str, token: &str) -> Result<(), KeychainError>;
    /// Load the device token for `server_url`, or `None` if none is stored.
    fn load(&self, server_url: &str) -> Result<Option<String>, KeychainError>;
    /// Delete the device token for `server_url`. Deleting a missing token is Ok.
    fn delete(&self, server_url: &str) -> Result<(), KeychainError>;
}

/// Production backend over the `keyring` crate (OS-native credential store).
#[derive(Debug, Default, Clone, Copy)]
pub struct KeyringStore;

impl KeyringStore {
    pub fn new() -> Self {
        KeyringStore
    }

    fn entry(server_url: &str) -> Result<keyring::Entry, KeychainError> {
        keyring::Entry::new(&keychain_key(server_url), DEVICE_TOKEN_ACCOUNT)
            .map_err(|e| KeychainError(e.to_string()))
    }
}

/// Run a keyring operation on a fresh OS thread, outside any tokio runtime.
///
/// On Linux the selected `async-secret-service` backend reaches the Secret
/// Service via zbus, whose blocking facade lazily builds its own
/// current-thread tokio runtime and calls `block_on` — which PANICS when the
/// calling thread is already inside a runtime (and `connect_main` calls
/// `store.load()` under the daemon's `rt.block_on`). A raw spawned thread
/// carries categorically no runtime context, so the nested `block_on` is
/// legal there — chosen over `spawn_blocking`, whose blocking allowance is a
/// tokio implementation detail. macOS/Windows backends are natively
/// synchronous and merely pay one thread spawn per call; the token is touched
/// about twice per process.
fn off_runtime<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, KeychainError> + Send + 'static,
) -> Result<T, KeychainError> {
    std::thread::spawn(f)
        .join()
        .map_err(|_| KeychainError("keychain thread panicked".to_string()))?
}

impl TokenStore for KeyringStore {
    fn store(&self, server_url: &str, token: &str) -> Result<(), KeychainError> {
        let server_url = server_url.to_string();
        let token = token.to_string();
        off_runtime(move || {
            Self::entry(&server_url)?
                .set_password(&token)
                .map_err(|e| KeychainError(e.to_string()))
        })
    }

    fn load(&self, server_url: &str) -> Result<Option<String>, KeychainError> {
        let server_url = server_url.to_string();
        off_runtime(move || match Self::entry(&server_url)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(KeychainError(e.to_string())),
        })
    }

    fn delete(&self, server_url: &str) -> Result<(), KeychainError> {
        let server_url = server_url.to_string();
        off_runtime(move || match Self::entry(&server_url)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(KeychainError(e.to_string())),
        })
    }
}

/// In-memory [`TokenStore`] for tests. Not for production — the whole point of
/// the real store is that the token never leaves the OS keychain.
#[derive(Default)]
pub struct InMemoryStore {
    inner: Mutex<HashMap<String, String>>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        InMemoryStore::default()
    }
}

impl TokenStore for InMemoryStore {
    fn store(&self, server_url: &str, token: &str) -> Result<(), KeychainError> {
        self.inner
            .lock()
            .unwrap()
            .insert(keychain_key(server_url), token.to_string());
        Ok(())
    }

    fn load(&self, server_url: &str) -> Result<Option<String>, KeychainError> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .get(&keychain_key(server_url))
            .cloned())
    }

    fn delete(&self, server_url: &str) -> Result<(), KeychainError> {
        self.inner.lock().unwrap().remove(&keychain_key(server_url));
        Ok(())
    }
}

#[cfg(test)]
mod off_runtime_tests {
    use super::*;

    /// The exact failure shape the Linux fix exists for: a keyring call made
    /// from a thread that is already inside a tokio runtime. `off_runtime`
    /// must make a nested current-thread `block_on` legal.
    #[tokio::test(flavor = "multi_thread")]
    async fn off_runtime_permits_nested_block_on_inside_a_runtime() {
        let value = off_runtime(|| {
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("nested runtime builds");
            Ok(rt.block_on(async { 7 }))
        })
        .expect("nested block_on must be legal off-runtime");
        assert_eq!(value, 7);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn off_runtime_maps_panics_to_keychain_errors() {
        let result: Result<(), KeychainError> = off_runtime(|| panic!("backend exploded"));
        assert_eq!(
            result.unwrap_err(),
            KeychainError("keychain thread panicked".to_string())
        );
    }
}

/// An error from the underlying credential store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeychainError(pub String);

impl fmt::Display for KeychainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "keychain error: {}", self.0)
    }
}

impl std::error::Error for KeychainError {}
