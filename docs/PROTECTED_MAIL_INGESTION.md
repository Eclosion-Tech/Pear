# Exact prepared-text batch ingestion (S2b2c4)

This dormant substrate lets an authenticated human owner approve one exact
prepared-text batch for private storage. Its bound connector may commit the
entire batch, its dispositions, cursor progress and terminal read declaration
in one transaction. Installing it does not start monitoring.

It uses the existing [read plan](PROTECTED_MAIL_READ.md) and exact contiguous
[selection](PROTECTED_MAIL_CONNECTOR.md). It supplies separate storage authority;
neither an existing selection, read grant, successful read report nor matching
hash grants permission to store content. The [fixed executor](PROTECTED_MAIL_EXECUTOR.md)
continues to discard MIME and is unchanged. No production adapter connects that
executor to this endpoint.

## Exact owner decision

`review_protected_mail_ingestion` reconstructs metadata for the retained read,
checks its current connection/selection/cursor and measures the supplied batch.
`issue_protected_mail_ingestion` repeats those checks and binds the owner's
expected epoch, configuration snapshot and manifest digest. Only the exact
authenticated non-AI human owner can review, issue or revoke. Publisher and
non-owner administrators cannot approve on the owner's behalf. Authentication
is not proof that a trusted UI displayed the artifact; that UI remains a gate.

The immutable authorization is keyed by read ID and binds the complete unchanged
read plan, selected UID order, connector identity/runtime/run, owner/module,
connection epoch/snapshot, cursor generation/digest, activation/expiry, nonce,
exact payload digest and byte count, and a separately approved envelope ceiling.
Its interval lies within the selection interval, with at most one hour from
issuance. The metadata manifest contains no message entries or text.

Fresh approval requires a pending or dispatching read. Terminal reads cannot
acquire storage authority retrospectively. One read has at most one immutable
authorization: revocation cannot renew it, replacement nonces cannot reopen it,
and exact issuance/revocation retries have no effect. A future reviewed recipe
and shared workflow budget are needed before recurring child runs may acquire
downstream authority automatically.

## Closed prepared payload

The canonical UTF-8 payload is recursive ASCII-key-sorted JSON:

```ts
{
  entries: [
    { kind: "imported", message: preparedMessage, uid: selectedUid },
    { kind: "held", reason: "authentication_material", uid: nextSelectedUid }
  ],
  formatVersion: 1,
  kind: "mail.ingestion.batch",
  read: completeConnectorReadV1
}
```

Exactly one to eight entries cover every selected UID, in order. Imported
messages use the unchanged bounded S1 literal-text contract. Their UID, folder,
UIDVALIDITY and direction must match the server-selected tuple. No account,
destination, source identifier, parent list, policy or processor override is
accepted. Strings retain their exact case, whitespace and Unicode scalars.

Held entries accept only the selected UID and one fixed reason:
`authentication_material`, `sensitive_content` or `unsupported_content`. They
store no title, sender, body, header, raw MIME or arbitrary explanation. A held
disposition creates no fabricated S1 message/source and cannot later be imported
under another request key.

Held describes a trusted declaration that complete observed content was
withheld. It is never an absent UID, expunge, incomplete/capped literal or
transport failure. Those outcomes still block progress. In particular, a
contiguous requested UID window is not evidence that every UID has already
been assigned. Bounded mailbox discovery and an explicit absence/skip contract
remain separate prerequisites for handling sparse UID histories.

Both per-field limits and the full canonical envelope apply. The complete
payload, including the read manifest, escaped JSON and all text/metadata, must
fit the owner's ceiling and a 2 MiB hard maximum. This cost is independent of
the earlier raw-MIME reservation and the old ACK's stored-record byte ceiling.
The actual payload must match the approved digest **and** exact byte count.

`prepareMailIngestion` copies and freezes those bytes before asynchronous
hashing and verifies the embedded read/selection commitments. Hostile getters,
extra fields, sparse arrays and invalid scalars fail closed. Preparation
authenticates no owner, current authority or mailbox observation.

This is prepared-text admission, not a MIME sanitizer. The bound
`sanitizationVersion` is an importer declaration, not redaction certification.
Exact owner approval does not prove those strings came from the IMAP session.
The trusted importer, future MIME processing and tested sanitization remain
part of the security boundary before real-mail use.

## One atomic effect and retained replay

`accept_protected_mail_ingestion(read_id, event_nonce, entries)` authenticates
the eligible bound connector before private lookup. A fresh commit requires
the current owner/configuration/epoch, active unrevoked authorization and
selection, exact current cursor, and a dispatching read. It validates all
entries and stable mailbox-tuple collisions before committing any effect.

One transaction then:

1. Inserts immutable S1 source/record/import receipts for imported entries.
2. Records a body-free typed disposition for every selected UID.
3. Inserts the batch receipt and versioned ingestion cursor history.
4. Advances the existing cursor head with its expected generation/digest.
5. Records the same service's one terminal `ReadReported` declaration/nonce.

A bad final entry, stale cursor, collision, competing terminal report or revoked
authority leaves the entire transaction uncommitted. The immutable receipt
consumes the exact local storage effect once and records its full envelope
cost. It creates no shared recurring budget and never refunds the earlier
read reservation. A status declaration still does not attest IMAP authenticity
or adequate redaction.

Canonical mailbox identity excludes grant/run/nonce. Existing imports and held
dispositions cannot be re-keyed as new mail, including through the old publisher
append path. The original publisher-only append authority stays unchanged.
No automatic source policy is installed; missing source ceilings continue to
deny processing. Storage approval grants no inference, promotion or ordinary
assistant access.

Old source-only ACK history and new ingestion history share one stable cursor
head. The validator accepts exactly one closed receipt family and checks its
retained associations; it does not create another cursor namespace. Old ACK
content/replay checks remain intact. Mixed old/new history supports subsequent
selections while held slots do not pretend to have stored S1 bodies.

An exact completed retry validates retained payload/source/disposition/history
and terminal-read associations, then returns the original metadata. It works
after expiry, revocation, owner logout, deletion or later cursor progress
without rewriting history or rewinding the head. Changed text, reason, order
or nonce conflicts. The bound eligible service must still authenticate.

The one-attempt worker helper snapshots the typed entries and host configuration,
uses a fixed authority route, refuses redirects, and caps actual streamed
responses at 4 KiB. A timeout or lost response remains unknown and never causes
automatic resend. An explicit identical retry may recover metadata only.
Unsafe numeric u64 generations are rejected rather than rounded.

## Private state and remaining gates

Five additive private tables retain authorization/events, tuple dispositions,
batch receipts and ingestion cursor history. The 42 prior private tables keep
their schemas. No new ordinary page/search/API/MCP projection, subscription,
export, owner held-message UI or automatic policy is added. Ordinary restore
remains fenced; protected backup/restore remains required before a canary.

Conformance uses only synthetic prepared messages and disposable localhost
authority. It covers populated old42 upgrade without backfill and a seventh
checkpoint on the shared disk-backed restart. Existing six checkpoints,
historical upgrades and synthetic TLS conformance remain required.

Real bounded discovery, MIME sanitization/adapter, recurring workflow authority,
isolated credentials and host egress, reviewed UI, provider transport and
protected recovery remain gates. Protected monitoring stays disabled.

## Validation

Local validation passed 183 Rust, 126 Sentinel, 545 worker and 303 web tests,
both client type checks and strict TypeScript for all eleven E2E scripts plus
the two lifecycle/TLS helpers. Both clients were regenerated with pinned 2.0.3
from the exact release WASM and match. An independent Python canonical JSON
vector matches the Rust/TypeScript 1,883-byte payload and SHA-256 commitment.
All 42 prior private table schemas are unchanged.

Fresh ingestion, populated-old42 upgrade, seed and resume passed 8/9/9/1
stages. The earlier live regression fixtures passed 136 stages; all seven
checkpoint families survived one controlled disk-backed restart without
republishing. Full 47-table associations, retained owner history, spent budgets,
inert replay and selective pending/dispatched completion were checked. Release
contracts (31), private native-log guard cases (8), shell/workflow syntax and
170 local documentation links passed. The owned server, data, checkpoints,
logs and generated synthetic keys were removed; no TLS fixture material remains.


The later [sparse checkpoint contract](PROTECTED_MAIL_SPARSE_CHECKPOINT.md)
adds separate owner approval over a nonempty recorded observation and complete
already-stored present records. It uses a dedicated third history family under
the same cursor, preserving this contract's scope and exact historical retries.
It does not authorize new body reads, ingestion or permanent absence tombstones.


The later [dormant composition](PROTECTED_MAIL_COMPOSITION.md) joins existing operations without changing
this storage authority. It adds no grant family or recurring approval; monitoring
remains disabled.
