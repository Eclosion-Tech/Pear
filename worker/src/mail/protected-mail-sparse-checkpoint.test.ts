import { test } from "node:test";
import assert from "node:assert/strict";
import { acknowledgeProtectedMailSparseCheckpoint, type ProtectedMailSparseCheckpointOptions } from "./protected-mail-sparse-checkpoint.js";

const checkpoint = "cb02833267b2d0d17f273c7f04efc48a5431674e7652de4226465aa7d4a2268e", observation = "a".repeat(64), nonce = "b".repeat(64);
const marker = "SPARSE_CHECKPOINT_PRIVATE_SYNTHETIC_DO_NOT_ECHO";
const receipt = (): unknown[] => [checkpoint, observation, "mail-connector-cursor:" + "e".repeat(64), 2, "7", 12, 1, 2, 512, "f".repeat(64)];
const options = (fetchImpl: typeof fetch): ProtectedMailSparseCheckpointOptions =>
  ({ baseUrl: "http://127.0.0.1:32109", dbName: "synthetic-sparse-workspace", token: "synthetic-sparse-bearer", fetchImpl });
function unknown(value: unknown) {
  assert.deepEqual(value, { kind: "unknown", reason: "procedure_outcome_unknown" }); assert.ok(!JSON.stringify(value).includes(marker));
}

test("sparse ACK fixes the authority route and submits only ID plus nonce", async () => {
  let calls = 0;
  const result = await acknowledgeProtectedMailSparseCheckpoint(options(async (input, init) => {
    calls++;
    assert.equal(String(input), "http://127.0.0.1:32109/v1/database/synthetic-sparse-workspace/call/acknowledge_protected_mail_sparse_checkpoint");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit"); assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.body, JSON.stringify([checkpoint, nonce])); return Response.json([0, receipt()]);
  }), checkpoint, nonce);
  assert.equal(calls, 1); assert.equal(result.kind, "ok"); if (result.kind !== "ok") return;
  assert.deepEqual(result.value, { checkpointId: checkpoint, observationId: observation, cursorId: "mail-connector-cursor:" + "e".repeat(64),
    cursorGeneration: "2", uidValidity: "7", lastUid: 12, acknowledgedMessages: 1, observedAbsentMessages: 2, acknowledgedBytes: 512, receiptDigest: "f".repeat(64) });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.value));
});

test("ACK snapshots host options and a lost reply never triggers automatic replay", async () => {
  let calls = 0, committed = false, target = "", sentToken = "";
  const opts = { ...options(async (url, init) => {
    calls++; target = String(url); sentToken = (init?.headers as Record<string, string>).Authorization;
    if (!committed) { committed = true; throw Error(marker); } return Response.json([0, receipt()]);
  }) };
  const pending = acknowledgeProtectedMailSparseCheckpoint(opts, checkpoint, nonce);
  opts.baseUrl = "http://attacker.example.test"; opts.token = marker;
  unknown(await pending); assert.equal(calls, 1); assert.ok(target.startsWith("http://127.0.0.1:32109/")); assert.equal(sentToken, "Bearer synthetic-sparse-bearer");
  assert.equal((await acknowledgeProtectedMailSparseCheckpoint(options(opts.fetchImpl!), checkpoint, nonce)).kind, "ok"); assert.equal(calls, 2);
});

test("decoder binds observation-derived identity and rejects unsafe, inconsistent or extra metadata", async () => {
  for (const mutate of [
    (v: unknown[]) => { v[0] = "0".repeat(64); }, (v: unknown[]) => { v[1] = "0".repeat(64); },
    (v: unknown[]) => { v[2] = marker; }, (v: unknown[]) => { v[3] = 9007199254740992; }, (v: unknown[]) => { v[3] = "2"; },
    (v: unknown[]) => { v[3] = 1; }, (v: unknown[]) => { v[4] = "07"; }, (v: unknown[]) => { v[4] = "4294967296"; },
    (v: unknown[]) => { v[5] = 4294967295; }, (v: unknown[]) => { v[5] = 2; }, (v: unknown[]) => { v[6] = 7; },
    (v: unknown[]) => { v[6] = 0; }, (v: unknown[]) => { v[7] = -1; }, (v: unknown[]) => { v[8] = 0; },
    (v: unknown[]) => { v[8] = 2097153; }, (v: unknown[]) => { v[9] = marker; }, (v: unknown[]) => { v.push(marker); },
  ]) { const value = receipt(); mutate(value); unknown(await acknowledgeProtectedMailSparseCheckpoint(options(async () => Response.json([0, value])), checkpoint, nonce)); }
  const absent = receipt(); absent[5] = 4294967294; absent[6] = 0; absent[7] = 8; absent[8] = 0;
  assert.equal((await acknowledgeProtectedMailSparseCheckpoint(options(async () => Response.json([0, absent])), checkpoint, nonce)).kind, "ok");
  absent[7] = 0; unknown(await acknowledgeProtectedMailSparseCheckpoint(options(async () => Response.json([0, absent])), checkpoint, nonce));
});

test("actual stream bytes and UTF8 are bounded; stalled fetch or body times out without retry", async () => {
  const rejectedResponses: ResponseInit[] = [{ status: 500, headers: { "content-type": "application/json" } }, { headers: { "content-type": "text/plain" } },
    { headers: { "content-type": "application/json", "content-length": "4097" } }];
  for (const init of rejectedResponses) {
    let rejectedStreamCancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { rejectedStreamCancelled = true; } }), init);
    unknown(await acknowledgeProtectedMailSparseCheckpoint(options(async () => response), checkpoint, nonce));
    assert.equal(rejectedStreamCancelled, true);
  }
  unknown(await acknowledgeProtectedMailSparseCheckpoint(options(async () => new Response(" ".repeat(4097), { headers: { "content-type": "application/json", "content-length": "16" } })), checkpoint, nonce));
  unknown(await acknowledgeProtectedMailSparseCheckpoint(options(async () => new Response(new Uint8Array([0xc0, 0xaf]), { headers: { "content-type": "application/json" } })), checkpoint, nonce));
  let calls = 0;
  unknown(await acknowledgeProtectedMailSparseCheckpoint({ ...options(async () => { calls++; return new Promise<Response>(() => {}); }), timeoutMs: 10 }, checkpoint, nonce));
  assert.equal(calls, 1);
  let cancelled = false;
  unknown(await acknowledgeProtectedMailSparseCheckpoint({ ...options(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } })), timeoutMs: 10 }, checkpoint, nonce));
  assert.equal(cancelled, true);
});

test("only fixed sparse errors are exposed and invalid authority options never send", async () => {
  const suffixes = ["invalid_request", "inconsistent", "owner_required", "service_required", "event_conflict", "stale", "source_required", "limit_exceeded"];
  for (const suffix of suffixes) {
    const reason = `protected_mail_sparse_checkpoint_${suffix}`;
    assert.deepEqual(await acknowledgeProtectedMailSparseCheckpoint(options(async () => Response.json([1, reason])), checkpoint, nonce), { kind: "denied", reason });
  }
  for (const error of [marker, "protected_mail_connector_stale", "protected_mail_sparse_checkpoint_unknown"])
    unknown(await acknowledgeProtectedMailSparseCheckpoint(options(async () => Response.json([1, error])), checkpoint, nonce));
  unknown(await acknowledgeProtectedMailSparseCheckpoint(options(async () => new Response(marker, { status: 500 })), checkpoint, nonce));
  let calls = 0; const opts = options(async () => { calls++; return Response.json([0, receipt()]); });
  for (const bad of ["http://mail.example.test", "https://mail.example.test/path", "https://user:pass@mail.example.test", "https://mail.example.test?q=1", "https://mail.example.test/#fragment"])
    assert.deepEqual(await acknowledgeProtectedMailSparseCheckpoint({ ...opts, baseUrl: bad }, checkpoint, nonce), { kind: "denied", reason: "invalid_request" });
  for (const bad of [{ ...opts, dbName: "workspace/other" }, { ...opts, token: "line\nbreak" }, { ...opts, timeoutMs: 0 }, { ...opts, timeoutMs: 60001 }])
    assert.deepEqual(await acknowledgeProtectedMailSparseCheckpoint(bad, checkpoint, nonce), { kind: "denied", reason: "invalid_request" });
  assert.deepEqual(await acknowledgeProtectedMailSparseCheckpoint(opts, marker, nonce), { kind: "denied", reason: "invalid_request" });
  assert.equal(calls, 0);
});
