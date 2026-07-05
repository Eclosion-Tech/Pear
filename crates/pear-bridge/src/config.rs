//! The config file — `~/.config/pear-bridge/config.toml` (`PEAR_BRIDGE.md`
//! § Config file). It holds **no secrets**: only a set of named profiles, each
//! mapping to a Pear server URL. Device tokens live in the OS keychain
//! (`keychain.rs`), never here.
//!
//! ```toml
//! [default]
//! server = "https://mypear.example.com"
//!
//! [work]
//! server = "https://pear.acmecorp.internal"
//! ```
//!
//! Server selection precedence at startup ([`resolve_server`]): an explicit
//! `--server` override wins; otherwise the `--profile` (or `default`) profile's
//! server.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The profile used when none is named.
pub const DEFAULT_PROFILE: &str = "default";

/// One profile's settings. Only a server URL today; additive in future.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct ProfileConfig {
    pub server: String,
}

/// The whole config: a map of profile name → settings. Serialized transparently
/// so each profile is a top-level TOML table (`[default]`, `[work]`, …).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(transparent)]
pub struct Config {
    pub profiles: BTreeMap<String, ProfileConfig>,
}

impl Config {
    /// Parse a config from TOML text.
    pub fn parse(s: &str) -> Result<Config, ConfigError> {
        toml::from_str(s).map_err(|e| ConfigError::Parse(e.to_string()))
    }

    /// Serialize the config to TOML (without the file header comment).
    pub fn to_toml(&self) -> Result<String, ConfigError> {
        toml::to_string(self).map_err(|e| ConfigError::Serialize(e.to_string()))
    }

    /// Load and parse the config at `path`. A missing file is
    /// [`ConfigError::NotFound`] so the caller can trigger first-run setup.
    pub fn load(path: impl AsRef<Path>) -> Result<Config, ConfigError> {
        let text = match fs::read_to_string(path.as_ref()) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(ConfigError::NotFound),
            Err(e) => return Err(ConfigError::Io(e.to_string())),
        };
        Config::parse(&text)
    }

    /// Write the config to `path`, creating parent directories. Prepends the
    /// "safe to read; never contains tokens" header from the doc.
    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), ConfigError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| ConfigError::Io(e.to_string()))?;
            }
        }
        let header =
            "# ~/.config/pear-bridge/config.toml\n# Safe to read; never contains tokens.\n\n";
        let body = self.to_toml()?;
        fs::write(path, format!("{header}{body}")).map_err(|e| ConfigError::Io(e.to_string()))
    }

    /// The server URL for a profile (or the default profile if `None`), if it
    /// exists.
    pub fn server_for(&self, profile: Option<&str>) -> Option<&str> {
        let name = profile.unwrap_or(DEFAULT_PROFILE);
        self.profiles.get(name).map(|p| p.server.as_str())
    }

    /// Insert or replace a profile's server URL.
    pub fn set_profile(&mut self, name: &str, server: &str) {
        self.profiles.insert(
            name.to_string(),
            ProfileConfig {
                server: server.to_string(),
            },
        );
    }
}

/// Resolve the server URL to connect to, applying CLI precedence: an explicit
/// `--server` override wins; otherwise the named (or default) profile's server.
/// Errors if neither yields a non-empty URL.
pub fn resolve_server(
    config: &Config,
    profile: Option<&str>,
    server_override: Option<&str>,
) -> Result<String, ConfigError> {
    if let Some(s) = server_override {
        let s = s.trim();
        if s.is_empty() {
            return Err(ConfigError::EmptyServer);
        }
        return Ok(s.to_string());
    }
    match config.server_for(profile) {
        Some(s) if !s.trim().is_empty() => Ok(s.trim().to_string()),
        Some(_) => Err(ConfigError::EmptyServer),
        None => Err(ConfigError::ProfileNotFound(
            profile.unwrap_or(DEFAULT_PROFILE).to_string(),
        )),
    }
}

/// The default config path: `$XDG_CONFIG_HOME/pear-bridge/config.toml`, falling
/// back to `$HOME/.config/pear-bridge/config.toml`.
pub fn default_path() -> PathBuf {
    config_path_from(
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

/// Pure path builder behind [`default_path`], exposed for testing without
/// mutating process environment variables.
pub fn config_path_from(xdg_config_home: Option<&str>, home: Option<&str>) -> PathBuf {
    let base = match xdg_config_home {
        Some(x) if !x.is_empty() => PathBuf::from(x),
        _ => PathBuf::from(home.unwrap_or(".")).join(".config"),
    };
    base.join("pear-bridge").join("config.toml")
}

/// Errors from config loading, parsing, and resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// No config file exists at the given path (trigger first-run).
    NotFound,
    /// Filesystem error reading/writing the config.
    Io(String),
    /// The TOML could not be parsed.
    Parse(String),
    /// The config could not be serialized to TOML.
    Serialize(String),
    /// The requested profile does not exist in the config.
    ProfileNotFound(String),
    /// A server URL was present but empty.
    EmptyServer,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::NotFound => write!(f, "no config file found"),
            ConfigError::Io(e) => write!(f, "config i/o error: {e}"),
            ConfigError::Parse(e) => write!(f, "could not parse config: {e}"),
            ConfigError::Serialize(e) => write!(f, "could not serialize config: {e}"),
            ConfigError::ProfileNotFound(p) => write!(f, "profile {p:?} not found in config"),
            ConfigError::EmptyServer => write!(f, "server URL is empty"),
        }
    }
}

impl std::error::Error for ConfigError {}
