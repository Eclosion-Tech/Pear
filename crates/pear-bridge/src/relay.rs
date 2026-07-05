//! The relay client — the bridge's dial-out WebSocket connection
//! (`PEAR_BRIDGE.md` § Architecture → RelayClient, and § Auth model).
//!
//! The bridge dials **out** to the Pear server's `/bridge/relay` endpoint and
//! holds the connection; nothing dials in. It authenticates with a **tunnel
//! token only** (in the `Authorization` header, never the URL) — it holds no
//! SpacetimeDB token; the relay attaches the server-side STDB token on the far
//! side. This is the proxy model the spike (`spikes/bridge-relay-spike/`)
//! validated.
//!
//! This module provides the building blocks the daemon's run loop composes:
//! * URL derivation from a server URL ([`relay_ws_url`], [`auth_url`]),
//! * reconnect [`Backoff`],
//! * tunnel-token [`refresh_delay`] timing,
//! * the authenticated dial-out itself ([`RelayClient::connect`]).
//!
//! The full reconnect + token-refresh + frame-dispatch loop (which carries the
//! proxied SpacetimeDB subscription) is assembled in `main.rs` once the relay
//! endpoint and STDB module exist; it is glue over these tested pieces.

use std::fmt;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

/// The connected, authenticated WebSocket to the relay.
pub type RelayStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Derive the relay WebSocket URL (`…/bridge/relay`) from a server URL,
/// upgrading the scheme to `ws`/`wss` to match `http`/`https`.
pub fn relay_ws_url(server_url: &str) -> Result<String, RelayError> {
    let (scheme, rest) = split_scheme(server_url)?;
    let ws_scheme = match scheme {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        other => {
            return Err(RelayError::InvalidServerUrl(format!(
                "unsupported scheme {other:?}"
            )))
        }
    };
    Ok(format!(
        "{ws_scheme}://{}/bridge/relay",
        rest.trim_end_matches('/')
    ))
}

/// Derive the tunnel-token auth URL (`…/api/bridge/auth`) from a server URL,
/// keeping an `http`/`https` scheme.
pub fn auth_url(server_url: &str) -> Result<String, RelayError> {
    let (scheme, rest) = split_scheme(server_url)?;
    let http_scheme = match scheme {
        "https" | "wss" => "https",
        "http" | "ws" => "http",
        other => {
            return Err(RelayError::InvalidServerUrl(format!(
                "unsupported scheme {other:?}"
            )))
        }
    };
    Ok(format!(
        "{http_scheme}://{}/api/bridge/auth",
        rest.trim_end_matches('/')
    ))
}

fn split_scheme(url: &str) -> Result<(&str, &str), RelayError> {
    match url.split_once("://") {
        Some((scheme, rest)) if !scheme.is_empty() && !rest.is_empty() => Ok((scheme, rest)),
        _ => Err(RelayError::InvalidServerUrl(format!(
            "{url:?} is not an absolute URL (expected scheme://host)"
        ))),
    }
}

/// Exponential reconnect backoff: `base * factor^attempt`, capped at `max`.
/// Deterministic (no jitter) so it can be unit-tested; the run loop calls
/// [`Backoff::reset`] after a successful, stable connection.
#[derive(Clone, Debug)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    factor: u32,
    attempt: u32,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration, factor: u32) -> Self {
        Backoff {
            base,
            max,
            factor: factor.max(1),
            attempt: 0,
        }
    }

    /// The delay before the next reconnect attempt, then advances the counter.
    pub fn next_delay(&mut self) -> Duration {
        let mult = (self.factor as u64)
            .checked_pow(self.attempt)
            .unwrap_or(u64::MAX);
        let delay = self
            .base
            .checked_mul(mult.min(u32::MAX as u64) as u32)
            .unwrap_or(self.max);
        self.attempt = self.attempt.saturating_add(1);
        delay.min(self.max)
    }

    /// Reset after a healthy connection so the next disconnect retries quickly.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff::new(Duration::from_millis(500), Duration::from_secs(30), 2)
    }
}

/// How long to wait before refreshing the tunnel token: time until expiry minus
/// a safety `margin`, clamped to zero (refresh now if already within the
/// margin). All three arguments are durations since a common epoch.
pub fn refresh_delay(now: Duration, expires_at: Duration, margin: Duration) -> Duration {
    expires_at.saturating_sub(margin).saturating_sub(now)
}

/// Dials the relay and holds the connection. Construct with a server URL and a
/// tunnel token; [`RelayClient::connect`] performs the authenticated dial-out.
pub struct RelayClient {
    ws_url: String,
    tunnel_token: String,
}

impl RelayClient {
    pub fn new(server_url: &str, tunnel_token: impl Into<String>) -> Result<Self, RelayError> {
        Ok(RelayClient {
            ws_url: relay_ws_url(server_url)?,
            tunnel_token: tunnel_token.into(),
        })
    }

    /// The resolved relay WebSocket URL this client will dial.
    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// Dial the relay, presenting the tunnel token in the `Authorization`
    /// header. Returns the live WebSocket stream on success.
    pub async fn connect(&self) -> Result<RelayStream, RelayError> {
        let mut request = self
            .ws_url
            .as_str()
            .into_client_request()
            .map_err(|e| RelayError::Connect(e.to_string()))?;
        let bearer = format!("Bearer {}", self.tunnel_token)
            .parse()
            .map_err(|e| RelayError::Connect(format!("invalid token header: {e}")))?;
        request.headers_mut().insert("authorization", bearer);

        let (stream, _response) = connect_async(request)
            .await
            .map_err(|e| RelayError::Connect(e.to_string()))?;
        Ok(stream)
    }
}

/// Drive repeated connection attempts with [`Backoff`]. `attempt` is invoked for
/// each try: returning `Ok(())` means a clean shutdown (stop looping); returning
/// `Err(_)` schedules a backoff sleep (via `sleep`) and retries. Stops with an
/// error after `max_attempts` consecutive failures (`None` = retry forever).
/// `sleep` is injected so this can be tested without real time.
pub async fn run_with_reconnect<A, AFut, S, SFut>(
    mut attempt: A,
    mut sleep: S,
    mut backoff: Backoff,
    max_attempts: Option<u32>,
) -> Result<(), RelayError>
where
    A: FnMut() -> AFut,
    AFut: std::future::Future<Output = Result<(), RelayError>>,
    S: FnMut(Duration) -> SFut,
    SFut: std::future::Future<Output = ()>,
{
    let mut failures = 0u32;
    loop {
        match attempt().await {
            Ok(()) => return Ok(()),
            Err(e) => {
                failures += 1;
                if let Some(max) = max_attempts {
                    if failures >= max {
                        return Err(e);
                    }
                }
                let delay = backoff.next_delay();
                sleep(delay).await;
            }
        }
    }
}

/// Errors from URL derivation and connecting.
#[derive(Debug, Clone)]
pub enum RelayError {
    InvalidServerUrl(String),
    Connect(String),
}

impl fmt::Display for RelayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RelayError::InvalidServerUrl(e) => write!(f, "invalid server URL: {e}"),
            RelayError::Connect(e) => write!(f, "relay connection failed: {e}"),
        }
    }
}

impl std::error::Error for RelayError {}

/// Read the next text frame off the relay stream, skipping non-text frames.
/// The daemon uses this to consume the relay's `allowlist` bootstrap frame
/// before handing the stream to the command loop.
pub async fn next_text_frame(stream: &mut RelayStream) -> Option<String> {
    while let Some(Ok(msg)) = stream.next().await {
        if let tokio_tungstenite::tungstenite::Message::Text(t) = msg {
            return Some(t);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::SinkExt;
    use std::sync::{Arc, Mutex};

    // ---- pure helpers ----

    #[test]
    fn relay_ws_url_upgrades_scheme() {
        assert_eq!(
            relay_ws_url("https://mypear.example.com").unwrap(),
            "wss://mypear.example.com/bridge/relay"
        );
        assert_eq!(
            relay_ws_url("http://localhost:3000").unwrap(),
            "ws://localhost:3000/bridge/relay"
        );
        // trailing slash trimmed; base path preserved
        assert_eq!(
            relay_ws_url("https://host/base/").unwrap(),
            "wss://host/base/bridge/relay"
        );
        assert!(relay_ws_url("not-a-url").is_err());
        assert!(relay_ws_url("ftp://host").is_err());
    }

    #[test]
    fn auth_url_keeps_http_scheme() {
        assert_eq!(
            auth_url("https://mypear.example.com").unwrap(),
            "https://mypear.example.com/api/bridge/auth"
        );
        assert_eq!(
            auth_url("http://localhost:3000/").unwrap(),
            "http://localhost:3000/api/bridge/auth"
        );
    }

    #[test]
    fn backoff_grows_and_caps_and_resets() {
        let mut b = Backoff::new(Duration::from_millis(100), Duration::from_secs(1), 2);
        assert_eq!(b.next_delay(), Duration::from_millis(100)); // 100 * 2^0
        assert_eq!(b.next_delay(), Duration::from_millis(200)); // 2^1
        assert_eq!(b.next_delay(), Duration::from_millis(400)); // 2^2
        assert_eq!(b.next_delay(), Duration::from_millis(800)); // 2^3
        assert_eq!(b.next_delay(), Duration::from_secs(1)); // 2^4 = 1600ms -> capped at 1s
        assert_eq!(b.next_delay(), Duration::from_secs(1)); // stays capped
        b.reset();
        assert_eq!(b.next_delay(), Duration::from_millis(100));
    }

    #[test]
    fn refresh_delay_normal_and_past_due() {
        let now = Duration::from_secs(1000);
        let expires = Duration::from_secs(2800); // 30 min later
        let margin = Duration::from_secs(300); // 5 min
        assert_eq!(
            refresh_delay(now, expires, margin),
            Duration::from_secs(1500)
        );
        // already within the margin -> refresh now (zero)
        let soon = Duration::from_secs(1100);
        assert_eq!(refresh_delay(now, soon, margin), Duration::ZERO);
    }

    #[tokio::test]
    async fn run_with_reconnect_retries_then_succeeds() {
        // Fail twice, then succeed; assert the injected sleeper saw two backoff
        // delays and the loop stopped on success (no real time elapses).
        let calls = Arc::new(Mutex::new(0u32));
        let sleeps: Arc<Mutex<Vec<Duration>>> = Arc::new(Mutex::new(Vec::new()));

        let calls_a = calls.clone();
        let attempt = move || {
            let calls_a = calls_a.clone();
            async move {
                let mut n = calls_a.lock().unwrap();
                *n += 1;
                if *n < 3 {
                    Err(RelayError::Connect("boom".into()))
                } else {
                    Ok(())
                }
            }
        };
        let sleeps_s = sleeps.clone();
        let sleeper = move |d: Duration| {
            let sleeps_s = sleeps_s.clone();
            async move {
                sleeps_s.lock().unwrap().push(d);
            }
        };

        let res = run_with_reconnect(
            attempt,
            sleeper,
            Backoff::new(Duration::from_millis(10), Duration::from_secs(1), 2),
            Some(10),
        )
        .await;

        assert!(res.is_ok());
        assert_eq!(*calls.lock().unwrap(), 3);
        assert_eq!(
            *sleeps.lock().unwrap(),
            vec![Duration::from_millis(10), Duration::from_millis(20)]
        );
    }

    #[tokio::test]
    async fn run_with_reconnect_gives_up_after_max_attempts() {
        let attempt = || async { Err::<(), _>(RelayError::Connect("always".into())) };
        let sleeper = |_d: Duration| async {};
        let res = run_with_reconnect(attempt, sleeper, Backoff::default(), Some(3)).await;
        assert!(res.is_err());
    }

    // ---- authenticated dial-out against a local WS server ----

    #[tokio::test]
    async fn connect_presents_tunnel_token_and_receives_frame() {
        use tokio::net::TcpListener;
        use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
        use tokio_tungstenite::tungstenite::Message;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen_auth: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let seen = seen_auth.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let seen = seen.clone();
            let callback = |req: &Request, resp: Response| {
                if let Some(v) = req.headers().get("authorization") {
                    *seen.lock().unwrap() = v.to_str().ok().map(|s| s.to_string());
                }
                Ok(resp)
            };
            let mut ws = tokio_tungstenite::accept_hdr_async(stream, callback)
                .await
                .unwrap();
            ws.send(Message::Text("hello-from-relay".into()))
                .await
                .unwrap();
            // keep the connection briefly so the client can read
            let _ = ws.next().await;
        });

        // Build the client against this server (http -> ws).
        let client = RelayClient::new(&format!("http://{addr}"), "test-tunnel-123").unwrap();
        let mut stream = client.connect().await.expect("connect failed");

        let frame = next_text_frame(&mut stream).await;
        assert_eq!(frame.as_deref(), Some("hello-from-relay"));

        // Close client side and let the server task finish.
        let _ = stream.close(None).await;
        let _ = server.await;

        assert_eq!(
            seen_auth.lock().unwrap().as_deref(),
            Some("Bearer test-tunnel-123"),
            "the relay must receive the tunnel token in the Authorization header"
        );
    }
}
