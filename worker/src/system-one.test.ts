import { test } from "node:test";
import assert from "node:assert/strict";
import { createJevAdvisor, createNimbleAdvisor, type SystemOneHttpConfig } from "./system-one.js";
import type { SystemOneRequest } from "./routing.js";

const request: SystemOneRequest = { state: { summary: "Review this" }, questions: {
  answer: { type: "choice", instructions: "Choose", criteria: { yes: "Yes", no: "No" } },
} };
const endpoint = "https://classifier.example.test/v1/systemone";
function config(overrides: Partial<SystemOneHttpConfig> = {}): SystemOneHttpConfig {
  return { endpoint, model: "pinned-model", consent: { enabled: true, allowedDestinations: [endpoint], allowHostedSpend: true },
    timeoutMs: 1_000, maxRequestBytes: 10_000, maxResponseBytes: 10_000, maxCalls: 1, ...overrides };
}
function fakeFetch(fn: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: unknown, init: RequestInit) => Promise.resolve(fn(String(url), init))) as typeof fetch;
}
const signal = () => new AbortController().signal;

test("Jev posts the typed contract exactly once with explicit key/model and no redirects", async () => {
  let calls = 0;
  const advisor = createJevAdvisor({ ...config({ fetchImpl: fakeFetch((url, init) => {
    calls++; assert.equal(url, endpoint); assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fake-secret");
    assert.deepEqual(JSON.parse(String(init.body)), { model: "pinned-model", ...request });
    return new Response(JSON.stringify({ model: "revision-1", answers: {} }));
  }) }), apiKey: "fake-secret" });
  assert.equal(advisor.destination, endpoint); assert.equal(advisor.hosted, true);
  assert.deepEqual(await advisor.client.decide(request, signal()), { model: "revision-1", answers: {} });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(advisor).includes("fake-secret"), false);
});

test("Nimble supports explicit loopback HTTP with no inherited Authorization", async () => {
  const url = "http://127.0.0.1:11435/v1/systemone";
  const advisor = createNimbleAdvisor(config({ endpoint: url, allowInsecureLoopback: true,
    consent: { enabled: true, allowedDestinations: [url], allowHostedSpend: false },
    fetchImpl: fakeFetch((_u, init) => {
      assert.equal(new Headers(init.headers).has("authorization"), false);
      assert.equal(JSON.parse(String(init.body)).model, "pinned-model");
      return new Response("{}");
    }) }));
  assert.equal(advisor.hosted, false);
  await advisor.client.decide(request, signal());
});

for (const bad of ["http://classifier.example.test/v1/systemone", "file:///secret", "https://user:pass@x.test/s",
  "https://x.test/s?key=secret", "https://x.test/s#fragment"]) {
  test(`Jev rejects insecure/credential-bearing endpoint: ${bad}`, () => {
    assert.throws(() => createJevAdvisor({ ...config({ endpoint: bad }), apiKey: "fake-key" }));
  });
}

test("loopback HTTP requires approval and is never allowed for keyed Jev", () => {
  const local = config({ endpoint: "http://127.0.0.1:8000/s" });
  assert.throws(() => createNimbleAdvisor(local));
  assert.throws(() => createJevAdvisor({ ...local, allowInsecureLoopback: true, apiKey: "fake" }));
  assert.throws(() => createNimbleAdvisor({ ...local, endpoint: "http://192.168.1.2/s", allowInsecureLoopback: true }));
});

test("missing key, missing model and invalid bounds are rejected at construction", () => {
  assert.throws(() => createJevAdvisor({ ...config(), apiKey: "" }));
  assert.throws(() => createJevAdvisor({ ...config(), apiKey: "bad\nkey" }));
  for (const change of [{ model: "" }, { timeoutMs: 0 }, { maxResponseBytes: Infinity }, { maxRequestBytes: 2_000_000 }]) {
    assert.throws(() => createNimbleAdvisor(config(change)));
  }
});

for (const consent of [
  { enabled: false, allowedDestinations: [endpoint], allowHostedSpend: true },
  { enabled: true, allowedDestinations: [], allowHostedSpend: true },
  { enabled: true, allowedDestinations: [endpoint], allowHostedSpend: false },
]) {
  test(`even direct adapter use enforces consent: ${JSON.stringify(consent)}`, async () => {
    let calls = 0;
    const advisor = createJevAdvisor({ ...config({ consent, fetchImpl: fakeFetch(() => { calls++; return new Response("{}"); }) }), apiKey: "fake" });
    await assert.rejects(advisor.client.decide(request, signal()), /not approved/);
    assert.equal(calls, 0);
  });
}

test("aborted and oversized requests do not reach the transport", async () => {
  let calls = 0;
  const advisor = createNimbleAdvisor(config({ maxRequestBytes: 1,
    fetchImpl: fakeFetch(() => { calls++; return new Response("{}"); }) }));
  await assert.rejects(advisor.client.decide(request, signal()), /too large/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(advisor.client.decide(request, controller.signal));
  assert.equal(calls, 0);
});

for (const status of [302, 401, 404, 500]) {
  test(`HTTP ${status} is not retried and cannot echo secrets in an error`, async () => {
    let calls = 0;
    const advisor = createNimbleAdvisor(config({ fetchImpl: fakeFetch(() => {
      calls++; return new Response("SECRET upstream body", { status, headers: { location: "https://evil.test" } });
    }) }));
    await assert.rejects(advisor.client.decide(request, signal()), err => {
      assert.equal(String(err).includes("SECRET"), false); assert.ok(String(err).includes(String(status))); return true;
    });
    assert.equal(calls, 1);
  });
}

for (const headers of [{}, { "content-length": "1000" }] as Record<string, string>[]) {
  test(`oversized responses rejected with declared or streamed size: ${JSON.stringify(headers)}`, async () => {
    const advisor = createNimbleAdvisor(config({ maxResponseBytes: 2,
      fetchImpl: fakeFetch(() => new Response('{"payload":"large"}', { headers })) }));
    await assert.rejects(advisor.client.decide(request, signal()), /too large/);
  });
}

test("finite adapter attempt budget cannot be bypassed by failed or concurrent requests", async () => {
  let calls = 0;
  const advisor = createNimbleAdvisor(config({ maxCalls: 1,
    fetchImpl: fakeFetch(() => { calls++; return new Response("error", { status: 500 }); }) }));
  const outcomes = await Promise.allSettled([advisor.client.decide(request, signal()), advisor.client.decide(request, signal())]);
  assert.equal(calls, 1);
  assert.ok(outcomes.every(o => o.status === "rejected"));
  await assert.rejects(advisor.client.decide(request, signal()), /budget exhausted/);
  assert.equal(calls, 1);
  const disabled = createNimbleAdvisor(config({ maxCalls: 0,
    fetchImpl: fakeFetch(() => { calls++; return new Response("{}"); }) }));
  await assert.rejects(disabled.client.decide(request, signal()), /budget exhausted/);
  assert.equal(calls, 1);
  assert.throws(() => createNimbleAdvisor(config({ maxCalls: Infinity })));
});

test("malformed JSON and network errors fail without exposing raw transport errors", async () => {
  const invalid = createNimbleAdvisor(config({ fetchImpl: fakeFetch(() => new Response("not json")) }));
  await assert.rejects(invalid.client.decide(request, signal()));
  const failed = createNimbleAdvisor(config({ fetchImpl: fakeFetch(() => { throw new Error("SECRET network message"); }) }));
  await assert.rejects(failed.client.decide(request, signal()), /System One transport failed/);
});
