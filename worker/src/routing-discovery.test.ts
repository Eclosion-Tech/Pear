import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverExecutionProfiles, type BillingObservation } from "./routing-discovery.js";
import { eligibleProfiles } from "./routing.js";

const hex = (value: string) => ({ toHexString: () => value });
function fixture() {
  const config = { id: 1n, identity: hex("owner"), createdBy: hex("human"), provider: { tag: "Anthropic" as const },
    model: "configured-model", endpoint: undefined, apiKey: "SECRET", systemPrompt: undefined, maxTokens: 8192,
    inferenceBackendJson: JSON.stringify({ mode: "bridge", device_id: 1, provider: "claude-code" }) as string | undefined };
  const grants = [{ deviceId: 1n, aiUserIdentity: hex("owner") }];
  const devices = [{ id: 1n, connected: true, revokedAt: undefined as unknown }];
  const capabilities = [{ deviceId: 1n, provider: "claude-code", available: true, version: "1",
    detectedAt: { microsSinceUnixEpoch: 9_500_000n } as { microsSinceUnixEpoch: bigint } | undefined }];
  const db = { ai_user_config: { id: { find: (id: bigint) => id === 1n ? config : undefined } },
    bridge_device_grant: { iter: () => grants }, bridge_device_summary: { iter: () => devices },
    bridge_device_capability: { iter: () => capabilities } };
  return { conn: { db }, config, grants, devices, capabilities };
}
const options = { principalId: "owner", aiUserId: 1n, nowMs: 10_000, maxObservationAgeMs: 1_000 };
function observation(f: ReturnType<typeof fixture>): BillingObservation {
  const p = discoverExecutionProfiles(f.conn, options).profiles[0];
  return { profileId: p.id, principalId: "owner", aiUserId: "1",
    configurationFingerprint: p.configurationFingerprint!, billing: "subscription", observedAtMs: 9_800 };
}

test("discovers real bridge references without treating dormant cloud keys as candidates", () => {
  const f = fixture();
  const result = discoverExecutionProfiles(f.conn, options);
  assert.deepEqual(result.profiles.map(p => p.id), ["bridge_1_claude-code"]);
  const p = result.profiles[0];
  assert.equal(p.billing, "unknown"); assert.equal(p.billingVerified, false);
  assert.equal(p.observedAtMs, 9_500); assert.equal(p.availability, "available");
  assert.deepEqual(p.taskProfiles, ["chat"]); assert.deepEqual(p.capabilities, ["llm"]);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal(p.configurationFingerprint?.length, 64);
});

test("source needs matching AI user and authenticated principal even when tables are visible", () => {
  const f = fixture();
  for (const o of [{ ...options, aiUserId: 2n }, { ...options, principalId: "other" }]) {
    assert.equal(discoverExecutionProfiles(f.conn, o).profiles.length, 0);
  }
});

test("missing grant tables never expose workspace-wide devices", () => {
  const f = fixture();
  const conn = { db: { ai_user_config: f.conn.db.ai_user_config,
    bridge_device_summary: f.conn.db.bridge_device_summary, bridge_device_capability: f.conn.db.bridge_device_capability } };
  const result = discoverExecutionProfiles(conn, options);
  assert.equal(result.profiles.length, 0);
  assert.ok(result.warnings.includes("bridge_discovery_tables_unavailable"));
});

test("cross-user grants, ungranted devices and revoked devices are excluded", () => {
  const f = fixture();
  f.grants[0].aiUserIdentity = hex("another-ai");
  assert.equal(discoverExecutionProfiles(f.conn, options).profiles.length, 0);
  f.grants[0].aiUserIdentity = hex("owner"); f.devices[0].revokedAt = { microsSinceUnixEpoch: 1n };
  assert.equal(discoverExecutionProfiles(f.conn, options).profiles.length, 0);
});

test("availability tracks connected/provider state, not an API-key existence heuristic", () => {
  const f = fixture();
  f.devices[0].connected = false;
  assert.equal(discoverExecutionProfiles(f.conn, options).profiles[0].availability, "offline");
  f.devices[0].connected = true; f.capabilities[0].available = false;
  assert.equal(discoverExecutionProfiles(f.conn, options).profiles[0].availability, "offline");
});

test("harness mode does not infer ACP readiness or permissions from CLI installation", () => {
  const f = fixture();
  f.config.inferenceBackendJson = JSON.stringify({ mode: "harness", device_id: 1, provider: "claude-code", cwd: "/repo" });
  const result = discoverExecutionProfiles(f.conn, options);
  assert.equal(result.profiles[0].availability, "unknown");
  assert.deepEqual(result.profiles[0].capabilities, []);
  assert.deepEqual(result.profiles[0].taskProfiles, []);
  assert.ok(result.warnings.includes("harness_readiness_unverified"));
});

test("dedicated review advertisement is distinct from unrestricted CLI inference", () => {
  const f = fixture();
  f.capabilities.push({ ...f.capabilities[0], provider: "claude-review" });
  const review = discoverExecutionProfiles(f.conn, options).profiles.find(p => p.id.endsWith("claude-review"))!;
  assert.deepEqual(review.capabilities, ["review"]);
  assert.deepEqual(review.taskProfiles, ["packet-review"]);
  assert.equal(review.backend, "claude-code");
});

test("unknown or duplicate provider reports do not become valid candidates", () => {
  const f = fixture();
  f.capabilities.push({ ...f.capabilities[0] }, { ...f.capabilities[0], provider: "arbitrary-shell" });
  assert.equal(discoverExecutionProfiles(f.conn, options).profiles.length, 0);
});

test("missing source timestamp remains unknown; reading again does not refresh it", () => {
  const f = fixture(); f.capabilities[0].detectedAt = undefined;
  const p = discoverExecutionProfiles(f.conn, options).profiles[0];
  assert.ok(Number.isNaN(p.observedAtMs));
  const later = discoverExecutionProfiles(f.conn, { ...options, nowMs: 20_000 }).profiles[0];
  assert.ok(Number.isNaN(later.observedAtMs));
});

test("fresh, identity/binding-specific trusted observation permits subscription eligibility", () => {
  const f = fixture();
  const p = discoverExecutionProfiles(f.conn, { ...options, billingObservations: [observation(f)] }).profiles[0];
  assert.equal(p.billing, "subscription"); assert.equal(p.billingVerified, true);
  assert.equal(p.observedAtMs, 9_500); // never refresh provider report to billing probe time
  const task = { id: "plan-1", principalId: "owner", aiUserId: "1", contextFingerprint: "context",
    summary: "work", artifacts: { repo: false, diff: false, logs: false }, taskProfile: "chat", requiredCapabilities: ["llm"] };
  const policy = { version: "v1", approvedProfileIds: [p.id], allowedWorkerDestinations: [p.destination],
    allowedBilling: ["subscription"] as const, nowMs: 10_000, maxObservationAgeMs: 1_000 };
  assert.equal(eligibleProfiles(task, policy, [p]).eligible.length, 1);
});

for (const change of [
  { principalId: "other" }, { aiUserId: "other" }, { configurationFingerprint: "wrong" },
  { observedAtMs: 8_000 }, { observedAtMs: 10_001 }, { observedAtMs: NaN },
]) {
  test(`mismatched/stale billing observation cannot authorize a profile: ${JSON.stringify(change)}`, () => {
    const f = fixture(); const o = { ...observation(f), ...change };
    assert.equal(discoverExecutionProfiles(f.conn, { ...options, billingObservations: [o] }).profiles[0].billingVerified, false);
  });
}

test("ambiguous billing observations fail closed and a binding/model change invalidates old observations", () => {
  const f = fixture(); const o = observation(f);
  assert.equal(discoverExecutionProfiles(f.conn, { ...options, billingObservations: [o, o] }).profiles[0].billingVerified, false);
  f.config.inferenceBackendJson = JSON.stringify({ mode: "bridge", device_id: 1, provider: "claude-code", model: "different" });
  assert.equal(discoverExecutionProfiles(f.conn, { ...options, billingObservations: [o] }).profiles[0].billingVerified, false);
});

test("configured fallback model changes invalidate the active binding billing observation", () => {
  const f = fixture(); const o = observation(f);
  f.config.model = "new-configured-model";
  assert.equal(discoverExecutionProfiles(f.conn, { ...options, billingObservations: [o] }).profiles[0].billingVerified, false);
});

test("active direct configs are references only; no invented health or billing information", () => {
  const f = fixture(); f.config.inferenceBackendJson = undefined; f.grants.length = 0;
  const result = discoverExecutionProfiles(f.conn, options);
  assert.equal(result.profiles[0].id, "configured_1");
  assert.equal(result.profiles[0].backend, "api");
  assert.equal(result.profiles[0].billingVerified, false);
  assert.equal(result.profiles[0].availability, "unknown");
  assert.ok(Number.isNaN(result.profiles[0].observedAtMs));
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});

test("broken/nonintegral active bindings never activate a dormant API candidate", () => {
  const f = fixture();
  for (const raw of ["broken JSON", JSON.stringify({ mode: "bridge", device_id: 1.5, provider: "claude-code" })]) {
    f.config.inferenceBackendJson = raw;
    const result = discoverExecutionProfiles(f.conn, options);
    assert.equal(result.profiles.some(p => p.backend === "api"), false);
    assert.ok(result.warnings.includes("invalid_active_binding"));
  }
});
