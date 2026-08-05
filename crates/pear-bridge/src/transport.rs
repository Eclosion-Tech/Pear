//! The daemon's relay transport — a tiny JSON protocol over the relay WebSocket.
//!
//! Under the relay-translates design (`PEAR_BRIDGE.md` § The relay, option B),
//! the daemon speaks **no SpacetimeDB**: the relay is the STDB client (it holds
//! the per-device token, subscribes to `bridge_command`, and forwards), and the
//! daemon just exchanges two message shapes over the WS:
//!
//!   relay → daemon: `{"type":"command", <IncomingCommand fields>}`
//!   daemon → relay: `{"type":"result", "command_id":N, "status":"...", …}`
//!
//! This keeps the daemon a small, standalone OSS binary with zero STDB schema or
//! SDK coupling. [`WsCommandSource`] / [`WsResultSink`] adapt the WS to the
//! engine's [`CommandSource`] / [`ResultSink`] traits, so [`crate::daemon::run_loop`]
//! drives execution unchanged. The wire shapes are mirrored on the relay side
//! (`lifecycle/src/bridge_relay.rs`); keep the two in sync.

use std::time::Duration;

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::tungstenite::Message;

use crate::allowlist::{AllowlistConfig, AllowlistEnforcer, UnlistedPolicy};
use crate::audit::AuditLog;
use crate::daemon::{
    process_incoming, CommandSource, ExecConfig, IncomingCommand, Outcome, ResultSink,
};
use crate::pty::PtyLimits;

/// The relay's first frame on a fresh connection: the device's server-side
/// allowlist config, which the daemon turns into its local [`AllowlistConfig`]
/// (the binary still layers its non-removable baseline on top in
/// [`AllowlistEnforcer::new`]) and PTY [`PtyLimits`]. The daemon reads exactly
/// one of these before entering the command loop. Wire shape is produced by the
/// relay's `query_allowlist_frame` (`lifecycle/src/bridge_relay.rs`) — keep in
/// sync.
#[derive(Deserialize)]
struct AllowlistFrame {
    #[serde(rename = "type")]
    ty: String,
    #[serde(default)]
    allowed_commands: Vec<String>,
    #[serde(default)]
    blocked_patterns: Vec<String>,
    #[serde(default)]
    allowed_directories: Vec<String>,
    #[serde(default)]
    require_confirmation_for: Vec<String>,
    #[serde(default = "default_max_output_bytes")]
    max_output_bytes: usize,
    #[serde(default = "default_max_runtime_seconds")]
    max_runtime_seconds: u64,
    /// "prompt" | "reject". Absent (older relay) ⇒ strict `reject` — fail safe.
    #[serde(default = "default_unlisted_command_policy")]
    unlisted_command_policy: String,
}

fn default_max_output_bytes() -> usize {
    65_536
}
fn default_max_runtime_seconds() -> u64 {
    120
}
fn default_unlisted_command_policy() -> String {
    "reject".to_string()
}

/// Parse the `allowlist` bootstrap frame into the enforcer config + PTY limits.
/// Returns `None` if the text isn't a well-formed `allowlist` frame (so the
/// daemon can reject a connection that opened with the wrong frame).
pub fn parse_allowlist_frame(text: &str) -> Option<(AllowlistConfig, PtyLimits)> {
    let f: AllowlistFrame = serde_json::from_str(text).ok()?;
    if f.ty != "allowlist" {
        return None;
    }
    let config = AllowlistConfig {
        allowed_commands: f.allowed_commands,
        blocked_patterns: f.blocked_patterns,
        allowed_directories: f.allowed_directories,
        require_confirmation_for: f.require_confirmation_for,
        unlisted_policy: match f.unlisted_command_policy.as_str() {
            "prompt" => UnlistedPolicy::Prompt,
            _ => UnlistedPolicy::Reject,
        },
    };
    let limits = PtyLimits {
        max_output_bytes: f.max_output_bytes,
        max_runtime: Duration::from_secs(f.max_runtime_seconds),
    };
    Some((config, limits))
}

/// Inbound frame from the relay. Internally tagged by `type`; the `command`
/// variant flattens an [`IncomingCommand`].
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Inbound {
    Command(IncomingCommand),
}

/// Parse an inbound text frame into a command, or `None` if it isn't a
/// well-formed `command` frame (control/unknown frames are ignored).
fn parse_inbound(text: &str) -> Option<IncomingCommand> {
    match serde_json::from_str::<Inbound>(text) {
        Ok(Inbound::Command(cmd)) => Some(cmd),
        Err(_) => None,
    }
}

/// Serialize the device's detected inference providers into a `capabilities`
/// frame: `{"type":"capabilities","capabilities":[{"provider":…,"available":…,
/// "version":…,"models":…}]}`. Sent daemon → relay once per connection, right
/// after the allowlist bootstrap frame is parsed; the relay mirrors each entry
/// into `report_bridge_device_capability`. An empty detection still produces a
/// frame (an empty list is itself information: no providers on this device).
pub fn capabilities_frame(caps: &[crate::providers::ProviderCapability]) -> String {
    #[derive(serde::Serialize)]
    struct CapabilitiesFrame<'a> {
        #[serde(rename = "type")]
        ty: &'a str,
        capabilities: &'a [crate::providers::ProviderCapability],
    }
    serde_json::to_string(&CapabilitiesFrame {
        ty: "capabilities",
        capabilities: caps,
    })
    .unwrap_or_else(|_| r#"{"type":"capabilities","capabilities":[]}"#.to_string())
}

/// Serialize one streaming delta into a `chunk` frame:
/// `{"type":"chunk","command_id":N,"seq":K,"content":"…"}`. The relay mirrors
/// it into `append_bridge_command_chunk`; older relays ignore unknown frames.
pub fn chunk_frame(command_id: u64, chunk: &crate::providers::ChunkOut) -> String {
    serde_json::json!({
        "type": "chunk",
        "command_id": command_id,
        "seq": chunk.seq,
        "content": chunk.content,
    })
    .to_string()
}

/// Serialize an outcome into a `result` frame: `{"type":"result","command_id":N,
/// "status":"...", …}` (the `Outcome` is flattened, tagged by `status`).
fn result_json(command_id: u64, outcome: &Outcome) -> Result<String, String> {
    #[derive(serde::Serialize)]
    struct ResultFrame<'a> {
        #[serde(rename = "type")]
        ty: &'a str,
        command_id: u64,
        #[serde(flatten)]
        outcome: &'a Outcome,
    }
    serde_json::to_string(&ResultFrame {
        ty: "result",
        command_id,
        outcome,
    })
    .map_err(|e| format!("failed to serialize result frame: {e}"))
}

/// Adapts the read half of the relay WS to [`CommandSource`].
pub struct WsCommandSource<S> {
    stream: S,
}

impl<S, E> CommandSource for WsCommandSource<S>
where
    S: Stream<Item = Result<Message, E>> + Unpin,
{
    async fn next_command(&mut self) -> Option<IncomingCommand> {
        while let Some(item) = self.stream.next().await {
            match item {
                Ok(Message::Text(text)) => {
                    if let Some(cmd) = parse_inbound(&text) {
                        return Some(cmd);
                    }
                    // Non-command / malformed text — skip and keep reading.
                }
                // Connection closed or errored → end the stream.
                Ok(Message::Close(_)) | Err(_) => return None,
                // Ping/pong/binary frames are not part of the protocol.
                Ok(_) => {}
            }
        }
        None
    }
}

/// Adapts the write half of the relay WS to [`ResultSink`].
pub struct WsResultSink<K> {
    sink: K,
}

impl<K, E> ResultSink for WsResultSink<K>
where
    K: Sink<Message, Error = E> + Unpin,
{
    async fn send_outcome(&mut self, command_id: u64, outcome: Outcome) -> Result<(), String> {
        let json = result_json(command_id, &outcome)?;
        self.sink
            .send(Message::Text(json))
            .await
            .map_err(|_| "failed to send result frame to relay".to_string())
    }
}

/// How often the daemon sends a WS Ping. The relay auto-Pongs, so a healthy but
/// otherwise-quiet connection keeps producing inbound frames; a Ping that can't
/// be delivered (dead socket) surfaces as a send error → reconnect.
const PING_INTERVAL: Duration = Duration::from_secs(20);

/// If no frame of ANY kind (command, pong, ping, close) arrives within this
/// window, the connection is treated as dead and the session ends so the caller
/// reconnects. This is the fix for a silently half-open socket (NAT/idle
/// timeout, laptop sleep, a relay that drops without a clean Close): without it,
/// `read.next().await` blocks forever and the daemon never reconnects even
/// though the relay has already marked the device disconnected. Kept a
/// comfortable multiple of `PING_INTERVAL` so a healthy idle link (pong-only
/// traffic) never trips it.
const IDLE_TIMEOUT: Duration = Duration::from_secs(70);

/// Run one relay session: drive command execution while keeping the WebSocket
/// alive with periodic Pings and a read-idle deadline. Returns `Ok(())` on a
/// clean close / stream end, `Err` on a transport error or idle timeout.
/// Reconnect/token-refresh are the caller's responsibility (see the reconnect
/// loop in `main.rs` / `relay::run_with_reconnect`).
///
/// `process_command` runs inline (synchronous PTY work), so the keepalive pauses
/// for the duration of a command; we count a just-finished command as fresh
/// activity so a long command can't immediately trip the idle deadline. Moving
/// execution onto `spawn_blocking` so pings continue mid-command is a known
/// follow-up (see PEAR_BRIDGE.md).
pub async fn run_session<W, E>(
    ws: W,
    enforcer: &AllowlistEnforcer,
    exec: &ExecConfig,
    audit: &mut AuditLog,
) -> Result<(), String>
where
    W: Stream<Item = Result<Message, E>> + Sink<Message, Error = E> + Unpin,
{
    let (mut write, mut read) = ws.split();

    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // `interval`'s first tick fires immediately — consume it so the first real
    // ping is one interval in, not at t=0.
    ping.tick().await;

    let mut last_activity = tokio::time::Instant::now();

    loop {
        tokio::select! {
            item = read.next() => match item {
                Some(Ok(msg)) => {
                    last_activity = tokio::time::Instant::now();
                    match msg {
                        Message::Text(text) => {
                            if let Some(cmd) = parse_inbound(&text) {
                                // Keep WS pings flowing WHILE the command runs:
                                // harness/inference turns can take many minutes
                                // and an idle socket gets cut by LB timeouts.
                                // (Bash still blocks inside its synchronous PTY
                                // call — no await points to ping at — which is
                                // the documented spawn_blocking follow-up.)
                                // Streaming inference emits chunk deltas through
                                // this channel mid-run; they become `chunk`
                                // frames the relay writes into
                                // bridge_command_chunk.
                                let (chunk_tx, mut chunk_rx) =
                                    tokio::sync::mpsc::unbounded_channel::<crate::providers::ChunkOut>();
                                let work =
                                    process_incoming(&cmd, enforcer, exec, audit, Some(chunk_tx));
                                tokio::pin!(work);
                                let outcome = loop {
                                    tokio::select! {
                                        outcome = &mut work => break outcome,
                                        chunk = chunk_rx.recv() => {
                                            if let Some(chunk) = chunk {
                                                let frame = chunk_frame(cmd.command_id, &chunk);
                                                let _ = write.send(Message::Text(frame)).await;
                                            }
                                        }
                                        _ = ping.tick() => {
                                            let _ = write.send(Message::Ping(Vec::new())).await;
                                        }
                                    }
                                };
                                // Chunks emitted between the last poll and
                                // completion still precede the result frame.
                                while let Ok(chunk) = chunk_rx.try_recv() {
                                    let frame = chunk_frame(cmd.command_id, &chunk);
                                    let _ = write.send(Message::Text(frame)).await;
                                }
                                let json = result_json(cmd.command_id, &outcome)?;
                                write
                                    .send(Message::Text(json))
                                    .await
                                    .map_err(|_| "failed to send result frame to relay".to_string())?;
                                // Executing can take a while; count the finished
                                // work as activity so the idle deadline isn't
                                // measured from before the command started.
                                last_activity = tokio::time::Instant::now();
                            }
                            // Non-command text — ignore, keep the session alive.
                        }
                        // Clean server close → end session; caller reconnects.
                        Message::Close(_) => return Ok(()),
                        // Ping/Pong/Binary aren't part of the protocol; tungstenite
                        // auto-Pongs incoming Pings. Receiving anything is liveness.
                        _ => {}
                    }
                }
                // Transport error → end with an error so the caller logs + backs off.
                Some(Err(_)) => return Err("relay stream error".to_string()),
                // Stream ended → clean close.
                None => return Ok(()),
            },
            _ = ping.tick() => {
                if last_activity.elapsed() >= IDLE_TIMEOUT {
                    return Err(format!(
                        "relay idle for {}s with no frames — treating connection as dead",
                        last_activity.elapsed().as_secs()
                    ));
                }
                write
                    .send(Message::Ping(Vec::new()))
                    .await
                    .map_err(|_| "failed to send keepalive ping to relay".to_string())?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_command_json(id: u64) -> String {
        format!(
            r#"{{"type":"command","command_id":{id},"device_id":1,"session_id":7,"conversation_id":9,"requested_by":"0xai","command":"git status","cwd":null,"confirmed":false}}"#
        )
    }

    #[test]
    fn parses_a_command_frame() {
        let cmd = parse_inbound(&sample_command_json(42)).expect("should parse");
        assert_eq!(cmd.command_id, 42);
        assert_eq!(cmd.device_id, 1);
        assert_eq!(cmd.command, "git status");
        assert_eq!(cmd.cwd, None);
        assert!(!cmd.confirmed);
    }

    #[test]
    fn parses_allowlist_bootstrap_frame() {
        let (cfg, limits) = parse_allowlist_frame(
            r#"{"type":"allowlist","allowed_commands":["git","ls"],"blocked_patterns":[],"allowed_directories":["/tmp"],"require_confirmation_for":["git push"],"max_output_bytes":4096,"max_runtime_seconds":30}"#,
        )
        .expect("should parse");
        assert_eq!(cfg.allowed_commands, vec!["git", "ls"]);
        assert_eq!(cfg.allowed_directories, vec!["/tmp"]);
        assert_eq!(cfg.require_confirmation_for, vec!["git push"]);
        assert_eq!(limits.max_output_bytes, 4096);
        assert_eq!(limits.max_runtime, std::time::Duration::from_secs(30));

        // Missing limits fall back to defaults.
        let (_, limits) = parse_allowlist_frame(r#"{"type":"allowlist"}"#).unwrap();
        assert_eq!(limits.max_output_bytes, 65_536);
        assert_eq!(limits.max_runtime, std::time::Duration::from_secs(120));

        // A non-allowlist frame is rejected.
        assert!(parse_allowlist_frame(r#"{"type":"command","command_id":1}"#).is_none());
        assert!(parse_allowlist_frame("garbage").is_none());
    }

    #[test]
    fn ignores_non_command_and_malformed_frames() {
        assert!(parse_inbound(r#"{"type":"pong"}"#).is_none());
        assert!(parse_inbound("not json").is_none());
        assert!(parse_inbound(r#"{"type":"command"}"#).is_none()); // missing fields
    }

    #[test]
    fn serializes_each_outcome_variant() {
        let completed = result_json(
            1,
            &Outcome::Completed {
                exit_code: Some(0),
                stdout: "ok".into(),
                stderr: String::new(),
                duration_ms: 5,
            },
        )
        .unwrap();
        assert!(completed.contains(r#""type":"result""#));
        assert!(completed.contains(r#""command_id":1"#));
        assert!(completed.contains(r#""status":"completed""#));
        assert!(completed.contains(r#""exit_code":0"#));

        let rejected = result_json(
            2,
            &Outcome::Rejected {
                reason: "nope".into(),
            },
        )
        .unwrap();
        assert!(rejected.contains(r#""status":"rejected""#));
        assert!(rejected.contains(r#""reason":"nope""#));

        let awaiting = result_json(
            3,
            &Outcome::AwaitingConfirmation {
                matched: "git push".into(),
            },
        )
        .unwrap();
        assert!(awaiting.contains(r#""status":"awaiting_confirmation""#));
        assert!(awaiting.contains(r#""matched":"git push""#));
    }

    #[tokio::test]
    async fn ws_command_source_yields_commands_and_stops_on_close() {
        // A stream mixing commands, a control frame (skipped), then Close.
        let items: Vec<Result<Message, std::io::Error>> = vec![
            Ok(Message::Text(sample_command_json(1))),
            Ok(Message::Text(r#"{"type":"pong"}"#.to_string())), // skipped
            Ok(Message::Ping(vec![])),                           // skipped
            Ok(Message::Text(sample_command_json(2))),
            Ok(Message::Close(None)),
            Ok(Message::Text(sample_command_json(3))), // never reached
        ];
        let mut source = WsCommandSource {
            stream: futures_util::stream::iter(items),
        };

        assert_eq!(source.next_command().await.unwrap().command_id, 1);
        assert_eq!(source.next_command().await.unwrap().command_id, 2);
        assert!(source.next_command().await.is_none()); // Close ends it
    }

    /// A WebSocket double that never yields an inbound frame (a silently
    /// half-open socket) but accepts and discards every send. This is the exact
    /// shape that hung the daemon for days before the keepalive: the relay had
    /// already dropped the device, but `read.next()` never returned.
    struct SilentWs;

    impl Stream for SilentWs {
        type Item = Result<Message, std::io::Error>;
        fn poll_next(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Self::Item>> {
            std::task::Poll::Pending
        }
    }

    impl Sink<Message> for SilentWs {
        type Error = std::io::Error;
        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn start_send(self: std::pin::Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            Ok(())
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    fn idle_test_enforcer() -> AllowlistEnforcer {
        AllowlistEnforcer::new(AllowlistConfig {
            unlisted_policy: UnlistedPolicy::Reject,
            allowed_commands: Vec::new(),
            blocked_patterns: Vec::new(),
            allowed_directories: Vec::new(),
            require_confirmation_for: Vec::new(),
        })
    }

    fn idle_test_exec() -> ExecConfig {
        ExecConfig {
            shell: "sh".to_string(),
            limits: PtyLimits::default(),
            server_url: "https://mypear.example.com".to_string(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn run_session_ends_when_the_connection_goes_idle() {
        // No inbound frame ever arrives. Once IDLE_TIMEOUT of virtual time passes
        // with no activity, run_session must return Err so the caller's reconnect
        // loop fires — instead of blocking forever (the multi-day "stuck
        // connected" bug). `start_paused` auto-advances the clock through the
        // ping ticks, so this completes instantly.
        let enforcer = idle_test_enforcer();
        let exec = idle_test_exec();
        let dir = std::env::temp_dir().join(format!("pear-bridge-idle-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut audit = AuditLog::open(&dir.join("audit.log")).unwrap();

        let res = run_session(SilentWs, &enforcer, &exec, &mut audit).await;
        assert!(res.is_err(), "an idle connection should end the session");
        assert!(res.unwrap_err().contains("idle"));
    }
}
