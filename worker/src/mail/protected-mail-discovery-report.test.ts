import assert from "node:assert/strict";
import test from "node:test";
import { completeProtectedMailDiscovery, finishProtectedMailDiscoveryDispatch } from "./protected-mail-discovery-report.js";
import type { ProtectedMailDiscoveryOutcome } from "./protected-mail-discovery-types.js";

const id = "a".repeat(64), nonce = "b".repeat(64), marker = "DISCOVERY_PRIVATE_SYNTHETIC_REPORT_ERROR";
const observation = () => ({ uidValidity: "7", uidNext: 12, presentUids: [2, 4, 9] });
const receipt = (): unknown[] => [id, "c".repeat(64), "mail-discovery-head:" + "d".repeat(64), 1];
const options = (fetchImpl: typeof fetch) => ({ baseUrl: "http://127.0.0.1:32109", dbName: "synthetic-discovery-workspace", token: "synthetic-bearer", fetchImpl });
const unknown = (value: unknown) => { assert.deepEqual(value, { kind: "unknown", reason: "procedure_outcome_unknown" }); assert.ok(!JSON.stringify(value).includes(marker)); };

test("complete sends a copied strict declaration once and returns authoritative receipt metadata only", async () => {
  let calls = 0, release!: () => void, serialized = "";
  const gate = new Promise<void>(resolve => { release = resolve; });
  const configured = options(async (input, init) => {
    calls++; assert.equal(String(input), "http://127.0.0.1:32109/v1/database/synthetic-discovery-workspace/call/complete_protected_mail_discovery");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store"); assert.equal(init?.referrerPolicy, "no-referrer"); serialized = String(init?.body);
    await gate; return Response.json([0, receipt()]);
  });
  const proposed = observation(), pending = completeProtectedMailDiscovery(configured, id, nonce, proposed);
  proposed.uidNext = 999; proposed.presentUids.push(500); configured.token = marker; configured.dbName = "changed"; release();
  const result = await pending; assert.equal(calls, 1); assert.equal(serialized, JSON.stringify([id, nonce, ["7", 12, [2, 4, 9]]]));
  assert.deepEqual(result, { kind: "ok", value: { discoveryId: id, observationDigest: "c".repeat(64), headId: "mail-discovery-head:" + "d".repeat(64), headGeneration: "1" } });
  assert.ok(result.kind === "ok" && Object.isFrozen(result.value) && !("uidNext" in result.value) && !("presentUids" in result.value));
});

test("complete rejects authority-like observation fields, getters and invalid order before network", async () => {
  let calls = 0, invoked = false; const configured = options(async () => { calls++; return Response.json([0, receipt()]); });
  const getter = Object.defineProperty(observation(), "uidNext", { enumerable: true, get() { invoked = true; throw Error(marker); } });
  for (const value of [getter, { ...observation(), absentUids: [3] }, { ...observation(), approved: true },
    { ...observation(), presentUids: [2, 2] }, { ...observation(), presentUids: [9, 4] }, { ...observation(), presentUids: [12] }])
    assert.deepEqual(await completeProtectedMailDiscovery(configured, id, nonce, value), { kind: "denied", reason: "invalid_request" });
  assert.equal(calls, 0); assert.equal(invoked, false);
});

test("complete rejects malformed/substituted receipt or raw observation and whitelists only discovery errors", async () => {
  for (const mutate of [(v: unknown[]) => { v[0] = "0".repeat(64); }, (v: unknown[]) => { v[1] = marker; },
    (v: unknown[]) => { v[2] = "mail-connector-cursor:" + "d".repeat(64); }, (v: unknown[]) => { v[3] = 9007199254740992; },
    (v: unknown[]) => { v[3] = "1"; }, (v: unknown[]) => { v[3] = 0; }, (v: unknown[]) => { v.push(observation()); }]) {
    const value = receipt(); mutate(value); unknown(await completeProtectedMailDiscovery(options(async () => Response.json([0, value])), id, nonce, observation()));
  }
  for (const value of [[0, observation()], [0, receipt(), marker], [1, marker], [1, "protected_mail_read_stale"]])
    unknown(await completeProtectedMailDiscovery(options(async () => Response.json(value)), id, nonce, observation()));
  for (const suffix of ["invalid_request", "inconsistent", "owner_required", "service_required", "event_conflict", "stale", "consumed", "limit_exceeded"]) {
    const reason = `protected_mail_discovery_${suffix}`;
    assert.deepEqual(await completeProtectedMailDiscovery(options(async () => Response.json([1, reason])), id, nonce, observation()), { kind: "denied", reason });
  }
});

test("lost complete reply stays unknown without local metadata, finish fallback or automatic resend", async () => {
  let calls = 0, consumed = false;
  const fetchImpl: typeof fetch = async () => { calls++; if (!consumed) { consumed = true; throw Error(marker); } return Response.json([0, receipt()]); };
  unknown(await completeProtectedMailDiscovery(options(fetchImpl), id, nonce, observation())); assert.equal(calls, 1); assert.equal(consumed, true);
  assert.equal((await completeProtectedMailDiscovery(options(fetchImpl), id, nonce, observation())).kind, "ok"); assert.equal(calls, 2);
});

test("complete bounds streamed bytes, invalid UTF8 and deadlines without returning diagnostics", async () => {
  for (const response of [new Response(" ".repeat(4097), { headers: { "content-type": "application/json", "content-length": "1" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }), new Response(marker, { status: 500 }),
    new Response("{}", { headers: { "content-type": "text/html" } })]) unknown(await completeProtectedMailDiscovery(options(async () => response), id, nonce, observation()));
  let calls = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  unknown(await completeProtectedMailDiscovery({ ...options(async () => { calls++; return new Response(stream, { headers: { "content-type": "application/json" } }); }), timeoutMs: 10 }, id, nonce, observation()));
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test("finish emits only the three fixed safety outcomes and bounded void acknowledgement", async () => {
  for (const [tag, outcome] of (["Failed", "Unknown", "CancelledBeforeDispatch"] as const).entries()) {
    let calls = 0;
    const result = await finishProtectedMailDiscoveryDispatch(options(async (input, init) => {
      calls++; assert.equal(String(input), "http://127.0.0.1:32109/v1/database/synthetic-discovery-workspace/call/finish_protected_mail_discovery_dispatch");
      assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
      assert.equal(init?.body, JSON.stringify([id, [tag, []], nonce])); return new Response(null, { status: 200 });
    }), id, outcome, nonce);
    assert.deepEqual(result, { kind: "recorded", eventNonce: nonce, outcome }); assert.equal(calls, 1);
  }
  let calls = 0;
  const result = await finishProtectedMailDiscoveryDispatch(options(async () => { calls++; throw Error(marker); }), id, "Failed", nonce);
  assert.deepEqual(result, { kind: "unknown", eventNonce: nonce, outcome: "Failed" }); assert.equal(calls, 1);
});

test("finish bounds/cancels streams and invalid inputs cannot echo model-chosen outcome or nonce", async () => {
  for (const response of [new Response(marker, { status: 500 }), new Response(" ".repeat(4097), { headers: { "content-length": "1" } }),
    new Response(null, { headers: { "content-length": "999999999999999999999999" } })])
    assert.deepEqual(await finishProtectedMailDiscoveryDispatch(options(async () => response), id, "Unknown", nonce), { kind: "unknown", eventNonce: nonce, outcome: "Unknown" });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  assert.deepEqual(await finishProtectedMailDiscoveryDispatch({ ...options(async () => new Response(stream)), timeoutMs: 10 }, id, "Failed", nonce), { kind: "unknown", eventNonce: nonce, outcome: "Failed" });
  assert.equal(cancelled, true);
  let calls = 0;
  for (const args of [[marker, "Unknown", nonce], [id, marker, nonce], [id, "Observed", nonce], [id, "Unknown", marker]])
    assert.deepEqual(await finishProtectedMailDiscoveryDispatch(options(async () => { calls++; return new Response(null); }), args[0], args[1] as ProtectedMailDiscoveryOutcome, args[2]), { kind: "unknown", eventNonce: "", outcome: "Unknown" });
  assert.equal(calls, 0);
});

test("report host configuration is exact and unsafe routes never send credentials", async () => {
  let calls = 0; const configured = options(async () => { calls++; return Response.json([0, receipt()]); });
  for (const patch of [{ baseUrl: "http://mail.example.test" }, { baseUrl: configured.baseUrl + "?" }, { baseUrl: configured.baseUrl + "/path" },
    { baseUrl: "https://user:pass@example.test" }, { token: "unsafe\ncredential" }, { dbName: "../other" }, { timeoutMs: 0 }, { timeoutMs: 60001 }]) {
    assert.deepEqual(await completeProtectedMailDiscovery({ ...configured, ...patch }, id, nonce, observation()), { kind: "denied", reason: "invalid_request" });
    assert.deepEqual(await finishProtectedMailDiscoveryDispatch({ ...configured, ...patch }, id, "Unknown", nonce), { kind: "unknown", eventNonce: nonce, outcome: "Unknown" });
  }
  assert.equal(calls, 0);
});
