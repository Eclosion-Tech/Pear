//! First-run pairing (`PEAR_BRIDGE.md` § UX: pairing flow — minimal variant).
//!
//! The daemon can't do the workspace-authenticated half of pairing (it has no
//! OIDC session). So it hands that to the browser: it starts a tiny loopback
//! listener, opens the Pear pair page with a `?callback` pointing at it, and the
//! signed-in page does the minting + `pair_bridge_device` call, then delivers
//! the freshly-generated device token back to the listener. The daemon stores
//! the token in the OS keychain and proceeds to connect.
//!
//! The loopback listener only ever accepts `127.0.0.1`, lives for one pairing,
//! and the token travels only over loopback. This avoids any STDB/OIDC code in
//! the daemon.

use std::fmt;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// How long to wait for the browser to complete pairing before giving up.
const PAIR_TIMEOUT: Duration = Duration::from_secs(300);

/// Run the interactive pairing handshake and return the raw device token.
///
/// `server_url` is what the daemon dials for relay/auth. `pair_base` is where
/// the pair *page* is served (often the same host; override via
/// `PEAR_BRIDGE_PAIR_URL` for split-origin deployments where the UI and the
/// relay live on different hosts).
pub async fn run_pairing(server_url: &str, pair_base: &str) -> Result<String, PairError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| PairError(format!("could not start loopback listener: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| PairError(format!("could not read listener address: {e}")))?
        .port();

    let callback = format!("http://127.0.0.1:{port}/pair");
    let pair_url = format!(
        "{}/bridge/pair?callback={}",
        pair_base.trim_end_matches('/'),
        urlencode(&callback)
    );

    println!("\nPairing this device with {server_url}.");
    println!("Complete sign-in in your browser:");
    println!("  {pair_url}");
    if let Err(e) = open_browser(&pair_url) {
        println!("(could not open a browser automatically: {e} — open the URL above manually)");
    }
    println!("\nWaiting for pairing to complete…");

    let token = tokio::time::timeout(PAIR_TIMEOUT, accept_token(&listener))
        .await
        .map_err(|_| PairError("pairing timed out (no callback within 5 minutes)".to_string()))??;

    println!("Device paired.");
    Ok(token)
}

/// Accept loopback connections until one carries `GET /pair?token=…`. Stray
/// requests (favicon, etc.) get a 404 and the loop continues.
async fn accept_token(listener: &TcpListener) -> Result<String, PairError> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| PairError(format!("accept failed: {e}")))?;
        match read_request_target(&mut stream).await {
            Ok(Some(target)) => {
                if let Some(token) = token_from_target(&target) {
                    let _ = respond(&mut stream, "200 OK", PAIRED_HTML).await;
                    return Ok(token);
                }
                let _ = respond(&mut stream, "404 Not Found", "not found").await;
            }
            // Couldn't parse a request line — drop this connection, keep waiting.
            Ok(None) | Err(_) => {
                let _ = respond(&mut stream, "400 Bad Request", "bad request").await;
            }
        }
    }
}

/// Read the HTTP request line and return its target (e.g. `/pair?token=…`).
async fn read_request_target(stream: &mut TcpStream) -> Result<Option<String>, PairError> {
    // The request line is the first line; reading a small prefix is enough.
    let mut buf = [0u8; 2048];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| PairError(format!("read failed: {e}")))?;
    if n == 0 {
        return Ok(None);
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    let first_line = head.lines().next().unwrap_or("");
    // "GET /pair?token=… HTTP/1.1"
    let mut parts = first_line.split_whitespace();
    let _method = parts.next();
    Ok(parts.next().map(|s| s.to_string()))
}

/// Extract `token` from a `/pair?token=…` request target.
fn token_from_target(target: &str) -> Option<String> {
    let (path, query) = target.split_once('?')?;
    if path != "/pair" {
        return None;
    }
    for pair in query.split('&') {
        if let Some(v) = pair.strip_prefix("token=") {
            let v = v.trim();
            if !v.is_empty() {
                return Some(urldecode(v));
            }
        }
    }
    None
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) -> Result<(), PairError> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|e| PairError(format!("write failed: {e}")))?;
    let _ = stream.flush().await;
    Ok(())
}

const PAIRED_HTML: &str =
    "<!doctype html><meta charset=utf-8><title>Paired</title><body style=\"font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem\"><h1>🍐 Device paired</h1><p>You can close this tab and return to your terminal.</p>";

/// Best-effort browser open. Failure is non-fatal — the URL was already printed.
fn open_browser(url: &str) -> Result<(), String> {
    use std::process::Command;
    let result = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Minimal percent-encoding for the callback URL embedded as a query value
/// (`:` and `/` are the only chars that matter here).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Minimal percent-decoding for the token query value.
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Debug)]
pub struct PairError(pub String);

impl fmt::Display for PairError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for PairError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_extracted_from_pair_target() {
        assert_eq!(
            token_from_target("/pair?token=abc123").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            token_from_target("/pair?foo=1&token=deadbeef&bar=2").as_deref(),
            Some("deadbeef")
        );
    }

    #[test]
    fn non_pair_targets_yield_no_token() {
        assert_eq!(token_from_target("/favicon.ico"), None);
        assert_eq!(token_from_target("/pair"), None);
        assert_eq!(token_from_target("/pair?token="), None);
        assert_eq!(token_from_target("/other?token=x"), None);
    }

    #[test]
    fn urlencode_roundtrips_callback() {
        let cb = "http://127.0.0.1:54321/pair";
        assert_eq!(urldecode(&urlencode(cb)), cb);
    }

    #[tokio::test]
    async fn accept_token_reads_a_pair_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { accept_token(&listener).await });

        // Simulate the browser's no-cors GET.
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"GET /pair?token=tok-xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        // Drain the response so the server can finish writing.
        let mut resp = Vec::new();
        let _ = client.read_to_end(&mut resp).await;

        let token = server.await.unwrap().unwrap();
        assert_eq!(token, "tok-xyz");
        assert!(String::from_utf8_lossy(&resp).contains("200 OK"));
    }
}
