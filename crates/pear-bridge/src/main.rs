//! `pear-bridge` daemon entry point.
//!
//! Wires the implemented modules together and provides the CLI from
//! `PEAR_BRIDGE.md` § CLI flags. Today `version`, `help`, `status`, and
//! `verify-audit` are fully functional; `connect`/first-run/pairing,
//! `unpair`, and service registration are scaffolded but depend on the
//! server-side relay endpoint + `/api/bridge/auth` (not yet built), so they
//! report that clearly rather than pretending to work.

use std::path::PathBuf;
use std::process::ExitCode;

use pear_bridge::allowlist::AllowlistEnforcer;
use pear_bridge::audit::{self, AuditLog, VerifyResult};
use pear_bridge::config::{self, Config, ConfigError};
use pear_bridge::daemon::ExecConfig;
use pear_bridge::keychain::{KeyringStore, TokenStore};
use pear_bridge::pair;
use pear_bridge::providers;
use pear_bridge::pty::default_shell;
use pear_bridge::relay::{self, Backoff};
use pear_bridge::transport;

const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "\
pear-bridge — local-shell execution daemon for Pear's tool-bash capability

USAGE:
    pear-bridge [--server <url>] [--profile <name>] [--token <token>]
    pear-bridge <subcommand> [options]

SUBCOMMANDS:
    (none) / connect   connect using the configured (or specified) server
    status              print current connection status and config
    verify-audit [path] walk the local audit log hash chain; report first break
    install-service     register as a login service (launchd/systemd/schtasks)
    uninstall-service   remove the service registration
    unpair              revoke this device and clear local config + keychain
    version             print version
    help                print this help

OPTIONS:
    --server <url>      override the server URL for this run
    --profile <name>    use a named profile from the config file
    --token <token>     non-interactive device token (CI/headless)
    -h, --help          print this help
";

/// A parsed CLI invocation.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Connect {
        server: Option<String>,
        profile: Option<String>,
        token: Option<String>,
    },
    Status {
        server: Option<String>,
        profile: Option<String>,
    },
    VerifyAudit {
        path: Option<String>,
    },
    InstallService,
    UninstallService,
    Unpair {
        server: Option<String>,
        profile: Option<String>,
    },
    Version,
    Help,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args) {
        Ok(cmd) => run(cmd),
        Err(e) => {
            eprintln!("error: {e}\n");
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// Parse argv (excluding the program name) into a [`Command`].
pub fn parse_args(args: &[String]) -> Result<Command, String> {
    if args.is_empty() {
        return Ok(Command::Connect {
            server: None,
            profile: None,
            token: None,
        });
    }

    // Top-level version flags.
    if args.len() == 1 && (args[0] == "--version" || args[0] == "-V") {
        return Ok(Command::Version);
    }

    // A leading non-flag token is a subcommand.
    let first = args[0].as_str();
    let (subcommand, rest): (Option<&str>, &[String]) = if first.starts_with('-') {
        (None, args)
    } else {
        (Some(first), &args[1..])
    };

    let opts = collect_opts(rest)?;

    match subcommand {
        None => {
            if opts.help {
                return Ok(Command::Help);
            }
            reject_positionals(&opts, "connect")?;
            Ok(Command::Connect {
                server: opts.server,
                profile: opts.profile,
                token: opts.token,
            })
        }
        // `connect` is the default (no-subcommand) action; accept it explicitly
        // too, since users naturally type it.
        Some("connect") => {
            reject_positionals(&opts, "connect")?;
            Ok(Command::Connect {
                server: opts.server,
                profile: opts.profile,
                token: opts.token,
            })
        }
        Some("help") => Ok(Command::Help),
        Some("version") => Ok(Command::Version),
        Some("status") => {
            reject_positionals(&opts, "status")?;
            Ok(Command::Status {
                server: opts.server,
                profile: opts.profile,
            })
        }
        Some("verify-audit") => {
            if opts.positionals.len() > 1 {
                return Err("verify-audit takes at most one path argument".to_string());
            }
            Ok(Command::VerifyAudit {
                path: opts.positionals.into_iter().next(),
            })
        }
        Some("install-service") => Ok(Command::InstallService),
        Some("uninstall-service") => Ok(Command::UninstallService),
        Some("unpair") => {
            reject_positionals(&opts, "unpair")?;
            Ok(Command::Unpair {
                server: opts.server,
                profile: opts.profile,
            })
        }
        Some(other) => Err(format!("unknown subcommand {other:?}")),
    }
}

#[derive(Default)]
struct Opts {
    server: Option<String>,
    profile: Option<String>,
    token: Option<String>,
    help: bool,
    positionals: Vec<String>,
}

fn collect_opts(rest: &[String]) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--server" => {
                o.server = Some(value_for(rest, i, "--server")?);
                i += 2;
            }
            "--profile" => {
                o.profile = Some(value_for(rest, i, "--profile")?);
                i += 2;
            }
            "--token" => {
                o.token = Some(value_for(rest, i, "--token")?);
                i += 2;
            }
            "-h" | "--help" => {
                o.help = true;
                i += 1;
            }
            s if s.starts_with('-') => return Err(format!("unknown flag {s:?}")),
            s => {
                o.positionals.push(s.to_string());
                i += 1;
            }
        }
    }
    Ok(o)
}

fn value_for(rest: &[String], flag_idx: usize, name: &str) -> Result<String, String> {
    rest.get(flag_idx + 1)
        .filter(|v| !v.starts_with('-'))
        .cloned()
        .ok_or_else(|| format!("{name} requires a value"))
}

fn reject_positionals(opts: &Opts, ctx: &str) -> Result<(), String> {
    if let Some(p) = opts.positionals.first() {
        return Err(format!("unexpected argument {p:?} for {ctx}"));
    }
    Ok(())
}

fn run(cmd: Command) -> ExitCode {
    match cmd {
        Command::Version => {
            println!("pear-bridge {VERSION}");
            ExitCode::SUCCESS
        }
        Command::Help => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Command::VerifyAudit { path } => run_verify_audit(path),
        Command::Status { server, profile } => run_status(server.as_deref(), profile.as_deref()),
        Command::Connect {
            server,
            profile,
            token,
        } => run_connect(server, profile, token),
        Command::Unpair { .. } | Command::InstallService | Command::UninstallService => {
            eprintln!("not yet implemented in this build");
            ExitCode::SUCCESS
        }
    }
}

fn run_verify_audit(path: Option<String>) -> ExitCode {
    let path = path
        .map(PathBuf::from)
        .unwrap_or_else(audit::default_audit_path);
    match audit::verify(&path) {
        Ok(VerifyResult::Ok { entries }) => {
            println!(
                "audit log OK: {entries} entries, hash chain intact ({})",
                path.display()
            );
            ExitCode::SUCCESS
        }
        Ok(VerifyResult::Broken { line, reason }) => {
            eprintln!(
                "audit log BROKEN at line {line}: {reason} ({})",
                path.display()
            );
            ExitCode::from(1)
        }
        Err(e) => {
            eprintln!("could not read audit log {}: {e}", path.display());
            ExitCode::from(1)
        }
    }
}

fn run_status(server: Option<&str>, profile: Option<&str>) -> ExitCode {
    let config_path = config::default_path();
    match Config::load(&config_path) {
        Ok(cfg) => {
            match config::resolve_server(&cfg, profile, server) {
                Ok(s) => println!("server: {s}"),
                Err(e) => println!("server: unresolved ({e})"),
            }
            println!("config: {}", config_path.display());
        }
        Err(ConfigError::NotFound) => {
            println!(
                "not configured — run `pear-bridge` to set up (config would live at {})",
                config_path.display()
            );
        }
        Err(e) => {
            eprintln!("config error: {e}");
            return ExitCode::from(1);
        }
    }
    println!("audit log: {}", audit::default_audit_path().display());
    ExitCode::SUCCESS
}

// ── connect: the steady-state daemon loop ───────────────────────────────────
//
// Composes the tested building blocks (`PEAR_BRIDGE.md` § Startup sequence):
//   resolve server + device token → fetch tunnel token (`/api/bridge/auth`) →
//   dial the relay (`/bridge/relay`) → read the relay's `allowlist` bootstrap
//   frame → build the local AllowlistEnforcer → run the command engine
//   (`transport::run_session`) until the connection drops → reconnect (backoff).
//
// Under the relay-translates model the daemon speaks only JSON; the relay is the
// SpacetimeDB client. So the daemon learns its allowlist from the first relay
// frame rather than an STDB subscription.

/// Auth response from `POST /api/bridge/auth` (mirrors lifecycle `AuthResponse`).
#[derive(serde::Deserialize)]
struct AuthResp {
    tunnel_token: String,
    /// Unix seconds; mid-session refresh is a v2 item — each reconnect re-auths.
    #[allow(dead_code)]
    tunnel_token_expires_at: u64,
    device_id: u64,
}

fn run_connect(server: Option<String>, profile: Option<String>, token: Option<String>) -> ExitCode {
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("error: could not start async runtime: {e}");
            return ExitCode::from(1);
        }
    };
    rt.block_on(connect_main(server, profile, token))
}

async fn connect_main(
    server: Option<String>,
    profile: Option<String>,
    token_override: Option<String>,
) -> ExitCode {
    let server_url = match resolve_server_url(server.as_deref(), profile.as_deref()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(1);
        }
    };

    let store = KeyringStore::new();
    let device_token = match token_override {
        Some(t) => t,
        None => match store.load(&server_url) {
            Ok(Some(t)) => t,
            // No stored token → run first-run pairing (opens the browser pair
            // page, receives the device token over loopback, persists it).
            Ok(None) => match pair_device(&store, &server_url).await {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("error: pairing failed: {e}");
                    return ExitCode::from(1);
                }
            },
            Err(e) => {
                eprintln!("error: keychain: {e}");
                return ExitCode::from(1);
            }
        },
    };

    // The local audit log persists across reconnects; its hash chain resumes.
    let audit_path = audit::default_audit_path();
    let mut audit = match AuditLog::open(&audit_path) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: cannot open audit log {}: {e}", audit_path.display());
            return ExitCode::from(1);
        }
    };

    let http = reqwest::Client::new();
    eprintln!("pear-bridge connecting to {server_url} …");

    // Reconnect forever (until SIGINT). A session that held for a while resets
    // the backoff so a transient drop retries promptly.
    let mut backoff = Backoff::default();
    loop {
        let started = std::time::Instant::now();
        match run_once(&http, &server_url, &device_token, &mut audit).await {
            Ok(()) => eprintln!("relay connection closed; reconnecting…"),
            Err(e) => eprintln!("connection error: {e}"),
        }
        if started.elapsed() > std::time::Duration::from_secs(30) {
            backoff.reset();
        }
        tokio::time::sleep(backoff.next_delay()).await;
    }
}

/// One connection lifecycle: auth → dial → bootstrap allowlist → run the engine
/// until the stream ends. Returns `Ok(())` on a clean stream close, `Err` on a
/// failure worth logging before the reconnect backoff.
async fn run_once(
    http: &reqwest::Client,
    server_url: &str,
    device_token: &str,
    audit: &mut AuditLog,
) -> Result<(), String> {
    let auth = fetch_tunnel_token(http, server_url, device_token).await?;
    eprintln!("authenticated (device {}); dialing relay…", auth.device_id);

    let client =
        relay::RelayClient::new(server_url, &auth.tunnel_token).map_err(|e| e.to_string())?;
    let mut ws = client.connect().await.map_err(|e| e.to_string())?;

    // The relay sends the allowlist as the first frame, before any command.
    // Bounded so a half-open socket during bootstrap (relay accepted the WS but
    // never sent the frame) can't hang the daemon — it errors and reconnects.
    let frame = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        relay::next_text_frame(&mut ws),
    )
    .await
    .map_err(|_| "timed out waiting for the relay allowlist frame".to_string())?
    .ok_or("relay closed before sending the allowlist frame")?;
    let (cfg, limits) = transport::parse_allowlist_frame(&frame)
        .ok_or("first relay frame was not a valid allowlist frame")?;
    let enforcer = AllowlistEnforcer::new(cfg);
    for w in &enforcer.warnings {
        eprintln!("allowlist warning: {w}");
    }
    let exec = ExecConfig {
        shell: default_shell(),
        limits,
        server_url: server_url.to_string(),
    };

    // Report which inference providers this device can serve (claude / codex /
    // ollama), so AI users can discover them via `bridge_device_capability`.
    // Best-effort: a send failure ends the session (socket is dead anyway),
    // detection itself cannot fail — absent providers just produce no entry.
    let caps = providers::detect_capabilities().await;
    eprintln!(
        "detected inference providers: {}",
        if caps.is_empty() {
            "none".to_string()
        } else {
            caps.iter()
                .map(|c| {
                    format!("{}{}", c.provider, if c.available { "" } else { " (unavailable)" })
                })
                .collect::<Vec<_>>()
                .join(", ")
        }
    );
    {
        use futures_util::SinkExt;
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            transport::capabilities_frame(&caps),
        ))
        .await
        .map_err(|e| format!("failed to send capabilities frame: {e}"))?;
    }

    eprintln!("connected — waiting for commands");
    transport::run_session(ws, &enforcer, &exec, audit).await
}

/// Run first-run pairing, persist the resulting device token in the keychain and
/// the server in the config file, and return the token. The pair *page* base is
/// `PEAR_BRIDGE_PAIR_URL` when set (split-origin deployments where the UI and the
/// relay live on different hosts), else the server URL itself.
async fn pair_device(store: &KeyringStore, server_url: &str) -> Result<String, String> {
    let pair_base = std::env::var("PEAR_BRIDGE_PAIR_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| server_url.to_string());

    let token = pair::run_pairing(server_url, &pair_base)
        .await
        .map_err(|e| e.to_string())?;

    store
        .store(server_url, &token)
        .map_err(|e| format!("could not save device token to keychain: {e}"))?;

    // Persist the server so future runs connect without --server. Best-effort.
    let path = config::default_path();
    let mut cfg = Config::load(&path).unwrap_or_default();
    cfg.set_profile("default", server_url);
    if let Err(e) = cfg.save(&path) {
        eprintln!("warning: could not write config {}: {e}", path.display());
    }

    Ok(token)
}

/// `POST {server}/api/bridge/auth` with the device token; returns the tunnel token.
async fn fetch_tunnel_token(
    http: &reqwest::Client,
    server_url: &str,
    device_token: &str,
) -> Result<AuthResp, String> {
    let url = relay::auth_url(server_url).map_err(|e| e.to_string())?;
    let res = http
        .post(&url)
        .bearer_auth(device_token)
        .send()
        .await
        .map_err(|e| format!("auth request failed: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("auth returned {status}: {body}"));
    }
    res.json::<AuthResp>()
        .await
        .map_err(|e| format!("auth response parse failed: {e}"))
}

/// Resolve the server URL from an explicit `--server`, a config profile, or the
/// default profile. A `--server` works even with no config file (first-run /
/// headless). With no config and no `--server`, the device isn't set up.
fn resolve_server_url(server: Option<&str>, profile: Option<&str>) -> Result<String, String> {
    match Config::load(config::default_path()) {
        Ok(cfg) => config::resolve_server(&cfg, profile, server)
            .map(|s| s.to_string())
            .map_err(|e| e.to_string()),
        Err(ConfigError::NotFound) => server.map(|s| s.to_string()).ok_or_else(|| {
            "not configured — pass --server <url> or pair this device first".to_string()
        }),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_args_is_connect() {
        assert_eq!(
            parse_args(&[]).unwrap(),
            Command::Connect {
                server: None,
                profile: None,
                token: None
            }
        );
    }

    #[test]
    fn explicit_connect_subcommand_with_flags() {
        assert_eq!(
            parse_args(&args(&[
                "connect",
                "--server",
                "http://localhost:3000",
                "--token",
                "tok"
            ]))
            .unwrap(),
            Command::Connect {
                server: Some("http://localhost:3000".to_string()),
                profile: None,
                token: Some("tok".to_string()),
            }
        );
    }

    #[test]
    fn connect_with_flags() {
        let cmd = parse_args(&args(&[
            "--server",
            "https://p.example.com",
            "--profile",
            "work",
            "--token",
            "abc",
        ]))
        .unwrap();
        assert_eq!(
            cmd,
            Command::Connect {
                server: Some("https://p.example.com".to_string()),
                profile: Some("work".to_string()),
                token: Some("abc".to_string()),
            }
        );
    }

    #[test]
    fn version_subcommand_and_flag() {
        assert_eq!(parse_args(&args(&["version"])).unwrap(), Command::Version);
        assert_eq!(parse_args(&args(&["--version"])).unwrap(), Command::Version);
        assert_eq!(parse_args(&args(&["-V"])).unwrap(), Command::Version);
    }

    #[test]
    fn help_forms() {
        assert_eq!(parse_args(&args(&["help"])).unwrap(), Command::Help);
        assert_eq!(parse_args(&args(&["--help"])).unwrap(), Command::Help);
        assert_eq!(parse_args(&args(&["-h"])).unwrap(), Command::Help);
    }

    #[test]
    fn status_takes_server_and_profile() {
        assert_eq!(
            parse_args(&args(&["status", "--profile", "work"])).unwrap(),
            Command::Status {
                server: None,
                profile: Some("work".to_string())
            }
        );
    }

    #[test]
    fn verify_audit_optional_path() {
        assert_eq!(
            parse_args(&args(&["verify-audit"])).unwrap(),
            Command::VerifyAudit { path: None }
        );
        assert_eq!(
            parse_args(&args(&["verify-audit", "/tmp/a.log"])).unwrap(),
            Command::VerifyAudit {
                path: Some("/tmp/a.log".to_string())
            }
        );
        assert!(parse_args(&args(&["verify-audit", "a", "b"])).is_err());
    }

    #[test]
    fn service_and_unpair_subcommands() {
        assert_eq!(
            parse_args(&args(&["install-service"])).unwrap(),
            Command::InstallService
        );
        assert_eq!(
            parse_args(&args(&["uninstall-service"])).unwrap(),
            Command::UninstallService
        );
        assert_eq!(
            parse_args(&args(&["unpair"])).unwrap(),
            Command::Unpair {
                server: None,
                profile: None
            }
        );
    }

    #[test]
    fn errors_on_unknown_subcommand_flag_and_missing_value() {
        assert!(parse_args(&args(&["frobnicate"])).is_err());
        assert!(parse_args(&args(&["--nope"])).is_err());
        assert!(parse_args(&args(&["--server"])).is_err()); // missing value
        assert!(parse_args(&args(&["status", "extra"])).is_err()); // unexpected positional
    }
}
