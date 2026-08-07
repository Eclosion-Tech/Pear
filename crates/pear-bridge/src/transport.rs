//! The daemon's relay transport — a tiny JSON protocol over the relay WebSocket.
//!
//! Under the relay-translates design (`PEAR_BRIDGE.md` § The relay, option B),
//! the daemon speaks **no SpacetimeDB**: the relay is the STDB client (it holds
//! the per-device token, subscribes to `bridge_command`, and forwards), and the
//! daemon exchanges these message shapes over the WS:
//!
//!   relay → daemon: `{"type":"command", <IncomingCommand fields>}`
//!   relay → daemon: `{"type":"approval_decision","command_id":N,
//!     "request_id":"...","outcome":"selected"|"cancelled","option_id":"..."?}`
//!   daemon → relay: `{"type":"result", "command_id":N, "status":"...", …}`
//!   daemon → relay: `{"type":"approval_request","command_id":N,
//!     "request_id":"...","tool_call_id":"..."?,"title":"..."?,"kind":"..."?,
//!     "options":[{"optionId":"...","name":"...","kind":"..."}],
//!     "diffs":[{"path":"...","oldText":"..."?,"newText":"..."?}]?}`
//!
//! This keeps the daemon a small, standalone OSS binary with zero STDB schema or
//! SDK coupling. [`WsCommandSource`] / [`WsResultSink`] adapt the WS to the
//! engine's [`CommandSource`] / [`ResultSink`] traits, so [`crate::daemon::run_loop`]
//! drives execution unchanged. The wire shapes are mirrored on the relay side
//! (`lifecycle/src/bridge_relay.rs`); keep the two in sync.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::tungstenite::Message;

use crate::allowlist::{AllowlistConfig, AllowlistEnforcer, UnlistedPolicy};
use crate::audit::AuditLog;
use crate::daemon::{
    process_incoming, ApprovalDecision, ApprovalPort, ApprovalRequest, CommandSource, ExecConfig,
    IncomingCommand, Outcome, ResultSink,
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

/// Inbound frame from the relay. Wire values such as `outcome` remain open
/// strings; the ACP permission boundary validates them before granting access.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Inbound {
    Command(IncomingCommand),
    ApprovalDecision {
        command_id: u64,
        request_id: String,
        outcome: String,
        #[serde(default)]
        option_id: Option<String>,
    },
}

/// Parse a known inbound text frame. Malformed and unknown frames remain
/// ignored for forward compatibility with older/newer relays.
fn parse_inbound(text: &str) -> Option<Inbound> {
    serde_json::from_str(text).ok()
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

fn approval_request_json(command_id: u64, request: &ApprovalRequest) -> Result<String, String> {
    #[derive(serde::Serialize)]
    struct ApprovalRequestFrame<'a> {
        #[serde(rename = "type")]
        ty: &'a str,
        command_id: u64,
        request_id: &'a str,
        #[serde(flatten)]
        payload: &'a crate::daemon::ApprovalFramePayload,
    }
    serde_json::to_string(&ApprovalRequestFrame {
        ty: "approval_request",
        command_id,
        request_id: &request.request_id,
        payload: &request.frame_payload,
    })
    .map_err(|error| format!("failed to serialize approval_request frame: {error}"))
}

fn dispatch_approval_decision(
    pending: &mut HashMap<String, tokio::sync::oneshot::Sender<ApprovalDecision>>,
    request_id: String,
    outcome: String,
    option_id: Option<String>,
) {
    if let Some(responder) = pending.remove(&request_id) {
        let _ = responder.send(ApprovalDecision { outcome, option_id });
    }
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
                    if let Some(Inbound::Command(cmd)) = parse_inbound(&text) {
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
    let mut processor = DaemonProcessor {
        enforcer,
        exec,
        audit,
    };
    run_session_with_processor(ws, &mut processor).await
}

#[allow(async_fn_in_trait)]
trait SessionProcessor {
    async fn process(
        &mut self,
        command: &IncomingCommand,
        chunks: Option<crate::providers::ChunkSender>,
        approvals: Option<ApprovalPort>,
    ) -> Outcome;
}

struct DaemonProcessor<'a> {
    enforcer: &'a AllowlistEnforcer,
    exec: &'a ExecConfig,
    audit: &'a mut AuditLog,
}

impl SessionProcessor for DaemonProcessor<'_> {
    async fn process(
        &mut self,
        command: &IncomingCommand,
        chunks: Option<crate::providers::ChunkSender>,
        approvals: Option<ApprovalPort>,
    ) -> Outcome {
        process_incoming(
            command,
            self.enforcer,
            self.exec,
            self.audit,
            chunks,
            approvals,
        )
        .await
    }
}

async fn run_session_with_processor<W, E, P>(ws: W, processor: &mut P) -> Result<(), String>
where
    W: Stream<Item = Result<Message, E>> + Sink<Message, Error = E> + Unpin,
    P: SessionProcessor,
{
    let (mut write, mut read) = ws.split();

    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // `interval`'s first tick fires immediately — consume it so the first real
    // ping is one interval in, not at t=0.
    ping.tick().await;

    let mut last_activity = tokio::time::Instant::now();
    let mut queued_commands = VecDeque::new();
    let mut pending_approvals: HashMap<String, tokio::sync::oneshot::Sender<ApprovalDecision>> =
        HashMap::new();

    loop {
        pending_approvals.retain(|_, responder| !responder.is_closed());

        let command = if let Some(command) = queued_commands.pop_front() {
            command
        } else {
            loop {
                tokio::select! {
                    item = read.next() => match item {
                        Some(Ok(msg)) => {
                            last_activity = tokio::time::Instant::now();
                            match msg {
                                Message::Text(text) => match parse_inbound(&text) {
                                    Some(Inbound::Command(command)) => break command,
                                    Some(Inbound::ApprovalDecision {
                                        command_id: _command_id,
                                        request_id,
                                        outcome,
                                        option_id,
                                    }) => dispatch_approval_decision(
                                        &mut pending_approvals,
                                        request_id,
                                        outcome,
                                        option_id,
                                    ),
                                    None => {}
                                },
                                Message::Close(_) => return Ok(()),
                                // Ping/Pong/Binary handling is unchanged; any
                                // received frame is still proof of liveness.
                                _ => {}
                            }
                        }
                        Some(Err(_)) => return Err("relay stream error".to_string()),
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
        };

        // Keep reading while async work is in flight: ACP permission requests
        // block inside the active JSON-RPC turn until their matching decision
        // arrives. Commands eagerly read during that wait remain serialized by
        // this queue and are never run concurrently.
        let (chunk_tx, mut chunk_rx) =
            tokio::sync::mpsc::unbounded_channel::<crate::providers::ChunkOut>();
        let (approval_tx, mut approval_rx) =
            tokio::sync::mpsc::unbounded_channel::<ApprovalRequest>();
        let approval_port = ApprovalPort::new(command.command_id, approval_tx);
        let work = processor.process(&command, Some(chunk_tx), Some(approval_port));
        tokio::pin!(work);
        let outcome = loop {
            tokio::select! {
                outcome = &mut work => break outcome,
                Some(chunk) = chunk_rx.recv() => {
                    let frame = chunk_frame(command.command_id, &chunk);
                    write
                        .send(Message::Text(frame))
                        .await
                        .map_err(|_| "failed to send chunk frame to relay".to_string())?;
                }
                Some(request) = approval_rx.recv() => {
                    let frame = approval_request_json(command.command_id, &request)?;
                    write
                        .send(Message::Text(frame))
                        .await
                        .map_err(|_| "failed to send approval_request frame to relay".to_string())?;
                    if pending_approvals.contains_key(&request.request_id) {
                        return Err(format!(
                            "duplicate ACP approval request id: {}",
                            request.request_id
                        ));
                    }
                    pending_approvals.insert(request.request_id, request.responder);
                }
                item = read.next() => match item {
                    Some(Ok(msg)) => {
                        match msg {
                            Message::Text(text) => match parse_inbound(&text) {
                                Some(Inbound::ApprovalDecision {
                                    command_id: _command_id,
                                    request_id,
                                    outcome,
                                    option_id,
                                }) => dispatch_approval_decision(
                                    &mut pending_approvals,
                                    request_id,
                                    outcome,
                                    option_id,
                                ),
                                Some(Inbound::Command(command)) => {
                                    queued_commands.push_back(command);
                                }
                                None => {}
                            },
                            Message::Close(_) => return Ok(()),
                            _ => {}
                        }
                    }
                    Some(Err(_)) => return Err("relay stream error".to_string()),
                    None => return Ok(()),
                },
                _ = ping.tick() => {
                    write
                        .send(Message::Ping(Vec::new()))
                        .await
                        .map_err(|_| "failed to send keepalive ping to relay".to_string())?;
                }
            }
        };

        // Chunks emitted between the last poll and completion still precede
        // the result frame. Closed approval receivers are pruned so a timed-out
        // request cannot leak registry state for the lifetime of the socket.
        while let Ok(chunk) = chunk_rx.try_recv() {
            let frame = chunk_frame(command.command_id, &chunk);
            write
                .send(Message::Text(frame))
                .await
                .map_err(|_| "failed to send chunk frame to relay".to_string())?;
        }
        pending_approvals.retain(|_, responder| !responder.is_closed());
        let json = result_json(command.command_id, &outcome)?;
        write
            .send(Message::Text(json))
            .await
            .map_err(|_| "failed to send result frame to relay".to_string())?;
        // Executing can take a while; the next idle deadline starts when the
        // command finishes, never from before it began.
        last_activity = tokio::time::Instant::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::{ApprovalDiff, ApprovalFramePayload, ApprovalOption};
    use tokio::io::DuplexStream;
    use tokio_tungstenite::tungstenite::protocol::Role;
    use tokio_tungstenite::WebSocketStream;

    fn sample_command_json(id: u64) -> String {
        format!(
            r#"{{"type":"command","command_id":{id},"device_id":1,"session_id":7,"conversation_id":9,"requested_by":"0xai","command":"git status","cwd":null,"confirmed":false}}"#
        )
    }

    fn sample_approval_payload() -> ApprovalFramePayload {
        ApprovalFramePayload {
            tool_call_id: Some("tool-1".to_string()),
            title: Some("Edit settings".to_string()),
            kind: Some("edit".to_string()),
            options: vec![
                ApprovalOption {
                    option_id: "allow".to_string(),
                    name: "Allow once".to_string(),
                    kind: "allow_once".to_string(),
                },
                ApprovalOption {
                    option_id: "reject".to_string(),
                    name: "Reject".to_string(),
                    kind: "reject_once".to_string(),
                },
            ],
            diffs: Some(vec![ApprovalDiff {
                path: "src/lib.rs".to_string(),
                old_text: Some("old".to_string()),
                new_text: Some("new".to_string()),
            }]),
        }
    }

    #[test]
    fn parses_a_command_frame() {
        let Inbound::Command(cmd) = parse_inbound(&sample_command_json(42)).expect("should parse")
        else {
            panic!("expected command frame");
        };
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
    fn approval_frames_round_trip_with_documented_keys() {
        let (responder, _decision) = tokio::sync::oneshot::channel();
        let request = ApprovalRequest {
            request_id: "7-1".to_string(),
            frame_payload: sample_approval_payload(),
            responder,
        };
        let frame: serde_json::Value =
            serde_json::from_str(&approval_request_json(7, &request).unwrap()).unwrap();
        assert_eq!(frame["type"], "approval_request");
        assert_eq!(frame["command_id"], 7);
        assert_eq!(frame["request_id"], "7-1");
        assert_eq!(frame["tool_call_id"], "tool-1");
        assert_eq!(frame["title"], "Edit settings");
        assert_eq!(frame["kind"], "edit");
        assert_eq!(frame["options"][0]["optionId"], "allow");
        assert_eq!(frame["options"][0]["name"], "Allow once");
        assert_eq!(frame["options"][0]["kind"], "allow_once");
        assert_eq!(frame["diffs"][0]["path"], "src/lib.rs");
        assert_eq!(frame["diffs"][0]["oldText"], "old");
        assert_eq!(frame["diffs"][0]["newText"], "new");

        let decision = parse_inbound(
            r#"{"type":"approval_decision","command_id":7,"request_id":"7-1","outcome":"selected","option_id":"allow"}"#,
        )
        .expect("approval decision should parse");
        let Inbound::ApprovalDecision {
            command_id,
            request_id,
            outcome,
            option_id,
        } = decision
        else {
            panic!("expected approval decision");
        };
        assert_eq!(command_id, 7);
        assert_eq!(request_id, "7-1");
        assert_eq!(outcome, "selected");
        assert_eq!(option_id.as_deref(), Some("allow"));
    }

    #[tokio::test]
    async fn approval_registry_completes_once_and_ignores_unknown_or_duplicate_decisions() {
        let mut pending = HashMap::new();
        let (responder, decision) = tokio::sync::oneshot::channel();
        pending.insert("7-1".to_string(), responder);

        dispatch_approval_decision(
            &mut pending,
            "missing".to_string(),
            "cancelled".to_string(),
            None,
        );
        assert_eq!(pending.len(), 1);
        dispatch_approval_decision(
            &mut pending,
            "7-1".to_string(),
            "selected".to_string(),
            Some("allow".to_string()),
        );
        assert_eq!(
            decision.await.unwrap(),
            ApprovalDecision {
                outcome: "selected".to_string(),
                option_id: Some("allow".to_string()),
            }
        );
        assert!(pending.is_empty());

        dispatch_approval_decision(
            &mut pending,
            "7-1".to_string(),
            "selected".to_string(),
            Some("allow".to_string()),
        );
        assert!(pending.is_empty());
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

    struct BlockingApprovalProcessor {
        events: Vec<String>,
    }

    impl SessionProcessor for BlockingApprovalProcessor {
        async fn process(
            &mut self,
            command: &IncomingCommand,
            _chunks: Option<crate::providers::ChunkSender>,
            approvals: Option<ApprovalPort>,
        ) -> Outcome {
            self.events.push(format!("start-{}", command.command_id));
            let stdout = if command.command_id == 1 {
                let decision = approvals
                    .expect("relay session must supply approvals")
                    .request(sample_approval_payload())
                    .expect("approval request send failed")
                    .await
                    .expect("approval responder dropped");
                format!("{}:{:?}", decision.outcome, decision.option_id)
            } else {
                "second".to_string()
            };
            self.events.push(format!("end-{}", command.command_id));
            Outcome::Completed {
                exit_code: Some(0),
                stdout,
                stderr: String::new(),
                duration_ms: 0,
            }
        }
    }

    async fn websocket_pair() -> (WebSocketStream<DuplexStream>, WebSocketStream<DuplexStream>) {
        let (daemon_io, relay_io) = tokio::io::duplex(16 * 1024);
        let daemon = WebSocketStream::from_raw_socket(daemon_io, Role::Server, None).await;
        let relay = WebSocketStream::from_raw_socket(relay_io, Role::Client, None).await;
        (daemon, relay)
    }

    async fn next_text_frame(ws: &mut WebSocketStream<DuplexStream>) -> serde_json::Value {
        loop {
            match ws.next().await.expect("websocket ended").unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Ping(payload) => ws.send(Message::Pong(payload)).await.unwrap(),
                other => panic!("unexpected websocket frame: {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn run_session_delivers_approval_decision_while_work_is_in_flight() {
        let (daemon_ws, mut relay_ws) = websocket_pair().await;
        let mut processor = BlockingApprovalProcessor { events: Vec::new() };
        let relay = async {
            relay_ws
                .send(Message::Text(sample_command_json(1)))
                .await
                .unwrap();
            let request = next_text_frame(&mut relay_ws).await;
            assert_eq!(request["type"], "approval_request");
            relay_ws
                .send(Message::Text(
                    serde_json::json!({
                        "type": "approval_decision",
                        "command_id": 1,
                        "request_id": request["request_id"],
                        "outcome": "selected",
                        "option_id": "allow",
                    })
                    .to_string(),
                ))
                .await
                .unwrap();
            let result = next_text_frame(&mut relay_ws).await;
            assert_eq!(result["type"], "result");
            assert_eq!(result["command_id"], 1);
            assert_eq!(result["stdout"], "selected:Some(\"allow\")");
            relay_ws.close(None).await.unwrap();
        };

        let (session, ()) =
            tokio::join!(run_session_with_processor(daemon_ws, &mut processor), relay);
        session.unwrap();
        assert_eq!(processor.events, ["start-1", "end-1"]);
    }

    #[tokio::test]
    async fn command_arriving_mid_work_is_queued_until_current_command_finishes() {
        let (daemon_ws, mut relay_ws) = websocket_pair().await;
        let mut processor = BlockingApprovalProcessor { events: Vec::new() };
        let relay = async {
            relay_ws
                .send(Message::Text(sample_command_json(1)))
                .await
                .unwrap();
            let request = next_text_frame(&mut relay_ws).await;
            assert_eq!(request["type"], "approval_request");

            // This command is deliberately sent before the first command's
            // decision; eager reading must preserve it without concurrent work.
            relay_ws
                .send(Message::Text(sample_command_json(2)))
                .await
                .unwrap();
            relay_ws
                .send(Message::Text(
                    serde_json::json!({
                        "type": "approval_decision",
                        "command_id": 1,
                        "request_id": request["request_id"],
                        "outcome": "selected",
                        "option_id": "allow",
                    })
                    .to_string(),
                ))
                .await
                .unwrap();

            let first = next_text_frame(&mut relay_ws).await;
            let second = next_text_frame(&mut relay_ws).await;
            assert_eq!(first["command_id"], 1);
            assert_eq!(second["command_id"], 2);
            relay_ws.close(None).await.unwrap();
        };

        let (session, ()) =
            tokio::join!(run_session_with_processor(daemon_ws, &mut processor), relay);
        session.unwrap();
        assert_eq!(processor.events, ["start-1", "end-1", "start-2", "end-2"]);
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
