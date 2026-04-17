/**
 * Reusable `StdbTransport` implementation backed by SpacetimeDB's HTTP API.
 *
 * Platform-agnostic: this module has zero process/env reads. The OSS Next.js
 * handler constructs one bound to `PEAR_STDB_*` env vars; the Cloudflare
 * Worker constructs one per workspace bound to that workspace's
 * server_ip + service token.
 *
 * Uses only the `fetch` global, so it runs in Node.js (Next.js), Cloudflare
 * Workers, Deno, Bun, and browsers (although browser usage would leak the
 * service token — don't).
 */

import { ApiEndpointError, type StdbTransport } from "./types";

export interface HttpTransportOptions {
  /** Base URL for the SpacetimeDB HTTP API, e.g. `http://stdb:3000`. */
  baseUrl: string;
  /** Database name, e.g. `pear` or `acme`. */
  dbName: string;
  /** Bearer token for the gateway/service identity. */
  token: string;
  /** Allows tests/Workers to inject their fetch. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Optional request timeout in ms. */
  timeoutMs?: number;
}

interface SqlStatementResult {
  schema?: {
    elements?: Array<{
      name?: { some?: string };
      algebraic_type?: unknown;
    }>;
  };
  rows?: unknown[][];
}

export class HttpStdbTransport implements StdbTransport {
  private readonly baseUrl: string;
  private readonly dbName: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;

  constructor(opts: HttpTransportOptions) {
    if (!opts.baseUrl) throw new Error("HttpStdbTransport: baseUrl required");
    if (!opts.dbName) throw new Error("HttpStdbTransport: dbName required");
    if (!opts.token) throw new Error("HttpStdbTransport: token required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.dbName = encodeURIComponent(opts.dbName);
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs;
  }

  async sql<Row = unknown>(query: string, params: unknown[] = []): Promise<Row[]> {
    const finalSql = inlineParams(query, params);
    const url = `${this.baseUrl}/v1/database/${this.dbName}/sql`;
    const res = await this.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: `Bearer ${this.token}`,
      },
      body: finalSql,
    });
    if (!res.ok) {
      const text = await safeText(res);
      throw new ApiEndpointError(
        502,
        "stdb_sql_error",
        `SpacetimeDB SQL failed (${res.status}): ${text}`,
      );
    }
    const data = (await res.json()) as SqlStatementResult[];
    if (!Array.isArray(data) || data.length === 0) return [];

    const result = data[0];
    const columns =
      result.schema?.elements?.map((el) => el.name?.some ?? "") ?? [];
    const rows = (result.rows ?? []).map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = row[i];
      }
      return obj as Row;
    });
    return rows;
  }

  async call(reducer: string, args: unknown[]): Promise<void> {
    const url = `${this.baseUrl}/v1/database/${this.dbName}/call/${encodeURIComponent(reducer)}`;
    const res = await this.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(args, replaceBigInt),
    });
    if (!res.ok) {
      const text = await safeText(res);
      throw new ApiEndpointError(
        502,
        "stdb_reducer_error",
        `SpacetimeDB reducer '${reducer}' failed (${res.status}): ${text}`,
      );
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    if (!this.timeoutMs) return this.fetchImpl(url, init);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Substitute positional `?` placeholders with literal values. SpacetimeDB's
 * HTTP `/sql` endpoint accepts a single SQL string, so we render args
 * server-side. All string values are escaped; numeric/boolean values pass
 * through. Non-supported types are rejected to avoid injection.
 */
function inlineParams(sql: string, params: unknown[]): string {
  if (params.length === 0) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => {
    if (i >= params.length) {
      throw new Error("inlineParams: more `?` placeholders than params");
    }
    const v = params[i++];
    return formatLiteral(v);
  });
}

function formatLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("formatLiteral: non-finite number");
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  throw new Error(
    `formatLiteral: unsupported type ${typeof v} (use string/number/bigint/boolean)`,
  );
}

function replaceBigInt(_: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}
