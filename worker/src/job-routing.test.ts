import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseWorker } from "./database-worker.js";
import type { ResolvedProvider } from "./providers.js";
import { executeTool, type ConnLike } from "./tools.js";

type Job = { id: bigint; aiUserId?: bigint; tier?: string };

function workerFor(resolveProvider?: (id: bigint) => ResolvedProvider | undefined) {
  const worker = new DatabaseWorker({
    uri: "ws://localhost:3000", dbName: "test", agentId: "test",
  }) as unknown as {
    aiUserWorkers: Map<bigint, { resolveProvider: typeof resolveProvider }>;
    resolveProviderForJob(job: Job | undefined): ResolvedProvider | undefined;
  };
  if (resolveProvider) worker.aiUserWorkers.set(1n, { resolveProvider });
  return worker;
}

for (const model of ["z-ai/glm-5.3-flash", "z-ai/glm-5.2", "deepseek/deepseek-v4-pro-0813"]) {
  test(`jobs preserve ${model} despite legacy tier overrides`, () => {
    const base = { provider: {}, providerTag: "OpenRouter", model, maxTokens: 8192 } as ResolvedProvider;
    const worker = workerFor((id) => { assert.equal(id, 1n); return base; });
    for (const tier of [undefined, "fast", "balanced", "flagship", "frontier"]) {
      assert.deepEqual(worker.resolveProviderForJob({ id: 58n, aiUserId: 1n, tier }), base);
    }
  });
}

test("jobs use the current configured transport and model, including device bindings", () => {
  let base = { provider: {}, providerTag: "Anthropic", model: "device-model", maxTokens: 1024 } as ResolvedProvider;
  const worker = workerFor(() => base);
  assert.deepEqual(worker.resolveProviderForJob({ id: 1n, aiUserId: 1n, tier: "balanced" }), base);
  base = { ...base, provider: {} as ResolvedProvider["provider"], model: "updated-model" };
  assert.deepEqual(worker.resolveProviderForJob({ id: 2n, aiUserId: 1n }), base);
});

test("an unavailable AI worker or provider cannot fall back to environment credentials", () => {
  for (const worker of [workerFor(), workerFor(() => undefined)]) {
    assert.throws(() => worker.resolveProviderForJob({ id: 58n, aiUserId: 1n }), /AI user 1.*inference/i);
  }
});

test("a missing job cannot fall back to environment credentials", () => {
  assert.throws(() => workerFor().resolveProviderForJob(undefined), /job/i);
});

test("human jobs without an AI assignment retain the environment provider", () => {
  assert.equal(workerFor().resolveProviderForJob({ id: 1n }), undefined);
});

test("delegation keeps AI attribution and drops legacy model-tier input", async () => {
  const jobs: Record<string, unknown>[] = [];
  const conn = {
    db: { orcha_job: { iter: () => jobs } },
    reducers: { createJob: async (args: Record<string, unknown>) => { jobs.push({ ...args, id: 7n }); } },
  } as unknown as ConnLike;
  const result = JSON.parse(await executeTool(conn, "delegate", {
    description: "Prepare a summary", tier: "balanced",
  }, 5n, { aiUserId: 1n, aiIdentityHex: "test-identity", currentPageId: 319n }));
  assert.equal(result.ok, true);
  assert.equal(jobs[0].aiUserId, 1n);
  assert.equal(jobs[0].parentJobId, 5n);
  assert.equal(jobs[0].tier, undefined);
});
