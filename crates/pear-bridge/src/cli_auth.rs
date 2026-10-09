//! Device-local CLI auth guard. Not a quota meter or a general tool-spend sandbox.
//! Default preserves configured auth. Strict mode never logs/exports login output.
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

pub const POLICY_ENV: &str = "PEAR_BRIDGE_CLI_AUTH_POLICY";
pub const EXTRA_USAGE_ENV: &str = "PEAR_BRIDGE_SUBSCRIPTION_EXTRA_USAGE_DISABLED";
const MAX_STATUS_BYTES: usize = 16 * 1024;
const MAX_CONFIG_BYTES: usize = 64 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
type Environment = BTreeMap<OsString, OsString>;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CliAuthPolicy {
    Configured,
    SubscriptionOnly,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CliProvider {
    Claude,
    Codex,
}

fn lookup<'a>(env: &'a Environment, name: &str) -> Option<&'a OsStr> {
    env.iter()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_os_str())
}
fn policy(env: &Environment) -> Result<CliAuthPolicy, String> {
    match lookup(env, POLICY_ENV) {
        None => Ok(CliAuthPolicy::Configured),
        Some(v) if v == "configured" => Ok(CliAuthPolicy::Configured),
        Some(v) if v == "subscription-only" => Ok(CliAuthPolicy::SubscriptionOnly),
        _ => Err("invalid device CLI auth policy; execution refused".into()),
    }
}
pub fn current_policy() -> Result<CliAuthPolicy, String> {
    policy(&std::env::vars_os().collect())
}

/// Snapshot is private and deliberately has no Debug/Serialize implementation.
/// The probe and inference child use identical environments, including auth homes.
pub(crate) struct PreparedCli {
    args: Vec<String>,
    environment: Environment,
}
impl PreparedCli {
    pub(crate) fn command(&self, bin: &str, cwd: &Path) -> Command {
        let mut command = Command::new(bin);
        command
            .args(&self.args)
            .current_dir(cwd)
            .env_clear()
            .envs(&self.environment);
        command
    }
}

fn reject_overrides(provider: CliProvider, env: &Environment) -> Result<(), String> {
    let names: &[&str] = match provider {
        CliProvider::Claude => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_PROFILE",
            "ANTHROPIC_FEDERATION_PROVIDER",
            "ANTHROPIC_FEDERATION_TARGET",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_SIMPLE",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
        ],
        CliProvider::Codex => &[
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "OPENAI_BASE_URL",
            "CODEX_ACCESS_TOKEN",
            "CODEX_AUTH_TOKEN",
            "OPENAI_ACCESS_TOKEN",
        ],
    };
    for name in names {
        // Even empty overrides are ambiguous: require operator to unset, not silently strip.
        if lookup(env, name).is_some() {
            return Err(format!(
                "subscription-only auth refused environment override {name}"
            ));
        }
    }
    if lookup(env, EXTRA_USAGE_ENV) != Some(OsStr::new("1")) {
        return Err("subscription-only auth requires local confirmation that extra usage/credits are disabled; login alone is not proof".into());
    }
    Ok(())
}

fn claude_auth_controls() -> Vec<String> {
    [
        "--setting-sources",
        "",
        "--settings",
        r#"{"disableAllHooks":true,"forceLoginMethod":"claudeai"}"#,
    ]
    .into_iter()
    .map(String::from)
    .collect()
}
fn claude_controls() -> Vec<String> {
    let mut controls = claude_auth_controls();
    controls.extend(
        [
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
        ]
        .into_iter()
        .map(String::from),
    );
    controls
}
fn codex_controls() -> Vec<String> {
    [
        "-c",
        r#"forced_login_method="chatgpt""#,
        "-c",
        r#"model_provider="openai""#,
    ]
    .into_iter()
    .map(String::from)
    .collect()
}
fn strict_args(provider: CliProvider, args: &[String]) -> Result<Vec<String>, String> {
    let forbidden: &[&str] = match provider {
        CliProvider::Claude => &["--bare", "--profile", "--cloud"],
        CliProvider::Codex => &[
            "-c",
            "--config",
            "--profile",
            "-p",
            "--oss",
            "--local-provider",
        ],
    };
    if args.iter().any(|a| {
        forbidden
            .iter()
            .any(|f| a == f || a.starts_with(&format!("{f}=")))
    }) {
        return Err("subscription-only auth refused launch override".into());
    }
    if args
        .windows(2)
        .any(|pair| matches!(pair[0].as_str(), "--model" | "-m") && pair[1].starts_with('-'))
    {
        return Err("subscription-only auth refused ambiguous model argument".into());
    }
    let mut out = match provider {
        CliProvider::Claude => claude_controls(),
        CliProvider::Codex => codex_controls(),
    };
    // Replace fixed Claude review controls rather than letting a later --settings
    // override the auth pin. These options are daemon-generated, not caller argv.
    let mut i = 0;
    while i < args.len() {
        if provider == CliProvider::Claude {
            match args[i].as_str() {
                "--setting-sources" | "--settings" | "--mcp-config" => {
                    i += 2;
                    continue;
                }
                "--strict-mcp-config" => {
                    i += 1;
                    continue;
                }
                _ => {}
            }
        }
        out.push(args[i].clone());
        i += 1;
    }
    Ok(out)
}

fn inspect_codex_config(env: &Environment, cwd: &Path) -> Result<(), String> {
    if cfg!(windows) {
        return Err(
            "subscription-only Codex config inspection is not supported on Windows yet".into(),
        );
    }
    let cwd = cwd.canonicalize().map_err(|_| {
        "subscription-only Codex working directory could not be verified".to_string()
    })?;
    if lookup(env, "CODEX_HOME").is_some_and(OsStr::is_empty) {
        return Err("subscription-only Codex config home is ambiguous".into());
    }
    let home = lookup(env, "CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            lookup(env, "HOME")
                .filter(|h| !h.is_empty())
                .map(|h| PathBuf::from(h).join(".codex"))
        })
        .ok_or_else(|| "subscription-only Codex requires a known local config home".to_string())?;
    let home = if home.is_absolute() {
        home
    } else {
        cwd.join(home)
    };
    let mut paths = vec![
        home.join("config.toml"),
        PathBuf::from("/etc/codex/config.toml"),
        PathBuf::from("/etc/codex/managed_config.toml"),
        PathBuf::from("/etc/codex/requirements.toml"),
    ];
    paths.extend(cwd.ancestors().map(|p| p.join(".codex/config.toml")));
    paths.sort();
    paths.dedup();
    for path in paths {
        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("subscription-only Codex config could not be inspected".into()),
        };
        if !metadata.is_file() {
            return Err("subscription-only Codex config must be a regular file".into());
        }
        if metadata.len() > MAX_CONFIG_BYTES as u64 {
            return Err("subscription-only Codex config too large".into());
        }
        let file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("subscription-only Codex config could not be inspected".into()),
        };
        let mut data = Vec::new();
        file.take((MAX_CONFIG_BYTES + 1) as u64)
            .read_to_end(&mut data)
            .map_err(|_| "subscription-only Codex config could not be read".to_string())?;
        if data.len() > MAX_CONFIG_BYTES {
            return Err("subscription-only Codex config too large".into());
        }
        let text = std::str::from_utf8(&data)
            .map_err(|_| "subscription-only Codex config is invalid".to_string())?;
        let parsed: toml::Value = toml::from_str(text)
            .map_err(|_| "subscription-only Codex config is invalid".to_string())?;
        let table = parsed
            .as_table()
            .ok_or_else(|| "subscription-only Codex config is invalid".to_string())?;
        if table.keys().any(|k| {
            matches!(
                k.as_str(),
                "model_providers"
                    | "profile"
                    | "profiles"
                    | "chatgpt_base_url"
                    | "openai_base_url"
                    | "experimental_bearer_token"
                    | "auth"
            )
        }) || table
            .get("model_provider")
            .is_some_and(|v| v.as_str() != Some("openai"))
            || table
                .get("forced_login_method")
                .is_some_and(|v| v.as_str() != Some("chatgpt"))
        {
            return Err(
                "subscription-only Codex refused ambiguous provider/profile/auth configuration"
                    .into(),
            );
        }
    }
    Ok(())
}

async fn bounded_read(reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_STATUS_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "subscription auth status could not be read".to_string())?;
    if bytes.len() > MAX_STATUS_BYTES {
        return Err("subscription auth status exceeded limit".into());
    }
    Ok(bytes)
}
fn validate_status(provider: CliProvider, stdout: &[u8], stderr: &[u8]) -> Result<(), String> {
    let accepted = match provider {
        CliProvider::Claude => serde_json::from_slice::<serde_json::Value>(stdout)
            .ok()
            .is_some_and(|v| {
                v.get("loggedIn").and_then(|v| v.as_bool()) == Some(true)
                    && v.get("authMethod").and_then(|v| v.as_str()) == Some("claude.ai")
                    && v.get("apiProvider").and_then(|v| v.as_str()) == Some("firstParty")
                    && matches!(
                        v.get("subscriptionType").and_then(|v| v.as_str()),
                        Some("pro" | "max")
                    )
            }),
        CliProvider::Codex => {
            let stdout = std::str::from_utf8(stdout).unwrap_or("").trim();
            let stderr = std::str::from_utf8(stderr).unwrap_or("").trim();
            (stdout == "Logged in using ChatGPT" && stderr.is_empty())
                || (stderr == "Logged in using ChatGPT" && stdout.is_empty())
        }
    };
    if accepted {
        Ok(())
    } else {
        Err("CLI subscription login could not be verified; unknown/API auth refused".into())
    }
}

async fn probe_command(
    bin: &str,
    args: &[String],
    cwd: &Path,
    env: &Environment,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut child = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "subscription CLI preflight could not be launched".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "subscription CLI preflight missing stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "subscription CLI preflight missing stderr".to_string())?;
    let work = async {
        let (stdout, stderr) = tokio::try_join!(bounded_read(stdout), bounded_read(stderr))?;
        let status = child
            .wait()
            .await
            .map_err(|_| "subscription CLI preflight failed".to_string())?;
        if !status.success() {
            return Err("subscription CLI preflight rejected".into());
        }
        Ok((stdout, stderr))
    };
    tokio::time::timeout(PROBE_TIMEOUT, work)
        .await
        .map_err(|_| "subscription CLI preflight timed out; execution refused".to_string())?
}
async fn probe(
    provider: CliProvider,
    bin: &str,
    cwd: &Path,
    env: &Environment,
) -> Result<(), String> {
    // First prove the read-only status subcommand exists. On an old CLI an
    // unrecognized word might be treated as a prompt or start interactive login.
    // --help is non-inference; no version-number/schema guesses are made.
    let controls = match provider {
        CliProvider::Claude => claude_auth_controls(),
        CliProvider::Codex => codex_controls(),
    };
    let subcommand = match provider {
        CliProvider::Claude => "auth",
        CliProvider::Codex => "login",
    };
    let mut help_args = controls.clone();
    help_args.extend([subcommand.into(), "--help".into()]);
    let (help, _) = probe_command(bin, &help_args, cwd, env).await?;
    let help = std::str::from_utf8(&help).unwrap_or("");
    let known_usage = help.lines().any(|l| {
        l.trim_start().starts_with("Usage:") && l.split_whitespace().any(|w| w == subcommand)
    });
    let known_status = help
        .lines()
        .any(|l| l.trim_start().split_whitespace().next() == Some("status"));
    if !known_usage || !known_status {
        return Err("CLI read-only auth status command unavailable; execution refused".into());
    }
    let mut args = controls;
    // Deliberately exclude variadic --mcp-config here, or it could swallow
    // the auth/status words instead of selecting the subcommand.
    args.extend([subcommand.into(), "status".into()]);
    let (stdout, stderr) = probe_command(bin, &args, cwd, env).await?;
    validate_status(provider, &stdout, &stderr)
}

/// Bounded version check with the exact private environment already probed.
pub(crate) async fn prepared_version(
    launch: &PreparedCli,
    bin: &str,
    cwd: &Path,
) -> Result<String, String> {
    if policy(&launch.environment)? != CliAuthPolicy::SubscriptionOnly {
        return Err("Preflight requires subscription-only snapshot".into());
    }
    let (stdout, stderr) =
        probe_command(bin, &["--version".into()], cwd, &launch.environment).await?;
    let version = std::str::from_utf8(&stdout)
        .map_err(|_| "Unknown CLI version".to_string())?
        .trim();
    if version.is_empty() || version.len() > 256 || !stderr.is_empty() {
        return Err("Unknown CLI version".into());
    }
    Ok(version.to_string())
}

pub(crate) async fn prepare(
    provider: CliProvider,
    bin: &str,
    args: &[String],
    cwd: &Path,
) -> Result<PreparedCli, String> {
    let environment: Environment = std::env::vars_os().collect();
    if policy(&environment)? == CliAuthPolicy::Configured {
        return Ok(PreparedCli {
            args: args.to_vec(),
            environment,
        });
    }
    reject_overrides(provider, &environment)?;
    let args = strict_args(provider, args)?;
    if provider == CliProvider::Codex {
        inspect_codex_config(&environment, cwd)?;
    }
    probe(provider, bin, cwd, &environment).await?;
    Ok(PreparedCli { args, environment })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_accepts_only_explicit_known_subscription_shapes() {
        let good = br#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max","email":"private@example.test"}"#;
        assert!(validate_status(CliProvider::Claude, good, b"").is_ok());
        for bad in [br#"{"loggedIn":true,"authMethod":"api_key"}"#.as_slice(), b"not json",
            br#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"unknown"}"#] {
            assert!(validate_status(CliProvider::Claude, bad, b"SECRET").unwrap_err().find("SECRET").is_none());
        }
        assert!(validate_status(CliProvider::Codex, b"", b"Logged in using ChatGPT\n").is_ok());
        assert!(validate_status(CliProvider::Codex, b"Logged in using ChatGPT", b"").is_ok());
        for bad in [
            b"Logged in using an API key - SECRET".as_slice(),
            b"Logged in using access token",
            b"warning\nLogged in using ChatGPT",
        ] {
            assert!(validate_status(CliProvider::Codex, b"", bad).is_err());
        }
    }
    #[test]
    fn policy_and_confirmation_fail_closed_and_never_echo_values() {
        let mut env = Environment::new();
        assert!(matches!(policy(&env).unwrap(), CliAuthPolicy::Configured));
        env.insert(POLICY_ENV.into(), "typo".into());
        assert!(policy(&env).is_err());
        env.insert(EXTRA_USAGE_ENV.into(), "1".into());
        env.insert("ANTHROPIC_API_KEY".into(), "SECRET".into());
        let error = reject_overrides(CliProvider::Claude, &env).unwrap_err();
        assert!(!error.contains("SECRET"));
        assert!(error.contains("ANTHROPIC_API_KEY"));
        env.remove(OsStr::new("ANTHROPIC_API_KEY"));
        assert!(reject_overrides(CliProvider::Claude, &env).is_ok());
        env.remove(OsStr::new(EXTRA_USAGE_ENV));
        assert!(reject_overrides(CliProvider::Claude, &env).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn codex_checks_project_ancestors_not_only_user_config() {
        let root = std::env::temp_dir().join(format!("pear-auth-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("project/subdir")).unwrap();
        std::fs::create_dir_all(root.join("project/.codex")).unwrap();
        let mut env = Environment::new();
        env.insert("CODEX_HOME".into(), root.join("home").into_os_string());
        std::fs::write(
            root.join("project/.codex/config.toml"),
            "[model_providers.custom]\nbase_url = 'SECRET'",
        )
        .unwrap();
        let err = inspect_codex_config(&env, &root.join("project/subdir")).unwrap_err();
        assert!(!err.contains("SECRET"));
        assert!(err.contains("configuration"));
        std::fs::remove_file(root.join("project/.codex/config.toml")).unwrap();
        std::fs::create_dir_all(root.join("project/subdir/relative-home")).unwrap();
        std::fs::write(
            root.join("project/subdir/relative-home/config.toml"),
            "model_provider = 'custom'",
        )
        .unwrap();
        env.insert("CODEX_HOME".into(), "relative-home".into());
        assert!(inspect_codex_config(&env, &root.join("project/subdir"))
            .unwrap_err()
            .contains("configuration"));
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn strict_argv_pins_auth_without_bare_or_custom_provider_overrides() {
        let claude = strict_args(
            CliProvider::Claude,
            &["-p".into(), "--settings".into(), "{}".into()],
        )
        .unwrap();
        assert!(claude.iter().any(|v| v.contains("forceLoginMethod")));
        assert_eq!(
            claude.iter().filter(|v| v.as_str() == "--settings").count(),
            1
        );
        assert!(strict_args(CliProvider::Claude, &["--bare".into()]).is_err());
        assert!(strict_args(
            CliProvider::Claude,
            &["--model".into(), "--settings".into()]
        )
        .is_err());
        let codex = strict_args(CliProvider::Codex, &["exec".into()]).unwrap();
        assert!(codex
            .iter()
            .any(|v| v == r#"forced_login_method="chatgpt""#));
        assert!(strict_args(CliProvider::Codex, &["--profile=custom".into()]).is_err());
    }
}
