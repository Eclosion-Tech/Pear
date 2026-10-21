import { test } from "node:test";
import assert from "node:assert/strict";
import { finishProtectedMailReadDispatch } from "./protected-mail-read-report.js";
import type { ProtectedMailReadOutcome } from "./protected-mail-read-types.js";

const id = "a".repeat(64), nonce = "b".repeat(64), marker = "EXECUTOR_PRIVATE_SYNTHETIC_REPORT_ERROR";
const options = (fetchImpl: typeof fetch) => ({ baseUrl: "http://127.0.0.1:32109", dbName: "synthetic-report-workspace", token: "synthetic-bearer", fetchImpl });
test("read report uses the fixed reducer route and closed enum once", async () => {
  for (const [tag, outcome] of (["ReadReported", "Failed", "Unknown", "CancelledBeforeDispatch"] as const).entries()) {
    let calls = 0;
    const result = await finishProtectedMailReadDispatch(options(async (input, init) => {
      calls++; assert.equal(String(input), "http://127.0.0.1:32109/v1/database/synthetic-report-workspace/call/finish_protected_mail_read_dispatch");
      assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
      assert.equal(init?.body, JSON.stringify([id, [tag, []], nonce])); return new Response(null, { status: 200 });
    }), id, outcome, nonce);
    assert.equal(calls, 1); assert.deepEqual(result, { kind: "recorded", eventNonce: nonce, outcome }); assert.ok(Object.isFrozen(result));
  }
});
test("lost report reply preserves the chosen outcome and nonce without retry", async () => {
  let calls = 0;
  const result = await finishProtectedMailReadDispatch(options(async () => { calls++; throw Error(marker); }), id, "ReadReported", nonce);
  assert.deepEqual(result, { kind: "unknown", eventNonce: nonce, outcome: "ReadReported" });
  assert.equal(calls, 1); assert.ok(!JSON.stringify(result).includes(marker));
});
test("report bounds actual response bytes and never returns server diagnostics", async () => {
  for (const response of [
    new Response(marker, { status: 500 }),
    new Response(" ".repeat(4097), { status: 200, headers: { "content-length": "1" } }),
    new Response("", { status: 200, headers: { "content-length": "999999999999999999999999" } }),
  ]) {
    const result = await finishProtectedMailReadDispatch(options(async () => response), id, "Failed", nonce);
    assert.deepEqual(result, { kind: "unknown", eventNonce: nonce, outcome: "Failed" });
    assert.ok(!JSON.stringify(result).includes(marker));
  }
});
test("report deadline cancels a hung body and does not resend", async () => {
  let calls = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const result = await finishProtectedMailReadDispatch({ ...options(async () => { calls++; return new Response(body); }), timeoutMs: 10 }, id, "Unknown", nonce);
  assert.deepEqual(result, { kind: "unknown", eventNonce: nonce, outcome: "Unknown" }); assert.equal(calls, 1); assert.equal(cancelled, true);
});
test("invalid report input cannot echo untrusted content or send credentials", async () => {
  let calls = 0;
  const configured = options(async () => { calls++; return new Response(null); });
  for (const args of [[marker, "Unknown", nonce], [id, marker, nonce], [id, "Unknown", marker]]) {
    const result = await finishProtectedMailReadDispatch(configured, args[0], args[1] as ProtectedMailReadOutcome, args[2]);
    assert.deepEqual(result, { kind: "unknown", eventNonce: "", outcome: "Unknown" }); assert.ok(!JSON.stringify(result).includes(marker));
  }
  assert.equal(calls, 0);
});
test("report refuses insecure authority endpoints before sending", async () => {
  let calls = 0;
  for (const baseUrl of ["http://mail.example.test", "https://example.test/", "https://user:pass@example.test", "https://example.test?", "https://example.test/#"]) {
    const result = await finishProtectedMailReadDispatch({ ...options(async () => { calls++; return new Response(null); }), baseUrl }, id, "Unknown", nonce);
    assert.equal(result.kind, "unknown");
  }
  assert.equal(calls, 0);
});
