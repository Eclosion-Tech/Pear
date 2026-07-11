/**
 * pear-snapshot-v2 — export → wipe → chunked import round-trip e2e.
 *
 * Drives the full backup/restore loop against a live SpacetimeDB instance:
 *
 *   1. Registers a native user (import requires an authenticated caller).
 *   2. Seeds a workspace: a ComponentTree page (Heading + RichText with Yjs
 *      bytes), a legacy BlockNote page with content, an attachment row, and
 *      a page snapshot.
 *   3. Subscribes to every include-list table and builds a v2 snapshot via
 *      the shared snapshot-core builder (same code path as the web UI and
 *      the cloud backup runner).
 *   4. Republishes the module with --clear-database (fresh workspace).
 *   5. Re-registers, then replays the snapshot through import_v2_begin /
 *      import_v2_chunk / import_v2_commit.
 *   6. Verifies per-table row counts against the snapshot manifest and
 *      spot-checks content fidelity (props text, Yjs bytes, contentFormat).
 *
 * Usage:
 *   pnpm --filter web e2e:snapshot <db-name> [<ws-uri>] [<module-wasm-path>]
 * Example (local scratch db — NEVER run against a real workspace; step 4
 * erases the database):
 *   pnpm --filter web e2e:snapshot pear-v2-e2e ws://localhost:3100 \
 *     ../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm
 *
 * The publish step shells out to the `spacetime` CLI; the server name is
 * derived from the URI port (`-s local3100` for :3100, else the default).
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { DbConnection } from "../src/module_bindings/index.js";
import type { DbConnection as DbConnectionType } from "../src/module_bindings/index.js";
import { tables } from "../src/module_bindings/index.js";
import type { ComponentNode, ComponentYjsState, Page } from "../src/module_bindings/types.js";
import {
  buildPearSnapshotV2,
  chunkSnapshotV2,
  SNAPSHOT_TABLES_V2,
} from "@eclosion-tech/snapshot-core";

const dbName = process.argv[2];
const uri = process.argv[3] ?? "ws://localhost:3100";
const wasmPath =
  process.argv[4] ??
  "../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm";

if (!dbName) {
  console.error("Usage: pnpm --filter web e2e:snapshot <db-name> [<ws-uri>] [<wasm-path>]");
  process.exit(1);
}

let passCount = 0;
let failCount = 0;
function expect(name: string, condition: boolean, reason = "expectation not met"): void {
  if (condition) {
    passCount += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failCount += 1;
    console.error(`  FAIL  ${name}: ${reason}`);
  }
}

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

type AnyDb = Record<string, { iter(): Iterable<unknown> }>;
type AnyReducers = Record<string, (...args: unknown[]) => Promise<unknown>>;

function rows<T>(conn: DbConnectionType, table: string): T[] {
  const t = (conn.db as unknown as AnyDb)[table];
  if (!t) throw new Error(`No such table on conn.db: ${table}`);
  return Array.from(t.iter()) as T[];
}

function callReducer(
  conn: DbConnectionType,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const fn = (conn.reducers as unknown as AnyReducers)[name];
  if (!fn) throw new Error(`No such reducer on conn.reducers: ${name}`);
  return fn(args);
}

async function connect(): Promise<DbConnectionType> {
  const conn: DbConnectionType = await new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(dbName)
      .onConnect((c) => resolve(c))
      .onConnectError((_ctx, err) => reject(new Error(`connect failed: ${err.message}`)))
      .build();
  });
  await new Promise<void>((resolve, reject) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError((ctx) => {
        const err = (ctx as unknown as { event?: { error?: Error } }).event?.error;
        reject(new Error(`subscription error: ${err?.message ?? "unknown"}`));
      })
      .subscribe(SNAPSHOT_TABLES_V2.map((t) => `SELECT * FROM ${t}`));
  });
  return conn;
}

async function register(conn: DbConnectionType, email: string): Promise<void> {
  await callReducer(conn, "register", {
    email,
    name: "Snapshot E2E",
    password: "e2e-password-1",
  });
}

function republishCleared(): void {
  const server = uri.includes(":3100") ? "local3100" : "local";
  console.log(`[e2e] Republishing ${dbName} with --clear-database (server ${server})`);
  execFileSync(
    "spacetime",
    ["publish", "-s", server, dbName, "--clear-database", "--bin-path", resolve(wasmPath), "-y"],
    { stdio: "inherit", cwd: "/tmp" },
  );
}

async function main(): Promise<void> {
  // ── Phase 1: seed + export ──────────────────────────────────────────────
  console.log(`[e2e] Phase 1: seeding ${uri} / ${dbName}`);
  const runId = Date.now();
  let conn = await connect();
  await register(conn, `e2e-source-${runId}@example.test`);

  await callReducer(conn, "createComponentTreePage", {
    parentId: null,
    pageType: { tag: "Doc" },
    title: `E2E ComponentTree Page ${runId}`,
  });
  const ctPage = await eventually("ComponentTree page", () =>
    rows<Page>(conn, "page").find((p) => p.title === `E2E ComponentTree Page ${runId}`),
  );
  const root = await eventually("root component node", () =>
    rows<ComponentNode>(conn, "component_node").find(
      (n) => n.surfaceId === ctPage.id && n.parentId === undefined,
    ),
  );
  await callReducer(conn, "insertComponent", {
    parentId: root.id,
    componentType: "Heading",
    propsJson: JSON.stringify({ level: 1, text: "Backup me" }),
    afterSiblingId: null,
  });
  await callReducer(conn, "insertComponent", {
    parentId: root.id,
    componentType: "RichText",
    propsJson: JSON.stringify({}),
    afterSiblingId: null,
  });
  const richText = await eventually("RichText node", () =>
    rows<ComponentNode>(conn, "component_node").find(
      (n) => n.surfaceId === ctPage.id && n.componentType === "RichText",
    ),
  );
  const yjsBytes = new Uint8Array([7, 6, 5, 4, 3, 2, 1]);
  await callReducer(conn, "saveComponentYjsState", {
    componentId: richText.id,
    data: yjsBytes,
  });
  await eventually("Yjs row", () =>
    rows<ComponentYjsState>(conn, "component_yjs_state").find(
      (s) => s.componentNodeId === richText.id,
    ),
  );

  await callReducer(conn, "createPage", {
    parentId: null,
    pageType: { tag: "Doc" },
    title: `E2E Second Page ${runId}`,
  });
  const secondPage = await eventually("second page", () =>
    rows<Page>(conn, "page").find((p) => p.title === `E2E Second Page ${runId}`),
  );
  await callReducer(conn, "createAttachment", {
    pageId: secondPage.id,
    filename: "photo.png",
    contentType: "image/png",
    storageKey: "pages/e2e/photo.png",
    sizeBytes: 1234n,
  });
  await callReducer(conn, "takeSnapshot", {
    pageId: ctPage.id,
    snapshotType: { tag: "Manual" },
  });
  await eventually("attachment + snapshot rows", () =>
    rows(conn, "attachment").length > 0 && rows(conn, "page_snapshot").length > 0,
  );

  console.log("[e2e] Building v2 snapshot");
  const snapshot = buildPearSnapshotV2(conn.db, {
    wsUri: uri,
    dbName,
    tablesRegistry: tables,
  });
  const { header, chunks, manifest } = chunkSnapshotV2(snapshot);
  const seededTables = Object.entries(snapshot.counts).filter(([, n]) => n > 0);
  console.log(
    `[e2e] Snapshot: ${seededTables.length} non-empty tables, ${chunks.length} chunks`,
  );
  expect("snapshot contains component_node rows", (snapshot.counts["component_node"] ?? 0) >= 3);
  expect("snapshot contains component_yjs_state", (snapshot.counts["component_yjs_state"] ?? 0) >= 1);
  expect(
    "blobManifest carries the attachment storage key",
    snapshot.blobManifest.storageKeys.includes("pages/e2e/photo.png"),
  );
  conn.disconnect();

  // ── Phase 2: wipe + import ──────────────────────────────────────────────
  republishCleared();
  await new Promise((r) => setTimeout(r, 1500));

  console.log("[e2e] Phase 2: importing into cleared database");
  conn = await connect();
  await register(conn, `e2e-restorer-${runId}@example.test`);

  await callReducer(conn, "importV2Begin", { headerJson: JSON.stringify(header) });
  for (const chunk of chunks) {
    await callReducer(conn, "importV2Chunk", {
      seq: chunk.seq,
      tableName: chunk.tableName,
      rowsJson: chunk.rowsJson,
    });
  }
  await callReducer(conn, "importV2Commit", { manifestJson: JSON.stringify(manifest) });
  console.log("[e2e] Import committed");

  // Give the subscription a beat to deliver post-import state.
  await eventually("imported pages visible", () => rows(conn, "page").length >= 2);

  // ── Phase 3: verify ─────────────────────────────────────────────────────
  for (const [table, count] of Object.entries(snapshot.counts)) {
    const live = rows(conn, table).length;
    // The restoring registrant adds one extra `user` row.
    const expected = table === "user" ? count + 1 : count;
    expect(`count[${table}] == ${expected}`, live === expected, `live=${live}`);
  }

  const restoredHeading = rows<ComponentNode>(conn, "component_node").find(
    (n) => n.componentType === "Heading",
  );
  expect(
    "heading props survived",
    Boolean(restoredHeading?.props.includes("Backup me")),
    JSON.stringify(restoredHeading?.props),
  );
  const restoredYjs = rows<ComponentYjsState>(conn, "component_yjs_state").find(
    (s) => s.componentNodeId === richText.id,
  );
  expect(
    "Yjs bytes byte-identical",
    Boolean(restoredYjs) && Buffer.from(restoredYjs.data).equals(Buffer.from(yjsBytes)),
    `got ${restoredYjs ? Buffer.from(restoredYjs.data).toString("hex") : "none"}`,
  );
  const restoredCt = rows<Page>(conn, "page").find(
    (p) => p.title === `E2E ComponentTree Page ${runId}`,
  );
  const fmt = restoredCt?.contentFormat as unknown as { tag?: string } | undefined;
  expect("contentFormat == ComponentTree", fmt?.tag === "ComponentTree", JSON.stringify(fmt));

  // Post-import id allocation must not collide with imported rows
  // (id_counter reset check): create a fresh page and ensure a new id.
  const preIds = new Set(rows<Page>(conn, "page").map((p) => p.id));
  await callReducer(conn, "createPage", {
    parentId: null,
    pageType: { tag: "Doc" },
    title: `E2E Post-Import Page ${runId}`,
  });
  const postPage = await eventually("post-import page", () =>
    rows<Page>(conn, "page").find((p) => p.title === `E2E Post-Import Page ${runId}`),
  );
  expect(
    "post-import page id does not collide",
    !preIds.has(postPage.id),
    `id ${postPage.id} collided`,
  );

  console.log("");
  console.log(`[e2e] ${passCount} passed, ${failCount} failed`);
  conn.disconnect();
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[e2e] FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
