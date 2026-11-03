import { readAuthoredComponent, type AuthoredComponent, readRetainedInterface, type InterfaceRegistry, type RetainedInterface } from "@eclosion-tech/trellis";
import library from "../interfaces.json" with { type: "json" };
export const INTERFACE_REGISTRY = library as unknown as InterfaceRegistry;
export function isRetainedPageInterface(json: string): boolean {
  try { return JSON.parse(json).v === "trellis_instance_v1"; } catch { return false; }
}
export function readPageInterface(json: string, surfaceId: string, componentId: string, registry: InterfaceRegistry = INTERFACE_REGISTRY): RetainedInterface {
  const saved = readRetainedInterface(json, registry);
  if (saved.document.documentId !== `pear-page:${surfaceId}:component:${componentId}` || saved.document.template!.instanceId !== `pear-component:${componentId}`) throw new Error("INVALID_INTERFACE: interface belongs to another component.");
  return saved;
}

export function isAuthoredPageComponent(raw:string):boolean {try{return JSON.parse(raw).v==="trellis_component_v1";}catch{return false;}}
export function readPageComponent(raw:string,surfaceId:string,componentId:string):AuthoredComponent {
  const saved=readAuthoredComponent(raw,INTERFACE_REGISTRY.catalog);
  if(saved.document.documentId!==`pear-page:${surfaceId}:component:${componentId}`)throw new Error("INVALID_COMPONENT: Document belongs to another component.");return saved;
}
