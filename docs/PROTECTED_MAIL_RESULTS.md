# Restricted inference-result acceptance (S2b2b2)

This slice saves one bounded broker-declared result as a private derivation
after its inference request was consumed. A new, explicit owner authorization
permits that storage. Existing processing grants are not widened, and existing
terminal outcomes acquire no body automatically. Protected monitoring remains
disabled. No provider call, provider-response parser, credential lookup,
mailbox/cursor permission, trusted UI or automatic summary promotion is added.

## Separate owner authority

`issue_protected_mail_result_authorization` binds one exact inference admission,
an owner event nonce, expiry and maximum canonical result-envelope bytes.
The authenticated non-AI collection owner must still have current processing
authority. Initial issuance is allowed only while the admission is `admitted`
or `dispatching`. Its expiry cannot exceed the processing grant's expiry or
the one-hour bound. The immutable authorization cannot be widened, renewed or
replaced; revocation is terminal. Exact historical issuance retries are inert.
The admission itself supplies the namespace, so another owner cannot preempt a
globally chosen authorization ID.

Source storage permission is a ceiling, not an independent workflow grant.
Acceptance requires both this explicit authorization and every current input
ancestor's owner-storage permission. Version one also requires the original
processing grant and processor permissions to remain current as a conservative
workflow continuation rule. Processing-only mail with storage disabled can
still receive the previously authorized inference disclosure, but its result
cannot be saved through this API. Metadata-only terminal reporting remains
available under its separate retained-association checks.

## Fixed declaration and measured envelope

The bound broker submits exactly six fields:

```ts
{
  formatVersion: 1,
  adapter: "anthropic.messages.v1",
  model: string,
  stopReason: "end_turn",
  outputTokens: number,
  body: string
}
```

The model must equal the frozen registry model. Declared output tokens are
positive integers no larger than the already reserved cap. The nonempty
literal body is at most 64 KiB UTF-8; invalid scalar strings and controls other
than LF, CR and TAB fail. Whitespace, Unicode and line endings are preserved.
Tool calls, parents, citations, approval, storage destination, sanitization
version and replacement configuration are not declaration fields. Those words
may occur inside literal text without becoming instructions or authority.

The server constructs the closed ten-key envelope:

```ts
{
  adapter, admissionId, body, formatVersion: 1,
  kind: "mail.inference.result", model, outputTokens,
  parents, sanitizationVersion: "sentinel-result-v1", stopReason: "end_turn"
}
```

`parents` comes exclusively from the complete stored input closure of the
consumed admission, including mail, approved instruction and all ancestors.
References use canonical decimal u64 revision strings, sort by UTF-8 ID and
numeric revision, and retain their digests. Canonical JSON sorts keys in ASCII
order. The authorization charges the actual complete envelope UTF-8 bytes,
including JSON escaping, metadata and every parent; its ceiling is 256 KiB.
This is a logical-envelope limit, not a measurement of physical database
storage. It is separate from the already spent inference budget, which is
never refunded or reset from reported token usage.

The portable codec checks this structure and freezes matching bytes/digest.
It authenticates no caller or ancestry and creates no S0 operation or permit.
The procedure never accepts its asserted parent list or hash as authority.

The model, stop reason and token count are authenticated broker declarations,
not provider, tokenizer or quality attestations. The fixed sanitization tag is
a format label, not proof of redaction. Binding a result to an admission does
not prove which model executed remotely, that its text is accurate, or that a
broker had no other inputs. Isolated stateless brokers, actual provider
transport/response validation and host enforcement remain later gates.

## Atomic acceptance and inherited restrictions

`accept_protected_mail_inference_result` authenticates the bound broker and
checks all current authority inside its transaction: eligible owner/service,
active processing and result authorizations, connection epoch/configuration,
exact instruction decision, current processor and every ancestor policy.
Only `dispatching` may become a new accepted result. Legacy `response_received`,
`failed`, `unknown` and pre-dispatch cancellation cannot be resurrected.

The transaction creates a host-owned, sealed S1b context/exposure and derived
source, installs the current intersection of parent restrictions, inserts an
immutable result receipt and advances inference to `response_received`.
The source's parents are the exact full input closure. The new wrapper must
fit the graph's node/depth bounds; ancestry is never truncated to make it fit.
Missing, stale, revoked or colliding state leaves every write uncommitted.

The context uses a reserved runtime and the exact admission ID. Existing
caller-created contexts or artifacts at that key are never adopted, even if
their bytes match. Public generic provenance writes cannot create new artifacts
in that namespace; safe historical replay and publisher blocking remain
available. Publisher management remains trusted and can read underlying
private records. The new broker API does not impersonate the publisher or
weaken public staging authorization.

The procedure returns only the accepted source reference, envelope digest and
byte count. It returns no result body or private ancestor list. The dedicated
HTTP helper uses host-owned authority configuration, one attempt, bounded
strict response decoding, rejected redirects and fixed errors. A lost reply
does not justify another provider request. An explicit identical acceptance
retry can recover the same metadata without another write.

## Replay, races and recovery

There is one accepted result globally per inference admission. Exact completed
acceptance replay binds the original event nonce and declaration and is inert
after authority changes, while the broker role and historical association must
still authenticate. Changed body/metadata/nonce conflicts. Neither replacement
authorization nor another run can create a second result. Reserved lifecycle
nonce collisions fail before writes rather than relying on index errors.

Acceptance races atomically with existing terminal reporting. If a report wins,
the result is not saved; if acceptance wins, a competing event cannot reopen
it. Late body storage is rejected after revocation, expiry, owner/service role
changes, epoch/configuration changes or incompatible policy changes. These
checks cannot recall a request that was already disclosed to its broker.

Three new private tables retain result authorizations/events and receipts.
Bodies use the existing private derivation/source family. No new body view,
ordinary page, search entry, snapshot, broad subscription, summary grant or
committed promotion is created. A later local promotion still needs its own
owner-issued exact-stage grant and all current storage checks.

The additive-upgrade fixture preserves all 30 earlier private tables and owner
histories without backfill. Recovery checkpoints retain accepted results,
pending authorizations and terminal outcomes; retries must leave receipts,
source bytes and both limits unchanged across an owned disk-backed restart
without republishing. Protected backup/restore must eventually retain all
these ledgers and invalidate restored authority before real-mail use.

Connector selection/cursor authority, trusted owner UI/recipe, sanitization
and held-message behavior, isolated credential/transport services and protected
backup/restore remain prerequisites for a canary. Ordinary assistants still
receive no protected mail through this work.

## Validation

Local validation passed 146 Rust, 97 Sentinel, 472 worker, 303 web and 31 release
tests, both client TypeScript checks and strict TypeScript for all seven
protected-mail fixtures plus their shared helper. Generated client digests
match. Result fresh/upgrade/seed/resume passed 13/14/14/1 stages, alongside
158 earlier regression/setup checks and the three earlier recovery checkpoints.
The populated upgrade retained the old 30 private tables without backfill;
all 33 survived the same disk-backed restart without republishing. Native logs
contained no panic or synthetic inference/result body marker. The owned server,
synthetic databases, checkpoints, logs and JWT keys were removed.
