import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalConnectorDiscovery } from "../../../packages/sentinel/src/index.js";
import { beginProtectedMailDiscoveryDispatch, type ProtectedMailDiscoveryProcedureOptions } from "./protected-mail-discovery-dispatch.js";

const id = "a".repeat(64), marker = "DISCOVERY_PRIVATE_SYNTHETIC_NO_ECHO";
function plan(): Record<string, unknown> {
  return { formatVersion: 1, kind: "mail.connector.discovery", profile: "imap.uid-discovery.v1", discoveryId: id, eventNonce: "b".repeat(64), workspaceId: "c".repeat(64), ownerId: "d".repeat(64),
    connection: { id: "9007199254740993", epoch: "2", snapshotDigest: "e".repeat(64) }, connector: { identity: "f".repeat(64), runtimeId: "fixture-discovery", runId: "fixture-run" },
    mailbox: { host: "mail.example.test", port: 993, username: "fixture@example.test", folder: "Inbox 雪", direction: "received" }, cursor: null, head: null,
    window: { mode: "bootstrap", maxSlots: 0, fromUid: null, maxThroughUid: null }, notBeforeMs: 1, expiresAtMs: 3000001,
    reservation: { operations: 1, numericSlots: 0, controlBytes: 65536 } };
}
function reply(canonical = canonicalConnectorDiscovery(plan())!): unknown[] {
  return [id, createHash("sha256").update(canonical).digest("hex"), Buffer.byteLength(canonical), canonical];
}
const options = (fetchImpl: typeof fetch): ProtectedMailDiscoveryProcedureOptions =>
  ({ baseUrl: "http://127.0.0.1:32109", dbName: "synthetic-discovery-workspace", token: "synthetic-bearer", fetchImpl });
const unknown = (value: unknown) => { assert.deepEqual(value, { kind: "unknown", reason: "procedure_outcome_unknown" }); assert.ok(!JSON.stringify(value).includes(marker)); };

test("discovery claim uses only its fixed route and verifies canonical exact metadata", async () => {
  let calls = 0;
  const result = await beginProtectedMailDiscoveryDispatch(options(async (input, init) => {
    calls++; assert.equal(String(input), "http://127.0.0.1:32109/v1/database/synthetic-discovery-workspace/call/begin_protected_mail_discovery_dispatch");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store"); assert.equal(init?.referrerPolicy, "no-referrer"); assert.equal(init?.body, JSON.stringify([id]));
    return Response.json([0, reply()]);
  }), id);
  assert.equal(calls, 1); assert.equal(result.kind, "ok"); if (result.kind !== "ok") return;
  assert.equal(result.value.plan.connection.id, "9007199254740993"); assert.equal(result.value.plan.mailbox.folder, "Inbox 雪");
  assert.equal(result.value.manifestBytes, Buffer.byteLength(result.value.canonical));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.value) && Object.isFrozen(result.value.plan.window));
});

test("lost claim stays consumed with no automatic retry or observation fallback", async () => {
  let calls = 0, consumed = false;
  const fetchImpl: typeof fetch = async () => { calls++; if (!consumed) { consumed = true; throw Error(marker); } return Response.json([1, "protected_mail_discovery_consumed"]); };
  unknown(await beginProtectedMailDiscoveryDispatch(options(fetchImpl), id)); assert.equal(calls, 1); assert.equal(consumed, true);
  assert.deepEqual(await beginProtectedMailDiscoveryDispatch(options(fetchImpl), id), { kind: "denied", reason: "protected_mail_discovery_consumed" }); assert.equal(calls, 2);
});

test("claim rejects substituted IDs, noncanonical bytes, rehashed invalid contracts and metadata channels", async () => {
  for (const mutate of [(v: unknown[]) => { v[0] = "0".repeat(64); }, (v: unknown[]) => { v[1] = "0".repeat(64); },
    (v: unknown[]) => { v[2] = Number(v[2]) - 1; }, (v: unknown[]) => { v.push(marker); }]) {
    const value = reply(); mutate(value); unknown(await beginProtectedMailDiscoveryDispatch(options(async () => Response.json([0, value])), id));
  }
  for (const changed of [{ ...plan(), discoveryId: "0".repeat(64) }, { ...plan(), profile: "imap.search.v1" },
    { ...plan(), approved: true }, { ...plan(), reservation: { operations: 1, numericSlots: 0, controlBytes: 65537 } },
    { ...plan(), window: { mode: "bootstrap", maxSlots: 0, fromUid: 0, maxThroughUid: 0 } }]) {
    unknown(await beginProtectedMailDiscoveryDispatch(options(async () => Response.json([0, reply(JSON.stringify(changed))])), id));
  }
  const noncanonical = " " + canonicalConnectorDiscovery(plan())!;
  unknown(await beginProtectedMailDiscoveryDispatch(options(async () => Response.json([0, reply(noncanonical)])), id));
});

test("claim bounds actual reply streams and cancels a stalled body without retry", async () => {
  for (const response of [new Response(" ".repeat(16385), { headers: { "content-type": "application/json", "content-length": "1" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }), new Response(marker, { status: 500 }),
    new Response("{}", { headers: { "content-type": "text/plain" } })]) unknown(await beginProtectedMailDiscoveryDispatch(options(async () => response), id));
  let calls = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  unknown(await beginProtectedMailDiscoveryDispatch({ ...options(async () => { calls++; return new Response(body, { headers: { "content-type": "application/json" } }); }), timeoutMs: 10 }, id));
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test("claim snapshots authority before await and exposes only fixed discovery denials", async () => {
  let release!: () => void, target = "", auth = "";
  const gate = new Promise<void>(resolve => { release = resolve; });
  const configured = { ...options(async (input, init) => { target = String(input); auth = String((init?.headers as Record<string, string>).Authorization); await gate; return Response.json([0, reply()]); }) };
  const pending = beginProtectedMailDiscoveryDispatch(configured, id); configured.baseUrl = "https://attacker.example.test"; configured.token = marker; release();
  assert.equal((await pending).kind, "ok"); assert.ok(target.startsWith("http://127.0.0.1:32109/")); assert.equal(auth, "Bearer synthetic-bearer");
  for (const suffix of ["invalid_request", "inconsistent", "owner_required", "service_required", "event_conflict", "stale", "consumed", "limit_exceeded"]) {
    const reason = `protected_mail_discovery_${suffix}`;
    assert.deepEqual(await beginProtectedMailDiscoveryDispatch(options(async () => Response.json([1, reason])), id), { kind: "denied", reason });
  }
  for (const reason of [marker, "protected_mail_read_consumed"]) unknown(await beginProtectedMailDiscoveryDispatch(options(async () => Response.json([1, reason])), id));
});

test("invalid authority or discovery ID cannot dispatch credentials", async () => {
  let calls = 0; const configured = options(async () => { calls++; return Response.json([0, reply()]); });
  for (const patch of [{ baseUrl: "http://mail.example.test" }, { baseUrl: configured.baseUrl + "/" }, { baseUrl: configured.baseUrl + "?" },
    { baseUrl: "https://user:pass@example.test" }, { dbName: "../other" }, { token: "unsafe\ncredential" }, { timeoutMs: 0 }])
    assert.deepEqual(await beginProtectedMailDiscoveryDispatch({ ...configured, ...patch }, id), { kind: "denied", reason: "invalid_request" });
  assert.deepEqual(await beginProtectedMailDiscoveryDispatch(configured, marker), { kind: "denied", reason: "invalid_request" }); assert.equal(calls, 0);
});
