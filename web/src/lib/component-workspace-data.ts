import { civilDate, evaluateComponentQuery, type ComponentQueryRequest, type ComponentQueryResult, type ComponentReadResult, type ComponentSource, type ComponentDataSnapshot, type ComponentRecord, type ComponentField, type Scalar } from "@eclosion-tech/trellis";
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
  const properties = Object.fromEntries(Object.entries(connection.mapping).map(([field, id]) => [field, data.properties.find(property => property.id.toString() === id && property.schemaId === schema.id && scalarProperty(property.propertyType.tag) === source.fields[field]?.type)]));
  const writableFields = Object.keys(properties).filter(field => source.fields[field]?.writable && properties[field] && writableProperty(properties[field]!.propertyType.tag));
  const records: ComponentRecord[] = data.pages.filter(page => page.parentId === schema.pageId && permission(page.id)).sort((a,b) => a.id < b.id ? -1 : 1).slice(0,1000).map(page => {
    const values: Record<string, Scalar> = {};
    for (const [field, property] of Object.entries(properties)) {
      const value = property && data.values.find(value => value.pageId === page.id && value.propertyDefinitionId === property.id)?.value;
      values[field] = scalarValue(value);
    }
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
  const properties = Object.fromEntries(Object.keys(source.fields).map(field => [field, data.properties.find(property => property.id.toString() === connection.mapping[field] && property.schemaId === schema.id && scalarProperty(property.propertyType.tag) === source.fields[field].type)]));
  const record = (page: Page): ComponentRecord => ({
    id: page.id.toString(),
    values: Object.fromEntries(Object.entries(properties).map(([field, property]) => [field, scalarValue(property && data.values.find(value => value.pageId === page.id && value.propertyDefinitionId === property.id)?.value)])),
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
