import { test } from "node:test";
import assert from "node:assert/strict";
import { finishProtectedMailSparseReadDispatch } from "./protected-mail-sparse-read-report.js";
import type { ProtectedMailSparseReadProcedureOptions } from "./protected-mail-sparse-read-dispatch.js";
import type { ProtectedMailSparseReadOutcome } from "./protected-mail-sparse-read-types.js";

const id = "a".repeat(64), nonce = "b".repeat(64), marker = "SPARSE_READ_PRIVATE_SYNTHETIC_DO_NOT_ECHO";
const options = (fetchImpl: typeof fetch): ProtectedMailSparseReadProcedureOptions => ({ baseUrl: "http://127.0.0.1:32109", dbName: "synthetic-sparse-read", token: "synthetic-bearer", fetchImpl });

test("report uses fixed outcome products/route and accepts bounded HTTP200 void reducer success", async () => {
  const outcomes: ProtectedMailSparseReadOutcome[] = ["ReadReported", "Failed", "Unknown", "CancelledBeforeDispatch"];
  for (let index = 0; index < outcomes.length; index++) {
    let calls = 0;
    const result = await finishProtectedMailSparseReadDispatch(options(async (input, init) => {
      calls++; assert.equal(String(input), "http://127.0.0.1:32109/v1/database/synthetic-sparse-read/call/finish_protected_mail_sparse_read_dispatch");
      assert.equal(init?.body, JSON.stringify([id, [index, []], nonce])); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
      assert.equal(init?.credentials, "omit"); assert.equal(init?.referrerPolicy, "no-referrer"); return new Response(null, { status: 200 });
    }), id, outcomes[index], nonce);
    assert.deepEqual(result, { kind: "recorded", eventNonce: nonce, outcome: outcomes[index] }); assert.equal(calls, 1); assert.ok(Object.isFrozen(result));
  }
});

test("lost terminal reply retains chosen outcome/nonce without retry; explicit identical recovery stays metadata-only", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; if (calls === 1) throw Error(marker); return new Response(null, { status: 200 }); };
  const unknown = await finishProtectedMailSparseReadDispatch(options(fetchImpl), id, "ReadReported", nonce);
  assert.deepEqual(unknown, { kind: "unknown", eventNonce: nonce, outcome: "ReadReported" }); assert.equal(calls, 1);
  assert.deepEqual(await finishProtectedMailSparseReadDispatch(options(fetchImpl), id, "ReadReported", nonce), { kind: "recorded", eventNonce: nonce, outcome: "ReadReported" }); assert.equal(calls, 2);
  assert.ok(!JSON.stringify(unknown).includes(marker));
});

test("bad status/length cancels early; actual 4096 stream cap discards all raw diagnostics", async () => {
  const invalid: ResponseInit[] = [{ status: 500 }, { headers: { "content-length": "4097" } }, { headers: { "content-length": "01" } }];
  for (const init of invalid) {
    let cancelled = false; const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), init);
    assert.deepEqual(await finishProtectedMailSparseReadDispatch(options(async () => response), id, "Failed", nonce), { kind: "unknown", eventNonce: nonce, outcome: "Failed" }); assert.equal(cancelled, true);
  }
  assert.deepEqual(await finishProtectedMailSparseReadDispatch(options(async () => new Response(marker + " ".repeat(4096), { headers: { "content-length": "1" } })), id, "Unknown", nonce), { kind: "unknown", eventNonce: nonce, outcome: "Unknown" });
  assert.deepEqual(await finishProtectedMailSparseReadDispatch(options(async () => new Response(marker)), id, "Unknown", nonce), { kind: "recorded", eventNonce: nonce, outcome: "Unknown" });
});

test("hung report body/fetch obey deadline and preserve the chosen report", async () => {
  let calls = 0;
  assert.deepEqual(await finishProtectedMailSparseReadDispatch({ ...options(async () => { calls++; return new Promise<Response>(() => {}); }), timeoutMs: 10 }, id, "Failed", nonce), { kind: "unknown", eventNonce: nonce, outcome: "Failed" }); assert.equal(calls, 1);
  let cancelled = false;
  assert.deepEqual(await finishProtectedMailSparseReadDispatch({ ...options(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }))), timeoutMs: 10 }, id, "ReadReported", nonce), { kind: "unknown", eventNonce: nonce, outcome: "ReadReported" }); assert.equal(cancelled, true);
});

test("malformed arguments and hostile host options never send or invoke accessors", async () => {
  let calls = 0, invoked = false; const opts = options(async () => { calls++; return new Response(null); });
  assert.deepEqual(await finishProtectedMailSparseReadDispatch(opts, marker, "Failed", nonce), { kind: "unknown", eventNonce: "", outcome: "Unknown" });
  const accessor = Object.defineProperty({ ...opts }, "token", { enumerable: true, get() { invoked = true; return marker; } });
  for (const bad of [accessor, { ...opts, baseUrl: "http://attacker.example.test" }, { ...opts, baseUrl: "https://mail.example.test/path" }, { ...opts, timeoutMs: 0 }, { ...opts, route: "other" }])
    assert.deepEqual(await finishProtectedMailSparseReadDispatch(bad, id, "Failed", nonce), { kind: "unknown", eventNonce: nonce, outcome: "Failed" });
  assert.equal(calls, 0); assert.equal(invoked, false);
});
