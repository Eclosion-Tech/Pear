import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalConnectorSelection, type ConnectorReadV1 } from "../../../packages/sentinel/src/index.js";
import { encodeProtectedMailImapFolder, parseProtectedMailFetchHeader, runProtectedMailImapSession } from "./protected-mail-imap-session.js";
import { ProtectedMailImapError, type ProtectedMailImapReason } from "./protected-mail-read-types.js";

function rejected(reason: ProtectedMailImapReason): (error: unknown) => boolean {
  return error => error instanceof ProtectedMailImapError && error.reason === reason && error.message === reason;
}
function plan(overrides: { expires?: number; notBefore?: number } = {}): ConnectorReadV1 {
  const now = Date.now();
  const selection = {
    formatVersion: 1 as const, kind: "mail.connector.selection" as const, selectionId: "a".repeat(64), workspaceId: "b".repeat(64), ownerId: "c".repeat(64),
    connection: { id: "1", epoch: "1", snapshotDigest: "d".repeat(64) }, connector: { identity: "e".repeat(64), runtimeId: "fixture-runtime", runId: "fixture-run" },
    mailbox: { host: "127.0.0.1", port: 993, username: "fixture-user", folder: "INBOX", direction: "received" as const },
    selection: { mode: "stored_batch" as const, uidValidity: "7", expectedCursorGeneration: "1", previousCursorDigest: "f".repeat(64), fromUid: 1, throughUid: 2, uids: [1, 2], maxAcknowledgedBytes: 100 },
    notBeforeMs: overrides.notBefore ?? now - 1000, expiresAtMs: overrides.expires ?? now + 60000,
  };
  const canonical = canonicalConnectorSelection(selection); assert.ok(canonical);
  return { formatVersion: 1, kind: "mail.connector.read", limits: { maxMessageBytes: 100, maxTotalBytes: 200 }, profile: "imap.uid-body-peek.v1",
    readId: "bd59b410c67e7ef343f8d6b4689fc9bb74ccbc402b97fbbc8550710ef3ddae2c", reservation: { bodyBytes: 200, messageSlots: 2, operations: 1 }, selection,
    selectionDigest: createHash("sha256").update(canonical).digest("hex") };
}

test("folder encoder uses modified UTF7 and quotes only literal folder bytes", () => {
  assert.equal(encodeProtectedMailImapFolder("INBOX"), '"INBOX"');
  assert.equal(encodeProtectedMailImapFolder("A&B"), '"A&-B"');
  assert.equal(encodeProtectedMailImapFolder("~peter/mail/台北/日本語"), '"~peter/mail/&U,BTFw-/&ZeVnLIqe-"');
  assert.equal(encodeProtectedMailImapFolder('Inbox "quoted"\\'), '"Inbox \\"quoted\\"\\\\"');
});
test("folder encoder never normalizes Unicode or loses surrogate-pair bytes", () => {
  assert.equal(encodeProtectedMailImapFolder("é"), '"&AOk-"');
  assert.equal(encodeProtectedMailImapFolder("e\u0301"), '"e&AwE-"');
  assert.equal(encodeProtectedMailImapFolder("🍐"), '"&2DzfUA-"');
  assert.notEqual(encodeProtectedMailImapFolder("é"), encodeProtectedMailImapFolder("e\u0301"));
  assert.match(encodeProtectedMailImapFolder("🍐".repeat(128)), /^"&[A-Za-z0-9+,]+-"$/);
});
test("folder encoder rejects invalid scalar/control/scope data with fixed errors", () => {
  for (const folder of ["", "\u0000", "line\nnext", "\u0085", "\ud800", "\udc00", "🍐".repeat(129)])
    assert.throws(() => encodeProtectedMailImapFolder(folder), rejected("protocol_failure"));
});
test("FETCH header supports UID/SIZE order but sequence number never stands in for UID", () => {
  assert.deepEqual(parseProtectedMailFetchHeader("* 1 FETCH (UID 42 RFC822.SIZE 3 BODY[]<0> {3}", 42, 4), { literalLength: 3 });
  assert.deepEqual(parseProtectedMailFetchHeader("* 5 FETCH (RFC822.SIZE 3 UID 42 BODY[]<0> {3}", 42, 4), { literalLength: 3 });
  assert.deepEqual(parseProtectedMailFetchHeader("* 1 FETCH (UID 42 RFC822.SIZE 0 BODY[]<0> {0}", 42, 1), { literalLength: 0 });
  assert.throws(() => parseProtectedMailFetchHeader("* 42 FETCH (UID 1 RFC822.SIZE 0 BODY[]<0> {0}", 42, 1), rejected("uid_mismatch"));
});
test("exact cap is always incomplete, while oversize is rejected before literal processing", () => {
  assert.throws(() => parseProtectedMailFetchHeader("* 1 FETCH (UID 1 RFC822.SIZE 4 BODY[]<0> {4}", 1, 4), rejected("limit_reached"));
  assert.throws(() => parseProtectedMailFetchHeader("* 1 FETCH (UID 1 RFC822.SIZE 100 BODY[]<0> {4}", 1, 4), rejected("limit_reached"));
  assert.throws(() => parseProtectedMailFetchHeader("* 1 FETCH (UID 1 RFC822.SIZE 5 BODY[]<0> {0005}", 1, 4), rejected("limit_reached"));
  assert.throws(() => parseProtectedMailFetchHeader("* 1 FETCH (UID 1 RFC822.SIZE 999999999999999999999999 BODY[]<0> {999999999999999999999999}", 1, 4), rejected("limit_reached"));
  assert.throws(() => parseProtectedMailFetchHeader("* 1 FETCH (UID 1 RFC822.SIZE 4 BODY[]<0> {3}", 1, 4), rejected("incomplete_read"));
});
test("closed FETCH subset rejects widening, extra attributes and unsupported framing", () => {
  const lines = [
    "* 1 FETCH (RFC822.SIZE 3 BODY[]<0> {3}", "* 1 FETCH (UID 1 RFC822.SIZE 3 BODY[]<1> {3}",
    "* 1 FETCH (UID 1 RFC822.SIZE 3 BODY[] {3}", "* 1 FETCH (UID 1 RFC822.SIZE 3 BINARY[]<0> {3}",
    "* 1 FETCH (UID 1 RFC822.SIZE 3 BODY[]<0> {3+}", "* 1 FETCH (UID 1 UID 1 RFC822.SIZE 3 BODY[]<0> {3}",
    "* 1 FETCH (UID 1 RFC822.SIZE 3 FLAGS (\\Seen) BODY[]<0> {3}", "* 1 FETCH (UID 1 RFC822.SIZE 3 BODY[]<0> NIL",
    "* 0 FETCH (UID 1 RFC822.SIZE 3 BODY[]<0> {3}", "* 4294967296 FETCH (UID 1 RFC822.SIZE 3 BODY[]<0> {3}",
  ];
  for (const line of lines) assert.throws(() => parseProtectedMailFetchHeader(line, 1, 4), rejected("protocol_failure"));
});
test("invalid password and already-aborted calls cannot access a plan or socket", async () => {
  const unknownPlan = undefined as unknown as ConnectorReadV1;
  for (const password of ["", "\u0000", "line\nnext", "\u0085", "\ud800", "x".repeat(4097)])
    await assert.rejects(runProtectedMailImapSession({ plan: unknownPlan, password, signal: new AbortController().signal, deadlineAtMs: Date.now() + 1000 }), rejected("authentication_failed"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runProtectedMailImapSession({ plan: unknownPlan, password: "synthetic-password", signal: controller.signal, deadlineAtMs: Date.now() + 1000 }), rejected("aborted"));
});
test("deadline/expiry/default private IP guards reject before a TLS connection", async () => {
  for (const deadlineAtMs of [0, NaN, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(runProtectedMailImapSession({ plan: plan(), password: "synthetic-password", signal: new AbortController().signal, deadlineAtMs }), rejected("deadline_exceeded"));
  await assert.rejects(runProtectedMailImapSession({ plan: plan(), password: "synthetic-password", signal: new AbortController().signal, deadlineAtMs: Date.now() - 1 }), rejected("deadline_exceeded"));
  await assert.rejects(runProtectedMailImapSession({ plan: plan({ expires: Date.now() - 1 }), password: "synthetic-password", signal: new AbortController().signal, deadlineAtMs: Date.now() + 1000 }), rejected("read_expired"));
  await assert.rejects(runProtectedMailImapSession({ plan: plan(), password: "synthetic-password", signal: new AbortController().signal, deadlineAtMs: Date.now() + 1000 }), rejected("tls_failure"));
});
