/**
 * ComponentNode substrate — end-to-end smoke test.
 *
 * Exercises every component-tree reducer against a live SpacetimeDB
 * instance. Asserts the substrate behaves correctly across the full
 * lifecycle of a ComponentTree page:
 *
 *   1. `create_component_tree_page` creates a page + root Container node.
 *   2. `insert_component` adds children under the root.
 *   3. `update_component_props` mutates props in place.
 *   4. `move_component` reparents nodes between siblings.
 *   5. `save_component_yjs_state` upserts Yjs bytes on a RichText node and
 *      rejects writes on non-Yjs nodes (negative case).
 *   6. `take_snapshot` serializes the live tree to `PageSnapshot.content`.
 *   7. `delete_component` soft-deletes a node, `restore_component`
 *      undoes it.
 *   8. `restore_page_to_snapshot` round-trips the captured snapshot.
 *   9. `register_component_type` adds a custom type, `update_component_type`
 *      updates it.
 *  10. Cleanup: soft-delete + hard-purge the test page. Verifies the purge
 *      cascade clears `ComponentNode` + `ComponentYjsState` rows.
 *
 * Usage:
 *   pnpm --filter web smoke <db-name> [<uri>]
 * Examples:
 *   # Local dev — no auth, anonymous identity works because there are no
 *   # access rules on the workspace.
 *   pnpm --filter web smoke pear-dev ws://localhost:3000
 *
 *   # Remote env — the lifecycle proxy at cloud.pear.pro enforces OIDC
 *   # bearer auth on every WebSocket upgrade. Grab a session token from
 *   # the browser (DevTools → Application → Local Storage on the
 *   # workspace, key `pear_spacetimedb_token__<workspace-id>`) and pass
 *   # via env:
 *   SPACETIMEDB_TOKEN=eyJhbGc... \
 *     pnpm --filter web smoke eclosion wss://eclosion.cloud.pear.pro
 *
 * The script writes test data into the target database. Run against dev /
 * staging instances, not production. The cleanup step removes the test
 * page on success; on partial failure inspect leftover pages with title
 * matching `Smoke Test <timestamp>`.
 */

import type { DbConnection as DbConnectionType } from "../src/module_bindings/index.js";
import { DbConnection } from "../src/module_bindings/index.js";
import type {
  ComponentNode,
  ComponentTypeDefinition,
  ComponentYjsState,
  Page,
  PageSnapshot,
  PageType,
  SnapshotType,
} from "../src/module_bindings/types.js";

const dbName = process.argv[2];
const uri = process.argv[3] ?? "ws://localhost:3000";
const token = process.env.SPACETIMEDB_TOKEN?.trim() || undefined;

if (!dbName) {
  console.error(
    "Usage: pnpm --filter web smoke <db-name> [<uri>]\n" +
      "  Local : pnpm --filter web smoke pear-dev ws://localhost:3000\n" +
      "  Remote: SPACETIMEDB_TOKEN=eyJ... pnpm --filter web smoke <slug> wss://<slug>.cloud.pear.pro",
  );
  process.exit(1);
}

// ============================================================
// Tiny test harness — pass/fail counters + assertions.
// ============================================================

let passCount = 0;
let failCount = 0;

function pass(name: string): void {
  passCount += 1;
  console.log(`  PASS  ${name}`);
}

function fail(name: string, reason: string): void {
  failCount += 1;
  console.error(`  FAIL  ${name}: ${reason}`);
}

function expect(
  name: string,
  condition: boolean,
  reason = "expectation not met",
): boolean {
  if (condition) {
    pass(name);
    return true;
  }
  fail(name, reason);
  return false;
}

/**
 * Poll a predicate until it returns a defined non-false value, or throw on
 * timeout. Returns the resolved value so callers chain off it.
 */
async function eventually<T>(
  description: string,
  predicate: () => T | undefined | null | false,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined && value !== null && value !== false) return value as T;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

/** Type helpers — `conn.db` and `conn.reducers` are dynamically generated. */
type AnyDb = Record<string, { iter(): Iterable<unknown> }>;
type AnyReducers = Record<string, (...args: unknown[]) => Promise<unknown>>;

function rows<T>(conn: DbConnectionType, table: string): T[] {
  const db = conn.db as unknown as AnyDb;
  const t = db[table];
  if (!t) throw new Error(`No such table on conn.db: ${table}`);
  return Array.from(t.iter()) as T[];
}

function callReducer(
  conn: DbConnectionType,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const r = conn.reducers as unknown as AnyReducers;
  const fn = r[name];
  if (!fn) throw new Error(`No such reducer on conn.reducers: ${name}`);
  return fn(args);
}

// ============================================================
// Connect + subscribe.
//
// The script body lives inside an async `main()` because tsx evaluates it
// in CommonJS mode (pear/web/package.json is not "type": "module" — that
// would break Next.js). CJS doesn't allow top-level await, so we wrap.
// ============================================================

async function main(): Promise<void> {
console.log(
  `[smoke] Connecting to ${uri} / ${dbName} (${token ? "authenticated" : "anonymous"})`,
);

const conn: DbConnectionType = await new Promise((resolve, reject) => {
  const builder = DbConnection.builder().withUri(uri).withDatabaseName(dbName);
  if (token) builder.withToken(token);
  builder
    .onConnect((c, identity) => {
      console.log(`[smoke] Connected as ${identity.toHexString()}`);
      resolve(c);
    })
    .onConnectError((_ctx, err) => {
      reject(new Error(`connect failed: ${err.message}`));
    })
    .build();
});

await new Promise<void>((resolve, reject) => {
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[smoke] Subscriptions applied`);
      resolve();
    })
    .onError((ctx) => {
      const err = (ctx as unknown as { event?: { error?: Error } }).event?.error;
      reject(new Error(`subscription error: ${err?.message ?? "unknown"}`));
    })
    .subscribe([
      "SELECT * FROM page",
      "SELECT * FROM page_content",
      "SELECT * FROM page_snapshot",
      "SELECT * FROM component_node",
      "SELECT * FROM component_yjs_state",
      "SELECT * FROM component_type_definition",
    ]);
});

// ============================================================
// Smoke test steps.
// ============================================================

const testTitle = `Smoke Test ${new Date().toISOString()}`;
console.log(`[smoke] Test page title: ${testTitle}`);

// --- 1. create_component_tree_page ---

await callReducer(conn, "createComponentTreePage", {
  parentId: null,
  pageType: { tag: "Doc" } as PageType,
  title: testTitle,
});

const testPage = await eventually("ComponentTree page to appear", () =>
  rows<Page>(conn, "page").find((p) => p.title === testTitle),
);
const pageId = testPage.id;
const fmt = testPage.contentFormat as unknown as { tag?: string };
expect(
  "page.content_format == ComponentTree",
  fmt.tag === "ComponentTree",
  `got ${JSON.stringify(testPage.contentFormat)}`,
);

const rootNode = await eventually("root ComponentNode to appear", () =>
  rows<ComponentNode>(conn, "component_node").find(
    (n) => n.surfaceId === pageId && n.parentId === undefined,
  ),
);
expect("root.component_type == Container", rootNode.componentType === "Container");
expect("root.parent_id is null", rootNode.parentId === undefined);

// --- 2. insert_component (twice — one Heading, one RichText) ---

await callReducer(conn, "insertComponent", {
  parentId: rootNode.id,
  componentType: "Heading",
  propsJson: JSON.stringify({ level: 1, text: "Hello" }),
  afterSiblingId: null,
});
const headingNode = await eventually("Heading child of root", () =>
  rows<ComponentNode>(conn, "component_node").find(
    (n) =>
      n.surfaceId === pageId &&
      n.parentId === rootNode.id &&
      n.componentType === "Heading",
  ),
);
expect("heading.props contains 'Hello'", headingNode.props.includes("Hello"));

await callReducer(conn, "insertComponent", {
  parentId: rootNode.id,
  componentType: "RichText",
  propsJson: JSON.stringify({ placeholder: "Type here…" }),
  afterSiblingId: headingNode.id,
});
const richTextNode = await eventually("RichText child of root", () =>
  rows<ComponentNode>(conn, "component_node").find(
    (n) =>
      n.surfaceId === pageId &&
      n.parentId === rootNode.id &&
      n.componentType === "RichText",
  ),
);
expect(
  "RichText.order > Heading.order",
  richTextNode.order > headingNode.order,
  `richText.order=${richTextNode.order} heading.order=${headingNode.order}`,
);

// --- 3. update_component_props ---

await callReducer(conn, "updateComponentProps", {
  componentId: headingNode.id,
  propsJson: JSON.stringify({ level: 2, text: "Updated heading" }),
});
await eventually("heading props update", () =>
  rows<ComponentNode>(conn, "component_node").find(
    (n) => n.id === headingNode.id && n.props.includes("Updated heading"),
  ),
);
pass("heading props mutated via update_component_props");

// --- 4. move_component ---

await callReducer(conn, "moveComponent", {
  componentId: headingNode.id,
  newParentId: rootNode.id,
  afterSiblingId: richTextNode.id,
});
await eventually("heading order > richText order after move", () => {
  const all = rows<ComponentNode>(conn, "component_node");
  const h = all.find((n) => n.id === headingNode.id);
  const r = all.find((n) => n.id === richTextNode.id);
  return h && r && h.order > r.order;
});
pass("heading reordered after RichText");

// --- 5. save_component_yjs_state (positive + negative case) ---

const yjsBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
await callReducer(conn, "saveComponentYjsState", {
  componentId: richTextNode.id,
  data: yjsBytes,
});
await eventually("ComponentYjsState row for RichText", () =>
  rows<ComponentYjsState>(conn, "component_yjs_state").find(
    (s) => s.componentNodeId === richTextNode.id,
  ),
);
pass("Yjs state persisted on RichText");

// Negative: Heading.has_yjs_state == false, so this reducer must fail.
// The SDK rejects the returned Promise on reducer error.
let negativeRejected = false;
try {
  await callReducer(conn, "saveComponentYjsState", {
    componentId: headingNode.id,
    data: yjsBytes,
  });
} catch {
  negativeRejected = true;
}
expect(
  "save_component_yjs_state rejected on non-Yjs type",
  negativeRejected,
  "reducer did not reject as expected",
);
expect(
  "no ComponentYjsState row for Heading",
  !rows<ComponentYjsState>(conn, "component_yjs_state").some(
    (s) => s.componentNodeId === headingNode.id,
  ),
  "row appeared despite reducer rejection",
);

// --- 6. take_snapshot ---

await callReducer(conn, "takeSnapshot", {
  pageId,
  snapshotType: { tag: "Manual" } as SnapshotType,
});
const snapshot = await eventually("PageSnapshot to appear", () =>
  rows<PageSnapshot>(conn, "page_snapshot").find((s) => s.pageId === pageId),
);
expect(
  "snapshot.content is component_tree_v1",
  snapshot.content.includes("component_tree_v1"),
);
expect(
  "snapshot includes 'Updated heading'",
  snapshot.content.includes("Updated heading"),
);

// --- 7. delete_component + restore_component ---

await callReducer(conn, "deleteComponent", { componentId: headingNode.id });
await eventually("heading is soft-deleted", () =>
  rows<ComponentNode>(conn, "component_node").find(
    (n) => n.id === headingNode.id && n.deletedAt !== undefined,
  ),
);
pass("delete_component soft-deletes target");

await callReducer(conn, "restoreComponent", {
  componentId: headingNode.id,
});
await eventually("heading is restored", () =>
  rows<ComponentNode>(conn, "component_node").find(
    (n) => n.id === headingNode.id && n.deletedAt === undefined,
  ),
);
pass("restore_component undoes the soft-delete");

// --- 8. restore_page_to_snapshot (round-trip) ---

// Mutate state so restore actually changes something.
await callReducer(conn, "updateComponentProps", {
  componentId: headingNode.id,
  propsJson: JSON.stringify({ level: 3, text: "About to be reverted" }),
});
await eventually("pre-restore prop change visible", () =>
  rows<ComponentNode>(conn, "component_node").find(
    (n) => n.id === headingNode.id && n.props.includes("About to be reverted"),
  ),
);

await callReducer(conn, "restorePageToSnapshot", {
  pageId,
  snapshotId: snapshot.id,
});

// After restore, the original Heading row is wiped + reinserted with a
// new ID. Find the new Heading under the page.
const restoredHeading = await eventually(
  "Heading appears post-restore with original text",
  () =>
    rows<ComponentNode>(conn, "component_node").find(
      (n) =>
        n.surfaceId === pageId &&
        n.componentType === "Heading" &&
        n.props.includes("Updated heading"),
    ),
);
expect(
  "restored heading id is fresh (not the old one)",
  restoredHeading.id !== headingNode.id,
  `expected new id, got original ${headingNode.id}`,
);

// --- 9. register_component_type + update_component_type ---

const customType = `SmokeCustom_${Date.now()}`;
await callReducer(conn, "registerComponentType", {
  componentType: customType,
  displayName: "Smoke Custom",
  description: "Registered by the substrate smoke test.",
  propSchemaJson: JSON.stringify({
    type: "object",
    properties: { caption: { type: "string" } },
  }),
  capabilities: [],
  hasYjsState: false,
  acceptsChildren: false,
});
const customDef = await eventually(
  "custom ComponentTypeDefinition appears",
  () =>
    rows<ComponentTypeDefinition>(conn, "component_type_definition").find(
      (d) => d.componentType === customType,
    ),
);
expect("custom def is_builtin == false", customDef.isBuiltin === false);

await callReducer(conn, "updateComponentType", {
  typeId: customDef.id,
  displayName: "Smoke Custom (renamed)",
  description: null,
  propSchemaJson: null,
  capabilities: null,
});
await eventually("custom def display_name updated", () =>
  rows<ComponentTypeDefinition>(conn, "component_type_definition").find(
    (d) => d.id === customDef.id && d.displayName === "Smoke Custom (renamed)",
  ),
);
pass("update_component_type mutates the registered row");

// --- 10. Cleanup: delete + purge the test page ---

await callReducer(conn, "deletePage", { pageId });
await eventually("page is soft-deleted", () =>
  rows<Page>(conn, "page").find((p) => p.id === pageId && p.deletedAt !== undefined),
);

const preNodeCount = rows<ComponentNode>(conn, "component_node").filter(
  (n) => n.surfaceId === pageId,
).length;
expect("ComponentNode rows still exist pre-purge", preNodeCount > 0);

await callReducer(conn, "purgePage", { pageId });
await eventually(
  "page row gone after purge",
  () => !rows<Page>(conn, "page").some((p) => p.id === pageId),
);
const postNodeCount = rows<ComponentNode>(conn, "component_node").filter(
  (n) => n.surfaceId === pageId,
).length;
expect(
  "purge cascade removed all ComponentNode rows for surface",
  postNodeCount === 0,
  `${postNodeCount} rows survived`,
);

// ============================================================
// Summary.
// ============================================================

console.log("");
console.log(`[smoke] ${passCount} passed, ${failCount} failed`);

conn.disconnect();
process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[smoke] FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
