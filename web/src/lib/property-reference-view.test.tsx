// @vitest-environment happy-dom
import React, { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { PropertyReferenceView } from "../components/component-renderers/PropertyReference";
import { LongTextProperty } from "../components/LongTextProperty";
vi.mock("next/navigation",()=>({useParams:()=>({}),useRouter:()=>({push:vi.fn()})}));
vi.mock("../hooks/useWorkspaceComponentData",()=>({useWorkspaceComponentData:vi.fn()}));
vi.mock("../hooks/usePages",()=>({useUpdateComponentProps:vi.fn()}));
vi.mock("@eclosion-tech/pulp",()=>({usePulpOptional:()=>null}));
let root:Root, container:HTMLDivElement;
afterEach(async()=>{if(root) await act(async()=>root.unmount());container?.remove();});
async function mount(node:React.ReactNode){(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;container=document.createElement("div");document.body.append(container);root=createRoot(container);await act(async()=>root.render(node));}
async function click(text:string){const button=[...container.querySelectorAll("button")].find(b=>b.textContent===text)!;expect(button).toBeTruthy();await act(async()=>button.click());}
async function select(label:string,value:string){const input=container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;await act(async()=>{input.value=value;input.dispatchEvent(new Event("change",{bubbles:true}));});}
const choices=[{pageId:"11",schemaId:"5",title:"Here",properties:[{id:"7",name:"Summary"}]},{pageId:"12",schemaId:"5",title:"There",properties:[{id:"7",name:"Summary"}]}];
function props(){return {result:{status:"unconfigured" as const},reference:null,canConfigure:true,choices,containingPageId:"11",onSave:vi.fn(async(_ref:unknown)=>{}),onOpen:vi.fn()};}
test("human picker authors the same self and explicit references as agents",async()=>{
 const p=props();await mount(<PropertyReferenceView {...p}/>);
 await select("Property","7");await click("Save reference");
 expect(p.onSave).toHaveBeenLastCalledWith({v:1,schemaId:"5",binding:{source:"property",field:"7",recordId:{param:"record"},property:"text",writeBack:false}});
 await click("Reference settings");await act(async()=>{(container.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement).click();});
 await select("Source page","12");await select("Property","7");await click("Save reference");
 expect(p.onSave.mock.calls.at(-1)?.[0]).toMatchObject({binding:{recordId:"12"}});
});
test("plain text and read-only controls clear on source revocation",async()=>{
 const p=props();await mount(<PropertyReferenceView {...p} canConfigure={false} result={{status:"ready",value:"<script>literal</script>\n\nSecond",pageId:"12",pageTitle:"Source",propertyName:"Summary",canEdit:false}}/>);
 expect(container.querySelector("script")).toBeNull();expect(container.textContent).toContain("<script>literal</script>\n\nSecond");
 expect(container.textContent).not.toContain("Reference settings");expect(container.textContent).not.toContain("Edit property");await click("Open source");expect(p.onOpen).toHaveBeenCalledWith(false);
 await act(async()=>root.render(<PropertyReferenceView {...p} canConfigure={false} result={{status:"unavailable"}}/>));
 expect(container.textContent).not.toMatch(/literal|Second|Source|Summary/);
});
test("panel expands and edits multiline values with explicit save and cancel",async()=>{
 const value="A long paragraph. ".repeat(30)+"\n\nSecond paragraph";const save=vi.fn(async()=>{});
 await mount(<LongTextProperty value={value} name="Summary" canEdit onSave={save}/>);
 expect(container.textContent).toContain("Second paragraph");await click("Show more");expect(container.querySelector('button[aria-expanded="true"]')).toBeTruthy();
 await click("Edit property");expect(container.querySelector("textarea")?.value).toBe(value);await click("Cancel");expect(save).not.toHaveBeenCalled();
 await click("Edit property");await click("Save");expect(save).toHaveBeenCalledWith(value);
});
