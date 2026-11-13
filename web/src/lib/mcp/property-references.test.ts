import { expect, test } from "vitest";
import { createPropertyReference } from "@pear/trellis-ui";
import { readPropertyReferenceValue, propertyReferenceText } from "./property-references";
import { getPageComponents } from "./authoring";
import { readComponentTreeDoc } from "./component-tree";
import type { StdbTransport } from "./types";
const ref=createPropertyReference("5","7","11");
function transport(options: {denied?:boolean;revoked?:boolean;empty?:boolean;type?:number}={}): StdbTransport {
  let reads=0;
  return {call:async()=>{},sql:async(query:string)=>{
    if(query.includes("FROM component_node")) return [
      {id:1,parent_id:{none:[]},component_type:"Container",props:"{}",order:0,deleted_at:{none:[]}},
      {id:2,parent_id:{some:1},component_type:"PropertyReference",props:JSON.stringify(ref),order:1,deleted_at:{none:[]}}
    ] as any;
    if(query.includes("FROM page JOIN")) return options.denied || (options.revoked && query.includes("page.parent_pk") && ++reads>1) ? [] : [{id:"11",title:"Source",deleted_at:{none:[]}}] as any;
    if(query.includes("FROM property_definition")) return [{id:"7",name:"Summary",property_type:[options.type??0,[]]}] as any;
    if(query.includes("FROM page_property_value")) return options.empty?[]:[{value:[0,"First\n\nSecond <b>literal</b>"]}] as any;
    return [];
  }};
}
test("agent structural and plain reads resolve the same reference under the caller transport",async()=>{
  const tree=await getPageComponents(transport(),90);
  expect(tree).toMatchObject({ok:true,root:{children:[{props:ref,resolved_property:{status:"ready",value:"First\n\nSecond <b>literal</b>",source:{page_id:"11",property_id:"7"}}}]}});
  expect(await readComponentTreeDoc(transport(),90)).toBe("[Property reference: page_id=11 property_id=7]\nFirst\n\nSecond <b>literal</b>");
});
test("denied, revoked, empty and unsupported agent sources stay distinct",async()=>{
  for(const options of [{denied:true},{revoked:true}]) {
    const result=await readPropertyReferenceValue(transport(options),ref,"90");
    expect(result).toEqual({status:"unavailable"});
    expect(propertyReferenceText(result)).not.toMatch(/Source|Summary|First/);
  }
  expect(await readPropertyReferenceValue(transport({empty:true}),ref,"90")).toMatchObject({status:"ready",value:""});
  expect(await readPropertyReferenceValue(transport({type:7}),ref,"90")).toEqual({status:"unsupported"});
});
