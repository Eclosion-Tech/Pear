/** Stateless MCP helpers for Database schema discovery and column creation. */

import type { StdbTransport } from "../api-endpoint";
import { discoverAllocatedId, readCounter } from "./ids";
import { encodeU64 } from "./encode";
import { reducerErrorMessage } from "./errors";

const PROPERTY_TYPES = [
  "Text",
  "Number",
  "Date",
  "Select",
  "MultiSelect",
  "Relation",
  "Checkbox",
  "Url",
  "Person",
  "File",
] as const;

type PropertyType = (typeof PROPERTY_TYPES)[number];

function decodePropertyType(raw: unknown): string {
  if (Array.isArray(raw) && typeof raw[0] === "number") {
    return PROPERTY_TYPES[raw[0]] ?? `Unknown(${raw[0]})`;
  }
  if (raw && typeof raw === "object") {
    const key = Object.keys(raw as Record<string, unknown>)[0];
    if (key) return key[0].toUpperCase() + key.slice(1);
  }
  return "Unknown";
}

function isPropertyType(value: string): value is PropertyType {
  return (PROPERTY_TYPES as readonly string[]).includes(value);
}

function encodePropertyType(propertyType: PropertyType): Record<string, []> {
  const variant = propertyType[0].toLowerCase() + propertyType.slice(1);
  return { [variant]: [] };
}

export async function getSchemaId(
  transport: StdbTransport,
  pageId: number,
): Promise<string> {
  if (!Number.isSafeInteger(pageId) || pageId <= 0) {
    return JSON.stringify({ ok: false, error: "page_id must be a positive integer" });
  }
  const rows = await transport.sql<{ id: number | string }>(
    "SELECT id FROM database_schema WHERE page_id = ?",
    [pageId],
  );
  const schemaId = Number(rows[0]?.id);
  if (!Number.isSafeInteger(schemaId) || schemaId <= 0) {
    return JSON.stringify({ ok: false, error: "No schema found for this page" });
  }
  return JSON.stringify({ ok: true, schema_id: schemaId });
}

export async function listProperties(
  transport: StdbTransport,
  schemaId: number,
): Promise<string> {
  if (!Number.isSafeInteger(schemaId) || schemaId <= 0) {
    return JSON.stringify({ ok: false, error: "schema_id must be a positive integer" });
  }
  const rows = await transport.sql<{
    id: number | string;
    name: string;
    property_type: unknown;
    config?: string;
    order?: number | string;
  }>(
    'SELECT id, name, property_type, config, "order" FROM property_definition WHERE schema_id = ?',
    [schemaId],
  );
  const properties = rows
    .map((row) => ({
      property_definition_id: Number(row.id),
      name: row.name,
      property_type: decodePropertyType(row.property_type),
      config: row.config ?? "{}",
      order: Number(row.order ?? 0),
    }))
    .sort((a, b) => a.order - b.order);
  return JSON.stringify({ ok: true, schema_id: schemaId, properties });
}

export async function addProperty(
  transport: StdbTransport,
  input: Record<string, unknown>,
): Promise<string> {
  const schemaId = Number(input.schema_id);
  const name = String(input.name ?? "").trim();
  const propertyType = String(input.property_type ?? "");
  const config = input.config === undefined ? "{}" : String(input.config);

  if (!Number.isSafeInteger(schemaId) || schemaId <= 0) {
    return JSON.stringify({ ok: false, error: "schema_id must be a positive integer" });
  }
  if (!name) return JSON.stringify({ ok: false, error: "Property name is required" });
  if (!isPropertyType(propertyType)) {
    return JSON.stringify({
      ok: false,
      error: `Unsupported property_type "${propertyType}". Expected one of: ${PROPERTY_TYPES.join(", ")}`,
    });
  }
  try {
    JSON.parse(config);
  } catch {
    return JSON.stringify({ ok: false, error: "config must be a valid JSON string" });
  }

  const before = await readCounter(transport, "property_definition");
  try {
    await transport.call("add_property", [
      encodeU64(schemaId),
      name,
      encodePropertyType(propertyType),
      config,
    ]);
  } catch (err) {
    return JSON.stringify({ ok: false, error: reducerErrorMessage(err) });
  }

  const propertyId = await discoverAllocatedId(
    transport,
    "property_definition",
    before,
    async (lo, hi) => {
      const rows = await transport.sql<{
        id: number | string;
        name: string;
      }>("SELECT id, name FROM property_definition WHERE schema_id = ?", [schemaId]);
      const candidates = rows
        .filter((row) => row.name === name)
        .map((row) => Number(row.id))
        .filter((id) => id > lo && id <= hi)
        .sort((a, b) => b - a);
      return candidates[0] ?? null;
    },
  );

  return JSON.stringify({
    ok: true,
    property_id: propertyId ?? undefined,
    name,
    property_type: propertyType,
  });
}

export async function deleteProperty(
  transport: StdbTransport,
  propertyDefinitionId: number,
): Promise<string> {
  if (!Number.isSafeInteger(propertyDefinitionId) || propertyDefinitionId <= 0) {
    return JSON.stringify({
      ok: false,
      error: "property_definition_id must be a positive integer",
    });
  }
  const rows = await transport.sql<{
    id: number | string;
    name: string;
  }>("SELECT id, name FROM property_definition WHERE id = ?", [propertyDefinitionId]);
  const property = rows[0];
  if (!property) {
    return JSON.stringify({ ok: false, error: "Property definition not found" });
  }
  try {
    await transport.call("delete_property", [encodeU64(propertyDefinitionId)]);
  } catch (err) {
    return JSON.stringify({ ok: false, error: reducerErrorMessage(err) });
  }
  return JSON.stringify({
    ok: true,
    property_definition_id: propertyDefinitionId,
    name: property.name,
  });
}
