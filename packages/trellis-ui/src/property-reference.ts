import { type ComponentBinding, type ComponentSource } from "@eclosion-tech/trellis";

/** No labels or resolved values belong in this persisted reference. */
export type PropertyReference = {
  v: 1;
  schemaId: string;
  binding: ComponentBinding & { source: "property"; property: "text"; writeBack: false };
};
export function propertyId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n)
    throw new Error("Expected a stable positive decimal ID.");
  return value;
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    throw new Error("Invalid property reference.");
}
export function readPropertyReference(input: unknown): PropertyReference {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  exact(value, ["v", "schemaId", "binding"]);
  if (value.v !== 1) throw new Error("Unsupported property reference version.");
  propertyId(value.schemaId);
  const binding = value.binding;
  exact(binding, ["source", "recordId", "field", "property", "writeBack"]);
  if (binding.source !== "property" || binding.property !== "text" || binding.writeBack !== false)
    throw new Error("Property references are read-only text bindings.");
  propertyId(binding.field);
  if (typeof binding.recordId === "string") propertyId(binding.recordId);
  else {
    exact(binding.recordId, ["param"]);
    if (binding.recordId.param !== "record") throw new Error("Expected this page or an explicit page.");
  }
  return structuredClone(value) as PropertyReference;
}
export function createPropertyReference(schemaId: string, field: string, pageId?: string): PropertyReference {
  return readPropertyReference({ v: 1, schemaId, binding: {
    source: "property", recordId: pageId ?? { param: "record" }, field, property: "text", writeBack: false,
  } });
}
/** The ordinary Trellis workspace adapter resolves this source, with stable IDs as field keys. */
export function propertyReferenceSource(ref: PropertyReference): ComponentSource {
  return { label: "Property", mode: "query", fields: { [ref.binding.field]: { type: "string", writable: false } },
    connection: { adapter: "pear.database", schemaId: ref.schemaId, mapping: { [ref.binding.field]: ref.binding.field } } };
}
