//! Tests for the device-token store. Exercises the key derivation and the
//! in-memory store; the real `KeyringStore` is not unit-tested (it touches the
//! OS keychain and may prompt), only compiled.

use pear_bridge::keychain::{keychain_key, InMemoryStore, TokenStore};

#[test]
fn key_is_namespaced_per_server() {
    assert_eq!(
        keychain_key("https://mypear.example.com"),
        "pear-bridge::https://mypear.example.com"
    );
    assert_ne!(
        keychain_key("https://a.example.com"),
        keychain_key("https://b.example.com")
    );
}

#[test]
fn in_memory_store_round_trips_per_server() {
    let store = InMemoryStore::new();
    let a = "https://a.example.com";
    let b = "https://b.example.com";

    assert_eq!(store.load(a).unwrap(), None);

    store.store(a, "token-a").unwrap();
    store.store(b, "token-b").unwrap();
    assert_eq!(store.load(a).unwrap(), Some("token-a".to_string()));
    assert_eq!(store.load(b).unwrap(), Some("token-b".to_string()));

    // store replaces
    store.store(a, "token-a2").unwrap();
    assert_eq!(store.load(a).unwrap(), Some("token-a2".to_string()));

    // delete is scoped and idempotent
    store.delete(a).unwrap();
    assert_eq!(store.load(a).unwrap(), None);
    assert_eq!(store.load(b).unwrap(), Some("token-b".to_string()));
    store.delete(a).unwrap(); // deleting a missing token is Ok
}
