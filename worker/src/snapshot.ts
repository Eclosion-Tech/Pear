/**
 * Server-side pear-snapshot-v2 builder (ticket 422, Phase B).
 *
 * Builds a complete workspace snapshot the way the web export does — a
 * dedicated SDK connection + subscribe-all + `buildPearSnapshotV2` from
 * @eclosion-tech/snapshot-core — with one crucial difference:
 *
 * The admin token is NOT exempt from `client_visibility_filter` on
 * SUBSCRIPTIONS (see orcha/src/index.ts). Six include-list tables carry RLS
 * filters and would be silently partial if read via subscription
 * (`RLS_SQL_TABLES` below). The database OWNER *does* bypass RLS on the HTTP
 * `POST /v1/database/{db}/sql` endpoint (verified live), so those six tables
 * are read via `/sql` and their positional SATS-JSON rows re-encoded into the
 * exact camelCase `__pear`-tagged format `encodePearValue` produces for
 * subscription rows (the format the import_v2_* reducers parse).
 *
 * Finally, EVERY include-list table's snapshot row count is cross-checked
 * against `/sql SELECT COUNT(*)` — a mismatch throws. Backups fail loudly;
 * they never silently truncate.
 */

import { DbConnection, tables } from "./module_bindings/index.js";
import {
  buildPearSnapshotV2,
  chunkSnapshotV2,
  SNAPSHOT_TABLES_V2,
  type ChunkedPearSnapshotV2,
  type PearSnapshotV2,
} from "../../packages/snapshot-core/src/index.js";

/**
 * Include-list tables with a `client_visibility_filter` in the module
 * (pear/server/spacetimedb/src/{conversations,api_endpoints,bridge}/mod.rs).
 * Subscriptions — even with the admin token — only deliver the caller's own
 * rows for these, so the snapshot reads them via the owner-privileged HTTP
 * /sql endpoint instead.
 */
export const RLS_SQL_TABLES: readonly string[] = [
  "api_endpoint_key",
  "message_feedback",
  "bridge_command",
  "bridge_command_result",
  "bridge_device_allowlist",
  "bridge_device_grant",
];

/** Include-list tables that are safe (complete) to read via subscription. */
export const SUBSCRIPTION_TABLES: readonly string[] = SNAPSHOT_TABLES_V2.filter(
  (name) => !RLS_SQL_TABLES.includes(name),
);

// ── /sql HTTP access ─────────────────────────────────────────────────────────

/** One statement result from POST /v1/database/{db}/sql. */
export type SqlStatementResult = {
  schema: { elements: SqlSchemaElement[] };
  rows: unknown[][];
};

export type SqlSchemaElement = {
  name: { some?: string; none?: unknown[] } | null;
  algebraic_type: SatsTypeJson;
};

/** SATS-JSON algebraic type, as returned in the /sql response schema. */
export type SatsTypeJson =
  | { Product: { elements: SqlSchemaElement[] } }
  | { Sum: { variants: SqlSchemaElement[] } }
  | { Array: SatsTypeJson }
  | Record<string, unknown>; // primitives: { U64: [] }, { String: [] }, …

let jsonParseSupportsSource: boolean | undefined;

function detectJsonParseSource(): boolean {
  if (jsonParseSupportsSource === undefined) {
    let seen = false;
    try {
      JSON.parse("0", ((_k: string, v: unknown, ctx?: { source?: string }) => {
        seen = typeof ctx?.source === "string";
        return v;
      }) as unknown as (key: string, value: unknown) => unknown);
    } catch {
      seen = false;
    }
    jsonParseSupportsSource = seen;
  }
  return jsonParseSupportsSource;
}

/**
 * JSON.parse that keeps integers beyond Number.MAX_SAFE_INTEGER exact by
 * parsing them as BigInt (uses the reviver `context.source` argument,
 * available on Node ≥ 21). SpacetimeDB serializes u64/i64 as bare JSON
 * numbers, so a plain JSON.parse would silently corrupt large ids.
 *
 * On runtimes without source access, unsafe integers surface as
 * imprecise numbers and `bigColumnToString` throws when one reaches a
 * 64-bit column — corruption is never silent either way.
 */
export function parseSqlJson(text: string): unknown {
  if (!detectJsonParseSource()) return JSON.parse(text);
  return JSON.parse(text, ((_k: string, value: unknown, ctx?: { source?: string }) => {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value) &&
      typeof ctx?.source === "string" &&
      /^-?\d+$/.test(ctx.source)
    ) {
      return BigInt(ctx.source);
    }
    return value;
  }) as unknown as (key: string, value: unknown) => unknown);
}

export type SqlHttpOptions = {
  httpBaseUrl: string;
  dbName: string;
  adminToken: string;
};

/** POST one SQL statement to the owner-privileged /sql endpoint. */
export async function sqlQuery(
  opts: SqlHttpOptions,
  sql: string,
): Promise<SqlStatementResult> {
  const url = `${opts.httpBaseUrl.replace(/\/$/, "")}/v1/database/${opts.dbName}/sql`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.adminToken}` },
    body: sql,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `/sql ${sql.slice(0, 60)} → HTTP ${resp.status} ${resp.statusText}: ${body.slice(0, 300)}`,
    );
  }
  const parsed = parseSqlJson(await resp.text());
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`/sql ${sql.slice(0, 60)} → unexpected response shape`);
  }
  return parsed[0] as SqlStatementResult;
}

export async function sqlCount(opts: SqlHttpOptions, table: string): Promise<number> {
  const res = await sqlQuery(opts, `SELECT COUNT(*) AS n FROM ${table}`);
  const raw = res.rows?.[0]?.[0];
  const n = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`COUNT(*) for "${table}" returned non-numeric value: ${String(raw)}`);
  }
  return n;
}

// ── SATS-JSON → __pear re-encoding ───────────────────────────────────────────
//
// /sql returns positional rows: products (incl. the row itself) as arrays of
// element values, sums as `[variantIndex, payload]`, Array<U8> as a hex
// string, u64/i64 as bare JSON numbers, u128+/Identity as "0x…" hex strings.
// The re-encoder walks the response schema and rebuilds exactly what
// `encodePearValue(row)` yields for the same row read via subscription:
// camelCase keys, `{ __pear: … }` tags, `{ tag, value? }` sums, null options.

const INT64_PLUS_TYPES = new Set(["U64", "I64", "U128", "I128", "U256", "I256"]);
const SMALL_NUMBER_TYPES = new Set(["U8", "U16", "U32", "I8", "I16", "I32", "F32", "F64"]);

export function snakeToCamel(name: string): string {
  return name.replace(/_([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Schema variant names are lowerCamelCase; the TS SDK codegen PascalCases them. */
function pascalTag(name: string): string {
  return name.length === 0 ? name : name[0].toUpperCase() + name.slice(1);
}

function elementName(el: SqlSchemaElement): string | undefined {
  const n = el.name;
  if (n && typeof n === "object" && typeof (n as { some?: unknown }).some === "string") {
    return (n as { some: string }).some;
  }
  return undefined;
}

function typeTag(t: SatsTypeJson): string {
  const keys = Object.keys(t as Record<string, unknown>);
  if (keys.length !== 1) {
    throw new Error(`Unrecognized SATS type (${keys.length} keys): ${JSON.stringify(t).slice(0, 120)}`);
  }
  return keys[0];
}

/** 64-bit-or-wider integer column value → decimal string, refusing imprecision. */
function bigColumnToString(value: unknown, context: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `${context}: integer ${value} exceeds Number.MAX_SAFE_INTEGER and JSON.parse ` +
          "source access is unavailable — refusing to emit an imprecise value",
      );
    }
    return String(value);
  }
  if (typeof value === "string") {
    // u128/u256 serialize as "0x…" hex; BigInt() accepts both hex and decimal.
    return BigInt(value).toString();
  }
  throw new Error(`${context}: expected integer, got ${JSON.stringify(value)?.slice(0, 80)}`);
}

/**
 * Identity value ("0x…" hex string from /sql) → SDK toHexString() format.
 * /sql drops leading zero nibbles ("0x79caf…") while the SDK zero-pads to the
 * full 32 bytes ("079caf…") — verified live — so pad to 64 hex chars.
 */
function identityHex(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context}: expected identity hex string, got ${JSON.stringify(value)?.slice(0, 80)}`);
  }
  const clean = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return clean.toLowerCase().padStart(64, "0");
}

function hexToBase64(hex: string, context: string): string {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) {
    throw new Error(`${context}: Array<U8> value is not a hex string: ${clean.slice(0, 40)}`);
  }
  return Buffer.from(clean, "hex").toString("base64");
}

/** True when a Sum is an Option (exactly the some/none variants). */
function isOptionSum(variants: SqlSchemaElement[]): boolean {
  if (variants.length !== 2) return false;
  const names = variants.map(elementName);
  return names.includes("some") && names.includes("none");
}

/**
 * Re-encode one positional SATS-JSON value from /sql into the `__pear`-tagged
 * camelCase shape `encodePearValue` produces for the same value read via a
 * subscription. `context` is a human-readable path for error messages.
 */
export function reencodeSqlValue(type: SatsTypeJson, value: unknown, context: string): unknown {
  const tag = typeTag(type);

  if (tag === "String") {
    if (typeof value !== "string") throw new Error(`${context}: expected string`);
    return value;
  }
  if (tag === "Bool") {
    if (typeof value !== "boolean") throw new Error(`${context}: expected boolean`);
    return value;
  }
  if (SMALL_NUMBER_TYPES.has(tag)) {
    const n = typeof value === "bigint" ? Number(value) : value;
    if (typeof n !== "number") throw new Error(`${context}: expected number for ${tag}`);
    return n;
  }
  if (INT64_PLUS_TYPES.has(tag)) {
    return { __pear: "bigint", v: bigColumnToString(value, `${context} (${tag})`) };
  }

  if (tag === "Array") {
    const elemType = (type as { Array: SatsTypeJson }).Array;
    if (typeTag(elemType) === "U8") {
      return { __pear: "bytes", v: hexToBase64(value as string, context) };
    }
    if (!Array.isArray(value)) throw new Error(`${context}: expected array`);
    return value.map((v, i) => reencodeSqlValue(elemType, v, `${context}[${i}]`));
  }

  if (tag === "Product") {
    const elements = (type as { Product: { elements: SqlSchemaElement[] } }).Product.elements;
    if (!Array.isArray(value) || value.length !== elements.length) {
      throw new Error(
        `${context}: expected product of ${elements.length} element(s), got ${JSON.stringify(value)?.slice(0, 80)}`,
      );
    }
    // SpacetimeDB special product types → __pear tags (match encodePearValue).
    if (elements.length === 1) {
      const only = elementName(elements[0]);
      if (only === "__identity__") {
        return { __pear: "identity", v: identityHex(value[0], context) };
      }
      if (only === "__timestamp_micros_since_unix_epoch__") {
        return { __pear: "timestamp", v: bigColumnToString(value[0], context) };
      }
      if (only === "__time_duration_micros__") {
        return { __pear: "bigint", v: bigColumnToString(value[0], context) };
      }
    }
    const out: Record<string, unknown> = {};
    for (let i = 0; i < elements.length; i++) {
      const name = elementName(elements[i]);
      if (name === undefined) {
        throw new Error(`${context}: product element ${i} is unnamed — cannot re-encode`);
      }
      const encoded = reencodeSqlValue(elements[i].algebraic_type, value[i], `${context}.${name}`);
      // Option-none fields are absent from the SDK row objects, so the web
      // export's JSON omits those keys entirely (verified live). Match that.
      if (encoded !== undefined) out[snakeToCamel(name)] = encoded;
    }
    return out;
  }

  if (tag === "Sum") {
    const variants = (type as { Sum: { variants: SqlSchemaElement[] } }).Sum.variants;
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number") {
      throw new Error(
        `${context}: expected sum value [variantIndex, payload], got ${JSON.stringify(value)?.slice(0, 80)}`,
      );
    }
    const [idx, payload] = value as [number, unknown];
    const variant = variants[idx];
    if (!variant) throw new Error(`${context}: sum variant index ${idx} out of range`);
    const variantName = elementName(variant);
    if (variantName === undefined) {
      throw new Error(`${context}: sum variant ${idx} is unnamed — cannot re-encode`);
    }

    if (isOptionSum(variants)) {
      // None encodes as an absent key in SDK rows (see the Product branch).
      if (variantName === "none") return undefined;
      return reencodeSqlValue(variant.algebraic_type, payload, `${context}.some`);
    }

    // Named-variant sum → the SDK's tagged shape { tag, value }. Unit variants
    // carry an empty product, so their payload re-encodes to {} — exactly what
    // the SDK yields (e.g. { tag: "Doc", value: {} }, verified live).
    return {
      tag: pascalTag(variantName),
      value: reencodeSqlValue(variant.algebraic_type, payload, `${context}.${variantName}`),
    };
  }

  throw new Error(`${context}: unsupported SATS type "${tag}"`);
}

/** Re-encode a whole /sql statement result into __pear-format row objects. */
export function reencodeSqlTableRows(
  result: SqlStatementResult,
  tableName: string,
): Record<string, unknown>[] {
  const elements = result.schema?.elements;
  if (!Array.isArray(elements)) {
    throw new Error(`/sql result for "${tableName}" has no schema.elements`);
  }
  const rowType: SatsTypeJson = { Product: { elements } };
  return (result.rows ?? []).map(
    (row, i) => reencodeSqlValue(rowType, row, `${tableName}[${i}]`) as Record<string, unknown>,
  );
}

// ── Completeness cross-check ─────────────────────────────────────────────────

/**
 * Throws unless every include-list table's snapshot count matches the
 * authoritative /sql count. A mismatch means the snapshot is partial (RLS,
 * dropped subscription, mid-snapshot writes) — backups must fail loudly.
 */
export function assertSnapshotCountsMatch(
  snapshotCounts: Record<string, number>,
  sqlCounts: Record<string, number>,
): void {
  const mismatches: string[] = [];
  for (const table of SNAPSHOT_TABLES_V2) {
    const snap = snapshotCounts[table];
    const sql = sqlCounts[table];
    if (snap !== sql) {
      mismatches.push(`${table}: snapshot=${snap ?? "missing"} sql=${sql ?? "missing"}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Snapshot row-count cross-check failed for ${mismatches.length} table(s) — refusing to ` +
        `upload a partial backup: ${mismatches.join("; ")}`,
    );
  }
}

// ── Connection + subscription plumbing ───────────────────────────────────────

const CONNECT_TIMEOUT_MS = 30_000;
const SUBSCRIBE_TIMEOUT_MS = 180_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function connectOnce(uri: string, dbName: string, token: string): Promise<DbConnection> {
  return withTimeout(
    new Promise<DbConnection>((resolve, reject) => {
      DbConnection.builder()
        .withUri(uri)
        .withDatabaseName(dbName)
        .withToken(token)
        .onConnect((conn) => resolve(conn))
        .onConnectError((_ctx, err) =>
          reject(err instanceof Error ? err : new Error(String(err))),
        )
        .build();
    }),
    CONNECT_TIMEOUT_MS,
    `connection to ${uri}/${dbName}`,
  );
}

/**
 * Subscribe to the non-RLS include-list tables and resolve once the initial
 * snapshot is applied. Unlike the worker's resilient subscribe-all (which
 * skips missing tables), ANY subscription error rejects: a skipped table
 * would mean a silently partial backup.
 */
function subscribeAllApplied(conn: DbConnection, dbName: string): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      (conn as unknown as {
        subscriptionBuilder(): {
          onApplied(cb: () => void): unknown;
          onError(cb: (_ctx: unknown, err: unknown) => void): unknown;
          subscribe(queries: string[]): unknown;
        };
      })
        .subscriptionBuilder()
        .onApplied(() => resolve())
        .onError((_ctx: unknown, err: unknown) =>
          reject(
            new Error(
              `snapshot subscription error on "${dbName}": ${err instanceof Error ? err.message : String(err)}`,
            ),
          ),
        )
        .subscribe(SUBSCRIPTION_TABLES.map((name) => `SELECT * FROM ${name}`));
    }),
    SUBSCRIBE_TIMEOUT_MS,
    `subscription apply on ${dbName}`,
  );
}

/** Newest module version recorded in the public migration_state table (via /sql). */
async function readModuleVersionSql(opts: SqlHttpOptions): Promise<string | undefined> {
  try {
    const res = await sqlQuery(opts, "SELECT * FROM migration_state");
    const elements = res.schema?.elements ?? [];
    const versionIdx = elements.findIndex((e) => elementName(e) === "module_version");
    const completedIdx = elements.findIndex((e) => elementName(e) === "completed_at");
    if (versionIdx < 0) return undefined;
    let best: string | undefined;
    let bestAt = -1n;
    for (const row of res.rows ?? []) {
      const v = row[versionIdx];
      if (typeof v !== "string") continue;
      let at = 0n;
      const completed = completedIdx >= 0 ? row[completedIdx] : undefined;
      if (Array.isArray(completed) && completed.length === 1) {
        try {
          at = BigInt(completed[0] as string | number | bigint);
        } catch {
          at = 0n;
        }
      }
      if (at >= bestAt) {
        best = v;
        bestAt = at;
      }
    }
    return best;
  } catch {
    return undefined; // best-effort, like the web export
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

export type BuildServerSnapshotV2Options = {
  /** SpacetimeDB WebSocket base, e.g. ws://localhost:3000 */
  uri: string;
  dbName: string;
  adminToken: string;
  /** SpacetimeDB HTTP base for /sql, e.g. http://localhost:3000 */
  httpBaseUrl: string;
};

export type ServerSnapshotV2 = ChunkedPearSnapshotV2 & {
  snapshot: PearSnapshotV2;
};

/**
 * Build a complete, count-verified pear-snapshot-v2 of one workspace database
 * using the admin token. See module docs for the subscription-vs-/sql split.
 */
export async function buildServerSnapshotV2(
  opts: BuildServerSnapshotV2Options,
): Promise<ServerSnapshotV2> {
  const sqlOpts: SqlHttpOptions = {
    httpBaseUrl: opts.httpBaseUrl,
    dbName: opts.dbName,
    adminToken: opts.adminToken,
  };

  const conn = await connectOnce(opts.uri, opts.dbName, opts.adminToken);
  let snapshot: PearSnapshotV2;
  try {
    await subscribeAllApplied(conn, opts.dbName);
    const moduleVersion = await readModuleVersionSql(sqlOpts);
    // Synchronous over the applied client cache — a point-in-time read.
    snapshot = buildPearSnapshotV2(conn.db, {
      wsUri: opts.uri,
      dbName: opts.dbName,
      ...(moduleVersion !== undefined ? { moduleVersion } : {}),
      tablesRegistry: tables as never,
    });
  } finally {
    try {
      conn.disconnect();
    } catch {
      // already closed
    }
  }

  // RLS'd tables: owner-privileged /sql read, re-encoded to the __pear format.
  for (const table of RLS_SQL_TABLES) {
    const result = await sqlQuery(sqlOpts, `SELECT * FROM ${table}`);
    const rows = reencodeSqlTableRows(result, table);
    snapshot.tables[table] = rows;
    snapshot.counts[table] = rows.length;
  }

  // Completeness cross-check: every include-list table, snapshot vs /sql.
  const sqlCounts: Record<string, number> = {};
  for (const table of SNAPSHOT_TABLES_V2) {
    sqlCounts[table] = await sqlCount(sqlOpts, table);
  }
  assertSnapshotCountsMatch(snapshot.counts, sqlCounts);

  const chunked = chunkSnapshotV2(snapshot);
  return { snapshot, ...chunked };
}
