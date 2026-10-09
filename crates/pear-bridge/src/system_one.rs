//! Explicit local-only System One over the authorized Bridge command bus.
//! No CLI, chat/generate fallback, redirects, retries or inherited endpoint.
use crate::{daemon::IncomingCommand, providers::InferenceResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub const OPERATION: &str = "local-system-one-v1";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: String,
    principal_id: String,
    ai_user_id: String,
    request_nonce: String,
    configuration_fingerprint: String,
    endpoint: String,
    model: String,
    model_digest: String,
    request: Value,
}
fn hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}
pub(crate) fn requested(raw: Option<&str>) -> bool {
    raw.and_then(|s| serde_json::from_str::<Value>(s).ok())
        .is_some_and(|v| v.get("operation").and_then(Value::as_str) == Some(OPERATION))
}
fn validate(r: &Request, cmd: &IncomingCommand) -> Result<reqwest::Url, &'static str> {
    let u = reqwest::Url::parse(&r.endpoint).map_err(|_| "Invalid local endpoint")?;
    if r.operation != OPERATION
        || r.principal_id != cmd.requested_by
        || !hex(&r.principal_id)
        || !hex(&r.configuration_fingerprint)
        || !hex(&r.model_digest)
        || r.ai_user_id
            .parse::<u64>()
            .ok()
            .filter(|v| *v > 0)
            .is_none()
        || r.request_nonce.len() != 36
        || !r
            .request_nonce
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-')
        || u.scheme() != "http"
        || u.host_str() != Some("127.0.0.1")
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/v1/systemone"
        || r.model.is_empty()
        || r.model.len() > 128
        || r.model.ends_with(":cloud")
    {
        return Err("Invalid local System One scope");
    }
    let obj = r.request.as_object().ok_or("Invalid decision request")?;
    if obj.len() != 2 || !obj.contains_key("state") || !obj.contains_key("questions") {
        return Err("Invalid decision request");
    }
    let qs = obj["questions"].as_object().ok_or("Invalid questions")?;
    if qs.is_empty() || qs.len() > 4 {
        return Err("Invalid question count");
    }
    for (name, q) in qs {
        let q = q.as_object().ok_or("Invalid question")?;
        let criteria = q
            .get("criteria")
            .and_then(Value::as_object)
            .ok_or("Invalid criteria")?;
        if name.len() > 64
            || q.len() != 3
            || q.get("type").and_then(Value::as_str) != Some("choice")
            || q.get("instructions")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 2048)
                .is_none()
            || criteria.is_empty()
            || criteria.len() > 16
            || criteria
                .iter()
                .any(|(k, v)| k.len() > 64 || v.as_str().filter(|s| s.len() <= 1024).is_none())
        {
            return Err("Invalid question");
        }
    }
    Ok(u)
}
async fn bounded_json(response: reqwest::Response, max: usize) -> Result<Value, &'static str> {
    if !response.status().is_success() {
        return Err("Local System One HTTP failure");
    }
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err("Local response too large");
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local response read failed")?
    {
        if bytes.len() + chunk.len() > max {
            return Err("Local response too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid local response")
}
fn reserve(dir: &std::path::Path, principal: &str, nonce: &str) -> Result<(), &'static str> {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    #[cfg(not(unix))]
    return Err("Durable local decision reservation unsupported");
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        if !dir.is_absolute() {
            return Err("Local reservation directory unavailable");
        }
        std::fs::create_dir_all(dir).map_err(|_| "Local reservation directory unavailable")?;
        if std::fs::symlink_metadata(dir)
            .map_err(|_| "Local reservation directory unavailable")?
            .file_type()
            .is_symlink()
        {
            return Err("Unsafe reservation directory");
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Local reservation directory unavailable")?;
        let name = hex::encode(Sha256::digest(format!("{principal}:{nonce}")));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(dir.join(name))
            .map_err(|_| "Local decision allowance unavailable or already used")?;
        file.write_all(b"consumed\n")
            .and_then(|_| file.sync_all())
            .map_err(|_| "Local reservation unavailable")?;
        std::fs::File::open(dir)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Local reservation unavailable")?;
        Ok(())
    }
}
pub(crate) async fn run(cmd: &IncomingCommand) -> InferenceResult {
    let dir = crate::audit::default_audit_path().with_file_name("system-one-once");
    run_with_reservation(cmd, &dir).await
}
async fn run_with_reservation(cmd: &IncomingCommand, dir: &std::path::Path) -> InferenceResult {
    let started = Instant::now();
    let mut correlation = String::new();
    let work = async {
        let raw = cmd
            .payload_json
            .as_deref()
            .filter(|s| s.len() <= 16384)
            .ok_or("Invalid decision payload")?;
        let r: Request = serde_json::from_str(raw).map_err(|_| "Invalid decision payload")?;
        let endpoint = validate(&r, cmd)?;
        let metadata = json!({"schema":"bridge-local-system-one-v1", "request_nonce":r.request_nonce,
            "command_id":cmd.command_id.to_string(), "device_id":cmd.device_id.to_string(),
            "session_id":cmd.session_id.to_string(), "principal_id":cmd.requested_by,
            "ai_user_id":r.ai_user_id, "configuration_fingerprint":r.configuration_fingerprint,
            "endpoint":r.endpoint, "model_digest":r.model_digest});
        correlation = metadata.to_string();
        // Fail closed across command redelivery/restart, including a crash after
        // POST but before completion. Failed reservations are never reclaimed.
        reserve(dir, &r.principal_id, &r.request_nonce)?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| "Local client unavailable")?;
        // Verify the exact approved local weights before classification. Unknown
        // or remote model records fail closed; this is not an API billing meter.
        let tags_url = endpoint
            .join("/api/tags")
            .map_err(|_| "Invalid local endpoint")?;
        let tags = bounded_json(
            client
                .get(tags_url)
                .send()
                .await
                .map_err(|_| "Local catalog unavailable")?,
            262144,
        )
        .await?;
        let models = tags
            .get("models")
            .and_then(Value::as_array)
            .ok_or("Invalid local catalog")?;
        let matches: Vec<_> = models
            .iter()
            .filter(|m| m.get("name").and_then(Value::as_str) == Some(&r.model))
            .collect();
        if matches.len() != 1
            || matches[0].get("digest").and_then(Value::as_str) != Some(&r.model_digest)
            || matches[0].get("remote_host").is_some()
            || matches[0].get("remote_model").is_some()
            || matches[0]
                .get("size")
                .and_then(Value::as_u64)
                .filter(|n| *n > 0)
                .is_none()
        {
            return Err("Approved local weights unavailable");
        }
        let response = bounded_json(
            client
                .post(endpoint)
                .json(&json!({"model":r.model,
            "state":r.request["state"], "questions":r.request["questions"]}))
                .send()
                .await
                .map_err(|_| "Local decision unavailable")?,
            32768,
        )
        .await?;
        // Export only the recognized decision fields, never an opaque HTTP body.
        let model = response
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| *s == r.model)
            .ok_or("Decision model mismatch")?;
        let answers = response
            .get("answers")
            .and_then(Value::as_object)
            .ok_or("Invalid decision answers")?;
        let questions = r.request["questions"]
            .as_object()
            .ok_or("Invalid questions")?;
        if answers.len() != questions.len() {
            return Err("Question mismatch");
        }
        let mut clean = serde_json::Map::new();
        for (name, q) in questions {
            let a = answers.get(name).ok_or("Missing answer")?;
            let criteria = q["criteria"].as_object().ok_or("Invalid criteria")?;
            let choice = a
                .get("choice")
                .and_then(Value::as_str)
                .filter(|s| criteria.contains_key(*s))
                .ok_or("Invalid choice")?;
            let ps = a
                .get("probabilities")
                .and_then(Value::as_object)
                .ok_or("Missing probabilities")?;
            if a.get("type").and_then(Value::as_str) != Some("choice")
                || ps.len() != criteria.len()
                || ps.iter().any(|(k, v)| {
                    !criteria.contains_key(k)
                        || v.as_f64()
                            .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 1.0)
                            .is_none()
                })
            {
                return Err("Invalid probabilities");
            }
            clean.insert(
                name.clone(),
                json!({"type":"choice", "choice":choice, "probabilities":ps}),
            );
        }
        let mut output = metadata;
        output["decision"] = json!({"model":model, "answers":clean});
        Ok(output.to_string())
    };
    let attempt = tokio::time::timeout(Duration::from_secs(25), work).await;
    let (ok, output, error) = match attempt {
        Ok(Ok(output)) => (true, output, None),
        Ok(Err(e)) => (false, correlation, Some(e.to_string())),
        Err(_) => (false, correlation, Some("Local decision timed out".into())),
    };
    InferenceResult {
        ok,
        provider: "local-system-one".into(),
        model: None,
        output,
        tool_calls: None,
        thinking: None,
        usage: None,
        duration_ms: started.elapsed().as_millis() as u64,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};
    fn payload(endpoint: &str) -> Value {
        json!({"operation":OPERATION,"principal_id":"a".repeat(64),"ai_user_id":"1",
            "request_nonce":"12345678-1234-1234-1234-123456789abc","configuration_fingerprint":"b".repeat(64),
            "endpoint":endpoint,"model":"nimble:latest","model_digest":"c".repeat(64),
            "request":{"state":{"summary":"approved summary"},"questions":{"q":{"type":"choice",
            "instructions":"choose","criteria":{"a":"first","b":"second"}}}}})
    }
    fn cmd(p: Value) -> IncomingCommand {
        IncomingCommand {
            command_id: 9,
            device_id: 2,
            session_id: 3,
            conversation_id: 0,
            requested_by: "a".repeat(64),
            command: "infer:ollama".into(),
            cwd: None,
            confirmed: false,
            kind: Some("inference".into()),
            payload_json: Some(p.to_string()),
        }
    }
    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pear-system-one-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }
    fn server(responses: Vec<(u16, Value)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/systemone", listener.local_addr().unwrap());
        let captured = Arc::new(Mutex::new(Vec::new()));
        let c = captured.clone();
        std::thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buffer).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                    let text = String::from_utf8_lossy(&bytes);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text[..end]
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|s| s.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                c.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&bytes).to_string());
                let body = body.to_string();
                let _=write!(stream,"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            }
        });
        (url, captured)
    }
    fn tags(remote: bool, digest: &str) -> Value {
        let mut m = json!({"name":"nimble:latest","digest":digest,"size":8967243693u64});
        if remote {
            m["remote_host"] = json!("https://remote.invalid");
        }
        json!({"models":[m]})
    }
    #[test]
    fn invalid_scopes_and_mixed_prompts_are_rejected() {
        for (field, value) in [
            ("endpoint", json!("https://remote.invalid/v1/systemone")),
            ("endpoint", json!("http://localhost:11434/v1/systemone")),
            (
                "endpoint",
                json!("http://127.0.0.1:11434/v1/systemone?key=SECRET"),
            ),
            ("principal_id", json!("d".repeat(64))),
            ("model", json!("nimble:cloud")),
            ("model_digest", json!("bad")),
        ] {
            let mut p = payload("http://127.0.0.1:11434/v1/systemone");
            p[field] = value;
            let r: Request = serde_json::from_value(p.clone()).unwrap();
            assert!(validate(&r, &cmd(p)).is_err());
        }
        let mut p = payload("http://127.0.0.1:11434/v1/systemone");
        p["prompt"] = json!("never execute");
        assert!(serde_json::from_value::<Request>(p).is_err());
    }
    #[tokio::test]
    async fn only_local_catalog_and_decision_are_called_and_redelivery_is_refused() {
        let response = json!({"model":"nimble:latest","SECRET":"private","answers":{"q":{"type":"choice","choice":"a",
            "probabilities":{"a":0.8,"b":0.2},"SECRET":"private"}}});
        let (url, requests) = server(vec![(200, tags(false, &"c".repeat(64))), (200, response)]);
        let p = payload(&url);
        let d = dir("success");
        let r = run_with_reservation(&cmd(p.clone()), &d).await;
        assert!(r.ok, "{:?}", r.error);
        assert!(!r.output.contains("SECRET"));
        assert!(!r.output.contains("private"));
        let reqs = requests.lock().unwrap();
        assert_eq!(reqs.len(), 2);
        assert!(reqs[0].starts_with("GET /api/tags"));
        assert!(reqs[1].starts_with("POST /v1/systemone"));
        assert!(!reqs[1].contains("principal_id"));
        assert!(!reqs[1].contains("configuration_fingerprint"));
        drop(reqs);
        assert!(!run_with_reservation(&cmd(p), &d).await.ok);
        assert_eq!(requests.lock().unwrap().len(), 2);
        std::fs::remove_dir_all(d).unwrap();
    }
    #[tokio::test]
    async fn remote_wrong_digest_and_http_failure_never_post_decisions() {
        for (i, body, status) in [
            (0, tags(true, &"c".repeat(64)), 200),
            (1, tags(false, &"d".repeat(64)), 200),
            (2, json!({"SECRET":"never export"}), 302),
            (3, json!({"SECRET":"never export"}), 500),
        ] {
            let (url, requests) = server(vec![(status, body)]);
            let d = dir(&format!("refused-{i}"));
            let r = run_with_reservation(&cmd(payload(&url)), &d).await;
            assert!(!r.ok);
            assert!(!r.output.contains("SECRET"));
            assert!(!r.error.unwrap().contains("SECRET"));
            assert_eq!(requests.lock().unwrap().len(), 1);
            std::fs::remove_dir_all(d).unwrap();
        }
    }
    #[tokio::test]
    async fn invalid_or_oversized_decisions_are_not_exported() {
        for (i, response) in [
            (0, json!({"model":"other","SECRET":"private","answers":{}})),
            (
                1,
                json!({"model":"nimble:latest","SECRET":"x".repeat(40000)}),
            ),
        ] {
            let (url, _) = server(vec![(200, tags(false, &"c".repeat(64))), (200, response)]);
            let d = dir(&format!("bad-{i}"));
            let r = run_with_reservation(&cmd(payload(&url)), &d).await;
            assert!(!r.ok);
            assert!(!r.output.contains("SECRET"));
            std::fs::remove_dir_all(d).unwrap();
        }
    }
}
