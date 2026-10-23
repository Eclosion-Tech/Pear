import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beginProtectedMailSparseReadDispatch, type ProtectedMailSparseReadProcedureOptions } from "./protected-mail-sparse-read-dispatch.js";

const readId = "891192f3dd1bb101132702d3c82e07fc3bb76d98f0b127d2bc952e214b0b4509", marker = "SPARSE_READ_PRIVATE_SYNTHETIC_DO_NOT_ECHO";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
function plan() {
  return { formatVersion: 1, kind: "mail.connector.sparse_read", readId, eventNonce: "b".repeat(64), workspaceId: "c".repeat(64), ownerId: "d".repeat(64),
    connection: { id: "9007199254740993", epoch: "18446744073709551615", snapshotDigest: "e".repeat(64) },
    connector: { identity: "f".repeat(64), runtimeId: "fixture-runtime", runId: "fixture-run" },
    mailbox: { host: "imap.example.test", port: 993, username: "fixture@example.test", folder: '受信🍐e\u0301"\\\u2028', direction: "received" },
    cursor: { id: "mail-connector-cursor:" + "1".repeat(64), generation: "18446744073709551615", digest: "2".repeat(64), uidValidity: "4294967295", lastUid: 4294967291 },
    observation: { id: "a".repeat(64), digest: "3".repeat(64), manifestDigest: "4".repeat(64), headId: "mail-discovery-head:" + "5".repeat(64), headGeneration: "18446744073709551615",
      uidValidity: "4294967295", uidNext: 4294967295, fromUid: 4294967292, throughUid: 4294967294, presentUids: [4294967292, 4294967294], absentUids: [4294967293] },
    limits: { maxMessageBytes: 524288, maxTotalBytes: 700000 }, profile: "imap.observed-uid-body-peek.v1",
    reservation: { bodyBytes: 700000, messageSlots: 2, operations: 1 }, notBeforeMs: 1700000000000, expiresAtMs: 1700003600000 };
}
const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === "object"
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)])) : v;
const canonical = () => JSON.stringify(sorted(plan()));
const dto = (): unknown[] => [readId, hash(canonical()), Buffer.byteLength(canonical()), canonical()];
const options = (fetchImpl: typeof fetch): ProtectedMailSparseReadProcedureOptions => ({ baseUrl: "http://127.0.0.1:32109", dbName: "synthetic-sparse-read", token: "synthetic-bearer", fetchImpl });
function unknown(v: unknown) { assert.deepEqual(v, { kind: "unknown", reason: "procedure_outcome_unknown" }); assert.ok(!JSON.stringify(v).includes(marker)); }

test("sparse claim uses only its fixed route and returns exact privately frozen plan metadata", async () => {
  let calls = 0;
  const result = await beginProtectedMailSparseReadDispatch(options(async (input, init) => {
    calls++; assert.equal(String(input), "http://127.0.0.1:32109/v1/database/synthetic-sparse-read/call/begin_protected_mail_sparse_read_dispatch");
    assert.equal(init?.method, "POST"); assert.equal(init?.body, JSON.stringify([readId])); assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "omit"); assert.equal(init?.referrerPolicy, "no-referrer");
    return Response.json([0, dto()]);
  }), readId);
  assert.equal(calls, 1); assert.equal(result.kind, "ok"); if (result.kind !== "ok") return;
  assert.equal(result.value.planBytes, 1837); assert.equal(result.value.planDigest, "15e68420ad194400bbf3f73779336436aed9dc22932d7e0dcb15311564a4b73a");
  assert.equal(result.value.plan.connection.id, "9007199254740993"); assert.deepEqual(result.value.plan.observation.presentUids, [4294967292, 4294967294]);
  assert.ok(Object.isFrozen(result.value) && Object.isFrozen(result.value.plan.observation.presentUids));
  assert.ok(!("password" in result.value) && !("permit" in result.value));
});

test("claim rejects canonical/hash/ID substitution, unsafe byte counts and mismatched sparse profiles", async () => {
  for (const mutate of [(v: unknown[]) => { v[0] = "0".repeat(64); }, (v: unknown[]) => { v[1] = "0".repeat(64); },
    (v: unknown[]) => { v[2] = 9007199254740992; }, (v: unknown[]) => { v[2] = "1837"; }, (v: unknown[]) => { v[2] = 8193; },
    (v: unknown[]) => { v[2] = 1836; }, (v: unknown[]) => { v[3] = JSON.stringify(plan()); v[1] = hash(String(v[3])); v[2] = Buffer.byteLength(String(v[3])); },
    (v: unknown[]) => { v.push(marker); }, (v: unknown[]) => {
      const changed = plan(); changed.observation.id = "0".repeat(64); v[3] = JSON.stringify(sorted(changed)); v[1] = hash(String(v[3])); v[2] = Buffer.byteLength(String(v[3]));
    }, (v: unknown[]) => {
      const changed = plan(); changed.profile = "imap.uid-body-peek.v1"; v[3] = JSON.stringify(sorted(changed)); v[1] = hash(String(v[3])); v[2] = Buffer.byteLength(String(v[3]));
    }]) { const value = dto(); mutate(value); unknown(await beginProtectedMailSparseReadDispatch(options(async () => Response.json([0, value])), readId)); }
});

test("lost committed claim stays unknown; explicit retry receives consumed instead of recovered metadata", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; if (calls === 1) throw Error(marker); return Response.json([1, "protected_mail_sparse_read_consumed"]); };
  unknown(await beginProtectedMailSparseReadDispatch(options(fetchImpl), readId)); assert.equal(calls, 1);
  assert.deepEqual(await beginProtectedMailSparseReadDispatch(options(fetchImpl), readId), { kind: "denied", reason: "protected_mail_sparse_read_consumed" }); assert.equal(calls, 2);
});

test("invalid response headers cancel streams and actual body cap/UTF8 ignores forged lengths", async () => {
  const invalid: ResponseInit[] = [{ status: 500, headers: { "content-type": "application/json" } }, { headers: { "content-type": "text/plain" } },
    { headers: { "content-type": "application/json", "content-length": "16385" } }, { headers: { "content-type": "application/json", "content-length": "01" } }];
  for (const init of invalid) {
    let cancelled = false; const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), init);
    unknown(await beginProtectedMailSparseReadDispatch(options(async () => response), readId)); assert.equal(cancelled, true);
  }
  unknown(await beginProtectedMailSparseReadDispatch(options(async () => new Response(" ".repeat(16385), { headers: { "content-type": "application/json", "content-length": "16" } })), readId));
  unknown(await beginProtectedMailSparseReadDispatch(options(async () => new Response(new Uint8Array([0xc0, 0xaf]), { headers: { "content-type": "application/json" } })), readId));
});

test("hung fetch/body and late success remain unknown with no resend and owned stream cancellation", async () => {
  let calls = 0, release!: (v: Response) => void;
  const pendingFetch = new Promise<Response>(resolve => { release = resolve; });
  const result = await beginProtectedMailSparseReadDispatch({ ...options(async () => { calls++; return pendingFetch; }), timeoutMs: 10 }, readId);
  unknown(result); assert.equal(calls, 1);
  let lateCancelled = false;
  release(new Response(new ReadableStream<Uint8Array>({ cancel() { lateCancelled = true; } }), { headers: { "content-type": "application/json" } }));
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(lateCancelled, true); unknown(result); assert.equal(calls, 1);
  let cancelled = false;
  unknown(await beginProtectedMailSparseReadDispatch({ ...options(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } })), timeoutMs: 10 }, readId));
  assert.equal(cancelled, true);
});

test("host authority options snapshot before awaits and reject accessors/inherited or extra configuration", async () => {
  let invoked = false, calls = 0, sent = "", token = "", release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opts = { ...options(async (url, init) => { calls++; sent = String(url); token = (init?.headers as Record<string, string>).Authorization; await gate; return Response.json([0, dto()]); }) };
  const pending = beginProtectedMailSparseReadDispatch(opts, readId); opts.baseUrl = "https://attacker.example.test"; opts.token = marker; release();
  assert.equal((await pending).kind, "ok"); assert.ok(sent.startsWith("http://127.0.0.1:32109/")); assert.equal(token, "Bearer synthetic-bearer");
  const safeOptions = options(async () => { calls++; return Response.json([0, dto()]); });
  const accessor = Object.defineProperty({ ...safeOptions }, "token", { enumerable: true, get() { invoked = true; return marker; } });
  for (const bad of [accessor, Object.assign(Object.create({ approved: true }), safeOptions), Object.defineProperty({ ...safeOptions }, "token", { value: "x", enumerable: false }),
    { ...safeOptions, [Symbol("extra")]: true }, { ...safeOptions, route: "other" }, { ...safeOptions, baseUrl: "http://mail.example.test" },
    { ...safeOptions, baseUrl: "https://user:pass@mail.example.test" }, { ...safeOptions, baseUrl: "https://mail.example.test?q=1" },
    { ...safeOptions, token: "line\nbreak" }, { ...safeOptions, timeoutMs: 60001 }]) {
    assert.deepEqual(await beginProtectedMailSparseReadDispatch(bad, readId), { kind: "denied", reason: "invalid_request" });
  }
  assert.equal(calls, 1); assert.equal(invoked, false);
});

test("only fixed sparse-read errors cross the boundary; other errors and malformed results stay unknown", async () => {
  for (const suffix of ["invalid_request", "inconsistent", "owner_required", "service_required", "event_conflict", "stale", "consumed", "limit_exceeded"]) {
    const reason = `protected_mail_sparse_read_${suffix}`;
    assert.deepEqual(await beginProtectedMailSparseReadDispatch(options(async () => Response.json([1, reason])), readId), { kind: "denied", reason });
  }
  for (const value of [[1, marker], [1, "protected_mail_read_stale"], [2, dto()], [0, dto(), marker], { ok: dto() }])
    unknown(await beginProtectedMailSparseReadDispatch(options(async () => Response.json(value)), readId));
  let calls = 0;
  assert.deepEqual(await beginProtectedMailSparseReadDispatch(options(async () => { calls++; throw Error(marker); }), marker), { kind: "denied", reason: "invalid_request" }); assert.equal(calls, 0);
});
