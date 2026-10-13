# Fresh Bridge evidence for advisory routing

Status: local, opt-in implementation. No deployment, live preflight, classifier
call or new model execution performed. Existing entry points remain disabled.

Principal matching validates exactly 32 bytes of hex, accepts the relay's optional
`0x` prefix, and compares canonical lower-case encodings. Receipts contain the
canonical actual requester, not an unchecked caller label. Malformed or distinct
identities still fail closed.

## What is observed

The device performs the same subscription-only native CLI auth/config checks used
before direct inference, plus a bounded `--version` check using that captured
private environment. It does **not** spawn the prepared inference command, pass a
prompt, invoke login/logout/setup-token, execute tools, or check a harness/ACP.

Evidence means:
- the strict subscription-only policy was actually applied;
- the CLI reported a known subscription login;
- the local operator spending attestation was present;
- the actual CLI version matched the discovered version;
- the native chat adapter's read-only auth preflight responded.

**Paid-extra-usage settings are still operator-attested, not queried or verified
by the provider.** This is not remaining quota, an invoice audit, model availability
or proof that a future request will succeed. Credentials, login JSON, account
email/organization, filesystem homes, raw environment and CLI auth output stay on
the device. Actual launches must still reauthorize and recheck their guard.

## Existing transport, new prompt-free operation

Reuse `enqueue_bridge_inference`, the authenticated relay, device-only completion,
requesting-AI result visibility and the existing audit chain. No schema, reducer,
MCP tool, generated binding, hosted URL or service credential changes.

The payload uses operation `subscription-preflight-v1` with exact scope metadata:
provider, profile ID, configuration fingerprint, AI-user ID, principal ID, fresh
UUID nonce and expected CLI version. There is deliberately no prompt/chat/model,
argv, permission override, shell command or full page context.

New daemons intercept operation-bearing payloads before ordinary inference.
Unknown operations and mixed/unrecognized fields fail closed. The prior ordinary
adapter rejects this payload for missing prompt/chat, rather than generating an
answer. A caller must not put this JSON inside a normal tool_infer prompt: that
would be ordinary inference. This operation is for the explicit host helper.

The daemon derives device/command/session/principal context from the incoming
command frame, verifies scope, and returns a versioned proof inside the ordinary
inference result's output string. Failed validated probes carry only bounded
correlation metadata plus the existing sanitized error; malformed scope may have
no correlated proof and time out. No token usage or tool calls are reported.

## Worker verification

worker/src/routing-preflight.ts exports probeBridgeRoutingProfile. It requires
explicit approval and an AI-user-scoped connection. It reuses discovery to check
identity/config, active grant, connected native profile and expected version.
It enqueues once and consumes requester-scoped result-cache updates. It avoids
the known multi-filter command-row incremental issue by matching fresh nonce,
actual command/device/principal proof and requesting-AI result identity instead.

Results must match the exact profile/fingerprint/version, command ID and scope,
known evidence labels, completed timestamp and a successful zero exit. Discovery
is rechecked after the probe; changed configuration, grants or availability
invalidates it. No admin connection, SQL fallback, retry or worker switch exists.
Absent cache/transport, old daemon, unknown response, abort or timeout yields no
observation. Enqueue and polling share a finite budget of at most 30 seconds.
Timeout/cancellation stops the local wait, not necessarily the already-queued
read-only probe. Late results are not published as observations.

Successful evidence creates a fresh BillingObservation labelled subscription,
with the originating scope/fingerprint, conservative request-start timestamp and
nativeChatReadiness=auth_preflight_only. Discovery may refresh the timestamp of
an available native chat profile ONLY from that explicit trusted observation.
Reading a cached provider report does not refresh health. Old capability-report
age alone need not prevent requesting a real probe; actual version and scope are
checked. Direct API configs, offline devices, packet-review, repo/tool authority
and harness/ACP profiles do not gain readiness from this native chat evidence.

No default table persistence or public exposure of observations is added.
The host remains responsible for trustworthy connections and approved storage.

## Opt-in Orcha integration

OrchaAdvisoryHook.observeBilling is an optional bounded collector, used only after
prepare approves the task/context and classifier consent is enabled. No collector
is installed by default. Failure, timeout or abort discards old prepared billing
observations and leaves the serialized executable graph unchanged. New evidence
is evaluated against the current host clock after the wait, not an earlier plan
timestamp. Advice still does not authorize execution.

createBridgeBillingObserver({maxProfiles, timeoutMs}) provides the native collector:
- one or two profiles maximum per plan entry, under a shared time budget;
- only caller-approved IDs/destinations/capabilities/task profiles and session pin;
- no native probe when classifier consent is disabled;
- no classifier calls inside the collector and no prompt or page data sent.

The existing maxTasksPerPlan also bounds entries. These are per-instance/per-plan
bounds, not account-wide spending or quota counters. Hosted classifier consent
and finite request budgets remain separately required.

Future host wiring must explicitly supply both callbacks, the actual originating
AI-user connection, approved summary/policy and chosen advisor. This PR does not
enable a DatabaseWorker hook or provide a live preview/UI command.

## Validation

Mock tests exercise native Claude/Codex preflights without model spawn, privacy,
wrong versions, mixed prompts, configured-policy refusal and old-adapter rejection;
worker nonce/scope/version/fingerprint validation, revocation, approval, cancellation,
stale-report refresh, finite waits and collector failure without classifier calls.

Local verification: 87 Rust tests and 155 worker/routing tests passed (242 total);
one existing live ACP test stayed ignored. Undefined-name checks passed. A
compiler-API before/after comparison reports 1,903 existing worker diagnostics
in each version, with no additional file/code/message signature multiplicities;
this is not a clean full worker typecheck.

No live result or operator attestation is treated as an independent billing audit.
Deployment of the updated Bridge and explicit hosting wiring are separate,
reviewed steps before the first approved advisory preview.
