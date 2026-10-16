import {test as platformTest} from 'node:test';
// Durable Unix ownership/mode enforcement is deliberately unsupported elsewhere.
const test=typeof process.getuid==='function'?platformTest:platformTest.skip;
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createAnswerOffer,createDirectAnswerOffer,validateAnswerOffer,answerOfferFingerprint,reserveAnswerApproval,runConfirmedAnswer,ANSWER_TIMING} from './confirmed-answer.js';
function fixture(change:(e:any)=>void=()=>{}){
  const principalId='a'.repeat(64),identity={toHexString:()=>principalId},rows:any[]=[],payloads:any[]=[];
  let granted=true,connected=true,version='mock';
  const detectedAt={microsSinceUnixEpoch:BigInt(Date.now())*1000n};
  const conn={db:{ai_user_config:{id:{find:()=>({id:1n,identity,provider:{tag:'Anthropic'},model:'mock',apiKey:'SECRET'})}},
    bridge_device_grant:{iter:()=>granted?[{deviceId:2n,aiUserIdentity:identity}]:[]},bridge_device_summary:{iter:()=>[{id:2n,connected}]},
    bridge_device_capability:{iter:()=>[{deviceId:2n,provider:'claude-code',version,available:true,detectedAt}]},bridge_command_result:{iter:()=>rows}},
    reducers:{enqueueBridgeInference(args:any){const p=JSON.parse(args.payloadJson);payloads.push(p);const native=p.operation==='subscription-preflight-v1';
      const id=BigInt(payloads.length);const common={command_id:String(id),device_id:'2',session_id:'3',principal_id:principalId,ai_user_id:'1',
        configuration_fingerprint:p.configuration_fingerprint,request_nonce:p.request_nonce};
      const e=native?{...common,schema:'bridge-subscription-evidence-v1',no_inference:true,profile_id:p.profile_id,provider:p.provider,
        cli_version:p.expected_cli_version,task_profile:'chat',auth_policy:'subscription-only',auth:'subscription_login',extra_usage:'operator_attested_disabled',readiness:'auth_preflight_only'}:
        {...common,schema:'bridge-confirmed-answer-v1',approval_id:p.approval_id,offer_fingerprint:p.offer_fingerprint,cli_version:p.cli_version,
          provider:'claude-code',auth:'subscription_login',extra_usage:'operator_attested_disabled',tools:'disabled',answer:'A bounded answer.'};
      if(!native)change(e);
      rows.push({commandId:id,requestedBy:identity,exitCode:0,completedAt:{microsSinceUnixEpoch:BigInt(Date.now())*1000n},
        stdout:JSON.stringify({ok:true,provider:native?'routing-preflight':'confirmed-answer',output:JSON.stringify(e)})});}}};
  const advice:any={status:'advised',recommendedProfileId:'bridge_2_claude-code',provenance:{requestFingerprint:'b'.repeat(64),contextFingerprint:'c'.repeat(64),candidateProfileIds:['bridge_2_claude-code']}};
  const offer=createAnswerOffer(conn,{workspace:'test',principalId,aiUserId:1n,text:'Explain a design tradeoff.',advice});
  return {conn,offer,payloads,rows,advice,revoke:()=>{granted=false},offline:()=>{connected=false},changeVersion:()=>{version='other'}};
}
async function approval(offer:ReturnType<typeof createAnswerOffer>,approved=true){
  const dir=await mkdtemp(join(tmpdir(),'pear-confirmed-'));await chmod(dir,0o700);const path=join(dir,'approval.json');
  const raw={schema:'pear-answer-approval-v1',approved,offer,offerFingerprint:answerOfferFingerprint(offer)};
  await writeFile(path,JSON.stringify(raw),{mode:0o600});return {dir,path,raw,clean:()=>rm(dir,{recursive:true,force:true})};
}
test('offer preparation performs no inference and binds exact text, scope, expiry and worker',()=>{
  const f=fixture();assert.equal(f.payloads.length,0);assert.ok(Object.isFrozen(f.offer));
  for(const bad of [{tools:'enabled'},{model:'paid-model'},{text:''},{text:'x'.repeat(8193)},{expiresAtMs:0},{principalId:'other'},{profileId:'bridge_2_codex'},{extra:'SECRET'}])
    assert.throws(()=>validateAnswerOffer({...f.offer,...bad}));
  assert.notEqual(answerOfferFingerprint(f.offer),answerOfferFingerprint({...f.offer,text:'Changed'}));
  for(const recommendedProfileId of [null,'bridge_2_codex','api_1'])assert.throws(()=>createAnswerOffer(f.conn,{workspace:'test',principalId:f.offer.principalId,aiUserId:1n,text:f.offer.text,advice:{...f.advice,recommendedProfileId}}));
  assert.ok(ANSWER_TIMING.deviceMs<ANSWER_TIMING.transportMs);
  assert.ok(ANSWER_TIMING.preflightMs+ANSWER_TIMING.transportMs<ANSWER_TIMING.overallMs);
});
test('explicit confirmation, private file and durable once marker are mandatory',async()=>{
  const f=fixture(),a=await approval(f.offer,false);
  try{await assert.rejects(reserveAnswerApproval(a.path));
    a.raw.approved=true;a.raw.offer={...a.raw.offer,text:'Tampered'};await writeFile(a.path,JSON.stringify(a.raw));await assert.rejects(reserveAnswerApproval(a.path));
    a.raw.offer=f.offer;await writeFile(a.path,JSON.stringify(a.raw));await chmod(a.path,0o644);await assert.rejects(reserveAnswerApproval(a.path));await chmod(a.path,0o600);
    const settled=await Promise.allSettled([reserveAnswerApproval(a.path),reserveAnswerApproval(a.path)]);assert.equal(settled.filter(s=>s.status==='fulfilled').length,1);
    await assert.rejects(reserveAnswerApproval(a.path));assert.equal(f.payloads.length,0);
  }finally{await a.clean();}
});
test('confirmed run is one fresh preflight then one tool-less answer, never a classifier or fallback',async()=>{
  const f=fixture(),a=await approval(f.offer);
  try{const r=await reserveAnswerApproval(a.path);const result=await runConfirmedAnswer(f.conn,r,new AbortController().signal);
    assert.equal(result.status,'completed');if(result.status==='completed')assert.equal(result.answer,'A bounded answer.');
    assert.deepEqual(f.payloads.map(p=>p.operation),['subscription-preflight-v1','confirmed-answer-v1']);
    assert.equal(f.payloads[1].text,f.offer.text);assert.equal('prompt' in f.payloads[1],false);assert.equal(JSON.stringify(f.payloads).includes('SECRET'),false);
    const journal=await readFile(r.journalPath,'utf8');assert.ok(journal.includes('completed'));assert.equal(journal.includes('A bounded answer.'),false);
    assert.equal((await runConfirmedAnswer(f.conn,r,new AbortController().signal)).status,'refused');assert.equal(f.payloads.length,2);
  }finally{await a.clean();}
});
for(const change of ['grant','offline','config','abort'])test(`changed ${change} refuses launch`,async()=>{
  const f=fixture(),a=await approval(f.offer),controller=new AbortController();
  try{const r=await reserveAnswerApproval(a.path);if(change==='grant')f.revoke();if(change==='offline')f.offline();if(change==='config')f.changeVersion();if(change==='abort')controller.abort();
    assert.equal((await runConfirmedAnswer(f.conn,r,controller.signal)).status,'refused');assert.equal(f.payloads.length,0);
  }finally{await a.clean();}
});
for(const field of ['command_id','principal_id','session_id','device_id','approval_id','offer_fingerprint','configuration_fingerprint','cli_version','tools'])test(`invalid ${field} yields unknown, not a repeat launch`,async()=>{
  const f=fixture(e=>e[field]='wrong'),a=await approval(f.offer);
  try{const r=await reserveAnswerApproval(a.path);assert.equal((await runConfirmedAnswer(f.conn,r,new AbortController().signal)).status,'unknown');assert.equal(f.payloads.length,2);
    await assert.rejects(reserveAnswerApproval(a.path));
  }finally{await a.clean();}
});
test('revocation after native preflight stops before inference',async()=>{
  const f=fixture(),a=await approval(f.offer),original=f.conn.reducers.enqueueBridgeInference;
  f.conn.reducers.enqueueBridgeInference=(args:any)=>{original(args);f.revoke();};
  try{const r=await reserveAnswerApproval(a.path);assert.equal((await runConfirmedAnswer(f.conn,r,new AbortController().signal)).status,'refused');assert.equal(f.payloads.length,1);}finally{await a.clean();}
});
test('cancelled hanging inference enqueue is unknown, consumes approval and cannot resume a launch loop',async()=>{
  const f=fixture(),a=await approval(f.offer),controller=new AbortController(),original=f.conn.reducers.enqueueBridgeInference;
  let release:()=>void=()=>{};
  f.conn.reducers.enqueueBridgeInference=(args:any)=>{
    if(JSON.parse(args.payloadJson).operation==='subscription-preflight-v1')return original(args);
    f.payloads.push(JSON.parse(args.payloadJson));setTimeout(()=>controller.abort(),5);return new Promise<void>(resolve=>{release=resolve;});
  };
  try{const r=await reserveAnswerApproval(a.path);assert.equal((await runConfirmedAnswer(f.conn,r,controller.signal)).status,'unknown');
    release();await new Promise(resolve=>setTimeout(resolve,10));
    const states=(await readFile(r.journalPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line).state);
    assert.equal(states.at(-1),'unknown');assert.equal(states.includes('submitted'),false);assert.equal(f.payloads.length,2);
    await assert.rejects(reserveAnswerApproval(a.path));
  }finally{await a.clean();}
});
test('direct human selection creates an offer without fabricating classifier advice',()=>{
 const f=fixture();const offer=createDirectAnswerOffer(f.conn,{workspace:'test',principalId:f.offer.principalId,aiUserId:1n,profileId:'bridge_2_claude-code',text:'Direct choice.'});
 assert.equal(f.payloads.length,0);assert.equal(offer.text,'Direct choice.');assert.notEqual(offer.requestFingerprint,f.offer.requestFingerprint);
 assert.throws(()=>createDirectAnswerOffer(f.conn,{workspace:'test',principalId:f.offer.principalId,aiUserId:1n,profileId:'bridge_2_codex',text:'No switch.'}));
});
for(const boundary of [1,2,3])test(`fresh host authorization denial at boundary ${boundary} never retries`,async()=>{
 const f=fixture(),a=await approval(f.offer);let checks=0;
 try{const r=await reserveAnswerApproval(a.path);const result=await runConfirmedAnswer(f.conn,r,new AbortController().signal,{authorize:async()=>{if(++checks===boundary)throw new Error('REVOKED_SECRET');}});
  assert.equal(result.status,boundary===3?'unknown':'refused');assert.equal(f.payloads.length,boundary===1?0:boundary===2?1:2);
  assert.equal(JSON.stringify(result).includes('SECRET'),false);await assert.rejects(reserveAnswerApproval(a.path));
 }finally{await a.clean();}
});
test('authorization that resolves after abort cannot overwrite unknown with completed',async()=>{
 const f=fixture(),a=await approval(f.offer),controller=new AbortController();let checks=0,release:()=>void=()=>{};
 try{const r=await reserveAnswerApproval(a.path);const pending=runConfirmedAnswer(f.conn,r,controller.signal,{authorize:async()=>{if(++checks===3){setTimeout(()=>controller.abort(),5);await new Promise<void>(resolve=>{release=resolve;});}}});
  assert.equal((await pending).status,'unknown');release();await new Promise(resolve=>setTimeout(resolve,20));
  const lines=(await readFile(r.journalPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line).state);assert.equal(lines.at(-1),'unknown');assert.equal(lines.includes('completed'),false);
 }finally{await a.clean();}
});
for(const boundary of [1,2])test(`hanging authorization at boundary ${boundary} aborts before inference, with no late continuation`,async()=>{
 const f=fixture(),a=await approval(f.offer),controller=new AbortController();let checks=0,release:()=>void=()=>{};
 try{const r=await reserveAnswerApproval(a.path);const result=await runConfirmedAnswer(f.conn,r,controller.signal,{authorize:async()=>{if(++checks===boundary){setTimeout(()=>controller.abort(),5);await new Promise<void>(resolve=>{release=resolve;});}}});
  assert.equal(result.status,'refused');assert.equal(f.payloads.length,boundary-1);release();await new Promise(resolve=>setTimeout(resolve,15));assert.equal(f.payloads.length,boundary-1);
  await assert.rejects(reserveAnswerApproval(a.path));
 }finally{await a.clean();}
});
