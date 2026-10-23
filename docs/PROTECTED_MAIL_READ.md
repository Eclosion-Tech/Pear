# One-use connector read-plan release (S2b2c2)

This adds separate owner authority to release one bounded read-plan declaration
for an existing [connector selection](PROTECTED_MAIL_CONNECTOR.md). A selection
alone still authorizes only acknowledgment of already-stored mail. No selected
message needs to exist in storage when the owner approves a read plan.

The procedure returns metadata to the selected service once. It does not open a
mailbox, release credentials, accept a body, install a source policy, advance a
cursor, authorize inference or enable monitoring. Actual connector execution,
atomic ingestion and missing/held dispositions remain later gates. The legacy
mail runner is not connected to this API.

## Exact owner authority

Only the authenticated non-AI human owner can review, issue or revoke. Review is
stateless. Issuance reconstructs the complete canonical plan inside the same
transaction and compares its digest with the owner's reviewed digest. This
authenticates the owner credential; a trusted review UI or approved workflow
recipe is still required before runtime use.

Only an existing `StoredBatch` selection is accepted. Its exact module identity,
owner, connection epoch/configuration, account/folder/direction, eligible
connector identity, runtime/run, cursor generation/digest, UIDVALIDITY, contiguous
one-to-eight UIDs and activation/expiry are retained. `NewOnly` is a declaration
of skipped history and cannot become a read plan. Selection/bootstrap metadata
probes are not admitted here.

There is exactly one immutable read grant per selection. Its ID derives only
from the selection ID, excluding runs, epochs, caps and caller nonces. Revoking,
expiring, cancelling or finishing it never permits a replacement grant for that
selection. Exact issuance/revocation replay is inert; changed inputs conflict.
Owner event nonces share one namespace across this read-grant family.

A separately issued selection at the same unchanged cursor may receive its own
explicit read grant and full reservation. This is once per selection, not once
per mailbox UID or a shared workflow pool. There is no recurring or delegated
authority and no downstream grant minting.

## Exact plan and maximum bytes

The closed canonical plan has eight outer fields:

```ts
{
  formatVersion: 1,
  kind: "mail.connector.read",
  limits: { maxMessageBytes, maxTotalBytes },
  profile: "imap.uid-body-peek.v1",
  readId,
  reservation: { bodyBytes: maxTotalBytes, messageSlots, operations: 1 },
  selection,
  selectionDigest
}
```

`selection` embeds the complete unchanged canonical selection and its SHA-256
commitment. Keys sort recursively in ASCII order; Unicode and whitespace remain
literal. The plan is capped at 12 KiB. The portable preparation copies before
awaiting, checks the embedded selection digest and deterministic read ID, and
returns frozen bytes. That object is a commitment, not an authenticated permit
or an S0 `mail.read` v1 operation fingerprint.

The per-message maximum is 1 byte to 512 KiB and the aggregate maximum is
1 byte to 2 MiB.
The aggregate must be at least the per-message maximum and at most the selected
count times that maximum. A smaller aggregate than the sum of all per-message
maxima explicitly permits exhaustion before every selected message is read.

These limits measure complete raw MIME message literal octets, including
headers. They are neither IMAP/TLS/TCP traffic bounds nor the S1 digest-preimage
bytes used by the existing ACK contract. The future executor must enforce both
maxima without reading an extra `cap + 1` byte. Protocol buffering, framing,
transport limits and actual observed message sizes require separate execution
conformance. Future message bytes and digests are unknown at plan issuance.

The versioned profile requires TLS to the selected endpoint, read-only
`EXAMINE` of the exact configured folder, matching UIDVALIDITY, and bounded
`BODY.PEEK` reads for exactly the selected UIDs. That in-operation metadata guard
does not authorize independent discovery or bootstrap probes. The profile
permits no SEARCH, LIST, folder fallback, expanded UID range, STORE or send.
This slice generates no IMAP commands and does not attest these obligations.

## Consume before release

`begin_protected_mail_read_dispatch` authenticates the selected eligible service
before private lookup. For a pending grant it checks the current owner/service,
both revocations, activation/expiry, connection epoch/snapshot and exact cursor
generation/digest. A competing ACK that advances the cursor makes a later claim
stale. A claim that already committed has crossed a finite authorization
boundary; a later revocation or ACK cannot retract its returned metadata.

One transaction moves the state to `Dispatching`, retains an immutable event and
reserves one operation, every selected message slot and the entire aggregate
byte maximum before returning the plan. Every subsequent claim denies release,
including identical retries and retries after a lost reply or restart. The
owner's separate stateless review path does not grant the service another
release. The one-attempt HTTP helper caps the actual streamed response at
16 KiB, rejects redirects, verifies exact canonical bytes/digests and never
automatically resends an unknown attempt.

`finish_protected_mail_read_dispatch` accepts only a fixed outcome and event
nonce. A dispatching attempt may report `ReadReported`, `Failed` or `Unknown`.
A pending attempt may instead become `CancelledBeforeDispatch` with zero
reservation. Dispatched terminal states retain their entire reservation.
Reports include no body, raw error, observed-byte count or refund request.

Reports remain recordable after expiry, revocation, pause, deletion or owner
logout by the still-eligible original service. Exact terminal replay is inert;
changed outcomes/nonces conflict. A service that becomes an AI or authenticated
human receives the same service-required denial before private lookup, including
historical paths. `ReadReported` is a declaration, not proof of mailbox access,
message existence, size enforcement or successful ingestion. No outcome
reopens authority, stores a message or advances a cursor.

## Private state and remaining gates

Four private tables retain the immutable grant, owner events, current read
state and immutable lifecycle events. Retained-state validation checks their
commitments, bounded event chain and complete reservation. Existing 38 tables
and their independent pools retain their semantics. There is no grant/state
backfill or body projection, ordinary page/search/conversation record, broad
subscription, snapshot export or public table binding.

The shared recovery gate retains all 42 tables, owner histories and pending,
dispatching and terminal read states across the same disk-backed restart as
the five earlier checkpoints, without republishing. A pending read can release
once afterward if still current; consumed attempts cannot release again.
Raw publisher/database management remains part of the trusted computing base.
Ordinary JSON snapshots remain unsuitable for protected backup/restore.

Next gates are bounded connector execution, separate exact new-body storage
authorization, atomic actual-byte validation/source/record/receipt writes and
checkpoint/disposition linkage. Trusted workflow-root budgets/delegation/UI,
sanitization, credential custody, provider transport, protected recovery and
host egress enforcement remain required before a protected canary. Monitoring
stays disabled.

## Validation

Local validation passed 171 Rust, 118 Sentinel, 484 worker, 303 web and 31
release tests, plus 26 procedure transport tests. Both generated-client
TypeScript checks, strict checks for nine fixtures plus lifecycle helper,
matching generated clients, ten baseline collision guards, six private
native-log guard cases, shell/workflow syntax and 130 local links passed.

Connector read fresh/upgrade/seed/resume passed 10/11/11/1 stages. All 15 earlier regression/setup phases passed 208 checks, and all five earlier checkpoints recovered across the same disk-backed restart without republishing. The populated upgrade retained all 38 earlier private tables without backfill; all 42 survived recovery with owner histories and ordinary state unchanged. Only the selected pending read changed on first release; dispatching/terminal attempts remained consumed and full reservations were retained. Native logs contained no panic or synthetic inference/result/connector/read body marker. The owned server, synthetic databases, checkpoints, logs and generated test keys were removed.

The later [dormant executor](PROTECTED_MAIL_EXECUTOR.md) tests this fixed wire
profile against synthetic TLS servers. Its installation schedules no existing
pending grant and supplies no production credential or workflow activation.


The later [exact prepared-text ingestion contract](PROTECTED_MAIL_INGESTION.md)
adds separate owner-approved storage/disposition authority and an atomic cursor
commit. It does not repurpose this contract's read/ACK authority, connect raw
MIME to a sink, or permit missing/incomplete UID skips. Production MIME
sanitization, discovery, workflow and host gates remain.


The later [observation-bound sparse read-plan contract](PROTECTED_MAIL_SPARSE_READ.md)
adds independent exact owner approval and one consumed metadata release for the
retained present UID list. It preserves this contract, supplies no executor or
body ingestion, and neither changes an inbox cursor nor activates monitoring.
