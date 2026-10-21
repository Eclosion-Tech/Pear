# Exact connector selection and private cursor acknowledgment (S2b2c1)

This slice controls progress over mail that is **already stored** in the
existing private S1 source/record/receipt family. An authenticated owner freezes
an exact configured folder and cursor window. The bound connector can advance
that cursor only after every selected record passes its retained association
checks. This is a checkpoint authorization, not authorization or evidence of
the preceding mailbox read or import.

Protected monitoring remains disabled. The legacy settings, polling runner,
leases and `mail_sync_cursor` stay disconnected. This adds no IMAP probe or
execution, credential release, body-ingress endpoint, missing/held disposition,
backfill, provider operation, recurring workflow or trusted UI integration.

## Owner review and immutable selection

`review_protected_mail_connector_selection` builds a body-free preview from the
current paused connection, retained authority epoch/configuration commitment,
configured account/folder and requested window. It returns the exact canonical
metadata, digest and byte count without writing a decision or cursor.
`issue_protected_mail_connector_selection` reconstructs that preview and checks
the owner's expected epoch, snapshot and manifest digest before recording the
immutable selection. An ordinary document, model response or matching hash
does not supply that owner decision.

Only the exact authenticated non-AI human owner can review, issue or revoke.
Neither publisher nor non-owner admin has a management override. The service
identity, runtime and run are fixed; no child-run or delegated-grant API is
added. IDs derive from the authenticated owner, connection and event nonce.
Another owner cannot preempt a globally chosen ID. Expiry is bounded to one
hour from issuance, with an explicit activation time. Revocation is terminal.
Exact issuance/revocation retries preserve history and never renew permission.

The server supplies host, port, username, folder and direction. Received means
the exact configured Inbox; Sent requires an explicitly configured Sent folder.
There is no special-use discovery or default folder substitution. The snapshot
binds the exact credential/key configuration privately; neither ciphertext nor
decryption material is copied into the new records or returned. Configuration
and digests remain sensitive metadata, not anonymization.

The two closed windows are:

- `NewOnly`: canonical nonzero u32 UIDVALIDITY and UIDNEXT, with no existing
  private cursor. The owner explicitly declares a skip through UIDNEXT minus
  one. An empty connector ACK creates generation one; issuance alone does not.
  UIDNEXT one produces cursor zero. These are owner declarations, not verified
  mailbox observations.
- `StoredBatch`: current UIDVALIDITY and cursor generation, one to eight next
  messages, and an acknowledged-byte ceiling. The server derives every next
  contiguous numeric UID. The caller cannot supply a different last UID or
  fast-forward to a reported mailbox horizon.

The new contract uses IMAP's nonzero 32-bit UID validity/next values and stable
mailbox/UIDVALIDITY/UID identity. Existing S1 u64-validity records retain their
original schema and interpretation. [RFC 9051, section 2.3.1.1](https://www.rfc-editor.org/rfc/rfc9051.html#section-2.3.1.1)

Existing cursors cannot be reinitialized or silently assigned a different
UIDVALIDITY. Such changes require a later explicit reconciliation contract.
An arithmetic overflow also stops progress. Pause, credential changes, grant
replacement and new runs cannot create a fresh cursor namespace or erase the
old position. Connection deletion retains this private cursor and history.

## Canonical metadata and acknowledgment

The closed canonical metadata has eleven outer keys:

```ts
{
  connection, connector, expiresAtMs, formatVersion: 1,
  kind: "mail.connector.selection", mailbox, notBeforeMs, ownerId,
  selection, selectionId, workspaceId
}
```

`workspaceId` is the authoritative database/module identity. Connection IDs,
epochs and cursor generations use canonical u64 decimal strings. The selection
binds its prior cursor digest/generation, exact UID list, validity and bounds.
Keys sort recursively in ASCII order; literal account/folder text is preserved.
The entire UTF-8 representation is bounded to 8 KiB. The portable codec freezes
matching bytes and digest, but authenticates no owner or configuration and
creates no operation, grant or execution permit. This selection commitment is
separate from S0 `mail.read` v1, which does not bind a UID window or cursor.

`acknowledge_protected_mail_connector_selection` accepts the selection ID,
event nonce and exact source references in selected UID order. A fresh ACK
rechecks current owner/service eligibility, selection status/time, exact live
connection epoch/snapshot and cursor generation/digest. Every numeric slot in a
stored batch must have the matching existing external-mail source, record and
receipt, including owner, collection, folder, UIDVALIDITY, UID, direction,
revision, digest and import association. Derived or foreign sources do not
substitute for mail. No new source or policy is installed.

The measured acknowledged bytes are the existing S1 digest preimage: every
length-prefixed UTF-8 field, including its domain/origin and eight-byte length
prefixes. The owner ceiling and 2 MiB hard bound apply to the complete batch.
This measures already retained data; it is neither raw MIME/wire size nor
physical storage usage. It reserves no inference or storage budget and grants
no permission to read or store that data.

Only after the whole window passes does one transaction update the cursor and
insert immutable history plus its ACK receipt. A missing, held, expunged,
oversized or unparseable slot cannot be skipped here. A failed last item leaves
every write uncommitted. Competing ACKs for one cursor generation have one
winner, including competing initial baselines.

The result contains selection/cursor IDs, generation, UIDVALIDITY, last UID,
acknowledged count/bytes and receipt digest. It contains no body, source list or
account configuration. Exact completed replay validates retained associations
and returns the same metadata after expiry, revocation, later cursor progress,
owner logout or connection deletion. It cannot rewind the head or append
history. Changed references or nonce conflict. The original service must still
authenticate; an ineligible or foreign service receives the same fixed denial
before private-resource lookup.

The one-attempt HTTP helper snapshots strict source-reference data before any
await, uses a fixed authority route, rejects redirects and caps the actual
streamed response at 4 KiB. Lost replies remain unknown; an explicit identical
ACK retry can recover metadata. Pinned HTTP JSON encodes u64 results as numbers,
so the helper rejects unsafe numeric generations rather than rounding them.
Generated SDK bigint reads and the canonical codec support the full u64 range.
Metadata decoding does not independently verify private bodies or attest IMAP
execution.

## Privacy, recovery and remaining gates

Five new tables are private: selection, owner events, cursor, cursor history
and ACK receipt. There is no new body view, ordinary page/search/conversation
projection, broad subscription or snapshot export. A populated upgrade retains
all 33 prior private tables without selection/cursor backfill. Ordinary restore
remains fenced; a separately authorized protected recovery contract is still
required before a canary. Raw publisher/database management remains trusted.

The shared recovery checkpoint must retain all 38 private tables and owner
histories, advanced cursor receipts and pending selections across the same
disk-backed restart without republishing. Earlier instruction, authority,
admission, inference and result ledgers/pools retain their existing semantics.
This ACK cannot mint fresh model/append grants or claim an end-to-end workflow
budget; those grants currently have independently scoped pools.

Admitted metadata/body reads, bounded wire behavior, atomic new import and
missing/held dispositions, sanitization, trusted workflow delegation/UI,
credential custody and socket enforcement remain later gates. Existing fake
mail-client tests do not establish actual IMAP behavior. The protected runner
must eventually prove its exact read-only command profile against an
instrumented server; [RFC 9051, section 6.3.3](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.3.3)
defines the read-only mailbox state. This slice executes no such commands.

## Validation

Local validation passed 159 Rust, 108 Sentinel, 478 worker, 303 web and 31
release tests, both client TypeScript checks and strict TypeScript for all
eight protected-mail fixtures plus their lifecycle helper. Generated clients
match. Connector fresh/upgrade/seed/resume passed 10/11/11/1 stages, alongside
186 earlier regression/setup checks and all four earlier recovery checkpoints.
The populated upgrade retained the old 33 private tables without backfill;
all 38 survived one shared disk-backed restart without republishing. Only the
selected pending ACK advanced. Native logs contained no panic or synthetic
inference/result/connector body marker. The owned server, synthetic databases,
checkpoint files, logs and JWT keys were removed.

The later [one-use read-plan contract](PROTECTED_MAIL_READ.md) requires separate
owner authorization over a StoredBatch selection. A selection alone still
grants no mailbox read. Plan release adds no new body ingestion or ACK effect.


The later [exact prepared-text ingestion contract](PROTECTED_MAIL_INGESTION.md)
adds separate owner-approved storage/disposition authority and an atomic cursor
commit. It does not repurpose this contract's read/ACK authority, connect raw
MIME to a sink, or permit missing/incomplete UID skips. Production MIME
sanitization, discovery, workflow and host gates remain.


The later [sparse checkpoint contract](PROTECTED_MAIL_SPARSE_CHECKPOINT.md)
adds separate owner approval over a nonempty recorded observation and complete
already-stored present records. It uses a dedicated third history family under
the same cursor, preserving this contract's scope and exact historical retries.
It does not authorize new body reads, ingestion or permanent absence tombstones.
