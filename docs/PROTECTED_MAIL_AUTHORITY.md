# Retained mail authority state (S2a)

This staged store supplies connection epochs and immutable processor revisions
for later admission. It creates no workflow grant, shared budget, admission or
dispatch permission. It is disconnected from the runner, prompt assembly and
settings UI; protected monitoring remains disabled. See [Sentinel status](SENTINEL.md),
the [source contract](PROTECTED_MAIL_STORAGE.md) and
[instruction decisions](PROTECTED_MAIL_INSTRUCTIONS.md).

## Connection epochs

`initialize_protected_mail_connection_authority` explicitly enrolls an existing
private collection. Only the publisher may initialize it, and the first record
requires the same live paused connection, exact collection owner, authenticated
non-AI human ownership and a valid credential envelope/current key association.
There is no automatic enrollment or repair of old state.

The private current head and immutable history bind the connection, collection,
owner, monotonic epoch and a versioned configuration commitment. The commitment
includes host, port, username, Inbox/Sent folders, backfill, enabled state,
encrypted credential and exact public-key descriptor bytes. It excludes legacy
page/AI selection, display label, sync status, leases and counters. Those legacy
fields do not select the protected processor or private destination.

The existing owner pause, password update and delete reducers advance enrolled
state in the same database transaction. Repeated pause and identical password
writes still advance the epoch. Changing a password and reverting its bytes
cannot restore the old epoch, even if the configuration digest matches again.
Accepted public-key descriptor changes likewise advance every live enrolled
head atomically; an identical descriptor publication is a no-op. The existing
restriction on changing the key ID while mailboxes exist remains in force.

Each hook verifies the retained owner/history association and exact old live
snapshot before updating. A failed check or epoch overflow rolls back the
original mutation too. Deletion leaves a terminal tombstone and immutable
history. Initialization retry cannot reset a later epoch or revive a tombstone.
Unenrolled and legacy connections receive no new state automatically.

These safety mutations retain their existing owner authorization, including
pause after logout. Future admission must independently recheck current owner
eligibility, live connection state and configuration. An initialization replay,
matching epoch or matching digest is not that check. Envelope validation does
not prove that a credential decrypts or can authenticate to IMAP.

## Frozen processor revisions

Publisher-only `configure_protected_mail_processor` records a closed version-1
configuration: a versioned Anthropic Messages or OpenAI Chat Completions adapter,
exact canonical HTTPS request URL, model and opaque credential handle/version.
URLs reject userinfo, query, fragment and noncanonical serialization. Bounded
opaque identifiers and fixed error codes avoid arbitrary configuration JSON.

Every new configure event creates an immutable revision and advances the
expected head generation, even for identical configuration. Changing a
credential version and reverting it cannot restore a prior revision identity.
The content digest binds every configuration field; the revision ID also binds
the profile and generation. The exact source-policy processor tuple is profile
ID, revision ID, endpoint and model. Rotating configuration cannot silently
widen an old source ceiling.

Configure and retire share an event namespace. Exact historical retries are
effect-free and cannot rewind the current head. Changed event arguments
conflict; concurrent proposals for one expected generation have one winner.
`retire_protected_mail_processor` advances the generation, retains the last
configuration/history and terminally retires the profile. A replacement needs
a new profile identity. Future admission must reject retired or non-current
revisions rather than trusting a caller-supplied configuration snapshot.

Identifiers are database-local. A future broker must authenticate the workspace
and credential namespace; IDs and digests are not bearer capabilities.
Credential references are trusted host declarations, not proof that a vault,
matching secret or broker exists. These reducers read no generic AI settings,
environment keys or fallback provider. They make no network request and do not
implement the named adapters. Configuration is not human approval, a source
ceiling, workflow authority or permission to disclose mail to that processor.

## Isolation, restore and remaining gates

All five backing tables are private. There is no new public read projection,
ordinary page field, generic API mapping or automatic worker subscription.
Ordinary workspace exports exclude these records. The publisher retains raw
management access as part of the trusted platform boundary. Configuration
digests and opaque identifiers remain sensitive metadata, not anonymization.

Ordinary v1/v2 restore rejects a retained private collection **or any protected
processor head**, including a retired profile with no mailbox collection.
New processor configuration and active v2 restore are mutually exclusive;
effect-free historical replay and restore abort remain available. A separate
protected backup/restore contract is still required before canary use.

The [local summary admission slice](PROTECTED_MAIL_ADMISSION.md) binds current
epochs/configuration, owner-issued grants, shared budgets, the exact frozen
append envelope, source restrictions and instruction decision generations in
one transaction. It admits no mailbox or provider effect. Governed instruction
source registration must preserve ceilings across edits: a new revision
cannot escape an older enrolled revision's restrictions. The later
[S2b1 adapter](PROTECTED_MAIL_INSTRUCTIONS.md) supplies that inheritance. S2a
itself adds no instruction adapter or approval semantics.
Credential brokers, dispatch claims, transport/egress enforcement, a reviewed
human interface and protected activation remain later gates. The existing
PostgreSQL answer ledger is unchanged.

## Disposable verification

Build and regenerate both clients from the same release WASM. Against a
task-owned disk-backed localhost SpacetimeDB 2.0.3 server:

```sh
cd worker
export PEAR_PROTECTED_MAIL_RETAIN_UNTIL_SERVER_CLEANUP=1
node --import tsx/esm scripts/protected-mail-authority-e2e.ts http://127.0.0.1:3099
```

`PEAR_PROTECTED_MAIL_WASM` selects the current artifact.
`PEAR_AUTHORITY_BASELINE_WASM` optionally seeds populated merged-S1c state before
upgrading. The fixture uses synthetic credentials/content and verifies private
protocol boundaries, no automatic backfill, epoch/configuration edit–revert,
CAS/replay, tombstones, restore exclusions and unchanged owner history.

For restart verification, set `PEAR_AUTHORITY_RESTART_PHASE=seed` and
`PEAR_AUTHORITY_RESTART_STATE_FILE` to a new file inside a task-owned private
temporary directory. The fixture writes a bounded exclusive mode-0600 checkpoint
containing only its synthetic identities and expected state, then disconnects
and retains that database. Restart the owned disk-backed server with the same
data, keys and origin, then run with phase `resume` and the same checkpoint.
Resume publishes nothing: it compares retained private state and owner views,
checks inert historical replays and removes its checkpoint in cleanup.

The retention flag is only for a controller that owns and removes the entire
disposable server and its storage. Fixtures drain their native `st_client` rows
before intentional shutdown, then retain uniquely named synthetic databases
until that removal. This avoids an observed pinned-2.0.3 database-DELETE
shutdown panic; SDK disconnect is asynchronous and is not a server-side barrier.
Unexpected exits and drain timeouts still fail the gate. The controller must
remove owned data and anonymous volumes and surface cleanup failures. Without
the flag, normal fixtures attempt database DELETE after draining; that mode is
not the disk-backed lifecycle being certified here.

Cloud PR CI builds pinned pre-S1a, S1a, S1b, S1c, S2a and current modules independently,
rejects current/baseline identity, runs all four mail harnesses and restarts its
disposable disk-backed Docker server for the seed/resume check. The release
also runs fresh authority conformance against its exact release WASM. A clean
restart establishes this persistence check; it does not establish crash-safe
admission, external exactly-once delivery or host containment.
