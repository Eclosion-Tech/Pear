# Fixed protected-mail inference admission (S2b2b1)

This slice admits one fixed inference request and releases its bytes once to
the authenticated broker named by an owner-issued grant. It builds the request
from stored mail, the exact approved instruction and the current processor
registry. It adds no provider call, credential lookup, mailbox read, cursor
update, result-body acceptance, trusted review UI or protected runner.
Protected monitoring remains disabled.

The release itself discloses the request to the bound broker identity. A
service label or token does not prove process isolation. Secret custody,
authenticated broker RPC and host/transport enforcement remain S3 gates.

## Exact processing authority

The authenticated non-AI collection owner issues a separate inference grant.
It freezes the current connection epoch/configuration snapshot, one eligible
broker identity and runtime label, exact current instruction revision and
approval decision/head generation, and one current processor registry revision.
Issuance accepts a caller nonce; the server derives the grant ID from the
authenticated owner, collection and nonce. The portable `inferenceGrantId`
helper computes the same ID. Different owners/collections cannot probe or
preempt another grant by issuing the same nonce.
The processor reference binds profile, head generation, immutable revision ID
and configuration digest. Invented tuples, historical or retired revisions,
unsupported adapters and configuration changes fail closed. There is no
fallback to another provider, AI worker or environment key.

A grant allows one to 64 exact raw-mail source references. The union of their
full ancestor graphs and the instruction graph must fit the 256-source bound.
Every current ancestor must permit the resolved processor tuple: profile ID,
registry revision ID, canonical endpoint and model. Missing or revoked policy
denies processing. Processor permission is independent of owner-storage
permission: inference does not create another stored message body, and a
storage ceiling alone does not authorize inference.

The owner fixes activation/expiry within one hour, the per-operation output
token cap (one to 4,096), per-operation request-byte ceiling (at most 1 MiB), and
aggregate operation/input-byte/output-token limits. Values must fit
JavaScript's safe integer range. Grants cannot be extended, replenished or
widened. All roots and descendants share the same budget, with at most 256
runs and 16 levels. Runtime/run labels grant no authority by themselves.

## Fixed request bytes

Only the version-one Anthropic Messages recipe is supported. Its complete
canonical JSON body is:

```ts
{
  max_tokens: grant.output_tokens_per_operation,
  messages: [{ content: canonicalMailJson, role: "user" }],
  model: currentProcessor.config.model,
  system: approvedInstruction.body
}
```

`canonicalMailJson` is a JSON **string** containing exactly these eight fields:

```ts
{ body, cc, direction, from, messageDate, sanitizationVersion, subject, to }
```

Direction is `received` or `sent`. Folder, UID, UIDVALIDITY and importer notes
are omitted. Object keys sort in ASCII order; literal Unicode, whitespace and
line endings remain unchanged. Invalid Unicode scalars and extra fields fail.
The byte ceiling and digest cover the complete outer UTF-8 request, including
JSON escaping of the inner string and the exact approved system instruction.
No tools, history, streaming, cache, metadata or caller-selected options are
added. The declared transport is POST with `Content-Type: application/json`
and `anthropic-version: 2023-06-01`; only opaque versioned credential handles
are returned, never authentication secrets.

The server derives the S0 `model.infer` operation from its own module identity,
owner, bound runtime, actual run/parent, connection epoch, exact processor,
full request size/digest and fixed output limit. Admission separately binds
the complete input closure and its current policy generations.
Canonical payload, operation fingerprint and logical work identity are
different commitments. Portable preparation is a byte contract, not a permit.

## Admission, claim and terminal outcomes

`admit_protected_mail_inference` accepts grant/run IDs, an exact mail reference
and an event nonce. Inside a transaction it authenticates the bound broker,
checks current authority and policy, constructs the full request, reserves one
operation plus actual wire input bytes and the fixed maximum output tokens,
and inserts a private immutable admission and initial `admitted` state.
Failure leaves no partial reservation. There are no refunds in this slice.
Only references and commitments are retained; the outgoing body is not copied
into an admission table.

`begin_protected_mail_inference_dispatch` repeats all current checks inside a
transaction, using that transaction's time. It resolves the same immutable
inputs, rebuilds the request and verifies its bytes/digest/fingerprint. The
`admitted` to `dispatching` transition and immutable event commit before the
procedure returns the closed dispatch payload to the bound broker. Every
subsequent claim is denied, including an identical authenticated retry.
No ordinary view or unprivileged SQL reader supplies the payload. The dedicated
driver avoids generic publisher-backed readers. Trusted publisher management
can still read the underlying private mail, instruction and configuration;
that existing access remains in the trusted computing base.

Authority origin, workspace, bearer and transport are host-owned configuration;
content or model proposals cannot supply them. The returned operation
fingerprint is authenticated server metadata, not independently reconstructed
by the HTTP driver. A future provider dispatcher must recheck the returned
deadline immediately before opening its socket and enforce the admitted
destination, credentials, TLS/DNS and redirect policy there.

The dedicated HTTP driver attempts a claim once, rejects redirects, bounds
the response, strictly decodes the pinned protocol result and emits fixed
errors. A timeout, lost reply or malformed/truncated response after commit
leaves a consumed, uncertain operation. The caller must not retry the release
automatically or reset the ledger to recover availability.

The outcome reducer accepts IDs, nonce and a closed declaration:
`response_received`, `failed`, `unknown`, or `cancelled_before_dispatch`.
Cancellation applies only before a claim. Terminal reporting may survive grant
expiry/revocation or epoch changes when the broker association/role still
authenticates; it neither discloses bytes nor reserves more resources.
An identical terminal event is inert; changed events conflict. Outcomes never
reopen a claim or refund its budget. `response_received` does not accept model
content or attest response accuracy, token usage or remote completion.

## Logical once identity and recovery

The global work identity binds module/workspace, collection, recipe/version
and the exact mail, instruction and processor revision references. It excludes
grant, run, nonce, connection epoch, instruction approval/head generation and
output-token limit. Processor generation remains part of its exact revision
reference. A replacement grant, reapproval, pause/resume or changed cap cannot
release the same logical work again. A genuinely different immutable input,
instruction or processor revision is different work. This is not once per
physical IMAP message and does not establish exactly-once provider I/O.

A separate request identity binds the original grant/run/nonce. Reusing it for
another mail reference conflicts. An exact authenticated admission retry can
return the same metadata-only ID after authority changes without another
reservation or disclosure. This exception never applies to payload claims.

Seven new private tables retain grants/events, runs, shared budgets,
admissions, dispatch heads and immutable dispatch events. They have no owner
body view, ordinary snapshot inclusion or broad worker subscription. The
existing restore fence applies through their retained collection. A future
protected backup must preserve once markers, spent budgets and dispatch state
and invalidate restored authority before use.

The disposable fixture exercises fresh and populated S2b2a upgrades without
backfill, current registry/role/instruction/policy checks, shared-budget and
claim races, exact wire bytes, replay, private protocol/export boundaries and
lost-response behavior. Restart checkpoints include admitted, dispatching and
terminal-unknown operations and must resume without republishing. Cloud adds
an independent S2b2a baseline for seven historical baseline comparisons and
runs authority, local admission and inference checkpoints across one owned
disk-backed restart. Release conformance uses the exact release WASM.

[S2b2b2 restricted result acceptance](PROTECTED_MAIL_RESULTS.md) adds explicit
owner result-storage authorization and bounded private derivation acceptance.
It does not validate an actual provider response or attest remote execution. Connector selection/cursor authority, trusted owner UI/recipe,
sanitization/held-message handling, protected backup/restore and S3 isolation
remain required before a real-mail canary.

## Validation on this slice

The locked Rust suite passed 134 tests and the release WASM build. Portable
Sentinel passed 86 tests/typecheck; worker passed 467 tests/typecheck; web passed
303 tests and its TypeScript check. Both clients were regenerated from the same
WASM and have matching binding digests. All six protected-mail fixtures passed
their standalone strict TypeScript check; 31 release contracts, all seven
baseline collision guards and local documentation links passed.

Live inference fresh/upgrade/seed runs passed 12/13/13 fixed stages. The
populated S2b2a upgrade retained all 23 previous private tables and owner
histories without inference backfill. Existing storage/provenance, instruction
fresh/S1b/S2a upgrades, authority and local-admission upgrades also passed.
One controlled disk-backed restart preserved all 30 inference-fixture tables,
owner history, immutable receipts and spent budgets without republishing;
authority and local-admission checkpoints passed across that same restart.
Consumed claims stayed consumed, and only the explicitly selected admitted
request advanced through its remaining lifecycle. No native panic or inference
body marker appeared in the server log. The entire disposable server, retained
synthetic databases, checkpoints, logs and JWT keys were removed. The paired
Cloud PR records the Docker CI result.
