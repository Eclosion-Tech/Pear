//! Mock CLIs only. No real login, model, credential-store or paid API calls.
#![cfg(unix)]
use pear_bridge::harness::run_harness_json;
use pear_bridge::providers::{run_inference_json, ChunkOut};
use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());
const ENV_KEYS: &[&str] = &[
    "PEAR_BRIDGE_CLI_AUTH_POLICY",
    "PEAR_BRIDGE_SUBSCRIPTION_EXTRA_USAGE_DISABLED",
    "PEAR_BRIDGE_CLAUDE_BIN",
    "PEAR_BRIDGE_CODEX_BIN",
    "HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
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
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_ACCESS_TOKEN",
    "CODEX_AUTH_TOKEN",
    "OPENAI_ACCESS_TOKEN",
    "PEAR_BRIDGE_ACP",
    "PEAR_BRIDGE_ACP_CLAUDE_CMD",
    "PEAR_BRIDGE_ACP_CODEX_CMD",
];
struct Fixture {
    root: PathBuf,
    saved: Vec<(&'static str, Option<OsString>)>,
}
impl Fixture {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!("pear-cli-auth-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("codex")).unwrap();
        std::fs::create_dir_all(root.join("claude")).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let saved = ENV_KEYS
            .iter()
            .map(|&key| (key, std::env::var_os(key)))
            .collect();
        for key in ENV_KEYS {
            std::env::remove_var(key);
        }
        std::env::set_var("HOME", &root);
        std::env::set_var("CODEX_HOME", root.join("codex"));
        std::env::set_var("CLAUDE_CONFIG_DIR", root.join("claude"));
        std::env::set_var("PEAR_BRIDGE_CLI_AUTH_POLICY", "subscription-only");
        std::env::set_var("PEAR_BRIDGE_SUBSCRIPTION_EXTRA_USAGE_DISABLED", "1");
        Self { root, saved }
    }
    fn script(&self, name: &str, body: &str) -> PathBuf {
        let file = self.root.join(name);
        std::fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        file
    }
    fn claude(&self, status: &str, streaming: bool) {
        let result = if streaming {
            r#"printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"mock answer"}]}}' '{"type":"result","result":"mock answer"}'"#
        } else {
            r#"printf '%s' '{"result":"mock answer"}'"#
        };
        let body = format!("printf '%s\\n' \"$*\" >> '{}'\ncase \"$*\" in\n *'auth --help'*) printf 'Usage: claude auth [command]\\nCommands:\\n  status Show auth status\\n'; exit 0;;\n *'auth status'*) printf '%s' '{}'; exit 0;;\nesac\nprintf 'run\\n' >> '{}'\ncat > /dev/null\n{result}",
            self.root.join("argv").display(), status, self.root.join("runs").display());
        let bin = self.script("fake-claude", &body);
        std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", bin);
    }
    fn codex(&self, status: &str) {
        let body = format!("printf '%s\\n' \"$*\" >> '{}'\ncase \"$*\" in\n *'login --help'*) printf 'Usage: codex login [COMMAND]\\nCommands:\\n  status Show login status\\n'; exit 0;;\n *'login status'*) printf '%s\\n' '{}' >&2; exit 0;;\nesac\nprintf 'run\\n' >> '{}'\ncat > /dev/null\nprintf 'mock codex'",
            self.root.join("argv").display(), status, self.root.join("runs").display());
        let bin = self.script("fake-codex", &body);
        std::env::set_var("PEAR_BRIDGE_CODEX_BIN", bin);
    }
    fn runs(&self) -> usize {
        std::fs::read_to_string(self.root.join("runs"))
            .unwrap_or_default()
            .lines()
            .count()
    }
    fn argv(&self) -> String {
        std::fs::read_to_string(self.root.join("argv")).unwrap_or_default()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[tokio::test]
async fn routing_preflight_reports_scoped_evidence_without_launching_inference() {
    use pear_bridge::allowlist::{AllowlistConfig, AllowlistEnforcer};
    use pear_bridge::audit::AuditLog;
    use pear_bridge::daemon::{process_incoming, ExecConfig, IncomingCommand, Outcome};
    use pear_bridge::pty::PtyLimits;
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("routing-preflight");
    let marker = f.root.join("model-called");
    let script = format!("case \"$*\" in\n *'auth --help'*) printf 'Usage: claude auth [command]\\nCommands:\\n status Read status\\n';;\n *'auth status'*) printf '%s' '{}';;\n '--version') printf 'fake-version';;\n *) touch '{}'; exit 42;;\nesac", CLAUDE_OK, marker.display());
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", f.script("probe-cli", &script));
    let principal = "a".repeat(64);
    let payload = serde_json::json!({"operation":"subscription-preflight-v1", "provider":"claude-code",
        "profile_id":"bridge_2_claude-code", "configuration_fingerprint":"b".repeat(64),
        "principal_id":principal, "ai_user_id":"1", "request_nonce":"12345678-1234-1234-1234-123456789abc",
        "expected_cli_version":"fake-version"});
    let mut cmd: IncomingCommand =
        serde_json::from_value(serde_json::json!({"command_id":9,"device_id":2,
        "session_id":3,"conversation_id":0,"requested_by":format!("0x{principal}"),"command":"infer:claude-code",
        "cwd":null,"confirmed":false,"kind":"inference","payload_json":payload.to_string()}))
        .unwrap();
    let enforcer = AllowlistEnforcer::new(AllowlistConfig::default());
    let exec = ExecConfig {
        shell: "sh".into(),
        limits: PtyLimits::default(),
        server_url: "test".into(),
    };
    let mut audit = AuditLog::open(f.root.join("audit.log")).unwrap();
    let outcome = process_incoming(&cmd, &enforcer, &exec, &mut audit, None, None).await;
    let Outcome::Completed {
        stdout, exit_code, ..
    } = outcome
    else {
        panic!("expected result");
    };
    assert_eq!(exit_code, Some(0));
    let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    let evidence: serde_json::Value =
        serde_json::from_str(result["output"].as_str().unwrap()).unwrap();
    assert_eq!(evidence["command_id"], "9");
    assert_eq!(evidence["device_id"], "2");
    assert_eq!(evidence["principal_id"], principal);
    assert_eq!(evidence["no_inference"], true);
    assert_eq!(evidence["extra_usage"], "operator_attested_disabled");
    assert!(!stdout.contains("private@example.test"));
    assert!(!marker.exists());
    // Both SDK and relay encodings must yield the same canonical receipt.
    for actual in [principal.clone(), format!("0x{}", principal.to_uppercase())] {
        cmd.requested_by = actual;
        let outcome = process_incoming(&cmd, &enforcer, &exec, &mut audit, None, None).await;
        let Outcome::Completed {
            stdout, exit_code, ..
        } = outcome
        else {
            panic!("expected result");
        };
        assert_eq!(exit_code, Some(0));
        let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();
        let evidence: serde_json::Value =
            serde_json::from_str(result["output"].as_str().unwrap()).unwrap();
        assert_eq!(evidence["principal_id"], principal);
        assert!(!marker.exists());
    }
    cmd.requested_by = format!("0x{principal}");
    // A different or malformed authenticated principal never passes this check.
    for actual in [format!("0x{}", "c".repeat(64)), "0xinvalid".into()] {
        cmd.requested_by = actual;
        assert!(matches!(
            process_incoming(&cmd, &enforcer, &exec, &mut audit, None, None).await,
            Outcome::Completed {
                exit_code: Some(1),
                ..
            }
        ));
        assert!(!marker.exists());
    }
    cmd.requested_by = format!("0x{principal}");
    // The prior daemon's ordinary adapter rejects the prompt-free payload.
    let legacy = run_inference_json(Some(&payload.to_string()), None).await;
    assert!(!legacy.ok);
    assert!(!marker.exists());
    let codex_script = format!("case \"$*\" in\n *'login --help'*) printf 'Usage: codex login [COMMAND]\\nCommands:\\n status Read status\\n';;\n *'login status'*) printf 'Logged in using ChatGPT' >&2;;\n '--version') printf 'fake-version';;\n *) touch '{}'; exit 42;;\nesac", marker.display());
    std::env::set_var(
        "PEAR_BRIDGE_CODEX_BIN",
        f.script("probe-codex", &codex_script),
    );
    let mut codex = payload.clone();
    codex["provider"] = "codex".into();
    codex["profile_id"] = "bridge_2_codex".into();
    cmd.payload_json = Some(codex.to_string());
    let outcome = process_incoming(&cmd, &enforcer, &exec, &mut audit, None, None).await;
    assert!(matches!(
        outcome,
        Outcome::Completed {
            exit_code: Some(0),
            ..
        }
    ));
    assert!(!marker.exists());
    let mut changed = payload.clone();
    changed["expected_cli_version"] = "changed".into();
    cmd.payload_json = Some(changed.to_string());
    let outcome = process_incoming(&cmd, &enforcer, &exec, &mut audit, None, None).await;
    assert!(matches!(
        outcome,
        Outcome::Completed {
            exit_code: Some(1),
            ..
        }
    ));
    assert!(!marker.exists());
    let mut mixed = payload.clone();
    mixed["prompt"] = "MUST NOT RUN".into();
    cmd.payload_json = Some(mixed.to_string());
    let outcome = process_incoming(&cmd, &enforcer, &exec, &mut audit, None, None).await;
    assert!(matches!(
        outcome,
        Outcome::Completed {
            exit_code: Some(1),
            ..
        }
    ));
    assert!(!marker.exists());
    std::env::set_var("PEAR_BRIDGE_CLI_AUTH_POLICY", "configured");
    cmd.payload_json = Some(payload.to_string());
    let outcome = process_incoming(&cmd, &enforcer, &exec, &mut audit, None, None).await;
    assert!(matches!(
        outcome,
        Outcome::Completed {
            exit_code: Some(1),
            ..
        }
    ));
    assert!(!marker.exists());
}

const CLAUDE_OK: &str = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max","email":"private@example.test"}"#;
async fn inference(provider: &str) -> pear_bridge::providers::InferenceResult {
    let json =
        serde_json::json!({"provider": provider, "prompt": "bounded task", "timeout_seconds": 2})
            .to_string();
    run_inference_json(Some(&json), None).await
}
fn harness(root: &Path, acp: bool, stream: bool) -> String {
    serde_json::json!({"provider":"claude-code", "session_id":"12345678-1234-1234-1234-123456789abc",
        "prompt":"bounded task", "cwd":root, "permission_mode":"plan", "acp":acp, "stream":stream}).to_string()
}

#[tokio::test]
async fn claude_and_alias_probe_before_each_launch_without_exporting_auth_output() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("claude");
    f.claude(CLAUDE_OK, false);
    for provider in ["claude-code", "claude"] {
        let result = inference(provider).await;
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.output, "mock answer");
        assert!(!result.to_json().contains("private@example.test"));
    }
    assert_eq!(f.runs(), 2);
    let args = f.argv();
    assert_eq!(args.matches("auth status").count(), 2);
    assert_eq!(args.matches("forceLoginMethod").count(), 6); // help + status + run, twice
    assert!(args.contains("--strict-mcp-config"));
    assert!(args.contains("--setting-sources"));
    assert!(!args.contains("--bare"));
    assert!(!args.contains("bounded task"));
}

#[tokio::test]
async fn codex_pins_chatgpt_and_openai_and_requires_status_before_exec() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("codex");
    f.codex("Logged in using ChatGPT");
    let result = inference("codex").await;
    assert!(result.ok, "{:?}", result.error);
    assert_eq!(result.output, "mock codex");
    assert_eq!(f.runs(), 1);
    let args = f.argv();
    assert!(args.contains("login status"));
    assert!(args.contains("exec --ephemeral"));
    assert_eq!(args.matches("forced_login_method=\"chatgpt\"").count(), 3);
    assert_eq!(args.matches("model_provider=\"openai\"").count(), 3);
}

#[tokio::test]
async fn api_unknown_and_malformed_statuses_never_execute_prompts_or_echo_secrets() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("bad-status");
    for status in [
        r#"{"loggedIn":true,"authMethod":"api_key","token":"SECRET"}"#,
        "SECRET malformed",
        "{}",
    ] {
        f.claude(status, false);
        let result = inference("claude-code").await;
        assert!(!result.ok);
        assert!(!result.to_json().contains("SECRET"));
    }
    for status in [
        "Logged in using an API key - SECRET",
        "Logged in using access token",
        "SECRET unknown",
    ] {
        f.codex(status);
        let result = inference("codex").await;
        assert!(!result.ok);
        assert!(!result.to_json().contains("SECRET"));
    }
    assert_eq!(f.runs(), 0);
}

#[tokio::test]
async fn inherited_key_gateway_cloud_and_bare_overrides_fail_before_status_probe() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("override");
    f.claude(CLAUDE_OK, false);
    f.codex("Logged in using ChatGPT");
    for (provider, names) in [
        (
            "claude-code",
            &[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_BASE_URL",
                "CLAUDE_CODE_SIMPLE",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_OAUTH_TOKEN",
            ][..],
        ),
        (
            "codex",
            &["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_ACCESS_TOKEN"][..],
        ),
    ] {
        for name in names {
            std::env::set_var(name, "SECRET");
            let result = inference(provider).await;
            std::env::remove_var(name);
            assert!(!result.ok);
            assert!(!result.to_json().contains("SECRET"));
        }
    }
    assert_eq!(f.runs(), 0);
    assert!(f.argv().is_empty());
}

#[tokio::test]
async fn missing_extra_usage_confirmation_and_invalid_policy_do_not_launch_any_cli() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("confirmation");
    f.claude(CLAUDE_OK, false);
    std::env::remove_var("PEAR_BRIDGE_SUBSCRIPTION_EXTRA_USAGE_DISABLED");
    assert!(!inference("claude-code").await.ok);
    std::env::set_var("PEAR_BRIDGE_CLI_AUTH_POLICY", "typo");
    assert!(!inference("claude-code").await.ok);
    assert!(f.argv().is_empty());
    assert_eq!(f.runs(), 0);
}

#[tokio::test]
async fn codex_rejects_custom_provider_profile_malformed_and_oversized_configuration() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("config");
    f.codex("Logged in using ChatGPT");
    for config in [
        "model_provider = 'custom'",
        "[model_providers.openai]\nbase_url = 'https://unapproved.test'",
        "[profiles.custom]\nmodel = 'anything'",
        "chatgpt_base_url = 'https://unapproved.test'",
        "SECRET malformed TOML",
    ] {
        std::fs::write(f.root.join("codex/config.toml"), config).unwrap();
        let result = inference("codex").await;
        assert!(!result.ok);
        assert!(!result.to_json().contains("SECRET"));
    }
    std::fs::write(f.root.join("codex/config.toml"), "#".repeat(65537)).unwrap();
    assert!(!inference("codex").await.ok);
    assert!(f.argv().is_empty());
    assert_eq!(f.runs(), 0);
}

#[tokio::test]
async fn codex_allows_non_auth_settings_and_rechecks_login_on_every_run() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("codex-config-ok");
    f.codex("Logged in using ChatGPT");
    std::fs::write(
        f.root.join("codex/config.toml"),
        "model = 'test-model'\nsandbox_mode = 'read-only'",
    )
    .unwrap();
    assert!(inference("codex").await.ok);
    f.codex("Logged in using an API key - SECRET");
    assert!(!inference("codex").await.ok);
    assert_eq!(f.runs(), 1);
}

#[tokio::test]
async fn claude_batch_and_streaming_harness_share_the_auth_guard() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("harness");
    f.claude(CLAUDE_OK, false);
    let batch = run_harness_json(
        Some(&harness(&f.root, false, false)),
        &[f.root.clone()],
        None,
    )
    .await;
    assert!(batch.ok, "{:?}", batch.error);
    f.claude(CLAUDE_OK, true);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<ChunkOut>();
    let stream = run_harness_json(
        Some(&harness(&f.root, false, true)),
        &[f.root.clone()],
        Some(tx),
    )
    .await;
    assert!(stream.ok, "{:?}", stream.error);
    assert_eq!(f.runs(), 2);
    f.claude(r#"{"loggedIn":true,"authMethod":"api_key"}"#, true);
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<ChunkOut>();
    let denied = run_harness_json(
        Some(&harness(&f.root, false, true)),
        &[f.root.clone()],
        Some(tx),
    )
    .await;
    assert!(!denied.ok);
    assert_eq!(f.runs(), 2);
}

#[tokio::test]
async fn strict_acp_is_rejected_before_an_adapter_can_spawn_or_download() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("acp");
    let marker = f.root.join("adapter-ran");
    let bin = f.script("acp", &format!("touch '{}'", marker.display()));
    std::env::set_var("PEAR_BRIDGE_ACP_CLAUDE_CMD", bin);
    let result = run_harness_json(
        Some(&harness(&f.root, true, false)),
        &[f.root.clone()],
        None,
    )
    .await;
    assert!(!result.ok);
    assert!(result.error.unwrap().contains("refuses ACP"));
    assert!(!marker.exists());
}

#[tokio::test]
async fn failed_and_oversized_auth_probes_never_send_a_prompt_or_echo_diagnostics() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("probe-errors");
    let bin = f.script(
        "failed-cli",
        "printf 'SECRET LOGIN DIAGNOSTIC' >&2; exit 17",
    );
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", bin);
    let result = inference("claude-code").await;
    assert!(!result.ok);
    assert!(!result.to_json().contains("SECRET"));
    let bin = f.script(
        "oversized-cli",
        "i=0; while [ $i -lt 1000 ]; do printf '012345678901234567890123456789'; i=$((i+1)); done",
    );
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", bin);
    let result = inference("claude-code").await;
    assert!(!result.ok);
    assert!(result.error.unwrap().contains("exceeded limit"));
    assert_eq!(f.runs(), 0);
}

#[tokio::test]
async fn missing_status_subcommand_is_refused_without_guessing_a_login_or_model_command() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("no-status-command");
    let marker = f.root.join("non-help-command");
    let bin = f.script("old-cli", &format!("case \"$*\" in *'--help'*) printf 'Usage: claude auth [command]\\nCommands:\\n login Sign in\\n'; exit 0;; esac; touch '{}'", marker.display()));
    std::env::set_var("PEAR_BRIDGE_CLAUDE_BIN", bin);
    let result = inference("claude-code").await;
    assert!(!result.ok);
    assert!(result.error.unwrap().contains("status command unavailable"));
    assert!(!marker.exists());
}

#[tokio::test]
async fn configured_mode_preserves_existing_api_auth_without_claiming_subscription_verification() {
    let _lock = ENV_LOCK.lock().unwrap();
    let f = Fixture::new("configured");
    f.claude("not called", false);
    std::env::set_var("PEAR_BRIDGE_CLI_AUTH_POLICY", "configured");
    std::env::set_var("ANTHROPIC_API_KEY", "fake API key");
    let result = inference("claude-code").await;
    assert!(result.ok);
    assert_eq!(f.runs(), 1);
    assert!(!f.argv().contains("auth status"));
    assert!(!f.argv().contains("forceLoginMethod"));
}
