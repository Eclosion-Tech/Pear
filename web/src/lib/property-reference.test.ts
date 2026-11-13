import { expect, test } from "vitest";
import { bindingRecordId } from "@eclosion-tech/trellis";
import { createPropertyReference, readPropertyReference } from "@pear/trellis-ui";
import { propertySourceChoices, resolvePropertyReference } from "./property-reference";
import type { WorkspaceComponentData } from "./component-workspace-data";
const viewer = "a".repeat(64);
function fixture(): WorkspaceComponentData {
  return { ready: true, principal: viewer, privileged: false,
    pages: [{id:10n,title:"Database"},{id:11n,parentId:10n,title:"First"},{id:12n,parentId:10n,title:"Second"},{id:90n,title:"Ordinary document"}],
    schemas:[{id:5n,pageId:10n}], properties:[{id:7n,schemaId:5n,name:"Summary",propertyType:{tag:"Text"}}],
    values:[{pageId:11n,propertyDefinitionId:7n,value:{tag:"Text",value:"First\n\nfull report <script> is literal"}}, {pageId:12n,propertyDefinitionId:7n,value:{tag:"Text",value:"Second"}}], rules:[],
  } as unknown as WorkspaceComponentData;
}
const self = createPropertyReference("5","7"), explicit = createPropertyReference("5","7","11");
test("templates, reload and duplicate resolve self from containing record; explicit source stays fixed", () => {
  const data=fixture();
  for(const page of ["11","12"]) {
    const copied=readPropertyReference(JSON.stringify(self));
    expect(resolvePropertyReference(copied,page,data)).toMatchObject({status:"ready",value:page==="11"?data.values[0].value.value:"Second",pageId:page});
    expect(resolvePropertyReference(JSON.stringify(explicit),page,data)).toMatchObject({status:"ready",pageId:"11"});
  }
  expect(resolvePropertyReference(explicit,"90",data)).toMatchObject({status:"ready",pageId:"11"});
  expect(resolvePropertyReference(self,undefined,data)).toEqual({status:"missing-context"});
  expect(bindingRecordId(self.binding,undefined,"11")).toBeUndefined();
});
test("rename and live changes preserve identity; deletion and incompatible type cannot select a same-named replacement", () => {
  const data=fixture();
  data.properties[0].name="Renamed"; data.pages[1].title="New title";
  data.values=[{...data.values[0],value:{tag:"Text",value:"Updated\n\nAll paragraphs"}},data.values[1]];
  expect(resolvePropertyReference(self,"11",data)).toMatchObject({value:"Updated\n\nAll paragraphs",propertyName:"Renamed",pageTitle:"New title"});
  data.properties=[{...data.properties[0],id:8n,name:"Summary"}];
  expect(resolvePropertyReference(self,"11",data)).toEqual({status:"unsupported"});
  data.properties=[{...data.properties[0],id:7n,propertyType:{tag:"Url"}}];
  expect(resolvePropertyReference(self,"11",data)).toEqual({status:"unsupported"});
});
test("source ACLs, revocation, restored access and principal changes clear values and all labels", () => {
  const data=fixture();
  data.rules=[{pageId:10n,principal:{tag:"WorkspaceMember",value:{toHexString:()=>viewer}},permission:{tag:"Read"}}] as any;
  expect(resolvePropertyReference(explicit,"90",data)).toMatchObject({status:"ready",canEdit:false});
  data.principal="b".repeat(64);
  expect(resolvePropertyReference(explicit,"90",data)).toEqual({status:"unavailable"});
  expect(propertySourceChoices(data)).toEqual([]);
  data.principal=viewer;
  expect(resolvePropertyReference(explicit,"90",data)).toMatchObject({status:"ready"});
  data.ready=false;
  expect(resolvePropertyReference(explicit,"90",data)).toEqual({status:"unavailable"});
  data.ready=true; data.pages=data.pages.filter(p=>p.id!==11n);
  expect(resolvePropertyReference(explicit,"90",data)).toEqual({status:"unavailable"});
});
test("empty differs from missing source; stored contract rejects values, labels, first-row fallback and unknown versions", () => {
  const data=fixture(); data.values=[];
  expect(resolvePropertyReference(self,"11",data)).toMatchObject({status:"ready",value:""});
  for(const bad of [{...self,v:2},{...self,value:"secret"},{...self,binding:{...self.binding,field:"Summary"}}, {...self,binding:{...self.binding,recordId:{first:true}}}, {...self,binding:{...self.binding,writeBack:true}}]) expect(()=>readPropertyReference(bad)).toThrow();
  expect(readPropertyReference(createPropertyReference("18446744073709551615","7","11")).schemaId).toBe("18446744073709551615");
  expect(()=>createPropertyReference("18446744073709551616","7")).toThrow();
});
