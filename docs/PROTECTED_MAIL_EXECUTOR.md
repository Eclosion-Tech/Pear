# Dormant bounded IMAP executor (S2b2c3)

The fixed executor consumes a fresh [one-use read-plan release](PROTECTED_MAIL_READ.md)
internally and exercises its wire profile. It remains a host library with no
runner, scheduler, tool, UI or API route. Installing it does not schedule old
pending grants or turn the earlier plan-release decision into production
credential or execution authority. A reviewed workflow, credential service and
isolated supported host remain activation gates. Monitoring stays disabled.

Conformance uses synthetic credentials and an instrumented local TLS server.
It accesses no real mailbox, provider or production workspace. No database
schema changes, new grant family or additional recovery checkpoint are needed.

## One claim, one session

`createProtectedMailReadExecutor` captures trusted host configuration and returns
a callable `execute(readId, signal?)` closure. Its public arguments accept no
plan, password, destination, command, raw-body sink or transport override. It
calls the existing authority claim exactly once. A denial, lost reply or invalid
claim response opens no socket and resolves no credential. A copied preparation
object is not a permit.

Only fresh successful claim metadata reaches the internal protocol module.
There is one TLS session and no reconnect, throttle retry, fallback account,
folder discovery, alternate endpoint or continuation fetch. Concurrent callers
still depend on the authority transaction: one may receive the plan, and the
others receive consumed without obtaining credentials or opening sockets.

The credential resolver receives a frozen association containing the exact
module/owner, read/selection/plan commitments, connection ID/epoch/snapshot,
account/endpoint/folder, UIDVALIDITY/UIDs and interval. The complete returned
association must match before dialing; another epoch, snapshot or username
cannot substitute. Passwords are bounded valid UTF-8 without C0/C1 controls.
There is no environment, ordinary worker token, connection-secret view or
"latest password" fallback.

The resolver is a trusted host seam. An echoed association does not attest that
a vault or current configuration was checked. The production adapter must
independently validate that exact credential/version and current host authority
before releasing a secret. No such adapter is installed here. Claim and secret
release are finite authorization boundaries; later revocation can request
cancellation but cannot retract bytes already disclosed.

## Fixed protocol and compatibility

The executor supports an explicit IMAP4rev1 subset. It uses direct TLS with CA
and exact-host verification, a TLS 1.2 minimum, and bound DNS-host SNI. IP hosts
receive certificate IP-SAN verification without IP SNI. Default socket lookup
rejects private/reserved addresses; a host-owned lookup policy and CA may be
supplied for the synthetic fixture or a later reviewed private deployment.
There are no generic TLS options that disable verification. Implicit TLS avoids
an opportunistic plaintext/STARTTLS path. [RFC 8314](https://www.rfc-editor.org/rfc/rfc8314.html#section-3.2)

The only commands are:

1. `CAPABILITY`, requiring IMAP4rev1 and advertised `AUTH=PLAIN`.
2. `AUTHENTICATE PLAIN` with one empty continuation, empty authorization identity
   and the exact plan username over verified TLS.
3. `EXAMINE` of the exact folder encoded in canonical modified UTF-7 and quoted
   without namespace prefixes, case changes or Unicode normalization.
4. One serial `UID FETCH` per selected UID, requesting `UID`, `RFC822.SIZE` and
   `BODY.PEEK[]<0.N>` with `N = min(message maximum, remaining aggregate)`.

The socket closes after the batch. No LIST, SEARCH, NAMESPACE, ID, ENABLE,
COMPRESS, IDLE, SELECT, STORE, send or arbitrary command is available. A zero
remaining aggregate stops before another request. The pinned legacy ImapFlow
path discovers namespaces/folders and retries FETCH internally, so it is not
used by this executor. Authentication uses no alternate-user or fallback mode.
[SASL PLAIN](https://www.rfc-editor.org/rfc/rfc4616.html#section-2),
[mailbox encoding](https://www.rfc-editor.org/rfc/rfc3501.html#section-5.1.3).

EXAMINE must return one matching canonical nonzero u32 UIDVALIDITY and an
explicit tagged `[READ-ONLY]` result before any fetch. Responses bind through
their UID item, not the leading message sequence number. The closed FETCH
subset requires UID and SIZE before the body, origin zero, one literal and one
tagged completion. Unsupported response orderings, extensions, UTF8=ONLY or
pure rev2 servers fail closed rather than triggering negotiation or discovery.
This is deliberately not a general IMAP compatibility claim.

## Bound accepted bytes before interpreting content

Raw MIME stays opaque. The incremental parser counts and hashes literal octets
without parsing headers, HTML, links or instructions. An oversized literal
announcement is rejected before allocation or copying. A literal must match
the requested UID, offset and declared size, and be strictly shorter than the
requested partial maximum. A cap-sized partial remains incomplete even when
SIZE matches; no extra `cap + 1` byte or follow-up probe is requested. SIZE is a
server declaration, not an independent proof of message completeness.
[RFC 9051](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.4.5)

A tagged OK with no matching FETCH is a missing UID. Duplicate, foreign,
malformed, truncated, oversized or capped responses fail the whole batch. A
bad final UID returns no earlier message metadata. There is no held/missing
disposition, cursor skip or partial import.

Independent hard bounds cover 8 KiB control lines, 64 KiB cumulative framing,
128 control responses and decrypted session input no larger than the aggregate
literal maximum plus 64 KiB. The host operation deadline covers claim, credential resolution and the
session. Once a valid claim reveals selection expiry, the remaining credential
wait and session also stop at that earlier time.
Abort and failure close the owned socket. Late claim or resolver replies cannot
start a connection after the caller has stopped waiting.

These are bounds on requested, accepted and exposed data. A malicious peer may
push excess bytes into OS/TLS buffers before the client closes; a JavaScript
parser does not establish network-level receive isolation. Host egress,
process isolation and transport buffering remain separate supported-host gates.

## Metadata and retained outcomes

The only successful result is bounded private metadata: read/plan identifiers,
UIDVALIDITY, UID/octet-count/digest items and aggregate accepted octets. Raw
message bytes are discarded internally. Nothing is sent to a model, ordinary
page, diagnostic, temporary file, queue or body callback. Digests are sensitive
identifiers, not anonymization, and are not ordinary telemetry.

The executor chooses one terminal declaration and one nonce, then makes one
bounded metadata-only report attempt. The report has a separate five-second
maximum. Losing that reply returns an unknown report with the same chosen
outcome and nonce; it never changes the outcome, reads again or refunds the
reservation. A controlled `Failed` declaration does not imply zero traffic.
Ambiguous transport/abort/deadline failures remain `Unknown`. `ReadReported`
means this restricted parser accepted the entire selected batch; it does not
attest mailbox authenticity, redaction, exact upstream size or stored content.

Existing c2 state retains its full operation/message/byte reservation for every
dispatched terminal outcome. The executor creates no S1 source, record, policy,
import receipt, cursor/history/ACK, inference or downstream grant. Atomic new-body
admission, sanitization, missing/held dispositions, trusted workflow budgets/UI,
credential custody, protected recovery and host isolation remain later gates.

## Validation

Local validation passed all 539 worker tests and TypeScript, including 41
instrumented real-TLS cases, eight protocol/preflight cases and six terminal
report cases. Strict TypeScript passed for all ten protected-mail fixtures and
two lifecycle/TLS helpers. All 31 release contracts, seven native private-log
guard cases, shell/workflow syntax and 127 local documentation links passed.

The integrated localhost test used real c2 claim/report procedures and a
synthetic TLS mailbox. It checked exact Pending1 to Dispatching2 to ReadReported3
state/events, full retained reservations, a consumed retry without another TCP
connection, and unchanged earlier 40 private tables plus ordinary state. There
were no raw body writes or cursor effects. The unchanged module/bindings were
verified against merged c2; no schema, migration or code generation changed.
All TLS sockets, ephemeral certificates, the owned database, test data, logs
and generated synthetic JWT keys were removed. The paired Cloud PR records
the exact-source CI run.


The later [exact prepared-text ingestion contract](PROTECTED_MAIL_INGESTION.md)
adds separate owner-approved storage/disposition authority and an atomic cursor
commit. It does not broaden read authority or the existing ACK contract, connect raw
MIME to a sink, or permit missing/incomplete UID skips. Production MIME
sanitization, discovery, workflow and host gates remain.


The later [dormant sparse executor](PROTECTED_MAIL_SPARSE_EXECUTOR.md) consumes a
separate observation-bound read claim and tests exact present-UID BODY.PEEKs.
It preserves this contract, supplies no body ingestion or production credential
adapter, and neither advances the cursor nor activates monitoring.
