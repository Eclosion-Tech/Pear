//! `pear-bridge` — the local-shell execution daemon for Pear's `tool-bash`
//! capability. See `docs/PEAR_BRIDGE.md` for the full design.
//!
//! The bridge dials out to a Pear relay, receives `BridgeCommand` rows over a
//! proxied SpacetimeDB subscription, and executes allowlisted commands in the
//! user's real environment. The [`allowlist`] module is the in-binary
//! enforcement point: per `PEAR_BRIDGE.md` § Security, the allowlist is
//! re-checked locally before any PTY call, regardless of what the server says —
//! a compromised or misconfigured server cannot make the bridge run a disallowed
//! command.
//!
//! Currently implemented: [`allowlist`] (implementation order step 3),
//! [`pty`] (step 4 — the execution path), [`audit`] (Layer 5 — the local
//! tamper-evident log), [`config`] (the no-secrets config file + profiles),
//! [`relay`] (the dial-out WebSocket client), and [`keychain`] (the device-token
//! store, keychain-only). The `main.rs` binary wires these together; the full
//! relay frame-dispatch loop and service registration land alongside it.

pub mod allowlist;
pub mod audit;
pub mod config;
pub mod daemon;
pub mod keychain;
pub mod pair;
pub mod providers;
pub mod pty;
pub mod relay;
pub mod sandbox;
pub mod transport;
