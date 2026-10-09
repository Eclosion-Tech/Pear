import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseWorker } from "./database-worker.js";
import { observeOrchaPlan, type OrchaAdvisoryHook, type OrchaAdviceReport,
  type OrchaAdvisoryPreparation } from "./orcha-routing.js";
import type { SystemOneRequest } from "./routing.js";
import type { TaskSpec } from "./llm.js";
import type { ResolvedProvider } from "./providers.js";

function fixture() {
  const identity = { toHexString: () => "owner" };
  const capabilities = [{ deviceId: 1n, provider: "claude-code", available: true, version: "1",
    detectedAt: { microsSinceUnixEpoch: 9_500_000n } }];
  const conn = { db: {
    ai_user_config: { id: { find: () => ({ id: 1n, identity, provider: { tag: "Anthropic" }, model: "mock",
      apiKey: "SECRET", inferenceBackendJson: '{"mode":"bridge","device_id":1,"provider":"claude-code"}' }) } },
    bridge_device_grant: { iter: () => [{ deviceId: 1n, aiUserIdentity: identity }] },
    bridge_device_summary: { iter: () => [{ id: 1n, connected: true }] },
    bridge_device_capability: { iter: () => capabilities },
  } };
  return { conn, capabilities, identity };
}
const spec: TaskSpec = { description: "Work with private page context", task_type: "llm",
  depends_on: [], required_capabilities: ["llm"] };
function context(f: ReturnType<typeof fixture>) {
  return { jobId: "job-1", orchestrateTaskId: "task-1", principalId: "owner", aiUserId: 1n,
    connection: f.conn, nowMs: 10_000 };
}
function response(r: SystemOneRequest) {
  return { model: "mock-revision", answers: Object.fromEntries(Object.entries(r.questions).map(([k, q]) => {
    const choice = Object.keys(q.criteria)[0];
    return [k, { type: "choice", choice, probabilities: Object.fromEntries(Object.keys(q.criteria).map(c => [c, Number(c === choice)])) }];
  })) };
}
function hook(onAdvice: (r: OrchaAdviceReport) => void = () => {}, onCall: () => void = () => {}): OrchaAdvisoryHook {
  return { onAdvice, prepare(c: OrchaAdvisoryPreparation) {
    const p = c.profiles[0];
    return { summary: "Approved bounded summary", artifacts: { repo: false, diff: false, logs: false },
      taskProfile: "chat", requiredCapabilities: ["llm"],
      policy: { version: "v1", approvedProfileIds: [p.id], allowedWorkerDestinations: [p.destination],
        allowedBilling: ["subscription"], maxObservationAgeMs: 60_000 },
      billingObservations: [{ profileId: p.id, principalId: c.principalId, aiUserId: c.aiUserId,
        configurationFingerprint: p.configurationFingerprint!, billing: "subscription", observedAtMs: p.observedAtMs }],
      advisor: { client: { async decide(r) {
        onCall(); const serialized = JSON.stringify(r);
        assert.equal(serialized.includes("private page context"), false);
        assert.equal(serialized.includes("SECRET"), false);
        return response(r);
      } }, destination: "mock-local", hosted: false,
      consent: { enabled: true, allowedDestinations: ["mock-local"], allowHostedSpend: false },
      timeoutMs: 100, maxRequestBytes: 20_000 } };
  } };
}

test("no hook means no discovery, no callback, no model call", async () => {
  const f = fixture();
  const c = context(f);
  const hostile = { ...c, connection: { get db(): object { throw new Error("must not read"); } } };
  assert.deepEqual(await observeOrchaPlan(hostile, [spec]), []);
});

test("unapproved context does not call classifier or report", async () => {
  const f = fixture(); let reports = 0;
  assert.deepEqual(await observeOrchaPlan(context(f), [spec], {
    prepare: () => undefined, onAdvice: () => { reports++; },
  }), []);
  assert.equal(reports, 0);
});

test("advisory uses live scoped discovery, approved summary and an immutable plan snapshot", async () => {
  const f = fixture(); const original = JSON.stringify(spec);
  let calls = 0; const received: OrchaAdviceReport[] = [];
  const h = hook(r => { received.push(r); }, () => { calls++; });
  const prepare = h.prepare;
  const reports = await observeOrchaPlan(context(f), [spec], { ...h, prepare(c) {
    assert.ok(Object.isFrozen(c)); assert.ok(Object.isFrozen(c.requiredCapabilities));
    assert.ok(Object.isFrozen(c.profiles[0])); assert.equal(JSON.stringify(c).includes("SECRET"), false);
    return prepare(c);
  } });
  assert.equal(calls, 1); assert.equal(received.length, 1); assert.equal(reports.length, 1);
  assert.equal(reports[0].advice.status, "advised");
  assert.equal(reports[0].specIndex, 0); assert.equal(reports[0].planFingerprint.length, 64);
  assert.equal(JSON.stringify(spec), original);
});

test("unverified billing blocks and emits a diagnostic, never a classifier call", async () => {
  const f = fixture(); let calls = 0; const h = hook(() => {}, () => { calls++; });
  const reports = await observeOrchaPlan(context(f), [spec], { ...h, prepare(c) {
    return { ...h.prepare(c)!, billingObservations: [] };
  } });
  assert.equal(calls, 0); assert.equal(reports[0].advice.status, "blocked");
});

test("model calls are bounded per plan; invalid limits rejected without inference", async () => {
  const f = fixture(); let calls = 0; const h = hook(() => {}, () => { calls++; });
  await observeOrchaPlan(context(f), [spec, spec, spec], h);
  assert.equal(calls, 1);
  await observeOrchaPlan(context(f), [spec, spec, spec], { ...h, maxTasksPerPlan: 2 });
  assert.equal(calls, 3);
  await assert.rejects(observeOrchaPlan(context(f), [spec], { ...h, maxTasksPerPlan: 6 }));
  assert.equal(calls, 3);
});

test("sink failures, synchronous and asynchronous, never retry the classifier", async () => {
  const f = fixture(); let calls = 0;
  for (const onAdvice of [() => { throw new Error("sink failed"); }, async () => { throw new Error("sink failed"); }]) {
    const reports = await observeOrchaPlan(context(f), [spec], hook(onAdvice, () => { calls++; }));
    assert.equal(reports[0].advice.status, "advised");
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
});

test("fresh observer failures/timeouts discard historical evidence and never call classifier", async () => {
  for (const collect of [async () => { throw new Error("SECRET"); }, () => new Promise<never>(() => {})]) {
    const f = fixture(); let calls=0; const h=hook(()=>{},()=>calls++);
    const reports=await observeOrchaPlan(context(f),[spec],{...h,observeBilling:{timeoutMs:20,collect}});
    assert.equal(calls,0);assert.equal(reports[0].advice.status,"blocked");
    assert.equal(JSON.stringify(reports).includes("SECRET"),false);
  }
});

function workerFixture(advisory?: OrchaAdvisoryHook, emptyPlan = false) {
  const f = fixture();
  f.capabilities[0].detectedAt = { microsSinceUnixEpoch: BigInt(Date.now() - 100) * 1000n };
  const job = { id: 7n, userId: "owner", aiUserId: 1n, prompt: "work", status: "running" };
  const task = { id: 8n, jobId: 7n, description: "Original request", taskType: "orchestrate", status: "claimed",
    dependsOn: [], requiredCapabilities: ["orchestrate"], assignedTo: "test", result: undefined };
  const published: unknown[] = [];
  const conn = { db: { orcha_job: { id: { find: () => job } }, orcha_task: { iter: () => [task] } },
    reducers: { async addTasksToJob(args: { taskGraphJson: string }) { published.push(JSON.parse(args.taskGraphJson)); } } };
  const provider = { provider: { async chat() {
    return { content: emptyPlan ? [] : [{ type: "tool_use", id: "plan", name: "submit_plan", input: { tasks: [spec] } }] };
  } }, model: "mock", maxTokens: 1024, providerTag: "Anthropic" } as unknown as ResolvedProvider;
  const worker = new DatabaseWorker({ uri: "ws://localhost:3000", dbName: "test", agentId: "test", routingAdvisory: advisory }) as unknown as {
    aiUserWorkers: Map<bigint, { identity: typeof f.identity; getConnLike(): typeof f.conn; resolveProvider(): ResolvedProvider }>;
    handleOrchestrate(c: unknown, t: typeof task): Promise<string>;
    observeRoutingForPlan(j: typeof job | undefined, t: typeof task, specs: TaskSpec[]): Promise<void>;
  };
  worker.aiUserWorkers.set(1n, { identity: f.identity, getConnLike: () => f.conn, resolveProvider: () => provider });
  return { worker, conn, task, job, published };
}

test("DatabaseWorker observes before publication without changing the executable graph", async () => {
  let reports = 0;
  const f = workerFixture(hook(() => { reports++; assert.equal(f.published.length, 0); }));
  assert.equal(await f.worker.handleOrchestrate(f.conn, f.task), "Decomposed into 1 task");
  assert.equal(reports, 1); assert.deepEqual(f.published, [[spec]]);
});

test("DatabaseWorker fallback plan is observed without altering the existing fallback behavior", async () => {
  let reports = 0;
  const f = workerFixture(hook(() => { reports++; }), true);
  assert.equal(await f.worker.handleOrchestrate(f.conn, f.task), "Decomposed into 1 task");
  assert.equal(reports, 1);
  assert.deepEqual(f.published, [[{ description: "Original request", task_type: "llm", depends_on: [], required_capabilities: ["llm"] }]]);
});

test("DatabaseWorker swallows advisory configuration errors and publishes the unchanged plan", async () => {
  const warnings: unknown[][] = []; const oldWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const f = workerFixture({ prepare: () => { throw new Error("SECRET configuration failure"); }, onAdvice: () => {} });
    await f.worker.handleOrchestrate(f.conn, f.task);
    assert.deepEqual(f.published, [[spec]]);
    assert.equal(JSON.stringify(warnings).includes("SECRET"), false);
    assert.ok(JSON.stringify(warnings).includes("existing execution unchanged"));
  } finally { console.warn = oldWarn; }
});

test("DatabaseWorker never discovers via admin authority when the AI worker is absent", async () => {
  let prepares = 0;
  const f = workerFixture({ prepare: () => { prepares++; return undefined; }, onAdvice: () => {} });
  f.worker.aiUserWorkers.clear();
  await f.worker.observeRoutingForPlan(f.job, f.task, [spec]);
  await f.worker.observeRoutingForPlan(undefined, f.task, [spec]);
  assert.equal(prepares, 0);
});
