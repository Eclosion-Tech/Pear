import { describe, expect, test } from "vitest";
import { ScheduleAt } from "spacetimedb";

import {
  PEAR_SNAPSHOT_FORMAT,
  PEAR_SNAPSHOT_FORMAT_V2,
  SNAPSHOT_TABLES_V2,
  buildPearSnapshotV2,
  chunkSnapshotV2,
  encodePearValue,
  parsePearSnapshotJson,
  resolveSnapshotTableAccessors,
  type PearSnapshotV2,
  type SnapshotTableRegistry,
} from "./pearExport";
import { tables } from "../module_bindings";
import tablePolicy from "../../../server/spacetimedb/snapshot_tables_v2.json";

// The generated bindings' `tables` registry, viewed through the minimal shape
// snapshot-core needs (same metadata worker/src/subscriptions.ts derives table
// names from).
const registry = tables as unknown as SnapshotTableRegistry;

/**
 * `#[view(...)]` functions appear in the generated bindings' table registry but
 * are NOT module tables (nothing to export/restore), so they are outside the
 * snapshot_tables_v2.json policy. The client bindings carry no explicit view
 * marker, so this list is maintained here — and each entry is structurally
 * verified below (views have no primary key, indexes, or constraints), so a
 * stale entry fails loudly.
 */
const KNOWN_VIEWS = new Set(["api_endpoint_key_lookup"]);

function bindingsSourceNames(): string[] {
  // Same derivation as worker/src/subscriptions.ts.
  return Object.values(registry)
    .map((t) => t.sourceName ?? t.tableDef?.sourceName)
    .filter((name): name is string => Boolean(name));
}

/** A db object shaped like the SDK's ClientDbView: keyed by accessorName. */
function makeFakeDb(
  rowsBySource: Record<string, unknown[]> = {}
): Record<string, { iter: () => unknown[] }> {
  const db: Record<string, { iter: () => unknown[] }> = {};
  for (const entry of Object.values(registry)) {
    const sourceName = entry.sourceName ?? entry.tableDef?.sourceName;
    const accessorName = entry.accessorName ?? entry.tableDef?.accessorName;
    if (!sourceName || !accessorName) continue;
    const rows = rowsBySource[sourceName] ?? [];
    db[accessorName] = { iter: () => rows };
  }
  return db;
}

const BASE_META = {
  wsUri: "ws://localhost:3000",
  dbName: "pear-test",
  tablesRegistry: registry,
};

describe("snapshot_tables_v2.json drift", () => {
  test("KNOWN_VIEWS entries exist in bindings and are structurally views", () => {
    for (const view of KNOWN_VIEWS) {
      const entry = Object.values(registry).find(
        (t) => (t.sourceName ?? t.tableDef?.sourceName) === view
      ) as
        | { indexes?: unknown[]; constraints?: unknown[] }
        | undefined;
      expect(entry, `KNOWN_VIEWS entry "${view}" not found in bindings`).toBeDefined();
      expect(
        entry?.indexes,
        `"${view}" has indexes — it looks like a real table, remove it from KNOWN_VIEWS`
      ).toEqual([]);
      expect(
        entry?.constraints,
        `"${view}" has constraints — it looks like a real table, remove it from KNOWN_VIEWS`
      ).toEqual([]);
    }
  });

  test("policy include/exclude do not overlap", () => {
    const overlap = tablePolicy.include.filter((t) =>
      Object.prototype.hasOwnProperty.call(tablePolicy.exclude, t)
    );
    expect(overlap, `tables in both include and exclude: ${overlap.join(", ")}`).toEqual([]);
  });

  test("bindings tables equal include ∪ exclude exactly (both directions)", () => {
    const fromBindings = new Set(bindingsSourceNames().filter((n) => !KNOWN_VIEWS.has(n)));
    const fromPolicy = new Set([...tablePolicy.include, ...Object.keys(tablePolicy.exclude)]);

    const missingFromPolicy = [...fromBindings].filter((n) => !fromPolicy.has(n)).sort();
    const missingFromBindings = [...fromPolicy].filter((n) => !fromBindings.has(n)).sort();

    expect(
      missingFromPolicy,
      `Public module table(s) present in the generated bindings but missing from ` +
        `server/spacetimedb/snapshot_tables_v2.json — add each to "include" or "exclude": ` +
        missingFromPolicy.join(", ")
    ).toEqual([]);
    expect(
      missingFromBindings,
      `Table(s) listed in server/spacetimedb/snapshot_tables_v2.json but absent from the ` +
        `generated bindings — regenerate bindings or remove them from the policy: ` +
        missingFromBindings.join(", ")
    ).toEqual([]);
  });

  test("SNAPSHOT_TABLES_V2 is wired to the canonical JSON include list", () => {
    expect([...SNAPSHOT_TABLES_V2]).toEqual(tablePolicy.include);
  });
});

describe("encodePearValue", () => {
  test("bigint", () => {
    expect(encodePearValue(123n)).toEqual({ __pear: "bigint", v: "123" });
    expect(encodePearValue(-9007199254740993n)).toEqual({
      __pear: "bigint",
      v: "-9007199254740993",
    });
  });

  test("Uint8Array → base64 bytes", () => {
    expect(encodePearValue(new Uint8Array([1, 2, 3]))).toEqual({ __pear: "bytes", v: "AQID" });
    expect(encodePearValue(new Uint8Array([]))).toEqual({ __pear: "bytes", v: "" });
  });

  test("Identity-like ({toHexString})", () => {
    const identity = { toHexString: () => "0xdeadbeef" };
    expect(encodePearValue(identity)).toEqual({ __pear: "identity", v: "0xdeadbeef" });
  });

  test("Timestamp-like ({microsSinceUnixEpoch: bigint})", () => {
    const ts = { microsSinceUnixEpoch: 1720000000000000n };
    expect(encodePearValue(ts)).toEqual({ __pear: "timestamp", v: "1720000000000000" });
  });

  test("ScheduleAt Interval variant → { tag, value: tagged bigint micros }", () => {
    // Real SDK runtime shape: { tag: "Interval", value: TimeDuration }.
    // The v2 import reducers expect exactly this encoding for
    // ai_user_routine.scheduledAt.
    const row = { scheduledId: 1n, scheduledAt: ScheduleAt.interval(5_000_000n) };
    expect(encodePearValue(row)).toEqual({
      scheduledId: { __pear: "bigint", v: "1" },
      scheduledAt: { tag: "Interval", value: { __pear: "bigint", v: "5000000" } },
    });
  });

  test("ScheduleAt Time variant → { tag, value: tagged timestamp }", () => {
    // Real SDK runtime shape: { tag: "Time", value: Timestamp }.
    const row = { scheduledId: 2n, scheduledAt: ScheduleAt.time(1_720_000_000_000_000n) };
    expect(encodePearValue(row)).toEqual({
      scheduledId: { __pear: "bigint", v: "2" },
      scheduledAt: { tag: "Time", value: { __pear: "timestamp", v: "1720000000000000" } },
    });
  });

  test("primitives and null/undefined pass through", () => {
    expect(encodePearValue(null)).toBeNull();
    expect(encodePearValue(undefined)).toBeUndefined();
    expect(encodePearValue(42)).toBe(42);
    expect(encodePearValue(true)).toBe(true);
    expect(encodePearValue("hi")).toBe("hi");
  });

  test("nested arrays and objects encode recursively", () => {
    const input = {
      id: 7n,
      blob: new Uint8Array([255]),
      list: [1n, { at: { microsSinceUnixEpoch: 5n }, name: "x" }],
      plain: { n: 1 },
    };
    expect(encodePearValue(input)).toEqual({
      id: { __pear: "bigint", v: "7" },
      blob: { __pear: "bytes", v: "/w==" },
      list: [
        { __pear: "bigint", v: "1" },
        { at: { __pear: "timestamp", v: "5" }, name: "x" },
      ],
      plain: { n: 1 },
    });
  });
});

describe("accessor-map resolution (no silent empty exports)", () => {
  test("every include-list table resolves against a bindings-shaped db", () => {
    const db = makeFakeDb();
    const resolved = resolveSnapshotTableAccessors(db, registry);
    expect([...resolved.keys()]).toEqual([...SNAPSHOT_TABLES_V2]);
  });

  test("a missing accessor hard-errors naming the table", () => {
    const db = makeFakeDb();
    const pageContentAccessor = Object.values(registry)
      .filter((t) => (t.sourceName ?? t.tableDef?.sourceName) === "page_content")
      .map((t) => t.accessorName ?? t.tableDef?.accessorName)[0];
    expect(pageContentAccessor).toBeDefined();
    delete db[pageContentAccessor as string];
    expect(() => resolveSnapshotTableAccessors(db, registry)).toThrowError(/page_content/);
  });

  test("an accessor without iter() hard-errors instead of exporting empty", () => {
    const db = makeFakeDb() as Record<string, unknown>;
    db["user"] = {}; // present but not iterable — v1 would have silently skipped this
    expect(() => resolveSnapshotTableAccessors(db, registry)).toThrowError(/\buser\b/);
  });

  test("buildPearSnapshotV2 covers exactly the include list", () => {
    const snap = buildPearSnapshotV2(makeFakeDb(), BASE_META);
    expect(Object.keys(snap.tables)).toEqual([...SNAPSHOT_TABLES_V2]);
    expect(Object.keys(snap.counts)).toEqual([...SNAPSHOT_TABLES_V2]);
    expect(snap.format).toBe(PEAR_SNAPSHOT_FORMAT_V2);
    expect(snap.workspace).toEqual({ wsUri: BASE_META.wsUri, dbName: BASE_META.dbName });
  });
});

describe("buildPearSnapshotV2 rows, counts and blobManifest", () => {
  test("rows are encoded and counted per table", () => {
    const snap = buildPearSnapshotV2(
      makeFakeDb({ user: [{ id: 1n, name: "a" }, { id: 2n, name: "b" }] }),
      BASE_META
    );
    expect(snap.counts.user).toBe(2);
    expect(snap.counts.page).toBe(0);
    expect(snap.tables.user).toEqual([
      { id: { __pear: "bigint", v: "1" }, name: "a" },
      { id: { __pear: "bigint", v: "2" }, name: "b" },
    ]);
  });

  test("blobManifest collects attachment/conversation_attachment/component_node keys, deduped", () => {
    const componentProps = JSON.stringify({
      storageKey: "comp/3.jpg",
      nested: { deeper: { storageKey: "att/1.png" } }, // duplicate of an attachment key
      list: [{ storageKey: "comp/4.png" }, { storageKey: "" }],
      numericStorageKey: { storageKey: 42 }, // non-string — ignored
      other: "x",
    });
    const snap = buildPearSnapshotV2(
      makeFakeDb({
        attachment: [
          { id: 1n, storageKey: "att/1.png" },
          { id: 2n, storageKey: "att/1.png" }, // duplicate
          { id: 3n, storageKey: "" }, // empty — ignored
        ],
        conversation_attachment: [
          { id: 1n, objectKey: "conv/2.pdf" },
          { id: 2n, objectKey: undefined }, // pending upload — skipped
        ],
        component_node: [
          { id: 1n, props: componentProps },
          { id: 2n, props: "not json {" }, // malformed — ignored
          { id: 3n, props: "" },
        ],
      }),
      BASE_META
    );
    expect([...snap.blobManifest.storageKeys].sort()).toEqual([
      "att/1.png",
      "comp/3.jpg",
      "comp/4.png",
      "conv/2.pdf",
    ]);
  });
});

describe("chunkSnapshotV2", () => {
  const utf8 = new TextEncoder();

  function makeSnapshot(tablesData: Record<string, unknown[]>): PearSnapshotV2 {
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(tablesData)) counts[k] = v.length;
    return {
      format: PEAR_SNAPSHOT_FORMAT_V2,
      exportedAt: "2026-07-11T00:00:00.000Z",
      workspace: { wsUri: "ws://x", dbName: "y" },
      moduleVersion: "0.19.0",
      tables: tablesData,
      counts,
      blobManifest: { storageKeys: [] },
    };
  }

  test("header and manifest carry the snapshot metadata and counts", () => {
    const snap = makeSnapshot({ user: [{ a: 1 }], page: [] });
    const { header, manifest } = chunkSnapshotV2(snap);
    expect(header).toEqual({
      format: PEAR_SNAPSHOT_FORMAT_V2,
      exportedAt: snap.exportedAt,
      workspace: snap.workspace,
      moduleVersion: "0.19.0",
    });
    expect(manifest).toEqual({ counts: { user: 1, page: 0 } });
  });

  test("reassembling chunk rows per table reproduces the snapshot; seq is contiguous from 1", () => {
    const rows = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({ id: i, tag, pad: "x".repeat(50) }));
    const snap = makeSnapshot({
      user: rows(37, "user"),
      page: [],
      page_content: rows(11, "pc"),
    });
    const { chunks } = chunkSnapshotV2(snap, 500);

    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i + 1));

    const reassembled: Record<string, unknown[]> = {};
    for (const chunk of chunks) {
      (reassembled[chunk.tableName] ??= []).push(...(JSON.parse(chunk.rowsJson) as unknown[]));
    }
    // Empty tables produce no chunks; they are represented by manifest.counts.
    expect(reassembled).toEqual({ user: snap.tables.user, page_content: snap.tables.page_content });
    expect(chunks.some((c) => c.tableName === "page")).toBe(false);
    // Multiple chunks were actually needed (the packing was exercised).
    expect(chunks.filter((c) => c.tableName === "user").length).toBeGreaterThan(1);
  });

  test("every chunk respects maxBytes except flagged oversized single rows", () => {
    const maxBytes = 300;
    const snap = makeSnapshot({
      user: [
        { id: 1, pad: "a".repeat(60) },
        { id: 2, pad: "b".repeat(60) },
        { id: 3, pad: "€".repeat(400) }, // multibyte, alone exceeds maxBytes
        { id: 4, pad: "c".repeat(60) },
      ],
    });
    const { chunks } = chunkSnapshotV2(snap, maxBytes);
    for (const chunk of chunks) {
      const size = utf8.encode(chunk.rowsJson).length;
      if (chunk.oversized) {
        expect(size).toBeGreaterThan(maxBytes);
        expect((JSON.parse(chunk.rowsJson) as unknown[]).length).toBe(1);
      } else {
        expect(size).toBeLessThanOrEqual(maxBytes);
      }
    }
    expect(chunks.filter((c) => c.oversized).length).toBe(1);
    // Nothing lost around the oversized row.
    const reassembled = chunks.flatMap((c) => JSON.parse(c.rowsJson) as unknown[]);
    expect(reassembled).toEqual(snap.tables.user);
  });

  test("moduleVersion is omitted from the header when absent", () => {
    const snap = makeSnapshot({ user: [] });
    delete snap.moduleVersion;
    const { header } = chunkSnapshotV2(snap);
    expect("moduleVersion" in header).toBe(false);
  });
});

describe("parsePearSnapshotJson", () => {
  test("sniffs v1", () => {
    const v1 = JSON.stringify({
      format: PEAR_SNAPSHOT_FORMAT,
      exportedAt: "2026-01-01T00:00:00.000Z",
      workspace: { wsUri: "ws://x", dbName: "y" },
      tables: { user: [] },
    });
    const parsed = parsePearSnapshotJson(v1);
    expect(parsed.format).toBe(PEAR_SNAPSHOT_FORMAT);
    if (parsed.format === PEAR_SNAPSHOT_FORMAT) {
      expect(parsed.snapshot.tables.user).toEqual([]);
    }
  });

  test("sniffs v2", () => {
    const v2 = JSON.stringify({
      format: PEAR_SNAPSHOT_FORMAT_V2,
      exportedAt: "2026-01-01T00:00:00.000Z",
      workspace: { wsUri: "ws://x", dbName: "y" },
      tables: { user: [] },
      counts: { user: 0 },
      blobManifest: { storageKeys: [] },
    });
    const parsed = parsePearSnapshotJson(v2);
    expect(parsed.format).toBe(PEAR_SNAPSHOT_FORMAT_V2);
    if (parsed.format === PEAR_SNAPSHOT_FORMAT_V2) {
      expect(parsed.snapshot.counts).toEqual({ user: 0 });
    }
  });

  test("rejects unknown formats and malformed input with clear errors", () => {
    expect(() => parsePearSnapshotJson("not json")).toThrowError(/not valid JSON/);
    expect(() => parsePearSnapshotJson("[1,2]")).toThrowError(/expected a JSON object/);
    expect(() => parsePearSnapshotJson(JSON.stringify({ format: "pear-snapshot-v9" }))).toThrowError(
      /Unsupported snapshot format.*pear-snapshot-v9/
    );
    expect(() => parsePearSnapshotJson(JSON.stringify({ hello: 1 }))).toThrowError(
      /Unsupported snapshot format/
    );
    expect(() =>
      parsePearSnapshotJson(JSON.stringify({ format: PEAR_SNAPSHOT_FORMAT_V2, tables: {} }))
    ).toThrowError(/missing counts/);
  });
});
