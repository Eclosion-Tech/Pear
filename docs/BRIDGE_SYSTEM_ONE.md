# Explicit local System One transport

This OSS adapter transports one bounded decision request to an authorized user-owned
Bridge. It does not configure hosting, select a worker, create tasks or enable Orcha.
It exists so a remote host need not expose Ollama ports, copy subscription credentials
or spend on a hosted classifier to reach a user's local decision model.

## Protocol

`enqueue_bridge_inference`, provider `ollama`, empty scalar model, prompt-free JSON:

- operation `local-system-one-v1`
- principal_id, ai_user_id, request_nonce (fresh UUID)
- configuration_fingerprint (discovered `bridge_<device>_ollama` reference)
- endpoint (explicit `http://127.0.0.1:<port>/v1/systemone`, no credentials/query/fragment)
- model (explicit installed tag, no `:cloud` tag)
- model_digest (explicit full 64-hex local weights digest)
- request `{state, questions}` (bounded choice questions)

Unknown/mixed outer fields fail. Any older daemon rejects the prompt-free payload
rather than running a model through the ordinary generate/chat/CLI path. No schema,
reducer, generated binding or additional grant is installed. Existing device grants,
command authorization and requester-scoped completion visibility still apply.

The daemon verifies actual requester identity and scope, reserves the principal/nonce
once, GETs the local `/api/tags` catalog, requires exactly one name/digest match with
positive local size and no remote_host/remote_model fields, then POSTs once to the
approved System One endpoint. No environment endpoint/proxy, redirect, HTTP retry,
model download, chat/generate/CLI fallback or API credentials are used. Catalog
responses are bounded to 256 KiB; decision responses to 32 KiB, whole operation to
25 seconds. Response fields are selected: only model and choice/probability answers
are returned in the scoped receipt. HTTP bodies/errors and extra answer fields are
not forwarded. The routing consumer validates normalized distributions separately.

## Once / trust / limits

Before even reading the catalog, `system-one-once` under the default persistent
Bridge audit-data directory receives an exclusive, synced principal/nonce marker.
This denies command redelivery after a crash or restart, including after a POST but
before completion. Failed attempts consume the nonce; no automatic reclamation.
No payload, credentials or raw identity is written into the marker. Unix only;
other platforms fail closed until equivalent persistent permissions are verified.
Keep this directory persistent across Bridge deployments. Do not delete markers to
retry a possibly completed request. A trusted owner can delete/alter files or swap
the local server/models; this does not defend against that owner. This is a local
weights/catalog check, not an invoice or remaining-quota audit.

The worker factory `createBridgeSystemOneClient` requires explicit approval,
AI-user-scoped discovery, connected/granted available Ollama capability, endpoint,
model/digest and finite timeout. Each instance consumes one attempt, including
failure/cancellation. Its single enqueue and wait are bounded together. It validates
nonce, actual command/device/session/principal, AI scope, source fingerprint,
endpoint/digest/model and completion freshness; then rechecks scope/grants/config.
No SQL/admin connection fallback, re-enqueue, raw row/error export or backend switch.
An instance budget is not an account/monthly ceiling; hosts must persist approval
consumption if they create clients again. Local timeout stops waiting, not necessarily
already queued/running GPU work; the persistent device nonce prevents duplicate POSTs.

Only caller-approved bounded context should reach this factory, using the routing
builder's selected fields. The host is responsible for separate consent for context,
classifier destination and subscription-worker observations. Neither a local
classification nor advice authorizes a Claude/Codex invocation. Actual execution
must still be confirmed, granted and guarded again.

## Validation

Unit HTTP fixtures check exact catalog/decision endpoints, remote/digest mismatch,
redirect/HTTP refusal, bounded output/privacy and crash/redelivery reservation.
Worker fixtures check receipt/scope mismatches, grants/config invalidation, explicit
approval, bounded hanging enqueue, replay, cancellation and the one-attempt budget.
Tests do not call an installed model or a real account.
