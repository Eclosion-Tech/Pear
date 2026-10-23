# Observation-bound one-use read-plan release

S2b2c7 adds separate exact owner authority to release a bounded read-plan
**declaration** for the present UIDs of one retained discovery observation.
It does not open a mailbox, resolve credentials, read or store a body, advance a
cursor, update discovery, install policy, authorize inference or enable monitoring.
The existing [contiguous read](PROTECTED_MAIL_READ.md),
[executor](PROTECTED_MAIL_EXECUTOR.md), [ingestion](PROTECTED_MAIL_INGESTION.md)
and [stored-mail checkpoint](PROTECTED_MAIL_SPARSE_CHECKPOINT.md) remain unchanged.

## Independent exact owner approval

Only the authenticated non-AI human owner can review, issue or revoke. Publisher
and non-owner administrators have no approval override. Stateless review
reconstructs the complete plan. Issuance repeats those checks and compares the
expected connection epoch, snapshot and full canonical plan digest. Authentication
is not proof of a trusted display or reviewed recipe; those remain runtime gates.

The input is a successful immutable NextWindow
[discovery observation](PROTECTED_MAIL_DISCOVERY.md) with a nonempty range of at
most eight numeric slots and at least one present UID. Bootstrap, empty-horizon
and all-absent observations cannot receive a read grant. All-absent progress may
use the separately approved local checkpoint; it never creates a zero-slot read.

The targets are exactly the observation's ordered present UIDs, including gaps.
Callers cannot replace that list, select a subset, fetch the whole numeric range,
probe an absent UID, choose another endpoint or change the service/run. The plan
inherits the original workspace, owner, eligible connector, runtime/run, mailbox,
folder/direction, epoch/configuration, cursor and completed discovery head.
No S1 source, policy or checkpoint grant is required: this is separate authority
for a future upstream read, not storage or absence disposition.

Fresh review, issuance and release require the latest validated completed head,
original cursor, current human owner and eligible service, and unchanged live
paused connection/configuration/epoch. A newer head is never silently substituted.
The completed observation remains retained data after its original discovery
grant expires or is revoked. The new grant supplies independent authority with
its own interval, lasting at most one hour from issuance.

There is one immutable sparse read grant per observation. Its ID derives only
from that observation under a separate hash domain. New nonces, limits, times or
runs cannot replace it after revocation, expiry, cancellation or completion.
Exact issuance/revocation retries are inert; changed inputs conflict. Distinct
explicitly approved observations can target the same UIDs with independent full
reservations. This is not a global per-UID limit, recurring workflow pool or
automatic downstream grant.

## Closed metadata and maximum reservation

The portable `ConnectorSparseReadV1` binds sixteen outer fields:

```ts
{
  formatVersion: 1,
  kind: "mail.connector.sparse_read",
  profile: "imap.observed-uid-body-peek.v1",
  readId, eventNonce, workspaceId, ownerId,
  connection, connector, mailbox, cursor, observation,
  limits: { maxMessageBytes, maxTotalBytes },
  reservation: { operations: 1, messageSlots, bodyBytes },
  notBeforeMs, expiresAtMs
}
```

The observation binds its ID, digest, original manifest digest, completed head,
UIDVALIDITY, UIDNEXT, clipped range and exact present/absent partition. Only the
present list supplies targets; retained absence grants no skip or storage effect.
There is no fabricated StoredBatch selection or embedded checkpoint approval.

The per-message maximum is 1 byte to 512 KiB. The total is 1 byte to 2 MiB,
at least the per-message maximum and at most present-count times that maximum.
An aggregate smaller than all per-message maxima can exhaust before every target
is read. These measure complete raw MIME literal octets, including headers;
they are not IMAP/TLS/TCP traffic, actual observed sizes or S1 digest-preimage bytes.

Canonical metadata is recursively ASCII-key-sorted literal UTF-8 JSON, capped at
8 KiB. Positive u64 identifiers/generations remain decimal strings. Preparation
copies and freezes before asynchronous hashing and checks the deterministic read
ID. Its frozen bytes authenticate no owner, live authority, mailbox observation,
credential, runtime isolation or future message content.

The new profile declares obligations for a later reviewed executor: verified
TLS, exact-folder read-only EXAMINE, unique matching UIDVALIDITY and UIDNEXT at
least the observed horizon, followed only by serial bounded UID BODY.PEEK reads
for the exact present list. It declares no SEARCH, absent-slot probe, range FETCH,
folder fallback, reconnect or continuation read. Missing, expunged, capped or
incomplete messages must fail the whole future batch; they cannot become absence,
held dispositions or cursor progress. This slice implements no such executor or
wire conformance, and does not adapt the old contiguous executor.

## Consume before the only release

`begin_protected_mail_sparse_read_dispatch(read_id)` authenticates the eligible
original service before private lookup. One transaction changes Pending generation
one into Dispatching generation two and reserves one operation, every present
message slot and the entire maximum total before returning the plan once.
Subsequent claims deny release, including identical retries after a lost reply
or database restart. Stateless owner review is not another service release.

A cursor/head change or revocation before claim makes a pending attempt stale
without spending its reservation. If claim commits first, later local progress
or revocation may also commit; it cannot retract already released metadata. This
release does not lock the cursor or promise immediate cancellation of a future
remote operation. The retained reservation remains spent.

`finish_protected_mail_sparse_read_dispatch(read_id, outcome, event_nonce)`
accepts only a closed metadata outcome and nonce. Dispatching can become
ReadReported, Failed or Unknown, all at generation three with the full reservation.
Pending can instead become CancelledBeforeDispatch at generation two with zero
reservation. A cancellation-versus-claim race has one lifecycle winner.

ReadReported is only a service declaration. It is not proof of mailbox access,
existence, size enforcement, completeness, sanitization or successful ingestion.
Reports accept no body, observed count/size, raw diagnostic, refund or plan input.
Exact terminal replay is inert; changed outcomes or nonces conflict. No outcome
refunds, renews, reopens or creates downstream authority.

The still-eligible original service can report after expiry, revocation, logout,
configuration changes, connection deletion or later cursor/head movement.
Retained validation checks immutable observation/plan commitments and a bounded
lifecycle chain without rechecking currentness or the old discovery grant's time.
A service that becomes an AI or authenticated human is denied before lookup on
fresh and historical paths.

## Private state and host helpers

Four additive private tables retain this contract:

- `protected_mail_sparse_read_grant`
- `protected_mail_sparse_read_grant_event`
- `protected_mail_sparse_read_state`
- `protected_mail_sparse_read_event`

The previous 57 schemas remain unchanged, for 61 private tables. Upgrade creates
no grants or reservation backfill. There is no new owner view, ordinary table
binding, broad subscription, JSON export, page, conversation, source, cursor or
discovery projection. Privileged database/host management remains trusted.

The separate one-attempt HTTP helpers accept only the opaque read ID, and a fixed
outcome/nonce for reporting. Host-owned authority origin, workspace and service
credential are copied before awaiting. The helpers use fixed routes, refuse
redirects and cap actual streamed claim/report responses at 16 KiB/4 KiB,
independently of response headers. Invalid early responses cancel their bodies.
Claims verify exact canonical bytes, plan size, digest and derived ID. Unknown
attempts never automatically retry or choose another outcome. An explicit exact
terminal retry may recover recorded metadata; a lost claim cannot recover the plan.

## Validation and remaining gates

Synthetic conformance covers exact sparse targets, authority/currentness fences,
once-only release, retained full reservations, cancellation/release races,
explicit lost-reply recovery and all 61 private boundaries. Populated old57
upgrade preserves existing records and histories without backfill. The tenth
shared recovery checkpoint retains pending, dispatching and terminal states
across one disk-backed restart without republishing. Fixture diagnostics use
fixed stage codes and owned temporary data/keys are removed.

Local validation on October 23, 2026 passed 227 Rust, 147 Sentinel, 640 worker,
303 web and 31 release tests, including twelve new claim/report helper tests.
Both application typechecks, strict checks for all fourteen native fixtures and
two helpers, thirteen private native-log guard cases, matching generated clients,
workflow/shell syntax and 137 local documentation paths passed. Independent Python
vectors match the Rust/TypeScript literal-Unicode/full-u64 commitments.

Native validation passed 322 fixed stages: 11 fresh, 12 populated old57 upgrade,
167 historical regressions, 122 restart-seed and 10 restart-recovery stages.
All ten families survived one controlled restart with unchanged data and synthetic
keys and no republishing. All checkpoint files were consumed. The owned database,
keys, private logs and temporary TLS fixtures were removed. Independent core,
codec/helper, fixture and release/cleanup reviews found no blocking issues.

Sparse IMAP execution, observation-bound exact body ingestion, MIME sanitization
and adaptation, trusted recurring workflow budgets/delegation, isolated production
credentials/network, trusted UI, provider transport and protected backup/restore
remain gates before real-mail use. No mailbox or workspace hostname is hardcoded.
Protected monitoring remains disabled.
