//! Tests for the config file: parsing, round-trip, profile/server resolution,
//! and default path derivation.

use std::fs;
use std::path::{Path, PathBuf};

use pear_bridge::config::{config_path_from, resolve_server, Config, ConfigError, DEFAULT_PROFILE};

const SAMPLE: &str = r#"
# header comment is ignored
[default]
server = "https://mypear.example.com"

[work]
server = "https://pear.acmecorp.internal"
"#;

fn temp_path(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "pear-bridge-cfg-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&p);
    p
}

#[test]
fn parses_profiles() {
    let cfg = Config::parse(SAMPLE).unwrap();
    assert_eq!(cfg.profiles.len(), 2);
    assert_eq!(
        cfg.server_for(None),
        Some("https://mypear.example.com"),
        "None resolves to the default profile"
    );
    assert_eq!(
        cfg.server_for(Some("work")),
        Some("https://pear.acmecorp.internal")
    );
    assert_eq!(cfg.server_for(Some("nope")), None);
}

#[test]
fn round_trips_through_toml() {
    let cfg = Config::parse(SAMPLE).unwrap();
    let serialized = cfg.to_toml().unwrap();
    let reparsed = Config::parse(&serialized).unwrap();
    assert_eq!(cfg, reparsed);
}

#[test]
fn save_then_load_preserves_profiles_and_writes_header() {
    let dir = temp_path("save");
    let path = dir.join("pear-bridge").join("config.toml");

    let mut cfg = Config::default();
    cfg.set_profile(DEFAULT_PROFILE, "https://a.example.com");
    cfg.set_profile("work", "https://b.example.com");
    cfg.save(&path).unwrap();

    // Header is present and reassures the reader no tokens are stored.
    let raw = fs::read_to_string(&path).unwrap();
    assert!(
        raw.contains("never contains tokens"),
        "header missing: {raw}"
    );

    let loaded = Config::load(&path).unwrap();
    assert_eq!(loaded, cfg);

    fs::remove_dir_all(&dir).ok();
}

#[test]
fn load_missing_file_is_not_found() {
    let missing = temp_path("missing").join("config.toml");
    assert_eq!(Config::load(&missing), Err(ConfigError::NotFound));
}

#[test]
fn set_profile_overwrites() {
    let mut cfg = Config::default();
    cfg.set_profile("default", "https://one.example.com");
    cfg.set_profile("default", "https://two.example.com");
    assert_eq!(cfg.server_for(None), Some("https://two.example.com"));
}

#[test]
fn resolve_server_override_wins() {
    let cfg = Config::parse(SAMPLE).unwrap();
    let resolved =
        resolve_server(&cfg, Some("work"), Some("https://override.example.com")).unwrap();
    assert_eq!(resolved, "https://override.example.com");
}

#[test]
fn resolve_server_falls_back_to_profile() {
    let cfg = Config::parse(SAMPLE).unwrap();
    assert_eq!(
        resolve_server(&cfg, None, None).unwrap(),
        "https://mypear.example.com"
    );
    assert_eq!(
        resolve_server(&cfg, Some("work"), None).unwrap(),
        "https://pear.acmecorp.internal"
    );
}

#[test]
fn resolve_server_errors_on_missing_profile_and_empty() {
    let cfg = Config::parse(SAMPLE).unwrap();
    assert_eq!(
        resolve_server(&cfg, Some("ghost"), None),
        Err(ConfigError::ProfileNotFound("ghost".to_string()))
    );

    let mut empty = Config::default();
    empty.set_profile("default", "   ");
    assert_eq!(
        resolve_server(&empty, None, None),
        Err(ConfigError::EmptyServer)
    );
    assert_eq!(
        resolve_server(&empty, None, Some("  ")),
        Err(ConfigError::EmptyServer)
    );
}

#[test]
fn default_path_prefers_xdg_then_home() {
    assert_eq!(
        config_path_from(Some("/xdg/cfg"), Some("/home/kara")),
        Path::new("/xdg/cfg/pear-bridge/config.toml")
    );
    assert_eq!(
        config_path_from(None, Some("/home/kara")),
        Path::new("/home/kara/.config/pear-bridge/config.toml")
    );
    // empty XDG falls through to HOME
    assert_eq!(
        config_path_from(Some(""), Some("/home/kara")),
        Path::new("/home/kara/.config/pear-bridge/config.toml")
    );
}
