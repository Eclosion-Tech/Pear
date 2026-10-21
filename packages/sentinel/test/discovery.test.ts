import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalConnectorDiscovery, parseMailDiscoveryObservation, prepareConnectorDiscovery, type ConnectorDiscoveryV1 } from "../src/index.js";

function plan(): ConnectorDiscoveryV1 {
  return { formatVersion: 1, kind: "mail.connector.discovery", profile: "imap.uid-discovery.v1", discoveryId: "a".repeat(64), eventNonce: "b".repeat(64), workspaceId: "c".repeat(64), ownerId: "d".repeat(64),
    connection: { id: "9007199254740993", epoch: "18446744073709551615", snapshotDigest: "e".repeat(64) },
    connector: { identity: "f".repeat(64), runtimeId: "fixture-runtime", runId: "fixture-run" },
    mailbox: { host: "imap.example.test", port: 993, username: "fixture@example.test", folder: '受信🍐e\u0301"\\\u2028', direction: "received" },
    cursor: { id: "mail-connector-cursor:" + "1".repeat(64), generation: "18446744073709551615", digest: "2".repeat(64), uidValidity: "4294967295", lastUid: 4294967293 },
    head: { id: "mail-discovery-head:" + "3".repeat(64), generation: "18446744073709551615", digest: "4".repeat(64), observationId: "5".repeat(64), uidValidity: "4294967295", uidNext: 1 },
    window: { mode: "next_window", maxSlots: 8, fromUid: 4294967294, maxThroughUid: 4294967295 },
    notBeforeMs: 1700000000000, expiresAtMs: 1700003600000, reservation: { operations: 1, numericSlots: 8, controlBytes: 65536 } };
}
const invalid = { status: "denied", reason: "invalid_connector_discovery" };
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

test("full discovery commitment preserves exact UTF8, u64 strings and recursively sorted fields", async () => {
  const value = plan(), prepared = await prepareConnectorDiscovery(value);
  assert.equal(prepared.status, "prepared"); if (prepared.status !== "prepared") return;
  const held = prepared.discovery;
  assert.equal(held.manifestBytes, Buffer.byteLength(held.canonical)); assert.equal(held.manifestDigest, hash(held.canonical));
  // Independently generated with Python json.dumps(sort_keys=True,
  // ensure_ascii=False,separators=(',',':')) and hashlib.sha256.
  assert.equal(held.manifestBytes, 1661);
  assert.equal(held.manifestDigest, "94c2cf538ad1b7d3c1273fc2e38dab5942a99f9567a0e5ea34e8f89dc692141f");
  assert.equal(held.manifest.mailbox.folder, value.mailbox.folder); assert.equal(held.manifest.connection.id, "9007199254740993");
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, item]) => [k, sorted(item)])) : v;
  assert.equal(held.canonical, JSON.stringify(sorted(value)));
  assert.ok(!("permit" in held) && !("operation" in held));
});

test("bootstrap is an explicit null-cursor declaration and retained head may lag independent cursor progress", async () => {
  const value = plan();
  assert.equal((await prepareConnectorDiscovery(value)).status, "prepared"); // Head UIDNEXT1 is intentionally behind cursor.
  const bootstrap = { ...value, cursor: null, head: null, window: { mode: "bootstrap", maxSlots: 0, fromUid: null, maxThroughUid: null }, reservation: { operations: 1, numericSlots: 0, controlBytes: 65536 } };
  assert.equal((await prepareConnectorDiscovery(bootstrap)).status, "prepared");
  const frozenBootstrap = await prepareConnectorDiscovery(bootstrap);
  assert.ok(frozenBootstrap.status === "prepared" && frozenBootstrap.discovery.manifestBytes === 1073
    && frozenBootstrap.discovery.manifestDigest === "f2236c40a5781d0795a7f3169f6fa2385bf9794eab67ea5aa6996601f7181a43");
  assert.equal((await prepareConnectorDiscovery({ ...bootstrap, head: value.head })).status, "prepared");
  for (const bad of [{ ...bootstrap, cursor: value.cursor }, { ...bootstrap, window: { ...bootstrap.window, fromUid: 0 } },
    { ...bootstrap, window: { ...bootstrap.window, maxThroughUid: 0 } }, { ...bootstrap, window: { ...bootstrap.window, maxSlots: 1 } },
    { ...bootstrap, reservation: { ...bootstrap.reservation, numericSlots: 1 } }]) assert.deepEqual(await prepareConnectorDiscovery(bad), invalid);
});

test("exact checked next-window arithmetic and fixed reservations prevent expansion or wrap", async () => {
  const value = plan();
  for (const bad of [{ ...value, cursor: null }, { ...value, cursor: { ...value.cursor!, lastUid: 4294967295 } },
    { ...value, window: { ...value.window, maxSlots: 9 } }, { ...value, window: { ...value.window, maxSlots: 0 } },
    { ...value, window: { ...value.window, fromUid: 4294967293 } }, { ...value, window: { ...value.window, maxThroughUid: 4294967294 } },
    { ...value, reservation: { ...value.reservation, operations: 2 } }, { ...value, reservation: { ...value.reservation, controlBytes: 65535 } },
    { ...value, reservation: { ...value.reservation, numericSlots: 7 } }, { ...value, head: { ...value.head!, uidValidity: "7" } }]) assert.deepEqual(await prepareConnectorDiscovery(bad), invalid);
  const zero = { ...value, cursor: { ...value.cursor!, lastUid: 0 }, window: { mode: "next_window", maxSlots: 1, fromUid: 1, maxThroughUid: 1 }, reservation: { ...value.reservation, numericSlots: 1 } };
  assert.equal((await prepareConnectorDiscovery(zero)).status, "prepared");
});

test("times, canonical numbers, roles, profile and closed mailbox strings are bounded", async () => {
  const value = plan();
  for (const bad of [{ ...value, expiresAtMs: value.notBeforeMs }, { ...value, expiresAtMs: value.expiresAtMs + 1 },
    { ...value, notBeforeMs: -1 }, { ...value, expiresAtMs: 9007199254740992 }, { ...value, profile: "imap.search.v1" },
    { ...value, connection: { ...value.connection, id: "01" } }, { ...value, connection: { ...value.connection, epoch: "18446744073709551616" } },
    { ...value, cursor: { ...value.cursor!, generation: "0" } }, { ...value, head: { ...value.head!, uidNext: 4294967296 } },
    { ...value, head: { ...value.head!, observationId: "X".repeat(64) } }, { ...value, mailbox: { ...value.mailbox, host: "imap.example.test/path" } },
    { ...value, mailbox: { ...value.mailbox, host: "imap\u2028example.test" } }, { ...value, mailbox: { ...value.mailbox, username: "x\u0085y" } },
    { ...value, mailbox: { ...value.mailbox, folder: "\ud800" } }, { ...value, mailbox: { ...value.mailbox, folder: "é".repeat(257) } },
    { ...value, connector: { ...value.connector, runtimeId: "model chosen text" } }, { ...value, approved: true }]) assert.deepEqual(await prepareConnectorDiscovery(bad), invalid);
});

test("plan copy and actual bytes freeze before awaits; returned payload copies cannot mutate held commitment", async () => {
  const value = structuredClone(plan()), canonical = canonicalConnectorDiscovery(value)!;
  const pending = prepareConnectorDiscovery(value);
  (value.mailbox as { folder: string }).folder = "changed"; (value.head as { uidNext: number }).uidNext = 99;
  const prepared = await pending; assert.equal(prepared.status, "prepared"); if (prepared.status !== "prepared") return;
  assert.equal(prepared.discovery.canonical, canonical); assert.ok(Object.isFrozen(prepared.discovery.manifest.head));
  prepared.discovery.copyPayload().fill(0); assert.equal(hash(prepared.discovery.copyPayload()), prepared.discovery.manifestDigest);
});

test("own-data validation rejects inherited, hidden, symbol and getter fields without invoking content", async () => {
  let invoked = false;
  const value = plan(), getter = Object.defineProperty({ ...value }, "head", { enumerable: true, get() { invoked = true; throw Error("DISCOVERY_PRIVATE_SYNTHETIC"); } });
  const hidden = Object.defineProperty({ ...value }, "secret", { value: "DISCOVERY_PRIVATE_SYNTHETIC" });
  const nonEnumerable = Object.defineProperty({ ...value }, "head", { value: value.head, enumerable: false });
  for (const bad of [getter, hidden, nonEnumerable, { ...value, [Symbol("extra")]: true }, Object.assign(Object.create({ approved: true }), value),
    new Proxy({}, { getPrototypeOf() { throw Error("DISCOVERY_PRIVATE_SYNTHETIC"); } })]) assert.deepEqual(await prepareConnectorDiscovery(bad), invalid);
  assert.equal(invoked, false);
});

test("observation parser copies only sorted unique present UIDs strictly below canonical UIDNEXT", () => {
  for (const value of [{ uidValidity: "1", uidNext: 1, presentUids: [] }, { uidValidity: "4294967295", uidNext: 4294967295, presentUids: [1, 4294967294] },
    { uidValidity: "7", uidNext: 20, presentUids: [1, 3, 5, 7, 9, 11, 13, 15] }]) {
    const result = parseMailDiscoveryObservation(value); assert.ok(result && Object.isFrozen(result) && Object.isFrozen(result.presentUids));
    value.presentUids.push(18); assert.notEqual(result.presentUids.length, value.presentUids.length);
  }
  for (const bad of [{ uidValidity: "01", uidNext: 2, presentUids: [] }, { uidValidity: "0", uidNext: 2, presentUids: [] },
    { uidValidity: "1", uidNext: 0, presentUids: [] }, { uidValidity: "1", uidNext: 4294967296, presentUids: [] },
    { uidValidity: "1", uidNext: 2, presentUids: [2] }, { uidValidity: "1", uidNext: 2, presentUids: [0] },
    { uidValidity: "1", uidNext: 10, presentUids: [2, 1] }, { uidValidity: "1", uidNext: 10, presentUids: [1, 1] },
    { uidValidity: "1", uidNext: 20, presentUids: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, { uidValidity: "1", uidNext: 2, presentUids: [], absentUids: [1] },
    { uidValidity: "1", uidNext: 10, presentUids: [1, , 3] }]) assert.equal(parseMailDiscoveryObservation(bad), undefined);
});

test("observation getters, custom iteration, hidden fields and prototypes never supply declarations", () => {
  let invoked = false;
  const uids = Object.defineProperty([1], "0", { enumerable: true, get() { invoked = true; return 1; } });
  const iterated = Object.assign([1], { [Symbol.iterator]() { invoked = true; throw Error("DISCOVERY_PRIVATE_SYNTHETIC"); } });
  const data = { uidValidity: "7", uidNext: 3, presentUids: [1] };
  for (const bad of [{ ...data, presentUids: uids }, { ...data, presentUids: iterated },
    Object.defineProperty({ ...data }, "uidNext", { enumerable: true, get() { invoked = true; return 3; } }),
    Object.defineProperty({ ...data }, "extra", { value: true }), Object.assign(Object.create({ approved: true }), data)]) assert.equal(parseMailDiscoveryObservation(bad), undefined);
  assert.equal(invoked, false);
});
