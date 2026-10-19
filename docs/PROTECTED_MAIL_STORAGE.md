# Private mail storage and provenance contract (S1a/S1b)

This is a staged substrate, disconnected from the existing mail runner and
settings UI. It does not enable protected monitoring or authorize a model call.
The broader [Sentinel status](SENTINEL.md) and [entry-point inventory](SENTINEL_COVERAGE.md)
describe the remaining gates. Existing page-based mail imports stay legacy.

## Authority and records

| Surface | Contract |
|---|---|
| `create_protected_mail_collection(connection_id)` | Publisher only; derives the owner from an existing paused connection. Authenticated human ownership is required, excluding publisher and either AI identity table. Collection creation refuses an active ordinary v2 restore |
| `append_protected_mail_message(connection_id, event_key, message)` | Publisher only; requires the same live, paused, human-owned connection and immutable collection binding. No runner calls this reducer yet |
| `protected_mail_collection`, `protected_mail_source`, `protected_mail_record`, `protected_mail_receipt` | Private backing tables; not generated client table surfaces, ordinary pages, workspace JSON exports or generic CRUD databases |
| `my_protected_mail_collections`, `my_protected_mail` | Explicit human owner views. No administrator/service override; AI and publisher identities receive no rows. Records include their source association, version, digest and origin |

The publisher can read private backing tables through trusted management SQL.
The view restriction does not constrain that platform authority. A human using
the publisher identity cannot use the owner views; a separate owner identity is
required. No new MCP, native tool, generic API mapping or automatic client
subscription exposes these views.

The input consists of folder, UIDVALIDITY, UID, received/sent direction, message
date, From/To/Cc, subject, literal body/note and a sanitization version. Fields
are bounded in UTF-8 bytes; metadata rejects controls and body/note permit only
line/tab controls. Folder and direction must match the connection configuration.
There are no attachments, raw MIME, arbitrary JSON, executable components,
caller-selected owners, page IDs, grants or processor permissions.

Content digests use versioned length-delimited fields. The server fixes origin
to `external_mail` and initial revision to `1`, and commits source, record and
receipt atomically. Supplied event keys are scoped to the collection; a second
server-derived key binds connection/folder/UIDVALIDITY/UID. Identical replay is
a no-op. Changed bytes, changed source version or a new event key for the same
mailbox event is a conflict. Missing or inconsistent associations are not
projected by owner views. Digests are sensitive identifiers, not anonymization.

The importer remains trusted to supply truthful mailbox and sanitization
declarations. These checks do not prove that content came from IMAP or that all
secrets were removed. Sanitization, derived summaries and model disclosure need
their later reviewed adapters and admission rules.

## Source ceilings and current generations

S1b adds private source-policy history and current heads. Policy initialization
is an explicit publisher management operation against an exact existing source
reference. It accepts bounded exact processor tuples and derives the only
permitted storage destination from the stored collection and human owner.
It cannot change source origin, ownership, content, ancestry or sanitization.
Existing S1a rows receive no automatic policy backfill; missing policy denies
governed processing and derivation while existing human-owner history reads
remain available.

An initial ceiling is a trusted management declaration, **not human approval,
a workflow grant or an admission**. Independent reviewed workflow authority
must still permit an operation. There is no runtime consumer of this policy.
Initial configuration is immutable: exact initialization retry cannot restore
an older current head. The authenticated human owner or publisher may narrow
the current processors/storage or revoke the source using its expected
generation. Non-owner administrators and either AI identity representation
have no override. Revocation cannot be undone and retained disconnected
history can still be narrowed or revoked.

Processor identity includes the exact profile, configuration revision, HTTPS
endpoint and model. A rotated key/configuration revision or another endpoint
is not interchangeable with an old tuple. Expanding a historical ceiling will
need a separately reviewed authorization design; a new grant alone cannot
silently expand it. Current policy is re-resolved across every ancestor when
creating a derived record. Old exposure snapshots never preserve obsolete
permissions. Generations and policy identifiers are private security records,
not ordinary telemetry.

## Registered exposure and derived records

Publisher-only staging reducers register source references under a private
collection/runtime/run context. Runtime and run strings describe host scope;
they do not authenticate a runtime or establish run authority. Each immutable
exposure snapshot contains the preceding context membership union new sources
and inherited snapshots. The server canonicalizes complete references and
their ancestor closure. There is no replace/remove operation or truncation.
A new event with a stale expected generation fails; exact replay of an old event
never rewinds the context head. Terminal context blocking prevents reuse after uncertain input.
An empty exposure record authorizes nothing and cannot support a derivation.

Source identity is the complete ID/revision/digest tuple. Canonical ordering
uses UTF-8 IDs and numeric revisions, not digest-only deduplication. SDK `u64`
values are big integers; future portable adapters must use canonical decimal
strings without rounding through JavaScript `Number`.

These are **durable host-registered exposures**, not automatic observation or
proof of complete prompt assembly. A future adapter must register every input
before disclosure, including prior history, errors, memory and child results.
If unregistered content may already have reached a context, it must block that
context. Registration is bookkeeping and may retain references whose current
policy is missing or revoked; forgetting a restrictive exposure would be unsafe.

A staged derivation is bounded literal text stored privately. Its complete
parent set comes from a frozen exposure snapshot belonging to the exact
context, rather than caller-selected citations. The server computes its
content digest and initial policy intersection atomically. Missing/revoked
ancestor policy or denied owner storage prevents a new derivation. Later
narrowing of any ancestor also narrows every descendant's effective ceiling.
A delayed result stays bound to its original input snapshot, and a blocked
context cannot use an older snapshot to write a new result.

Snapshots, references and digests are identifiers, never bearer capabilities.
References and context IDs are database-local; future admission must also bind
the authenticated workspace and transport.
The original S1a digest identifies its typed mail representation, not exact
model request bytes. A derived digest identifies stored text, not proof that a
model produced it. No model or screening service runs here; the publisher is
still trusted to describe the inputs and output truthfully. All new metadata
and derived content remain in private tables, without a new owner view, model
reader, native/MCP tool, CRUD mapping or ordinary page projection.

## Lifecycle and retention

Creating a collection fences the existing page-writing sync path for that
connection. Re-enabling or claiming it through legacy reducers fails; old
leases cannot import, checkpoint or authorize triage. No existing page or
historical grant is silently removed or relabeled protected. This staging API
is not the future settings migration/enable flow.

Disconnect preserves private records and owner reads, while appending requires
the live connection and therefore fails after deletion. Existing workspace JSON
exports omit this store, and export hydration requests only exportable tables.
Ordinary v1/v2 restore refuses a workspace containing any private collection,
including one with no records and no ordinary pages. Chunk and commit paths
recheck this condition; ordinary v2 abort remains available. A dedicated
protected backup/restore path is required before real-mail activation.

## Disposable verification

Build with the pinned toolchain and regenerate both public clients from the
same WASM. Start an in-memory SpacetimeDB 2.0.3 server bound to localhost, then:

```sh
cd worker
node --import tsx/esm scripts/protected-mail-e2e.ts http://127.0.0.1:3099
node --import tsx/esm scripts/protected-mail-state-e2e.ts http://127.0.0.1:3099
```

Set `PEAR_UPGRADE_FROM_WASM` to an absolute path to the pre-S1 module to include
an additive upgrade probe. `PEAR_PROTECTED_MAIL_WASM` optionally selects the new
WASM; by default the script uses the normal module build output. The script
refuses non-local origins, userinfo and redirects, creates a uniquely named
database, uses synthetic credentials/content and deletes its fixture in
`finally`. It never connects to an IMAP server or model provider.

For the state harness, set `PEAR_SOURCE_STATE_BASELINE_WASM` to an absolute
path to the merged S1a module. It populates private records before upgrading,
then checks unchanged source identities and owner reads, absent automatic
policy, policy narrowing/revocation, cumulative exposures and derivation.

The Cloud conformance wrapper builds pinned pre-S1a and S1a baselines plus the
current module in independent Cargo target directories, rejects identical
upgrade artifacts,
starts a disposable Docker server on a random loopback port and cleans it up.
It runs in PR checks. The coordinated release also runs the live harness against
its exact release WASM. Neither test establishes runtime admission, credential
isolation, full backup/restore support or host egress containment.
