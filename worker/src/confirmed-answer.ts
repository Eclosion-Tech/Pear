/** Manual two-phase, Claude-only text answer. Never imported by worker/job loops. */
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,stat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {discoverExecutionProfiles} from './routing-discovery.js';
import {probeBridgeRoutingProfile,type PreflightConnection} from './routing-preflight.js';
import type {RoutingAdvice} from './routing.js';

export const ANSWER_TIMING=Object.freeze({preflightMs:30_000,deviceMs:120_000,transportMs:125_000,overallMs:180_000});
export interface AnswerOffer {
  readonly schema:'pear-answer-offer-v1';readonly approvalId:string;readonly workspace:string;readonly principalId:string;readonly aiUserId:string;
  readonly profileId:string;readonly configurationFingerprint:string;readonly cliVersion:string;readonly text:string;
  readonly expiresAtMs:number;readonly requestFingerprint:string;readonly contextFingerprint:string;
  readonly tools:'disabled';readonly model:'provider_default';
}
const keys='schema,approvalId,workspace,principalId,aiUserId,profileId,configurationFingerprint,cliVersion,text,expiresAtMs,requestFingerprint,contextFingerprint,tools,model'.split(',');
const hex=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s);
export function validateAnswerOffer(raw:unknown,now=Date.now()):AnswerOffer {
  const o=raw as AnswerOffer;
  if(!o||typeof o!=='object'||Object.keys(o).sort().join()!==[...keys].sort().join()
    ||o.schema!=='pear-answer-offer-v1'||typeof o.workspace!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(o.workspace)||!uuid(o.approvalId)||!hex(o.principalId)||!hex(o.configurationFingerprint)
    ||!hex(o.requestFingerprint)||!hex(o.contextFingerprint)||typeof o.aiUserId!=='string'||!/^[1-9][0-9]{0,19}$/.test(o.aiUserId)
    ||BigInt(o.aiUserId)>18446744073709551615n||typeof o.profileId!=='string'||!/^bridge_[1-9][0-9]*_claude-code$/.test(o.profileId)
    ||typeof o.cliVersion!=='string'||!o.cliVersion||Buffer.byteLength(o.cliVersion)>256
    ||typeof o.text!=='string'||!o.text.trim()||Buffer.byteLength(o.text)>8192||o.tools!=='disabled'||o.model!=='provider_default'
    ||!Number.isSafeInteger(o.expiresAtMs)||o.expiresAtMs<=now||o.expiresAtMs>now+300_000) throw new Error('Invalid or expired answer offer');
  if(Buffer.byteLength(JSON.stringify(o))>12_288)throw new Error('Answer offer exceeds wire budget');
  if(BigInt(o.profileId.split('_')[1])>18446744073709551615n)throw new Error('Invalid device');
  return Object.freeze({...o});
}
export function answerOfferFingerprint(offer:AnswerOffer):string {
  return createHash('sha256').update(JSON.stringify(keys.map(k=>[k,(offer as any)[k]]))).digest('hex');
}
function profile(conn:PreflightConnection,offer:Pick<AnswerOffer,'principalId'|'aiUserId'|'profileId'>){
  return discoverExecutionProfiles(conn,{principalId:offer.principalId,aiUserId:BigInt(offer.aiUserId),nowMs:Date.now(),maxObservationAgeMs:30_000})
    .profiles.find(p=>p.id===offer.profileId&&p.grant==='granted'&&p.availability==='available'&&p.backend==='claude-code'
      &&p.taskProfiles.includes('chat')&&p.capabilities.includes('llm'));
}
/** Only a trusted host may associate advice with its original exact text/context.
 * This does not prove that a model recommendation is an authorization. */
export function createAnswerOffer(conn:PreflightConnection,input:{workspace:string;principalId:string;aiUserId:bigint;text:string;advice:RoutingAdvice}):AnswerOffer {
  const a=input.advice;
  if(a.status!=='advised'||!a.recommendedProfileId||!a.provenance.candidateProfileIds.includes(a.recommendedProfileId)||!/^bridge_[1-9][0-9]*_claude-code$/.test(a.recommendedProfileId))throw new Error('Unsupported or abstained recommendation');
  const scope={workspace:input.workspace,principalId:input.principalId,aiUserId:String(input.aiUserId),profileId:a.recommendedProfileId};
  const p=profile(conn,scope);if(!p?.configurationFingerprint)throw new Error('Recommended profile unavailable');
  const db=conn.db as any;const caps=db.bridge_device_capability??db.bridgeDeviceCapability;
  const deviceId=BigInt(scope.profileId.split('_')[1]);
  const cliVersion=caps&&[...caps.iter()].find((c:any)=>c.deviceId===deviceId&&c.provider==='claude-code')?.version;
  return validateAnswerOffer({schema:'pear-answer-offer-v1',approvalId:randomUUID(),...scope,
    configurationFingerprint:p.configurationFingerprint,cliVersion,text:input.text,expiresAtMs:Date.now()+300_000,
    requestFingerprint:a.provenance.requestFingerprint,contextFingerprint:a.provenance.contextFingerprint,tools:'disabled',model:'provider_default'});
}
export interface AnswerReservation {readonly offer:AnswerOffer;readonly fingerprint:string;readonly journalPath:string}
const reservations=new WeakSet<object>();
/** Human/operator-controlled private file: {schema, approved:true, offer, offerFingerprint}.
 * Reserve once before preflight/launch; hosts should also do this before opening a connection. */
export async function reserveAnswerApproval(path:string):Promise<AnswerReservation>{
  const uid=process.getuid?.();const dir=await stat(dirname(path));
  if(uid===undefined||dir.uid!==uid||!dir.isDirectory()||(dir.mode&0o077)!==0)throw new Error('Unsafe answer directory');
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw:any;
  try{const s=await f.stat();if(s.uid!==uid||!s.isFile()||(s.mode&0o077)!==0||s.size>16_384)throw new Error('Unsafe answer file');raw=JSON.parse(await f.readFile('utf8'));}finally{await f.close();}
  if(!raw||Object.keys(raw).sort().join()!=='approved,offer,offerFingerprint,schema'||raw.schema!=='pear-answer-approval-v1'||raw.approved!==true)throw new Error('Answer not confirmed');
  const offer=validateAnswerOffer(raw.offer);const fingerprint=answerOfferFingerprint(offer);
  if(raw.offerFingerprint!==fingerprint)throw new Error('Confirmed offer changed');
  const journalPath=join(dirname(path),offer.approvalId+'.used');const marker=await open(journalPath,'wx',0o600);
  try{await marker.writeFile(JSON.stringify({state:'reserved',atMs:Date.now(),fingerprint})+'\n');await marker.sync();}finally{await marker.close();}
  const directory=await open(dirname(path),constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
  const reservation=Object.freeze({offer,fingerprint,journalPath});reservations.add(reservation);return reservation;
}
async function record(r:AnswerReservation,state:string,commandId?:string){
  const f=await open(r.journalPath,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW);
  try{const s=await f.stat();if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw new Error('Unsafe answer journal');
    await f.writeFile(JSON.stringify({state,atMs:Date.now(),...(commandId?{commandId}:{})})+'\n');await f.sync();}finally{await f.close();}
}
export type AnswerResult={status:'completed';commandId:string;answer:string;profileId:string}
  |{status:'refused'|'failed'|'unknown';reason:string;commandId?:string};
/** Abort stops waiting, NOT a confirmed remote kill. After launch uncertainty
 * returns unknown; never refunds approval, changes worker or repeats enqueue. */
export async function runConfirmedAnswer(conn:PreflightConnection,r:AnswerReservation,signal:AbortSignal):Promise<AnswerResult>{
  if(!reservations.delete(r))return {status:'refused',reason:'reservation_unavailable'};
  let launched=false,stopped=false,commandId:string|undefined;
  const stop=()=>stopped||signal.aborted||Date.now()>=r.offer.expiresAtMs;
  try{
    const o=validateAnswerOffer(r.offer);if(stop())throw new Error('stopped');
    const current=()=>profile(conn,o)?.configurationFingerprint===o.configurationFingerprint;
    if(!current())throw new Error('profile_changed');
    await record(r,'preflight');
    const probe=await probeBridgeRoutingProfile(conn,{principalId:o.principalId,aiUserId:BigInt(o.aiUserId),profileId:o.profileId,approved:true,timeoutMs:ANSWER_TIMING.preflightMs,signal});
    if(probe.status!=='observed'||stop()||!current())throw new Error('preflight_unavailable');
    const deviceId=BigInt(o.profileId.split('_')[1]),nonce=randomUUID();
    const payloadJson=JSON.stringify({operation:'confirmed-answer-v1',principal_id:o.principalId,ai_user_id:o.aiUserId,
      approval_id:o.approvalId,request_nonce:nonce,offer_fingerprint:r.fingerprint,configuration_fingerprint:o.configurationFingerprint,
      cli_version:o.cliVersion,expires_at_ms:o.expiresAtMs,text:o.text});
    const db=conn.db as any,results=db.bridge_command_result??db.bridgeCommandResult;
    if(typeof results?.iter!=='function'||typeof conn.reducers?.enqueueBridgeInference!=='function')throw new Error('transport_unavailable');
    await record(r,'launching');if(stop()||!current())throw new Error('stopped');
    const started=Date.now();launched=true; // Must precede any potentially accepted enqueue.
    const work=async():Promise<AnswerResult>=>{
      await conn.reducers.enqueueBridgeInference({deviceId,provider:'claude-code',model:'',payloadJson,conversationId:0n,jobId:undefined,taskId:undefined,nonce});
      if(stop())throw new Error('wait_stopped');
      await record(r,'submitted');
      while(!stop()&&Date.now()-started<ANSWER_TIMING.transportMs){
        for(const row of results.iter()){
          if(row.requestedBy?.toHexString()!==o.principalId||typeof row.stdout!=='string'||Buffer.byteLength(row.stdout)>65_536)continue;
          let envelope:any,e:any;try{envelope=JSON.parse(row.stdout);e=JSON.parse(envelope.output);}catch{continue;}
          if(e.request_nonce!==nonce)continue;
          const completed=typeof row.completedAt?.microsSinceUnixEpoch==='bigint'?Number(row.completedAt.microsSinceUnixEpoch)/1000:NaN;
          if(typeof row.commandId!=='bigint'||row.commandId<=0n||e.schema!=='bridge-confirmed-answer-v1'||e.command_id!==String(row.commandId)||e.device_id!==String(deviceId)
            ||typeof e.session_id!=='string'||!/^[1-9][0-9]*$/.test(e.session_id)||e.principal_id!==o.principalId||e.ai_user_id!==o.aiUserId
            ||e.approval_id!==o.approvalId||e.offer_fingerprint!==r.fingerprint||e.configuration_fingerprint!==o.configurationFingerprint
            ||e.cli_version!==o.cliVersion||envelope.provider!=='confirmed-answer'||!Number.isFinite(completed)
            ||completed<started-5000||completed>Date.now()+5000)throw new Error('invalid_receipt');
          commandId=String(row.commandId);
          if(row.rejectionReason||row.exitCode!==0||envelope.ok!==true){await record(r,'failed',commandId);return {status:'failed',reason:'device_refused_or_failed',commandId};}
          if(e.provider!=='claude-code'||e.auth!=='subscription_login'||e.extra_usage!=='operator_attested_disabled'||e.tools!=='disabled'
            ||envelope.tool_calls!=null||typeof e.answer!=='string'||!e.answer||Buffer.byteLength(e.answer)>32_768)throw new Error('invalid_answer');
          if(stop()||!current())throw new Error('scope_changed');
          await record(r,'completed',commandId);return {status:'completed',commandId,answer:e.answer,profileId:o.profileId};
        }
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      throw new Error('wait_stopped');
    };
    let timer:ReturnType<typeof setTimeout>|undefined;let abort:(()=>void)|undefined;
    try{return await Promise.race([work(),new Promise<never>((_,reject)=>{
      abort=()=>reject(new Error('wait_stopped'));timer=setTimeout(abort,ANSWER_TIMING.transportMs);
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    })]);}finally{stopped=true;if(timer)clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);}
  }catch{
    const status=launched?'unknown':'refused';await record(r,status,commandId).catch(()=>{});
    return {status,reason:launched?'upstream_state_unknown_no_retry':'confirmation_or_preflight_refused',...(commandId?{commandId}:{})};
  }
}
