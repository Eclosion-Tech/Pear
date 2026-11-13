// @vitest-environment happy-dom
import React, { act } from "react";
import { test, expect } from "vitest";
import { createRoot } from "react-dom/client";
import { AuthoredComponentView } from "@eclosion-tech/trellis-react";
import { createAuthoredComponent, createBaselineCatalog, readAuthoredComponent, type ComponentDataAdapter } from "@eclosion-tech/trellis";

test("authored record parameter reads containing record, reacts to changes, and clears on principal switch",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const catalog=createBaselineCatalog();
 const initial=await createAuthoredComponent("Summary",{catalog,principal:"human",parentId:"page",requestId:"create",documentId:"detail",instanceId:"detail"});
 const saved=readAuthoredComponent({...initial,sources:{records:{label:"Records",mode:"query",fields:{summary:{type:"string",writable:false}},connection:{adapter:"pear.database",schemaId:"5",mapping:{summary:"7"}}}},bindings:{detail:{source:"records",recordId:{param:"record"},field:"summary",property:"text",writeBack:false}},document:{...initial.document,nodes:[...initial.document.nodes,{id:"detail",parentId:initial.document.rootId,order:0,type:"RichText",props:{},text:[]}]}},catalog);
 const reads:string[]=[];let denied=false;let changed=()=>{};
 const adapter:ComponentDataAdapter={read:async(_source,id)=>{reads.push(id);return denied?{status:"denied"}:{status:"ready",record:{id,values:{summary:`Record ${id}\n\nParagraph`}}};},watch:(_source,callback)=>{changed=callback;return()=>{};}};
 const div=document.createElement("div");document.body.append(div);const root=createRoot(div);
 const render=async(id?:string,principal="one")=>act(async()=>{root.render(<AuthoredComponentView saved={saved} catalog={catalog} principalKey={principal} recordId={id} canEdit={false} onCommit={async()=>saved} dataAdapters={{"pear.database":adapter}}/>);await new Promise(r=>setTimeout(r,20));});
 try {
  await render();expect(reads).toEqual([]);expect(div.textContent).toContain("containing page");
  await render("11");expect(div.textContent).toContain("Record 11\n\nParagraph");
  await render("12");expect(div.textContent).toContain("Record 12\n\nParagraph");expect(div.textContent).not.toContain("Record 11");
  denied=true;await act(async()=>{changed();await new Promise(r=>setTimeout(r,80));});expect(div.textContent).not.toContain("Paragraph");
  await render("11","two");expect(div.textContent).not.toContain("Paragraph");
  denied=false;await act(async()=>{changed();await new Promise(r=>setTimeout(r,80));});expect(div.textContent).toContain("Record 11");
 }finally{await act(async()=>root.unmount());div.remove();}
});
