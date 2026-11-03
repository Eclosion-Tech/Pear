import type { ComponentSource, ComponentDataSnapshot, ComponentRecord, ComponentField, Scalar } from "@eclosion-tech/trellis";
import type { DatabaseSchema, Page, PageAccessRule, PagePropertyValue, PropertyDefinition } from "@/src/module_bindings/types";
import { effectivePagePermission, pageAccessScope } from "./pageAccess";
export type WorkspaceComponentData = { ready: boolean; principal: string; privileged: boolean; pages: readonly Page[]; rules: readonly PageAccessRule[]; schemas: readonly DatabaseSchema[]; properties: readonly PropertyDefinition[]; values: readonly PagePropertyValue[] };
export function scalarProperty(type: string): ComponentField["type"] | null {
  if (["Text", "Url", "Select"].includes(type)) return "string";
  if (type === "Number") return "number";
  if (type === "Checkbox") return "boolean";
  return null;
}
export function writableProperty(type: string): boolean { return ["Text", "Url", "Number", "Checkbox"].includes(type); }
export function workspaceComponentSnapshot(source: ComponentSource, data: WorkspaceComponentData): ComponentDataSnapshot {
  const connection = source.connection;
  if (!data.ready) return { status: "loading", records: [], writableFields: [] };
  const permission = (id: bigint) => data.principal === "anonymous" ? null : effectivePagePermission(pageAccessScope(id, data.pages, data.rules), data.principal, data.privileged);
  const schema = connection?.adapter === "pear.database" && data.schemas.find(row => row.id.toString() === connection.schemaId);
  if (!schema || !data.pages.some(page => page.id === schema.pageId) || !permission(schema.pageId)) return { status: "error", records: [], writableFields: [], message: "The connected workspace database is unavailable or unreadable." };
  if (connection?.adapter !== "pear.database") return { status: "error", records: [], writableFields: [], message: "Choose a workspace database connection." };
  const properties = Object.fromEntries(Object.entries(connection.mapping).map(([field, id]) => [field, data.properties.find(property => property.id.toString() === id && property.schemaId === schema.id && scalarProperty(property.propertyType.tag) === source.fields[field]?.type)]));
  const writableFields = Object.keys(properties).filter(field => source.fields[field]?.writable && properties[field] && writableProperty(properties[field]!.propertyType.tag));
  const records: ComponentRecord[] = data.pages.filter(page => page.parentId === schema.pageId && permission(page.id)).sort((a,b) => a.id < b.id ? -1 : 1).slice(0,1000).map(page => {
    const values: Record<string, Scalar> = {};
    for (const [field, property] of Object.entries(properties)) {
      const value = property && data.values.find(value => value.pageId === page.id && value.propertyDefinitionId === property.id)?.value;
      values[field] = value && "value" in value && ["string","number","boolean"].includes(typeof value.value) ? value.value as Scalar : null;
    }
    return { id: page.id.toString(), values, writableFields: permission(page.id) === "Write" ? writableFields : [] };
  });
  return { status: "ready", records, writableFields };
}
