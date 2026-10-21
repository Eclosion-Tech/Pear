import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptProtectedMailInferenceResult } from "./protected-inference-claim.js";
import type { ProtectedInferenceProcedureOptions } from "./protected-inference-claim.js";

const admission = "a".repeat(64), nonce = "b".repeat(64), marker = "PRIVATE_RESULT_SYNTHETIC_DO_NOT_ECHO";
const source = ["mail-derived-source:" + "c".repeat(64), 1, "d".repeat(64)];
const receipt = () => [admission, [...source], "e".repeat(64), 1024];
const declaration = () => ({ formatVersion: 1, adapter: "anthropic.messages.v1", model: "fixture-model", stopReason: "end_turn", outputTokens: 10,
  body: `\t${marker}\r\n{"approved":true,"parents":[],"tools":["send"]} 🍐` });
const options = (fetchImpl: typeof fetch): ProtectedInferenceProcedureOptions =>
  ({ baseUrl: "http://127.0.0.1:32109", dbName: "synthetic-result-workspace", token: "synthetic-result-bearer", fetchImpl });
const unknown = (result: unknown) => {
  assert.deepEqual(result, { kind: "unknown", reason: "procedure_outcome_unknown" });
  assert.ok(!JSON.stringify(result).includes(marker));
};

test("result declaration goes only to the authority route as a fixed six-field product", async () => {
  let calls = 0;
  const proposed = declaration();
  const fetchImpl: typeof fetch = async (input, init) => {
    calls++; assert.equal(String(input), "http://127.0.0.1:32109/v1/database/synthetic-result-workspace/call/accept_protected_mail_inference_result");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    assert.equal(init?.body, JSON.stringify([admission, nonce, [1, "anthropic.messages.v1", "fixture-model", "end_turn", 10, proposed.body]]));
    return Response.json([0, receipt()]);
  };
  const result = await acceptProtectedMailInferenceResult(options(fetchImpl), admission, nonce, proposed);
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.value, { admissionId: admission, source: { id: source[0], revision: "1", digest: source[2] }, envelopeDigest: "e".repeat(64), envelopeBytes: 1024 });
  assert.ok(Object.isFrozen(result.value) && Object.isFrozen(result.value.source)); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result.value).includes(marker));
});

test("submission snapshots literals before awaiting and does not accept caller authority fields", async () => {
  let calls = 0, body = "", release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl: typeof fetch = async (_, init) => { calls++; body = String(init?.body); await gate; return Response.json([0, receipt()]); };
  const proposed = declaration(), original = proposed.body;
  const pending = acceptProtectedMailInferenceResult(options(fetchImpl), admission, nonce, proposed);
  proposed.body = "changed"; proposed.model = "changed"; release();
  assert.equal((await pending).kind, "ok");
  assert.equal((JSON.parse(body) as unknown[][])[2][5], original);
  for (const invalid of [{ ...declaration(), parents: [] }, { ...declaration(), approved: true }, { ...declaration(), body: "" },
    { ...declaration(), body: "x".repeat(65537) }, { ...declaration(), body: "\ud800" }, { ...declaration(), stopReason: "tool_use" }, { ...declaration(), outputTokens: 0 }]) {
    assert.deepEqual(await acceptProtectedMailInferenceResult(options(fetchImpl), admission, nonce, invalid), { kind: "denied", reason: "invalid_request" });
  }
  assert.equal(calls, 1);
});

test("lost acceptance reply stays unknown without resend; explicit replay can recover metadata", async () => {
  let calls = 0, committed = false;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    if (!committed) { committed = true; throw Error(marker); }
    return Response.json([0, receipt()]);
  };
  unknown(await acceptProtectedMailInferenceResult(options(fetchImpl), admission, nonce, declaration()));
  assert.equal(calls, 1); assert.ok(committed);
  assert.equal((await acceptProtectedMailInferenceResult(options(fetchImpl), admission, nonce, declaration())).kind, "ok");
  assert.equal(calls, 2);
});

test("metadata decoder rejects substituted resources, extra data, wrong revision and byte limits", async () => {
  for (const mutate of [
    (v: unknown[]) => { v[0] = "f".repeat(64); },
    (v: unknown[]) => { v.push(marker); },
    (v: unknown[]) => { (v[1] as unknown[])[0] = "mail-source:" + "c".repeat(64); },
    (v: unknown[]) => { (v[1] as unknown[])[1] = 2; },
    (v: unknown[]) => { (v[1] as unknown[])[2] = marker; },
    (v: unknown[]) => { v[2] = marker; },
    (v: unknown[]) => { v[3] = 262145; },
  ]) {
    const value = receipt(); mutate(value);
    unknown(await acceptProtectedMailInferenceResult(options(async () => Response.json([0, value])), admission, nonce, declaration()));
  }
  unknown(await acceptProtectedMailInferenceResult(options(async () => new Response(" ".repeat(4097), { headers: { "content-type": "application/json" } })), admission, nonce, declaration()));
});

test("only this procedure's fixed result errors are returned; raw or foreign errors stay unknown", async () => {
  assert.deepEqual(await acceptProtectedMailInferenceResult(options(async () => Response.json([1, "protected_mail_result_stale"])), admission, nonce, declaration()),
    { kind: "denied", reason: "protected_mail_result_stale" });
  for (const error of [marker, "protected_mail_inference_stale"]) {
    unknown(await acceptProtectedMailInferenceResult(options(async () => Response.json([1, error])), admission, nonce, declaration()));
  }
  unknown(await acceptProtectedMailInferenceResult(options(async () => new Response(marker, { status: 500 })), admission, nonce, declaration()));
});
