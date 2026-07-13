import { encodePearValue } from "./encodePearValue";
import { SNAPSHOT_TABLES_V2 } from "./tablePolicy";

/** Pear portable snapshot format (JSON). Version 2. */
export const PEAR_SNAPSHOT_FORMAT_V2 = "pear-snapshot-v2" as const;

export type PearSnapshotV2 = {
  format: typeof PEAR_SNAPSHOT_FORMAT_V2;
  exportedAt: string;
  workspace: { wsUri: string; dbName: string };
  moduleVersion?: string;
  /** Encoded rows keyed by snake_case table sourceName, in include-list order. */
  tables: Record<string, unknown[]>;
  /** Row count per table (same keys as `tables`). */
  counts: Record<string, number>;
  /** Object-storage keys referenced by the exported rows (attachments, chat uploads, component props). */
  blobManifest: { storageKeys: string[] };
};

/**
 * Shape of one entry in the generated bindings' `tables` registry
 * (`import { tables } from ".../module_bindings"`). Same metadata the worker's
 * subscriptions.ts derives table names from — never a hand-maintained list.
 */
export type SnapshotTableRegistryEntry = {
  sourceName?: string;
  accessorName?: string;
  tableDef?: {
    sourceName?: string;
    accessorName?: string;
  };
};

export type SnapshotTableRegistry = Record<string, SnapshotTableRegistryEntry>;

type IterableTable = { iter: () => Iterable<unknown> };

/**
 * Map each snake_case table sourceName in `tableNames` to its live accessor on
 * `db` (the connection's ClientDbView), using the bindings registry to translate
 * sourceName → accessorName (the SDK keys the db view by `accessorName`, which is
 * NOT guaranteed to equal the sourceName).
 *
 * Hard-errors (throws) if any requested table cannot be resolved to an iterable
 * accessor — a silently-skipped table would produce a snapshot that looks fine
 * but is missing data (the v1 exporter's failure mode).
 */
export function resolveSnapshotTableAccessors(
  db: unknown,
  tablesRegistry: SnapshotTableRegistry,
  tableNames: readonly string[] = SNAPSHOT_TABLES_V2
): Map<string, IterableTable> {
  const accessorBySource = new Map<string, string>();
  for (const [key, entry] of Object.entries(tablesRegistry)) {
    const sourceName = entry.sourceName ?? entry.tableDef?.sourceName;
    const accessorName = entry.accessorName ?? entry.tableDef?.accessorName ?? key;
    if (sourceName) accessorBySource.set(sourceName, accessorName);
  }

  const dbRec = (db ?? undefined) as Record<string, unknown> | undefined;
  const resolved = new Map<string, IterableTable>();
  const missing: string[] = [];

  for (const name of tableNames) {
    const accessorName = accessorBySource.get(name);
    const table = accessorName !== undefined && dbRec ? dbRec[accessorName] : undefined;
    if (!table || typeof (table as IterableTable).iter !== "function") {
      missing.push(name);
      continue;
    }
    resolved.set(name, table as IterableTable);
  }

  if (missing.length > 0) {
    throw new Error(
      `pear-snapshot-v2 export: could not resolve a db accessor for table(s): ${missing.join(", ")}. ` +
        "The module bindings and snapshot_tables_v2.json are out of sync — refusing to export a partial snapshot."
    );
  }
  return resolved;
}

export type PearSnapshotV2Meta = {
  wsUri: string;
  dbName: string;
  moduleVersion?: string;
  /** The generated bindings' `tables` registry (see SnapshotTableRegistry). */
  tablesRegistry: SnapshotTableRegistry;
};

export function buildPearSnapshotV2(db: unknown, meta: PearSnapshotV2Meta): PearSnapshotV2 {
  const accessors = resolveSnapshotTableAccessors(db, meta.tablesRegistry);

  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const storageKeys = new Set<string>();

  for (const name of SNAPSHOT_TABLES_V2) {
    const table = accessors.get(name);
    if (!table) throw new Error(`pear-snapshot-v2 export: missing accessor for "${name}"`); // unreachable
    const rows: unknown[] = [];
    for (const row of table.iter()) {
      collectBlobStorageKeys(name, row, storageKeys);
      rows.push(encodePearValue(row));
    }
    tables[name] = rows;
    counts[name] = rows.length;
  }

  return {
    format: PEAR_SNAPSHOT_FORMAT_V2,
    exportedAt: new Date().toISOString(),
    workspace: { wsUri: meta.wsUri, dbName: meta.dbName },
    ...(meta.moduleVersion !== undefined ? { moduleVersion: meta.moduleVersion } : {}),
    tables,
    counts,
    blobManifest: { storageKeys: [...storageKeys] },
  };
}

/** Pull object-storage keys out of a raw (pre-encoding) row of a blob-bearing table. */
function collectBlobStorageKeys(tableName: string, row: unknown, out: Set<string>): void {
  if (!row || typeof row !== "object") return;
  const r = row as Record<string, unknown>;

  if (tableName === "attachment") {
    if (typeof r.storageKey === "string" && r.storageKey !== "") out.add(r.storageKey);
    return;
  }
  if (tableName === "conversation_attachment") {
    // objectKey is optional (upload may not have completed); skip null/undefined.
    if (typeof r.objectKey === "string" && r.objectKey !== "") out.add(r.objectKey);
    return;
  }
  if (tableName === "component_node") {
    if (typeof r.props !== "string" || r.props === "") return;
    let props: unknown;
    try {
      props = JSON.parse(r.props);
    } catch {
      return; // malformed props JSON — nothing to collect
    }
    collectStorageKeyProps(props, out);
  }
}

function collectStorageKeyProps(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStorageKeyProps(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "storageKey" && typeof v === "string" && v !== "") {
      out.add(v);
    } else {
      collectStorageKeyProps(v, out);
    }
  }
}

// ── Chunking ─────────────────────────────────────────────────────────────────

export type PearSnapshotV2Header = {
  format: typeof PEAR_SNAPSHOT_FORMAT_V2;
  exportedAt: string;
  workspace: { wsUri: string; dbName: string };
  moduleVersion?: string;
};

export type PearSnapshotV2Chunk = {
  /** 1-based, contiguous across the whole snapshot, deterministic. */
  seq: number;
  tableName: string;
  /** JSON array string of encoded rows; UTF-8 length ≤ maxBytes unless `oversized`. */
  rowsJson: string;
  /** Set when a single row alone exceeds maxBytes and ships as its own chunk. */
  oversized?: true;
};

export type PearSnapshotV2Manifest = {
  counts: Record<string, number>;
};

export type ChunkedPearSnapshotV2 = {
  header: PearSnapshotV2Header;
  chunks: PearSnapshotV2Chunk[];
  manifest: PearSnapshotV2Manifest;
};

const utf8Encoder = new TextEncoder();

function utf8Length(s: string): number {
  return utf8Encoder.encode(s).length;
}

/**
 * Split a snapshot into reducer-sized pieces: a begin header, ordered row chunks
 * (each rowsJson a JSON array string of ≤ maxBytes, except a single row that is
 * itself larger than maxBytes, which ships alone flagged `oversized`), and a
 * commit manifest with the expected row counts.
 */
export function chunkSnapshotV2(
  snapshot: PearSnapshotV2,
  maxBytes = 1_000_000
): ChunkedPearSnapshotV2 {
  if (!Number.isFinite(maxBytes) || maxBytes < 2) {
    throw new Error(`chunkSnapshotV2: maxBytes must be a finite number >= 2, got ${maxBytes}`);
  }

  const chunks: PearSnapshotV2Chunk[] = [];
  let seq = 1;

  for (const [tableName, rows] of Object.entries(snapshot.tables)) {
    let pending: string[] = [];
    let pendingRowBytes = 0; // sum of UTF-8 lengths of pending row JSON strings

    const flush = (oversized = false): void => {
      if (pending.length === 0) return;
      const chunk: PearSnapshotV2Chunk = {
        seq: seq++,
        tableName,
        rowsJson: `[${pending.join(",")}]`,
      };
      if (oversized) chunk.oversized = true;
      chunks.push(chunk);
      pending = [];
      pendingRowBytes = 0;
    };

    for (const row of rows) {
      const rowJson = JSON.stringify(row);
      const rowBytes = utf8Length(rowJson);

      if (rowBytes + 2 > maxBytes) {
        // A huge single row can't fit any chunk: give it its own, flagged.
        flush();
        pending = [rowJson];
        pendingRowBytes = rowBytes;
        flush(true);
        continue;
      }

      // Chunk size if we add this row: brackets + rows + commas (pending.length
      // commas once this row joins the pending ones).
      const projectedBytes = 2 + pendingRowBytes + rowBytes + pending.length;
      if (pending.length > 0 && projectedBytes > maxBytes) flush();

      pending.push(rowJson);
      pendingRowBytes += rowBytes;
    }
    flush();
  }

  return {
    header: {
      format: snapshot.format,
      exportedAt: snapshot.exportedAt,
      workspace: snapshot.workspace,
      ...(snapshot.moduleVersion !== undefined ? { moduleVersion: snapshot.moduleVersion } : {}),
    },
    chunks,
    manifest: { counts: snapshot.counts },
  };
}
