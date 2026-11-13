# Page property references

Implemented against Pear `main` at `f2892600018cae82b96c8505f5bb241fa919b92c` on branch `feat/property-bindings`. The original pear-cloud checkout contains unrelated work and was left untouched. This implementation lives in an isolated Pear checkout.

Text properties in the page properties panel now wrap and preserve line breaks, with a four-line preview, expansion, and a multiline editor with Save/Cancel. Database grid cells retain their existing dense presentation.

Insert `/property` into a page body, choose **This page** or **Choose a page**, then choose a Text property. The complete value renders as plain document text. Selecting/focusing the block exposes source and settings controls. **Open source** uses canonical workspace page navigation; **Edit property** navigates to the source page's existing properties panel and opens its textarea when the viewer can edit that page. Reference settings require destination write access. Arbitrary HTML, Markdown and `{{...}}` remain literal text.

## Persistence and access

The registered leaf block is `PropertyReference`, without Yjs state or children. Its versioned props contain only identities and a Trellis `ComponentBinding`:

```json
{
  "v": 1,
  "schemaId": "5",
  "binding": {
    "source": "property",
    "recordId": { "param": "record" },
    "field": "7",
    "property": "text",
    "writeBack": false
  }
}
```

For an explicit source, `recordId` is the decimal page-ID string. `field` is the property-definition ID, not its name. IDs remain strings through reference persistence and validation, including IDs beyond JavaScript's safe-integer range. Renames preserve references. Missing definitions and unsupported types do not select replacements by name. An unconfigured block stores `{}`; unsupported saved references retain their original data and show a fallback.

The host resolver uses the same workspace data and authorized record reader as authored components. Trellis's new `bindingRecordId` helper resolves parameters only from supplied containing-record context. Pear supplies `node.surfaceId`; neither focused-tab state nor the first snapshot row is a fallback. Authored Trellis components now resolve record parameters through `session.read` too, and their session transition avoids handing children a closed connection.

Source access is independent of destination access. Pickers and rendering check schema/page permissions before returning titles, labels or values. The host resolves current data during render, and scoped subscriptions invalidate readiness on connection or principal changes. No resolved source text is persisted in block props. The read-only block never writes source values. Empty text has a distinct presentation from an unavailable source.

## Database templates and duplication

Current main had no page-body template/duplication flow. **New from page template** on database pages now accepts an accessible document page as a reusable template. **Duplicate page** is available on document pages. Both use the transactional `create_page_from_template` reducer, which checks template read access, block access and destination-parent write access, copies reachable live structure/Yjs state, and gives the copied nodes new identities. Same-database property values are copied as record defaults; cross-database columns are not transplanted.

`PropertyReference` props survive copying unchanged: self bindings resolve against the newly created page, while explicit bindings keep the chosen source. Resolved values are never copied into body content. Versioned Trellis components receive new document/node identities and fresh creation receipts; their source bindings remain intact. Deleted subtrees are not resurrected. This first version uses existing pages as templates; it does not add a separate template catalog or default-template scheduler.

## Agent authoring

Use `insert_component` with `component_type: "PropertyReference"` and the props above; use `update_component_props` to replace its complete configuration. Discover stable property IDs with `query_database`/`list_properties`. `get_page_components` returns the saved reference plus `resolved_property`; `get_page` renders the authorized value with its source IDs. Reads use the caller-bound transport, recheck source availability, and never expand source page bodies.

`create_page_from_template` is also exposed through MCP and native chat parity. It requires `pages:write` for OAuth, source read access and destination-parent write access. Inputs are `source_page_id` (decimal string), optional `parent_id` (decimal string), and `title`. Omit `parent_id` for a root page; supply the source's parent to duplicate within its database. Concurrent ambiguous ID discovery is reported rather than guessing which page was created.

The worker's generic preloaded document-context walker shows an honest unavailable marker when no authorized property read was supplied. Agents obtain resolved source content via the caller-bound `get_page`/`get_page_components` tools; the feature does not expand references through publisher authority.

## Verification

Local checks completed on 2026-11-13:

- 399 web tests passed, including reference serialization, real React picker/editor behavior, live source/ACL changes, principal switching, the authored record binding runtime, existing components and MCP readback. OAuth scope assertions also passed after adding the new template tool.
- 36 Rust page tests passed, including reference validation, template copying and valid copied authored-component state.
- 31 Trellis authoring/data/record-view tests passed against the edited Trellis source.
- 17 native worker MCP parity tests passed.
- Trellis package builds, web/worker TypeScript checks, WASM build, and regenerated web/worker bindings passed.
- `web/scripts/property-reference-e2e.mts` passed against a disposable localhost SpacetimeDB workspace: persisted self/explicit blocks, two template records, duplication, readback, live updates, rename/deletion, empty values, forbidden source writes, denied destination creation, revocation/restoration and malformed cached-value rejection. The script deleted its own test database afterward.
- Chromium checked actual UI components at 1280px and 390px, including multiline editing, picker round-trip, saved-reference reload, self-context changes, explicit references, read-only controls and permission revocation/restoration. No horizontal overflow or browser errors. Canonical source URLs and Back history were exercised in the local fixture. Screenshots were visually inspected: [desktop](property-bindings-evidence/desktop.png), [narrow](property-bindings-evidence/narrow.png), [narrow picker](property-bindings-evidence/picker-narrow.png).

No signed-in production UI test or deployment was performed. The browser fixture uses the actual components and resolver with local data; its navigation check exercises canonical URL construction and browser history, not a deployed Next.js workspace. The Canopy proof record and its edited body were not changed.

Reproduce from the Pear checkout:

```sh
pnpm --filter @pear/trellis-ui build
pnpm --filter @pear/web exec vitest run
pnpm --filter @pear/web exec tsc --noEmit
pnpm --filter @pear/worker exec tsc --noEmit
pnpm --filter @pear/worker exec node --import tsx/esm --test src/mcp-parity-tools.test.ts
cargo test --manifest-path server/spacetimedb/Cargo.toml --lib pages:: --offline
# With a disposable local SpacetimeDB server listening on port 3117:
cd web
node --import tsx scripts/property-reference-e2e.mts
```

The browser script requires an installed Playwright Chromium and `@playwright/test`/`esbuild`. It can use the Trellis workspace's existing browser tools without adding application dependencies:

```sh
PEAR_BROWSER_TOOLS_PACKAGE=/path/to/Trellis/package.json \
PEAR_PROPERTY_EVIDENCE=/tmp/property-reference-visual \
node web/scripts/property-reference-browser/verify.mjs
```

## Trellis artifacts

Pear pins core `0.1.0-alpha.9` and React `0.1.0-alpha.11`. The reviewable source changes are in `vendor/trellis/property-bindings.patch`; apply that patch to the maintained Trellis source, update package versions, build and pack to reproduce the vendor archives. The baseline local Trellis sources were compared to every source embedded in the current core alpha.8 / React alpha.9 package source maps (14 core files and 8 React files): no differences. The core helper, current-record renderer and session transition are the only library source changes.
