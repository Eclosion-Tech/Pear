/**
 * Request → Response dispatcher for custom API endpoints.
 *
 * The dispatcher is the platform-agnostic core of the feature. It knows
 * how to:
 *
 *   1. Load (or cache-hit) an `EndpointConfig` for a slug.
 *   2. Validate the HTTP method against `allowed_methods`.
 *   3. Translate the request body into SATS-JSON `PropertyValue`s using
 *      the field mappings + property definitions.
 *   4. Call the appropriate atomic reducer (`create_database_row`,
 *      `update_database_row`, `delete_database_row`) via an injected
 *      `StdbTransport`.
 *   5. Read back the resulting row(s) and shape the response JSON.
 *   6. Append an `ApiCallLog` entry (fire-and-forget).
 *
 * It does NOT perform authentication — hosts authenticate the caller and
 * pass the result in via `args.auth`. It does not know about
 * Cloudflare, Next.js, Postgres, or any process-level config.
 */

import { decodePropertyValue, encodeHttpMethod, encodeOption, encodePropertyValue } from "./codec";
import { buildOpenApiSpec } from "./openapi";
import {
  ApiEndpointError,
  type ApiFieldMappingRow,
  type AuthResult,
  type EndpointConfig,
  type ErrorBody,
  type ListBody,
  type PropertyDefinitionRow,
  type RowBody,
  type SatsPropertyValue,
  type StdbTransport,
  type HttpMethodName,
} from "./types";
import { EndpointConfigCache } from "./cache";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export interface DispatchArgs {
  /** Full request URL — used to read query params and build self-links. */
  url: URL;
  method: string;
  body: unknown;
  endpointSlug: string;
  /** Trailing path segment after the slug, if any: row id or `_schema`. */
  trailing?: string;
  transport: StdbTransport;
  auth: AuthResult;
  cache?: EndpointConfigCache;
  /** Best-effort caller IP (X-Forwarded-For first hop). */
  callerIp?: string;
  /** Public base URL for OpenAPI generation, e.g. `https://x/e/fruit`. */
  baseUrl: string;
}

export async function dispatchApiEndpointRequest(
  args: DispatchArgs,
): Promise<Response> {
  const startedAt = Date.now();
  const method = args.method.toUpperCase() as HttpMethodName;

  let endpointId: number | undefined;
  let keyId: number | undefined;
  let response: Response;

  try {
    const config = await loadEndpointConfig(
      args.transport,
      args.endpointSlug,
      args.cache,
    );
    endpointId = config.endpoint.id;
    keyId = args.auth.kind === "api-key" ? args.auth.keyId : undefined;

    if (config.endpoint.requireAuth && args.auth.kind === "open") {
      throw new ApiEndpointError(
        401,
        "auth_required",
        "This endpoint requires authentication. Provide a Bearer API key.",
      );
    }

    if (args.trailing === "_schema") {
      if (method !== "GET") {
        throw new ApiEndpointError(
          405,
          "method_not_allowed",
          `Method ${method} not allowed on /_schema`,
        );
      }
      const spec = buildOpenApiSpec({ config, baseUrl: args.baseUrl });
      response = json(200, spec);
    } else {
      if (!config.endpoint.allowedMethods.includes(method)) {
        throw new ApiEndpointError(
          405,
          "method_not_allowed",
          `Method ${method} not allowed by this endpoint`,
        );
      }

      response = await dispatchCrud(args, config, method);
    }
  } catch (e) {
    response = errorResponse(e);
  }

  const latencyMs = Date.now() - startedAt;
  if (endpointId !== undefined) {
    void logCall(args.transport, {
      endpointId,
      keyId,
      method,
      path: args.url.pathname,
      statusCode: response.status,
      latencyMs,
      callerIp: args.callerIp,
      errorMessage:
        response.status >= 400
          ? safeErrorMessage(response)
          : undefined,
    }).catch(() => undefined);

    if (keyId !== undefined && response.status < 400) {
      void args.transport
        .call("touch_api_endpoint_key", [keyId])
        .catch(() => undefined);
    }
  }

  return response;
}

async function dispatchCrud(
  args: DispatchArgs,
  config: EndpointConfig,
  method: HttpMethodName,
): Promise<Response> {
  if (args.trailing) {
    const rowId = parseRowId(args.trailing);
    switch (method) {
      case "GET":
        return getRow(args.transport, config, rowId);
      case "PATCH":
        return updateRow(args.transport, config, rowId, args.body);
      case "DELETE":
        return deleteRow(args.transport, config, rowId);
      default:
        throw new ApiEndpointError(
          405,
          "method_not_allowed",
          `Method ${method} not allowed on /{id}`,
        );
    }
  }

  switch (method) {
    case "GET":
      return listRows(args.transport, config, args.url);
    case "POST":
      return createRow(args.transport, config, args.body);
    default:
      throw new ApiEndpointError(
        405,
        "method_not_allowed",
        `Method ${method} not allowed on collection`,
      );
  }
}

// ---------- CRUD operations ----------

async function listRows(
  transport: StdbTransport,
  config: EndpointConfig,
  url: URL,
): Promise<Response> {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT)),
  );
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

  const pages = await transport.sql<{
    id: string | number;
    title: string;
    sort_order: number;
    created_at?: string;
    updated_at?: string;
  }>(
    `SELECT id, title, sort_order, created_at, updated_at
       FROM page
      WHERE parent_id = ?
        AND deleted_at IS NULL
        AND page_type = 'Database'
      ORDER BY sort_order ASC, id ASC
      LIMIT ?
     OFFSET ?`,
    [config.endpoint.databasePageId, limit, offset],
  );

  const rows = await assembleRows(transport, config, pages);

  const body: ListBody = {
    data: rows,
    pagination: { limit, offset },
  };
  return json(200, body);
}

async function getRow(
  transport: StdbTransport,
  config: EndpointConfig,
  rowId: number | string,
): Promise<Response> {
  const pages = await transport.sql<{
    id: string | number;
    title: string;
    parent_id: string | number | null;
    deleted_at: string | null;
    created_at?: string;
    updated_at?: string;
  }>(
    `SELECT id, title, parent_id, deleted_at, created_at, updated_at
       FROM page
      WHERE id = ?
      LIMIT 1`,
    [rowId],
  );

  if (
    pages.length === 0 ||
    pages[0].deleted_at !== null ||
    String(pages[0].parent_id) !== String(config.endpoint.databasePageId)
  ) {
    throw new ApiEndpointError(404, "not_found", `Row ${rowId} not found`);
  }

  const rows = await assembleRows(transport, config, [pages[0]]);
  return json(200, rows[0]);
}

async function createRow(
  transport: StdbTransport,
  config: EndpointConfig,
  body: unknown,
): Promise<Response> {
  const { title, fields } = parseRowBody(body);

  const values = buildPropertyValuesForCreate(config, fields);
  const resolvedTitle = title?.trim() || deriveTitleFromFields(config, fields) || "Untitled";

  const clientRequestId = randomUuid();

  await transport.call("create_database_row", [
    config.endpoint.databasePageId,
    resolvedTitle,
    values,
    clientRequestId,
  ]);

  const markers = await transport.sql<{ page_id: string | number }>(
    `SELECT page_id FROM database_row_marker WHERE client_request_id = ? LIMIT 1`,
    [clientRequestId],
  );
  if (markers.length === 0) {
    throw new ApiEndpointError(
      500,
      "create_failed",
      "Row was not created (no marker found). Check SpacetimeDB module logs.",
    );
  }
  const newId = markers[0].page_id;

  const pages = await transport.sql<{
    id: string | number;
    title: string;
    created_at?: string;
    updated_at?: string;
  }>(
    `SELECT id, title, created_at, updated_at FROM page WHERE id = ? LIMIT 1`,
    [newId],
  );
  const rows = await assembleRows(transport, config, pages);
  return json(201, rows[0], {
    Location: `${pages[0].id}`,
  });
}

async function updateRow(
  transport: StdbTransport,
  config: EndpointConfig,
  rowId: number | string,
  body: unknown,
): Promise<Response> {
  const pages = await transport.sql<{
    parent_id: string | number | null;
    deleted_at: string | null;
  }>(
    `SELECT parent_id, deleted_at FROM page WHERE id = ? LIMIT 1`,
    [rowId],
  );
  if (
    pages.length === 0 ||
    pages[0].deleted_at !== null ||
    String(pages[0].parent_id) !== String(config.endpoint.databasePageId)
  ) {
    throw new ApiEndpointError(404, "not_found", `Row ${rowId} not found`);
  }

  const { title, fields } = parseRowBody(body);
  const { setValues, clearValues } = buildPropertyValuesForUpdate(
    config,
    fields,
  );

  await transport.call("update_database_row", [
    rowId,
    encodeOption(title?.trim() || null),
    setValues,
    clearValues,
  ]);

  // Re-fetch and return the canonical state.
  return getRow(transport, config, rowId);
}

async function deleteRow(
  transport: StdbTransport,
  config: EndpointConfig,
  rowId: number | string,
): Promise<Response> {
  const pages = await transport.sql<{
    parent_id: string | number | null;
    deleted_at: string | null;
  }>(
    `SELECT parent_id, deleted_at FROM page WHERE id = ? LIMIT 1`,
    [rowId],
  );
  if (
    pages.length === 0 ||
    String(pages[0].parent_id) !== String(config.endpoint.databasePageId)
  ) {
    throw new ApiEndpointError(404, "not_found", `Row ${rowId} not found`);
  }

  await transport.call("delete_database_row", [rowId]);
  return new Response(null, { status: 204 });
}

// ---------- Helpers ----------

async function loadEndpointConfig(
  transport: StdbTransport,
  slug: string,
  cache?: EndpointConfigCache,
): Promise<EndpointConfig> {
  if (cache) {
    const cached = cache.get(slug);
    if (cached) return cached;
  }

  const endpoints = await transport.sql<{
    id: string | number;
    database_page_id: string | number;
    slug: string;
    display_name: string;
    description: string;
    allowed_methods: string;
    require_auth: boolean | number;
  }>(
    `SELECT id, database_page_id, slug, display_name, description,
            allowed_methods, require_auth
       FROM api_endpoint
      WHERE slug = ?
      LIMIT 1`,
    [slug],
  );
  if (endpoints.length === 0) {
    throw new ApiEndpointError(404, "endpoint_not_found", `No endpoint '${slug}'`);
  }
  const e = endpoints[0];

  // SpacetimeDB's SQL subset rejects `ORDER BY` on non-indexed columns
  // (`field_order` has no btree index; only `id` PK and `endpoint_id` do),
  // so fetch unordered and sort in JS. Mapping counts per endpoint are tiny
  // — capped by the column count of the underlying database page — so the
  // O(n log n) is irrelevant.
  const mappings = (
    await transport.sql<{
      id: string | number;
      endpoint_id: string | number;
      property_definition_id: string | number;
      field_name: string;
      required_on_create: boolean | number;
      default_value: string | null;
      read_only: boolean | number;
      field_order: number;
    }>(
      `SELECT id, endpoint_id, property_definition_id, field_name,
              required_on_create, default_value, read_only, field_order
         FROM api_field_mapping
        WHERE endpoint_id = ?`,
      [e.id],
    )
  ).sort((a, b) => a.field_order - b.field_order);

  const propIds = mappings.map((m) => m.property_definition_id);
  let properties: Array<{
    id: string | number;
    schema_id: string | number;
    name: string;
    property_type: string;
    config: string;
    order: number;
  }> = [];
  if (propIds.length > 0) {
    // STDB's SQL subset doesn't support `IN (...)`; expand to an OR chain
    // over the indexed PK so the planner still uses the btree.
    properties = await transport.sql<typeof properties[number]>(
      `SELECT id, schema_id, name, property_type, config, "order"
         FROM property_definition
        WHERE ${orClause("id", propIds.length)}`,
      propIds,
    );
  }

  const config: EndpointConfig = {
    endpoint: {
      id: Number(e.id),
      databasePageId: Number(e.database_page_id),
      slug: e.slug,
      displayName: e.display_name,
      description: e.description,
      allowedMethods: parseAllowedMethods(e.allowed_methods),
      requireAuth: Boolean(e.require_auth),
    },
    mappings: mappings.map((m) => ({
      id: Number(m.id),
      endpointId: Number(m.endpoint_id),
      propertyDefinitionId: Number(m.property_definition_id),
      fieldName: m.field_name,
      requiredOnCreate: Boolean(m.required_on_create),
      defaultValue: m.default_value,
      readOnly: Boolean(m.read_only),
      fieldOrder: m.field_order,
    })),
    propertyDefinitions: properties.map((p) => ({
      id: Number(p.id),
      schemaId: Number(p.schema_id),
      name: p.name,
      propertyType: p.property_type as PropertyDefinitionRow["propertyType"],
      config: p.config,
      order: p.order,
    })),
  };

  if (cache) cache.set(slug, config);
  return config;
}

function parseAllowedMethods(raw: unknown): HttpMethodName[] {
  // SpacetimeDB returns Vec<HttpMethod> as a JSON array of either
  // `"Get"` strings or `{ "Get": [] }` objects depending on version. Be
  // defensive: accept both.
  if (Array.isArray(raw)) {
    return raw
      .map((v) => {
        if (typeof v === "string") return v.toUpperCase() as HttpMethodName;
        if (typeof v === "object" && v !== null) {
          const tag = Object.keys(v as object)[0];
          return tag.toUpperCase() as HttpMethodName;
        }
        return null;
      })
      .filter((m): m is HttpMethodName => m !== null);
  }
  if (typeof raw === "string") {
    try {
      return parseAllowedMethods(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return [];
}

async function assembleRows(
  transport: StdbTransport,
  config: EndpointConfig,
  pages: Array<{
    id: string | number;
    title: string;
    created_at?: string;
    updated_at?: string;
  }>,
): Promise<RowBody[]> {
  if (pages.length === 0) return [];

  const propIdToField = new Map<number, ApiFieldMappingRow>();
  for (const m of config.mappings) {
    propIdToField.set(m.propertyDefinitionId, m);
  }
  const propsById = new Map<number, PropertyDefinitionRow>();
  for (const p of config.propertyDefinitions) propsById.set(p.id, p);

  const ids = pages.map((p) => p.id);
  const valueRows = await transport.sql<{
    page_id: string | number;
    property_definition_id: string | number;
    value: SatsPropertyValue;
  }>(
    // STDB's SQL subset doesn't support `IN (...)` — expand to an OR chain
    // (page_id has a btree index so the planner still uses it).
    `SELECT page_id, property_definition_id, value
       FROM page_property_value
      WHERE ${orClause("page_id", ids.length)}`,
    ids,
  );

  const byPage = new Map<string, Record<string, unknown>>();
  for (const p of pages) byPage.set(String(p.id), {});

  for (const v of valueRows) {
    const fields = byPage.get(String(v.page_id));
    if (!fields) continue;
    const mapping = propIdToField.get(Number(v.property_definition_id));
    if (!mapping) continue;
    fields[mapping.fieldName] = decodePropertyValue(v.value);
  }

  return pages.map((p) => ({
    id: String(p.id),
    title: p.title,
    fields: byPage.get(String(p.id)) ?? {},
    createdAt: normaliseTs(p.created_at),
    updatedAt: normaliseTs(p.updated_at),
  }));
}

function normaliseTs(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ms = Number(raw);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  return raw;
}

interface ParsedRowBody {
  title?: string;
  fields: Record<string, unknown>;
}

function parseRowBody(body: unknown): ParsedRowBody {
  if (body === null || body === undefined) return { fields: {} };
  if (typeof body !== "object") {
    throw new ApiEndpointError(
      400,
      "invalid_body",
      "Request body must be a JSON object",
    );
  }
  const obj = body as { title?: unknown; fields?: unknown };
  const title =
    typeof obj.title === "string" ? obj.title : undefined;
  let fields: Record<string, unknown>;
  if (obj.fields === undefined) {
    // Allow flat shape: { name: "...", priority: "high", ... }
    const { title: _t, ...rest } = obj as Record<string, unknown>;
    fields = rest;
  } else if (typeof obj.fields === "object" && obj.fields !== null) {
    fields = obj.fields as Record<string, unknown>;
  } else {
    throw new ApiEndpointError(
      400,
      "invalid_body",
      "`fields` must be an object",
    );
  }
  return { title, fields };
}

function buildPropertyValuesForCreate(
  config: EndpointConfig,
  fields: Record<string, unknown>,
): Array<{ property_definition_id: number; value: SatsPropertyValue }> {
  const out: Array<{
    property_definition_id: number;
    value: SatsPropertyValue;
  }> = [];
  const propsById = new Map(
    config.propertyDefinitions.map((p) => [p.id, p] as const),
  );

  for (const m of config.mappings) {
    if (m.readOnly) continue;
    const prop = propsById.get(m.propertyDefinitionId);
    if (!prop) continue;
    const provided = Object.prototype.hasOwnProperty.call(fields, m.fieldName)
      ? fields[m.fieldName]
      : undefined;

    if (provided === undefined) {
      if (m.requiredOnCreate && m.defaultValue === null) {
        throw new ApiEndpointError(
          400,
          "missing_required_field",
          `Field '${m.fieldName}' is required`,
        );
      }
      const def = parseStoredDefault(m.defaultValue);
      if (def !== null) {
        out.push({ property_definition_id: prop.id, value: def });
      }
      continue;
    }

    if (provided === null) continue; // explicit null = skip

    const encoded = encodePropertyValue(
      m.fieldName,
      prop.propertyType,
      prop.config,
      provided,
    );
    out.push({ property_definition_id: prop.id, value: encoded });
  }
  return out;
}

function buildPropertyValuesForUpdate(
  config: EndpointConfig,
  fields: Record<string, unknown>,
): {
  setValues: Array<{ property_definition_id: number; value: SatsPropertyValue }>;
  clearValues: number[];
} {
  const setValues: Array<{
    property_definition_id: number;
    value: SatsPropertyValue;
  }> = [];
  const clearValues: number[] = [];
  const propsById = new Map(
    config.propertyDefinitions.map((p) => [p.id, p] as const),
  );

  for (const m of config.mappings) {
    if (!Object.prototype.hasOwnProperty.call(fields, m.fieldName)) continue;
    if (m.readOnly) {
      throw new ApiEndpointError(
        400,
        "read_only_field",
        `Field '${m.fieldName}' is read-only`,
      );
    }
    const prop = propsById.get(m.propertyDefinitionId);
    if (!prop) continue;
    const value = fields[m.fieldName];
    if (value === null) {
      clearValues.push(prop.id);
    } else {
      const encoded = encodePropertyValue(
        m.fieldName,
        prop.propertyType,
        prop.config,
        value,
      );
      setValues.push({ property_definition_id: prop.id, value: encoded });
    }
  }
  return { setValues, clearValues };
}

function parseStoredDefault(raw: string | null): SatsPropertyValue | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed as SatsPropertyValue;
  } catch {
    return null;
  }
}

function deriveTitleFromFields(
  config: EndpointConfig,
  fields: Record<string, unknown>,
): string | undefined {
  // Convention: the first text-typed mapping named `title`, `name`, or with
  // `field_order = 0` is treated as the title source if present.
  const candidates = ["title", "name"];
  for (const candidate of candidates) {
    if (typeof fields[candidate] === "string" && (fields[candidate] as string).trim()) {
      return fields[candidate] as string;
    }
  }
  const firstTextMapping = config.mappings
    .slice()
    .sort((a, b) => a.fieldOrder - b.fieldOrder)
    .find((m) => {
      const prop = config.propertyDefinitions.find(
        (p) => p.id === m.propertyDefinitionId,
      );
      return (
        prop?.propertyType === "Text" &&
        typeof fields[m.fieldName] === "string" &&
        (fields[m.fieldName] as string).trim()
      );
    });
  if (firstTextMapping) return fields[firstTextMapping.fieldName] as string;
  return undefined;
}

function parseRowId(raw: string): number | string {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return n;
    return raw;
  }
  throw new ApiEndpointError(400, "invalid_id", `Invalid row id: ${raw}`);
}

interface LogCallArgs {
  endpointId: number;
  keyId?: number;
  method: HttpMethodName;
  path: string;
  statusCode: number;
  latencyMs: number;
  callerIp?: string;
  errorMessage?: string;
}

async function logCall(transport: StdbTransport, args: LogCallArgs): Promise<void> {
  await transport.call("log_api_call", [
    args.endpointId,
    encodeOption(args.keyId ?? null),
    encodeHttpMethod(args.method),
    args.path.length > 1024 ? args.path.slice(0, 1024) : args.path,
    args.statusCode,
    args.latencyMs,
    encodeOption(args.callerIp ?? null),
    encodeOption(
      args.errorMessage
        ? args.errorMessage.length > 2048
          ? args.errorMessage.slice(0, 2048)
          : args.errorMessage
        : null,
    ),
  ]);
}

function safeErrorMessage(response: Response): string | undefined {
  // Avoid clone/await on a response we're returning. The dispatcher only
  // ever builds error responses via `errorResponse(...)`, so we already
  // have the message in scope at the call site — this fallback returns
  // undefined and is intentionally conservative.
  return undefined;
}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, replaceBigInt), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function replaceBigInt(_: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Build `col = ? OR col = ? OR …` for `n` placeholders. SpacetimeDB's SQL
 * subset rejects `IN (…)`, so callers expand to an OR chain. The placeholder
 * order matches the params array passed to `transport.sql`. */
function orClause(col: string, n: number): string {
  if (n <= 0) {
    throw new Error(`orClause: n must be >= 1, got ${n}`);
  }
  return Array.from({ length: n }, () => `${col} = ?`).join(" OR ");
}

function errorResponse(err: unknown): Response {
  if (err instanceof ApiEndpointError) {
    const body: ErrorBody = {
      error: { code: err.code, message: err.message, details: err.details },
    };
    return json(err.status, body);
  }
  const message = err instanceof Error ? err.message : String(err);
  const body: ErrorBody = {
    error: { code: "internal_error", message },
  };
  return json(500, body);
}

function randomUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback: 16 random bytes hex-encoded with dashes.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
