import { bindingRecordId } from "@eclosion-tech/trellis";
import { readPropertyReference, propertyId } from "@pear/trellis-ui";
import type { StdbTransport } from "./types";
import { decodeEnumVariant, isOptionNone, unwrapScalar } from "./decode";
import { decodeCellValue } from "./database";

export type ResolvedProperty = { status: "ready"; value: string; source: { page_id: string; property_id: string; schema_id: string }; page_title: string; property_name: string }
  | { status: "unavailable" | "unsupported" | "missing-context" | "unconfigured" };
const TYPES = ["TEXT", "NUMBER", "DATE", "SELECT", "MULTISELECT", "RELATION", "CHECKBOX", "URL", "PERSON", "AI", "FORMULA", "ROLLUP", "FILE"];
function id(raw: unknown) {
  if (typeof raw === "number" && !Number.isSafeInteger(raw)) throw new Error("Rounded identity");
  return propertyId(String(unwrapScalar(raw)));
}
/** Each query is made with the viewing AI user's token. No publisher/service transport or cached value. */
export async function readPropertyReferenceValue(transport: StdbTransport, raw: unknown, containingPageId?: string): Promise<ResolvedProperty> {
  let ref;
  try { ref = readPropertyReference(raw); } catch { return { status: raw === "{}" ? "unconfigured" : "unsupported" }; }
  const pageId = bindingRecordId(ref.binding, containingPageId);
  if (!pageId) return { status: "missing-context" };
  try {
    propertyId(pageId);
    // Join the live source page to the connected schema; RLS applies to both.
    const sourceQuery = `SELECT page.* FROM page JOIN database_schema ON page.parent_pk = database_schema.page_id WHERE page.id = ${pageId} AND database_schema.id = ${ref.schemaId}`;
    type Source = { id: unknown; title: string; deleted_at: unknown };
    const databaseQuery = `SELECT page.* FROM page JOIN database_schema ON page.id = database_schema.page_id WHERE database_schema.id = ${ref.schemaId}`;
    const database = await transport.sql<Source>(databaseQuery);
    if (!database[0] || !isOptionNone(database[0].deleted_at)) return { status: "unavailable" };
    const pages = await transport.sql<Source>(sourceQuery);
    if (!pages[0] || !isOptionNone(pages[0].deleted_at)) return { status: "unavailable" };
    const properties = await transport.sql<{ id: unknown; name: string; property_type: unknown }>(
      `SELECT * FROM property_definition WHERE id = ${ref.binding.field} AND schema_id = ${ref.schemaId}`);
    const property = properties[0];
    if (!property || decodeEnumVariant(property.property_type, TYPES) !== "TEXT") return { status: "unsupported" };
    const values = await transport.sql<{ value: unknown }>(
      `SELECT value FROM page_property_value WHERE page_id = ${pageId} AND property_definition_id = ${ref.binding.field}`);
    if (values[0] && decodeEnumVariant(values[0].value, TYPES) !== "TEXT") return { status: "unsupported" };
    const value = values[0] ? decodeCellValue(values[0].value) : "";
    // A revocation between reads must not turn a denied value into "empty".
    const currentDatabase = await transport.sql<Source>(databaseQuery);
    if (!currentDatabase[0] || !isOptionNone(currentDatabase[0].deleted_at)) return { status: "unavailable" };
    const current = await transport.sql<Source>(sourceQuery);
    if (!current[0] || !isOptionNone(current[0].deleted_at)) return { status: "unavailable" };
    return { status: "ready", value: typeof value === "string" ? value : "", page_title: current[0].title,
      property_name: property.name, source: { page_id: id(current[0].id), property_id: id(property.id), schema_id: ref.schemaId } };
  } catch { return { status: "unavailable" }; }
}
export function propertyReferenceText(result: ResolvedProperty): string {
  return result.status === "ready" ? `[Property reference: page_id=${result.source.page_id} property_id=${result.source.property_id}]\n${result.value || "[Empty property]"}` : `[Property reference: ${result.status}]`;
}
export async function readPropertyReferences(transport: StdbTransport, nodes: readonly { id: number; componentType: string; props?: string; deleted: boolean }[], pageId: number) {
  const resolved = new Map<number, ResolvedProperty>();
  for (const node of nodes) if (!node.deleted && node.componentType === "PropertyReference")
    resolved.set(node.id, await readPropertyReferenceValue(transport, node.props, String(pageId)));
  return resolved;
}
