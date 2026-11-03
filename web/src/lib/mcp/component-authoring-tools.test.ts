import {expect,it} from "vitest";
import {canonicalJson,createAuthoredComponent,commitAuthoredComponent,prepareAuthoredTemplate,reusableComponentReference,componentRepositoryFingerprint,type AuthoredComponent} from "@eclosion-tech/trellis";
import {INTERFACE_REGISTRY} from "@pear/trellis-ui";
import {PAGE_PANEL_TOOLS} from "./page-panels";
import {COMPONENT_REPOSITORY_TOOLS} from "./component-repository-tools";
import type {McpContext} from "./types";
const principal="b".repeat(64);
function fixture(){let saved:AuthoredComponent|null=null,lose=false,denied=false,version:any=null,receipt:any=null;
 const row=()=>({id:"100",surface_id:"7",component_type:"TrellisPanel",props:canonicalJson(saved),deleted_at:null});
 const ctx={aiUserId:1n,transport:{sql:async(query:string)=>{
  if(query.includes("ai_user_config"))return[{identity:principal}];
  if(query.includes("my_component_repository_receipt"))return receipt?[receipt]:[];
  if(query.includes("workspace_component_template_version"))return version?[{package_json:canonicalJson(version.package),content_hash:version.reference.hash}]:[];
  if(query.includes("workspace_component_template"))return version?[{template_id:version.reference.templateId,latest_version:version.reference.version,name:version.package.name,description:"",tags_json:"[]",archived:false,revision:0,owner:principal}]:[];
  if(query.includes("WHERE id = 70"))return[{id:"70",surface_id:"7",component_type:"Container",props:"{}",deleted_at:null}];return saved?[row()]:[];
 },call:async(name:string,args:unknown[])=>{
  if(denied)throw new Error("Caller lacks write access on this page");
  if(name==="create_trellis_panel"){const descriptor=JSON.parse(String(args[2]));saved=await createAuthoredComponent(descriptor.title,{catalog:INTERFACE_REGISTRY.catalog,principal,parentId:String(args[0]),requestId:String(args[1]),documentId:"pear-page:7:component:100",instanceId:"pear-component:100"});}
  else if(name==="publish_component_template"){const options=JSON.parse(String(args[2])),value=await prepareAuthoredTemplate(saved!,INTERFACE_REGISTRY.catalog,options),reference=await reusableComponentReference(value);if(reference.hash!==args[3])throw new Error("PREVIEW_CHANGED");version={package:value,reference};receipt={request_id:args[5],fingerprint:await componentRepositoryFingerprint({kind:"publish",componentId:String(args[0]),sourceRevision:Number(args[1]),options,previewHash:String(args[3]),audience:"workspace"}),operation:"publish",template_id:reference.templateId,result_revision:0};}
  else saved=await commitAuthoredComponent(saved!,{baseRevision:Number(args[1]),requestId:String(args[2]),command:JSON.parse(String(args[3]))},{catalog:INTERFACE_REGISTRY.catalog,principal});
  if(lose)throw new Error("response lost");
 }}} as unknown as McpContext;
 return{run:async(name:string,input:Record<string,unknown>)=>JSON.parse(await [...PAGE_PANEL_TOOLS,...COMPONENT_REPOSITORY_TOOLS].find(tool=>tool.name===name)!.execute(ctx,input)),saved:()=>saved!,lose:()=>{lose=true;},deny:()=>{denied=true;}};
}
it("agents author a blank component using the same atomic definition, discover exact contracts and recover a lost response",async()=>{
 const host=fixture();const created=await host.run("create_component",{parent_id:"70",title:"Custom",request_id:"blank"});expect(created.ok).toBe(true);expect(created.document.nodes).toHaveLength(1);expect(created.document.template).toBeUndefined();expect(created.authoring_contract.local_action.effects[0].kind).toBe("setText");
 const command={kind:"edit",configuration:{...created.configuration,actions:{toggle:{kind:"local",input:{type:"object",properties:{}},effects:[{kind:"toggle",target:{id:"agent:checkbox"},property:"checked"}],message:"Done"}}},operations:[{op:"insertNode",node:{id:"agent:checkbox",parentId:created.document.rootId,type:"ChecklistItem",order:0,props:{checked:false},text:[{text:"Custom item"}],action:{slot:"toggle",input:{}}}}]};
 const schema=PAGE_PANEL_TOOLS.find(tool=>tool.name==="update_component")!.inputSchema;expect((schema.properties!.command as any).properties.operations.minItems).toBe(0);
 host.lose();const changed=await host.run("update_component",{component_id:"100",base_revision:0,request_id:"design",command});expect(changed.ok).toBe(true);expect(changed.revision).toBe(1);expect((await host.run("update_component",{component_id:"100",base_revision:0,request_id:"design",command})).replayed).toBe(true);
 const stale=await host.run("update_component",{component_id:"100",base_revision:0,request_id:"stale",command});expect(stale.code).toBe("STALE_REVISION");expect((await host.run("get_page_panel",{component_id:"100"})).reference).toEqual(created.reference);
 host.deny();expect((await host.run("update_component",{component_id:"100",base_revision:0,request_id:"design",command})).code).toBe("AUTHORIZATION_DENIED");
});
it("the existing library tools preview, publish and read an authored component without requiring a preset",async()=>{
 const host=fixture();await host.run("create_component",{parent_id:"70",request_id:"blank"});const options={slug:"blank-component",version:"1.0.0",name:"Blank component",description:"Build further",tags:[]};const preview=await host.run("preview_component_template",{component_id:"100",options});expect(preview.ok).toBe(true);expect(preview.package.format).toBe("trellis_authored_template_v1");host.lose();const saved=await host.run("publish_component_template",{component_id:"100",source_revision:0,options,preview_hash:preview.preview_hash,audience:"workspace",request_id:"publish"});expect(saved.ok).toBe(true);const read=await host.run("get_component_template",{template_id:"workspace:blank-component",version:"1.0.0"});expect(read.ok).toBe(true);expect(read.reference.hash).toBe(preview.preview_hash);expect(read.package.blueprint.nodes).toHaveLength(1);
});
