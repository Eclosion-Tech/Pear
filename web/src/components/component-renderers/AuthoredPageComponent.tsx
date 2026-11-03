"use client";
import { useCallback, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { useSpacetimeDB } from "spacetimedb/react";
import { usePulpOptional, type BlockRendererProps } from "@eclosion-tech/pulp";
import { AuthoredComponentView } from "@eclosion-tech/trellis-react";
import { canonicalJson, observeComponentCommit, type ComponentCommit } from "@eclosion-tech/trellis";
import { INTERFACE_REGISTRY, readPageComponent } from "@pear/trellis-ui";
import { usePageAccess } from "@/src/hooks/usePageAccess";
import { useComponentData } from "@/src/hooks/useComponentData";
import { blockReferenceHref } from "@/src/lib/blockReferenceLink";
import type { DbConnection } from "@/src/module_bindings";
import { SaveComponentTemplate } from "./ComponentTemplateLibrary";
export function AuthoredPageComponentRenderer({node}:BlockRendererProps){
  const access=usePageAccess(node.surfaceId),{getConnection}=useSpacetimeDB(),route=useParams(),pulp=usePulpOptional();
  const workspace=Array.isArray(route?.slug)?route.slug[0]:route?.slug;
  const live=useRef(access);live.current=access;
  const parsed=useMemo(()=>{try{return readPageComponent(node.props,String(node.surfaceId),String(node.id));}catch{return null;}},[node.props,node.surfaceId,node.id]);
  const read=useCallback(()=>{
    const connection=getConnection() as DbConnection|null,row=connection?.db.component_node.id.find(node.id);
    if(!row||row.deletedAt!=null||row.surfaceId!==node.surfaceId||row.componentType!=="TrellisPanel")throw new Error("Source component is deleted or unavailable.");
    return readPageComponent(row.props,String(node.surfaceId),String(node.id));
  },[getConnection,node.id,node.surfaceId]);
  const commit=useCallback(async(request:ComponentCommit,signal:AbortSignal)=>{
    const connection=getConnection() as DbConnection|null,principal=live.current.principal;
    const check=()=>{if(signal.aborted||connection?.identity?.toHexString()!==principal||live.current.principal!==principal)throw new Error("SESSION_ENDED: This editing session ended.");if(!live.current.canEdit)throw new Error("Caller lacks write access on this page");};
    check();return observeComponentCommit(request,{catalog:INTERFACE_REGISTRY.catalog,principal,signal,write:args=>{check();return connection!.reducers.commitTrellisPanel({componentId:String(node.id),baseRevision:BigInt(args.baseRevision),requestId:args.requestId,parametersJson:canonicalJson(args.command)});},read:()=>{check();return read();}});
  },[getConnection,node.id,read]);
  const data=useComponentData(node.surfaceId,commit,read);
  if(!parsed)return <p role="alert">This saved component is invalid or unsupported. Its stored definition has been retained.</p>;
  return <section aria-label="Page component" data-trellis-page-panel={String(node.id)} className="trellis-authored-component my-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700 [&_input]:rounded [&_input]:border [&_input]:border-neutral-400 [&_input]:bg-transparent [&_input]:p-2 [&_select]:border [&_select]:bg-transparent [&_button]:rounded [&_button]:border [&_button]:px-2 [&_button]:py-1">
    <div className="mb-3 flex items-center gap-3 text-xs text-neutral-500"><a href={blockReferenceHref({surfaceId:node.surfaceId,blockId:node.id},workspace)}>Open source</a>{pulp?.config.onCommentBlock&&access.canEdit&&<button type="button" onClick={()=>pulp.config.onCommentBlock?.(node.id)}>Discuss component</button>}</div>
    <SaveComponentTemplate saved={parsed} registry={INTERFACE_REGISTRY} componentId={String(node.id)} principal={access.principal} canEdit={access.canEdit}/>
    <AuthoredComponentView saved={parsed} catalog={INTERFACE_REGISTRY.catalog} principalKey={access.principal} canEdit={access.canEdit} onCommit={commit} {...data}/>
  </section>;
}
