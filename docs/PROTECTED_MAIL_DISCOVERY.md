# Bounded metadata-only discovery

S2b2c5 adds a separate owner-approved discovery operation and a dormant host
executor. It observes UID metadata in one configured folder. It does not fetch
headers or bodies, create an inbox baseline, advance the inbox cursor, authorize
skipping missing UIDs, or issue downstream grants. Protected monitoring remains
disabled. The existing [selection](PROTECTED_MAIL_CONNECTOR.md),
[read](PROTECTED_MAIL_READ.md), [executor](PROTECTED_MAIL_EXECUTOR.md) and
[prepared ingestion](PROTECTED_MAIL_INGESTION.md) contracts retain their scope.

## Authority and retained state

`review_protected_mail_discovery` is a stateless authenticated human-owner
preview. `issue_protected_mail_discovery` repeats its checks and binds the exact
manifest digest, connection epoch and configuration snapshot. Publisher and
administrator identities cannot substitute for the owner. The manifest freezes
the service identity, runtime/run, workspace, account, exact folder/direction,
times, cursor, discovery head, mode and limits. Expiry is at most one hour.

Each owner-issued nonce identifies a distinct grant. There is no recurring root
or automatic renewal. Explicitly approved grants can share a cursor version;
their operations have independent reservations. Revocation is terminal.

Six new private tables retain the grant, grant events, dispatch state, dispatch
events, immutable observations and discovery head:

- `protected_mail_discovery_grant`
- `protected_mail_discovery_grant_event`
- `protected_mail_discovery_state`
- `protected_mail_discovery_event`
- `protected_mail_discovery_observation`
- `protected_mail_discovery_head`

The 47 previous private table schemas are preserved. Upgrade creates no grant,
observation, baseline or policy backfill. These tables have no ordinary reader,
subscription or JSON export projection. Metadata and its digests are private;
hashing is not anonymization. Privileged database/host management remains trusted.

The discovery head is separate from the inbox cursor. Its stable identity binds
the owner, module, connection and exact folder across connection epochs. After
the first accepted observation, UIDVALIDITY must remain fixed and UIDNEXT cannot
decrease. The head links an immutable observation and its bounded immediate
predecessor. It remains retained after deletion. Reset/reconciliation needs a
future separately reviewed operation.

## Two closed modes

`Bootstrap` requires no inbox cursor. It observes UIDVALIDITY and UIDNEXT through
EXAMINE, with no SEARCH. UIDNEXT 1 is valid. It records no range, present set or
absence set. Creating a new-only baseline requires separate human authority.

`NextWindow` freezes the validated inbox cursor and one through eight numeric UID
slots immediately after it. Let `from = lastUid + 1`. A nonempty search ends at
`min(lastUid + maxSlots, UIDNEXT - 1)`, using checked arithmetic. UIDNEXT must be
greater than the cursor's last UID and at least the retained discovery horizon.
When UIDNEXT equals `from`, the interval is empty and the connector sends no
SEARCH. A cursor at u32 maximum cannot form another window. UIDNEXT itself may
equal u32 maximum.

For a nonempty interval, the connector issues exactly one numeric
`UID SEARCH UID from:through`. It accepts one complete SEARCH result containing
zero or more canonical, strictly ascending, unique UIDs inside that interval.
The authority derives the absent complement over at most eight slots. Callers
cannot submit their own range, through UID or absence list.

IMAP UIDs need not be contiguous. UIDNEXT predicts the lower boundary for later
arrivals; it does not promise that a message with that UID will exist. Numeric
ranges include both endpoints regardless of their order, so this profile never
sends a reversed empty range or uses `*`. UID SEARCH returns UIDs, and SEARCH can
return an empty set. These protocol facts motivate the bounded profile.
[RFC 3501](https://www.rfc-editor.org/rfc/rfc3501.html)

An observation is a trusted connector/server declaration. It is not an atomic
mailbox snapshot or cryptographic proof of upstream state. Later arrivals and
expunges may race the operation. A failed later body fetch cannot retroactively
become observed absence. Sparse selection and absent-slot disposition require
separate authority; the existing contiguous StoredBatch contract is unchanged.

## One claim, one session, one chosen report

`begin_protected_mail_discovery_dispatch` atomically consumes Pending generation
1 into Dispatching generation 2 before releasing its metadata plan once. It
reserves one operation, 65,536 accepted input/control bytes and the maximum
numeric slots. A lost reply remains consumed. There are no refunds or reopenings.

`complete_protected_mail_discovery` accepts only UIDVALIDITY, UIDNEXT and present
UIDs. Fresh completion rechecks the current owner/service, configuration, epoch,
time, revocation, exact cursor/no-cursor and frozen discovery head. One transaction
inserts the observation, unique head-generation association and Observed terminal
event/state, then updates the discovery head. It never writes the inbox cursor.
Separately approved concurrent grants can both dispatch; only one completion can
win a particular head generation. The losing result is never silently rebased.

Exact completed report retries validate their own retained associations and
return identical receipt metadata after expiry, deletion or later head/cursor
movement. Changed declarations or nonces conflict. Failed and Unknown operations
cannot later acquire an observation. The original still-eligible service can
record a safety terminal outcome after expiry, revocation, pause or deletion.

`createProtectedMailDiscoveryExecutor` is a host-configured closure. Its caller
supplies only an opaque discovery ID and optional abort signal. It consumes a
valid claim before invoking the exact credential resolver or opening a socket.
The resolver must return an exact closed binding, including the complete frozen
canonical plan. Its echo declares a trusted association; it does not attest that
a credential vault or current configuration was independently checked. There is
no production credential adapter or environment-password fallback.

The public result contains a fixed status and opaque IDs/nonce. A confirmed
completion adds only authenticated receipt metadata. UIDVALIDITY, UIDNEXT,
present/absent sets and local ranges never leave through executor results. A lost
or denied completion exposes no local observation, sends no alternate terminal
report and opens no second session. The fixed HTTP helpers make one attempt;
explicit identical report recovery is distinct from redispatch.

## Wire and transport limits

The separate metadata protocol uses verified TLS 1.2 or later, the exact server
certificate hostname, default public-address lookup and rejection of private IP
literals. CA and lookup overrides are fixed host options used by synthetic tests.
The profile is CAPABILITY, PLAIN authentication, exact-folder EXAMINE and at most
one numeric UID SEARCH. EXAMINE must return unique canonical nonzero u32
UIDVALIDITY/UIDNEXT and tagged READ-ONLY confirmation.

It rejects literals, FETCH, ESEARCH, referrals, PREAUTH, BYE, unsolicited EXPUNGE,
duplicate or malformed counters/results, wrong tags and buffered trailing data.
This is a deliberately strict IMAP4rev1 subset; some legal unsolicited responses
cause failure. The protocol has no body parser, callback or arbitrary command.
It reuses only the earlier executor's pure folder encoder.

Limits are 8 KiB per line, 64 KiB total accepted decrypted input, 128 responses
and a host deadline of at most 60 seconds, also bounded by grant expiry. Accepted
input limits do not prevent peer bytes from entering OS or TLS buffers. Late
claim/resolver success cannot dial. Claim responses are streamed within 16 KiB,
with an 8 KiB canonical plan. Reports use at most 4 KiB and five seconds. Fixed
errors exclude raw server text, transcripts, passwords and authentication frames.

## Release boundary

Synthetic TLS and native disposable-database conformance cover authority,
concurrency, replay, sparse/empty horizons, rollback, strict wire limits and
privacy. The release gate retains populated old47 upgrade coverage and adds an
eighth shared disk-backed recovery checkpoint for all53 private tables. Fixture
diagnostics use fixed stage codes; the wrapper owns cleanup of data and keys.

MIME sanitization/body adaptation, sparse disposition, trusted recurring workflow,
provider transport, isolated credentials/network, trusted UI and protected
backup/restore remain gates before a real-mail pilot. No mailbox or workspace
hostname is hardcoded. This slice deploys or activates nothing.


Local validation passed 197 Rust, 134 Sentinel, 623 worker and 303 web tests,
worker/web typechecks, matching generated clients and strict standalone typing
for all 12 native fixtures plus their helpers. Fresh discovery, old47 upgrade,
earlier regressions, eight-checkpoint seed and resume passed 8/9/145/97/8 stages.
The restart retained all53 private tables and owner histories. Eleven private-log
guard cases passed. All data, credentials, certificates and network peers were
synthetic; no real mailbox or provider was contacted.
