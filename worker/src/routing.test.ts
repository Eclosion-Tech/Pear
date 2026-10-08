import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eligibleProfiles, recommendRoute, type AdvisorOptions, type ExecutionProfile,
  type RoutingPolicy, type RoutingTask, type SystemOneRequest,
} from "./routing.js";

const task: RoutingTask = {
  id: "task-1", principalId: "owner", aiUserId: "ai-1", contextFingerprint: "context-1",
  summary: "Review the supplied diff", artifacts: { repo: false, diff: true, logs: false },
  requiredCapabilities: ["review"], taskProfile: "packet-review",
};
const policy: RoutingPolicy = {
  version: "policy-1", approvedProfileIds: ["claude", "codex", "api"],
  allowedWorkerDestinations: ["anthropic", "openai"], allowedBilling: ["subscription"],
  nowMs: 10_000, maxObservationAgeMs: 1_000,
};
function profile(overrides: Partial<ExecutionProfile> = {}): ExecutionProfile {
  return { id: "claude", principalId: "owner", aiUserId: "ai-1", backend: "claude-code",
    capabilities: ["review"], taskProfiles: ["packet-review"], destination: "anthropic",
    billing: "subscription", billingVerified: true, grant: "granted", availability: "available",
    observedAtMs: 9_500, ...overrides };
}
function response(request: SystemOneRequest, candidate = "candidate_0") {
  const selections: Record<string, string> = { candidate, work_type: "review",
    readiness: "ready_to_start", complexity: "routine" };
  return { model: "mock-revision-1", answers: Object.fromEntries(Object.entries(request.questions)
    .map(([name, q]) => [name, { type: "choice", choice: selections[name],
      probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, Number(k === selections[name])])) }])) };
}
function advisor(decide = async (r: SystemOneRequest, _s: AbortSignal): Promise<unknown> => response(r)): AdvisorOptions {
  return { client: { decide }, destination: "classifier-local", hosted: false,
    consent: { enabled: true, allowedDestinations: ["classifier-local"], allowHostedSpend: false },
    timeoutMs: 1_000, maxRequestBytes: 20_000 };
}

for (const [reason, override] of [
  ["not_approved", { id: "unapproved" }],
  ["identity_mismatch", { principalId: "another-owner" }],
  ["identity_mismatch", { aiUserId: "another-ai" }],
  ["grant_unavailable", { grant: "revoked" }],
  ["grant_unavailable", { grant: "unknown" }],
  ["not_available", { availability: "offline" }],
  ["not_available", { availability: "busy" }],
  ["not_available", { availability: "unknown" }],
  ["stale_observation", { observedAtMs: 8_999 }],
  ["stale_observation", { observedAtMs: 10_001 }],
  ["stale_observation", { observedAtMs: NaN }],
  ["missing_capability", { capabilities: ["llm"] }],
  ["unsupported_task_profile", { taskProfiles: ["repo-write"] }],
  ["destination_denied", { destination: "unapproved-vendor" }],
  ["billing_denied", { id: "api", backend: "api", billing: "metered_api" }],
  ["billing_denied", { billing: "unknown" }],
  ["billing_unverified", { billingVerified: false }],
  ["billing_mismatch", { backend: "api", billing: "subscription" }],
  ["billing_mismatch", { backend: "ollama", billing: "subscription" }],
] as const) {
  test(`eligibility excludes ${reason}: ${JSON.stringify(override)}`, () => {
    const result = eligibleProfiles(task, policy, [profile(override)]);
    assert.equal(result.eligible.length, 0);
    assert.ok(result.excluded[0].reasons.includes(reason));
  });
}

test("eligibility keeps all matching constraints and does not mutate caller input", () => {
  const p = profile();
  const before = JSON.stringify(p);
  assert.deepEqual(eligibleProfiles(task, policy, [p]).eligible, [p]);
  assert.equal(JSON.stringify(p), before);
  assert.equal(eligibleProfiles(task, policy, [profile({ observedAtMs: 9_000 })]).eligible.length, 1);
});

test("API worker spending requires explicit billing permission independent of classifier consent", async () => {
  const api = profile({ id: "api", backend: "api", billing: "metered_api" });
  let calls = 0;
  const options = advisor(async r => { calls++; return response(r); });
  assert.equal((await recommendRoute(task, policy, [api], options)).status, "blocked");
  assert.equal(calls, 0);
  const allowed = { ...policy, allowedBilling: ["metered_api"] as const };
  assert.equal((await recommendRoute(task, allowed, [api], options)).status, "advised");
});

test("session pin prevents worker switching and an unavailable pinned route blocks", () => {
  const pinned = { ...task, pinnedProfileId: "codex" };
  const codex = profile({ id: "codex", backend: "codex", destination: "openai" });
  const result = eligibleProfiles(pinned, policy, [profile(), codex]);
  assert.deepEqual(result.eligible.map(p => p.id), ["codex"]);
  assert.deepEqual(result.excluded[0].reasons, ["session_pinned"]);
  assert.equal(eligibleProfiles(pinned, policy, [profile(), { ...codex, grant: "revoked" }]).eligible.length, 0);
});

test("duplicate IDs and invalid identity/freshness context fail closed without a classifier call", async () => {
  let calls = 0;
  const options = advisor(async r => { calls++; return response(r); });
  for (const [t, p, catalog] of [
    [task, policy, [profile(), profile()]],
    [{ ...task, principalId: "" }, policy, [profile()]],
    [task, { ...policy, nowMs: NaN }, [profile()]],
    [task, { ...policy, maxObservationAgeMs: -1 }, [profile()]],
    [task, policy, [profile({ id: "__proto__.invalid" })]],
  ] as const) {
    assert.deepEqual(await recommendRoute(t, p, catalog, options), {
      status: "blocked", reason: "invalid_input", excluded: [],
    });
  }
  assert.equal(calls, 0);
});

test("advice is disabled by default; no eligible workers never calls the classifier", async () => {
  assert.deepEqual(await recommendRoute(task, policy, [profile()]), {
    status: "unavailable", reason: "disabled", eligibleProfileIds: ["claude"],
  });
  let calls = 0;
  const options = advisor(async r => { calls++; return response(r); });
  const result = await recommendRoute(task, policy, [profile({ grant: "revoked" })], options);
  assert.equal(result.status, "blocked");
  assert.equal(calls, 0);
});

for (const [reason, modify] of [
  ["disabled", (o: AdvisorOptions) => ({ ...o, consent: { ...o.consent, enabled: false } })],
  ["destination_denied", (o: AdvisorOptions) => ({ ...o, destination: "unapproved-host" })],
  ["hosted_spend_denied", (o: AdvisorOptions) => ({ ...o, hosted: true })],
  ["invalid_options", (o: AdvisorOptions) => ({ ...o, timeoutMs: 0 })],
  ["invalid_options", (o: AdvisorOptions) => ({ ...o, timeoutMs: Infinity })],
  ["invalid_options", (o: AdvisorOptions) => ({ ...o, maxRequestBytes: NaN })],
  ["request_too_large", (o: AdvisorOptions) => ({ ...o, maxRequestBytes: 1 })],
] as const) {
  test(`classifier gate: ${reason}`, async () => {
    let calls = 0;
    const options = modify(advisor(async r => { calls++; return response(r); }));
    const result = await recommendRoute(task, policy, [profile()], options);
    assert.ok(result.status === "unavailable" && result.reason === reason);
    assert.equal(calls, 0);
  });
}

test("hosted classifier consent can coexist with subscription-only worker policy", async () => {
  const o = advisor();
  const result = await recommendRoute(task, policy, [profile()], {
    ...o, hosted: true, consent: { ...o.consent, allowHostedSpend: true },
  });
  assert.equal(result.status, "advised");
});

test("request includes only eligible candidates and approved context, not IDs or extra secrets", async () => {
  const unsafe = { ...profile(), apiKey: "SECRET", cwd: "/private", permissionMode: "bypass" };
  const result = await recommendRoute(task, policy, [unsafe, profile({ id: "api", billing: "metered_api" })],
    advisor(async r => {
      const serialized = JSON.stringify(r);
      for (const forbidden of ["SECRET", "/private", "bypass", "owner", "ai-1", "context-1", "task-1"]) {
        assert.equal(serialized.includes(forbidden), false);
      }
      assert.equal(Object.keys(r.questions.candidate.criteria).length, 2); // one candidate + abstain
      assert.deepEqual((r.state as { artifacts: unknown }).artifacts, task.artifacts);
      assert.ok(Object.isFrozen(r.questions.candidate.criteria));
      return response(r);
    }));
  assert.ok(result.status === "advised");
  assert.equal(result.recommendedProfileId, "claude");
  assert.equal(result.provenance.model, "mock-revision-1");
  assert.deepEqual(result.provenance.candidateProfileIds, ["claude"]);
  assert.equal(result.provenance.requestFingerprint.length, 64);
  assert.deepEqual(result.probabilities.candidate, { candidate_0: 1, abstain: 0 });
  assert.ok(Object.isFrozen(result.probabilities.candidate));
  assert.equal("binding" in result, false);
  assert.equal("permissionMode" in result, false);
});

test("model can abstain; needs clarification is advice, not a blocked execution permission", async () => {
  const result = await recommendRoute(task, policy, [profile()], advisor(async r => {
    const out = response(r, "abstain");
    out.answers.readiness = { type: "choice", choice: "needs_clarification",
      probabilities: { ready_to_start: 0, needs_clarification: 1 } };
    return out;
  }));
  assert.ok(result.status === "advised");
  assert.equal(result.recommendedProfileId, null);
  assert.equal(result.classification.readiness, "needs_clarification");
});

for (const mutation of [
  (o: ReturnType<typeof response>) => { o.answers.candidate.choice = "unapproved-vendor"; },
  (o: ReturnType<typeof response>) => { o.answers.candidate.choice = "candidate_999"; },
  (o: ReturnType<typeof response>) => { delete o.answers.readiness; },
  (o: ReturnType<typeof response>) => { o.answers.candidate.type = "score"; },
  (o: ReturnType<typeof response>) => { o.answers.candidate.probabilities.candidate_0 = NaN; },
  (o: ReturnType<typeof response>) => { o.answers.candidate.probabilities.candidate_0 = Infinity; },
  (o: ReturnType<typeof response>) => { o.answers.candidate.probabilities.candidate_0 = -1; },
  (o: ReturnType<typeof response>) => { o.answers.candidate.probabilities.candidate_0 = 0.3; },
  (o: ReturnType<typeof response>) => { o.answers.candidate.probabilities.injected = 0; },
  (o: ReturnType<typeof response>) => { o.model = ""; },
]) {
  test(`invalid classifier output is unavailable, never executable: ${mutation.toString()}`, async () => {
    const result = await recommendRoute(task, policy, [profile()], advisor(async r => {
      const out = response(r); mutation(out); return out;
    }));
    assert.ok(result.status === "unavailable" && result.reason === "invalid_response");
  });
}

test("classifier errors are sanitized and never retried/fallback", async () => {
  let calls = 0;
  const result = await recommendRoute(task, policy, [profile()], advisor(async () => {
    calls++; throw new Error("credential SECRET upstream failure");
  }));
  assert.ok(result.status === "unavailable" && result.reason === "classifier_error");
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});

test("timeout settles even if adapter ignores abort, and sends an abort signal", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const options = advisor(async (_r, s) => { calls++; signal = s; return new Promise(() => {}); });
  const result = await recommendRoute(task, policy, [profile()], { ...options, timeoutMs: 10 });
  assert.ok(result.status === "unavailable" && result.reason === "timeout");
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});

test("request size limit counts UTF-8 bytes, not just string length", async () => {
  let serialized = "";
  let calls = 0;
  const options = advisor(async r => { calls++; serialized = JSON.stringify(r); return response(r); });
  const unicode = { ...task, summary: "レビューしてください" };
  assert.equal((await recommendRoute(unicode, policy, [profile()], options)).status, "advised");
  assert.ok(Buffer.byteLength(serialized) > serialized.length);
  const result = await recommendRoute(unicode, policy, [profile()], { ...options, maxRequestBytes: serialized.length });
  assert.ok(result.status === "unavailable" && result.reason === "request_too_large");
  assert.equal(calls, 1);
});

test("pre-aborted request does not call adapter", async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const result = await recommendRoute(task, policy, [profile()], {
    ...advisor(async r => { calls++; return response(r); }), signal: controller.signal,
  });
  assert.ok(result.status === "unavailable" && result.reason === "cancelled");
  assert.equal(calls, 0);
});

test("cancellation during request settles even if adapter ignores abort", async () => {
  const controller = new AbortController();
  const options = advisor(async (_r, s) => {
    queueMicrotask(() => controller.abort());
    await new Promise(resolve => s.addEventListener("abort", resolve, { once: true }));
    return new Promise(() => {});
  });
  const result = await recommendRoute(task, policy, [profile()], { ...options, signal: controller.signal });
  assert.ok(result.status === "unavailable" && result.reason === "cancelled");
});

test("request provenance is deterministic and changes with context, policy and catalog", async () => {
  const fingerprint = async (t = task, p = policy, catalog = [profile()]) => {
    const r = await recommendRoute(t, p, catalog, advisor());
    assert.ok(r.status === "advised");
    return r.provenance.requestFingerprint;
  };
  const original = await fingerprint();
  assert.equal(await fingerprint(), original);
  assert.notEqual(await fingerprint({ ...task, contextFingerprint: "new-context" }), original);
  assert.notEqual(await fingerprint(task, { ...policy, version: "policy-2" }), original);
  assert.notEqual(await fingerprint(task, policy, [profile({ observedAtMs: 9_600 })]), original);
});

test("caller mutations while awaiting cannot swap selected profile or provenance", async () => {
  const mutable = { ...profile(), capabilities: ["review"] };
  const mutableTask = { ...task };
  const result = await recommendRoute(mutableTask, policy, [mutable], advisor(async r => {
    mutable.id = "another-profile"; mutable.capabilities.push("write");
    mutableTask.contextFingerprint = "mutated";
    return response(r);
  }));
  assert.ok(result.status === "advised");
  assert.equal(result.recommendedProfileId, "claude");
  assert.equal(result.provenance.contextFingerprint, "context-1");
});
