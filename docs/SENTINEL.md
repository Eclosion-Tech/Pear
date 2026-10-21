# Sentinel implementation status

**Updated:** 2026-10-21

**Status:** S0 through S2b2c4 are merged. This branch adds
[bounded metadata-only discovery](PROTECTED_MAIL_DISCOVERY.md): separate owner
permission, a one-use metadata executor, atomic private observations and retained
UID continuity. Discovery does not fetch bodies or advance the inbox cursor.
MIME sanitization/body adaptation, sparse disposition, recurring workflow,
isolated credentials, trusted UI and host controls remain gates.
Protected monitoring stays disabled.

Sentinel will enforce authority and disclosure rules outside the model. Email,
webpages, workspace content, tool output, and derived summaries cannot grant
permissions. A compromised model may still produce false or harmful text;
containment must prevent its forbidden effects independently of detection.

## Implemented foundation

[`packages/sentinel`](../packages/sentinel/README.md) defines four fixed mail
operations, host-owned grants and exposure snapshots, strict runtime validation,
and a pure eligibility check. It binds the workspace, principal, runtime, run and
parent run, connection epoch, exact mailbox/folders, processor configuration,
private storage destination, expiry and resource ceilings. Every exposed source
revision and ancestor must permit the actual processor or storage destination.
Multiple revisions retain their separate restrictions. Missing or cyclic source
graphs fail closed.

There is no generic tool, URL, shell, send, share, or arbitrary page-write
operation. A screening result can hold processing but cannot authorize it.
Denials use fixed codes without echoing arguments or source identifiers.
Canonical SHA-256 operation fingerprints include exact action fields and the
host-computed payload digest. They do not authenticate authority or represent a
dispatch permit.

An eligible result explicitly requires a later durable admission. The package
does not authenticate snapshots, consume a budget, store an admission, prevent
replay, recheck live ACLs, or enforce network routing. Those remain separate
requirements. Model output must never provide host-owned policy state.

`prepareOperation` copies the operation and the complete serialized request
before the first asynchronous boundary, verifies its actual byte count and
digest, and retains a private payload buffer. Later edits to the proposal or
caller-owned buffer cannot change the held request. It returns a frozen request,
not an execution permit. Source-policy, grant, processor and epoch changes still
require fresh admission/dispatch checks; an unchanged action hash supplies no
evidence that current authority is unchanged. The separate read-plan release binds its concrete cursor/UID selection; actual
production connector integration and reviewed MIME/body processing remain gates; separate exact prepared-text admission is implemented in this branch.

The test-only containment driver records exact synthetic mailbox, classifier,
inference and private-storage effects. Its in-memory authority and one-use test
handles exercise policy and dispatch ordering. They are not production
interfaces or evidence of durable transactions, crash recovery, process
isolation, automatic exposure tracking or host network enforcement.

## Diagnostic privacy

The worker now uses fixed event codes, counts, numeric record IDs and opaque
instance labels in the covered paths. Full tool arguments/results, search
queries, fetch URLs, workspace/display labels, and raw error objects/stacks were
removed from these diagnostics:

| Paths | Covered behavior |
|---|---|
| `tools.ts`, `llm.ts` | Native-tool diagnostics and model tool-call logging |
| `conversation.ts` | Conversation tool loops, message flushes and turn/stream failure diagnostics |
| `composite-tool-executor.ts`, `mcp-tool-executor.ts`, `audit-logger.ts` | Dispatch/collision/snapshot/handshake failures and fixed audit outcome details |
| `database-worker.ts`, `ai-user-worker.ts`, `index.ts` | Workspace/AI worker lifecycle and global failure handlers |
| `attachments.ts`, `workspace-files.ts`, `subscriptions.ts` | Attachment/blob and subscription failure diagnostics |

This is not a worker-wide privacy guarantee. Notion import/fetch,
structural-sensor, standalone MCP HTTP/stdio, scribe, and operator provisioning
CLI diagnostics still need review before participating in a protected profile.
Functional private conversation traces and task failure outputs remain content
records; tool audit hashes remain identifiers rather than anonymized telemetry.
Their storage/read boundaries require later substrate enforcement. The current
audit writer's failure behavior is unchanged and is not a durable admission log.

## Private mail storage

[`mail/protected.rs`](../server/spacetimedb/src/mail/protected.rs) now keeps
collections, immutable sources, literal records and deduplication receipts in
four private tables. An authenticated human owner can read the two explicit
`my_protected_mail*` views, with the exact source reference, version, digest and
origin returned alongside content. Other humans, administrators, AI identities
(including authenticated human/AI hybrids), service identities and publisher
projections receive no owner-view rows. The publisher retains trusted raw-table
access as part of the platform's management authority.

Only the publisher can create a collection or append bounded typed plaintext.
The store derives ownership from a paused connection, matches the configured
folder/direction, fixes external-mail origin and computes content digests on
the server. Source, record and receipt commit together. Exact replay is a no-op;
changed content or another request key for the same mailbox UID tuple fails.
The importer's sanitization version is a declaration, not proof of redaction or
mailbox authenticity. No arbitrary source JSON, page components, processor
permissions or derived-source authority can be supplied.

A staged connection cannot re-enter legacy enable, lease, checkpoint, triage or
page-import paths. Disconnect removes its live credentials/connection while
retaining private records; new appends then fail. Existing legacy root pages,
mailbox labels, historical imports and sharing rules are unchanged. No private
message title, body or metadata is copied into those ordinary structures.

General worker subscriptions exclude the private owner views. Browser export
hydration now requests only the snapshot allowlist, and ordinary JSON snapshots
exclude private mail storage. Ordinary v1/v2 restore refuses even an empty
retained private collection after all pages have been purged; collection
creation also refuses an active v2 import session. Abort remains available.
A separate protected backup/restore contract is required before a canary.

S1b adds explicit publisher-initialized source ceilings, immutable policy
history and current generations. Owners and the trusted publisher can only
narrow or revoke an initialized ceiling. No policy is automatically inferred
for old sources, and missing policy denies processing. Initial ceiling metadata
does not establish human approval or execution authority.

Private context heads and frozen exposure snapshots retain the complete
registered source/history union. Derived text copies all frozen members into
immutable parent references; the server computes its digest and policy
intersection. Current restrictions on every ancestor remain applicable after
derivation, including revocation. No caller can replace ancestry with a model's
citations. These are host-registered declarations, not proof that every actual
prompt byte was observed; actual exposure instrumentation remains absent.
All new rows are private, with no new read projection or ordinary page fields.

[S1c reviewed instructions](PROTECTED_MAIL_INSTRUCTIONS.md) add private immutable
revisions, draft heads and approval/revocation history. Owner decisions bind
exact frozen text, scope/version and expected generation; edits clear approval,
and replay cannot reactivate an old decision. Publisher-staged drafts copy an
existing derivation's exact body and complete ancestry; manual edits cannot
remove known parents. A fresh manual paste has unknown provenance.

The explicit owner review view is excluded from broad worker subscriptions and
ordinary exports. Authentication identifies the owner credential, not physical
human presence or proof of display. No review UI or runtime consumer is added;
trusted UI/recipe authorization and protected runner integration remain gates.
Local summary admission and fixed inference admission separately check the exact
current instruction and its stored ancestry. An instruction
approval grants no disclosure or effect authority. Mutable prompts, page flags,
publisher configuration and conversation answers receive no automatic approval.
See the [storage contract and fixture commands](PROTECTED_MAIL_STORAGE.md).

## Staged authority state

[S2a authority records](PROTECTED_MAIL_AUTHORITY.md) add explicitly enrolled
connection epochs/tombstones and immutable processor revisions. Existing owner
pause, password and delete reducers invalidate enrolled epochs atomically;
exact public-key descriptor changes invalidate all live enrolled connections.
Repeated or reverted configuration cannot restore an older generation.
Publisher config declarations and terminal retirement use immutable history,
CAS and effect-free replay; they grant no processing permission.

The five new tables are private with no new view or runtime consumer. Ordinary
restore also rejects processor-only private state, and new profile configuration
cannot run during v2 import. The persistence fixture restarts a disk-backed
server and compares retained state without republishing it. Configuration
records alone establish no grant or dispatch authority. S2b2a consumes their
current epoch/snapshot for its local summary facet. Fixed inference admission
also binds the current registry revision and rechecks it before payload release;
provider transport remains a gate.

## Governed instruction inputs

[S2b1 instruction sources](PROTECTED_MAIL_INSTRUCTIONS.md) reuse exact immutable
instruction references and explicit source-policy enrollment. First enrollment
requires the current checked revision and eligible owner; historical exact
retries cannot reset ceilings. Edits retain an enrolled predecessor as a source
parent, including through intermediate unenrolled edits. Current ancestor
narrowing/revocation therefore remains binding. Missing policy denies processing;
source resolution and exposure bookkeeping do not grant instruction authority.

S2b1 adds no tables, views, grants, budgets or runtime consumer. S2b2a binds its
current approved revision, exact decision/head generation, current source
restrictions and the actual frozen local append payload. Retained historical
data and a publisher declaration cannot substitute for that check.

## Local summary admission

[S2b2a](PROTECTED_MAIL_ADMISSION.md) adds one fixed local effect: promote an
already-staged summary into a private committed pointer and receipt. The owner
freezes a bounded exact-artifact allowlist, current epoch/configuration,
instruction approval, service identity, expiry and limits. Every service run
and child uses the same grant budget. All new-effect checks, full envelope byte
debit and unique effect/receipt commit in one transaction.

The reducer reads the stored body and complete ancestry itself; callers supply
no body, processor, exposure set, digest, byte count, clean verdict or cursor.
The approved instruction must already occur in the frozen ancestry. Source
restrictions are rechecked at use, including the staged source's own policy.
Empty processor ceilings can permit this local storage effect without granting
inference. Once-per-stage identity excludes grant/run/nonce; only the exact
original authenticated completed request can replay without a new debit.

Six new tables are private, without a body view, ordinary export or automatic
subscription. No initial staging write, mailbox read, inference, external
dispatch or checkpoint is admitted here. The portable append codec shares the
server's canonical envelope/fingerprint contract; a prepared object remains
unauthenticated. No trusted review UI, broker or protected runner is activated.

## Fixed inference admission

[S2b2b1](PROTECTED_MAIL_INFERENCE.md) adds a separate owner-issued processing
grant over exact raw mail, the current approved instruction and an exact
current processor registry revision. The server constructs a closed Anthropic
Messages request, measures its full UTF-8 bytes, reserves one shared operation,
input-byte and maximum-output-token pool, and retains immutable references and
commitments without copying the outgoing body into the admission ledger.

A procedure rechecks current authority, policies and exact rebuilt bytes in a
transaction, commits the one-use dispatch state, then returns the payload only
to its bound broker. A duplicate claim never returns the body. Lost responses
remain consumed/uncertain; terminal outcomes contain no result content or raw
errors. The global work key survives replacement grants, runs, nonces, epochs,
reapproval and token-cap changes. This is a once-only release to a credentialed
service, not evidence of process isolation or exactly-once remote transmission.

Seven new tables remain private. A dedicated one-attempt HTTP driver strictly
decodes the pinned procedure result, bounds response bytes and rejects
redirects. No provider is called. Provider-response validation, trusted UI, isolated
credentials, real transport and IMAP/cursor authority remain later work.

## Restricted result acceptance

[S2b2b2](PROTECTED_MAIL_RESULTS.md) adds explicit owner authorization to store
one result of an exact consumed admission. Processing-only grants do not gain
storage permission. The broker supplies a closed bounded literal declaration;
the server supplies its complete input ancestry, current restrictions and fixed
format tag, then measures the whole canonical envelope. Source, policy,
receipt and terminal `response_received` state commit together.

Only a dispatching admission may accept new content. Unknown/failed/legacy
terminal outcomes cannot acquire a result later. Exact completed retries are
metadata-only no-ops; changed declarations/nonces conflict. No result is
promoted automatically, and no body view or ordinary snapshot is added.
Reported model/stop/token metadata do not prove provider execution or accuracy.
Three new tables remain private; the derived source uses the existing S1b
family with full current restrictions. Connector, reviewed UI and host gates
remain required before protected use.

## Exact connector selection and cursor acknowledgment

[S2b2c1](PROTECTED_MAIL_CONNECTOR.md) adds a stateless owner preview and immutable
owner-issued selection bound to the module, current connection epoch/snapshot,
exact configured folder, connector/runtime/run and cursor window. New-only
bootstrap is an explicit owner declaration. Stored batches contain at most
eight contiguous next UIDs; every S1 source/record/receipt must already exist
and match. Missing or substituted slots leave the entire cursor unchanged.

The cursor, immutable history and ACK receipt commit together. Exact completed
retries remain metadata-only after revocation or later cursor progress, while
fresh work rechecks current roles, authority and CAS. Five new tables are
private; deletion retains their history. Existing model, result and local
promotion grants/pools are unchanged. This acknowledges earlier storage,
without authorizing or proving the preceding read/import. Admitted ingestion,
missing/held dispositions, trusted workflow delegation/UI and wire/host checks
remain later gates. The legacy runner and paused-only fences stay intact.

## Coverage inventory and release gates

The [entry-point inventory and next storage design](SENTINEL_COVERAGE.md) map
the existing identities, read paths and effect paths to their remaining gates.

| Surface | Current implementation | Required before protected use |
|---|---|---|
| Fixed mail operations | Offline contracts, canonical mail codecs, atomic local promotion, inference/result admission and exact stored-mail cursor ACK | Trusted adapters, reviewed owner UI/recipe, provider transport/response validation and admitted mailbox ingestion |
| Source/exposure graph | Private source ceilings/current generations, cumulative registered exposure snapshots and immutable derived ancestry | Reviewed registration adapter, authenticated run binding, fresh admission/dispatch policy checks and complete actual exposure coverage |
| Mail destination/readers | Separate private tables and explicit owner views, excluded from ordinary page readers/caches/exports | Reviewed owner UI, safe connection migration and admitted runtime use; legacy mail pages remain legacy |
| Reviewed instructions | Private exact revisions, scoped owner decisions, edit-to-draft, governed inheritance and current approval bound to local promotion | Reviewed human UI/recipe and complete actual prompt/input instrumentation |
| Authority/dispatch | Retained epochs/configuration; owner grants/shared budgets, unique local effects, one-use inference payload claims, private result acceptance and exact cursor ACK | Isolated credentials/transport, provider response validation and full connector lifecycle |
| IMAP, model and classifier credentials | Existing worker custody unchanged | Isolated roles with minimal environment/mounts, authenticated RPC and host-enforced network policy |
| Mail settings/lifecycle | Existing monitor unchanged | Draft/test/preview/enable, frozen processor approval, authentication-message suppression, cancellation and accurate terminal/backoff states |
| Normal chat, APIs, MCP and output streams | Existing controls unchanged | Shared authorization across reads, writes, inference, responses, exports, notifications and sharing |
| Memory, compaction, delegation and schedules | Graph tested with synthetic derived records | Automatic exposure persistence and narrowed authority across resume/children |
| Public research, Bridge, harness and browsers | No Sentinel contract or integration | Separate reviewed effects, constrained execution and destination enforcement |

The first protected mail workflow will use a fixed private destination and no
ordinary assistant page grant. The assistant selector will reference a reviewed
model profile only. General assistants must not receive protected mail until
their outgoing paths are governed. Existing configurable IMAP support remains
available; this foundation does not upgrade it to the protected profile.

S0's fixed mail contracts, offline policy attacks, synthetic sinks and covered
logging regressions exercise the offline mail boundary. Application entry-point
closure and actual model/host attack evaluation remain later gates. Public
research stays at the design-contract stage until S8: current mail tests reject
search/fetch proposals rather than expanding the active mail operation union.
Do not interpret synthetic dispatch tests as network containment or classifier
accuracy results.

## Validation

- `pnpm --filter @eclosion-tech/sentinel test`: strict TypeScript check and
  synthetic policy/validation/fingerprint/preparation attacks and observed
  synthetic dispatches; no external services.
- `pnpm --filter @pear/worker test`: worker TypeScript check and full unit suite,
  including 18 diagnostic privacy regressions with synthetic secret markers.
- Locked Rust module tests/WASM build and regenerated web/worker bindings.
- `worker/scripts/protected-mail-e2e.ts`: disposable localhost SQL/subscription,
  additive upgrade, identity isolation, atomic replay/conflict, legacy fencing,
  fixed reader/export checks, logout/disconnect and ordinary-restore refusal.
- `worker/scripts/protected-mail-state-e2e.ts`: populated S1a upgrade, no policy
  backfill, current-ceiling narrowing/revocation, cumulative exposure and derived
  ancestry, replay and private protocol boundaries.
- `worker/scripts/protected-mail-instructions-e2e.ts`: populated S1b upgrade,
  private review/identity boundaries, exact decisions, edit/revoke/replay CAS,
  S2a upgrade, current-only source enrollment and inherited instruction ceilings,
  retained ancestry and export exclusions.
- `worker/scripts/protected-mail-authority-e2e.ts`: populated S1c upgrade,
  epoch/configuration edit–revert and replay, tombstones, processor-only restore
  fences, private protocol boundaries and controlled disk-backed restart.
- `worker/scripts/protected-mail-admission-e2e.ts`: exact-artifact local grants,
  complete append bytes, shared-budget/effect races, populated S2b1 upgrade and
  retained private receipts/budgets across restart.
- `worker/scripts/protected-mail-inference-e2e.ts`: exact current registry and
  full fixed request, one-use broker claims, lost replies, private boundaries,
  populated S2b2a upgrade and retained admitted/dispatching/unknown state.

- `worker/scripts/protected-mail-result-e2e.ts`: separately authorized bounded
  result storage, complete inherited restrictions, atomic races, populated old30
  upgrade and retained result/authorization history across restart.
- `worker/scripts/protected-mail-connector-e2e.ts`: exact owner preview/selection,
  explicit bootstrap, contiguous stored-source ACK/CAS, populated old33 upgrade,
  role/epoch/replay/privacy boundaries and retained cursor recovery.

Tests cover forged approvals, unknown effects, scope/epoch/time mismatches,
destination substitution, changed processors, malformed JSON-like objects,
resource limits, missing/cyclic source graphs, and restrictions preserved
through summaries, memory, compaction and child-context derivation. A real host
must still prove that it records every exposure and sends every effect through
the enforced boundary.

## One-use connector read-plan release

The [read-plan contract](PROTECTED_MAIL_READ.md) requires separate owner authority
over an exact existing StoredBatch selection. Four private tables enforce one
plan release and one full maximum raw-MIME reservation per selection. Neither
unknown outcomes nor terminal reports refund or reopen it. The fixed service
procedure rechecks current selection, cursor and authority before committing
Dispatching; no message needs to exist in S1 yet. The separate fixed executor tests bounded IMAP execution; prepared-text storage
now has independent admission. Actual MIME/body integration and the protected
runner remain later gates.

## Dormant bounded IMAP executor

The [fixed executor](PROTECTED_MAIL_EXECUTOR.md) claims once internally, checks
the exact credential association and uses one verified TLS session for a
read-only selected folder and bounded individual UID PEEKs. Raw octets stay
opaque and are discarded; success returns bounded private metadata only.
Malformed, missing or cap-sized partials fail the whole batch without cursor
progress. No runner or credential service invokes this host library. Synthetic
wire conformance is separate from production compatibility and S3 isolation.


## Exact prepared-text ingestion

The [ingestion contract](PROTECTED_MAIL_INGESTION.md) adds owner approval over
one exact payload, independent of existing read authority. A bound dispatching
read can commit imported S1 records, body-free held dispositions, the same
cursor head and its terminal declaration atomically. Full UTF-8 envelope bytes
are measured and committed; changed content cannot reuse the decision. The
new versioned receipt/history family preserves old ACK semantics and prevents
held slots from masquerading as imported sources. Missing, capped or uncertain
reads cannot advance progress. No source policy or processing grant is created.
The current executor, recurring runner and actual MIME sanitizer remain separate.


## Bounded metadata-only discovery

The [discovery contract](PROTECTED_MAIL_DISCOVERY.md) adds owner-approved
Bootstrap or next-window discovery, a separate fixed EXAMINE/UID SEARCH executor
and six private tables. The discovery head retains UIDVALIDITY and a monotonic
UIDNEXT horizon independently of the inbox cursor. Observations record no body,
create no baseline, grant no downstream authority and never advance that cursor.
Lost claim/report replies do not retry a mailbox session or expose local UID
metadata. All 47 earlier private schemas and contiguous selection/ingestion
contracts retain their scope; monitoring stays disabled.
