//! Explicit one-shot, tool-less subscription answer. Not a general executor.
use crate::{daemon::IncomingCommand, providers::InferenceResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};

pub const OPERATION: &str = "confirmed-answer-v1";
const MAX_PAYLOAD: usize = 16_384;
const MAX_TEXT: usize = 8_192;
const ATTEMPT_SECONDS: u64 = 120;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: String,
    principal_id: String,
    ai_user_id: String,
    approval_id: String,
    request_nonce: String,
    offer_fingerprint: String,
    configuration_fingerprint: String,
    cli_version: String,
    expires_at_ms: u64,
    text: String,
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn validate(r: &Request, cmd: &IncomingCommand) -> Result<(), &'static str> {
    if r.operation != OPERATION
        || cmd.kind.as_deref() != Some("inference")
        || cmd.command != "infer:claude-code"
        || cmd.cwd.is_some()
        || cmd.conversation_id != 0
        || cmd.device_id == 0
        || cmd.session_id == 0
        || !crate::principal::matches(&r.principal_id, &cmd.requested_by)
        || !uuid(&r.approval_id)
        || !uuid(&r.request_nonce)
        || !hex(&r.offer_fingerprint)
        || !hex(&r.configuration_fingerprint)
        || r.ai_user_id
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0)
            .is_none()
        || r.expires_at_ms <= now_ms()
        || r.expires_at_ms > now_ms().saturating_add(300_000)
        || r.cli_version.is_empty()
        || r.cli_version.len() > 256
        || r.text.trim().is_empty()
        || r.text.len() > MAX_TEXT
    {
        return Err("Invalid confirmed answer scope");
    }
    Ok(())
}
pub(crate) fn requested(raw: Option<&str>) -> bool {
    raw.and_then(|s| serde_json::from_str::<Value>(s).ok())
        .is_some_and(|v| v.get("operation").and_then(Value::as_str) == Some(OPERATION))
}
/// Library callers must supply an already-authorized Bridge command. This is
/// not a replacement for server-side device grants or human confirmation.
pub async fn run(cmd: &IncomingCommand) -> InferenceResult {
    let dir = crate::audit::default_audit_path().with_file_name("confirmed-answer-once");
    execute(cmd, &dir, |text, version, cwd, expires| {
        Box::pin(crate::confirmed_claude::run(text, version, cwd, expires))
    })
    .await
}
type AnswerFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, &'static str>> + Send + 'a>>;
async fn execute<F>(cmd: &IncomingCommand, dir: &Path, runner: F) -> InferenceResult
where
    F: for<'a> FnOnce(&'a str, &'a str, &'a Path, u64) -> AnswerFuture<'a>,
{
    let started = Instant::now();
    let mut correlation = String::new();
    let work = async {
        let raw = cmd
            .payload_json
            .as_deref()
            .filter(|s| s.len() <= MAX_PAYLOAD)
            .ok_or("Invalid confirmed answer payload")?;
        let r: Request =
            serde_json::from_str(raw).map_err(|_| "Invalid confirmed answer payload")?;
        validate(&r, cmd)?;
        let principal =
            crate::principal::canonical(&cmd.requested_by).ok_or("Invalid principal")?;
        let mut metadata = json!({"schema":"bridge-confirmed-answer-v1","command_id":cmd.command_id.to_string(),
            "device_id":cmd.device_id.to_string(),"session_id":cmd.session_id.to_string(),"principal_id":principal,
            "ai_user_id":r.ai_user_id,"approval_id":r.approval_id,"request_nonce":r.request_nonce,
            "offer_fingerprint":r.offer_fingerprint,"configuration_fingerprint":r.configuration_fingerprint,
            "cli_version":r.cli_version,"provider":"claude-code","auth":"subscription_login",
            "extra_usage":"operator_attested_disabled","tools":"disabled"});
        correlation = metadata.to_string();
        // Approval, not delivery nonce, is the device-side once key. Changing a
        // nonce cannot spend the same approval twice. Never reclaim on failure.
        crate::system_one::reserve(dir, &principal, &r.approval_id)?;
        let scratch = dir.join(format!("scratch-{}", r.approval_id));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&scratch)
                .map_err(|_| "Private answer directory unavailable")?;
        }
        #[cfg(not(unix))]
        {
            return Err("Confirmed answer unsupported on this platform");
        }
        let answer = runner(&r.text, &r.cli_version, &scratch, r.expires_at_ms).await;
        // Only this newly created empty scratch directory is removed. Nonempty
        // directories are retained; never recursively remove CLI-created files.
        let _ = std::fs::remove_dir(&scratch);
        let answer = answer?;
        if answer.is_empty() || answer.len() > 32_768 {
            return Err("Invalid answer size");
        }
        metadata["answer"] = json!(answer);
        Ok(metadata.to_string())
    };
    let (ok, output, error) =
        match tokio::time::timeout(Duration::from_secs(ATTEMPT_SECONDS), work).await {
            Ok(Ok(output)) => (true, output, None),
            Ok(Err(reason)) => (false, correlation.clone(), Some(reason.to_string())),
            Err(_) => (
                false,
                correlation.clone(),
                Some("Confirmed answer attempt timed out; no retry".into()),
            ),
        };
    let mut result = InferenceResult {
        ok,
        provider: "confirmed-answer".into(),
        model: None,
        output,
        tool_calls: None,
        thinking: None,
        usage: None,
        duration_ms: started.elapsed().as_millis() as u64,
        error,
    };
    // Nested JSON escaping must not exceed the completion envelope budget.
    if result.ok && result.to_json().len() > 65_536 {
        result.ok = false;
        result.output = correlation;
        result.error = Some("Confirmed answer exceeded wire limit".into());
    }
    result
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    fn command() -> IncomingCommand {
        IncomingCommand{command_id:9,device_id:2,session_id:3,conversation_id:0,requested_by:format!("0x{}","A".repeat(64)),
            command:"infer:claude-code".into(),cwd:None,confirmed:false,kind:Some("inference".into()),
            payload_json:Some(json!({"operation":OPERATION,"principal_id":"a".repeat(64),"ai_user_id":"1",
                "approval_id":"12345678-1234-1234-1234-123456789abc","request_nonce":"22345678-1234-1234-1234-123456789abc",
                "offer_fingerprint":"b".repeat(64),"configuration_fingerprint":"c".repeat(64),"cli_version":"mock","expires_at_ms":now_ms()+300_000,
                "text":"Explain a design tradeoff."}).to_string())}
    }
    fn directory(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pear-answer-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }
    #[test]
    fn changed_scope_expiry_and_oversized_text_are_refused() {
        for summary in ["infer:codex", "infer:ollama", "infer:claude-code:override"] {
            let mut cmd = command();
            cmd.command = summary.into();
            let r: Request = serde_json::from_str(cmd.payload_json.as_ref().unwrap()).unwrap();
            assert!(validate(&r, &cmd).is_err());
        }
        for (field, value) in [
            ("principal_id", json!("d".repeat(64))),
            ("expires_at_ms", json!(0)),
            ("expires_at_ms", json!(now_ms() + 400_000)),
            ("text", json!("x".repeat(8193))),
            ("approval_id", json!("12345678-1234-1234-1234-123456789abC")),
            ("cli_version", json!("")),
        ] {
            let mut cmd = command();
            let mut p: Value = serde_json::from_str(cmd.payload_json.as_ref().unwrap()).unwrap();
            p[field] = value;
            cmd.payload_json = Some(p.to_string());
            let r: Request = serde_json::from_str(cmd.payload_json.as_ref().unwrap()).unwrap();
            assert!(validate(&r, &cmd).is_err());
        }
    }
    #[tokio::test]
    async fn successful_answer_is_scoped_and_approval_cannot_be_replayed_with_a_new_nonce() {
        let mut cmd = command();
        let dir = directory("once");
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let result = execute(&cmd, &dir, move |text, version, cwd, _| {
            counter.fetch_add(1, Ordering::SeqCst);
            assert_eq!(text, "Explain a design tradeoff.");
            assert_eq!(version, "mock");
            assert_eq!(std::fs::read_dir(cwd).unwrap().count(), 0);
            Box::pin(async { Ok("A bounded answer.".into()) })
        })
        .await;
        assert!(result.ok, "{:?}", result.error);
        let receipt: Value = serde_json::from_str(&result.output).unwrap();
        assert_eq!(receipt["principal_id"], "a".repeat(64));
        assert_eq!(receipt["answer"], "A bounded answer.");
        let mut p: Value = serde_json::from_str(cmd.payload_json.as_ref().unwrap()).unwrap();
        p["request_nonce"] = json!("32345678-1234-1234-1234-123456789abc");
        cmd.payload_json = Some(p.to_string());
        let counter = calls.clone();
        assert!(
            !execute(&cmd, &dir, move |_, _, _, _| {
                counter.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok("wrong".into()) })
            })
            .await
            .ok
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn escaping_cannot_exceed_the_wire_budget() {
        let dir = directory("wire");
        let cmd = command();
        let result = execute(&cmd, &dir, |_, _, _, _| {
            Box::pin(async { Ok("\0".repeat(32_768)) })
        })
        .await;
        assert!(!result.ok);
        assert_eq!(
            result.error.as_deref(),
            Some("Confirmed answer exceeded wire limit")
        );
        assert!(result.to_json().len() < 65_536);
        assert!(
            !execute(&cmd, &dir, |_, _, _, _| panic!("must not repeat"))
                .await
                .ok
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn invalid_payload_never_runs_and_failed_launch_still_consumes_approval() {
        let dir = directory("failure");
        let mut cmd = command();
        let original = cmd.payload_json.clone();
        let mut p: Value = serde_json::from_str(original.as_ref().unwrap()).unwrap();
        p["prompt"] = json!("mixed");
        cmd.payload_json = Some(p.to_string());
        assert!(
            !execute(&cmd, &dir, |_, _, _, _| panic!("must not run"))
                .await
                .ok
        );
        cmd.payload_json = original;
        assert!(
            !execute(&cmd, &dir, |_, _, _, _| Box::pin(async {
                Err("Subscription guard refused")
            }))
            .await
            .ok
        );
        assert!(
            !execute(&cmd, &dir, |_, _, _, _| panic!("must not retry"))
                .await
                .ok
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
