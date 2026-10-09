import {test} from "node:test";
import assert from "node:assert/strict";
import {createBridgeSystemOneClient} from "./bridge-system-one.js";

function fixture(change:(e:any)=>void=()=>{}) {
  const principalId="a".repeat(64),identity={toHexString:()=>principalId};
  let granted=true,connected=true,calls=0,version="0.35.0";
  const rows:any[]=[],payloads:any[]=[];
  const detectedAt={microsSinceUnixEpoch:BigInt(Date.now())*1000n};
  const conn={db:{ai_user_config:{id:{find:()=>({id:1n,identity,provider:{tag:"Anthropic"},model:"mock",apiKey:"SECRET"})}},
    bridge_device_grant:{iter:()=>granted?[{deviceId:2n,aiUserIdentity:identity}]:[]},
    bridge_device_summary:{iter:()=>[{id:2n,connected}]},bridge_device_capability:{iter:()=>[
      {deviceId:2n,provider:"ollama",version,available:true,detectedAt}]},bridge_command_result:{iter:()=>rows}},
    reducers:{enqueueBridgeInference(args:any){calls++;const p=JSON.parse(args.payloadJson);payloads.push(p);
      const e={schema:"bridge-local-system-one-v1",request_nonce:p.request_nonce,command_id:"9",device_id:"2",session_id:"3",
        principal_id:principalId,ai_user_id:"1",configuration_fingerprint:p.configuration_fingerprint,endpoint:p.endpoint,
        model_digest:p.model_digest,decision:{model:p.model,answers:{q:{type:"choice",choice:"a",probabilities:{a:1}}}}};change(e);
      rows.push({commandId:9n,requestedBy:identity,completedAt:{microsSinceUnixEpoch:BigInt(Date.now())*1000n},exitCode:0,
        stdout:JSON.stringify({ok:true,provider:"local-system-one",output:JSON.stringify(e)})});}}};
  const options={approved:true,principalId,aiUserId:1n,deviceId:2n,endpoint:"http://127.0.0.1:11434/v1/systemone",
    model:"nimble:latest",modelDigest:"b".repeat(64),timeoutMs:100};
  return {conn,options,payloads,rows,calls:()=>calls,revoke:()=>{granted=false;},offline:()=>{connected=false;},changeVersion:()=>{version="changed";}};
}
const request={state:{summary:"approved"},questions:{q:{type:"choice" as const,instructions:"choose",criteria:{a:"first"}}}};
test("one local decision, selected payload and no worker credential or fallback",async()=>{
  const f=fixture(),client=createBridgeSystemOneClient(f.conn,f.options),signal=new AbortController().signal;
  const result:any=await client.decide(request,signal);assert.equal(result.model,"nimble:latest");assert.equal(f.calls(),1);
  assert.equal(JSON.stringify(f.payloads).includes("SECRET"),false);assert.equal(f.payloads[0].operation,"local-system-one-v1");
  assert.equal("prompt" in f.payloads[0],false);assert.equal("chat" in f.payloads[0],false);
  await assert.rejects(client.decide(request,signal),/budget exhausted/);assert.equal(f.calls(),1);
});
test("approval and loopback-only exact endpoint validation",()=>{
  for(const options of [{approved:false},{endpoint:"https://remote.invalid/v1/systemone"},{endpoint:"http://localhost:11434/v1/systemone"},
    {endpoint:"http://127.0.0.1:11434/v1/systemone?key=SECRET"},{model:"nimble:cloud"},{modelDigest:"bad"}]) {
    const f=fixture();assert.throws(()=>createBridgeSystemOneClient(f.conn,{...f.options,...options}));assert.equal(f.calls(),0);
  }
});
test("no grant, offline, wrong identity and cancellation never enqueue",async()=>{
  for(const type of ["grant","offline","identity","cancelled"]) {
    const f=fixture(),c=new AbortController();if(type==="grant")f.revoke();if(type==="offline")f.offline();
    if(type==="identity")f.options.principalId="b".repeat(64);if(type==="cancelled")c.abort();
    const client=createBridgeSystemOneClient(f.conn,f.options);await assert.rejects(client.decide(request,c.signal));
    assert.equal(f.calls(),0);await assert.rejects(client.decide(request,c.signal),/budget exhausted/);
  }
});
for(const field of ["command_id","device_id","session_id","principal_id","ai_user_id","configuration_fingerprint","model_digest","endpoint"]) {
  test(`invalid receipt ${field} is refused without retry`,async()=>{
    const f=fixture(e=>e[field]="wrong"),client=createBridgeSystemOneClient(f.conn,f.options);
    await assert.rejects(client.decide(request,new AbortController().signal));assert.equal(f.calls(),1);
  });
}
test("revocation/config change after result invalidates decision",async()=>{
  for(const changed of ["grant","version"]) {
    const f=fixture();const old=f.conn.reducers.enqueueBridgeInference;
    f.conn.reducers.enqueueBridgeInference=(args:any)=>{old(args);if(changed==="grant")f.revoke();else f.changeVersion();};
    await assert.rejects(createBridgeSystemOneClient(f.conn,f.options).decide(request,new AbortController().signal));assert.equal(f.calls(),1);
  }
});
test("nonce replay and hanging enqueue are bounded; neither retries",async()=>{
  const f=fixture(e=>e.request_nonce="other");f.options.timeoutMs=20;
  await assert.rejects(createBridgeSystemOneClient(f.conn,f.options).decide(request,new AbortController().signal));assert.equal(f.calls(),1);
  const g=fixture();g.options.timeoutMs=20;let calls=0;
  const conn={...g.conn,reducers:{enqueueBridgeInference:()=>{calls++;return new Promise<void>(()=>{});}}};
  await assert.rejects(createBridgeSystemOneClient(conn,g.options).decide(request,new AbortController().signal));assert.equal(calls,1);
});
