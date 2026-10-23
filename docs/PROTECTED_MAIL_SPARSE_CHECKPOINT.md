# Sparse checkpoints over already-stored mail

S2b2c6 adds separate owner authority to checkpoint a bounded discovery range
containing present messages and observed gaps. Every present message must already
have its complete private S1 source, record and receipt. The checkpoint commits
only progress metadata. It neither reads a mailbox nor imports content.
Protected monitoring remains disabled.

This is a separate contract from [contiguous selection/ACK](PROTECTED_MAIL_CONNECTOR.md),
[one-use reads](PROTECTED_MAIL_READ.md), [prepared ingestion](PROTECTED_MAIL_INGESTION.md)
and [metadata discovery](PROTECTED_MAIL_DISCOVERY.md). Their grant scope and
existing table schemas are preserved. Observation-bound body reads and ingestion
remain separate work.

## Exact independent owner approval

`review_protected_mail_sparse_checkpoint` builds a stateless metadata preview.
Only the authenticated non-AI human owner can review, issue or revoke; publisher
and non-owner administrator identities have no approval override.
`issue_protected_mail_sparse_checkpoint` reconstructs the preview and compares the
expected connection epoch, snapshot and complete manifest digest. One immutable
grant exists per observation. Revocation is terminal; retries cannot renew it.

The source observation must be a successful retained NextWindow discovery with a
nonempty range of at most eight numeric UID slots. Bootstrap and empty-horizon
observations cannot initialize or advance a cursor here. Fresh review, issuance
and commit require the exact observation to remain the latest validated discovery
head, with the original cursor, epoch and configuration still current. A newer
observation is never silently substituted.

The completed observation is retained data. Original discovery expiry or
revocation does not erase it; a new checkpoint grant supplies independent owner
authority. The checkpoint inherits the observation's exact service, runtime/run,
account, configured folder and direction. Its own interval lasts at most one hour
from issuance. There is no delegation or automatic recurring approval.

For every observed-present UID, the server resolves the exact stored mailbox
tuple and validates the complete source/record/receipt association. It freezes
the source ID, revision, digest and measured byte cost in the owner-approved
manifest. Derived sources, foreign records, held-only dispositions, missing
records and later fetch failures cannot replace a present message.

Byte costs use the full length-prefixed S1 content digest preimage. They describe
already-stored data, not MIME size, network use or permission to disclose it.
The exact total must fit the owner ceiling and the 2 MiB hard bound. An all-absent
range has no sources, zero acknowledged bytes and a zero ceiling. All-present
and mixed ranges are also valid.

## Point-in-time absence

The server derives the present/absent partition from the validated immutable
observation. Callers cannot submit absence lists, source substitutions, UID ranges
or a last UID. Advancement ends at the observed clipped range boundary, including
trailing gaps; it never jumps to UIDNEXT or an arbitrary mailbox horizon.

At fresh review, issuance and commit, an observed-absent tuple must have no known
S1 receipt or prepared-ingestion disposition. A known message cannot be skipped
under an absence decision. These checks use bounded tuple lookups.

The retained disposition means that progress was approved using that observation
at that time. It is not a permanent assertion that the tuple can never exist in
storage. A later independently authorized trusted publisher append remains
permitted. That append does not change the old disposition, rewind progress or
grant processing authority. Historical validation never demands continuing
absence; doing so could invalidate an otherwise sound cursor chain after later
maintenance. No negative tuple tombstone or fabricated empty message is created.
Future runtime reconciliation/backfill needs its own explicit authority.

## One atomic local effect

`acknowledge_protected_mail_sparse_checkpoint(checkpoint_id, event_nonce)` accepts
only opaque IDs. The original still-eligible service must authenticate before
private-resource lookup. Fresh execution rechecks the grant, activation/expiry,
revocation, current owner/configuration/epoch, latest observation, exact cursor,
all frozen positive source associations/costs and fresh absent-slot collisions.

Only then does one transaction insert the immutable receipt and dedicated cursor
history and advance the same stable inbox cursor through the exact observed
range. The receipt records a closed UID-ordered partition of verified-present and
observed-absent slots. The operation writes no source, body, policy, inference
budget, discovery head, page, conversation or workflow state.

The receipt is the local once marker. No remote dispatch or credential release
occurs, so no separate dispatch claim is needed. Concurrent acknowledgments or
competing contiguous ACK/ingestion operations have one cursor winner. A publisher
append racing an absent-slot checkpoint has different semantics: append-first
denies the fresh checkpoint; checkpoint-first can be followed by the independently
authorized append without changing its historical result.

Exact completed replay checks its own retained grant/events, observation, positive
sources, receipt/history and immediate cursor predecessor. It returns identical
metadata after expiry, revocation, owner logout, connection deletion, later head
or cursor movement, and later independent staging of an absent tuple. It creates
no new history and never rewinds progress. A changed nonce conflicts. Fresh
currentness and absence checks are not repeated during historical validation.

## Closed third cursor family

Four additive private tables retain this contract:

- `protected_mail_sparse_checkpoint_grant`
- `protected_mail_sparse_checkpoint_grant_event`
- `protected_mail_sparse_checkpoint_receipt`
- `protected_mail_sparse_checkpoint_cursor_history`

All 53 earlier schemas remain unchanged, for 57 private tables in total. Upgrade
creates no grants, dispositions or cursor backfill. No public view, ordinary
subscription or JSON export projection is added. Privileged database/host
management remains part of the trusted computing base.

The shared cursor validator accepts exactly one of three closed history families
at each generation: original contiguous ACK, prepared ingestion, or sparse
checkpoint. Missing or multiple associations fail. Initial generation one still
comes from the original explicit NewOnly baseline. Each descriptor validates its
local retained associations and one immediate predecessor, with no unbounded or
recursive history walk. Existing historical ACK and ingestion retries retain
their behavior across interleaved families.

## Portable metadata and host helper

`ConnectorSparseCheckpointV1` binds the owner/workspace, exact mailbox and service,
epoch/configuration, original cursor, observation digest/head/range/partition,
complete present source references and costs, limits and times. Its closed JSON
uses recursive ASCII key order, literal Unicode and canonical decimal strings
for u64 values. The representation is bounded to 16 KiB and privately copied and
frozen before asynchronous hashing. Preparation authenticates no owner or mailbox
and supplies no execution or body-read authority.

`acknowledgeProtectedMailSparseCheckpoint` uses a fixed host-owned authority URL,
workspace and service token. Its only operation arguments are checkpoint ID and
nonce. It makes one request to the fixed procedure, rejects redirects, caps the
actual streamed response at 4 KiB and rejects unsafe numeric u64 values. A lost
reply remains unknown; an explicit identical retry can recover metadata without
advancing again. Fixed errors contain no raw server diagnostics or bodies.

## Validation and remaining gates

Synthetic native conformance covers sparse/all-absent/all-present windows, exact
source costs, currentness and late-append behavior, real competing commit paths,
three-family histories, private boundaries and lost-reply recovery. Populated
old53 upgrade and the ninth shared restart checkpoint retain previous state and
owner histories. The release gate independently builds thirteen historical
modules plus current and checks the exact release artifact. Fixture output uses
fixed stage codes and owned data/keys/checkpoints are cleaned up.

Local validation on October 21, 2026 passed 212 Rust, 140 Sentinel, 628 worker,
303 web and 31 release tests, both application typechecks, strict checks for all
thirteen native scripts and two fixture helpers, and twelve private-log guard
cases. Native validation passed 298 fixed stages: 12 fresh, 13 populated old53
upgrade, 154 historical regressions, 110 restart-seed and nine restart-recovery
stages. The same data and synthetic keys survived one controlled restart without
republishing. All nine checkpoints were consumed; the owned database, keys,
private logs and temporary TLS fixtures were removed. Independent implementation
and release-wiring reviews found no blocking issues.

Observation-bound sparse reads/ingestion, MIME sanitization/body adaptation,
trusted recurring workflow, production credential/network isolation, trusted UI
and protected backup/restore remain gates. No real mailbox, provider, deployment
or protected monitoring activation is part of this slice.
