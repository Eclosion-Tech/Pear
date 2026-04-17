/**
 * OpenAPI 3.1 generator for a custom API endpoint.
 *
 * Given an `EndpointConfig` (endpoint + field mappings + property
 * definitions) and the public-facing base URL, produce a valid OpenAPI
 * document describing the four CRUD operations the dispatcher exposes.
 *
 * Output is consumed by:
 *   - The "Recent calls" / docs panel in `ApiEndpointsSettings.tsx`
 *     (rendered with Stoplight Elements).
 *   - External tools fetching `<endpoint-url>/_schema` directly.
 */

import type { EndpointConfig, PropertyTypeName } from "./types";

export interface BuildOpenApiSpecArgs {
  config: EndpointConfig;
  /** Public base URL, e.g. `https://acme.api.pear.pro/e/fruit`. */
  baseUrl: string;
}

interface OpenApiSchema {
  type?: string;
  format?: string;
  enum?: string[];
  items?: OpenApiSchema;
  description?: string;
  nullable?: boolean;
  example?: unknown;
}

function jsonSchemaForProperty(
  propertyType: PropertyTypeName,
  config: string,
): OpenApiSchema {
  let parsed: { options?: string[] } = {};
  try {
    parsed = JSON.parse(config) as { options?: string[] };
  } catch {
    /* config is not always JSON */
  }

  switch (propertyType) {
    case "Text":
      return { type: "string" };
    case "Url":
      return { type: "string", format: "uri" };
    case "Number":
      return { type: "number" };
    case "Date":
      return { type: "string", format: "date-time" };
    case "Checkbox":
      return { type: "boolean" };
    case "Select":
      return parsed.options && parsed.options.length > 0
        ? { type: "string", enum: parsed.options }
        : { type: "string" };
    case "MultiSelect":
      return {
        type: "array",
        items:
          parsed.options && parsed.options.length > 0
            ? { type: "string", enum: parsed.options }
            : { type: "string" },
      };
    case "Person":
      return {
        type: "array",
        items: { type: "string", description: "User identity (hex)" },
      };
    case "Relation":
      return {
        type: "array",
        items: { type: "string", description: "Page id (uint64 as string)" },
      };
  }
}

export function buildOpenApiSpec(args: BuildOpenApiSpecArgs): unknown {
  const { config, baseUrl } = args;
  const { endpoint, mappings, propertyDefinitions } = config;

  const propsById = new Map(propertyDefinitions.map((p) => [p.id, p] as const));

  const fieldsSchema: Record<string, OpenApiSchema> = {};
  const requiredOnCreate: string[] = [];
  const readOnlyFields: string[] = [];

  for (const m of mappings) {
    const prop = propsById.get(m.propertyDefinitionId);
    if (!prop) continue;
    fieldsSchema[m.fieldName] = jsonSchemaForProperty(
      prop.propertyType,
      prop.config,
    );
    if (m.requiredOnCreate) requiredOnCreate.push(m.fieldName);
    if (m.readOnly) readOnlyFields.push(m.fieldName);
  }

  const rowSchema = {
    type: "object",
    required: ["id", "title", "fields"],
    properties: {
      id: { type: "string", description: "Page id (uint64 as string)" },
      title: { type: "string" },
      fields: {
        type: "object",
        properties: fieldsSchema,
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  };

  const createBody = {
    type: "object",
    required: requiredOnCreate.length > 0 ? ["fields", ...maybeTitle()] : maybeTitle(),
    properties: {
      title: { type: "string" },
      fields: {
        type: "object",
        required: requiredOnCreate,
        properties: Object.fromEntries(
          Object.entries(fieldsSchema).filter(
            ([name]) => !readOnlyFields.includes(name),
          ),
        ),
      },
    },
  };

  const updateBody = {
    type: "object",
    properties: {
      title: { type: "string" },
      fields: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(fieldsSchema).filter(
            ([name]) => !readOnlyFields.includes(name),
          ),
        ),
      },
    },
  };

  const errorSchema = {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          details: {},
        },
      },
    },
  };

  const securitySchemes = endpoint.requireAuth
    ? {
        ApiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "pear_*",
        },
      }
    : {};
  const security = endpoint.requireAuth ? [{ ApiKey: [] }] : [];

  const errorResponses = {
    "400": {
      description: "Validation failed",
      content: { "application/json": { schema: errorSchema } },
    },
    "401": {
      description: "Authentication required",
      content: { "application/json": { schema: errorSchema } },
    },
    "403": {
      description: "Forbidden — method not permitted by the API key",
      content: { "application/json": { schema: errorSchema } },
    },
    "404": {
      description: "Not found",
      content: { "application/json": { schema: errorSchema } },
    },
    "405": {
      description: "Method not allowed by the endpoint",
      content: { "application/json": { schema: errorSchema } },
    },
    "429": {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: errorSchema } },
    },
  };

  const paths: Record<string, unknown> = {
    "/": {
      get: {
        summary: `List ${endpoint.displayName} rows`,
        operationId: "listRows",
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
        ],
        responses: {
          "200": {
            description: "List of rows",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: rowSchema },
                    pagination: {
                      type: "object",
                      properties: {
                        limit: { type: "integer" },
                        offset: { type: "integer" },
                        total: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
          ...errorResponses,
        },
      },
      post: {
        summary: `Create a ${endpoint.displayName} row`,
        operationId: "createRow",
        requestBody: {
          required: true,
          content: { "application/json": { schema: createBody } },
        },
        responses: {
          "201": {
            description: "Created",
            content: { "application/json": { schema: rowSchema } },
          },
          ...errorResponses,
        },
      },
    },
    "/{id}": {
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      get: {
        summary: `Fetch one ${endpoint.displayName} row`,
        operationId: "getRow",
        responses: {
          "200": {
            description: "The row",
            content: { "application/json": { schema: rowSchema } },
          },
          ...errorResponses,
        },
      },
      patch: {
        summary: `Update a ${endpoint.displayName} row`,
        operationId: "updateRow",
        requestBody: {
          required: true,
          content: { "application/json": { schema: updateBody } },
        },
        responses: {
          "200": {
            description: "Updated row",
            content: { "application/json": { schema: rowSchema } },
          },
          ...errorResponses,
        },
      },
      delete: {
        summary: `Delete a ${endpoint.displayName} row`,
        operationId: "deleteRow",
        responses: {
          "204": { description: "Deleted" },
          ...errorResponses,
        },
      },
    },
  };

  // Trim methods the endpoint has not allowed.
  const allowed = new Set(endpoint.allowedMethods);
  if (!allowed.has("GET")) {
    delete (paths["/"] as Record<string, unknown>).get;
    delete (paths["/{id}"] as Record<string, unknown>).get;
  }
  if (!allowed.has("POST")) delete (paths["/"] as Record<string, unknown>).post;
  if (!allowed.has("PATCH"))
    delete (paths["/{id}"] as Record<string, unknown>).patch;
  if (!allowed.has("DELETE"))
    delete (paths["/{id}"] as Record<string, unknown>).delete;

  return {
    openapi: "3.1.0",
    info: {
      title: endpoint.displayName,
      description:
        endpoint.description ||
        `Custom Pear API endpoint backed by the '${endpoint.slug}' database.`,
      version: "1.0.0",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes,
      schemas: {
        Row: rowSchema,
        Error: errorSchema,
      },
    },
    security,
    paths,
  };
}

function maybeTitle(): string[] {
  // `title` is always optional on create — server falls back to the value of
  // the mapped title field or "Untitled". Returned as a no-op required list
  // helper so the spec stays readable.
  return [];
}
