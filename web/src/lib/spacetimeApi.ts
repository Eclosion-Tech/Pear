/**
 * Server-side SpacetimeDB HTTP API client.
 * Used by the custom API endpoints gateway (/api/e/[...slug]) to query tables
 * and call reducers without maintaining a WebSocket connection.
 *
 * Requires env vars:
 *   SPACETIMEDB_PROXY_ORIGIN  — internal SpacetimeDB HTTP URL (e.g. http://spacetimedb:3000)
 *   SPACETIMEDB_DB_NAME       — database name (e.g. pear-dev)
 *   SPACETIMEDB_GATEWAY_TOKEN — identity token for authenticating the gateway
 */

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const proxy = process.env.SPACETIMEDB_PROXY_ORIGIN?.trim();
  if (proxy) return proxy;

  const wsUri =
    process.env.NEXT_PUBLIC_SPACETIMEDB_URI?.trim() ?? "ws://localhost:3000";
  return wsUri.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function getDbName(): string {
  return (
    process.env.SPACETIMEDB_DB_NAME?.trim() ||
    process.env.NEXT_PUBLIC_SPACETIMEDB_DB_NAME?.trim() ||
    "pear-dev"
  );
}

function getGatewayToken(): string | undefined {
  return process.env.SPACETIMEDB_GATEWAY_TOKEN?.trim() || undefined;
}

// ---------------------------------------------------------------------------
// SQL query
// ---------------------------------------------------------------------------

export interface SqlColumn {
  name: string;
  type: unknown;
}

export interface SqlResult {
  columns: SqlColumn[];
  rows: Record<string, unknown>[];
}

/**
 * Execute a SQL query against SpacetimeDB.
 * Returns rows as plain JS objects keyed by column name.
 */
export async function query(sql: string): Promise<SqlResult> {
  const baseUrl = getBaseUrl();
  const dbName = getDbName();
  const token = getGatewayToken();

  const headers: Record<string, string> = {
    "Content-Type": "text/plain",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${baseUrl}/v1/database/${dbName}/sql`, {
    method: "POST",
    headers,
    body: sql,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SpacetimeDB SQL error (${res.status}): ${text}`);
  }

  const data = await res.json();

  // Response is an array of statement results.
  // Each result has { schema: ProductType, rows: ProductValue[] }.
  if (!Array.isArray(data) || data.length === 0) {
    return { columns: [], rows: [] };
  }

  const result = data[0];
  const schema = result.schema;
  const rawRows: unknown[][] = result.rows ?? [];

  // Parse schema to get column names
  const columns: SqlColumn[] = (schema?.elements ?? []).map(
    (el: { name: { some?: string }; algebraic_type: unknown }) => ({
      name: el.name?.some ?? "",
      type: el.algebraic_type,
    })
  );

  // Convert positional row arrays to named objects
  const rows = rawRows.map((row: unknown[]) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i].name] = row[i];
    }
    return obj;
  });

  return { columns, rows };
}

// ---------------------------------------------------------------------------
// Reducer calls
// ---------------------------------------------------------------------------

/**
 * Call a SpacetimeDB reducer via HTTP.
 * Args are passed as a JSON array in SATS-JSON format.
 */
export async function callReducer(
  reducerName: string,
  args: unknown[]
): Promise<void> {
  const baseUrl = getBaseUrl();
  const dbName = getDbName();
  const token = getGatewayToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(
    `${baseUrl}/v1/database/${dbName}/call/${reducerName}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `SpacetimeDB reducer '${reducerName}' failed (${res.status}): ${text}`
    );
  }
}

// ---------------------------------------------------------------------------
// SATS-JSON helpers
// ---------------------------------------------------------------------------

/** Encode an Option<T> in SATS-JSON format. */
export function satsOption(value: unknown | null | undefined): unknown {
  if (value === null || value === undefined) {
    return { none: [] };
  }
  return { some: value };
}

/** Encode a PropertyValue variant in SATS-JSON format. */
export function satsPropertyValue(
  propertyType: string,
  value: unknown
): unknown {
  switch (propertyType) {
    case "Text":
      return { Text: String(value) };
    case "Number":
      return { Number: Number(value) };
    case "Date":
      return { Date: Number(value) };
    case "Select":
      return { Select: String(value) };
    case "MultiSelect":
      return {
        MultiSelect: Array.isArray(value) ? value.map(String) : [String(value)],
      };
    case "Relation":
      return {
        Relation: Array.isArray(value) ? value.map(Number) : [Number(value)],
      };
    case "Checkbox":
      return { Checkbox: Boolean(value) };
    case "Url":
      return { Url: String(value) };
    case "Person":
      return {
        Person: Array.isArray(value) ? value.map(String) : [String(value)],
      };
    default:
      return { Text: String(value) };
  }
}

/** Decode a SATS-JSON PropertyValue to a plain JS value. */
export function decodeSatsPropertyValue(
  satsValue: unknown
): { type: string; value: unknown } | null {
  if (satsValue === null || satsValue === undefined) return null;
  if (typeof satsValue !== "object") return null;

  const obj = satsValue as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return null;

  const type = keys[0];
  return { type, value: obj[type] };
}

/** Decode a SATS-JSON PageType enum. */
export function decodeSatsEnum(satsValue: unknown): string | null {
  if (satsValue === null || satsValue === undefined) return null;
  if (typeof satsValue !== "object") return null;

  const obj = satsValue as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return null;
  return keys[0];
}

// ---------------------------------------------------------------------------
// Gateway config check
// ---------------------------------------------------------------------------

export function isGatewayConfigured(): boolean {
  return Boolean(getBaseUrl() && getDbName());
}
