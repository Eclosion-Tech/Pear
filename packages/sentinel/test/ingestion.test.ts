import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalConnectorSelection, canonicalMailIngestionPayload, parseMailIngestionEntries, prepareMailIngestion,
  type ConnectorReadV1, type ConnectorSelectionV1, type MailIngestionPayloadV1, type ProtectedMailPreparedMessage } from "../src/index.js";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function readId(selectionId: string): string {
  const hash = createHash("sha256");
  for (const field of ["pear-mail-read-grant-v1", selectionId]) {
    const bytes = Buffer.from(field), length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}
function read(count = 2): ConnectorReadV1 {
  const selection: ConnectorSelectionV1 = { formatVersion: 1, kind: "mail.connector.selection", selectionId: "a".repeat(64), workspaceId: "b".repeat(64), ownerId: "c".repeat(64),
    connection: { id: "9007199254740993", epoch: "18446744073709551615", snapshotDigest: "d".repeat(64) },
    connector: { identity: "e".repeat(64), runtimeId: "fixture-runtime", runId: "fixture-run" },
    mailbox: { host: "imap.example.test", port: 993, username: "fixture@example.test", folder: "受信🍐e\u0301", direction: "received" },
    selection: { mode: "stored_batch", uidValidity: "7", expectedCursorGeneration: "18446744073709551615", previousCursorDigest: "f".repeat(64),
      fromUid: 2, throughUid: 1 + count, uids: Array.from({ length: count }, (_, i) => i + 2), maxAcknowledgedBytes: 1 },
    notBeforeMs: 1700000000000, expiresAtMs: 1700003600000 };
  return { formatVersion: 1, kind: "mail.connector.read", limits: { maxMessageBytes: 524288, maxTotalBytes: count * 262144 },
    profile: "imap.uid-body-peek.v1", readId: readId(selection.selectionId), reservation: { bodyBytes: count * 262144, messageSlots: count, operations: 1 },
    selection, selectionDigest: digest(canonicalConnectorSelection(selection)!) };
}
function message(uid = 2): ProtectedMailPreparedMessage {
  return { folder: "受信🍐e\u0301", uidValidity: "7", uid, direction: "received", messageDate: "2026-10-21", from: "fixture@example.test", to: "owner@example.test", cc: "",
    subject: 'literal "subject"', body: '日本語🍐e\u0301\u2028\nquoted "text"\\', note: "", sanitizationVersion: "prepared-text-v1" };
}
function payload(): MailIngestionPayloadV1 {
  return { formatVersion: 1, kind: "mail.ingestion.batch", read: read(), entries: [
    { uid: 2, kind: "imported", message: message() }, { uid: 3, kind: "held", reason: "authentication_material" },
  ] };
}
const denied = { status: "denied", reason: "invalid_mail_ingestion" };

test("mixed prepared-text/held payload commits complete UTF8 envelope and preserves literal scalars", async () => {
  const proposed = payload(), canonical = canonicalMailIngestionPayload(proposed)!;
  const prepared = await prepareMailIngestion(proposed);
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  assert.equal(prepared.ingestion.canonical, canonical);
  assert.equal(prepared.ingestion.payloadBytes, Buffer.byteLength(canonical));
  assert.equal(prepared.ingestion.payloadDigest, digest(canonical));
  // Independently serialized and hashed with Python ensure_ascii=False JSON.
  assert.equal(prepared.ingestion.payloadBytes, 1883);
  assert.equal(prepared.ingestion.payloadDigest, "4369fe3ef974e1cb8e77f275f673e82a84ba4e2b165b3251981c465d31f8b935");
  assert.deepEqual(Object.keys(JSON.parse(canonical)), ["entries", "formatVersion", "kind", "read"]);
  assert.equal(prepared.ingestion.payload.entries[0].kind === "imported" && prepared.ingestion.payload.entries[0].message.body, message().body);
  assert.deepEqual(Object.keys(prepared.ingestion.payload.entries[1]), ["kind", "reason", "uid"]);
  assert.ok(!("permit" in prepared.ingestion) && !("operation" in prepared.ingestion));
});

test("canonical bytes ignore insertion order while body, held reason and complete read bindings stay exact", async () => {
  const reverse = (v: unknown): unknown => Array.isArray(v) ? v.map(reverse) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).reverse().map(([key, value]) => [key, reverse(value)])) : v;
  const original = payload(), canonical = canonicalMailIngestionPayload(original)!;
  assert.equal(canonicalMailIngestionPayload(reverse(original)), canonical);
  for (const reason of ["sensitive_content", "unsupported_content"] as const) assert.notEqual(canonicalMailIngestionPayload({ ...original, entries: [original.entries[0], { uid: 3, kind: "held", reason }] }), canonical);
  for (const body of [message().body + " ", message().body.normalize("NFC"), message().body.replace("\n", "\r\n")]) {
    assert.notEqual(canonicalMailIngestionPayload({ ...original, entries: [{ uid: 2, kind: "imported", message: { ...message(), body } }, original.entries[1]] }), canonical);
  }
});

test("preparation validates nested digest and read identity beyond structural serialization", async () => {
  for (const changed of [{ ...read(), readId: "0".repeat(64) }, { ...read(), selectionDigest: "0".repeat(64) }]) {
    const value = { ...payload(), read: changed };
    assert.ok(canonicalMailIngestionPayload(value));
    assert.deepEqual(await prepareMailIngestion(value), denied);
  }
});

test("every selected slot and imported mailbox tuple must match; missing never becomes held", async () => {
  const value = payload();
  for (const entries of [[], [value.entries[0]], [...value.entries].reverse(), [value.entries[0], value.entries[0]],
    [value.entries[0], { uid: 4, kind: "held", reason: "sensitive_content" }],
    [value.entries[0], { uid: 3, kind: "held", reason: "missing_uid" }],
    [value.entries[0], { uid: 3, kind: "missing" }],
    [{ uid: 2, kind: "imported", message: { ...message(), uid: 3 } }, value.entries[1]],
    [{ uid: 2, kind: "imported", message: { ...message(), folder: "INBOX" } }, value.entries[1]],
    [{ uid: 2, kind: "imported", message: { ...message(), direction: "sent" } }, value.entries[1]],
    [{ uid: 2, kind: "imported", message: { ...message(), uidValidity: "8" } }, value.entries[1]],
  ]) assert.deepEqual(await prepareMailIngestion({ ...value, entries }), denied);
});

test("UTF8 field bounds are bytes, accept exact S1 limits and preserve allowed newlines", () => {
  const valid = { ...message(), subject: "é".repeat(512), body: "🍐".repeat(40000), note: "a\r\n\tb" };
  assert.ok(parseMailIngestionEntries([{ uid: 2, kind: "imported", message: valid }]));
  for (const changed of [{ ...valid, body: valid.body + "a" }, { ...valid, subject: valid.subject + "a" },
    { ...valid, from: "é".repeat(1025) }, { ...valid, body: "a\u0085b" }, { ...valid, body: "\ud800" },
    { ...valid, subject: "newline\n" }, { ...valid, sanitizationVersion: "version with spaces" }, { ...valid, uidValidity: "07" }]) {
    assert.equal(parseMailIngestionEntries([{ uid: 2, kind: "imported", message: changed }]), undefined);
  }
});

test("complete escaped envelope cap is independent from raw MIME reservations and old ACK byte ceilings", async () => {
  const proposed = { ...payload(), read: read(8), entries: Array.from({ length: 8 }, (_, i) =>
    ({ kind: "imported", uid: i + 2, message: { ...message(i + 2), body: "a".repeat(160000) } })) };
  assert.equal((await prepareMailIngestion(proposed)).status, "prepared");
  assert.equal(proposed.read.selection.selection.maxAcknowledgedBytes, 1);
  // Same valid field byte counts; JSON escaping increases the complete cost.
  proposed.entries.forEach(entry => { entry.message.body = "\n".repeat(160000); });
  assert.equal(canonicalMailIngestionPayload(proposed), undefined);
});

test("frozen before-await snapshots isolate caller mutation and returned byte copies", async () => {
  const value = structuredClone(payload()), original = canonicalMailIngestionPayload(value)!;
  const pending = prepareMailIngestion(value);
  const first = value.entries[0]; if (first.kind === "imported") (first.message as { body: string }).body = "changed";
  (value.read.selection.mailbox as { folder: string }).folder = "changed";
  const prepared = await pending; assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  assert.equal(prepared.ingestion.canonical, original);
  assert.ok(Object.isFrozen(prepared.ingestion.payload.entries) && Object.isFrozen(prepared.ingestion.payload.entries[0]));
  prepared.ingestion.copyPayload().fill(0);
  assert.equal(digest(prepared.ingestion.copyPayload()), prepared.ingestion.payloadDigest);
});

test("closed records reject data getters, prototypes, hidden/symbol fields, holes and arbitrary held text", async () => {
  let invoked = false;
  const getter = Object.defineProperty({ ...message() }, "body", { enumerable: true, get() { invoked = true; throw Error("INGESTION_PRIVATE_SYNTHETIC"); } });
  const itemGetter = Object.defineProperty({ uid: 2, kind: "imported" }, "message", { enumerable: true, get() { invoked = true; return message(); } });
  const array = [payload().entries[0], payload().entries[1]];
  Object.defineProperty(array, "0", { enumerable: true, get() { invoked = true; return payload().entries[0]; } });
  const hidden = Object.defineProperty({ ...message() }, "private", { value: "INGESTION_PRIVATE_SYNTHETIC" });
  for (const entries of [[{ uid: 2, kind: "imported", message: getter }], [itemGetter], array,
    [{ uid: 2, kind: "imported", message: hidden }], [{ uid: 2, kind: "held", reason: "sensitive_content", body: "private" }],
    [{ uid: 2, kind: "held", reason: "sensitive_content", [Symbol("extra")]: true }],
    [Object.assign(Object.create({ approved: true }), payload().entries[0])], [payload().entries[0], , payload().entries[1]],
    new Proxy([], { getPrototypeOf() { throw Error("INGESTION_PRIVATE_SYNTHETIC"); } })]) assert.equal(parseMailIngestionEntries(entries), undefined);
  for (const extra of [{ approved: true }, { password: "private" }, { destination: "other" }]) assert.deepEqual(await prepareMailIngestion({ ...payload(), ...extra }), denied);
  assert.equal(invoked, false);
});
