# Trellis generated-panel pilot

The pilot replaces the rendering of compatible `component_tree_v1` panels while retaining Pear's `GeneratedUiInteractionProvider` and existing Button renderer. Original wire node IDs, form mappings, confirmation, reducer invocation keys and queue-status interpretation are preserved. Message storage, worker writes and server authorization are unchanged.

The default remains the legacy path. Enable the pilot with `NEXT_PUBLIC_PEAR_TRELLIS_GENERATED_UI=1`, or set `localStorage.setItem('pear:trellis-generated-ui', '1')` and reload. Set the value to `0` to roll back without a rebuild. The first client render matches the build default before reading the runtime override.

Panels outside the bounded shared catalog fall back to the existing historical renderer. Strict conversion does not broaden action capability: selected controls still invoke the existing Manual automation reducer, which authorizes the caller. A successful reducer dispatch is pending until a matching queue event arrives; completed, skipped, dry-run and failed outcomes retain their existing feedback.

Trellis is installed from local built artifacts in `vendor/trellis/`. No source alias or neighboring Trellis checkout is needed to build Pear after installation. The pilot uses a separate scoped renderer catalog and does not overwrite Pulp's global renderer registrations.

## Retained template workflow

New retained panels use the explicit `pear_trellis_ui_v1` envelope in the existing message field. They render through Trellis regardless of the historical-conversion flag; invalid or unsupported versions display an error while preserving their stored data. The database schema and message subscription are unchanged.

The host package `@pear/trellis-ui` bundles `pear.summary@1.0.0` and `pear.automation-form@1.0.0`. Templates have immutable hashes, named parameters and stable node keys. The form has one required field named `value`. A Pear-owned binding selects an existing enabled Manual automation, its scalar/`$form.value` inputs and optional confirmation. Updates cannot change that binding or the pinned template version.

After installing the updated web client and database module, enable worker tools with `PEAR_TRELLIS_UI=1` and restart the worker. The flag is off by default. The tools are conversation-only:

1. `list_ui_templates` returns exact versions, schemas and defaults.
2. `list_ui` finds up to 20 recent saved interfaces in this conversation, including earlier turns.
3. `create_ui` instantiates one template on the current assistant message. A different panel cannot be overwritten.
4. `get_ui` reads a message's saved parameters and revision. It does not expose browser drafts.
5. `update_ui` changes parameters on that same instance, using `message_id`, `base_revision` and a stable `request_id`.

`commit_message_trellis` reuses the original AI-sender, conversation-authority and active-conversation checks. Its transaction validates the complete candidate against the bundled template, checks the revision, pins action bindings and writes a server-owned receipt. It retains 32 receipts. Identical retries do not advance the document; changed content under the same request ID is rejected. Evicted stale requests cannot overwrite a newer revision. The legacy setter cannot create, overwrite or clear a retained panel.

Workers report a saved result only after observing its receipt through the message subscription. A lost acknowledgement is resolved from that receipt; an unobserved result returns `COMMIT_UNCONFIRMED` and requires an identical retry. After `STALE_REVISION`, read again and decide whether to propose a new update.

The newer chat thread shares one automation queue subscription across its panels. Buttons still use the original confirmation, field resolution, reducer and authoritative queue status. A document commit never means an automation completed. Reloading restores committed parameters; private unsent drafts remain local to the current browser surface.

## Page-owned Note panel

`TrellisPanel` is a leaf in the ordinary page component tree. Insert **Note panel** from the slash menu; its **Edit panel** settings and fixed **Save note** action update the same component through `commit_trellis_panel`. The pinned `pear.note-panel@1.0.0` envelope lives in `ComponentNode.props`. Parameter edits retain component/template-node IDs. Page Write access, base revisions and 32 principal-scoped receipts govern both human and agent saves. Generic props replacement is rejected; generic single/batched insertion accepts only declared parameters and initializes server-owned state.

Shared MCP/chat tools are `list_page_panel_templates`, `create_page_panel`, `get_page_panel` and `update_page_panel`. Use canonical decimal strings for IDs. Read the current revision before proposing changed parameters; use a stable request ID and identical arguments after an uncertain result. A stale edit requires a fresh read and deliberate new proposal. `get_page_panel` never returns private unsent drafts.

**Discuss panel** starts the existing component-anchored conversation. Its chat header can invite an AI. The chat-only `show_page_panel` stores a `pear_page_component_v1` reference containing only page/component IDs on the current assistant message. It requires the original AI sender and source Read access. Both occurrences use the page's saved state and permissions, while unfinished input remains local to each view. Source revocation or deletion displays an unavailable reference without erasing it. Soft restoration of the same component works; whole-page snapshot restoration allocates new IDs and does not repair old references.

This first slice supports six string parameters and one save-note action. It does not introduce arbitrary component composition, native controls or shared page undo/history. Settings conflicts preserve the draft with explicit reload; uncertain saves preserve an identical retry; principal changes end pending editing sessions. The new page tools share existing page-authoring availability and are not gated by `PEAR_TRELLIS_UI`. Deploy the reviewed module and upgraded readers before exposing them through restarted workers/gateways. No live workspace is deployed by the Trellis finish script.

## Install and rollout

The guarded Trellis installer installs dependencies and builds `@pear/trellis-ui`. Normal builds must build this package before the web client or worker. Client bindings are regenerated with SpacetimeDB 2.0.3; no generated file is hand edited.

Publish the reviewed module using this workspace's existing deployment process, then restart upgraded clients/workers before enabling `PEAR_TRELLIS_UI`. The staged change does not deploy a live workspace. Disabling the worker flag stops new retained-UI tool calls while keeping saved panels readable. Older clients do not understand the new envelope.

The isolated local smoke test exercises real message commits, sender restrictions, reconnect, stale/retry handling and a Live Manual automation that creates a page only in its disposable test database. Browser tests separately cover the actual chat data renderer, drafts/focus/caret and queue feedback. Native rendering of this Pear panel is outside this workflow.
