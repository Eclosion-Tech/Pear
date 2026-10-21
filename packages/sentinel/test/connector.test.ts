import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalConnectorSelection, prepareConnectorSelection } from "../src/index.js";
import type { ConnectorSelectionV1 } from "../src/index.js";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function bootstrap(): ConnectorSelectionV1 {
  return { formatVersion: 1, kind: "mail.connector.selection", selectionId: "a".repeat(64), workspaceId: "b".repeat(64), ownerId: "c".repeat(64),
    connection: { id: "18446744073709551615", epoch: "9007199254740993", snapshotDigest: "d".repeat(64) },
    connector: { identity: "e".repeat(64), runtimeId: "fixture-runtime", runId: "fixture-run" },
    mailbox: { host: "imap.example.test", port: 993, username: 'quoted"user\\@example.test', folder: 'Inbox "quoted"\\', direction: "received" },
    selection: { mode: "new_only", uidValidity: "4294967295", expectedCursorGeneration: "0", previousCursorDigest: "", fromUid: 0, throughUid: 0, uids: [], maxAcknowledgedBytes: 0 },
    notBeforeMs: 1700000000000, expiresAtMs: 1700003600000 };
}
function batch(): ConnectorSelectionV1 {
  return { ...bootstrap(), connection: { id: "9007199254740993", epoch: "18446744073709551615", snapshotDigest: "d".repeat(64) },
    mailbox: { host: "imap.example.test", port: 65535, username: "日本語🍐e\u0301\u2028@example.test", folder: "送信済み🍐\u2028e\u0301", direction: "sent" },
    selection: { mode: "stored_batch", uidValidity: "7", expectedCursorGeneration: "18446744073709551615", previousCursorDigest: "f".repeat(64),
      fromUid: 4294967288, throughUid: 4294967295, uids: Array.from({ length: 8 }, (_, index) => 4294967288 + index), maxAcknowledgedBytes: 2097152 } };
}

test("escaped bootstrap golden binds all eleven metadata keys without a network operation", async () => {
  const canonical = canonicalConnectorSelection(bootstrap())!;
  // Independent Python UTF-8 canonical JSON vectors, also asserted in Rust.
  assert.equal(Buffer.byteLength(canonical), 968);
  assert.equal(digest(canonical), "a943ecf05316032f36e90c6c20c52c6cef8aaac357a82861d34a97e9b7c8bc25");
  assert.deepEqual(Object.keys(JSON.parse(canonical)), ["connection", "connector", "expiresAtMs", "formatVersion", "kind", "mailbox", "notBeforeMs", "ownerId", "selection", "selectionId", "workspaceId"]);
  const prepared = await prepareConnectorSelection(bootstrap()); assert.equal(prepared.status, "prepared");
  assert.equal(prepared.selection.canonical, canonical); assert.equal(prepared.selection.manifestDigest, digest(canonical));
  assert.equal(prepared.selection.manifestBytes, 968); assert.equal(Buffer.from(prepared.selection.copyPayload()).toString("utf8"), canonical);
  assert.ok(!("operation" in prepared.selection) && !("permit" in prepared.selection) && !("credentials" in prepared.selection));
});

test("Unicode batch golden preserves scalar bytes, contiguous u32 endpoints and decimal u64 precision", () => {
  const canonical = canonicalConnectorSelection(batch())!;
  assert.equal(Buffer.byteLength(canonical), 1164);
  assert.equal(digest(canonical), "54e5e98a4f7f972833b3796b1e7f7d6bc5f2e6a8464a7e12ec96537130ba2197");
  const value = JSON.parse(canonical); assert.deepEqual(value.selection.uids, batch().selection.uids);
  assert.equal(value.mailbox.folder, batch().mailbox.folder); assert.equal(value.mailbox.username, batch().mailbox.username);
  assert.equal(value.connection.id, "9007199254740993"); assert.equal(value.connection.epoch, "18446744073709551615");
});

test("object key order is canonical but endpoint, identity, time, account and cursor fields remain exact", () => {
  const original = batch(), canonical = canonicalConnectorSelection(original)!;
  const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, value]) => [key, reverse(value)])) : value;
  assert.equal(canonicalConnectorSelection(reverse(original)), canonical);
  for (const value of [
    { ...original, workspaceId: "a".repeat(64) }, { ...original, ownerId: "a".repeat(64) }, { ...original, selectionId: "b".repeat(64) },
    { ...original, connection: { ...original.connection, id: "1" } }, { ...original, connection: { ...original.connection, epoch: "1" } },
    { ...original, connection: { ...original.connection, snapshotDigest: "a".repeat(64) } },
    { ...original, connector: { ...original.connector, identity: "a".repeat(64) } }, { ...original, connector: { ...original.connector, runtimeId: "different" } },
    { ...original, connector: { ...original.connector, runId: "different" } }, { ...original, mailbox: { ...original.mailbox, host: "other.example.test" } },
    { ...original, mailbox: { ...original.mailbox, port: 993 } }, { ...original, mailbox: { ...original.mailbox, username: "other@example.test" } },
    { ...original, mailbox: { ...original.mailbox, folder: "other" } }, { ...original, mailbox: { ...original.mailbox, direction: "received" } },
    { ...original, selection: { ...original.selection, uidValidity: "8" } }, { ...original, selection: { ...original.selection, expectedCursorGeneration: "1" } },
    { ...original, selection: { ...original.selection, previousCursorDigest: "a".repeat(64) } }, { ...original, selection: { ...original.selection, maxAcknowledgedBytes: 1 } },
    { ...original, notBeforeMs: original.notBeforeMs + 1 }, { ...original, expiresAtMs: original.expiresAtMs + 1 },
  ]) assert.notEqual(canonicalConnectorSelection(value), canonical);
  assert.notEqual(canonicalConnectorSelection({ ...original, mailbox: { ...original.mailbox, folder: "é" } }), canonicalConnectorSelection({ ...original, mailbox: { ...original.mailbox, folder: "e\u0301" } }));
});

test("closed metadata cannot accept bodies, read commands, credentials or authority flags", () => {
  const value = bootstrap();
  for (const key of Object.keys(value)) { const copy = { ...value } as Record<string, unknown>; delete copy[key]; assert.equal(canonicalConnectorSelection(copy), undefined); }
  for (const extra of [{ body: "private" }, { command: "FETCH" }, { password: "private" }, { approved: true }, { grant: true }, { childRun: "child" }]) assert.equal(canonicalConnectorSelection({ ...value, ...extra }), undefined);
  for (const change of [{ formatVersion: 2 }, { kind: "mail.read" }, { selectionId: "A".repeat(64) }, { ownerId: `0x${"a".repeat(64)}` }]) assert.equal(canonicalConnectorSelection({ ...value, ...change }), undefined);
  for (const key of ["connection", "connector", "mailbox", "selection"] as const) assert.equal(canonicalConnectorSelection({ ...value, [key]: { ...value[key], extra: true } }), undefined);
});

test("u64 and u32 decimal strings never accept rounding, zero validity or noncanonical representations", () => {
  for (const value of ["0", "01", "+1", "-1", "1.0", "1e1", "18446744073709551616", 1, 9007199254740993, null]) {
    assert.equal(canonicalConnectorSelection({ ...bootstrap(), connection: { ...bootstrap().connection, id: value } }), undefined);
    assert.equal(canonicalConnectorSelection({ ...batch(), selection: { ...batch().selection, expectedCursorGeneration: value } }), undefined);
  }
  for (const value of ["0", "01", "+1", "4294967296", "18446744073709551615", 7]) assert.equal(canonicalConnectorSelection({ ...batch(), selection: { ...batch().selection, uidValidity: value } }), undefined);
});

test("new-only encodes only an explicit empty bootstrap and never UIDNEXT overflow or a hidden batch", () => {
  for (const change of [{ expectedCursorGeneration: "1" }, { previousCursorDigest: "a".repeat(64) }, { fromUid: 1 }, { uids: [1] }, { maxAcknowledgedBytes: 1 }, { throughUid: 4294967295 }, { throughUid: -1 }]) {
    assert.equal(canonicalConnectorSelection({ ...bootstrap(), selection: { ...bootstrap().selection, ...change } }), undefined);
  }
  assert.ok(canonicalConnectorSelection({ ...bootstrap(), selection: { ...bootstrap().selection, throughUid: 4294967294 } }));
});

test("stored batch is exactly one through eight contiguous numeric UIDs without sorting or dropping slots", () => {
  const base = batch();
  for (const change of [{ mode: "search" }, { uids: [] }, { uids: [...base.selection.uids].reverse() }, { uids: [4294967288, 4294967290], throughUid: 4294967290 },
    { uids: [1, 1], fromUid: 1, throughUid: 2 }, { uids: ["1"], fromUid: 1, throughUid: 1 }, { uids: [0], fromUid: 0, throughUid: 0 },
    { uids: Array.from({ length: 9 }, (_, i) => i + 1), fromUid: 1, throughUid: 9 }, { expectedCursorGeneration: "0" }, { previousCursorDigest: "" },
    { maxAcknowledgedBytes: 0 }, { maxAcknowledgedBytes: 2097153 }, { fromUid: 4294967289 }, { throughUid: 4294967296 }]) {
    assert.equal(canonicalConnectorSelection({ ...base, selection: { ...base.selection, ...change } }), undefined);
  }
  assert.ok(canonicalConnectorSelection({ ...base, selection: { ...base.selection, uids: [4294967295], fromUid: 4294967295, throughUid: 4294967295, maxAcknowledgedBytes: 1 } }));
});

test("safe time and opaque run checks are structural, not a clock or active permission", () => {
  for (const change of [{ notBeforeMs: -1 }, { notBeforeMs: 1.5 }, { expiresAtMs: Number.MAX_SAFE_INTEGER + 1 }, { expiresAtMs: NaN }, { expiresAtMs: 1 }]) assert.equal(canonicalConnectorSelection({ ...bootstrap(), ...change }), undefined);
  assert.ok(canonicalConnectorSelection({ ...bootstrap(), notBeforeMs: 1, expiresAtMs: 1 }));
  assert.ok(canonicalConnectorSelection({ ...bootstrap(), notBeforeMs: 0, expiresAtMs: Number.MAX_SAFE_INTEGER }));
  for (const value of ["", " space", "space ", "slash/run", "🍐", "x".repeat(129)]) assert.equal(canonicalConnectorSelection({ ...bootstrap(), connector: { ...bootstrap().connector, runId: value } }), undefined);
});

test("literal mailbox values are scalar/control-free UTF-8 bounded without Unicode normalization", () => {
  for (const value of ["\ud800", "\udfff", "x\n", "\u0000", "\u0085", "\u007f", "\u009f", "🍐".repeat(129)]) assert.equal(canonicalConnectorSelection({ ...bootstrap(), mailbox: { ...bootstrap().mailbox, folder: value } }), undefined);
  for (const host of ["https://imap.example.test", "imap.example.test/path", "user@imap.example.test", "imap.example.test?x", "imap.example.test#x", " imap.example.test", "imap.\u2028example.test"]) assert.equal(canonicalConnectorSelection({ ...bootstrap(), mailbox: { ...bootstrap().mailbox, host } }), undefined);
  assert.ok(canonicalConnectorSelection({ ...bootstrap(), mailbox: { ...bootstrap().mailbox, folder: "🍐".repeat(128), username: " literal spaces " } }));
  // Rust char::is_whitespace deliberately differs from JavaScript trim/\s:
  // BOM is literal metadata, and no execution-safe-host claim is made here.
  assert.ok(canonicalConnectorSelection({ ...bootstrap(), mailbox: { ...bootstrap().mailbox, host: "\ufeffimap.example.test", username: "\ufeff" } }));
});

test("all input and held bytes are copied before the first await and returned aliases cannot change them", async () => {
  const value = structuredClone(batch()), pending = prepareConnectorSelection(value);
  (value.mailbox as { folder: string }).folder = "changed"; (value.selection.uids as number[])[0] = 1;
  const prepared = await pending; assert.equal(prepared.status, "prepared");
  assert.equal(prepared.selection.canonical, canonicalConnectorSelection(batch()));
  assert.ok(Object.isFrozen(prepared.selection.manifest) && Object.isFrozen(prepared.selection.manifest.selection) && Object.isFrozen(prepared.selection.manifest.selection.uids));
  prepared.selection.copyPayload().fill(0); assert.equal(digest(prepared.selection.copyPayload()), prepared.selection.manifestDigest);
});

test("hostile proxies, data getters and array tricks fail closed without leaking raw errors", async () => {
  let invoked = false;
  const getter = { ...batch() }; Object.defineProperty(getter, "mailbox", { enumerable: true, get() { invoked = true; throw Error("PRIVATE_CONNECTOR_MARKER"); } });
  const arrayGetter = [...batch().selection.uids]; Object.defineProperty(arrayGetter, "0", { enumerable: true, get() { invoked = true; throw Error("PRIVATE_CONNECTOR_MARKER"); } });
  const sparse = new Array(8), extra = Object.assign([...batch().selection.uids], { extra: true });
  const symbol = { ...batch(), [Symbol("private")]: true };
  for (const value of [getter, symbol, new Proxy({}, { getPrototypeOf() { throw Error("PRIVATE_CONNECTOR_MARKER"); } }),
    { ...batch(), selection: { ...batch().selection, uids: arrayGetter } }, { ...batch(), selection: { ...batch().selection, uids: sparse } }, { ...batch(), selection: { ...batch().selection, uids: extra } }]) {
    assert.equal(canonicalConnectorSelection(value), undefined);
    assert.deepEqual(await prepareConnectorSelection(value), { status: "denied", reason: "invalid_connector_selection" });
  }
  assert.equal(invoked, false);
});
