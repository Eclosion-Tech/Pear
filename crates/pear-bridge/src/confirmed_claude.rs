//! Stronger, bounded Claude adapter used ONLY by the explicitly confirmed path.
use std::{
    path::Path,
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Status, version and execution use the same captured guard environment.
/// Never expose raw CLI JSON/stderr or enable tools.
pub(crate) async fn run(
    text: &str,
    expected_version: &str,
    cwd: &Path,
    expires_at_ms: u64,
) -> Result<String, &'static str> {
    let bin = std::env::var("PEAR_BRIDGE_CLAUDE_BIN").unwrap_or_else(|_| "claude".into());
    let args = vec![
        "-p".into(),
        "--output-format".into(),
        "json".into(),
        "--tools".into(),
        String::new(),
    ];
    let launch = crate::cli_auth::prepare(crate::cli_auth::CliProvider::Claude, &bin, &args, cwd)
        .await
        .map_err(|_| "Subscription guard refused")?;
    // Refuses configured/API snapshots even if hosting's earlier probe passed.
    let version = crate::cli_auth::prepared_version(&launch, &bin, cwd)
        .await
        .map_err(|_| "Strict snapshot unavailable")?;
    if version != expected_version {
        return Err("Confirmed CLI version changed");
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if now >= expires_at_ms {
        return Err("Confirmed approval expired before launch");
    }
    let mut child = launch
        .command(&bin, cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Confirmed CLI launch failed")?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Confirmed CLI input unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Confirmed CLI output unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Confirmed CLI diagnostics unavailable")?;
    let work = async {
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|_| "Confirmed CLI input failed")?;
        drop(stdin);
        let read = |stream: Box<dyn tokio::io::AsyncRead + Unpin + Send>| async move {
            let mut bytes = Vec::new();
            stream
                .take(65_537)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
        };
        let (out, err, status) =
            tokio::join!(read(Box::new(stdout)), read(Box::new(stderr)), child.wait());
        let out = out.map_err(|_| "Confirmed CLI output failed")?;
        let err = err.map_err(|_| "Confirmed CLI diagnostics failed")?;
        if out.len() > 65_536
            || err.len() > 65_536
            || !status.map_err(|_| "Confirmed CLI wait failed")?.success()
        {
            return Err("Confirmed CLI failed or exceeded output limit");
        }
        answer_text(&out)
    };
    tokio::time::timeout(Duration::from_secs(60), work)
        .await
        .map_err(|_| "Confirmed CLI timed out; no retry")?
}
fn answer_text(raw: &[u8]) -> Result<String, &'static str> {
    let value: serde_json::Value =
        serde_json::from_slice(raw).map_err(|_| "Invalid confirmed CLI result")?;
    if value.get("type").and_then(|v| v.as_str()) != Some("result")
        || value.get("subtype").and_then(|v| v.as_str()) != Some("success")
        || value.get("is_error").and_then(|v| v.as_bool()) != Some(false)
    {
        return Err("Confirmed CLI refused");
    }
    value
        .get("result")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty() && s.len() <= 32_768)
        .map(str::to_string)
        .ok_or("Invalid confirmed answer")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_recognized_success_text_is_exported() {
        let raw=br#"{"type":"result","subtype":"success","is_error":false,"result":"Answer.","SECRET":"hidden"}"#;
        assert_eq!(answer_text(raw).unwrap(), "Answer.");
        for raw in [
            br#"{"type":"result","subtype":"error","is_error":true,"result":"SECRET"}"#.as_slice(),
            br#"{"result":"SECRET"}"#,
            b"SECRET",
        ] {
            assert!(!answer_text(raw).unwrap_err().contains("SECRET"));
        }
    }
}
