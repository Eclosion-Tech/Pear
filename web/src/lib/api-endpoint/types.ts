/**
 * Shared types for the platform-agnostic custom API endpoint library.
 *
 * This module ships with open-source Pear and is imported by both the
 * default Next.js handler ([../../../app/api/e/[slug]/route.ts]) and any
 * external gateway implementations (e.g. the Pear-Cloud Cloudflare Worker
 * at `workers/api/`).
 *
 * It MUST stay free of platform-specific imports — no `next/*`, no
 * `process.env` reads, no `node:*` modules. Use the injected
 * `StdbTransport` for all SpacetimeDB I/O.
 */

/** SpacetimeDB property types as defined in `lib.rs`. */
export type PropertyTypeName =
  | "Text"
  | "Number"
  | "Date"
  | "Select"
  | "MultiSelect"
  | "Relation"
  | "Checkbox"
  | "Url"
  | "Person";

/** SATS-JSON tagged-union encoding of a `PropertyValue`. */
export type SatsPropertyValue =
  | { Text: string }
  | { Number: number }
  | { Date: number | string } // u64 ms — string when value > 2^53
  | { Select: string }
  | { MultiSelect: string[] }
  | { Relation: Array<number | string> }
  | { Checkbox: boolean }
  | { Url: string }
  | { Person: string[] };

export type HttpMethodName = "GET" | "POST" | "PATCH" | "DELETE";

/** SATS-JSON tag for `HttpMethod`. */
export type SatsHttpMethod =
  | { Get: [] }
  | { Post: [] }
  | { Patch: [] }
  | { Delete: [] };

export interface PropertyDefinitionRow {
  id: number;
  schemaId: number;
  name: string;
  propertyType: PropertyTypeName;
  /** JSON string with `{ options?, defaultValue?, ... }`. */
  config: string;
  order: number;
}

export interface ApiFieldMappingRow {
  id: number;
  endpointId: number;
  propertyDefinitionId: number;
  fieldName: string;
  requiredOnCreate: boolean;
  /** JSON-encoded `SatsPropertyValue`, applied when the field is absent on POST. */
  defaultValue: string | null;
  readOnly: boolean;
  fieldOrder: number;
}

export interface ApiEndpointRow {
  id: number;
  databasePageId: number;
  slug: string;
  displayName: string;
  description: string;
  allowedMethods: HttpMethodName[];
  requireAuth: boolean;
}

/** Full configuration needed to serve a request for one endpoint. */
export interface EndpointConfig {
  endpoint: ApiEndpointRow;
  mappings: ApiFieldMappingRow[];
  propertyDefinitions: PropertyDefinitionRow[];
}

/**
 * Authenticated principal for a request. Performed by the host (Next.js
 * route handler or Cloudflare Worker) before invoking the dispatcher; the
 * dispatcher only consumes the result.
 */
export type AuthResult =
  | { kind: "session"; identityHex: string }
  | { kind: "api-key"; keyId: number; identityHex?: string }
  | { kind: "open" };

/**
 * Transport abstraction for talking to one workspace's SpacetimeDB. Hosts
 * supply an implementation bound to a specific `(server, database, token)`
 * tuple — Next.js single-tenant handler binds to `PEAR_STDB_*` env vars,
 * the multi-tenant Worker binds per request from a Postgres lookup.
 */
export interface StdbTransport {
  /** Execute a SQL query and return the typed rows. */
  sql<Row = unknown>(query: string, params?: unknown[]): Promise<Row[]>;
  /** Invoke a reducer with positional SATS-JSON arguments. */
  call(reducer: string, args: unknown[]): Promise<void>;
}

/** Structured error surfaced to the API caller. */
export class ApiEndpointError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiEndpointError";
  }
}

/** Body shape of an error response. Stable contract for clients. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Body shape of a single row response. */
export interface RowBody {
  id: string;
  title: string;
  fields: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** Body shape of a list response. */
export interface ListBody {
  data: RowBody[];
  pagination: {
    limit: number;
    offset: number;
    total?: number;
  };
}
