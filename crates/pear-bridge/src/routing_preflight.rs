//! Prompt-free, read-only subscription evidence over the existing command bus.
//! Old daemons reject this payload because it has neither prompt nor chat.
use crate::cli_auth::{self, CliAuthPolicy, CliProvider};
use crate::daemon::IncomingCommand;
use crate::providers::InferenceResult;
use serde::Deserialize;
use std::time::Instant;

pub const OPERATION: &str = "subscription-preflight-v1";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: String,
    provider: String,
    profile_id: String,
    configuration_fingerprint: String,
    ai_user_id: String,
    principal_id: String,
    request_nonce: String,
    expected_cli_version: String,
}
fn hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
/// Any operation-bearing payload is intercepted: unknown/malformed requests
/// cannot accidentally fall through to model execution, including mixed prompts.
pub(crate) fn requested(raw: Option<&str>) -> bool {
    raw.and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .is_some_and(|v| v.get("operation").is_some())
}
pub(crate) async fn run(cmd: &IncomingCommand) -> InferenceResult {
    let started = Instant::now();
    let mut failure_output = String::new();
    let attempt = async {
        let raw = cmd.payload_json.as_deref().ok_or("Missing preflight payload")?;
        if raw.len() > 8192 { return Err("Preflight payload too large".to_string()); }
        let r: Request = serde_json::from_str(raw).map_err(|_| "Invalid preflight payload".to_string())?;
        if r.operation != OPERATION || !hex(&r.configuration_fingerprint)
            || !hex(&r.principal_id) || r.principal_id != cmd.requested_by
            || r.ai_user_id.is_empty() || r.ai_user_id.len() > 20
            || !r.ai_user_id.bytes().all(|b| b.is_ascii_digit())
            || r.request_nonce.len() != 36 || !r.request_nonce.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            || r.expected_cli_version.is_empty() || r.expected_cli_version.len() > 256
            || r.profile_id != format!("bridge_{}_{}", cmd.device_id, r.provider) {
            return Err("Preflight scope mismatch".to_string());
        }
        failure_output = serde_json::json!({"schema":"bridge-subscription-evidence-v1",
            "request_nonce":r.request_nonce, "command_id":cmd.command_id.to_string(),
            "device_id":cmd.device_id.to_string(), "principal_id":cmd.requested_by,
            "no_inference":true}).to_string();
        let (provider, bin, args) = match r.provider.as_str() {
            "claude-code" => (CliProvider::Claude, std::env::var("PEAR_BRIDGE_CLAUDE_BIN").unwrap_or_else(|_| "claude".into()),
                vec!["-p".into(), "--output-format".into(), "json".into(), "--tools".into(), "".into()]),
            "codex" => (CliProvider::Codex, std::env::var("PEAR_BRIDGE_CODEX_BIN").unwrap_or_else(|_| "codex".into()),
                vec!["exec".into(), "--ephemeral".into(), "--skip-git-repo-check".into(), "--color".into(), "never".into(), "-".into()]),
            _ => return Err("Unsupported preflight provider".to_string()),
        };
        if cli_auth::current_policy()? != CliAuthPolicy::SubscriptionOnly {
            return Err("Preflight requires subscription-only policy".to_string());
        }
        let cwd = std::env::temp_dir();
        // prepare validates the same fixed native launch profile without spawning
        // the prepared inference command or supplying any prompt.
        let launch = cli_auth::prepare(provider, &bin, &args, &cwd).await?;
        let version = cli_auth::prepared_version(&launch, &bin, &cwd).await?;
        if version != r.expected_cli_version { return Err("CLI report changed; refresh discovery".to_string()); }
        Ok(serde_json::json!({
            "schema":"bridge-subscription-evidence-v1", "no_inference":true,
            "device_id":cmd.device_id.to_string(), "command_id":cmd.command_id.to_string(),
            "session_id":cmd.session_id.to_string(), "principal_id":cmd.requested_by,
            "ai_user_id":r.ai_user_id, "profile_id":r.profile_id,
            "configuration_fingerprint":r.configuration_fingerprint, "request_nonce":r.request_nonce,
            "provider":r.provider, "cli_version":version, "task_profile":"chat",
            "auth_policy":"subscription-only", "auth":"subscription_login",
            "extra_usage":"operator_attested_disabled", "readiness":"auth_preflight_only"
        }).to_string())
    }.await;
    let (ok, output, error) = match attempt {
        Ok(output) => (true, output, None),
        Err(error) => (false, failure_output, Some(error)),
    };
    InferenceResult {
        ok,
        provider: "routing-preflight".into(),
        model: None,
        output,
        tool_calls: None,
        thinking: None,
        usage: None,
        duration_ms: started.elapsed().as_millis() as u64,
        error,
    }
}
