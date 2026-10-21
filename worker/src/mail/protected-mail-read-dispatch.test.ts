import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalConnectorSelection } from "../../../packages/sentinel/src/index.js";
import { beginProtectedMailReadDispatch, type ProtectedMailReadProcedureOptions } from "./protected-mail-read-dispatch.js";

const marker = "READ_PRIVATE_SYNTHETIC_DO_NOT_ECHO", selectionId = "a".repeat(64);
function hashFields(domain: string, fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of [domain, ...fields]) {
    const bytes = Buffer.from(field), size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(bytes.length)); hash.update(size).update(bytes);
  }
  return hash.digest("hex");
}
const readId = hashFields("pear-mail-read-grant-v1", [selectionId]);
function plan(): Record<string, unknown> {
  const selection = canonicalConnectorSelection({ formatVersion: 1, kind: "mail.connector.selection", selectionId,
    workspaceId: "b".repeat(64), ownerId: "c".repeat(64), connection: { id: "1", epoch: "2", snapshotDigest: "d".repeat(64) },
    connector: { identity: "e".repeat(64), runtimeId: "fixture-reader", runId: "fixture-run" },
    mailbox: { host: "mail.example.test", port: 993, username: "fixture@example.test", folder: "Inbox 雪", direction: "received" },
    selection: { mode: "stored_batch", uidValidity: "7", expectedCursorGeneration: "1", previousCursorDigest: "f".repeat(64),
      fromUid: 1, throughUid: 2, uids: [1, 2], maxAcknowledgedBytes: 2097152 }, notBeforeMs: 1, expiresAtMs: 10000000 });
  assert.ok(selection);
  return { formatVersion: 1, kind: "mail.connector.read", limits: { maxMessageBytes: 524288, maxTotalBytes: 700000 },
    profile: "imap.uid-body-peek.v1", readId, reservation: { bodyBytes: 700000, messageSlots: 2, operations: 1 },
    selection: JSON.parse(selection), selectionDigest: createHash("sha256").update(selection).digest("hex") };
}
function reply(value = plan()): unknown[] {
  const canonical = JSON.stringify(value);
  return [readId, createHash("sha256").update(canonical).digest("hex"), Buffer.byteLength(canonical), canonical];
}
const options = (fetchImpl: typeof fetch): ProtectedMailReadProcedureOptions =>
  ({ baseUrl: "http://127.0.0.1:32109", dbName: "synthetic-read-workspace", token: "synthetic-read-bearer", fetchImpl });
function unknown(value: unknown): void {
  assert.deepEqual(value, { kind: "unknown", reason: "procedure_outcome_unknown" });
  assert.ok(!JSON.stringify(value).includes(marker));
}

test("read-plan claim uses the fixed authority route and verifies frozen exact metadata", async () => {
  let calls = 0;
  const result = await beginProtectedMailReadDispatch(options(async (input, init) => {
    calls++;
    assert.equal(String(input), "http://127.0.0.1:32109/v1/database/synthetic-read-workspace/call/begin_protected_mail_read_dispatch");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    assert.equal(init?.body, JSON.stringify([readId]));
    return Response.json([0, reply()]);
  }), readId);
  assert.equal(calls, 1); assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.value.readId, readId);
  assert.equal(result.value.plan.selection.mailbox.folder, "Inbox 雪");
  assert.equal(result.value.plan.reservation.bodyBytes, 700000);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.value) && Object.isFrozen(result.value.plan.selection.selection.uids));
});

test("lost successful claim remains unknown and explicit repeat cannot recover a consumed plan", async () => {
  let calls = 0, consumed = false;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    if (!consumed) { consumed = true; throw Error(marker); }
    return Response.json([1, "protected_mail_read_consumed"]);
  };
  unknown(await beginProtectedMailReadDispatch(options(fetchImpl), readId));
  assert.equal(consumed, true); assert.equal(calls, 1);
  assert.deepEqual(await beginProtectedMailReadDispatch(options(fetchImpl), readId), { kind: "denied", reason: "protected_mail_read_consumed" });
  assert.equal(calls, 2);
});

test("read-plan decoder rejects altered bindings, caps, reservation, digest and noncanonical bytes", async () => {
  const mutations: Array<(v: Record<string, unknown>) => void> = [
    v => { v.readId = "0".repeat(64); }, v => { v.profile = "imap.search.v1"; },
    v => { v.selectionDigest = "0".repeat(64); }, v => { v.approved = true; },
    v => { v.limits = { maxMessageBytes: 524289, maxTotalBytes: 700000 }; },
    v => { v.limits = { maxMessageBytes: 524288, maxTotalBytes: 2097153 }; },
    v => { v.reservation = { bodyBytes: 1, messageSlots: 2, operations: 1 }; },
    v => { v.reservation = { bodyBytes: 700000, messageSlots: 1, operations: 1 }; },
    v => { v.reservation = { bodyBytes: 700000, messageSlots: 2, operations: 2 }; },
    v => { const s = v.selection as Record<string, unknown>; s.selectionId = "0".repeat(64);
      v.selectionDigest = createHash("sha256").update(JSON.stringify(s)).digest("hex"); },
  ];
  for (const mutate of mutations) {
    const v = plan(); mutate(v);
    unknown(await beginProtectedMailReadDispatch(options(async () => Response.json([0, reply(v)])), readId));
  }
  for (const mutate of [
    (v: unknown[]) => { v[0] = "0".repeat(64); }, (v: unknown[]) => { v[1] = "0".repeat(64); },
    (v: unknown[]) => { v[2] = Number(v[2]) - 1; }, (v: unknown[]) => { v.push(marker); },
    (v: unknown[]) => { v[3] = " " + String(v[3]); v[2] = Buffer.byteLength(String(v[3])); v[1] = createHash("sha256").update(String(v[3])).digest("hex"); },
  ]) {
    const v = reply(); mutate(v);
    unknown(await beginProtectedMailReadDispatch(options(async () => Response.json([0, v])), readId));
  }
});

test("read-plan reply is bounded by actual streamed bytes and malformed streams stay unknown", async () => {
  for (const response of [
    new Response(" ".repeat(16385), { headers: { "content-type": "application/json", "content-length": "16" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    new Response(marker, { status: 500 }),
    new Response("{}", { headers: { "content-type": "text/plain" } }),
  ]) unknown(await beginProtectedMailReadDispatch(options(async () => response), readId));
  let cancelled = false;
  const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  unknown(await beginProtectedMailReadDispatch({ ...options(async () => new Response(stalled, { headers: { "content-type": "application/json" } })), timeoutMs: 10 }, readId));
  assert.equal(cancelled, true);
});

test("read-plan timeout never resends and host configuration is snapshotted before waiting", async () => {
  let calls = 0, release!: () => void, captured = "";
  const gate = new Promise<void>(resolve => { release = resolve; });
  const configured = { ...options(async (input) => { calls++; captured = String(input); await gate; return Response.json([0, reply()]); }) };
  const pending = beginProtectedMailReadDispatch(configured, readId);
  configured.baseUrl = "https://attacker.example.test"; configured.dbName = "substituted"; configured.token = marker; release();
  assert.equal((await pending).kind, "ok"); assert.ok(captured.startsWith("http://127.0.0.1:32109/"));
  unknown(await beginProtectedMailReadDispatch({ ...options(async () => { calls++; return new Promise<Response>(() => {}); }), timeoutMs: 10 }, readId));
  assert.equal(calls, 2);
});

test("read-plan transport exposes only read-family fixed errors and rejects insecure authority input", async () => {
  for (const reason of ["invalid_request", "inconsistent", "owner_required", "service_required", "event_conflict", "stale", "consumed", "limit_exceeded"]) {
    const error = `protected_mail_read_${reason}`;
    assert.deepEqual(await beginProtectedMailReadDispatch(options(async () => Response.json([1, error])), readId), { kind: "denied", reason: error });
  }
  for (const error of [marker, "protected_mail_connector_stale", "protected_mail_inference_consumed"]) {
    unknown(await beginProtectedMailReadDispatch(options(async () => Response.json([1, error])), readId));
  }
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; return Response.json([0, reply()]); };
  for (const baseUrl of ["http://mail.example.test", "https://example.test/", "https://user:pass@example.test", "https://example.test?", "https://example.test/#"]) {
    assert.deepEqual(await beginProtectedMailReadDispatch({ ...options(fetchImpl), baseUrl }, readId), { kind: "denied", reason: "invalid_request" });
  }
  assert.deepEqual(await beginProtectedMailReadDispatch(options(fetchImpl), marker), { kind: "denied", reason: "invalid_request" });
  assert.equal(calls, 0);
});
