/** Stateless MCP helpers for Database schema discovery and column edits. */

import type { StdbTransport } from "../api-endpoint";
import { discoverAllocatedId, readCounter } from "./ids";
import { encodeU64 } from "./encode";
import { reducerErrorMessage } from "./errors";

/**
 * Every `PropertyType` variant in DECLARATION ORDER — the wire sum arrives as
 * `[variantIndex, payload]`, so this list must mirror the Rust enum in
 * `pages/schemas.rs` exactly, computed variants included. (It previously
 * listed `File` at index 9, which is `Ai`: list_properties reported Ai columns
 * as "File" and Formula/Rollup/File as Unknown.)
 */
const PROPERTY_TYPE_ORDER = [
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
  "Formula",
  "Rollup",
  "File",
] as const;

/**
 * The subset an agent may assign. Ai/Formula/Rollup are computed columns whose
 * behaviour lives entirely in `config` (prompt, expression, rollup target), so
 * naming one as a bare type would produce a permanently-empty column.
 */
const SETTABLE_PROPERTY_TYPES = [
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

type PropertyType = (typeof SETTABLE_PROPERTY_TYPES)[number];

function decodePropertyType(raw: unknown): string {
  if (Array.isArray(raw) && typeof raw[0] === "number") {
    return PROPERTY_TYPE_ORDER[raw[0]] ?? `Unknown(${raw[0]})`;
  }
  if (raw && typeof raw === "object") {
    const key = Object.keys(raw as Record<string, unknown>)[0];
    if (key) return key[0].toUpperCase() + key.slice(1);
  }
  return "Unknown";
}

function isPropertyType(value: string): value is PropertyType {
  return (SETTABLE_PROPERTY_TYPES as readonly string[]).includes(value);
}

function encodePropertyType(propertyType: PropertyType): Record<string, []> {
  const variant = propertyType[0].toLowerCase() + propertyType.slice(1);
  return { [variant]: [] };
}

interface StoredProperty {
  id: number;
  name: string;
  property_type: string;
  config: string;
}

/**
 * Read one property definition by id. Every column edit needs the current row
 * first — to reject a bad id before calling a reducer, and to report what the
 * edit replaced.
 */
async function loadProperty(
  transport: StdbTransport,
  propertyDefinitionId: number,
): Promise<StoredProperty | null> {
  const rows = await transport.sql<{
    id: number | string;
    name: string;
    property_type: unknown;
    config?: string;
  }>("SELECT id, name, property_type, config FROM property_definition WHERE id = ?", [
    propertyDefinitionId,
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    property_type: decodePropertyType(row.property_type),
    config: row.config ?? "{}",
  };
}

/** Shared guard: a positive-integer property id naming a live definition. */
async function requireProperty(
  transport: StdbTransport,
  propertyDefinitionId: number,
): Promise<StoredProperty | { error: string }> {
  if (!Number.isSafeInteger(propertyDefinitionId) || propertyDefinitionId <= 0) {
    return { error: "property_definition_id must be a positive integer" };
  }
  const property = await loadProperty(transport, propertyDefinitionId);
  return property ?? { error: "Property definition not found" };
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
      error: `Unsupported property_type "${propertyType}". Expected one of: ${SETTABLE_PROPERTY_TYPES.join(", ")}`,
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
  const property = await requireProperty(transport, propertyDefinitionId);
  if ("error" in property) return JSON.stringify({ ok: false, error: property.error });
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

// ── Column edits ──────────────────────────────────────────────────────────────
//
// The `rename_property`/`update_property_config`/`update_property_type`
// reducers have existed since the grid shipped, but MCP only ever exposed add
// and delete — so an agent's only way to fix a column was delete + re-add,
// which discards every value in it. These three are the non-destructive path.

export async function renameProperty(
  transport: StdbTransport,
  propertyDefinitionId: number,
  name: string,
): Promise<string> {
  const property = await requireProperty(transport, propertyDefinitionId);
  if ("error" in property) return JSON.stringify({ ok: false, error: property.error });

  const nextName = String(name ?? "").trim();
  if (!nextName) return JSON.stringify({ ok: false, error: "Property name is required" });

  try {
    await transport.call("rename_property", [encodeU64(propertyDefinitionId), nextName]);
  } catch (err) {
    return JSON.stringify({ ok: false, error: reducerErrorMessage(err) });
  }
  return JSON.stringify({
    ok: true,
    property_definition_id: propertyDefinitionId,
    previous_name: property.name,
    name: nextName,
  });
}

export async function updatePropertyConfig(
  transport: StdbTransport,
  propertyDefinitionId: number,
  config: string,
): Promise<string> {
  const property = await requireProperty(transport, propertyDefinitionId);
  if ("error" in property) return JSON.stringify({ ok: false, error: property.error });

  const nextConfig = String(config ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(nextConfig);
  } catch {
    return JSON.stringify({ ok: false, error: "config must be a valid JSON string" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({
      ok: false,
      error: 'config must be a JSON object, e.g. \'{"options":["A","B"]}\'',
    });
  }

  try {
    await transport.call("update_property_config", [
      encodeU64(propertyDefinitionId),
      nextConfig,
    ]);
  } catch (err) {
    return JSON.stringify({ ok: false, error: reducerErrorMessage(err) });
  }
  // The reducer replaces config wholesale, so echo what was overwritten —
  // an agent editing Select options needs to see whether it dropped any.
  return JSON.stringify({
    ok: true,
    property_definition_id: propertyDefinitionId,
    name: property.name,
    property_type: property.property_type,
    previous_config: property.config,
    config: nextConfig,
  });
}

export async function updatePropertyType(
  transport: StdbTransport,
  propertyDefinitionId: number,
  propertyType: string,
): Promise<string> {
  const property = await requireProperty(transport, propertyDefinitionId);
  if ("error" in property) return JSON.stringify({ ok: false, error: property.error });

  const nextType = String(propertyType ?? "");
  if (!isPropertyType(nextType)) {
    return JSON.stringify({
      ok: false,
      error: `Unsupported property_type "${nextType}". Expected one of: ${SETTABLE_PROPERTY_TYPES.join(", ")}`,
    });
  }
  if (nextType === property.property_type) {
    return JSON.stringify({
      ok: true,
      property_definition_id: propertyDefinitionId,
      name: property.name,
      property_type: nextType,
      unchanged: true,
    });
  }

  try {
    await transport.call("update_property_type", [
      encodeU64(propertyDefinitionId),
      encodePropertyType(nextType),
    ]);
  } catch (err) {
    return JSON.stringify({ ok: false, error: reducerErrorMessage(err) });
  }
  // The reducer resets config to "{}" and does NOT rewrite stored cell values,
  // which keep their old PropertyValue variant until each row is set again.
  return JSON.stringify({
    ok: true,
    property_definition_id: propertyDefinitionId,
    name: property.name,
    previous_property_type: property.property_type,
    property_type: nextType,
    config_reset: property.config !== "{}" ? property.config : undefined,
    note:
      "Existing cell values were NOT converted — they keep their old type until each row is " +
      "rewritten with set_row_properties. Config was reset to {}.",
  });
}
