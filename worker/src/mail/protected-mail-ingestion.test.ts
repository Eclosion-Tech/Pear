import assert from "node:assert/strict";
import test from "node:test";
import { acceptProtectedMailIngestion, type ProtectedMailIngestionOptions } from "./protected-mail-ingestion.js";

const selection = "a".repeat(64), readId = "bd59b410c67e7ef343f8d6b4689fc9bb74ccbc402b97fbbc8550710ef3ddae2c";
const nonce = "b".repeat(64), marker = "INGESTION_PRIVATE_SYNTHETIC_DO_NOT_ECHO";
function entries() {
  return [{ kind: "imported", uid: 2, message: { folder: "INBOX", uidValidity: "7", uid: 2, direction: "received", messageDate: "2026-10-21",
    from: "fixture@example.test", to: "owner@example.test", cc: "", subject: "prepared", body: marker, note: "", sanitizationVersion: "prepared-text-v1" } },
  { kind: "held", uid: 3, reason: "authentication_material" }];
}
const receipt = (): unknown[] => [readId, selection, "mail-connector-cursor:" + "e".repeat(64), 2, "7", 3, 1, 1, 2048, "f".repeat(64)];
const options = (fetchImpl: typeof fetch): ProtectedMailIngestionOptions =>
  ({ baseUrl: "http://127.0.0.1:32109", dbName: "synthetic-ingestion-workspace", token: "synthetic-ingestion-bearer", fetchImpl });
function unknown(value: unknown) {
  assert.deepEqual(value, { kind: "unknown", reason: "procedure_outcome_unknown" });
  assert.ok(!JSON.stringify(value).includes(marker));
}

test("ingestion sends one exact prepared batch to its fixed route and returns only bounded metadata", async () => {
  let calls = 0;
  const result = await acceptProtectedMailIngestion(options(async (input, init) => {
    calls++;
    assert.equal(String(input), "http://127.0.0.1:32109/v1/database/synthetic-ingestion-workspace/call/accept_protected_mail_ingestion");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store"); assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.body, JSON.stringify([readId, nonce, [[0, ["INBOX", "7", 2, [0, []], "2026-10-21", "fixture@example.test", "owner@example.test", "", "prepared", marker, "", "prepared-text-v1"]], [1, [3, [0, []]]]]]));
    return Response.json([0, receipt()]);
  }), readId, nonce, entries());
  assert.equal(calls, 1); assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.value, { readId, selectionId: selection, cursorId: "mail-connector-cursor:" + "e".repeat(64), cursorGeneration: "2", uidValidity: "7",
    lastUid: 3, importedMessages: 1, heldMessages: 1, envelopeBytes: 2048, receiptDigest: "f".repeat(64) });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.value));
  assert.ok(!JSON.stringify(result).includes(marker));
});

test("ingestion snapshots actual text and host configuration before await, rejecting getters and extra authority", async () => {
  let release!: () => void, calls = 0, serialized = "", invoked = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opts = options(async (_, init) => { calls++; serialized = String(init?.body); await gate; return Response.json([0, receipt()]); });
  const proposed = entries(), pending = acceptProtectedMailIngestion(opts, readId, nonce, proposed);
  proposed[0].message!.body = "changed"; proposed[1].reason = "sensitive_content";
  (opts as { token: string }).token = "changed"; (opts as { dbName: string }).dbName = "changed"; release();
  assert.equal((await pending).kind, "ok"); assert.ok(serialized.includes(marker)); assert.ok(!serialized.includes("sensitive_content"));
  const accessor = Object.defineProperty({ ...entries()[0].message }, "body", { enumerable: true, get() { invoked = true; throw Error(marker); } });
  for (const proposed of [[{ ...entries()[0], message: accessor }], [{ ...entries()[1], subject: marker }], [{ ...entries()[1], approved: true }],
    [{ ...entries()[1], reason: "missing_uid" }], [entries()[0], entries()[0]], [entries()[1], entries()[0]], [entries()[0], , entries()[1]]]) {
    assert.deepEqual(await acceptProtectedMailIngestion(opts, readId, nonce, proposed), { kind: "denied", reason: "invalid_request" });
  }
  assert.equal(calls, 1); assert.equal(invoked, false);
});

test("lost committed ingestion is unknown without resend; explicit exact retry recovers metadata", async () => {
  let calls = 0, committed = false;
  const fetchImpl: typeof fetch = async () => { calls++; if (!committed) { committed = true; throw Error(marker); } return Response.json([0, receipt()]); };
  unknown(await acceptProtectedMailIngestion(options(fetchImpl), readId, nonce, entries()));
  assert.equal(calls, 1); assert.equal(committed, true);
  assert.equal((await acceptProtectedMailIngestion(options(fetchImpl), readId, nonce, entries())).kind, "ok");
  assert.equal(calls, 2);
});

test("receipt substitutions, unsafe u64, inconsistent slot counts and malformed responses remain unknown", async () => {
  for (const mutate of [
    (v: unknown[]) => { v[0] = "0".repeat(64); }, (v: unknown[]) => { v[1] = "0".repeat(64); },
    (v: unknown[]) => { v[2] = marker; }, (v: unknown[]) => { v[3] = 9007199254740992; },
    (v: unknown[]) => { v[3] = "2"; }, (v: unknown[]) => { v[3] = 1; },
    (v: unknown[]) => { v[4] = "07"; }, (v: unknown[]) => { v[4] = "8"; }, (v: unknown[]) => { v[4] = "4294967296"; },
    (v: unknown[]) => { v[5] = 4; }, (v: unknown[]) => { v[6] = 0; v[7] = 2; },
    (v: unknown[]) => { v[8] = 2097153; }, (v: unknown[]) => { v[9] = marker; }, (v: unknown[]) => { v.push(marker); },
  ]) {
    const value = receipt(); mutate(value);
    unknown(await acceptProtectedMailIngestion(options(async () => Response.json([0, value])), readId, nonce, entries()));
  }
  for (const value of [{ value: receipt() }, [0, receipt(), marker], [1, marker], [1, "protected_mail_read_stale"]]) {
    unknown(await acceptProtectedMailIngestion(options(async () => Response.json(value)), readId, nonce, entries()));
  }
});

test("streamed response bounds, invalid UTF8 and deadline stop without exposing body or retrying", async () => {
  for (const response of [
    () => new Response(" ".repeat(4097), { headers: { "content-type": "application/json", "content-length": "16" } }),
    () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    () => new Response(marker, { status: 500 }),
    () => new Response(JSON.stringify([0, receipt()]), { headers: { "content-type": "text/html" } }),
  ]) unknown(await acceptProtectedMailIngestion(options(async () => response()), readId, nonce, entries()));
  let calls = 0;
  unknown(await acceptProtectedMailIngestion({ ...options(async () => { calls++; return new Promise<Response>(() => {}); }), timeoutMs: 10 }, readId, nonce, entries()));
  assert.equal(calls, 1);
  let cancelled = false;
  unknown(await acceptProtectedMailIngestion({ ...options(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { "content-type": "application/json" } })), timeoutMs: 10 }, readId, nonce, entries()));
  assert.equal(cancelled, true);
});

test("only fixed ingestion denials escape; invalid credentials/authority origins never dispatch", async () => {
  assert.deepEqual(await acceptProtectedMailIngestion(options(async () => Response.json([1, "protected_mail_ingestion_stale"])), readId, nonce, entries()),
    { kind: "denied", reason: "protected_mail_ingestion_stale" });
  let calls = 0;
  const opts = options(async () => { calls++; return Response.json([0, receipt()]); });
  for (const changed of [{ baseUrl: "http://mail.example.test" }, { baseUrl: opts.baseUrl + "/path" }, { baseUrl: opts.baseUrl + "?target=other" },
    { token: "unsafe\ncredential" }, { dbName: "../other" }, { timeoutMs: 0 }]) {
    assert.deepEqual(await acceptProtectedMailIngestion({ ...opts, ...changed }, readId, nonce, entries()), { kind: "denied", reason: "invalid_request" });
  }
  assert.equal(calls, 0);
});
