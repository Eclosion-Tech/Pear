# Explicitly confirmed subscription answer (manual, opt-in)

This is a small confirmation-and-run library, not an automatic route or scheduler.
No existing worker startup, job loop or planner launches it. Optional host-backed
MCP answer tools are described below; they do not add autonomous dispatch. Advice is not consent.
The initial supported execution is one Claude Code text answer: no tools, repository
binding, agent session, delegation, model switch or fallback. Codex, ACP/harness,
follow-up affinity and remote cancellation are deliberately out of scope.

## Prepare, confirm, run

A trusted host calls `createAnswerOffer` with the original exact text, authenticated
workspace/AI-user scope and validated advisory recommendation. It must establish
that the text belongs to that advice; a model's fingerprint is not authorization.
Preparation only reads scoped discovery. It never enqueues work or calls a model.
The recommended available/granted native chat profile must be Claude Code.

An immutable offer binds a fresh approval UUID, workspace, principal, AI-user ID,
profile, configuration fingerprint, detected CLI version, exact UTF-8 text (8 KiB
maximum, plus a 12 KiB serialized-offer budget), advisory provenance and a maximum five-minute expiry. Tools are fixed
`disabled`; the model is explicitly `provider_default`, not a model-availability
claim. Show all these terms to the human, with no additional hidden context.

The operator writes `{schema:"pear-answer-approval-v1", approved:false, offer,
offerFingerprint}` in a private file. Only explicit human confirmation may set
`approved:true`. `reserveAnswerApproval` checks exact fields/hash, expiry, ownership,
0700 parent/0600 file and no file symlink; then creates and syncs an exclusive
`<approvalId>.used` journal **before** preflight or inference. Hosting should reserve
before opening the credential-bearing SDK connection as well. Persist this directory
across process/container recreation. Do not delete a marker to retry.

`runConfirmedAnswer` requires the actual in-process reservation object, consumes
it once, verifies the original profile/configuration and performs one fresh native
subscription preflight. It rechecks grants/connectivity/configuration and expiry
before its single enqueue. No classifier is called here. Failed preflight never
enqueues inference. A different available worker never substitutes for the approved
worker. Client and device failures consume approval, including ambiguous delivery.

## Device operation

The inference command has provider `claude-code`, an empty scalar model, and a
typed envelope with operation `confirmed-answer-v1` (no legacy `prompt` field). Its selected fields are
principal/AI-user, approval UUID, delivery nonce, offer/configuration fingerprints,
CLI version, expiry and `text`. Unknown fields, malformed scope, oversized text,
expired approvals and mixed legacy `prompt` fields fail closed. Older daemons reject
the missing ordinary prompt/provider payload rather than executing a fallback.
Existing server-side grants and requester-scoped result visibility remain required.

The device reserves canonical actual requester + approval UUID in a persistent
`confirmed-answer-once` directory. A new nonce or alternate principal encoding
cannot spend that approval twice. This persistence currently requires Unix;
unsupported platforms fail closed. The marker is consumed before local auth probes.

It creates a new private scratch working directory (no supplied repository), then
prepares a guarded CLI snapshot. Auth/status, version and execution use that same
captured environment. A configured/API snapshot is refused even if hosting's earlier
preflight passed. The device checks the expected CLI version and expiry again before
model launch. The fixed Claude invocation uses `--tools ""`; subscription guard
controls also disable hooks and inherited MCP configuration. No system prompt,
model override, resume/session ID or arbitrary CLI arguments can be supplied.

This is not an OS filesystem sandbox. The CLI still accesses its own local login
and account-level configuration. The host forwards only approved text, not repo,
page, diff, log, credential or conversation content. Do not claim a stronger local
filesystem/account boundary than this tool-less scratch-directory invocation.

Model execution is bounded to 60 seconds, each stdout/stderr stream to 64 KiB, and
the selected answer to 32 KiB and the escaped completion envelope to 64 KiB. Only a recognized successful Claude JSON result's
`result` string is exported, never raw stdout/stderr, auth responses, thinking,
usage, arbitrary envelope fields or returned tool calls. The entire device attempt
is bounded to 120 seconds; command transport to 125 seconds. The host must also
allow the separate 30-second preflight and discovery time (180 seconds overall).
CLI timeout drops/kills the local child; it does not prove upstream inference stops.

## Outcomes and uncertainty

Private append-only journal states include reserved, preflight, launching, submitted,
completed, failed and unknown/refused. Journal records contain status, timing,
fingerprint and command ID when a matching receipt arrives, never prompt/answer or
auth bodies. A command ID is not guaranteed while enqueue visibility is uncertain.

- Before enqueue, an invalid/revoked/expired offer is refused.
- A validated failure receipt is failed; it is not an allowance to retry.
- Timeout, disconnect, cancellation, invalid receipt or persistence failure after
  possible enqueue is **unknown**. It must not launch again automatically.
- Abort cancels the local wait, not a confirmed remote kill. Late enqueue acceptance
  does not restart polling or overwrite unknown with submitted.
- A completed receipt must match command/device/session/principal/AI-user, nonce,
  approval, offer/configuration hashes, version, provider and completion freshness.
  The host rechecks current scope before returning the answer as untrusted text.

There is no reconnect/relaunch, SQL/admin transport fallback, automatic route,
remote-cancel guarantee, durable scheduler, recovery executor or follow-up session.
Those need separate design and tests. A trusted operator can edit its own files or
invoke other Bridge APIs; this path does not constrain arbitrary Bash/MCP spending,
other callers, the controller model or owner-controlled CLIs. The once budget is
one CLI invocation by this adapter, not an audit of the official CLI's internal
HTTP requests/retry behavior or provider accounting.

Extra usage is **operator-attested disabled**. Native readiness is
**auth_preflight_only**, not remaining quota, invoice verification, model access,
repository permission or ACP readiness. No API or model call is made by tests;
fixtures use local fake CLIs, receipts and caches.

## Optional scoped human frontend

`createDirectAnswerOffer` supports an explicitly human-selected, currently eligible
Claude profile without classifier advice. Its request/context hashes are tagged
`human-explicit-v1`; it does not manufacture a successful advisory. The original
advisory-required preparation API remains supported. Both produce the same bounded
immutable offer and require a separate explicit approval before native preflight.

`runConfirmedAnswer` accepts an optional async host authorization hook. It is
bounded by the existing overall deadline and runs before preflight and at dispatch
and return boundaries. A denial or late response cannot turn unknown into completed
or launch a second attempt. This supplements, not replaces, device grants and
configuration/expiry checks.

The portable MCP registry offers `list_answer_workers`, `prepare_answer`,
`run_answer` and `get_answer` through an optional host-injected `McpContext.answers`
capability. Without a host adapter it fails closed. `execution:read` covers
listing/preparation/owned status, and `execution:answer` covers submission; defaults
are unchanged. Hosts must authenticate the grant, bind actor/workspace server-side,
perform fresh authorization and persist a once claim before child work. The generic
library contains no deployment URL, host/admin credential, database configuration
or process launcher. These tools intentionally do not join chat tool parity.

`approved:true` is a trusted-client attestation, not cryptographic evidence of a
physical human action. Keep execution-scoped credentials away from general agent
tooling. A frontend should expose user commands, not model-callable execution tools,
show the exact offer and expiry, reserve persistently before submission, and never
refresh/replay an uncertain execution request. Status retrieval is read-only and
must never resume the original operation. The host must not claim that aborting a
client HTTP request cancels the remote CLI.
