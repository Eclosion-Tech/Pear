//! Child-isolated mock CLI tests only: no real account, model or keychain access.
#![cfg(unix)]
use pear_bridge::{confirmed_answer, daemon::IncomingCommand};
use serde_json::json;
use std::{os::unix::fs::PermissionsExt, path::PathBuf};
#[tokio::test]
async fn confirmed_answer_mock_cli() {
    if let Ok(case) = std::env::var("PEAR_TEST_ANSWER_CASE") {
        let root = PathBuf::from(std::env::var("HOME").unwrap());
        let expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + if case == "expiry" { 1000 } else { 300_000 };
        let cmd=IncomingCommand{command_id:1,device_id:2,session_id:3,conversation_id:0,requested_by:"a".repeat(64),command:"infer:claude-code".into(),
            cwd:None,confirmed:false,kind:Some("inference".into()),payload_json:Some(json!({"operation":"confirmed-answer-v1","principal_id":"a".repeat(64),"ai_user_id":"1",
                "approval_id":"12345678-1234-1234-1234-123456789abc","request_nonce":"22345678-1234-1234-1234-123456789abc","offer_fingerprint":"b".repeat(64),
                "configuration_fingerprint":"c".repeat(64),"cli_version":if case=="version" {"different"}else{"mock"},"expires_at_ms":expires,"text":"Approved text only."}).to_string())};
        let result = confirmed_answer::run(&cmd).await;
        assert_eq!(result.ok, case == "success", "{:?}", result.error);
        assert!(!result.output.contains("SECRET"));
        let runs = std::fs::read_to_string(root.join("runs")).unwrap_or_default();
        assert_eq!(
            runs.lines().count(),
            if ["success", "malformed", "oversized"].contains(&case.as_str()) {
                1
            } else {
                0
            }
        );
        if case == "success" {
            let args = std::fs::read_to_string(root.join("argv")).unwrap();
            assert!(args.contains("--tools\n\n"));
            assert!(args.contains("--strict-mcp-config"));
            assert!(args.contains("disableAllHooks"));
            assert_eq!(
                std::fs::read_to_string(root.join("stdin")).unwrap(),
                "Approved text only."
            );
            assert!(std::fs::read_to_string(root.join("cwd"))
                .unwrap()
                .contains("scratch-12345678"));
        }
        return;
    }
    for case in [
        "success",
        "configured",
        "status",
        "version",
        "malformed",
        "api",
        "extra",
        "oversized",
        "expiry",
    ] {
        let root =
            std::env::temp_dir().join(format!("pear-confirmed-cli-{case}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("claude");
        let source = r#"#!/bin/sh
printf '%s\n' "$@" >> "$HOME/argv"
case "$*" in
 *'auth --help'*) printf 'Usage: claude auth [command]\nCommands:\n  status Show auth status\n'; exit 0;;
 *'auth status'*) if [ "$PEAR_TEST_ANSWER_CASE" = status ]; then printf '{"loggedIn":false,"SECRET":"hidden"}'; else printf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'; fi; exit 0;;
 *'--version'*) if [ "$PEAR_TEST_ANSWER_CASE" = expiry ]; then sleep 2; fi; printf 'mock'; exit 0;;
esac
printf 'run\n' >> "$HOME/runs"
pwd > "$HOME/cwd"
cat > "$HOME/stdin"
if [ "$PEAR_TEST_ANSWER_CASE" = oversized ]; then head -c 70000 /dev/zero | tr '\000' x; elif [ "$PEAR_TEST_ANSWER_CASE" = malformed ]; then printf 'SECRET'; else printf '{"type":"result","subtype":"success","is_error":false,"result":"A bounded answer.","SECRET":"hidden"}'; fi
"#;
        std::fs::write(&script, source).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "confirmed_answer_mock_cli", "--nocapture"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &root)
            .env("XDG_DATA_HOME", root.join("data"))
            .env("PEAR_TEST_ANSWER_CASE", case)
            .env("PEAR_BRIDGE_CLAUDE_BIN", &script)
            .env(
                "PEAR_BRIDGE_CLI_AUTH_POLICY",
                if case == "configured" {
                    "configured"
                } else {
                    "subscription-only"
                },
            )
            .env(
                "PEAR_BRIDGE_SUBSCRIPTION_EXTRA_USAGE_DISABLED",
                if case == "extra" { "0" } else { "1" },
            )
            .envs(if case == "api" {
                vec![("ANTHROPIC_API_KEY", "SECRET")]
            } else {
                vec![]
            })
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "mock case {case}: {}",
            String::from_utf8_lossy(&status.stderr)
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
