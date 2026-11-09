import { civilDate, evaluateComponentQuery, nativePearAttribute, type ComponentQueryRequest, type ComponentQueryResult, type ComponentReadResult, type ComponentSource, type ComponentDataSnapshot, type ComponentRecord, type ComponentField, type Scalar } from "@eclosion-tech/trellis";
import type { DatabaseSchema, Page, PageAccessRule, PagePropertyValue, PropertyDefinition } from "@/src/module_bindings/types";
import { effectivePagePermission, pageAccessScope } from "./pageAccess";
import { dateOnlyKey } from "./date-only";
export type WorkspaceComponentData = { ready: boolean; principal: string; privileged: boolean; pages: readonly Page[]; rules: readonly PageAccessRule[]; schemas: readonly DatabaseSchema[]; properties: readonly PropertyDefinition[]; values: readonly PagePropertyValue[] };
export function scalarProperty(type: string): ComponentField["type"] | null {
  if (["Text", "Url", "Select"].includes(type)) return "string";
  if (type === "Number") return "number";
  if (type === "Checkbox") return "boolean";
  if (type === "Date") return "date";
  return null;
}
export function writableProperty(type: string): boolean { return ["Text", "Url", "Number", "Checkbox"].includes(type); }
/** Record attributes every database row has without a property definition. They
 * appear in source choices beside real columns and are always read-only text. */
export const NATIVE_RECORD_PROPERTIES = [
  { id: "$title", name: "Title", type: "string" as const, writable: false },
  { id: "$id", name: "Record ID", type: "string" as const, writable: false },
];
function nativeValue(page: Page, id: string): Scalar {
  return id === "$title" ? page.title : id === "$id" ? page.id.toString() : null;
}
/** A mapped field reads either a schema property of the declared type or a native record attribute. */
type MappedField = { kind: "property"; property: PropertyDefinition } | { kind: "native"; id: string };
function mappedFields(source: ComponentSource, mapping: Record<string, string>, schemaId: bigint, properties: readonly PropertyDefinition[], fields: readonly string[]): Record<string, MappedField | undefined> {
  return Object.fromEntries(fields.map(field => {
    const id = mapping[field];
    if (nativePearAttribute(id)) return [field, source.fields[field]?.type === "string" && source.fields[field]?.writable !== true ? { kind: "native", id } : undefined];
    const property = properties.find(property => property.id.toString() === id && property.schemaId === schemaId && scalarProperty(property.propertyType.tag) === source.fields[field]?.type);
    return [field, property ? { kind: "property", property } : undefined];
  }));
}
function fieldValue(page: Page, mapped: MappedField | undefined, values: readonly PagePropertyValue[]): Scalar {
  if (!mapped) return null;
  if (mapped.kind === "native") return nativeValue(page, mapped.id);
  return scalarValue(values.find(value => value.pageId === page.id && value.propertyDefinitionId === mapped.property.id)?.value);
}
function scalarValue(value: PagePropertyValue["value"] | undefined): Scalar {
  if (value?.tag === "Date") {
    const timestamp = Number(value.value);
    return civilDate(timestamp) === null ? null : dateOnlyKey(timestamp);
  }
  return value && "value" in value && ["string", "number", "boolean"].includes(typeof value.value) ? value.value as Scalar : null;
}
export function workspaceComponentSnapshot(source: ComponentSource, data: WorkspaceComponentData): ComponentDataSnapshot {
  const connection = source.connection;
  if (!data.ready) return { status: "loading", records: [], writableFields: [] };
  const permission = (id: bigint) => data.principal === "anonymous" ? null : effectivePagePermission(pageAccessScope(id, data.pages, data.rules), data.principal, data.privileged);
  const schema = connection?.adapter === "pear.database" && data.schemas.find(row => row.id.toString() === connection.schemaId);
  if (!schema || !data.pages.some(page => page.id === schema.pageId) || !permission(schema.pageId)) return { status: "error", records: [], writableFields: [], message: "The connected workspace database is unavailable or unreadable." };
  if (connection?.adapter !== "pear.database") return { status: "error", records: [], writableFields: [], message: "Choose a workspace database connection." };
  const properties = mappedFields(source, connection.mapping, schema.id, data.properties, Object.keys(connection.mapping));
  const writableFields = Object.keys(properties).filter(field => {
    const mapped = properties[field];
    return source.fields[field]?.writable && mapped?.kind === "property" && writableProperty(mapped.property.propertyType.tag);
  });
  const records: ComponentRecord[] = data.pages.filter(page => page.parentId === schema.pageId && permission(page.id)).sort((a,b) => a.id < b.id ? -1 : 1).slice(0,1000).map(page => {
    const values: Record<string, Scalar> = {};
    for (const [field, mapped] of Object.entries(properties)) values[field] = fieldValue(page, mapped, data.values);
    return { id: page.id.toString(), values, writableFields: permission(page.id) === "Write" ? writableFields : [] };
  });
  return { status: "ready", records, writableFields,creatableFields:permission(schema.pageId)==="Write"?writableFields:[] };
}

function workspaceReadScope(source: ComponentSource, data: WorkspaceComponentData) {
  if (!data.ready) return { status: "unavailable", message: "Workspace data is not ready." } as const;
  const connection = source.connection;
  const schema = connection?.adapter === "pear.database" && data.schemas.find(row => row.id.toString() === connection.schemaId);
  if (!schema || connection?.adapter !== "pear.database" || !data.pages.some(page => page.id === schema.pageId && page.deletedAt == null))
    return { status: "unavailable", message: "The connected workspace database is unavailable." } as const;
  const permission = (id: bigint) => data.principal !== "anonymous" && effectivePagePermission(pageAccessScope(id, data.pages, data.rules), data.principal, data.privileged);
  if (!permission(schema.pageId)) return { status: "denied", message: "You cannot read the connected workspace database." } as const;
  const properties = mappedFields(source, connection.mapping, schema.id, data.properties, Object.keys(source.fields));
  const record = (page: Page): ComponentRecord => ({
    id: page.id.toString(),
    values: Object.fromEntries(Object.entries(properties).map(([field, mapped]) => [field, fieldValue(page, mapped, data.values)])),
  });
  return { status: "ready", schema, permission, record } as const;
}

export function workspaceComponentQuery(source: ComponentSource, request: ComponentQueryRequest, data: WorkspaceComponentData): ComponentQueryResult {
  const asOf = new Date().toISOString();
  const scope = workspaceReadScope(source, data);
  if (scope.status !== "ready") return { ...scope, records: [], complete: false, asOf };
  const records = data.pages.filter(page => page.parentId === scope.schema.pageId && page.deletedAt == null && scope.permission(page.id)).map(scope.record);
  return { status: "ready", ...evaluateComponentQuery(records, source, request), asOf };
}

export function workspaceComponentRead(source: ComponentSource, recordId: string, data: WorkspaceComponentData): ComponentReadResult {
  const scope = workspaceReadScope(source, data);
  if (scope.status !== "ready") return scope;
  const page = data.pages.find(page => page.id.toString() === recordId && page.parentId === scope.schema.pageId && page.deletedAt == null);
  if (!page || !scope.permission(page.id)) return { status: "unavailable", message: "This record is unavailable." };
  return { status: "ready", record: scope.record(page) };
}
