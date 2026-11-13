import { bindingRecordId } from "@eclosion-tech/trellis";
import { readPropertyReference, propertyReferenceSource, type PropertyReference } from "@pear/trellis-ui";
import { workspaceComponentRead, type WorkspaceComponentData } from "./component-workspace-data";
import { effectivePagePermission, pageAccessScope } from "./pageAccess";

export type PropertyResolution =
  | { status: "ready"; value: string; pageId: string; pageTitle: string; propertyName: string; canEdit: boolean }
  | { status: "unconfigured" | "unsupported" | "unavailable" | "missing-context" };
export function resolvePropertyReference(raw: unknown, containingPageId: string | undefined, data: WorkspaceComponentData): PropertyResolution {
  if (raw === "{}" || (raw && typeof raw === "object" && Object.keys(raw).length === 0)) return { status: "unconfigured" };
  let ref: PropertyReference;
  try { ref = readPropertyReference(raw); } catch { return { status: "unsupported" }; }
  const pageId = bindingRecordId(ref.binding, containingPageId);
  if (!pageId) return { status: "missing-context" };
  // Authorize before exposing titles, property labels, type or deletion details.
  const result = workspaceComponentRead(propertyReferenceSource(ref), pageId, data);
  if (result.status !== "ready" || !result.record) return { status: "unavailable" };
  const property = data.properties.find(p => p.id.toString() === ref.binding.field && p.schemaId.toString() === ref.schemaId);
  if (!property || property.propertyType.tag !== "Text") return { status: "unsupported" };
  const value = data.values.find(v => v.pageId.toString() === pageId && v.propertyDefinitionId === property.id)?.value;
  if (value && value.tag !== "Text") return { status: "unsupported" };
  const page = data.pages.find(p => p.id.toString() === pageId)!;
  return { status: "ready", value: value?.tag === "Text" ? value.value : "", pageId, pageTitle: page.title,
    propertyName: property.name, canEdit: effectivePagePermission(pageAccessScope(page.id, data.pages, data.rules), data.principal, data.privileged) === "Write" };
}
export function propertySourceChoices(data: WorkspaceComponentData) {
  if (!data.ready || data.principal === "anonymous") return [];
  return data.pages.filter(p => p.deletedAt == null).flatMap(page => {
    const schema = data.schemas.find(s => s.pageId === page.parentId);
    if (!schema) return [];
    const properties = data.properties.filter(p => p.schemaId === schema.id && p.propertyType.tag === "Text");
    if (!properties.length || workspaceComponentRead(propertyReferenceSource({ v: 1, schemaId: String(schema.id), binding: {
      source: "property", field: String(properties[0].id), recordId: String(page.id), property: "text", writeBack: false,
    } }), String(page.id), data).status !== "ready") return [];
    return [{ pageId: String(page.id), title: page.title, schemaId: String(schema.id), properties: properties.map(p => ({ id: String(p.id), name: p.name })) }];
  });
}
