# Dormant executor for observed mail UIDs

S2b2c8 implements the fixed wire profile declared by the
[observation-bound read plan](PROTECTED_MAIL_SPARSE_READ.md). It is a host library:
no runner, scheduler, tool, route, UI or production credential adapter invokes it.
Installing it does not schedule pending grants or activate protected monitoring.
All conformance credentials, mail data, certificates and endpoints are synthetic.

The existing contiguous [read executor](PROTECTED_MAIL_EXECUTOR.md), metadata
[discovery executor](PROTECTED_MAIL_DISCOVERY.md), codecs and authority retain
their behavior. This adds no Rust, schema or generated-client change. All 61
private tables and the current release module remain unchanged.

## One fresh claim before secrets or sockets

`createProtectedMailSparseReadExecutor(hostOptions)` returns an
`execute(readId, signal?)` closure. Its caller supplies only an opaque read ID
and optional abort signal. There is no plan, password, target, UID list, command,
body sink, session callback or transport override in the execution arguments.

Host options are closed own-data objects copied before awaiting. Getters,
symbols, extra fields and unsupported prototypes fail without invoking getters.
The authority origin, workspace, service credential, credential resolver,
optional CA/lookup policy and deadline are fixed host configuration.

Each call attempts the existing sparse-read claim exactly once. The authority
consumes Pending1 into Dispatching2 and reserves one operation, every observed
present slot and the complete maximum raw-MIME ceiling before releasing the
plan. A denied, malformed, truncated, lost or timed-out claim resolves no
credential, opens no socket and sends no report. Concurrent calls depend on that
transaction: only the successful fresh claimant can proceed. No retry, copied
plan, reconnect or alternate grant can recover a consumed release.

The resolver receives a frozen association containing the exact read/plan IDs,
complete canonical plan, workspace/owner, connection epoch/snapshot, account,
endpoint, folder/direction and interval. The canonical plan also binds the
original service/runtime/run, observation/head/cursor, exact present/absent
partition, profile and limits. Only an exact closed `{ binding, password }`
echo with a bounded valid password can proceed. There is no environment password,
general worker token, connection-secret view or latest-credential fallback.

The resolver remains trusted. Its echo does not prove a vault lookup, current
configuration check or adequate credential scope. A production adapter must
independently validate that association and current host authority immediately
before releasing a secret. No such adapter is installed here.

## Deadlines across every asynchronous boundary

The absolute host deadline starts before claim, defaults to 20 seconds and is
at most 60 seconds. A returned plan cannot reset it; the grant expiry can only
shorten credential/session time. An already-aborted call does no work.

A successful claim arriving after abort, deadline or grant expiry returns an
unknown outcome before attaching the plan. It invokes no resolver, opens no
socket and sends no report, even when timer delivery was delayed. Its durable
reservation remains consumed for explicit reconciliation.

After attaching a timely claim, the executor checks the absolute clock and grant
interval again inside the queued resolver callback, after resolution and before
session/dial. The session checks after preparation and before accepting input or
writing commands. Its guarded DNS callback cannot forward a late success into a
TCP connection after abort, expiry or deadline. Socket ownership and cancellation
remain within the session; late claim/resolver/DNS responses cannot start another
operation.

A safety report has a separate maximum of five seconds and may occur after the
operation deadline or abort. This is not another read or a refund.

## Fixed sparse wire profile

The new sparse-only session reuses the existing pure folder encoder and FETCH
header validator. Its bounded buffer engine is separate from the older sessions;
it adds no generic command hook or permissive parser mode.

The profile uses one verified TLS 1.2-or-later connection, exact certificate
hostname or IP-SAN verification, fixed SNI and no automatic address-family retry.
Default lookup rejects private/reserved destinations, including private IP
literals. CA and lookup overrides are fixed host trust/network policy used by
synthetic fixtures; they are not caller-selected TLS bypasses.

Commands are restricted to CAPABILITY, one AUTHENTICATE PLAIN exchange, exact-folder
read-only EXAMINE, then one serial numeric UID FETCH per frozen present UID.
The folder uses literal modified UTF-7 and quoting without normalization or
namespace fallback. EXAMINE must return exactly one canonical positive-u32
UIDVALIDITY matching the observation and exactly one canonical positive-u32
UIDNEXT at least the observed horizon, plus tagged READ-ONLY confirmation.
Missing, duplicate, malformed or rollback metadata prevents every FETCH.
Growth in UIDNEXT never expands the frozen target list.

For each target, the request is `UID FETCH uid (UID RFC822.SIZE BODY.PEEK[]<0.N>)`,
where N is the smaller of the per-message maximum and remaining total. There is
no SEARCH, absent-slot probe, full-range FETCH, LIST, NAMESPACE, IDLE, STORE,
sending, preflight size fetch, continuation, fallback or reconnect.

The closed FETCH subset requires UID and SIZE before BODY, origin zero, one
literal and a matching tagged completion. A literal must be strictly shorter
than N and match SIZE; a cap-sized partial remains incomplete even when the
server declares that size. No extra cap-plus-one byte is requested. Missing,
expunged, foreign, duplicate, capped, truncated or trailing responses fail the
whole batch. A failed later UID cannot become observed absence, held disposition,
cursor progress or a partial result.

Unexpected literal announcements are rejected outside the validated FETCH-header
path. Framing limits remain 8 KiB per line, 64 KiB total control and 128 responses;
accepted decrypted input is bounded by the aggregate literal maximum plus 64 KiB.
Boundaries reject buffered trailing data after each completed protocol phase.
These bounds govern requested/accepted data. They do not prevent peer bytes from
entering OS/TLS buffers or establish host network isolation.

## Opaque content and one terminal declaration

Raw MIME is counted and hashed as opaque octets, then discarded internally.
No header, HTML, link, instruction or model parser runs. No raw body reaches a
file, queue, database, model, diagnostic, callback or public result. This is not
a physical zeroization guarantee for JavaScript strings or OS/TLS memory.

Internal full-batch metadata supports conformance checks. The public executor
returns only private opaque IDs, fixed status/reason and the chosen report
metadata. It returns no UIDs, UIDVALIDITY, UIDNEXT, body sizes, hashes, canonical
plan, password, authentication frame or earlier partial-message metadata, even
on successful reporting. Digests and IDs remain private identifiers rather than
ordinary telemetry.

The executor chooses one outcome and random nonce before making one bounded
terminal report. Full local parser completion chooses ReadReported; controlled
credential/protocol/missing/limit failures choose Failed. Ambiguous session
transport, TLS, abort or deadline failures choose Unknown. Failed does not prove
zero traffic. All dispatched outcomes retain the complete reservation.

A lost report preserves that chosen outcome and nonce. It never starts another
session, changes the outcome or automatically resends. An explicit identical
terminal retry can recover recorded metadata through the existing authority
helper. A completed executor result describes local completion; `report.kind`
states whether the declaration was recorded. Neither proves mailbox authenticity,
sanitization, storage or permission for downstream processing.

## Validation and remaining gates

Synthetic TLS conformance covers exact sparse targets, UIDNEXT growth and
failure modes, closed credentials/configuration, binary framing/caps, trailing
input, delayed claim/resolver/DNS responses, cancellation and opaque results.
Native conformance joins the unchanged c7 claim/report authority to the synthetic
TLS endpoint. Only selected sparse-read state/events may change during execution;
other private rows, owner history, sources, cursor/head and ordinary effects are
preserved. Consumed and lost claims cause no additional credential or TCP access.

The existing fourteen historical builds plus current, populated upgrades and
ten shared disk-backed recovery checkpoints remain required. No additional
baseline, state backfill or recovery ledger is added. Owned test data, keys,
checkpoints, sockets and certificates are removed after validation.

Local validation on October 23, 2026 passed 708 worker tests and typecheck,
147 Sentinel and 31 release tests, 14 private native-log guard cases, workflow/shell
syntax and 130 local documentation paths. Focused TLS checks passed 50 new session
cases, 18 new executor cases and the unchanged legacy regression suites. All 15
native scripts and both helpers passed strict TypeScript.

Native validation passed 314 fixed stages: 3 new executor, 179 historical,
122 restart-seed and 10 restart-recovery stages. All ten checkpoints survived one
controlled restart with unchanged data/keys and no republishing. Owned database,
keys, checkpoints, private logs, sockets and temporary TLS material were removed.
Independent session, executor, native-fixture and release/documentation reviews
found no blocking issues. Rust/Cargo, schemas, codecs, existing executors and both
generated clients were verified unchanged; the exact c7 release WASM was reused.

Observation-bound exact body ingestion, reviewed MIME sanitization/adaptation,
trusted recurring workflow budgets/delegation, production credential custody,
process/network isolation, trusted UI, provider transport and protected
backup/restore remain gates before real-mail use. Monitoring remains disabled.
