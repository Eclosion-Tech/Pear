import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalConnectorSparseCheckpoint, prepareConnectorSparseCheckpoint, type ConnectorSparseCheckpointV1 } from "../src/index.js";

function plan(): ConnectorSparseCheckpointV1 {
  return { formatVersion: 1, kind: "mail.connector.sparse_checkpoint", checkpointId: "cb02833267b2d0d17f273c7f04efc48a5431674e7652de4226465aa7d4a2268e",
    eventNonce: "b".repeat(64), workspaceId: "c".repeat(64), ownerId: "d".repeat(64),
    connection: { id: "9007199254740993", epoch: "18446744073709551615", snapshotDigest: "e".repeat(64) },
    connector: { identity: "f".repeat(64), runtimeId: "fixture-runtime", runId: "fixture-run" },
    mailbox: { host: "imap.example.test", port: 993, username: "fixture@example.test", folder: '受信🍐e\u0301"\\\u2028', direction: "received" },
    cursor: { id: "mail-connector-cursor:" + "1".repeat(64), generation: "18446744073709551615", digest: "2".repeat(64), uidValidity: "4294967295", lastUid: 4294967291 },
    observation: { id: "a".repeat(64), digest: "3".repeat(64), manifestDigest: "4".repeat(64), headId: "mail-discovery-head:" + "5".repeat(64), headGeneration: "18446744073709551615",
      uidValidity: "4294967295", uidNext: 4294967295, fromUid: 4294967292, throughUid: 4294967294, presentUids: [4294967292, 4294967294], absentUids: [4294967293] },
    sources: [{ uid: 4294967292, source: { id: "mail-source:9007199254740993:" + "6".repeat(64), revision: "1", digest: "7".repeat(64) }, bytes: 512 },
      { uid: 4294967294, source: { id: "mail-source:9007199254740993:" + "8".repeat(64), revision: "1", digest: "9".repeat(64) }, bytes: 777 }],
    acknowledgedBytes: 1289, maxAcknowledgedBytes: 2097152, notBeforeMs: 1700000000000, expiresAtMs: 1700003600000 };
}
const invalid = { status: "denied", reason: "invalid_connector_sparse_checkpoint" };
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function allAbsent(): ConnectorSparseCheckpointV1 {
  const value = plan(); return { ...value, observation: { ...value.observation, presentUids: [], absentUids: [4294967292, 4294967293, 4294967294] }, sources: [], acknowledgedBytes: 0, maxAcknowledgedBytes: 0 };
}

test("sparse manifest binds exact Unicode, full u64 strings and independently generated canonical vectors", async () => {
  for (const [value, bytes, digest] of [[plan(), 2216, "55d6b4b0cdcf92bebd13ef4cf097b39b7e0b2b940858781bd015a76a73162502"],
    [allAbsent(), 1741, "e5c8a6bbd43f1f0c75782dc1db3302719bfcdf586b1e257dc4f41a1dba01e064"]] as const) {
    const result = await prepareConnectorSparseCheckpoint(value); assert.equal(result.status, "prepared"); if (result.status !== "prepared") continue;
    const held = result.checkpoint;
    // Python json.dumps(sort_keys=True,ensure_ascii=False,separators=(',',':'))
    // plus independent length-prefixed hashlib checkpoint ID calculation.
    assert.equal(held.manifestBytes, bytes); assert.equal(held.manifestDigest, digest);
    assert.equal(Buffer.byteLength(held.canonical), bytes); assert.equal(hash(held.copyPayload()), digest);
    assert.equal(held.manifest.mailbox.folder, value.mailbox.folder); assert.equal(held.manifest.connection.id, "9007199254740993");
    const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, item]) => [k, sorted(item)])) : v;
    assert.equal(held.canonical, JSON.stringify(sorted(value))); assert.ok(!("permit" in held));
  }
});

test("present and absent lists must be an exact ordered disjoint bounded partition", async () => {
  const value = plan();
  for (const observation of [
    { ...value.observation, presentUids: [4294967294, 4294967292] }, { ...value.observation, presentUids: [4294967292, 4294967292] },
    { ...value.observation, absentUids: [] }, { ...value.observation, absentUids: [4294967292] },
    { ...value.observation, absentUids: [4294967291] }, { ...value.observation, presentUids: [] },
    { ...value.observation, fromUid: 4294967291 }, { ...value.observation, throughUid: 4294967295 },
    { ...value.observation, uidNext: 4294967294 }, { ...value.observation, uidValidity: "1" },
    { ...value.observation, presentUids: [4294967292, , 4294967294] },
  ]) assert.deepEqual(await prepareConnectorSparseCheckpoint({ ...value, observation }), invalid);
  const zero = { ...allAbsent(), cursor: { ...value.cursor, lastUid: 0 }, observation: { ...value.observation, fromUid: 1, throughUid: 1, uidNext: 2, presentUids: [], absentUids: [1] } };
  assert.equal((await prepareConnectorSparseCheckpoint(zero)).status, "prepared");
  assert.deepEqual(await prepareConnectorSparseCheckpoint({ ...zero, observation: { ...zero.observation, throughUid: 9, uidNext: 10, absentUids: [1, 2, 3, 4, 5, 6, 7, 8, 9] } }), invalid);
});

test("source ordering, exact S1 revision and byte accounting cannot be omitted or expanded", async () => {
  const value = plan(), first = value.sources[0];
  for (const bad of [{ ...value, sources: [...value.sources].reverse() }, { ...value, sources: [first] },
    { ...value, sources: [{ ...first, bytes: 0 }, value.sources[1]] }, { ...value, acknowledgedBytes: 1288 }, { ...value, maxAcknowledgedBytes: 1288 },
    { ...value, maxAcknowledgedBytes: 0 }, { ...value, maxAcknowledgedBytes: 2097153 },
    { ...value, sources: [{ ...first, source: { ...first.source, revision: "2" } }, value.sources[1]] },
    ...["mail-derived-source:" + "6".repeat(64), "mail-source:01:" + "6".repeat(64), "mail-source:18446744073709551616:" + "6".repeat(64)].map(id =>
      ({ ...value, sources: [{ ...first, source: { ...first.source, id } }, value.sources[1]] })),
    { ...allAbsent(), maxAcknowledgedBytes: 1 }, { ...allAbsent(), acknowledgedBytes: 1 }]) assert.deepEqual(await prepareConnectorSparseCheckpoint(bad), invalid);
  const allPresent = { ...value, observation: { ...value.observation, throughUid: value.observation.fromUid, presentUids: [value.observation.fromUid], absentUids: [] },
    sources: [first], acknowledgedBytes: first.bytes, maxAcknowledgedBytes: first.bytes };
  assert.equal((await prepareConnectorSparseCheckpoint(allPresent)).status, "prepared");
  assert.deepEqual(await prepareConnectorSparseCheckpoint({ ...value, sources: value.sources.map(s => ({ ...s, bytes: 2097152 })), acknowledgedBytes: 4194304 }), invalid);
});

test("identity relation is checked in preparation and the whole commitment freezes before awaits", async () => {
  const value = structuredClone(plan()), canonical = canonicalConnectorSparseCheckpoint(value)!;
  const pending = prepareConnectorSparseCheckpoint(value);
  (value.observation.presentUids as number[])[0] = 1; (value.sources[0] as { bytes: number }).bytes = 1;
  const result = await pending; assert.equal(result.status, "prepared"); if (result.status !== "prepared") return;
  assert.equal(result.checkpoint.canonical, canonical); assert.ok(Object.isFrozen(result.checkpoint.manifest.sources[0].source));
  assert.ok(Object.isFrozen(result.checkpoint.manifest.observation.presentUids));
  result.checkpoint.copyPayload().fill(0); assert.equal(hash(result.checkpoint.copyPayload()), result.checkpoint.manifestDigest);
  const wrong = { ...plan(), checkpointId: "0".repeat(64) };
  assert.equal(typeof canonicalConnectorSparseCheckpoint(wrong), "string"); assert.deepEqual(await prepareConnectorSparseCheckpoint(wrong), invalid);
});

test("closed scalar, mailbox, time and canonical numeric constraints reject malformed manifests", async () => {
  const value = plan();
  for (const bad of [{ ...value, expiresAtMs: value.notBeforeMs }, { ...value, expiresAtMs: value.expiresAtMs + 1 }, { ...value, notBeforeMs: -1 },
    { ...value, expiresAtMs: 9007199254740992 }, { ...value, eventNonce: "X".repeat(64) }, { ...value, body: "SPARSE_CHECKPOINT_PRIVATE_SYNTHETIC" },
    { ...value, connection: { ...value.connection, id: "01" } }, { ...value, connection: { ...value.connection, epoch: "18446744073709551616" } },
    { ...value, cursor: { ...value.cursor, generation: "0" } }, { ...value, cursor: { ...value.cursor, uidValidity: "4294967296" } },
    { ...value, observation: { ...value.observation, headGeneration: "00" } }, { ...value, mailbox: { ...value.mailbox, host: "imap.example.test/path" } },
    { ...value, mailbox: { ...value.mailbox, host: "imap\u2028example.test" } }, { ...value, mailbox: { ...value.mailbox, username: "x\u0085y" } },
    { ...value, mailbox: { ...value.mailbox, folder: "\ud800" } }, { ...value, mailbox: { ...value.mailbox, folder: "é".repeat(257) } },
    { ...value, connector: { ...value.connector, runId: "arbitrary text" } }]) assert.deepEqual(await prepareConnectorSparseCheckpoint(bad), invalid);
});

test("own-data fields and dense arrays are checked without invoking content getters or custom iteration", async () => {
  let invoked = false; const value = plan();
  const getter = Object.defineProperty({ ...value }, "observation", { enumerable: true, get() { invoked = true; return value.observation; } });
  const sourceGetter = Object.defineProperty({ ...value.sources[0] }, "source", { enumerable: true, get() { invoked = true; return value.sources[0].source; } });
  const customIterator = Object.assign([...value.observation.presentUids], { [Symbol.iterator]() { invoked = true; throw Error("SPARSE_CHECKPOINT_PRIVATE_SYNTHETIC"); } });
  const indexGetter = Object.defineProperty([...value.observation.presentUids], "0", { enumerable: true, get() { invoked = true; return 4294967292; } });
  for (const bad of [getter, { ...value, sources: [sourceGetter, value.sources[1]] }, { ...value, observation: { ...value.observation, presentUids: customIterator } },
    { ...value, observation: { ...value.observation, presentUids: indexGetter } }, Object.defineProperty({ ...value }, "secret", { value: true }),
    Object.defineProperty({ ...value }, "cursor", { value: value.cursor, enumerable: false }), { ...value, [Symbol("extra")]: true }, Object.assign(Object.create({ approved: true }), value),
    { ...value, sources: Object.assign([...value.sources], { extra: true }) }, new Proxy({}, { getPrototypeOf() { throw Error("SPARSE_CHECKPOINT_PRIVATE_SYNTHETIC"); } })])
    assert.deepEqual(await prepareConnectorSparseCheckpoint(bad), invalid);
  assert.equal(invoked, false);
});
