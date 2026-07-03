/**
 * Repeater Phase-2 bench — reducer commit → client delivery latency under
 * page churn, against a live SpacetimeDB instance.
 *
 * Phase 1 (spikes/repeater-bench) measured materialization + React render
 * in isolation and settled the strategy question (incremental). This script
 * measures the leg Phase 1 excluded: a reducer call on one connection to a
 * row event arriving on a *second* connection — what another user's
 * repeater-backed sidebar would experience — plus the per-delivery client
 * compute a sidebar repeater implies (rebuild the byParent index over the
 * page cache + filter/sort the dataSource query, the useComponentTree /
 * full-re-evaluation pattern).
 *
 * Usage:
 *   pnpm --filter web bench:repeater <db-name> [<uri>]
 * Env knobs:
 *   BENCH_PAGES=300      pages created under the bench parent
 *   BENCH_RATE=20        title updates per second
 *   BENCH_DURATION=15    seconds of churn
 *   SPACETIMEDB_TOKEN    bearer token for remote instances (see smoke)
 *
 * Writes test data; run against dev/staging. Cleanup purges the bench
 * pages; on partial failure look for pages titled `Repeater Bench <ts>`.
 */

import { performance } from "node:perf_hooks";
import type { DbConnection as DbConnectionType } from "../src/module_bindings/index.js";
import { DbConnection } from "../src/module_bindings/index.js";
import type { Page, PageType } from "../src/module_bindings/types.js";

const dbName = process.argv[2];
const uri = process.argv[3] ?? "ws://localhost:3000";
const token = process.env.SPACETIMEDB_TOKEN?.trim() || undefined;

const PAGES = Number(process.env.BENCH_PAGES ?? 300);
const RATE = Number(process.env.BENCH_RATE ?? 20);
const DURATION = Number(process.env.BENCH_DURATION ?? 15);

if (!dbName) {
  console.error(
    "Usage: pnpm --filter web bench:repeater <db-name> [<uri>]\n" +
      "  Local: pnpm --filter web bench:repeater pear-dev ws://localhost:3000",
  );
  process.exit(1);
}

type AnyReducers = Record<string, (...args: unknown[]) => Promise<unknown>>;
type PageTable = {
  iter(): Iterable<Page>;
  onUpdate?: (cb: (ctx: unknown, oldRow: Page, newRow: Page) => void) => void;
  onInsert?: (cb: (ctx: unknown, row: Page) => void) => void;
};

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

function pageTable(conn: DbConnectionType): PageTable {
  const t = (conn.db as unknown as Record<string, PageTable>).page;
  if (!t) throw new Error("No `page` table on conn.db");
  return t;
}

async function connect(label: string): Promise<DbConnectionType> {
  const conn: DbConnectionType = await new Promise((resolve, reject) => {
    const builder = DbConnection.builder().withUri(uri).withDatabaseName(dbName);
    if (token) builder.withToken(token);
    builder
      .onConnect((c, identity) => {
        console.log(`[bench] ${label} connected as ${identity.toHexString()}`);
        resolve(c);
      })
      .onConnectError((_ctx, err) =>
        reject(new Error(`${label} connect failed: ${err.message}`)),
      )
      .build();
  });
  await new Promise<void>((resolve, reject) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError((ctx) => {
        const err = (ctx as unknown as { event?: { error?: Error } }).event
          ?.error;
        reject(new Error(`${label} subscription error: ${err?.message}`));
      })
      .subscribe(["SELECT * FROM page"]);
  });
  return conn;
}

async function eventually<T>(
  description: string,
  predicate: () => T | undefined | null | false,
  timeoutMs = 15000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined && value !== null && value !== false)
      return value as T;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

function report(label: string, samples: number[], unit = "ms"): void {
  const s = samples.slice().sort((a, b) => a - b);
  const fmt = (v: number) => v.toFixed(2);
  console.log(
    `[bench] ${label}: n=${s.length} p50=${fmt(percentile(s, 50))}${unit} ` +
      `p95=${fmt(percentile(s, 95))}${unit} p99=${fmt(percentile(s, 99))}${unit} ` +
      `max=${fmt(s[s.length - 1] ?? NaN)}${unit}`,
  );
}

/**
 * The per-delivery client compute a sidebar repeater implies today:
 * byParent index over the whole page cache (useComponentTree pattern) +
 * dataSource evaluation (filter to bench pages, sort by title). Full
 * re-evaluation on purpose — the v1 pattern; Phase 1's query benches cover
 * the delta-maintenance upgrade.
 */
function sidebarComputeMs(conn: DbConnectionType, parentId: bigint): number {
  const t0 = performance.now();
  const byParent = new Map<bigint | null, Page[]>();
  for (const p of pageTable(conn).iter()) {
    const key = (p.parentId ?? null) as bigint | null;
    const arr = byParent.get(key);
    if (arr) arr.push(p);
    else byParent.set(key, [p]);
  }
  const kids = (byParent.get(parentId) ?? [])
    .slice()
    .sort((a, b) => (a.title < b.title ? -1 : 1));
  void kids;
  return performance.now() - t0;
}

async function main(): Promise<void> {
  console.log(
    `[bench] ${uri}/${dbName} — pages=${PAGES} rate=${RATE}/s duration=${DURATION}s`,
  );
  const driver = await connect("driver");
  const observer = await connect("observer");

  // --- Setup: parent + N child pages ---
  const parentTitle = `Repeater Bench ${new Date().toISOString()}`;
  await callReducer(driver, "createPage", {
    parentId: null,
    pageType: { tag: "Doc" } as PageType,
    title: parentTitle,
  });
  const parent = await eventually("bench parent page", () =>
    Array.from(pageTable(driver).iter()).find((p) => p.title === parentTitle),
  );

  console.log(`[bench] creating ${PAGES} child pages…`);
  const t0 = performance.now();
  for (let i = 0; i < PAGES; i++) {
    await callReducer(driver, "createPage", {
      parentId: parent.id,
      pageType: { tag: "Doc" } as PageType,
      title: `bench-page-${i}`,
    });
  }
  await eventually(
    "all child pages visible on observer",
    () =>
      Array.from(pageTable(observer).iter()).filter(
        (p) => p.parentId === parent.id,
      ).length >= PAGES,
    60000,
  );
  console.log(
    `[bench] setup done in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );

  // --- Churn: driver renames, observer timestamps delivery ---
  const childIds = Array.from(pageTable(observer).iter())
    .filter((p) => p.parentId === parent.id)
    .map((p) => p.id);

  const pending = new Map<string, number>(); // nonce title → t0
  const latencies: number[] = [];
  const compute: number[] = [];

  const table = pageTable(observer);
  if (!table.onUpdate) {
    throw new Error(
      "page table has no onUpdate on this SDK version — wire the row callback per current spacetimedb SDK docs",
    );
  }
  table.onUpdate((_ctx, _oldRow, newRow) => {
    const sent = pending.get(newRow.title);
    if (sent !== undefined) {
      latencies.push(performance.now() - sent);
      pending.delete(newRow.title);
      compute.push(sidebarComputeMs(observer, parent.id));
    }
  });

  console.log(`[bench] churning for ${DURATION}s…`);
  let seq = 0;
  const intervalMs = 1000 / RATE;
  const end = performance.now() + DURATION * 1000;
  while (performance.now() < end) {
    const id = childIds[seq % childIds.length];
    const title = `bench-page-${seq % childIds.length} r${seq}`;
    seq++;
    pending.set(title, performance.now());
    void callReducer(driver, "updatePageTitle", { pageId: id, title }).catch(
      (err) => console.error(`[bench] update failed: ${err}`),
    );
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  await new Promise((r) => setTimeout(r, 2000)); // drain stragglers

  // --- Report ---
  report("reducer call → observer delivery", latencies);
  report(
    `per-delivery sidebar compute (cache=${Array.from(pageTable(observer).iter()).length} pages, full re-eval)`,
    compute,
  );
  if (pending.size > 0)
    console.warn(`[bench] ${pending.size} updates never observed`);

  // --- Cleanup ---
  console.log(`[bench] cleaning up ${childIds.length + 1} pages…`);
  for (const id of [...childIds, parent.id]) {
    try {
      await callReducer(driver, "deletePage", { pageId: id });
      await callReducer(driver, "purgePage", { pageId: id });
    } catch (err) {
      console.warn(`[bench] cleanup failed for page ${id}: ${err}`);
    }
  }
  console.log("[bench] done");
  process.exit(0);
}

main().catch((err) => {
  console.error(`[bench] fatal: ${err}`);
  process.exit(1);
});
