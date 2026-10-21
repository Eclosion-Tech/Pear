# Local protected summary admission (S2b2a)

This slice admits one fixed **local promotion of an already-staged summary**.
It adds owner-issued grants, service-bound runs, a shared budget, and a private
committed-summary pointer with an immutable receipt. The source body remains in
the validated [S1b derivation](PROTECTED_MAIL_STORAGE.md); promotion copies no
body into ordinary pages or assistant context.

It does not admit the initial staging write, mailbox access, inference,
screening, network dispatch, or a cursor update. Publisher maintenance remains
trusted management. Protected monitoring remains disabled, and no runner,
trusted review UI, native/MCP tool or CRUD route is connected to these reducers.

## Exact owner authority

`issue_protected_mail_summary_grant` requires the authenticated, non-AI owner
of the retained collection. It freezes:

- The owner, collection and connection, current enrolled connection epoch and
  exact configuration snapshot. Grant records are local to the issuing module;
  operation/effect identities derive the workspace from `ctx.identity()`.
- One explicitly selected service identity and runtime label. The service must
  differ from the owner and publisher and cannot be an authenticated human,
  administrator, or have either AI identity role. A connection-created unauthenticated user stub
  is not itself a human role.
- The exact current approved instruction reference, head generation and
  approval decision. A revision reference alone is insufficient; reapproval of
  the same revision changes authority and invalidates the older grant.
- One to 64 exact, preexisting staged derivation references. Every candidate
  must already include that instruction and the connection's mail ancestry in
  its stored source closure. Grant issuance cannot add missing ancestry. The
  union of all allowed candidates also obeys the 256-source graph bound.
- Activation/expiry within the fixed one-hour bound, maximum operations, an
  aggregate append-byte pool, and a per-operation append-byte ceiling.

These bindings and limits cannot be widened, replenished or extended in place.
Revocation is terminal. Exact issue/revoke retries preserve history without
resetting a budget or reactivating the grant. Authentication identifies the
owner credential; it does not attest physical human presence or a reviewed
display. The trusted UI/recipe remains a later gate.

This older local API accepts a globally chosen grant ID. An eligible owner with
its own collection can detect a collision with a guessed existing ID or reserve
a predictable unused ID; it cannot read or use another owner's grant. Owner-
scoped issuance is required before exposing this API through the trusted UI.
The newer [inference grant](PROTECTED_MAIL_INFERENCE.md) derives that namespace
on the server. Retained local IDs are unchanged by this slice.

The service must authenticate as the bound `ctx.sender()` for each run and new
promotion. Runtime/run strings are labels, not credentials or proof of an
isolated executable. Owner, publisher, human and AI role changes are checked
again at use. No publisher fallback or caller-selected owner is accepted.

## Runs and shared limits

`start_protected_mail_summary_run` registers a bounded run, optionally under an
existing parent of the same grant. There are at most 256 runs per grant and
16 levels. Every root and descendant references the **same grant budget**;
creating a child never copies or refills counters.

The effect run may differ from the original publisher-registered staging
context. The exact allowlist authorizes the artifact; it does not prove which
model generated it. Promotion validates the original frozen seal and rejects
a blocked original context. Advancing that context does not rewrite a frozen
candidate's ancestry.

## One atomic local effect

`admit_and_promote_protected_mail_derivation(grant_id, run_id, stage, event_nonce)`
accepts references and identifiers only. It accepts no body, payload digest,
byte count, processor selection, exposure set, clean verdict or checkpoint.
Within one reducer transaction it:

1. Authenticates the service and checks its stored run/grant association.
2. Checks current owner eligibility, active grant and time, retained connection
   epoch/configuration and absence of a terminal tombstone.
3. Checks the exact current approved instruction and decision/head generation.
4. Resolves the immutable staged body and complete source closure, including
   the staged source itself. Every current ancestor policy must permit storage
   in the owner's collection; missing, revoked or inconsistent state denies.
5. Constructs the fixed append envelope from stored bytes, computes its actual
   UTF-8 size and digest, and checks the whole shared and per-operation limits.
6. Debits one operation and the full envelope bytes, inserts the unique private
   committed-summary pointer, and inserts its immutable admission receipt.

Failure leaves no partial pointer, receipt or budget debit. Local promotion
can succeed with an empty processor ceiling when owner storage is permitted.
Its screening requirement is fixed to `not_required`; this makes no claim of
inference permission, completed redaction, a clean classifier result, or
summary accuracy.

## Frozen append contract

`FrozenAppendPayloadV1` is a closed JSON shape:

```ts
{
  body: string,
  contractVersion: 1,
  kind: "mail.summary",
  parents: SourceRef[],
  sanitizationVersion: string,
  stage: SourceRef
}
```

`parents` is the complete closure, including `stage`. References use canonical
positive decimal u64 revision strings and lowercase SHA-256 digests. They sort
by UTF-8 source ID, numeric revision and digest; duplicate/conflicting source
identities fail. Object keys sort in ASCII order. Literal body bytes, Unicode,
newlines and whitespace are preserved without trimming or normalization.
Invalid scalar strings, unsupported fields and bounds fail closed. Existing
derivation bounds apply; the complete envelope is additionally capped at
512 KiB. Epochs, millisecond timestamps and budget values must fit JavaScript's
safe integer range before constructing the S0 operation.

The server reconstructs the existing S0 `MailAppend` operation from its module
identity, owner, grant runtime, actual effect run/parent, connection epoch,
fixed owner destination and measured envelope size/digest. The operation hash
is distinct from the staged source digest, payload hash, grant request digest
and effect identity. `prepareMailAppend` supplies the matching portable codec
and frozen-byte preparation; a caller-created prepared object is never a
permit and is not accepted by the reducer.

The receipt records the actual payload hash/cost, operation fingerprint,
current source generations, authenticated service and resulting budget state.
Neither an exposure registration nor a receipt attests complete token lineage,
actual prompt assembly, model execution, or adherence to an instruction.

## Replay and recovery

The unique effect identity binds the module/workspace, collection, contract
version and exact staged source reference. It excludes grants, roots, runs,
children and caller nonces. Issuing another grant therefore cannot promote the
same staged source again. This is once per exact staged artifact, not once per
IMAP message; trusted management can create another staged artifact.

A separate request identity binds the original grant, run and event nonce.
Reusing that nonce for another artifact conflicts. Only the identical completed
request, from its still-eligible bound service, can replay without effect after
grant expiry/revocation, instruction changes, pause or disconnect. It creates no
new receipt, debit, disclosure or authority. A changed request or another run or
grant attempting the consumed stage fails rather than receiving a new permit.

The committed pointer, receipt and spent budget persist together. A controlled
disk-backed restart checks retained state and replay without republishing the
module. This does not establish crash-safe external dispatch or exactly-once
remote I/O. No arbitrary cursor argument is accepted: a summary's source graph
cannot prove a contiguous mailbox UID prefix.

## Private storage and later gates

Six new private tables hold grants, grant events, runs, budget pools, committed
summary pointers and admission receipts. They have no body view or public
table bindings. Broad worker subscriptions and ordinary snapshot allowlists
exclude them. Creation requires an existing retained collection, so ordinary
restore is already fenced; active v2 restore cannot create that collection.
A future protected backup/restore must preserve global effect receipts and
spent budgets, retain restrictions and fence restored authority before use.
Restoring bodies without the ledger could otherwise make an old effect new.

The disposable admission fixture covers fresh and populated S2b1 upgrades,
identity boundaries, exact input/payload bindings, revocation and ABA changes,
shared-budget/effect races, no-op replay, private projections and a retained
restart. Cloud builds the S2b1 baseline independently alongside the five earlier
baselines, rejects current identity against all six, and runs both authority and
admission restart checks across one owned server restart. Release conformance
also runs the fresh fixture against the exact release WASM.

[Fixed inference admission](PROTECTED_MAIL_INFERENCE.md) adds a separate
processing grant and one-use payload claim with current dispatch-time checks.
[Restricted result acceptance](PROTECTED_MAIL_RESULTS.md) adds explicit owner
storage authorization for a bounded private stage, without automatic promotion.
Provider execution, isolated credentials, authenticated broker RPC and host
egress controls remain later gates. Preserve spent/unknown outcomes rather than retrying a remote
effect by resetting a local receipt. Trusted owner UI, complete real exposure
tracking, sanitization, protected backup/restore and the full connector/provider
workflow remain prerequisites for the protected mail canary.

Local validation on this slice passed: 120 locked Rust tests and release WASM,
75 portable Sentinel tests/typecheck, 458 worker and 303 web tests with both
TypeScript checks, matching regenerated clients, 31 release contracts and all
six baseline collision guards. Live admission fresh/S2b1-upgrade/seed modes
passed 14/15/15 fixed stages, then all 23 private tables, owner history, inert
replays and the exhausted byte pool survived a controlled restart without
republishing. Existing mail/provenance and instruction fresh/S1b/S2a upgrade
fixtures and the S1c authority upgrade/restart also passed. The entire owned
disposable server, synthetic databases, checkpoint files and JWT keys were
removed. The coordinated Cloud PR records the full Docker CI result.
