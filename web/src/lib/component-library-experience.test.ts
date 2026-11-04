// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from "vitest";
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import {canonicalJson,createAuthoredComponent,prepareAuthoredTemplate,reusableComponentReference} from "@eclosion-tech/trellis";
import {INTERFACE_REGISTRY} from "@pear/trellis-ui";
import {ComponentLibraryProvider,WorkspaceComponentsButton} from "../components/component-renderers/ComponentLibraryProvider";
import {useComponentSlashItems} from "../components/component-renderers/useComponentSlashItems";
const state=vi.hoisted(()=>({principal:"a".repeat(64),families:[] as any[],versions:[] as any[],connection:null as any}));
vi.mock("spacetimedb/react",()=>({useSpacetimeDB:()=>({identity:{toHexString:()=>state.principal},getConnection:()=>state.connection})}));
vi.mock("../hooks/usePageAccess",()=>({usePageAccess:(id:bigint)=>({principal:state.principal,privileged:false,canEdit:id===7n,ready:true,pages:[{id:7n,title:"Destination",pageType:{tag:"Doc"}}]})}));
vi.mock("../hooks/useComponentRepository",()=>({useWorkspaceComponentTemplates:()=>({rows:state.families,ready:true}),useWorkspaceComponentVersions:()=>({rows:state.versions,ready:true}),useComponentRepositoryWriter:()=>async()=>{}}));
vi.mock("../hooks/useScopedTable",()=>({useScopedTable:()=>({rows:[{id:70n,parentId:null,surfaceId:7n}],ready:true})}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|null=null,container:HTMLDivElement;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;container?.remove();});
let openBrowse:()=>void;const inserted:Record<string,unknown>[]=[];
function Probe(){const items=useComponentSlashItems(7n,70n);openBrowse=()=>items.find(item=>item.id==="browse-components")!.choose!({insert:item=>{inserted.push(item.defaultProps);}});return createElement(WorkspaceComponentsButton);}
async function mount(){
 const blank=await createAuthoredComponent("Saved form",{catalog:INTERFACE_REGISTRY.catalog,principal:state.principal,parentId:"70",requestId:"blank",documentId:"source",instanceId:"source"});
 const pkg=await prepareAuthoredTemplate(blank,INTERFACE_REGISTRY.catalog,{slug:"saved-form",name:"Saved form",description:"Reusable form",version:"1.0.0",tags:[]}),reference=await reusableComponentReference(pkg);
 state.families=[{templateId:reference.templateId,name:pkg.name,description:pkg.description,tagsJson:"[]",latestVersion:reference.version,owner:{toHexString:()=>state.principal},revision:0n,archived:false}];
 state.versions=[{templateId:reference.templateId,version:reference.version,packageJson:canonicalJson(pkg),contentHash:reference.hash}];
 state.connection={identity:{toHexString:()=>state.principal}};
 inserted.length=0;container=document.createElement("div");document.body.append(container);root=createRoot(container);
 await act(async()=>{root!.render(createElement(ComponentLibraryProvider,null,createElement(Probe)));});
 return reference;
}
const button=(name:string)=>[...document.querySelectorAll("button")].find(button=>(button.getAttribute("aria-label")??[...button.childNodes].filter(node=>!(node instanceof Element&&node.getAttribute("aria-hidden")==="true")).map(node=>node.textContent).join(""))?.trim()===name)!;
async function click(name:string){await act(async()=>{button(name).click();await new Promise(resolve=>setTimeout(resolve,25));});}
it("sidebar library requires an explicit destination and previews the immutable workspace template",async()=>{
 await mount();await click("Components");expect(document.querySelector('dialog')!.open).toBe(true);await click("Saved form");
 expect(button("Insert into this page").disabled).toBe(true);expect(document.querySelector('[aria-label="Selected component template"]')).not.toBeNull();
 const target=[...document.querySelectorAll('select')].find(select=>select.parentElement?.textContent?.includes("Insert into page"))!;
 await act(async()=>{target.value="7";target.dispatchEvent(new Event("change",{bubbles:true}));});expect(button("Insert into this page").disabled).toBe(false);
 await click("Close component library");expect(document.querySelector('dialog')).toBeNull();
});
it("Browse all returns a pinned descriptor to the original slash callback without appending a separate page instance",async()=>{
 const reference=await mount();await act(async()=>openBrowse());await click("Saved form");expect(button("Insert at cursor").disabled).toBe(false);await click("Insert at cursor");
 expect(inserted).toEqual([{kind:"component-template",templateId:reference.templateId,version:reference.version,hash:reference.hash}]);expect(document.querySelector('dialog')).toBeNull();
});
