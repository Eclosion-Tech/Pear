# Component authoring and live data

Pages offer **New component** beside **Component library**, and a **New component** slash item. A new component starts with an empty container. The hardcoded checklist and note presets are absent from creation menus and agent discovery. Existing saved instances and previously pinned requests retain compatibility; new reusable components come from human/AI authoring and workspace publication.

The builder adds building blocks, arranges their parent/order, edits their properties, and configures local actions. Local actions can copy private field input into saved text, update a property, or toggle a checkbox. Humans and AI edit the same page-owned definition with the same revision and durable retry receipts. Private input remains scoped to each viewer; showing the component in chat stores a live reference to the page instance.

Agents use `create_component`, `get_component`, and `update_component`. `get_component` returns the complete configuration, catalog, exact patch schemas/examples, and source/action contracts. Configuration and layout changes commit atomically. `setAction` attaches a declared slot or removes it with `null`. A stale revision requires a fresh read; an unconfirmed write requires the same request ID and arguments.

## Live sources

A source declares scalar fields and a connection. Bind an input, checkbox, or text block to a field, or add a live table. Bound controls intersect the field's declared capability, the adapter's supported operations, current record permissions, and page write access.

- **Pear database:** map field aliases to exact schema/property IDs. Text, URL, number and checkbox values support transactional write-back. Select fields can be displayed read-only. The reducer checks that the row is in the connected database, each property belongs to the selected schema, types match, and the caller still has write access. Property history, triggers and the component receipt commit in one transaction. Foreign rows, unsupported fields, deleted sources, and revoked permissions reject the whole write. A binding to the first record uses the first readable row by ID; a table can edit its displayed rows. Agents use `write_component_data` for this same workspace write path.
- **External JSON API:** configure an HTTPS read URL, optional dotted records path, stable record ID field, and scalar record fields. CORS must permit the browser request. Reads poll every five seconds. Write-back requires an explicit PATCH or PUT record URL, optionally containing `{id}`. A connection without a write operation is read-only, even if the template requests editable fields. A denied or unsupported write revokes editing for that record. PATCH sends the changed fields; PUT first reads the latest object and preserves unprojected fields. Success requires reading the requested values back from the service. An uncertain response retains the draft and retry identity. Services may also enforce their own concurrency/version policies; this generic adapter does not provide cross-service transactions.

API tokens are entered privately for the current browser session and exact URL origin. They are absent from the component definition, agent snapshots, saved templates and backup payloads. Changing the principal ends the session. External writes execute through the connected browser adapter; the server-side agent write tool supports workspace data. No service-specific OAuth integration or server-side external credential store is introduced here.

## Reuse

**Save as template** previews an immutable workspace version before publication. The published blueprint resets checkbox completion, private field defaults, saved action output, source record selectors and source connections. Each use allocates fresh node/document identities and independent state. Reconnect the new instance's source ports deliberately. Existing instances stay editable and pinned when the family gains versions or is archived.

`trellis_component_v1` instances and `trellis_authored_template_v1` packages are independent of the original registered task/note presets. Their format is data only; components cannot supply JavaScript, reducers or new host capabilities. The repository interface can resolve either package format; external repository discovery/adoption remains a future host adapter.

No new database tables, reducers or views are required. Existing component/repository storage and backup/restore paths accept the new formats. Existing view dispatch slots must remain stable on SpacetimeDB 2.0.3.
