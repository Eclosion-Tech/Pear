import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
/** Disposable localhost integration test. Builds use the normal module WASM. */
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { HttpStdbTransport } from '../src/lib/api-endpoint/http-transport';
import { requestHumanInputTool } from '../src/lib/mcp/human-input';
import { DbConnection } from '../src/module_bindings';

async function main() {
  const base = process.argv[2] ?? 'http://127.0.0.1:3098';
  assert(['localhost','127.0.0.1'].includes(new URL(base).hostname));
  const name = `pear-input-e2e-${Date.now()}`;
  const url = `${base}/v1/database/${name}`;
  const sockets: WebSocket[] = [];
  const subscriptions: DbConnection[] = [];
  const none = { none: [] }; const ident = (hex: string) => [`0x${hex}`];
  async function identity() { return await (await fetch(`${base}/v1/identity`, { method: 'POST' })).json() as { identity: string; token: string }; }
  const owner = await identity();
  type Actor = { identity: string; token: string; db: HttpStdbTransport };
  async function actor(): Promise<Actor> {
    const a = await identity();
    const socket = new WebSocket(`${url.replace('http:','ws:')}/subscribe?token=${encodeURIComponent(a.token)}`, 'v1.json.spacetimedb'); sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Connect timeout')), 10000);
      socket.addEventListener('message', e => { if (JSON.parse(String(e.data)).IdentityToken) { clearTimeout(timer); resolve(); } });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('Connect failed')); });
    });
    return { ...a, db: new HttpStdbTransport({ baseUrl: base, dbName: name, token: a.token }) };
  }
  const publisher = new HttpStdbTransport({ baseUrl: base, dbName: name, token: owner.token });
  async function subscribeRequests(a: Actor): Promise<DbConnection> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Human-input subscription timeout')), 10000);
      const connection = DbConnection.builder().withUri(base).withDatabaseName(name).withToken(a.token)
        .onConnect(conn => {
          conn.subscriptionBuilder()
            .onApplied(() => { clearTimeout(timer); resolve(conn); })
            .onError((_ctx, error) => { clearTimeout(timer); reject(error); })
            .subscribe(['SELECT * FROM human_input_request', 'SELECT * FROM conversation_message']);
        })
        .onConnectError((_ctx, error) => { clearTimeout(timer); reject(error); })
        .build();
      subscriptions.push(connection);
    });
  }
  async function waitFor(predicate: () => boolean, label: string) {
    const until = Date.now() + 10000;
    while (!predicate()) {
      assert(Date.now() < until, `Timed out: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    const wasm = await readFile(new URL('../../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm', import.meta.url));
    const upgradeFrom = process.env.PEAR_UPGRADE_FROM_WASM;
    const result = await fetch(url, { method:'PUT', headers:{Authorization:`Bearer ${owner.token}`}, body:upgradeFrom ? await readFile(upgradeFrom) : wasm });
    assert(result.ok, await result.text());
    const human = await actor(), other = await actor(), ai = await actor();
    await human.db.call('register', ['owner@example.test','Human','fixture-password']);
    await human.db.call('create_local_user', ['other@example.test','Other','fixture-password']);
    await other.db.call('login', ['other@example.test','fixture-password']);
    await publisher.call('create_ai_user', [ident(ai.identity),ident(human.identity),'Agent',{anthropic:[]},'fixture',none,none,none,none,none]);
    await human.db.call('create_conversation', [none,[ident(ai.identity)],none]);
    const conversation = Number((await human.db.sql<{id:number}>('SELECT id FROM conversation'))[0].id);
    const ctx = { transport: ai.db, aiUserId:1n, conversationId: BigInt(conversation) };
    const input = { conversation_id:conversation, recipient:'Human', request_key:'branch-choice', question:'Which branch should I use?' };
    if (upgradeFrom) {
      assert.equal(JSON.parse(await requestHumanInputTool.execute(ctx,input)).ok,true);
      const planned = await fetch(`${url}/pre_publish`,{method:'POST',headers:{Authorization:`Bearer ${owner.token}`},body:wasm});
      assert(planned.ok,await planned.clone().text());
      const plan = (await planned.json()).AutoMigrate;
      assert(plan,'upgrade must preserve data through automatic migration');
      const suffix = plan.break_clients ? `?policy=BreakClients&token=${encodeURIComponent(plan.token)}` : '';
      const updated = await fetch(url+suffix,{method:'PUT',headers:{Authorization:`Bearer ${owner.token}`},body:wasm});
      assert(updated.ok,await updated.text());
      assert.equal((await human.db.sql('SELECT * FROM human_input_request')).length,1,'upgrade preserves the pending request');
      console.log('PASS: in-place upgrade preserves an unanswered request and its conversation');
    }
    const humanLive = await subscribeRequests(human);
    const aiLive = await subscribeRequests(ai);
    const otherLive = await subscribeRequests(other);
    const first = JSON.parse(await requestHumanInputTool.execute(ctx, input));
    assert.equal(first.ok,true,JSON.stringify(first));
    assert.equal(JSON.parse(await requestHumanInputTool.execute(ctx, input)).ok,true);
    const requests = await human.db.sql<{id:number}>('SELECT * FROM human_input_request');
    assert.equal(requests.length,1,'retry must not duplicate request');
    await waitFor(() => humanLive.db.human_input_request.count() === 1n && aiLive.db.human_input_request.count() === 1n, 'request insertion reaches recipient and requester');
    assert.equal(otherLive.db.human_input_request.count(), 0n, 'unrelated human receives no request');
    assert.equal((await human.db.sql('SELECT * FROM conversation_message')).length,1,'retry must not duplicate question message');
    assert.equal((await other.db.sql('SELECT * FROM human_input_request')).length,0,'other human cannot read request');
    const changed = JSON.parse(await requestHumanInputTool.execute(ctx,{...input,question:'Changed question'}));
    assert.equal(changed.ok,false,'same key cannot change content');
    await assert.rejects(other.db.call('answer_human_input',[requests[0].id,'Forged reply']));
    await assert.rejects(ai.db.call('answer_human_input',[requests[0].id,'Self approval']));
    await human.db.call('answer_human_input',[requests[0].id,'Use the feature branch']);
    await waitFor(() => [...aiLive.db.human_input_request.iter()][0]?.answer === 'Use the feature branch' && aiLive.db.conversation_message.count() === 2n, 'answer and addressed chat message reach the agent subscription');
    assert.equal(otherLive.db.human_input_request.count(), 0n, 'answer remains private in live subscriptions');
    await assert.rejects(human.db.call('answer_human_input',[requests[0].id,'Double tap']));
    const messages = await ai.db.sql<{content:string;mentions:unknown}>('SELECT content, mentions FROM conversation_message');
    assert.equal(messages.length,2);
    assert.equal(messages[1].content,'Use the feature branch');
    assert(JSON.stringify(messages[1].mentions).includes(ai.identity),'answer must address the agent so its worker wakes');
    const second = JSON.parse(await requestHumanInputTool.execute(ctx,{...input,request_key:'another'})); assert(second.ok);
    await waitFor(() => humanLive.db.human_input_request.count() === 2n && aiLive.db.human_input_request.count() === 2n, 'new request after initial snapshot reaches both participants');
    const all = await human.db.sql<{id:number}>('SELECT id FROM human_input_request');
    // Exercise the real module rows consumed by lifecycle's mobile inbox.
    const device = await actor();
    await human.db.call('pair_bridge_device',['Test desktop','a'.repeat(64),'macos','test',ident(device.identity),'fixture-encrypted',['/tmp']]);
    const deviceId = Number((await publisher.sql<{id:number}>('SELECT id FROM bridge_device'))[0].id);
    await human.db.call('grant_bridge_device',[deviceId,ident(ai.identity)]);
    await device.db.call('open_bridge_session',['a'.repeat(64),'b'.repeat(64),(Date.now()+3600000)*1000,'test']);
    await ai.db.call('enqueue_bridge_harness',[deviceId,'claude','{}',conversation,none,none,'test-harness']);
    const commandId = Number((await publisher.sql<{id:number}>('SELECT id FROM bridge_command'))[0].id);
    const options = JSON.stringify([{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]);
    const args = [commandId,'permission-1',none,{some:'Read local file'},none,options,none];
    await assert.rejects(ai.db.call('record_bridge_approval_request',args));
    await device.db.call('record_bridge_approval_request',args);
    await device.db.call('record_bridge_approval_request',args);
    const approvals = await human.db.sql<{id:number}>('SELECT id FROM bridge_approval');
    assert.equal(approvals.length,1);
    assert.equal((await other.db.sql('SELECT id FROM bridge_approval')).length,0);
    await ai.db.call('enqueue_bridge_command',[deviceId,'git push',none,conversation,none,none,'test-command']);
    const commands = await publisher.sql<{id:number}>('SELECT id FROM bridge_command');
    await device.db.call('await_bridge_command_confirmation',[commands[1].id]);
    // Optional cloud-side contract check. The core test runs without pear-cloud.
    const lifecycleManifest = process.env.PEAR_CLOUD_LIFECYCLE_MANIFEST;
    if (lifecycleManifest) {
      const fixture = `/tmp/pear-mobile-fixture-${Date.now()}.json`;
      await writeFile(fixture,JSON.stringify({base,module:name,human:human.token,other:other.token,identity:human.identity,admin:owner.token}),{mode:0o600});
      try {
        const result = await promisify(execFile)('cargo',['test','--manifest-path',lifecycleManifest,'--lib','--offline','mobile::tests::live_mobile_inbox','--','--ignored','--nocapture'],{env:{...process.env,DEVELOPER_DIR:'/Library/Developer/CommandLineTools',PEAR_MOBILE_TEST_FIXTURE:fixture},maxBuffer:1024*1024});
        console.log(result.stdout);
      } finally { await rm(fixture); }
    }
    await assert.rejects(other.db.call('resolve_bridge_approval',[approvals[0].id,'allow']));
    await human.db.call('resolve_bridge_approval',[approvals[0].id,'deny']);
    await assert.rejects(human.db.call('resolve_bridge_approval',[approvals[0].id,'allow']));
    await device.db.call('record_bridge_approval_request',[commandId,'permission-2',none,none,none,options,none]);
    const pendingApprovals = await human.db.sql<{id:number}>('SELECT id FROM bridge_approval');
    await device.db.call('expire_bridge_approval',[pendingApprovals[1].id]);
    await assert.rejects(human.db.call('resolve_bridge_approval',[pendingApprovals[1].id,'allow']));
    await human.db.call('close_conversation',[conversation]);
    await assert.rejects(human.db.call('answer_human_input',[all[1].id,'Too late']));
    await human.db.call('remove_conversation_participant',[conversation,ident(ai.identity)]);
    await waitFor(() => aiLive.db.human_input_request.count() === 0n && aiLive.db.conversation_message.count() === 0n, 'removing the requester revokes live request and message visibility');
    assert.equal((await ai.db.sql('SELECT * FROM human_input_request')).length,0);
    assert.equal(humanLive.db.human_input_request.count(),2n,'recipient retains its requests');
    console.log('PASS: live request/answer/chat delivery and membership revocation; duplicate, forged, closed-conversation and expired approval responses rejected.');
  } finally {
    for (const connection of subscriptions) connection.disconnect();
    await Promise.all(sockets.map(socket => new Promise<void>(resolve => { if (socket.readyState === WebSocket.CLOSED) { resolve(); return; } socket.addEventListener("close", () => resolve(), { once:true }); socket.close(); setTimeout(resolve,1000); })));
    await new Promise(resolve => setTimeout(resolve,500));
    await fetch(url,{method:'DELETE',headers:{Authorization:`Bearer ${owner.token}`}}).catch(() => {});
  }
}
void main().catch(error => { console.error(error); process.exitCode=1; });
