// @vitest-environment happy-dom
import {it,expect,vi} from "vitest";
import {act,createElement,useEffect} from "react";
import {createRoot} from "react-dom/client";
import type {ComponentDataAdapter,ComponentSource} from "@eclosion-tech/trellis";
const access=vi.hoisted(()=>({principal:"first",ready:true,canEdit:true,privileged:false,pages:[]}));
const table=vi.hoisted(()=>({ready:true,rows:[]}));
vi.mock("../hooks/usePageAccess",()=>({usePageAccess:()=>access}));
vi.mock("../hooks/useScopedTable",()=>({useScopedTable:()=>table}));
import {useComponentData} from "../hooks/useComponentData";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
it("API tokens remain private to their exact origin and never cross a principal change, including child mount effects",async()=>{
 const calls:{url:string;authorization:string|null}[]=[];
 const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(async(url,init)=>{calls.push({url:String(url),authorization:new Headers(init?.headers).get("Authorization")});return new Response("[]");});
 const source:ComponentSource={label:"API",fields:{name:{type:"string"}},connection:{adapter:"external.json",readUrl:"https://api.example.test/rows",recordsPath:"",idField:"id"}};
 let current:ReturnType<typeof useComponentData>;
 function Child({adapter}:{adapter:ComponentDataAdapter}){useEffect(()=>{const controller=new AbortController(),close=adapter.subscribe!(source,()=>{},controller.signal),other=adapter.subscribe!({...source,connection:{...source.connection as any,readUrl:"https://different.example.test/rows"}},()=>{},controller.signal);return()=>{controller.abort();close();other();};},[adapter]);return null;}
 function Host(){current=useComponentData(7n,async()=>{throw new Error("No writes in credential test");},()=>{throw new Error("No component reads in credential test");});return createElement(Child,{adapter:current.dataAdapters["external.json"]});}
 const container=document.createElement("div"),root=createRoot(container);document.body.append(container);
 try{await act(async()=>root.render(createElement(Host)));await act(async()=>{current!.onCredential("https://api.example.test","PRIVATE_TOKEN");});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});expect(calls.some(call=>call.url.startsWith("https://api.example.test")&&call.authorization==="Bearer PRIVATE_TOKEN")).toBe(true);expect(calls.filter(call=>call.url.startsWith("https://different.example.test")).every(call=>call.authorization===null)).toBe(true);
  const before=calls.length;access.principal="second";await act(async()=>root.render(createElement(Host)));await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});expect(calls.length).toBeGreaterThan(before);expect(calls.slice(before).every(call=>call.authorization===null)).toBe(true);
 }finally{await act(async()=>root.unmount());container.remove();fetch.mockRestore();}
});
