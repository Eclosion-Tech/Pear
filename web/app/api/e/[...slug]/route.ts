import { NextResponse, type NextRequest } from "next/server";
import {
  query,
  callReducer,
  satsOption,
  satsPropertyValue,
  decodeSatsPropertyValue,
  decodeSatsEnum,
  isGatewayConfigured,
} from "@/src/lib/spacetimeApi";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EndpointConfig {
  id: number;
  database_page_id: number;
  slug: string;
  display_name: string;
  description: string;
  allowed_methods: unknown[];
  require_auth: boolean;
}

interface FieldMapping {
  id: number;
  endpoint_id: number;
  property_definition_id: number;
  field_name: string;
  required_on_create: boolean;
  default_value: string | null;
  read_only: boolean;
  field_order: number;
  property_type?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(
  code: string,
  message: string,
  status: number
): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

function methodFromSats(satsMethod: unknown): string | null {
  return decodeSatsEnum(satsMethod);
}

function endpointAllowsMethod(
  endpoint: EndpointConfig,
  method: string
): boolean {
  const allowed = endpoint.allowed_methods ?? [];
  const httpMethod = method.toUpperCase();
  const satsName =
    httpMethod === "GET"
      ? "Get"
      : httpMethod === "POST"
        ? "Post"
        : httpMethod === "PATCH"
          ? "Patch"
          : httpMethod === "DELETE"
            ? "Delete"
            : null;
  if (!satsName) return false;

  return allowed.some((m) => {
    const decoded = methodFromSats(m);
    return decoded === satsName;
  });
}

async function hashKey(raw: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

async function loadEndpoint(slug: string): Promise<EndpointConfig | null> {
  const escaped = slug.replace(/'/g, "''");
  const result = await query(
    `SELECT * FROM api_endpoint WHERE slug = '${escaped}'`
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as unknown as EndpointConfig;
}

async function loadFieldMappings(endpointId: number): Promise<FieldMapping[]> {
  const result = await query(
    `SELECT m.*, p.property_type FROM api_field_mapping m ` +
      `JOIN property_definition p ON m.property_definition_id = p.id ` +
      `WHERE m.endpoint_id = ${endpointId}`
  );

  const mappings = result.rows.map((row) => {
    const m = row as unknown as FieldMapping & {
      property_type?: unknown;
    };
    if (m.property_type && typeof m.property_type === "object") {
      m.property_type = decodeSatsEnum(m.property_type) ?? "Text";
    }
    return m;
  });

  mappings.sort(
    (a, b) => (a.field_order ?? 0) - (b.field_order ?? 0)
  );
  return mappings;
}

async function validateApiKey(
  endpointId: number,
  bearerToken: string,
  httpMethod: string
): Promise<{ valid: boolean; reason?: string }> {
  const keyHash = await hashKey(bearerToken);
  const escaped = keyHash.replace(/'/g, "''");

  const result = await query(
    `SELECT * FROM api_endpoint_key WHERE endpoint_id = ${endpointId} AND key_hash = '${escaped}'`
  );

  if (result.rows.length === 0) {
    return { valid: false, reason: "Invalid API key" };
  }

  const key = result.rows[0] as Record<string, unknown>;

  // Check expiry
  if (key.expires_at !== null && key.expires_at !== undefined) {
    const expiresDecoded = decodeSatsEnum(key.expires_at);
    if (expiresDecoded === "some") {
      const expiresVal = (key.expires_at as Record<string, unknown>)["some"];
      if (typeof expiresVal === "number" && expiresVal < Date.now() * 1000) {
        return { valid: false, reason: "API key has expired" };
      }
    }
  }

  // Check method permissions
  const allowedMethods = (key.allowed_methods ?? []) as unknown[];
  const satsName =
    httpMethod === "GET"
      ? "Get"
      : httpMethod === "POST"
        ? "Post"
        : httpMethod === "PATCH"
          ? "Patch"
          : httpMethod === "DELETE"
            ? "Delete"
            : null;

  if (satsName) {
    const methodAllowed = allowedMethods.some(
      (m) => decodeSatsEnum(m) === satsName
    );
    if (!methodAllowed) {
      return {
        valid: false,
        reason: `API key does not permit ${httpMethod} requests`,
      };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// GET — list rows (with filtering and sorting)
// ---------------------------------------------------------------------------

/** Reserved query params that are not field filters. */
const RESERVED_PARAMS = new Set([
  "limit",
  "offset",
  "id",
  "sort",
  "title",
]);

function buildRow(
  page: Record<string, unknown>,
  mappings: FieldMapping[],
  propIndex: Map<string, unknown>
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: page.id,
    title: page.title,
  };
  for (const mapping of mappings) {
    const key = `${page.id}:${mapping.property_definition_id}`;
    const satsVal = propIndex.get(key);
    if (satsVal !== undefined) {
      const decoded = decodeSatsPropertyValue(satsVal);
      row[mapping.field_name] = decoded ? decoded.value : null;
    } else {
      row[mapping.field_name] = null;
    }
  }
  return row;
}

async function handleGet(
  endpoint: EndpointConfig,
  mappings: FieldMapping[],
  request: NextRequest
): Promise<NextResponse> {
  const url = new URL(request.url);
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "50", 10),
    500
  );
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const rowId = url.searchParams.get("id");
  const sortParam = url.searchParams.get("sort");
  const titleFilter = url.searchParams.get("title");

  if (rowId) {
    return handleGetOne(endpoint, mappings, parseInt(rowId, 10));
  }

  // Collect field filters from query params (e.g. ?priority=high&status=open)
  const fieldFilters = new Map<string, string>();
  const mappingByFieldName = new Map<string, FieldMapping>();
  for (const m of mappings) {
    mappingByFieldName.set(m.field_name, m);
  }
  for (const [key, value] of url.searchParams.entries()) {
    if (!RESERVED_PARAMS.has(key) && mappingByFieldName.has(key)) {
      fieldFilters.set(key, value);
    }
  }

  // Get all child pages (rows) of the database
  const pagesResult = await query(
    `SELECT id, title, created_at, updated_at, sort_order FROM page ` +
      `WHERE parent_id = ${endpoint.database_page_id} AND deleted_at IS NULL ` +
      `ORDER BY sort_order ASC`
  );

  let allPages = pagesResult.rows;

  // Apply title filter if provided
  if (titleFilter) {
    const lower = titleFilter.toLowerCase();
    allPages = allPages.filter((p) =>
      String(p.title ?? "")
        .toLowerCase()
        .includes(lower)
    );
  }

  if (allPages.length === 0) {
    return NextResponse.json({
      data: [],
      pagination: { offset, limit, total: 0 },
    });
  }

  // Load property values for ALL pages (needed for filtering before pagination)
  const allPageIds = allPages.map((p) => p.id);
  const propDefIds = mappings.map((m) => m.property_definition_id);

  let propValues: Record<string, unknown>[] = [];
  if (propDefIds.length > 0 && allPageIds.length > 0) {
    const propResult = await query(
      `SELECT page_id, property_definition_id, value FROM page_property_value ` +
        `WHERE page_id IN (${allPageIds.join(",")}) ` +
        `AND property_definition_id IN (${propDefIds.join(",")})`
    );
    propValues = propResult.rows;
  }

  const propIndex = new Map<string, unknown>();
  for (const pv of propValues) {
    const key = `${pv.page_id}:${pv.property_definition_id}`;
    propIndex.set(key, pv.value);
  }

  // Build full rows for filtering and sorting
  let data = allPages.map((page) => buildRow(page, mappings, propIndex));

  // Apply field filters
  for (const [fieldName, filterValue] of fieldFilters) {
    data = data.filter((row) => {
      const val = row[fieldName];
      if (val === null || val === undefined) return false;
      if (Array.isArray(val)) {
        return val.some(
          (v) => String(v).toLowerCase() === filterValue.toLowerCase()
        );
      }
      return String(val).toLowerCase() === filterValue.toLowerCase();
    });
  }

  // Apply sorting: ?sort=priority (asc) or ?sort=-priority (desc)
  // Supports comma-separated fields: ?sort=-priority,title
  if (sortParam) {
    const sortFields = sortParam.split(",").map((s) => {
      const desc = s.startsWith("-");
      const field = desc ? s.slice(1) : s;
      return { field, desc };
    });

    data.sort((a, b) => {
      for (const { field, desc } of sortFields) {
        const va = a[field];
        const vb = b[field];
        let cmp = 0;
        if (va === null && vb !== null) cmp = 1;
        else if (va !== null && vb === null) cmp = -1;
        else if (typeof va === "number" && typeof vb === "number")
          cmp = va - vb;
        else if (typeof va === "string" && typeof vb === "string")
          cmp = va.localeCompare(vb);
        else if (typeof va === "boolean" && typeof vb === "boolean")
          cmp = Number(va) - Number(vb);
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });
  }

  const total = data.length;
  const pagedData = data.slice(offset, offset + limit);

  return NextResponse.json({
    data: pagedData,
    pagination: { offset, limit, total },
  });
}

async function handleGetOne(
  endpoint: EndpointConfig,
  mappings: FieldMapping[],
  pageId: number
): Promise<NextResponse> {
  const pageResult = await query(
    `SELECT id, title, created_at, updated_at FROM page ` +
      `WHERE id = ${pageId} AND parent_id = ${endpoint.database_page_id} AND deleted_at IS NULL`
  );

  if (pageResult.rows.length === 0) {
    return jsonError("NOT_FOUND", "Row not found", 404);
  }

  const page = pageResult.rows[0];
  const propDefIds = mappings.map((m) => m.property_definition_id);

  let propValues: Record<string, unknown>[] = [];
  if (propDefIds.length > 0) {
    const propResult = await query(
      `SELECT property_definition_id, value FROM page_property_value ` +
        `WHERE page_id = ${pageId} AND property_definition_id IN (${propDefIds.join(",")})`
    );
    propValues = propResult.rows;
  }

  const propMap = new Map<number, unknown>();
  for (const pv of propValues) {
    propMap.set(pv.property_definition_id as number, pv.value);
  }

  const row: Record<string, unknown> = {
    id: page.id,
    title: page.title,
  };

  for (const mapping of mappings) {
    const satsVal = propMap.get(mapping.property_definition_id);
    if (satsVal !== undefined) {
      const decoded = decodeSatsPropertyValue(satsVal);
      row[mapping.field_name] = decoded ? decoded.value : null;
    } else {
      row[mapping.field_name] = null;
    }
  }

  return NextResponse.json({ data: row });
}

// ---------------------------------------------------------------------------
// POST — create row
// ---------------------------------------------------------------------------

async function handlePost(
  endpoint: EndpointConfig,
  mappings: FieldMapping[],
  request: NextRequest
): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  // Validate required fields
  for (const mapping of mappings) {
    if (
      mapping.required_on_create &&
      !mapping.read_only &&
      body[mapping.field_name] === undefined
    ) {
      if (!mapping.default_value) {
        return jsonError(
          "VALIDATION_ERROR",
          `Field '${mapping.field_name}' is required`,
          400
        );
      }
    }
  }

  // Use 'title' from body, or first text field, or default
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : "Untitled";

  // Create the page (row) under the database
  await callReducer("create_page", [
    satsOption(endpoint.database_page_id),
    { Doc: [] },
    title,
  ]);

  // Find the newly created page (most recent child of this database)
  const newPageResult = await query(
    `SELECT id FROM page WHERE parent_id = ${endpoint.database_page_id} ` +
      `AND deleted_at IS NULL ORDER BY id DESC`
  );

  if (newPageResult.rows.length === 0) {
    return jsonError("INTERNAL_ERROR", "Failed to create row", 500);
  }

  const newPageId = newPageResult.rows[0].id as number;

  // Set property values for each mapped field
  const responseRow: Record<string, unknown> = {
    id: newPageId,
    title,
  };

  for (const mapping of mappings) {
    if (mapping.read_only) continue;

    let rawValue = body[mapping.field_name];

    // Apply default if not provided
    if (rawValue === undefined && mapping.default_value) {
      try {
        rawValue = JSON.parse(mapping.default_value);
      } catch {
        rawValue = mapping.default_value;
      }
    }

    if (rawValue === undefined || rawValue === null) {
      responseRow[mapping.field_name] = null;
      continue;
    }

    const propertyType = mapping.property_type ?? "Text";
    const satsValue = satsPropertyValue(propertyType, rawValue);

    try {
      await callReducer("set_property_value", [
        newPageId,
        mapping.property_definition_id,
        satsValue,
      ]);
      responseRow[mapping.field_name] = rawValue;
    } catch (err) {
      console.error(
        `[api/e] Failed to set property ${mapping.field_name}:`,
        err
      );
      responseRow[mapping.field_name] = null;
    }
  }

  return NextResponse.json({ data: responseRow, created: true }, { status: 201 });
}

// ---------------------------------------------------------------------------
// PATCH — update row
// ---------------------------------------------------------------------------

async function handlePatch(
  endpoint: EndpointConfig,
  mappings: FieldMapping[],
  request: NextRequest
): Promise<NextResponse> {
  const url = new URL(request.url);
  const rowId = url.searchParams.get("id");

  if (!rowId) {
    return jsonError(
      "VALIDATION_ERROR",
      "Query parameter 'id' is required for PATCH",
      400
    );
  }

  const pageId = parseInt(rowId, 10);

  // Verify the row belongs to this database
  const pageResult = await query(
    `SELECT id, title FROM page WHERE id = ${pageId} ` +
      `AND parent_id = ${endpoint.database_page_id} AND deleted_at IS NULL`
  );

  if (pageResult.rows.length === 0) {
    return jsonError("NOT_FOUND", "Row not found", 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  // Update title if provided
  if (typeof body.title === "string" && body.title.trim()) {
    await callReducer("update_page_title", [pageId, body.title.trim()]);
  }

  // Update property values
  for (const mapping of mappings) {
    if (mapping.read_only) continue;

    const rawValue = body[mapping.field_name];
    if (rawValue === undefined) continue;

    const propertyType = mapping.property_type ?? "Text";
    const satsValue = satsPropertyValue(propertyType, rawValue);

    try {
      await callReducer("set_property_value", [
        pageId,
        mapping.property_definition_id,
        satsValue,
      ]);
    } catch (err) {
      console.error(
        `[api/e] Failed to update property ${mapping.field_name}:`,
        err
      );
    }
  }

  // Return the updated row
  return handleGetOne(endpoint, mappings, pageId);
}

// ---------------------------------------------------------------------------
// DELETE — soft-delete row
// ---------------------------------------------------------------------------

async function handleDelete(
  endpoint: EndpointConfig,
  _mappings: FieldMapping[],
  request: NextRequest
): Promise<NextResponse> {
  const url = new URL(request.url);
  const rowId = url.searchParams.get("id");

  if (!rowId) {
    return jsonError(
      "VALIDATION_ERROR",
      "Query parameter 'id' is required for DELETE",
      400
    );
  }

  const pageId = parseInt(rowId, 10);

  // Verify the row belongs to this database
  const pageResult = await query(
    `SELECT id FROM page WHERE id = ${pageId} ` +
      `AND parent_id = ${endpoint.database_page_id} AND deleted_at IS NULL`
  );

  if (pageResult.rows.length === 0) {
    return jsonError("NOT_FOUND", "Row not found", 404);
  }

  await callReducer("delete_page", [pageId]);

  return NextResponse.json({ deleted: true, id: pageId });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleRequest(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }
): Promise<NextResponse> {
  if (!isGatewayConfigured()) {
    return jsonError(
      "NOT_CONFIGURED",
      "Custom API endpoints are not configured. Set SPACETIMEDB_PROXY_ORIGIN and SPACETIMEDB_DB_NAME.",
      503
    );
  }

  const { slug } = await params;

  // slug is an array of path segments; we use the first as the endpoint slug
  const endpointSlug = slug[0];
  if (!endpointSlug) {
    return jsonError("NOT_FOUND", "Endpoint not found", 404);
  }

  // Handle _schema sub-path (OpenAPI spec)
  if (slug.length > 1 && slug[1] === "_schema") {
    return handleSchema(endpointSlug);
  }

  // Load endpoint config
  let endpoint: EndpointConfig | null;
  try {
    endpoint = await loadEndpoint(endpointSlug);
  } catch (err) {
    console.error("[api/e] Failed to load endpoint config:", err);
    return jsonError("INTERNAL_ERROR", "Failed to load endpoint configuration", 500);
  }

  if (!endpoint) {
    return jsonError("NOT_FOUND", `Endpoint '${endpointSlug}' not found`, 404);
  }

  // Check method is allowed
  const method = request.method.toUpperCase();
  if (!endpointAllowsMethod(endpoint, method)) {
    return jsonError(
      "METHOD_NOT_ALLOWED",
      `${method} is not allowed on this endpoint`,
      405
    );
  }

  // Authenticate if required
  if (endpoint.require_auth) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return jsonError(
        "UNAUTHORIZED",
        "Authorization header with Bearer token is required",
        401
      );
    }

    const bearerToken = authHeader.slice(7).trim();
    if (!bearerToken) {
      return jsonError("UNAUTHORIZED", "Bearer token is empty", 401);
    }

    try {
      const authResult = await validateApiKey(endpoint.id, bearerToken, method);
      if (!authResult.valid) {
        return jsonError(
          "UNAUTHORIZED",
          authResult.reason ?? "Authentication failed",
          401
        );
      }
    } catch (err) {
      console.error("[api/e] Auth validation error:", err);
      return jsonError("INTERNAL_ERROR", "Authentication check failed", 500);
    }
  }

  // Load field mappings
  let mappings: FieldMapping[];
  try {
    mappings = await loadFieldMappings(endpoint.id);
  } catch (err) {
    console.error("[api/e] Failed to load field mappings:", err);
    return jsonError("INTERNAL_ERROR", "Failed to load field mappings", 500);
  }

  // Dispatch to method handler
  switch (method) {
    case "GET":
      return handleGet(endpoint, mappings, request);
    case "POST":
      return handlePost(endpoint, mappings, request);
    case "PATCH":
      return handlePatch(endpoint, mappings, request);
    case "DELETE":
      return handleDelete(endpoint, mappings, request);
    default:
      return jsonError("METHOD_NOT_ALLOWED", `${method} is not supported`, 405);
  }
}

// ---------------------------------------------------------------------------
// OpenAPI schema generation (stub — fleshed out in Phase 2b)
// ---------------------------------------------------------------------------

async function handleSchema(endpointSlug: string): Promise<NextResponse> {
  const endpoint = await loadEndpoint(endpointSlug);
  if (!endpoint) {
    return jsonError("NOT_FOUND", `Endpoint '${endpointSlug}' not found`, 404);
  }

  const mappings = await loadFieldMappings(endpoint.id);

  const properties: Record<string, unknown> = {
    id: { type: "integer", description: "Row ID", readOnly: true },
    title: { type: "string", description: "Row title" },
  };
  const required: string[] = [];

  for (const m of mappings) {
    const propType = m.property_type ?? "Text";
    let jsonType = "string";
    let jsonFormat: string | undefined;

    switch (propType) {
      case "Number":
        jsonType = "number";
        break;
      case "Checkbox":
        jsonType = "boolean";
        break;
      case "Date":
        jsonType = "integer";
        jsonFormat = "unix-timestamp-micros";
        break;
      case "MultiSelect":
      case "Relation":
      case "Person":
        jsonType = "array";
        break;
    }

    const prop: Record<string, unknown> = {
      type: jsonType,
      ...(jsonFormat ? { format: jsonFormat } : {}),
      ...(m.read_only ? { readOnly: true } : {}),
    };
    if (jsonType === "array") {
      prop.items = { type: propType === "Number" ? "integer" : "string" };
    }

    properties[m.field_name] = prop;
    if (m.required_on_create && !m.read_only) {
      required.push(m.field_name);
    }
  }

  const allowedMethods = endpoint.allowed_methods
    .map((m) => decodeSatsEnum(m)?.toLowerCase())
    .filter(Boolean);

  const paths: Record<string, unknown> = {};
  const pathKey = `/api/e/${endpoint.slug}`;

  if (allowedMethods.includes("get")) {
    paths[pathKey] = {
      ...((paths[pathKey] as Record<string, unknown>) ?? {}),
      get: {
        summary: `List ${endpoint.display_name}`,
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 50, maximum: 500 },
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0 },
          },
          {
            name: "id",
            in: "query",
            schema: { type: "integer" },
            description: "Return a single row by ID",
          },
          {
            name: "sort",
            in: "query",
            schema: { type: "string" },
            description:
              "Sort by field(s). Prefix with - for descending. Comma-separated for multiple fields. Example: -priority,title",
          },
          {
            name: "title",
            in: "query",
            schema: { type: "string" },
            description: "Filter rows by title (case-insensitive substring match)",
          },
          ...mappings.map((m) => ({
            name: m.field_name,
            in: "query",
            schema: { type: "string" },
            description: `Filter by ${m.field_name} (exact match, case-insensitive)`,
          })),
        ],
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: {
                        type: "object",
                        properties,
                      },
                    },
                    pagination: {
                      type: "object",
                      properties: {
                        offset: { type: "integer" },
                        limit: { type: "integer" },
                        total: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  if (allowedMethods.includes("post")) {
    paths[pathKey] = {
      ...((paths[pathKey] as Record<string, unknown>) ?? {}),
      post: {
        summary: `Create ${endpoint.display_name}`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties,
                ...(required.length > 0 ? { required } : {}),
              },
            },
          },
        },
        responses: {
          "201": { description: "Created" },
        },
      },
    };
  }

  const spec = {
    openapi: "3.1.0",
    info: {
      title: endpoint.display_name,
      description: endpoint.description,
      version: "1.0.0",
    },
    servers: [{ url: "/" }],
    paths,
    ...(endpoint.require_auth
      ? {
          components: {
            securitySchemes: {
              bearerAuth: {
                type: "http",
                scheme: "bearer",
              },
            },
          },
          security: [{ bearerAuth: [] }],
        }
      : {}),
  };

  return NextResponse.json(spec, {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Export handlers
// ---------------------------------------------------------------------------

export const GET = handleRequest;
export const POST = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
