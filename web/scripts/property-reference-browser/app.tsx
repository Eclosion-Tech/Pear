import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PropertyReferenceView } from "../../src/components/component-renderers/PropertyReferenceView";
import { LongTextProperty } from "../../src/components/LongTextProperty";
import { createPropertyReference, readPropertyReference } from "@pear/trellis-ui";
import { resolvePropertyReference, propertySourceChoices } from "../../src/lib/property-reference";
import type { WorkspaceComponentData } from "../../src/lib/component-workspace-data";
import { blockReferenceHref } from "../../src/lib/blockReferenceLink";
const summary = `The garden is ready for its next season. Over the past month, the team mapped the growing beds, repaired the paths, and gathered ideas from neighbors.\n\nThe strongest recommendation is to keep the first phase small: open the shared beds, add clear labels, and host one planting afternoon. This gives the community a useful place to start while leaving room to learn.\n\nNext steps\nConfirm the volunteer schedule and order the remaining seeds. Keep a record of what grows well so next year’s plan builds on what we observe.\n\nProperty values remain plain text. <b>This is literal text</b>, and {{this.summary}} stays literal too.`;
const base={ready:true,principal:"reader",privileged:false,rules:[],pages:[{id:10n,title:"Projects"},{id:11n,parentId:10n,title:"Community garden"},{id:12n,parentId:10n,title:"Neighborhood library"}],schemas:[{id:5n,pageId:10n}],properties:[{id:7n,schemaId:5n,name:"Summary",propertyType:{tag:"Text"}}]} as unknown as unknown as WorkspaceComponentData;
function App(){
 const [page,setPage]=useState("11"),[value,setValue]=useState(summary),[permission,setPermission]=useState("Write");
 const [reference,setReference]=useState(()=>{try{return readPropertyReference(localStorage.getItem("reference")||"")}catch{return createPropertyReference("5","7")}});
 const data={...base,values:[{pageId:11n,propertyDefinitionId:7n,value:{tag:"Text",value}},{pageId:12n,propertyDefinitionId:7n,value:{tag:"Text",value:"A second record with its own summary.\n\nThe library starts with a book exchange and a quiet reading space."}}],rules:permission==="Denied"?[{pageId:10n,principal:{tag:"WorkspaceMember",value:{toHexString:()=>"other"}},permission:{tag:"Read"}}]:permission==="Read"?[{pageId:10n,principal:{tag:"WorkspaceMember",value:{toHexString:()=>"reader"}},permission:{tag:"Read"}}]:[]} as unknown as WorkspaceComponentData;
 const result=resolvePropertyReference(reference,page,data);
 return <main className="mx-auto max-w-3xl px-5 py-8 sm:px-12 text-neutral-800">
  <nav className="mb-8 flex flex-wrap gap-3 text-xs text-neutral-500"><span>Local verification</span><button onClick={()=>setPage("11")}>Record A</button><button onClick={()=>setPage("12")}>Record B</button><button onClick={()=>setPermission("Read")}>Read only</button><button onClick={()=>setPermission("Denied")}>Revoke source</button><button onClick={()=>setPermission("Write")}>Restore access</button></nav>
  <p className="mb-3 text-sm text-neutral-400">Projects / {page==="11"?"Community garden":"Neighborhood library"}</p>
  <h1 className="mb-7 text-3xl font-semibold">{page==="11"?"Community garden":"Neighborhood library"}</h1>
  <div className="mb-8 border-b border-neutral-100 pb-5"><div className="flex gap-3"><span className="w-24 sm:w-36 shrink-0 pt-2 text-xs text-neutral-500">T　Summary</span><div className="min-w-0 flex-1">
   {result.status==="ready"&&<LongTextProperty key={page+permission} name="Summary" value={page==="11"?value:"A second record with its own summary."} canEdit={permission==="Write"} onSave={async v=>setValue(v)}/>}
  </div></div></div>
  <h2 className="mb-3 text-xl font-semibold">Project overview</h2>
  <PropertyReferenceView key={page+permission} result={result} reference={reference} choices={propertySourceChoices(data)} containingPageId={page} canConfigure={permission==="Write"} onSave={async ref=>{setReference(ref);localStorage.setItem("reference",JSON.stringify(ref));}} onOpen={edit=>{if(result.status==="ready"){history.pushState({},"",blockReferenceHref({surfaceId:BigInt(result.pageId)},"local")+(edit?"?editProperty=7#property-7":""));}}}/>
  <p className="mt-6 text-neutral-500">This paragraph belongs to the document. The summary above stays connected to its source property.</p>
 </main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
