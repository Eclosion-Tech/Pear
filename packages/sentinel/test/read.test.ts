import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalConnectorRead, canonicalConnectorSelection, prepareConnectorRead } from "../src/index.js";
import type { ConnectorReadV1, ConnectorSelectionV1 } from "../src/index.js";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function readId(selectionId: string): string {
  const hash = createHash("sha256");
  for (const field of ["pear-mail-read-grant-v1", selectionId]) { const bytes = Buffer.from(field), length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length).update(bytes); }
  return hash.digest("hex");
}
function selection(): ConnectorSelectionV1 {
  return { formatVersion: 1, kind: "mail.connector.selection", selectionId: "a".repeat(64), workspaceId: "b".repeat(64), ownerId: "c".repeat(64),
    connection: { id: "18446744073709551615", epoch: "9007199254740993", snapshotDigest: "d".repeat(64) }, connector: { identity: "e".repeat(64), runtimeId: "fixture-runtime", runId: "fixture-run" },
    mailbox: { host: "imap.example.test", port: 993, username: 'quoted"user\\@example.test', folder: 'Inbox "quoted"\\', direction: "received" },
    selection: { mode: "stored_batch", uidValidity: "4294967295", expectedCursorGeneration: "18446744073709551615", previousCursorDigest: "f".repeat(64), fromUid: 2, throughUid: 3, uids: [2, 3], maxAcknowledgedBytes: 1 },
    notBeforeMs: 1700000000000, expiresAtMs: 1700003600000 };
}
function plan(selected = selection(), total = 1048576): ConnectorReadV1 {
  return { formatVersion: 1, kind: "mail.connector.read", limits: { maxMessageBytes: 524288, maxTotalBytes: total }, profile: "imap.uid-body-peek.v1", readId: readId(selected.selectionId),
    reservation: { bodyBytes: total, messageSlots: selected.selection.uids.length, operations: 1 }, selection: selected, selectionDigest: digest(canonicalConnectorSelection(selected)!) };
}

test("escaped independent golden commits exact nested selection and full MIME reservation", async () => {
  const value = plan(), canonical = canonicalConnectorRead(value)!;
  assert.equal(digest(canonicalConnectorSelection(value.selection)!), "1b4aaef21712b771ea1f572405ab0aed20c5094fa6f0769f51b5193e0f4558d6");
  assert.equal(value.readId, "bd59b410c67e7ef343f8d6b4689fc9bb74ccbc402b97fbbc8550710ef3ddae2c");
  // Independently computed with Python canonical UTF-8 JSON, also tested in Rust.
  assert.equal(Buffer.byteLength(canonical), 1442); assert.equal(digest(canonical), "a7e0e6e8f0f6ec10dce608184b518799b2f2b3323094c0fcffc851e110de0b90");
  assert.deepEqual(Object.keys(JSON.parse(canonical)), ["formatVersion", "kind", "limits", "profile", "readId", "reservation", "selection", "selectionDigest"]);
  const result = await prepareConnectorRead(value); assert.equal(result.status, "prepared");
  assert.equal(result.read.canonical, canonical); assert.equal(result.read.planBytes, 1442); assert.equal(result.read.planDigest, digest(canonical));
  assert.equal(Buffer.from(result.read.copyPayload()).toString("utf8"), canonical);
  assert.ok(!("permit" in result.read) && !("operation" in result.read) && !("credentials" in result.read));
});

test("Unicode independent golden preserves exact scalars, u32 boundaries and precision-safe u64 strings", async () => {
  const selected: ConnectorSelectionV1 = { ...selection(), connection: { id: "9007199254740993", epoch: "18446744073709551615", snapshotDigest: "d".repeat(64) },
    mailbox: { host: "imap.example.test", port: 65535, username: "日本語🍐e\u0301\u2028@example.test", folder: "送信済み🍐\u2028e\u0301", direction: "sent" },
    selection: { mode: "stored_batch", uidValidity: "7", expectedCursorGeneration: "18446744073709551615", previousCursorDigest: "f".repeat(64), fromUid: 4294967288, throughUid: 4294967295,
      uids: Array.from({ length: 8 }, (_, index) => 4294967288 + index), maxAcknowledgedBytes: 2097152 } };
  const value = plan(selected, 2097152), canonical = canonicalConnectorRead(value)!;
  assert.equal(value.selectionDigest, "54e5e98a4f7f972833b3796b1e7f7d6bc5f2e6a8464a7e12ec96537130ba2197");
  assert.equal(Buffer.byteLength(canonical), 1548); assert.equal(digest(canonical), "b857747278ce1db25100cb32e73d1b142872a54ce70d46f1132e4079716fe3c2");
  const result = await prepareConnectorRead(value); assert.equal(result.status, "prepared");
  assert.equal(result.read.manifest.selection.connection.id, "9007199254740993"); assert.equal(result.read.manifest.selection.mailbox.folder, selected.mailbox.folder);
});

test("full preparation verifies both embedded commitments rather than merely accepting their format", async () => {
  for (const value of [{ ...plan(), selectionDigest: "a".repeat(64) }, { ...plan(), readId: "b".repeat(64) },
    { ...plan(), selection: { ...selection(), ownerId: "f".repeat(64) } }, { ...plan(), selection: { ...selection(), selectionId: "b".repeat(64) } }]) {
    assert.ok(canonicalConnectorRead(value)); // Structural serialization makes no hash/authority claim.
    assert.deepEqual(await prepareConnectorRead(value), { status: "denied", reason: "invalid_connector_read" });
  }
  // Honest re-commitment is structurally valid, not evidence of authorization.
  assert.equal((await prepareConnectorRead(plan({ ...selection(), ownerId: "f".repeat(64) }))).status, "prepared");
});

test("canonical key order is independent of object insertion but every complete selection field remains binding", async () => {
  const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, value]) => [key, reverse(value)])) : value;
  const original = plan(), canonical = canonicalConnectorRead(original)!;
  assert.equal(canonicalConnectorRead(reverse(original)), canonical); assert.equal((await prepareConnectorRead(reverse(original))).status, "prepared");
  for (const selected of [{ ...selection(), mailbox: { ...selection().mailbox, folder: "other" } }, { ...selection(), connection: { ...selection().connection, epoch: "1" } },
    { ...selection(), connector: { ...selection().connector, runId: "other" } }, { ...selection(), selection: { ...selection().selection, previousCursorDigest: "b".repeat(64) } },
    { ...selection(), expiresAtMs: selection().expiresAtMs + 1 }]) assert.notEqual(canonicalConnectorRead(plan(selected)), canonical);
});

test("eight-key declaration rejects raw commands, sources, bodies, credentials and execution authority", async () => {
  const value = plan();
  for (const key of Object.keys(value)) { const copy = { ...value } as Record<string, unknown>; delete copy[key]; assert.equal(canonicalConnectorRead(copy), undefined); }
  for (const extra of [{ body: "PRIVATE_READ_MARKER" }, { password: "PRIVATE_READ_MARKER" }, { command: "FETCH" }, { readGrant: true }, { approved: true }, { sources: [] }, { children: [] }]) {
    assert.equal(canonicalConnectorRead({ ...value, ...extra }), undefined); assert.equal((await prepareConnectorRead({ ...value, ...extra })).status, "denied");
  }
  for (const change of [{ formatVersion: 2 }, { kind: "mail.read" }, { profile: "imap.search.v1" }, { readId: "A".repeat(64) }, { selectionDigest: `0x${"a".repeat(64)}` }]) assert.equal(canonicalConnectorRead({ ...value, ...change }), undefined);
  assert.equal(canonicalConnectorRead({ ...value, limits: { ...value.limits, wireBytes: 1 } }), undefined);
  assert.equal(canonicalConnectorRead({ ...value, reservation: { ...value.reservation, actualBodyBytes: 1 } }), undefined);
});

test("read grant cannot adopt NewOnly or widen/reorder a UID window", () => {
  const value = plan();
  for (const change of [{ mode: "new_only", expectedCursorGeneration: "0", previousCursorDigest: "", fromUid: 0, throughUid: 1, uids: [], maxAcknowledgedBytes: 0 },
    { uids: [3, 2] }, { uids: [2, 4], throughUid: 4 }, { uidValidity: "4294967296" }, { expectedCursorGeneration: "01" }, { throughUid: 4294967296 }]) {
    assert.equal(canonicalConnectorRead({ ...value, selection: { ...selection(), selection: { ...selection().selection, ...change } } }), undefined);
  }
});

test("RAW literal limits are bounded independently from S1 acknowledged bytes", async () => {
  const value = plan(); assert.equal(value.selection.selection.maxAcknowledgedBytes, 1); assert.equal((await prepareConnectorRead(value)).status, "prepared");
  for (const limits of [{ maxMessageBytes: 0, maxTotalBytes: 1 }, { maxMessageBytes: 524289, maxTotalBytes: 1048576 }, { maxMessageBytes: 524288, maxTotalBytes: 2097153 },
    { maxMessageBytes: 2, maxTotalBytes: 1 }, { maxMessageBytes: 2, maxTotalBytes: 5 }, { maxMessageBytes: 1.5, maxTotalBytes: 2 }, { maxMessageBytes: "1", maxTotalBytes: 2 }, { maxMessageBytes: NaN, maxTotalBytes: 2 }]) {
    assert.equal(canonicalConnectorRead({ ...value, limits, reservation: { bodyBytes: limits.maxTotalBytes, messageSlots: 2, operations: 1 } }), undefined);
  }
  assert.ok(canonicalConnectorRead({ ...value, limits: { maxMessageBytes: 2, maxTotalBytes: 3 }, reservation: { bodyBytes: 3, messageSlots: 2, operations: 1 } }));
});

test("reservation is the full total cap, exact UID count and one operation without usage/refund fields", () => {
  for (const change of [{ bodyBytes: 1048575 }, { messageSlots: 1 }, { messageSlots: 3 }, { operations: 0 }, { operations: 2 }, { bodyBytes: "1048576" }]) assert.equal(canonicalConnectorRead({ ...plan(), reservation: { ...plan().reservation, ...change } }), undefined);
});

test("before-await copying and frozen held bytes defeat mutable original/returned aliases", async () => {
  const value = structuredClone(plan()), pending = prepareConnectorRead(value);
  (value.selection.mailbox as { folder: string }).folder = "changed"; (value.selection.selection.uids as number[])[0] = 1;
  (value.limits as { maxMessageBytes: number }).maxMessageBytes = 1;
  const result = await pending; assert.equal(result.status, "prepared"); assert.equal(result.read.canonical, canonicalConnectorRead(plan()));
  assert.ok(Object.isFrozen(result.read) && Object.isFrozen(result.read.manifest.selection.selection.uids) && Object.isFrozen(result.read.manifest.limits));
  result.read.copyPayload().fill(0); assert.equal(digest(result.read.copyPayload()), result.read.planDigest);
});

test("hostile descriptors and proxies return fixed failures without data getters or raw error details", async () => {
  let invoked = false;
  const getter = { ...plan() }; Object.defineProperty(getter, "selectionDigest", { enumerable: true, get() { invoked = true; throw Error("PRIVATE_READ_MARKER"); } });
  const nested = { ...selection().mailbox }; Object.defineProperty(nested, "folder", { enumerable: true, get() { invoked = true; throw Error("PRIVATE_READ_MARKER"); } });
  const array = [2, 3]; Object.defineProperty(array, "0", { enumerable: true, get() { invoked = true; throw Error("PRIVATE_READ_MARKER"); } });
  const hidden = { ...plan() }; Object.defineProperty(hidden, "private", { value: "PRIVATE_READ_MARKER", enumerable: false });
  const inherited = Object.assign(Object.create({ approved: true }), plan());
  for (const value of [getter, { ...plan(), selection: { ...selection(), mailbox: nested } }, { ...plan(), selection: { ...selection(), selection: { ...selection().selection, uids: array } } },
    hidden, inherited, { ...plan(), [Symbol("private")]: true }, new Proxy({}, { getPrototypeOf() { throw Error("PRIVATE_READ_MARKER"); } })]) {
    assert.equal(canonicalConnectorRead(value), undefined); assert.deepEqual(await prepareConnectorRead(value), { status: "denied", reason: "invalid_connector_read" });
  }
  assert.equal(invoked, false);
});
