/**
 * Database-page (structured rows) read/write over `/sql` + `/call` — the MCP
 * side of tasks 213/215/263.
 *
 * Read: `queryDatabase` returns columns + rows with decoded cell values,
 * offset-paginated with an explicit `truncated`/`next_offset` contract (the
 * chat surface's silent char-budget halving was task 263).
 * Write: `setRowProperties` sets columns on a row BY NAME — it resolves the
 * row's parent Database schema (including `parent_schema_id` inheritance),
 * coerces each value by the column's declared type, and calls the
 * `set_property_value` reducer per column.
 */

import type { StdbTransport } from "../api-endpoint";
import type { PageRow } from "./types";
import { getPageRow, listChildren } from "./pages";
import { decodeEnumVariant, orChain, toNumberOrNull, unwrapScalar } from "./decode";
import { encodeU64 } from "./encode";
import { reducerErrorMessage } from "./errors";

// Index→name arrays MUST match the Rust enum declaration order (schemas.rs).
const PROPERTY_TYPE_TAGS = [
  "TEXT",
  "NUMBER",
  "DATE",
  "SELECT",
  "MULTISELECT",
  "RELATION",
  "CHECKBOX",
  "URL",
  "PERSON",
  "AI",
  "FORMULA",
  "ROLLUP",
] as const;

/** Canonical (Rust-cased) property type names, by decodeEnumVariant tag. */
const PROPERTY_TYPE_CANONICAL: Record<string, string> = {
  TEXT: "Text",
  NUMBER: "Number",
  DATE: "Date",
  SELECT: "Select",
  MULTISELECT: "MultiSelect",
  RELATION: "Relation",
  CHECKBOX: "Checkbox",
  URL: "Url",
  PERSON: "Person",
  AI: "Ai",
  FORMULA: "Formula",
  ROLLUP: "Rollup",
};

/** PropertyValue variant order (schemas.rs) for decoding `[idx, payload]`. */
const PROPERTY_VALUE_TAGS = [
  "Text",
  "Number",
  "Date",
  "Select",
  "MultiSelect",
  "Relation",
  "Checkbox",
  "Url",
  "Person",
  "Ai",
] as const;

export interface ColumnDef {
  id: number;
  name: string;
  type: string;
  order: number;
  /** Position of the owning schema in the inheritance chain (root = 0). */
  chainIndex: number;
}

interface ResolvedDatabase {
  page: PageRow;
  schemaId: number;
  columns: ColumnDef[];
}

type RawSchemaRow = {
  id: number | string;
  page_id: number | string;
  parent_schema_id: unknown;
};

type RawPropRow = {
  id: number | string;
  schema_id: number | string;
  name: string;
  property_type: unknown;
  order: number | string;
};

const MAX_SCHEMA_CHAIN_DEPTH = 32; // mirrors the server-side bound

/**
 * Resolve a Database page to its effective column list: the schema's
 * inheritance chain root-first, each link's columns in `order`. Returns an
 * error string for non-Database or schema-less pages.
 */
export async function resolveDatabase(
  transport: StdbTransport,
  pageId: number,
): Promise<ResolvedDatabase | { error: string }> {
  const page = await getPageRow(transport, pageId);
  if (!page || page.deleted) return { error: `Page ${pageId} not found` };
  if (page.pageType !== "Database") {
    return {
      error: `Page ${pageId} is a ${page.pageType} page, not a Database. Use get_page for non-database pages.`,
    };
  }

  // Schema + definition tables are workspace-small: fetch whole and join
  // client-side (Option columns are unfilterable in STDB SQL anyway).
  const schemas = await transport.sql<RawSchemaRow>(
    "SELECT id, page_id, parent_schema_id FROM database_schema",
  );
  const own = schemas.find((s) => Number(s.page_id) === pageId);
  if (!own) return { error: `Database page ${pageId} has no schema` };

  const byId = new Map(schemas.map((s) => [Number(s.id), s]));
  const chain: number[] = []; // root-first
  let cursor: number | null = Number(own.id);
  for (let depth = 0; cursor !== null && depth < MAX_SCHEMA_CHAIN_DEPTH; depth++) {
    chain.unshift(cursor);
    const row = byId.get(cursor);
    cursor = row ? toNumberOrNull(row.parent_schema_id) : null;
  }

  const props = await transport.sql<RawPropRow>(
    `SELECT id, schema_id, name, property_type, "order" FROM property_definition WHERE ${orChain("schema_id", chain.length)}`,
    chain,
  );
  const columns: ColumnDef[] = props
    .map((p) => ({
      id: Number(p.id),
      name: p.name,
      type:
        PROPERTY_TYPE_CANONICAL[decodeEnumVariant(p.property_type, PROPERTY_TYPE_TAGS) ?? ""] ??
        "Text",
      order: Number(p.order ?? 0),
      chainIndex: chain.indexOf(Number(p.schema_id)),
    }))
    .sort((a, b) => a.chainIndex - b.chainIndex || a.order - b.order);

  return { page, schemaId: Number(own.id), columns };
}

// ── Cell decoding (read side) ─────────────────────────────────────────────────

/**
 * Decode a `PropertyValue` sum off the `/sql` wire (`[variantIndex, payload]`,
 * tolerating `{variant: payload}`) into a JSON-safe scalar/array, same shapes
 * as the chat surface: Date → ISO string, Relation → page-id numbers,
 * Ai → its output string.
 */
export function decodeCellValue(raw: unknown): unknown {
  let tag: string | undefined;
  let payload: unknown;
  if (Array.isArray(raw) && raw.length >= 1 && typeof raw[0] === "number") {
    tag = PROPERTY_VALUE_TAGS[raw[0]];
    payload = raw[1];
  } else if (raw !== null && typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length === 1) {
      const key = entries[0][0].toLowerCase();
      tag = PROPERTY_VALUE_TAGS.find((t) => t.toLowerCase() === key);
      payload = entries[0][1];
    }
  }
  if (!tag) return null;

  switch (tag) {
    case "Text":
    case "Url":
    case "Select":
      return payload == null ? null : String(payload);
    case "Number": {
      const n = Number(payload);
      return Number.isFinite(n) ? n : null;
    }
    case "Checkbox":
      return Boolean(payload);
    case "Date": {
      const ms = Number(payload);
      return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
    }
    case "MultiSelect":
    case "Person":
      return Array.isArray(payload) ? payload.map(String) : [String(payload)];
    case "Relation":
      return Array.isArray(payload) ? payload.map(Number) : [Number(payload)];
    case "Ai": {
      // Product { output, evaluation_id, is_stale } — positional or named.
      if (Array.isArray(payload)) return payload[0] == null ? null : String(payload[0]);
      if (payload !== null && typeof payload === "object") {
        const o = payload as Record<string, unknown>;
        return o.output == null ? null : String(o.output);
      }
      return null;
    }
    default:
      return null;
  }
}

// ── query_database ────────────────────────────────────────────────────────────

/**
 * Char budget per response — aligned with get_page's window. `offset` +
 * `next_offset` make the remainder reachable; `truncated` is always explicit
 * (task 263: the old silent halving surfaced as a mystery ~21-row cap).
 */
const QUERY_DB_CHAR_BUDGET = 20_000;
const QUERY_DB_MAX_LIMIT = 200;

export interface QueryDatabaseInput {
  page_id: number;
  limit?: number;
  offset?: number;
  property_filter?: { property?: string; equals?: unknown; contains?: string };
}

export async function queryDatabase(
  transport: StdbTransport,
  input: QueryDatabaseInput,
): Promise<string> {
  const resolved = await resolveDatabase(transport, Number(input.page_id));
  if ("error" in resolved) return JSON.stringify({ ok: false, error: resolved.error });
  const { page, columns } = resolved;

  // Rows are the database page's live children, stable-ordered by id.
  const rowPages = (await listChildren(transport, page.id)).sort((a, b) => a.id - b.id);

  // All cell values for all rows, chunked OR-chains on the indexed page_id.
  type RawPV = { page_id: number | string; property_definition_id: number | string; value: unknown };
  const cellsByRow = new Map<number, Map<number, unknown>>();
  const CHUNK = 50;
  for (let i = 0; i < rowPages.length; i += CHUNK) {
    const chunk = rowPages.slice(i, i + CHUNK).map((r) => r.id);
    const pvs = await transport.sql<RawPV>(
      `SELECT page_id, property_definition_id, value FROM page_property_value WHERE ${orChain("page_id", chunk.length)}`,
      chunk,
    );
    for (const pv of pvs) {
      const rid = Number(pv.page_id);
      const m = cellsByRow.get(rid) ?? new Map<number, unknown>();
      m.set(Number(pv.property_definition_id), decodeCellValue(pv.value));
      cellsByRow.set(rid, m);
    }
  }

  let matched = rowPages.map((r) => {
    const cells = cellsByRow.get(r.id);
    const out: Record<string, unknown> = { page_id: r.id, title: r.title };
    for (const c of columns) out[c.name] = cells?.get(c.id) ?? null;
    return out;
  });

  const filter = input.property_filter;
  if (filter?.property) {
    const propName = filter.property;
    const known = propName === "title" || columns.some((c) => c.name === propName);
    if (!known) {
      return JSON.stringify({
        ok: false,
        error: `Unknown property "${propName}". Known columns: ${["title", ...columns.map((c) => c.name)].join(", ")}`,
      });
    }
    const eq = filter.equals;
    const contains =
      typeof filter.contains === "string" ? filter.contains.toLowerCase() : undefined;
    matched = matched.filter((row) => {
      const cell = row[propName];
      const text = cell == null ? "" : Array.isArray(cell) ? cell.join(", ") : String(cell);
      if (eq !== undefined && String(eq).toLowerCase() !== text.toLowerCase()) return false;
      if (contains !== undefined && !text.toLowerCase().includes(contains)) return false;
      return true;
    });
  }

  const totalRows = matched.length;
  const offset = Math.max(0, Math.trunc(Number(input.offset ?? 0)) || 0);
  let limit = Number(input.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(limit, QUERY_DB_MAX_LIMIT);
  let rows = matched.slice(offset, offset + limit);

  const build = () => {
    const truncated = offset + rows.length < totalRows;
    return JSON.stringify({
      ok: true,
      page_id: page.id,
      database_title: page.title,
      columns: columns.map((c) => ({ name: c.name, type: c.type })),
      total_rows: totalRows,
      returned_rows: rows.length,
      offset,
      truncated,
      next_offset: truncated ? offset + rows.length : undefined,
      note: truncated
        ? "More rows exist — call again with offset=next_offset, or narrow with property_filter."
        : undefined,
      rows,
    });
  };
  // A wide/large table can still blow the context budget at a small row
  // count; shrink the window but keep the explicit next_offset contract so
  // nothing is silently unreachable.
  let payload = build();
  while (payload.length > QUERY_DB_CHAR_BUDGET && rows.length > 1) {
    rows = rows.slice(0, Math.ceil(rows.length / 2));
    payload = build();
  }
  return payload;
}

// ── set_row_properties ────────────────────────────────────────────────────────

/** Wire-encode a coerced cell as a SATS-JSON `PropertyValue` variant. */
type WireValue = Record<string, unknown>;

function coerceAndEncode(
  column: ColumnDef,
  raw: unknown,
): { ok: true; wire: WireValue } | { ok: false; error: string } {
  const fail = (want: string): { ok: false; error: string } => ({
    ok: false,
    error: `Column "${column.name}" is ${column.type} — expected ${want}, got ${JSON.stringify(raw)}`,
  });
  switch (column.type) {
    case "Text":
      return { ok: true, wire: { text: String(raw ?? "") } };
    case "Url":
      return { ok: true, wire: { url: String(raw ?? "") } };
    case "Select":
      if (typeof raw !== "string" || !raw) return fail("a string (one option)");
      return { ok: true, wire: { select: raw } };
    case "Number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return fail("a number");
      return { ok: true, wire: { number: n } };
    }
    case "Checkbox":
      if (typeof raw !== "boolean") return fail("a boolean");
      return { ok: true, wire: { checkbox: raw } };
    case "Date": {
      // Accept unix ms or any Date.parse-able string (ISO date/datetime).
      const ms = typeof raw === "number" ? raw : Date.parse(String(raw));
      if (!Number.isFinite(ms) || ms <= 0) return fail("unix ms or an ISO date string");
      return { ok: true, wire: { date: Math.trunc(ms) } };
    }
    case "MultiSelect": {
      const arr = Array.isArray(raw) ? raw : [raw];
      if (!arr.every((x) => typeof x === "string")) return fail("a string array");
      return { ok: true, wire: { multiSelect: arr } };
    }
    case "Relation": {
      const arr = (Array.isArray(raw) ? raw : [raw]).map(Number);
      if (!arr.every((x) => Number.isSafeInteger(x) && x > 0)) {
        return fail("a page-id number array");
      }
      return { ok: true, wire: { relation: arr } };
    }
    case "Person": {
      const arr = Array.isArray(raw) ? raw : [raw];
      if (!arr.every((x) => typeof x === "string")) return fail("an identity-hex string array");
      return { ok: true, wire: { person: arr } };
    }
    default:
      return {
        ok: false,
        error: `Column "${column.name}" is ${column.type} — computed columns cannot be set directly.`,
      };
  }
}

/**
 * Set columns on a database row by NAME. Resolves the row's parent Database
 * schema, coerces each value by column type, and applies one
 * `set_property_value` reducer call per column (each transactional; on a
 * mid-batch failure `applied` reports what landed).
 */
export async function setRowProperties(
  transport: StdbTransport,
  rowPageId: number,
  properties: Record<string, unknown>,
): Promise<string> {
  const entries = Object.entries(properties ?? {});
  if (entries.length === 0) {
    return JSON.stringify({ ok: false, error: "`properties` must be a non-empty object." });
  }

  const row = await getPageRow(transport, rowPageId);
  if (!row || row.deleted) {
    return JSON.stringify({ ok: false, error: `Row page ${rowPageId} not found` });
  }
  if (row.parentId === null) {
    return JSON.stringify({ ok: false, error: `Page ${rowPageId} is not a database row (no parent).` });
  }
  const resolved = await resolveDatabase(transport, row.parentId);
  if ("error" in resolved) {
    return JSON.stringify({
      ok: false,
      error: `Parent page ${row.parentId} is not a queryable Database: ${resolved.error}`,
    });
  }
  const byName = new Map(resolved.columns.map((c) => [c.name, c]));

  const applied: string[] = [];
  for (const [name, raw] of entries) {
    const column = byName.get(name);
    if (!column) {
      return JSON.stringify({
        ok: false,
        error: `Unknown column "${name}". Known columns: ${resolved.columns.map((c) => c.name).join(", ")}`,
        applied,
      });
    }
    const coerced = coerceAndEncode(column, raw);
    if (!coerced.ok) return JSON.stringify({ ok: false, error: coerced.error, applied });
    try {
      await transport.call("set_property_value", [
        encodeU64(rowPageId),
        encodeU64(column.id),
        coerced.wire,
      ]);
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: `set_property_value failed for "${name}": ${reducerErrorMessage(err)}`,
        applied,
      });
    }
    applied.push(name);
  }

  return JSON.stringify({ ok: true, page_id: rowPageId, applied });
}
