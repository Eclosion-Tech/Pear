import { readRetainedInterface, type InterfaceRegistry, type RetainedInterface } from "@eclosion-tech/trellis";
import library from "../interfaces.json" with { type: "json" };
export const INTERFACE_REGISTRY = library as unknown as InterfaceRegistry;
export function isRetainedPageInterface(json: string): boolean {
  try { return JSON.parse(json).v === "trellis_instance_v1"; } catch { return false; }
}
export function readPageInterface(json: string, surfaceId: string, componentId: string): RetainedInterface {
  const saved = readRetainedInterface(json, INTERFACE_REGISTRY);
  if (saved.document.documentId !== `pear-page:${surfaceId}:component:${componentId}` || saved.document.template!.instanceId !== `pear-component:${componentId}`) throw new Error("INVALID_INTERFACE: interface belongs to another component.");
  return saved;
}
