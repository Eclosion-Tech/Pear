# Dormant contiguous mail composition

This cut joins existing protected operations into one synthetic workflow. It
adds internal bounded MIME custody and an exact owner result read, without a
new table, grant family, cursor namespace or recurring authority. No runner,
tool, route or production credential/provider adapter activates the workflow.

## One complete path

The fixture starts with no S1 mail records. An authenticated owner approves a
truthful contiguous StoredBatch selection and its existing one-use read plan.
The trusted host consumes that fresh claim before resolving credentials or
opening the fixed TLS session. It retains complete admitted literals internally
until every selected UID, declared size and response boundary has passed.

A fixed parser worker prepares bounded literal text and metadata. Unsupported
complete content can become the existing `unsupported_content` disposition.
Missing, capped, malformed or uncertain network reads fail the whole batch;
they cannot become held or absent entries to force cursor progress.

The host-configured review hook receives the copied/frozen exact prepared c4
payload and commitment. It receives no raw MIME or password. Hook success is
not storage authority: the owner must issue the existing exact c4 authorization,
and the bound service submits those same entries once. The existing c4
transaction checks authority, stores sources/dispositions, advances the existing
cursor and declares the same read `ReadReported` atomically.

Explicit management then enrolls source ceilings. The owner separately approves
instructions and an existing inference grant. Existing admission/payload
consumption feeds a deterministic tool-free synthetic provider; it is not a
real provider call or model-quality evaluation. Existing owner result
authorization and result acceptance store the private derived result with its
complete ancestry. The owner reads that accepted body through the new procedure.

## Custody and parsing limits

The existing strict c2 IMAP wire profile remains in force. This cut does not
adopt ImapFlow defaults or widen already-issued manifests. The public read
executors retain their opaque outputs and automatic terminal reporting; callers
cannot request raw output or suppress a report.

The internal parser uses the installed pinned MailParser/mailsplit grammar.
It returns bounded plain text and metadata, discards attachment contents, and
does not render HTML, images or links. Raw input is bounded by the admitted read,
16 KiB header blocks and 64 MIME child nodes bound structure; decoded content
is capped at 256 KiB and plain-text output at 64 KiB. Each worker has a three-second
deadline within the read/host deadline and 64/8 MiB V8 heap limits, and the
parent can terminate the worker on cancellation or deadline. The worker receives
an empty environment and no database, mailbox or provider credentials. Retained
raw buffers are cleared after preparation and on failure.

These are application controls. MailParser assembles text before final output
checks; V8 limits exclude external Buffer allocations. A worker is not an OS
filesystem/network sandbox, and clearing retained buffers does not erase every
runtime/library copy or string. The production host profile remains a gate.

Prepared text remains untrusted. MIME decoding is not secrecy filtering, HTML
sanitization or instruction approval. The parser's tolerance for some malformed
MIME does not establish semantic completeness; complete network transport is
validated independently. The synthetic HTML-only held case does not demonstrate
universal authentication-code or reset-link detection. MailParser maintenance
policy and engine selection remain as recorded in the [reuse spike](PROTECTED_MAIL_REUSE_SPIKE.md).

## Terminal and unknown outcomes

Before an ingestion submission, failure selects one fixed terminal declaration.
No incomplete batch reaches review or storage. A lost read-claim reply starts no
credential resolution or session; its consumed reservation never reopens.

After an ingestion submission, a lost/uncertain reply may follow an atomic
commit. The composition does not resend or issue a competing terminal report.
An explicit identical existing c4 retry can recover receipt metadata only.
Successful c4 itself supplies read completion; there is no second terminal effect.

## Exact owner result retrieval

`read_protected_mail_result(admission_id)` returns one closed product:

```text
[format_version=1, admission_id, source, body, envelope_digest, envelope_bytes]
```

The role gate runs before private result lookup and requires retained module
metadata plus a currently authenticated eligible human identity. The admission
must belong to that exact owner. Publisher, services, AI identities, AI/human
hybrids and non-owner administrators cannot read on the owner's behalf.
Malformed, missing, foreign and not-yet-accepted IDs share the fixed owner
denial. Inconsistent owned retained associations return a fixed inconsistency.

The procedure validates retained grant/run/admission, exact owner authorization,
dispatch/completion events, result envelope, indexed derivation namespace and
complete immutable source ancestry. It returns the exact bounded literal body,
without a parent-list enumeration, SQL view, subscription or broadcast. It
performs no write, repair, new admission or promotion.

Accepted history remains readable to its currently authenticated exact owner
after operational expiry, revocation, policy narrowing or connection deletion,
as retained S1 owner history does. Those changes still restrict new processing
and effects. Historical retrieval cannot renew a grant, consent or budget.

## Scope and remaining gates

This is a contiguous composition proof. Sparse c7/c8 IDs cannot masquerade as
c2 StoredBatch reads or enter c4 through a fabricated conversion. Sparse
ingestion, trusted recurring recipes/delegation, production credential custody,
provider transport/response validation, host isolation, reviewed UI and protected
backup/restore remain explicit gates. Monitoring remains disabled.

See [ingestion](PROTECTED_MAIL_INGESTION.md), [result acceptance](PROTECTED_MAIL_RESULTS.md)
and the companion Cloud implementation plan for the existing authority contracts.


## Validation

Local verification passed 231 Rust, 147 policy, 722 worker and 303 web tests;
both client type checks and strict TypeScript for every protected E2E fixture
passed. The 63 targeted worker cases include 14 new custody/composition tests
and 49 existing strict-session/public-executor regressions.

Native localhost composition passed six fresh stages and seven populated-upgrade
stages. The prior exact 61-table module accepted the synthetic workflow before
an additive upgrade; all private row snapshots remained unchanged, and the new
owner read returned the retained accepted body. The existing public executor
also passed its two native authority/TLS stages. Raw fixture data and bearer
material did not reach diagnostics.

Actual WASM schemas retain all 149 table shapes, including every one of the 61
private protected-mail tables. Both clients were regenerated from the exact new
release WASM and all 373 generated files match. Dependencies and the lockfile
are unchanged. Host release tests (31), native-log guard cases (8), workflow and
shell syntax, documentation links and independent security reviews passed.
The owned native server, database data, synthetic keys and TLS certificates were
removed after verifying healthy shutdown and clean private logs.
