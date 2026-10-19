# Private mail storage contract (S1a)

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
```

Set `PEAR_UPGRADE_FROM_WASM` to an absolute path to the pre-S1 module to include
an additive upgrade probe. `PEAR_PROTECTED_MAIL_WASM` optionally selects the new
WASM; by default the script uses the normal module build output. The script
refuses non-local origins, userinfo and redirects, creates a uniquely named
database, uses synthetic credentials/content and deletes its fixture in
`finally`. It never connects to an IMAP server or model provider.

The Cloud conformance wrapper builds the pinned baseline and current module,
starts a disposable Docker server on a random loopback port and cleans it up.
It runs in PR checks. The coordinated release also runs the live harness against
its exact release WASM. Neither test establishes runtime admission, credential
isolation, full backup/restore support or host egress containment.
