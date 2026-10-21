import { test } from "node:test";
import assert from "node:assert/strict";
import { acknowledgeProtectedMailConnectorSelection, type ProtectedConnectorProcedureOptions } from "./protected-connector-ack.js";

const selection = "a".repeat(64), nonce = "b".repeat(64), marker = "CONNECTOR_PRIVATE_SYNTHETIC_DO_NOT_ECHO";
const source = () => ({ id: "mail-source:1:" + "c".repeat(64), revision: "1", digest: "d".repeat(64) });
const receipt = (): unknown[] => [selection, "mail-connector-cursor:" + "e".repeat(64), 2, "7", 12, 1, 512, "f".repeat(64)];
const options = (fetchImpl: typeof fetch): ProtectedConnectorProcedureOptions =>
  ({ baseUrl: "http://127.0.0.1:32109", dbName: "synthetic-connector-workspace", token: "synthetic-connector-bearer", fetchImpl });
function unknown(value: unknown) {
  assert.deepEqual(value, { kind: "unknown", reason: "procedure_outcome_unknown" });
  assert.ok(!JSON.stringify(value).includes(marker));
}

test("connector ACK uses only the fixed authority route and exact source products", async () => {
  let calls = 0;
  const result = await acknowledgeProtectedMailConnectorSelection(options(async (input, init) => {
    calls++;
    assert.equal(String(input), "http://127.0.0.1:32109/v1/database/synthetic-connector-workspace/call/acknowledge_protected_mail_connector_selection");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    const value = source(); assert.equal(init?.body, JSON.stringify([selection, nonce, [[value.id, 1, value.digest]]]));
    return Response.json([0, receipt()]);
  }), selection, nonce, [source()]);
  assert.equal(calls, 1); assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.value, { selectionId: selection, cursorId: "mail-connector-cursor:" + "e".repeat(64), cursorGeneration: "2",
    uidValidity: "7", lastUid: 12, acknowledgedMessages: 1, acknowledgedBytes: 512, receiptDigest: "f".repeat(64) });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.value));
});

test("ACK snapshots references before awaiting and rejects getters and authority fields", async () => {
  let calls = 0, serialized = "", release!: () => void, invoked = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl: typeof fetch = async (_, init) => { calls++; serialized = String(init?.body); await gate; return Response.json([0, receipt()]); };
  const proposed = [source()], original = proposed[0].digest;
  const pending = acknowledgeProtectedMailConnectorSelection(options(fetchImpl), selection, nonce, proposed);
  proposed[0].digest = "0".repeat(64); proposed.push(source()); release();
  assert.equal((await pending).kind, "ok"); assert.equal((JSON.parse(serialized) as unknown[][][])[2][0][2], original);
  const accessor = Object.defineProperty({ id: source().id, revision: "1" }, "digest", { enumerable: true, get() { invoked = true; return original; } });
  for (const invalid of [[accessor], [{ ...source(), approved: true }], [{ ...source(), body: marker }], [{ ...source(), revision: 2 }],
    [{ ...source(), id: "mail-derived-source:" + "c".repeat(64) }], Array.from({ length: 9 }, source), [source(), , source()]]) {
    assert.deepEqual(await acknowledgeProtectedMailConnectorSelection(options(fetchImpl), selection, nonce, invalid), { kind: "denied", reason: "invalid_request" });
  }
  assert.equal(calls, 1); assert.equal(invoked, false);
});

test("lost ACK stays unknown without resend and explicit exact replay recovers metadata", async () => {
  let calls = 0, committed = false;
  const fetchImpl: typeof fetch = async () => { calls++; if (!committed) { committed = true; throw Error(marker); } return Response.json([0, receipt()]); };
  unknown(await acknowledgeProtectedMailConnectorSelection(options(fetchImpl), selection, nonce, [source()]));
  assert.equal(calls, 1); assert.equal(committed, true);
  assert.equal((await acknowledgeProtectedMailConnectorSelection(options(fetchImpl), selection, nonce, [source()])).kind, "ok");
  assert.equal(calls, 2);
});

test("ACK decoder rejects substituted metadata, unsafe u64, mismatched counts and extra data", async () => {
  for (const mutate of [
    (v: unknown[]) => { v[0] = "0".repeat(64); }, (v: unknown[]) => { v[1] = marker; },
    (v: unknown[]) => { v[2] = 9007199254740992; }, (v: unknown[]) => { v[2] = "2"; },
    (v: unknown[]) => { v[3] = "07"; }, (v: unknown[]) => { v[3] = "4294967296"; },
    (v: unknown[]) => { v[4] = 4294967296; }, (v: unknown[]) => { v[5] = 0; },
    (v: unknown[]) => { v[6] = 2097153; }, (v: unknown[]) => { v[7] = marker; }, (v: unknown[]) => { v.push(marker); },
  ]) {
    const value = receipt(); mutate(value);
    unknown(await acknowledgeProtectedMailConnectorSelection(options(async () => Response.json([0, value])), selection, nonce, [source()]));
  }
  const baseline = [selection, "mail-connector-cursor:" + "e".repeat(64), 1, "4294967295", 0, 0, 0, "f".repeat(64)];
  assert.equal((await acknowledgeProtectedMailConnectorSelection(options(async () => Response.json([0, baseline])), selection, nonce, [])).kind, "ok");
  baseline[6] = 1;
  unknown(await acknowledgeProtectedMailConnectorSelection(options(async () => Response.json([0, baseline])), selection, nonce, []));
});

test("actual streamed ACK response bytes are capped and timeout never resends", async () => {
  const oversized = () => new Response(" ".repeat(4097), { headers: { "content-type": "application/json", "content-length": "16" } });
  unknown(await acknowledgeProtectedMailConnectorSelection(options(async () => oversized()), selection, nonce, [source()]));
  let calls = 0;
  const stalled: typeof fetch = async () => { calls++; return new Promise<Response>(() => {}); };
  unknown(await acknowledgeProtectedMailConnectorSelection({ ...options(stalled), timeoutMs: 10 }, selection, nonce, [source()]));
  assert.equal(calls, 1);
});

test("ACK exposes only connector fixed denials and refuses an insecure authority destination", async () => {
  assert.deepEqual(await acknowledgeProtectedMailConnectorSelection(options(async () => Response.json([1, "protected_mail_connector_stale"])), selection, nonce, [source()]),
    { kind: "denied", reason: "protected_mail_connector_stale" });
  for (const error of [marker, "protected_mail_result_stale", "protected_mail_inference_stale"]) {
    unknown(await acknowledgeProtectedMailConnectorSelection(options(async () => Response.json([1, error])), selection, nonce, [source()]));
  }
  unknown(await acknowledgeProtectedMailConnectorSelection(options(async () => new Response(marker, { status: 500 })), selection, nonce, [source()]));
  let calls = 0;
  assert.deepEqual(await acknowledgeProtectedMailConnectorSelection({ ...options(async () => { calls++; return Response.json([0, receipt()]); }), baseUrl: "http://mail.example.test" },
    selection, nonce, [source()]), { kind: "denied", reason: "invalid_request" });
  assert.equal(calls, 0);
});
