# Protected-mail owner read surface (design)

**Status:** design for review; nothing here is implemented. This is the
Pear-side gate that the Trellis record-view council placed in front of any
mailbox becoming a Trellis component data source (council record R5). It
amends the [storage contract](PROTECTED_MAIL_STORAGE.md) and the coverage
inventory, and adds no monitoring, model, connector, cursor, discovery or
workflow authority. Protected monitoring stays disabled, and nothing produces
protected records in production today.

## Why a new surface

Owners read original mail only through the two owner views. `my_protected_mail`
takes no parameters and returns every record the owner has, each with `body` and
`note`, in owner-index order, with no limit or window. A component that
subscribed to it would stream whole mailboxes into the browser on mount and
could bind bodies to arbitrary display slots. Receipts, which hold the canonical
`mailbox_event_id`, are private; no owner surface shows them. The one existing
owner procedure that returns mail-derived content, `read_protected_mail_result`,
returns accepted derived text, not original mail. The storage contract forbids
any new automatic client subscription over these views.

A Trellis component needs the opposite: a bounded, body-free window that the
owner asks for from code-rendered chrome, a separate body read for one record
after another gesture, and an explicit `denied` distinct from an empty mailbox.

## Surfaces

| Surface | Contract |
|---|---|
| `query_protected_mail_window(request)` procedure | Owner only. Resolves the caller's own active binding for one component source, then returns at most 200 body-free summary rows of that collection, newest first, below an optional `(imported_at, id)` boundary, with `complete` |
| `read_protected_mail_summary(collection_id, record_id)` procedure | Owner only. Returns one body-free summary row by its durable reference |
| `read_protected_mail_body(collection_id, record_id)` procedure | Owner only. Returns one record's bounded `body` and `note` with its summary fields by its durable reference |
| `bind_protected_mail_component_source(component_id, source, collection_id)` and `unbind_protected_mail_component_source(component_id, source)` reducers | The collection owner, with read access on the page. Each owner has at most one active binding per component source; nobody can replace or remove another owner's binding |
| `protected_mail_component_binding` table | Private, append-only lifecycle: component node and its page, source name, owner, collection, declaration digest, monotonic epoch, status `active` or `revoked`, timestamps |
| `my_protected_mail_component_bindings` view | Owner only, no mail content: component node, source, collection id, epoch, status |
| `protected_mail_window_index` table | Private. One row per protected record: collection id, inverted `imported_at` key and record id, written in the record's transaction. Serves newest-first windows in time proportional to the page without touching record bodies |

There is no view over mail content, no change signal and no subscription. The
binding view is an explicit owner view in the sense of the storage contract,
like `my_protected_mail_collections`, and carries no message data.

### Summary rows

Each row carries `id`, `collection_id`, `mailbox_event_id`, `uid_validity`,
`uid`, `folder`, `direction`, `message_date`, `from`, `to`, `cc`, `subject`,
`imported_at`, `source_id`, `source_revision`, `digest`,
`sanitization_version`, `origin` and `has_note`. It never carries `body` or
`note`. A row is projected only when collection, source, record and receipt
agree, exactly as `my_protected_mail` does today ("Missing or inconsistent
associations are not projected"). `mailbox_event_id` is the receipt's canonical
connection/folder/UIDVALIDITY/UID identity; `id` stays
`{collection_id}:{event_key}`.

### Window request and caps

```ts
{ formatVersion: 1, componentId, source, limit, before?: { importedAt, id } }
```

`limit` is 1 to 200 and is required. Rows are ordered by `imported_at`
descending, then `id` ascending in UTF-8 byte order, which is the order the
window index yields. `imported_at` and `before.importedAt` travel as decimal
integer microseconds in a string under the full-u64 rule, and the client returns
the value unchanged; a Trellis `date` field is derived from it for display only,
never used as a boundary. `before` is an exclusive boundary on that pair: a row
is returned when its `imported_at` is older than `before.importedAt`, or equal
with a larger `id`. A `before.importedAt` outside `0..=i64::MAX`, or a malformed
`id`, is rejected with the fixed malformed-request error. Batch ingestion
commits several records with one transaction timestamp, so a timestamp-only
boundary would skip the rest of a batch; the pair boundary cannot. `complete` is
true when no older qualifying row remains: after `limit` rows the procedure
looks ahead for one more admissible row, under the same index-row and
association checks as every returned row, and reports `complete: false` only if
it finds one, so a window is never followed by an empty page. The response is
capped at 1 MiB measured on its JSON encoding with worst-case escaping, the
larger of the two transports; a window that would exceed it returns fewer rows,
at least one, with `complete: false`, and the client continues from the last
row. A worst-case row is about 16 KiB, so every call makes progress. `before` is
a plain pair of values the client already holds, not a cursor token, and there
is no offset, filter, search or sort choice. The response repeats the binding
epoch and collection id it resolved.

Implementation serves windows from a private window index instead of scanning
records. `protected_mail_window_index` holds one row per protected record, keyed
by the record `id` as its primary key so a row can never be duplicated and a
backfill rerun skips what exists: `record_id`, `collection_id`, and an inverted
sort key (`u64::MAX` minus `imported_at` in microseconds), with a BTree index on
`(collection_id, inverted_key, record_id)`. The row is written next to the
record insert in `insert_ingested_mail`, the single function through which both
`append_protected_mail_message` and the ingestion path create records, so no
writer can skip it. The pinned SpacetimeDB iterates an index range forward only,
and forward over the inverted key is newest first with ids ascending inside an
equal key; a page is the range `(collection_id, inverted(before.importedAt),
(Excluded(before.id), Unbounded))` followed by `(collection_id,
(Excluded(inverted(before.importedAt)), Unbounded))`, which needs no arithmetic
and cannot overflow, or the whole collection prefix for the first page. For each
index row the procedure fetches the record by primary key and admits it only
when the record's collection matches the index row, its `imported_at` reproduces
the inverted key, and its collection, source and receipt agree; a row failing
any check is skipped, never counted and never reported as an error, so a window
is short only when the collection is, and a mis-keyed index row can never place
a record in another collection's window. Iteration stops after `limit` admitted
rows plus the one-row look-ahead, or at the byte cap. Cost is proportional to
the candidates examined: the admitted rows, the look-ahead row, any rows
rejected by the checks and any rows trimmed by the byte cap, never to the size
of the mailbox. Only those candidates are deserialized, which matters because
every record row carries a body of up to 160 KB. Index rows for records that
exist when the table is introduced come from a publisher-only backfill
management reducer gated like the existing management operations: it skips
records whose row exists with identical values, fails on a row that exists with
different values, and so is a no-op when rerun; nothing produces protected
records in production today, so in practice the backfill touches only fixtures.
The byte cap drops the oldest returned rows, never below one, and clears
`complete`.

`message_date` is stored free text, an ISO-8601 instant when the MIME custody
could parse a Date header and otherwise empty. The server neither parses nor
sorts by it. A client derives a UTC civil date for a Trellis `date` field when
the text parses and leaves the field empty otherwise.

### Authority and errors

All three procedures and both reducers require the authenticated human owner:
the `human()` rule of the admission module together with the fail-closed module
metadata check that `authenticated_owner` already applies to the views. Owner
means owner of the collection; for the window procedure it also means owner of
the binding, which the server resolves itself from `(component_id, source,
sender)`. The client never supplies a collection id to the window procedure, so
no owner-authenticated code can read an owned collection through a component
without a binding; the binding is the only path from a component to a window.
The window procedure also requires the caller's current read access to the
page at call time and folds a failure into `protected_mail_binding_required`,
so an owner who lost access to a page learns nothing about its components.

Errors are fixed strings. `protected_mail_owner_required` covers every caller
that is not an authenticated human owner and, before ownership is proven, every
missing, malformed or foreign id, so existence is not disclosed; the publisher,
both AI identity tables, service identities, unauthenticated users and
non-owner administrators all receive it. `protected_mail_binding_required`
tells an owner that they hold no active binding for that component source,
which is their own state. `protected_mail_inconsistent_state` is returned only
after ownership is proven, for an owned record whose association does not
agree, mirroring `read_protected_mail_result`. An owned collection with no
matching record returns `Ok` with zero rows and `complete: true`; the client
renders that as empty, never as denied.

Procedures run on the owner's own authenticated connection through the
generated bindings. Anyone holding an owner token is the owner for this
purpose; the worker, services and brokers hold none. A CI code-search guard,
like the existing native-log guards, fails if worker, host service, MCP tool,
native tool registry or `packages/trellis-ui` code references these procedure
names. Trusted publisher management SQL over the
private tables is unchanged and is not part of this surface.

### Binding lifecycle

A binding row is created by the owner, who needs current read access to the
page, for one component node on one page, one source name and one of their own
collections. It records the SHA-256 digest of the canonical source declaration
(label, fields, mode and connection) at binding time. Binding when an active row
exists revokes it and inserts a new row with the next epoch; unbinding revokes
the active row. Rows are never deleted, so an epoch never recurs. Only the row's
owner can unbind it; page access of any level grants nothing over another
owner's binding.

Revocation is written in the mutating transaction, not discovered later.
`commit_trellis_panel` revokes every active binding of a node whose source
declaration digest changes. Every path that removes or replaces nodes revokes
the bindings of the removed node and of all its descendants: `delete_component`,
the replace paths of `replace_page_doc` and `update_page_blocks`, `delete_page`
for the page's own nodes, `delete_page_subtree` for those and the nodes of every
descendant page it trashes, and `restore_page_to_snapshot`, which purges nodes.
A restored node or page therefore returns without bindings. Cross-page moves are
refused by `move_component` ("Cross-surface moves are not allowed"), and a
reorder within a page changes neither the node nor its declaration and does not
revoke. An edit that is reverted before the next read still revokes, because the
edit itself did. As a second check, the window procedure refuses a binding
unless the node, every ancestor node and the page are live and undeleted and the
current declaration digest matches. Any change of the source declaration,
whether through `commit_trellis_panel`, `update_component` or a template,
therefore ends the binding, and the owner must bind again from chrome.

Collection creation, monitoring, connector grants, instruction approvals and
inference admissions grant nothing here, and a binding grants nothing to them.
Enabling monitoring alone never approves this surface.

## Reusable window primitive

The window index and its routine are written so that they can be extracted for
other large record sets: the module takes a table handle, a scope value, an
optional `(key, id)` boundary, a limit, a byte budget and a per-row
fetch-and-check callback, and nothing in it names mail. The sort key is a `u64`
the source defines, stored inverted so that forward iteration is descending,
with the record id as tie-break. This design uses only insertion; protected
records are never updated or deleted, so no re-key or removal helper is
specified here.

What may be shared is the mechanism; tables are not. Each domain keeps its own
index table with its own visibility and backup policy:
`protected_mail_window_index` is private and outside ordinary export like every
protected table, while a future index over ordinary database rows would be an
ordinary table under the snapshot policy. Mixing them would place protected
metadata in a structure that ordinary export, restore and readers touch, which
the coverage inventory forbids. Reuse for ordinary Pear databases, the
server-side windowing the record-view plan cut from its first version, is not
part of this design; it needs its own review, which would also decide the
host-level request and response contract. Trellis core's query request stays
unchanged.

## Every read is an owner gesture in code-rendered chrome

Trust surfaces render from code, never from component trees (the Pear Cloud
document `docs/PEAR_EXPRESSIVE_SURFACES.md`). The host therefore owns every
call, issued through the owner's live SpacetimeDB connection, which the
component data hook does not hold today and must be given:

- A component may declare `connection: { adapter: "pear.protected_mail" }` and
  nothing else: no collection id and no credential. The declaration is inert.
  `commit_trellis_panel`, templates, `update_component` and chat can at most
  say that a source is protected mail; none of them can choose a mailbox. The
  council reads R5's "protected connection" as this mailbox binding; the inert
  declaration grants nothing and is harmless to copy.
- Binding happens in the host's code-rendered panel menu, beside "Open source":
  "Connect protected mailbox…" lists the owner's collections, labelled from the
  owner's own `mail_connection` row when it still exists and otherwise by
  collection id and creation time, and calls the binding reducer after an
  inline confirmation.
- Mounting a component never reads mail. The panel frame renders a code-chrome
  "Show mail" control for a bound source; the owner's click issues the first
  window call of this browser session for that binding. The window is then held
  in session memory (see below), so leaving and returning to the page within the
  session renders the held window again, labelled with its `asOf` time, without
  a call. "Refresh" repeats the call, "Older" moves the boundary, and "Newest"
  returns to the top. A new session, logout, an access or principal change, or a
  rebinding starts over with "Show mail". No timer, head signal, scroll or
  component action issues a call, and nothing marks a window fresh
  automatically.
- Viewers without an active binding of their own, owner or not, see
  `unavailable` with "Connect a protected mailbox from the panel menu". Each
  viewer sees only their own mailbox or none; a page never shows one owner's
  mail to another viewer, and no procedure is called for a viewer without a
  binding, so nothing about other bindings is disclosed. `denied` is reserved
  for the owner's own calls that the server refuses, for example after logout
  or an identity change, and is distinct from an empty window.
- Opening a row runs the existing `open` action into the host's code-rendered
  record panel. The panel shows the summary row the session already holds and
  two chrome controls: "Show summary" calls `read_protected_mail_summary` when
  the row is not held, for example after a history restore or a durable link,
  and "Show message" calls `read_protected_mail_body`. The panel calls either
  only when the record's collection prefix is one of the viewer's own
  collections in `my_protected_mail_collections`; otherwise it shows
  `unavailable` without a call. Both procedures reject a `record_id` whose
  prefix is not the given `collection_id` with `protected_mail_owner_required`.
  The adapter's `read` never calls a procedure; it answers from the held window
  or returns `unavailable`. The body is never bound to a component slot and
  never fetched on open, restore or mount.
- Protected sources are never registered in the host source registry that
  feeds Pulp page repeaters, which query on mount with caller-chosen filters;
  `show_page_panel` and the chat panel renderer refuse any component holding a
  protected source; and saving the component as a template, publishing it to
  the repository, workspace writes and creates refuse it too.

## Component rules in Trellis and the Rust mirror

`pear.protected_mail` becomes a third `ComponentConnection` member in
`@eclosion-tech/trellis` and in `authored_component_state.rs`, with the same
rules in both validators and in the parity script:

- `mode` must be `query`. Declared fields may use only the summary field names,
  typed `string`, or `date` for `message_date` and `imported_at`. `body` and
  `note` cannot be declared.
- No binding may target the protected source in this version: a scalar `text`
  binding reads from a snapshot that a query-mode source never fills, so it
  could not show the held window anyway. Rows render only through list nodes
  such as `DataTable` and `RecordList` over the source. Every other binding in
  a component that holds a protected source, over any source, may target only
  the literal `text` display property, with no `value`, `checked` or write-back
  target; the no-write rule is component-wide, as R5 requires.
- A component holding a protected source declares no other connected source:
  no `pear.database` and no `external.json` beside it, so no second adapter or
  outbound request shares a document with mail rows.
- The only action of any kind in a component that holds a protected source is
  `open` over that source, without a `layout`; the detail view is always the
  host's code-rendered panel. No `source` (record write), `create`, `refresh`
  or `local` action exists in such a component, so no event input can carry
  mail data into the shared component document.
- Nodes over the source may not set `filter`, `sort` or `range` props. The
  adapter accepts a query request only when `filter`, `range` and `sort` are
  empty and `limit` is at most 200; anything else returns `unavailable` with a
  fixed message rather than a silently narrowed window, so `complete` is never
  false in the wrong direction. Components therefore render the window the
  host chrome loaded; `CalendarGrid` is not useful over this source and the
  rule makes that explicit.

## Identity, staleness and durable references

The durable reference of a message is `workspace + collection_id + record_id`,
with `record_id` equal to `{collection_id}:{event_key}`. It resolves through
the summary and body procedures for its owner regardless of any component or
binding, and it stays readable after disconnect under the storage contract.
Absence from a window is not deletion.

The transient panel reference adds component node, source name and binding
epoch as presentation guards only. `connectionIdentity` of
`{ adapter: "pear.protected_mail" }` is constant, so the host adds the binding
epoch and the session's read authorization to the request generation inputs of
`useComponentData`, which today cover page access, principal and schema inputs
(credential changes recreate the external adapter rather than advancing the
generation). A response issued under an older epoch, after logout, after a
principal change or after an access change is rejected before caching or
rendering; rebinding closes an open panel. Held windows are session memory
only, keyed by principal, component node, source, collection id and binding
epoch. A held window is rendered only while the owner's binding view shows that
epoch `active`, and it is purged when the epoch is revoked, on logout, on access
loss or on a principal change.

## UIDVALIDITY resets, duplicates and expunge

Protected records are never updated or deleted. `mailbox_event_id` hashes
UIDVALIDITY, so after a mailbox reset the same message imported again receives
a new identity and both rows remain. Summaries expose `uid_validity` so a client
can label or group them; the server performs no deduplication. Messages expunged
from the mailbox remain in storage and in summaries; there is no tombstone and
no removal. These are documented properties of the surface, not defects.

## What stays forbidden

No view or subscription over mail content. No MCP, native tool, CRUD mapping,
generic API, ordinary page, repeater, search or conversation projection. No
model, AI identity, service or non-owner read through this surface. No mail
action (reply, move, flag), write, draft, cursor advance, discovery, monitoring
or connector effect. No cursor token, offset, persisted cache, server-side
filter, search or sort in this version. Legacy mail pages are not a Trellis
source.

## Amendments

The [storage contract](PROTECTED_MAIL_STORAGE.md) lists the new surfaces and
states that an owner may read bounded, body-free windows and one record at a
time through these procedures, on their own authenticated connection, after an
explicit gesture in code-rendered chrome; its sentence that no new MCP, native
tool, generic API mapping or automatic client subscription exposes the views
stays true. The coverage inventory's rule that every protected read needs a run,
a grant and a recorded exposure is qualified to governed reads: an owner's own
historical reads through the explicit owner views and these procedures are
outside it, as the views already were, and disclose nothing beyond the owner's
own records. When implemented, `snapshot_tables_v2.json` omits the private
binding and window index tables, as it omits every private table, and lists
`my_protected_mail_component_bindings` under `exclude` beside the existing owner
views; `worker/src/subscriptions.ts` already excludes every `my_protected_mail_*`
view; and the coverage rows for page projections, MCP readers, owner views and
tool registration name the three procedures.

## Validation plan

A native fixture over a disposable server, in the style of the existing
harnesses: the owner binds, reads a window, pages across a batch whose records
share one `imported_at`, reads one summary and one body; another human, an
ordinary AI, an anonymous caller, a service identity and the publisher receive
the fixed denial over WebSocket and HTTP; an owner without a binding receives
`binding_required`; a second owner's binding on the same component does not
replace the first; editing the source declaration (including an edit reverted
before any read), deleting or trashing the node or any ancestor, replacing the
page document, deleting the page or restoring a snapshot revokes the binding in
that transaction and a restored node has none; a same-page reorder keeps the
binding and a cross-page move is refused; `limit` and the pair boundary produce
disjoint windows that end with `complete` under both the row and byte caps;
inconsistent associations are not projected; `body` and `note` never appear in a
window or summary response, checked by response and native log guards; a
UIDVALIDITY-reset duplicate appears twice with distinct `uid_validity`. An owner
who lost page read access receives `binding_required`; a record id whose prefix
is not the given collection receives `owner_required`; a component declaring a
second source, a scalar binding over the mailbox or any action but `open` is
rejected by both validators. On the Trellis side, TS/Rust parity covers the new
connection member, the `text`-only binding rule, the `open`-without-layout rule
and the no-filter/sort/range rule. Browser checks prove that mount, history
restore and page repeaters issue no procedure call, that only the chrome
controls do, and that `show_page_panel` refuses the component. The window index
is written atomically with each record, the window procedure's result equals a
brute-force scan ordered by `imported_at` descending then `id` ascending in
UTF-8 byte order for random boundaries and limits, including boundaries that
fall inside a batch sharing one timestamp and a collection holding exactly
`limit` rows (which must report `complete: true`), a mis-keyed index row never
surfaces a record in another collection's window, a revoked epoch purges the
held window on the next render, a fixture mailbox of fifty thousand records
pages in time proportional to the candidates examined, an instrumented run shows
that only admitted, look-ahead, rejected and byte-cap-trimmed candidates are
read, and equal-timestamp pagination with `limit` 1 visits every row of the
batch exactly once. A populated upgrade from the current 61 protected-mail
private tables (72 module-wide) keeps every table and history; the binding table
has no backfill, and the window index backfill reducer is checked against the
brute-force scan, is a no-op when rerun, and fails on a mismatched existing row.

## Remaining gates

This design authorizes no monitoring, connector, inference or workflow
implementation. Before real mail reaches a component, production ingestion into
S1 storage, protected backup and restore, and host egress enforcement remain
required gates in the Sentinel inventory.
