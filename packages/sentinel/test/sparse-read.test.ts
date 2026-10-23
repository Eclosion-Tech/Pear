import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalConnectorSparseRead, prepareConnectorSparseRead, canonicalConnectorRead, type ConnectorSparseReadV1 } from "../src/index.js";

function plan(): ConnectorSparseReadV1 {
  return { formatVersion: 1, kind: "mail.connector.sparse_read", readId: "891192f3dd1bb101132702d3c82e07fc3bb76d98f0b127d2bc952e214b0b4509",
    eventNonce: "b".repeat(64), workspaceId: "c".repeat(64), ownerId: "d".repeat(64),
    connection: { id: "9007199254740993", epoch: "18446744073709551615", snapshotDigest: "e".repeat(64) },
    connector: { identity: "f".repeat(64), runtimeId: "fixture-runtime", runId: "fixture-run" },
    mailbox: { host: "imap.example.test", port: 993, username: "fixture@example.test", folder: '受信🍐e\u0301"\\\u2028', direction: "received" },
    cursor: { id: "mail-connector-cursor:" + "1".repeat(64), generation: "18446744073709551615", digest: "2".repeat(64), uidValidity: "4294967295", lastUid: 4294967291 },
    observation: { id: "a".repeat(64), digest: "3".repeat(64), manifestDigest: "4".repeat(64), headId: "mail-discovery-head:" + "5".repeat(64), headGeneration: "18446744073709551615",
      uidValidity: "4294967295", uidNext: 4294967295, fromUid: 4294967292, throughUid: 4294967294, presentUids: [4294967292, 4294967294], absentUids: [4294967293] },
    limits: { maxMessageBytes: 524288, maxTotalBytes: 700000 }, profile: "imap.observed-uid-body-peek.v1",
    reservation: { bodyBytes: 700000, messageSlots: 2, operations: 1 }, notBeforeMs: 1700000000000, expiresAtMs: 1700003600000 };
}
const invalid = { status: "denied", reason: "invalid_connector_sparse_read" };
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function single(): ConnectorSparseReadV1 {
  const value = plan(); return { ...value, cursor: { ...value.cursor, lastUid: 0 },
    observation: { ...value.observation, fromUid: 1, throughUid: 1, uidNext: 2, presentUids: [1], absentUids: [] },
    limits: { maxMessageBytes: 1, maxTotalBytes: 1 }, reservation: { bodyBytes: 1, messageSlots: 1, operations: 1 } };
}

test("sparse read goldens bind exact Unicode/u64 metadata and full raw-MIME reservation", async () => {
  for (const [value, length, digest] of [[plan(), 1837, "15e68420ad194400bbf3f73779336436aed9dc22932d7e0dcb15311564a4b73a"],
    [single(), 1756, "0251b9dbff2f078546716e847f69065f89523f6f1048ccc2ce057a764d8c850f"]] as const) {
    const result = await prepareConnectorSparseRead(value); assert.equal(result.status, "prepared"); if (result.status !== "prepared") continue;
    // Independent Python json.dumps(sort_keys=True,ensure_ascii=False) and
    // length-prefixed hashlib read-ID vectors, mirrored independently in Rust.
    assert.equal(result.read.planBytes, length); assert.equal(result.read.planDigest, digest);
    assert.equal(Buffer.byteLength(result.read.canonical), length); assert.equal(hash(result.read.copyPayload()), digest);
    assert.equal(result.read.manifest.mailbox.folder, value.mailbox.folder); assert.equal(result.read.manifest.connection.id, "9007199254740993");
    const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)])) : v;
    assert.equal(result.read.canonical, JSON.stringify(sorted(value)));
    assert.ok(!("permit" in result.read) && !("operation" in result.read) && !("credentials" in result.read));
    assert.equal(canonicalConnectorRead(value), undefined); // New family cannot widen StoredBatch.
  }
});

test("full preparation checks observation-derived identity while structural commitment grants no authority", async () => {
  for (const value of [{ ...plan(), readId: "0".repeat(64) }, { ...plan(), observation: { ...plan().observation, id: "0".repeat(64) } }]) {
    assert.ok(canonicalConnectorSparseRead(value)); assert.deepEqual(await prepareConnectorSparseRead(value), invalid);
  }
  const value = plan(), reverse = (v: unknown): unknown => Array.isArray(v) ? v.map(reverse) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).reverse().map(([key, item]) => [key, reverse(item)])) : v;
  assert.equal(canonicalConnectorSparseRead(reverse(value)), canonicalConnectorSparseRead(value));
  for (const changed of [{ ...value, ownerId: "a".repeat(64) }, { ...value, observation: { ...value.observation, digest: "a".repeat(64) } },
    { ...value, connector: { ...value.connector, runId: "other" } }, { ...value, mailbox: { ...value.mailbox, folder: "other" } }]) {
    assert.equal((await prepareConnectorSparseRead(changed)).status, "prepared"); assert.notEqual(canonicalConnectorSparseRead(changed), canonicalConnectorSparseRead(value));
  }
});

test("only an exact nonempty bounded partition with nonempty present UIDs can become a sparse read", async () => {
  const value = plan();
  for (const observation of [{ ...value.observation, presentUids: [], absentUids: [4294967292, 4294967293, 4294967294] },
    { ...value.observation, presentUids: [4294967294, 4294967292] }, { ...value.observation, presentUids: [4294967292, 4294967292] },
    { ...value.observation, absentUids: [] }, { ...value.observation, absentUids: [4294967292] }, { ...value.observation, absentUids: [4294967291] },
    { ...value.observation, fromUid: 4294967291 }, { ...value.observation, throughUid: 4294967295 }, { ...value.observation, uidNext: 4294967294 },
    { ...value.observation, uidValidity: "1" }, { ...value.observation, presentUids: [4294967292, , 4294967294] },
    { ...value.observation, presentUids: [4294967292] }, { ...value.observation, throughUid: value.cursor.lastUid }])
    assert.deepEqual(await prepareConnectorSparseRead({ ...value, observation }), invalid);
  const nine = { ...single(), observation: { ...single().observation, throughUid: 9, uidNext: 10, presentUids: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, reservation: { bodyBytes: 1, messageSlots: 9, operations: 1 } };
  assert.deepEqual(await prepareConnectorSparseRead(nine), invalid);
});

test("full caps and reservations are exact without zero-slot reads or usage/refund fields", async () => {
  const value = plan();
  for (const limits of [{ maxMessageBytes: 0, maxTotalBytes: 1 }, { maxMessageBytes: 524289, maxTotalBytes: 700000 }, { maxMessageBytes: 524288, maxTotalBytes: 2097153 },
    { maxMessageBytes: 2, maxTotalBytes: 1 }, { maxMessageBytes: 2, maxTotalBytes: 5 }, { maxMessageBytes: 1.5, maxTotalBytes: 2 }, { maxMessageBytes: "1", maxTotalBytes: 2 },
    { maxMessageBytes: NaN, maxTotalBytes: 2 }, { maxMessageBytes: 1, maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 }])
    assert.deepEqual(await prepareConnectorSparseRead({ ...value, limits, reservation: { bodyBytes: limits.maxTotalBytes, messageSlots: 2, operations: 1 } }), invalid);
  for (const reservation of [{ ...value.reservation, operations: 2 }, { ...value.reservation, messageSlots: 3 }, { ...value.reservation, bodyBytes: 699999 },
    { ...value.reservation, actualBytes: 1 }, { ...value.reservation, refunded: true }]) assert.deepEqual(await prepareConnectorSparseRead({ ...value, reservation }), invalid);
  assert.equal((await prepareConnectorSparseRead({ ...value, limits: { maxMessageBytes: 2, maxTotalBytes: 3 }, reservation: { bodyBytes: 3, messageSlots: 2, operations: 1 } })).status, "prepared");
});

test("closed fields, scalar strings, canonical u64 and times cannot smuggle an alternate contract", async () => {
  const value = plan();
  for (const key of Object.keys(value)) { const copy = { ...value } as Record<string, unknown>; delete copy[key]; assert.deepEqual(await prepareConnectorSparseRead(copy), invalid); }
  for (const bad of [{ ...value, sources: [] }, { ...value, body: "SPARSE_READ_PRIVATE_SYNTHETIC" }, { ...value, approved: true }, { ...value, profile: "imap.uid-body-peek.v1" },
    { ...value, kind: "mail.connector.read" }, { ...value, expiresAtMs: value.notBeforeMs }, { ...value, expiresAtMs: value.expiresAtMs + 1 },
    { ...value, notBeforeMs: -1 }, { ...value, expiresAtMs: 9007199254740992 }, { ...value, readId: "A".repeat(64) },
    { ...value, connection: { ...value.connection, id: "01" } }, { ...value, connection: { ...value.connection, epoch: "18446744073709551616" } },
    { ...value, cursor: { ...value.cursor, generation: "0" } }, { ...value, cursor: { ...value.cursor, uidValidity: "4294967296" } },
    { ...value, observation: { ...value.observation, headGeneration: "00" } }, { ...value, mailbox: { ...value.mailbox, host: "imap.example.test/path" } },
    { ...value, mailbox: { ...value.mailbox, host: "imap\u2028example.test" } }, { ...value, mailbox: { ...value.mailbox, username: "x\u0085y" } },
    { ...value, mailbox: { ...value.mailbox, folder: "\ud800" } }, { ...value, mailbox: { ...value.mailbox, folder: "é".repeat(257) } },
    { ...value, connector: { ...value.connector, runId: "arbitrary text" } }]) assert.deepEqual(await prepareConnectorSparseRead(bad), invalid);
});

test("original mutations and payload-copy aliases cannot change the commitment across crypto awaits", async () => {
  const value = structuredClone(plan()), canonical = canonicalConnectorSparseRead(value)!;
  const pending = prepareConnectorSparseRead(value);
  (value.observation.presentUids as number[])[0] = 1; (value.mailbox as { folder: string }).folder = "changed";
  (value.limits as { maxTotalBytes: number }).maxTotalBytes = 1;
  const result = await pending; assert.equal(result.status, "prepared"); if (result.status !== "prepared") return;
  assert.equal(result.read.canonical, canonical); assert.ok(Object.isFrozen(result.read.manifest.observation.presentUids) && Object.isFrozen(result.read.manifest.limits));
  result.read.copyPayload().fill(0); assert.equal(hash(result.read.copyPayload()), result.read.planDigest);
});

test("own-data validation rejects getters, custom iteration, hidden fields and hostile prototypes without invoking content", async () => {
  let invoked = false; const value = plan();
  const getter = Object.defineProperty({ ...value }, "observation", { enumerable: true, get() { invoked = true; return value.observation; } });
  const custom = Object.assign([...value.observation.presentUids], { [Symbol.iterator]() { invoked = true; throw Error("SPARSE_READ_PRIVATE_SYNTHETIC"); } });
  const indexGetter = Object.defineProperty([...value.observation.presentUids], "0", { enumerable: true, get() { invoked = true; return 4294967292; } });
  const nested = Object.defineProperty({ ...value.mailbox }, "folder", { enumerable: true, get() { invoked = true; return "changed"; } });
  for (const bad of [getter, { ...value, mailbox: nested }, { ...value, observation: { ...value.observation, presentUids: custom } },
    { ...value, observation: { ...value.observation, presentUids: indexGetter } }, Object.defineProperty({ ...value }, "secret", { value: true }),
    Object.defineProperty({ ...value }, "cursor", { value: value.cursor, enumerable: false }), { ...value, [Symbol("extra")]: true }, Object.assign(Object.create({ approved: true }), value),
    { ...value, observation: { ...value.observation, presentUids: Object.assign([...value.observation.presentUids], { extra: true }) } },
    new Proxy({}, { getPrototypeOf() { throw Error("SPARSE_READ_PRIVATE_SYNTHETIC"); } })]) assert.deepEqual(await prepareConnectorSparseRead(bad), invalid);
  assert.equal(invoked, false);
});
