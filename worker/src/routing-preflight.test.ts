import { test } from "node:test";
import assert from "node:assert/strict";
import { probeBridgeRoutingProfile, createBridgeBillingObserver } from "./routing-preflight.js";
import { observeOrchaPlan } from "./orcha-routing.js";
import { discoverExecutionProfiles } from "./routing-discovery.js";

function fixture(change: (e: Record<string, unknown>) => void = () => {}) {
  const principalId = "a".repeat(64);
  const identity = { toHexString: () => principalId };
  let granted = true, version = "fake-version", calls = 0;
  const rows: unknown[] = [], payloads: Record<string, unknown>[] = [];
  const conn = { db: {
    ai_user_config: { id: { find: () => ({ id: 1n, identity, provider: {tag:"Anthropic"}, model:"mock", apiKey:"SECRET",
      inferenceBackendJson:'{"mode":"bridge","device_id":2,"provider":"claude-code"}' }) } },
    bridge_device_grant: { iter: () => granted ? [{ deviceId:2n, aiUserIdentity:identity }] : [] },
    bridge_device_summary: { iter: () => [{ id:2n, connected:true }] },
    bridge_device_capability: { iter: () => [{ deviceId:2n, provider:"claude-code", available:true, version,
      detectedAt:{ microsSinceUnixEpoch:BigInt(Date.now()) * 1000n } }] },
    bridge_command_result: { iter: () => rows },
  }, reducers: { enqueueBridgeInference(args: {payloadJson:string}) {
    calls++; const p = JSON.parse(args.payloadJson); payloads.push(p);
    const e = { schema:"bridge-subscription-evidence-v1", no_inference:true,
      device_id:"2", command_id:"9", session_id:"3", principal_id:principalId,
      ai_user_id:"1", profile_id:p.profile_id, configuration_fingerprint:p.configuration_fingerprint,
      request_nonce:p.request_nonce, provider:p.provider, cli_version:p.expected_cli_version,
      task_profile:"chat", auth_policy:"subscription-only", auth:"subscription_login",
      extra_usage:"operator_attested_disabled", readiness:"auth_preflight_only" };
    change(e);
    rows.push({ commandId:9n, requestedBy:identity, completedAt:{microsSinceUnixEpoch:BigInt(Date.now())*1000n},
      exitCode:0, stdout:JSON.stringify({ok:true,provider:"routing-preflight",output:JSON.stringify(e)}) });
  } } };
  const options = { principalId, aiUserId:1n, profileId:"bridge_2_claude-code", approved:true, timeoutMs:1000 };
  return { conn, options, payloads, rows, calls:()=>calls, revoke:()=>{granted=false;}, changeVersion:()=>{version="changed";} };
}

test("explicit probe sends no prompt/chat/worker key and yields scoped fresh attested evidence", async () => {
  const f = fixture();
  // Stable source detection timestamp, as in a real capability row.
  const caps = [...f.conn.db.bridge_device_capability.iter()];
  f.conn.db.bridge_device_capability.iter = () => caps;
  const result = await probeBridgeRoutingProfile(f.conn, f.options);
  assert.equal(result.status,"observed"); assert.equal(f.calls(),1);
  assert.equal(JSON.stringify(f.payloads).includes("SECRET"),false);
  assert.equal("prompt" in f.payloads[0],false); assert.equal("chat" in f.payloads[0],false);
  if (result.status === "observed") {
    assert.equal(result.evidence.extraUsage,"operator_attested_disabled");
    const profiles = discoverExecutionProfiles(f.conn,{principalId:f.options.principalId,aiUserId:1n,
      nowMs:Date.now(),maxObservationAgeMs:30_000,billingObservations:[result.observation]}).profiles;
    assert.equal(profiles[0].billingVerified,true);
  }
});

test("no consent, wrong identity, absent grant and cancelled probe never enqueue", async () => {
  for (const reason of ["approval","identity","grant","cancelled"]) {
    const f = fixture(); const opts = {...f.options};
    if (reason === "approval") opts.approved=false;
    if (reason === "identity") opts.principalId="b".repeat(64);
    if (reason === "grant") f.revoke();
    const controller = new AbortController();
    if (reason === "cancelled") controller.abort();
    const result = await probeBridgeRoutingProfile(f.conn,{...opts,signal:controller.signal});
    assert.equal(result.status,"unavailable"); assert.equal(f.calls(),0);
  }
});

for (const field of ["device_id","command_id","principal_id","ai_user_id","configuration_fingerprint",
  "provider","cli_version","auth_policy","auth","extra_usage","readiness","schema","task_profile"]) {
  test(`rejects mismatched proof ${field} without retry`, async () => {
    const f = fixture(e=>{e[field]="wrong";});
    const caps = [...f.conn.db.bridge_device_capability.iter()];
    f.conn.db.bridge_device_capability.iter=()=>caps;
    const result = await probeBridgeRoutingProfile(f.conn,f.options);
    assert.deepEqual(result,{status:"unavailable",reason:"invalid_evidence"}); assert.equal(f.calls(),1);
  });
}

test("revocation during probe invalidates evidence", async () => {
  let revoke = () => {};
  const f = fixture(()=>revoke()); revoke=f.revoke;
  const caps = [...f.conn.db.bridge_device_capability.iter()];
  f.conn.db.bridge_device_capability.iter=()=>caps;
  assert.deepEqual(await probeBridgeRoutingProfile(f.conn,f.options),{status:"unavailable",reason:"profile_changed"});
});

test("explicit Orcha observer refreshes stale native-chat evidence before one mocked advisory", async () => {
  const f=fixture();
  const caps=[...f.conn.db.bridge_device_capability.iter()];
  caps[0].detectedAt.microsSinceUnixEpoch=BigInt(Date.now()-86_400_000)*1000n;
  f.conn.db.bridge_device_capability.iter=()=>caps;
  let classifierCalls=0;
  const reports=await observeOrchaPlan({jobId:"1",orchestrateTaskId:"2",aiUserId:1n,
    principalId:f.options.principalId,connection:f.conn,nowMs:Date.now()},
    [{description:"private page",task_type:"llm",depends_on:[],required_capabilities:["llm"]}], {
      prepare(c) { const p=c.profiles[0]; return {summary:"approved summary",artifacts:{repo:false,diff:false,logs:false},
        taskProfile:"chat",requiredCapabilities:["llm"],policy:{version:"1",approvedProfileIds:[p.id],
          allowedWorkerDestinations:[p.destination],allowedBilling:["subscription"],maxObservationAgeMs:1000},
        advisor:{destination:"mock",hosted:false,consent:{enabled:true,allowedDestinations:["mock"],allowHostedSpend:false},
          timeoutMs:100,maxRequestBytes:20_000,client:{async decide(r) {classifierCalls++;
            assert.equal(JSON.stringify(r).includes("private page"),false);
            return {model:"mock",answers:Object.fromEntries(Object.entries(r.questions).map(([k,q])=>{
              const choice=Object.keys(q.criteria)[0];return [k,{type:"choice",choice,
                probabilities:Object.fromEntries(Object.keys(q.criteria).map(s=>[s,Number(s===choice)]))}];}))};
          }}}}; },
      observeBilling:createBridgeBillingObserver({maxProfiles:1,timeoutMs:1000}),onAdvice:()=>{},
    });
  assert.equal(f.calls(),1);assert.equal(classifierCalls,1);assert.equal(reports[0].advice.status,"advised");
});

test("native evidence cannot turn an active harness binding into a ready chat candidate", async () => {
  const f=fixture();
  const oldFind=f.conn.db.ai_user_config.id.find;
  f.conn.db.ai_user_config.id.find=()=>({...oldFind(),inferenceBackendJson:
    '{"mode":"harness","device_id":2,"provider":"claude-code","cwd":"/repo","permission_mode":"plan"}'});
  const result=await probeBridgeRoutingProfile(f.conn,f.options);
  assert.deepEqual(result,{status:"unavailable",reason:"profile_unavailable"});assert.equal(f.calls(),0);
});

test("historical result with a different nonce is not reused", async () => {
  const f=fixture(e=>{e.request_nonce="old";});
  const result=await probeBridgeRoutingProfile(f.conn,{...f.options,timeoutMs:30});
  assert.deepEqual(result,{status:"unavailable",reason:"timeout"});assert.equal(f.calls(),1);
});

test("hanging enqueue is bounded; no fallback or retry", async () => {
  const f = fixture();
  f.conn.reducers.enqueueBridgeInference = () => new Promise<void>(()=>{});
  const start=Date.now();
  assert.deepEqual(await probeBridgeRoutingProfile(f.conn,{...f.options,timeoutMs:20}),{status:"unavailable",reason:"timeout"});
  assert.ok(Date.now()-start<500);
});
