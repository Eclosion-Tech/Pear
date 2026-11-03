"use client";
import {useEffect,useRef,useState} from "react";
import {useSpacetimeDB} from "spacetimedb/react";
import {createAuthoredComponent,canonicalJson} from "@eclosion-tech/trellis";
import {INTERFACE_REGISTRY,readPageComponent} from "@pear/trellis-ui";
import type {DbConnection} from "@/src/module_bindings";
import {usePageAccess} from "@/src/hooks/usePageAccess";
export function NewComponentButton({surfaceId,parentId}:{surfaceId:bigint;parentId:bigint|null}){
  const access=usePageAccess(surfaceId),{getConnection}=useSpacetimeDB(),[open,setOpen]=useState(false),[title,setTitle]=useState("Untitled component"),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const request=useRef<{id:string;title:string}|null>(null),live=useRef(access);live.current=access;
  useEffect(()=>{setOpen(false);setMessage("");request.current=null;},[access.principal,surfaceId]);
  async function create(){if(!parentId)return;setBusy(true);setMessage("");request.current??={id:`create:${crypto.randomUUID()}`,title};const attempt=request.current,principal=access.principal,connection=getConnection() as DbConnection|null;
    const check=()=>{if(!connection||connection.identity?.toHexString()!==principal||live.current.principal!==principal||!live.current.canEdit)throw new Error("This editing session ended or page access changed.");};
    try{check();const expected=await createAuthoredComponent(attempt.title,{catalog:INTERFACE_REGISTRY.catalog,principal,parentId:String(parentId),requestId:attempt.id,documentId:"creation:check",instanceId:"creation:check"});
      try{await connection!.reducers.createTrellisPanel({parentId:String(parentId),requestId:attempt.id,parametersJson:canonicalJson({kind:"component",title:attempt.title})});}catch(error){if(/lacks .*access|Authentication required|REQUEST_REUSED|INVALID_COMPONENT/.test(String(error)))throw error;}
      for(let count=0;count<30;count++){check();for(const node of connection!.db.component_node.iter()){if(node.surfaceId!==surfaceId||node.componentType!=="TrellisPanel"||node.deletedAt!=null)continue;try{const saved=readPageComponent(node.props,String(surfaceId),String(node.id));if(saved.creation.principal===principal&&saved.creation.parentId===String(parentId)&&saved.creation.requestId===attempt.id){if(saved.creation.fingerprint!==expected.creation.fingerprint)throw new Error("REQUEST_REUSED: Creation differs.");request.current=null;setOpen(false);setMessage("Blank component created. Use its builder or invite AI to design it with you.");return;}}catch(error){if(String(error).includes("REQUEST_REUSED"))throw error;}}await new Promise(resolve=>setTimeout(resolve,40));}
      throw new Error("Creation is unconfirmed. Retry this same creation request.");
    }catch(error){setMessage(error instanceof Error?error.message:"Unable to create component.");}finally{setBusy(false);}
  }
  return <><button type="button" className="mb-3 mr-3 rounded border px-3 py-1 text-sm" disabled={!access.canEdit||!parentId} onClick={()=>{setOpen(true);setMessage("");}}>New component</button>{open&&<div role="group" aria-label="New blank component"><label>Component name<input value={title} maxLength={160} disabled={busy||!!request.current} onChange={e=>setTitle(e.target.value)}/></label><button type="button" disabled={busy} onClick={()=>void create()}>{request.current?"Retry creation":"Create blank component"}</button><button type="button" disabled={busy} onClick={()=>setOpen(false)}>Cancel</button><p>Start empty, add building blocks and connect live data, then save it to the workspace library.</p></div>}{message&&<p role="status">{message}</p>}</>;
}
