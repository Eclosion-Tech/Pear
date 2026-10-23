import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { LookupFunction } from "node:net";
import type { ConnectorSparseReadV1 } from "../../../packages/sentinel/src/index.js";
import { runProtectedMailSparseReadSession } from "./protected-mail-sparse-read-session.js";
import { ProtectedMailSparseReadImapError } from "./protected-mail-sparse-read-executor-types.js";
import { createExecutorFixture, createExecutorFixtureCertificates, executorFetchReply,
  EXECUTOR_FIXTURE_HOST, EXECUTOR_FIXTURE_MARKER } from "../../scripts/protected-mail-executor-fixture.js";
import type { ExecutorFixtureCertificates, ExecutorFixtureOptions } from "../../scripts/protected-mail-executor-fixture.js";

let certificates: ExecutorFixtureCertificates;
const password = `${EXECUTOR_FIXTURE_MARKER}password`;
const body = Buffer.concat([Buffer.from([0, 255, 128, 13, 10]), Buffer.from(`${EXECUTOR_FIXTURE_MARKER}opaque`)]);
before(async () => { certificates = await createExecutorFixtureCertificates(); });
after(async () => { await certificates?.close(); });

function plan(port: number, change: { expires?: number; notBefore?: number; folder?: string; maxMessage?: number; maxTotal?: number } = {}): ConnectorSparseReadV1 {
  return { formatVersion: 1, kind: "mail.connector.sparse_read", profile: "imap.observed-uid-body-peek.v1",
    readId: "891192f3dd1bb101132702d3c82e07fc3bb76d98f0b127d2bc952e214b0b4509", eventNonce: "b".repeat(64), workspaceId: "c".repeat(64), ownerId: "d".repeat(64),
    connection: { id: "1", epoch: "1", snapshotDigest: "e".repeat(64) }, connector: { identity: "f".repeat(64), runtimeId: "fixture-runtime", runId: "fixture-run" },
    mailbox: { host: EXECUTOR_FIXTURE_HOST, port, username: "fixture@example.test", folder: change.folder ?? "INBOX", direction: "received" },
    cursor: { id: `mail-connector-cursor:${"1".repeat(64)}`, generation: "1", digest: "2".repeat(64), uidValidity: "7", lastUid: 0 },
    observation: { id: "a".repeat(64), digest: "3".repeat(64), manifestDigest: "4".repeat(64), headId: `mail-discovery-head:${"5".repeat(64)}`, headGeneration: "1",
      uidValidity: "7", uidNext: 9, fromUid: 1, throughUid: 8, presentUids: [2, 5, 8], absentUids: [1, 3, 4, 6, 7] },
    limits: { maxMessageBytes: change.maxMessage ?? 128, maxTotalBytes: change.maxTotal ?? 256 },
    reservation: { operations: 1, messageSlots: 3, bodyBytes: change.maxTotal ?? 256 }, notBeforeMs: change.notBefore ?? Date.now() - 1000, expiresAtMs: change.expires ?? Date.now() + 60000 };
}
const examined = (tag: string, validity = "7", next = "9", extra = "", readOnly = true) => Buffer.from(
  `* FLAGS (\\Seen \\Answered)\r\n* 8 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY ${validity}] stable\r\n* OK [UIDNEXT ${next}] next\r\n${extra}${tag} OK [${readOnly ? "READ-ONLY" : "READ-WRITE"}] ready\r\n`);
async function context(t: { after(fn: () => Promise<void>): void }, options: ExecutorFixtureOptions = {}, changes: Parameters<typeof plan>[1] = {}) {
  const fixture = await createExecutorFixture({ certificates, messages: new Map([2, 5, 8].map(uid => [uid, body])),
    examineReply: tag => ({ bytes: examined(tag, options.uidValidity ?? "7", String(options.uidNext ?? 9), "", options.readOnly !== false), split: options.split }), ...options });
  t.after(() => fixture.close());
  const manifest = plan(fixture.port, changes);
  const run = (signal = new AbortController().signal, timeout = 2000, lookup: LookupFunction = fixture.lookup) => runProtectedMailSparseReadSession({ plan: manifest, password, signal, deadlineAtMs: Date.now() + timeout, ca: fixture.ca, lookup });
  return { fixture, manifest, run };
}
async function rejected(work: Promise<unknown>, reason?: string) {
  try { await work; }
  catch (error) {
    assert.ok(error instanceof ProtectedMailSparseReadImapError && (!reason || error.reason === reason), "sparse_session_expected_fixed_error");
    assert.ok(Object.isFrozen(error) && !error.message.includes(EXECUTOR_FIXTURE_MARKER) && !("messages" in error), "sparse_session_error_exposed_material"); return;
  }
  assert.fail("sparse_session_accepted_invalid_wire");
}
async function until(check: () => boolean) { const deadline = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < deadline, "sparse_session_fixture_wait_expired"); await new Promise(resolve => setTimeout(resolve, 1)); } }

test("sparse session fetches only 2,5,8 and hashes split opaque octets without expanding higher UIDNEXT", async t => {
  for (const next of [9, 100, 4294967295]) {
    const c = await context(t, { uidNext: next, split: true, ...(next === 100 ? { examineReply: (tag: string) => ({ bytes: Buffer.from(`* OK [UIDNEXT 100] next\r\n* OK [UIDVALIDITY 7] stable\r\n${tag} OK [READ-ONLY] ready\r\n`), split: true }) } : {}) }), result = await c.run();
    assert.ok(result.messages.length === 3 && result.messages.every((m, i) => m.uid === [2, 5, 8][i] && m.bytes === body.length && m.digest === createHash("sha256").update(body).digest("hex")), "sparse_session_binary_metadata_changed");
    assert.ok(result.bodyBytes === body.length * 3 && Object.isFrozen(result) && Object.isFrozen(result.messages) && result.messages.every(Object.isFrozen), "sparse_session_result_not_bounded_or_frozen");
    assert.ok(c.fixture.stats.fetches.map(v => v.uid).join(",") === "2,5,8" && c.fixture.stats.searches.length === 0 && !c.fixture.stats.forbidden && c.fixture.stats.authenticationMatched && c.fixture.stats.tagsSequential, "sparse_session_command_scope_changed");
    assert.ok(!("uidNext" in result) && !("body" in result) && !("canonical" in result), "sparse_session_exposed_unneeded_material");
    await until(() => c.fixture.stats.closedConnections === 1);
  }
});
test("sparse session accepts SIZE-before-UID and zero-length literals with exact modified UTF7 folder", async t => {
  const c = await context(t, { folderWire: '&ZcWITA- &- \\"quoted\\"\\\\', fetchReply: request => ({ bytes: executorFetchReply(request, Buffer.alloc(0), { prefix: `* 1 FETCH (RFC822.SIZE 0 UID ${request.uid} BODY[]<0> {0}\r\n` }) }) }, { folder: '旅行 & "quoted"\\' });
  const result = await c.run();
  assert.ok(result.messages.length === 3 && result.bodyBytes === 0 && result.messages.every(v => v.digest === createHash("sha256").update(Buffer.alloc(0)).digest("hex")) && c.fixture.stats.mailboxMatched, "sparse_session_zero_or_folder_changed");
});

const counterFaults: Array<[string, ExecutorFixtureOptions, string]> = [
  ["UIDVALIDITY mismatch", { uidValidity: "8" }, "uid_validity_mismatch"],
  ["UIDNEXT rollback", { uidNext: 8 }, "uid_next_rollback"],
  ["missing UIDNEXT", { examineReply: tag => ({ bytes: Buffer.from(`* OK [UIDVALIDITY 7] stable\r\n${tag} OK [READ-ONLY] ready\r\n`) }) }, "protocol_failure"],
  ["missing UIDVALIDITY", { examineReply: tag => ({ bytes: Buffer.from(`* OK [UIDNEXT 9] next\r\n${tag} OK [READ-ONLY] ready\r\n`) }) }, "protocol_failure"],
  ...["UIDNEXT 9", "UIDNEXT 10", "UIDVALIDITY 7", "UIDVALIDITY 8"].map((code): [string, ExecutorFixtureOptions, string] => [`duplicate ${code}`, { examineReply: tag => ({ bytes: examined(tag, "7", "9", `* OK [${code}] duplicate\r\n`) }) }, "protocol_failure"]),
  ...["0", "09", "4294967296"].map((uidNext): [string, ExecutorFixtureOptions, string] => [`invalid UIDNEXT ${uidNext}`, { uidNext }, "protocol_failure"]),
  ...["0", "07", "4294967296"].map((uidValidity): [string, ExecutorFixtureOptions, string] => [`invalid UIDVALIDITY ${uidValidity}`, { uidValidity }, "protocol_failure"]),
  ["no READ-ONLY", { readOnly: false }, "read_only_required"],
];
for (const [name, options, reason] of counterFaults) test(`sparse session rejects ${name} before any FETCH`, async t => {
  const c = await context(t, options); await rejected(c.run(), reason);
  assert.ok(c.fixture.stats.fetches.length === 0 && c.fixture.stats.searches.length === 0 && !c.fixture.stats.forbidden && c.fixture.stats.tcpConnections === 1, "sparse_counter_failure_probed_or_retried");
});

const faults: Array<[string, ExecutorFixtureOptions, string?]> = [
  ["PREAUTH", { greeting: "* PREAUTH synthetic\r\n" }],
  ["greeting literal", { greeting: "* OK {3}\r\nraw\r\n" }],
  ["greeting non-synchronizing literal", { greeting: "* OK {3+}\r\nraw\r\n" }],
  ["greeting literal8", { greeting: "* OK ~{3}\r\nraw\r\n" }],
  ["referral", { greeting: "* OK [REFERRAL imap://example.invalid] synthetic\r\n" }],
  ["pure rev2", { capabilities: "IMAP4rev2 AUTH=PLAIN" }],
  ["UTF8-only", { capabilities: "IMAP4rev1 AUTH=PLAIN UTF8=ONLY" }],
  ["no PLAIN", { capabilities: "IMAP4rev1 AUTH=LOGIN" }, "authentication_failed"],
  ["auth rejection", { authReject: true }, "authentication_failed"],
  ["extra challenge", { authExtraChallenge: true }, "authentication_failed"],
  ["capability tagged literal", { capabilities: "IMAP4rev1 AUTH=PLAIN\r\nC1 OK {3}\r\nraw" }],
  ["EXAMINE control literal", { examineReply: tag => ({ bytes: examined(tag, "7", "9", "* OK [NOMODSEQ] ~{3}\r\nraw\r\n") }) }],
  ["EXAMINE tagged literal", { examineReply: tag => ({ bytes: Buffer.from(`* OK [UIDVALIDITY 7] stable\r\n* OK [UIDNEXT 9] next\r\n${tag} OK [READ-ONLY] {3}\r\nraw\r\n`) }) }],
  ["FETCH tagged literal", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { suffix: `)\r\n${request.tag} OK {3}\r\nraw\r\n` }) }) }],
  ["final UID mismatch", { fetchReply: request => ({ bytes: executorFetchReply(request, body, request.index === 2 ? { uid: 7 } : {}) }) }, "uid_mismatch"],
  ["literal SIZE mismatch", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { size: body.length + 1 }) }) }, "incomplete_read"],
  ["nonzero origin", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { offset: 1 }) }) }],
  ["UID after body", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { prefix: `* 1 FETCH (RFC822.SIZE ${body.length} BODY[]<0> {${body.length}}\r\n`, suffix: ` UID ${request.uid})\r\n${request.tag} OK fetched\r\n` }) }) }],
  ["duplicate FETCH", { fetchReply: request => ({ bytes: Buffer.concat([executorFetchReply(request, body, { suffix: ")\r\n" }), executorFetchReply(request, body)]) }) }],
  ["already buffered FETCH after tagged OK", { fetchReply: request => ({ bytes: Buffer.concat([executorFetchReply(request, body), executorFetchReply(request, body)]) }) }],
  ["missing final UID", { fetchReply: request => ({ bytes: request.index === 2 ? Buffer.from(`${request.tag} OK missing\r\n`) : executorFetchReply(request, body) }) }, "missing_uid"],
  ["wrong final tag", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { tag: "C999" }) }) }],
  ["truncated literal", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { declaredLength: body.length + 1, size: body.length + 1, suffix: "" }), close: true }) }, "transport_closed"],
  ["oversized announcement", { fetchReply: request => ({ bytes: Buffer.from(`* 1 FETCH (UID ${request.uid} RFC822.SIZE 999999 BODY[]<0> {999999}\r\n`) }) }, "limit_reached"],
  ["oversized line", { greeting: `* OK ${"x".repeat(8192)}\r\n` }, "limit_reached"],
  ["control response flood", { examineReply: tag => ({ bytes: examined(tag, "7", "9", "* 1 EXISTS\r\n".repeat(129)) }) }, "limit_reached"],
];
for (const [name, options, reason] of faults) test(`sparse session rejects ${name} without partial metadata`, async t => {
  const c = await context(t, options); await rejected(c.run(), reason);
  assert.ok(c.fixture.stats.searches.length === 0 && !c.fixture.stats.forbidden && c.fixture.stats.tcpConnections === 1, "sparse_fault_retried_or_widened");
});

test("exact cap is always incomplete and a later remaining cap stops without continuation", async t => {
  const exact = await context(t, { messages: new Map([2, 5, 8].map(uid => [uid, Buffer.alloc(64)])) }, { maxMessage: 64, maxTotal: 128 });
  await rejected(exact.run(), "limit_reached");
  assert.ok(exact.fixture.stats.fetches.length === 1 && exact.fixture.stats.fetches[0].limit === 64, "sparse_session_requested_cap_plus_one");
  const aggregate = await context(t, { messages: new Map([[2, Buffer.alloc(63)], [5, Buffer.alloc(37)], [8, Buffer.alloc(1)]]) }, { maxMessage: 64, maxTotal: 100 });
  await rejected(aggregate.run(), "limit_reached");
  assert.ok(aggregate.fixture.stats.fetches.length === 2 && aggregate.fixture.stats.fetches[1].uid === 5 && aggregate.fixture.stats.fetches[1].limit === 37 && aggregate.fixture.stats.tcpConnections === 1, "sparse_session_aggregate_or_retry_changed");
});
test("verified TLS CA and exact hostname precede authentication", async t => {
  const wrong = await createExecutorFixtureCertificates("wrong.example.test"); t.after(() => wrong.close());
  for (const mismatch of [false, true]) {
    const c = await context(t, { certificates: mismatch ? wrong : certificates });
    await rejected(runProtectedMailSparseReadSession({ plan: c.manifest, password, signal: new AbortController().signal, deadlineAtMs: Date.now() + 2000, ca: mismatch ? wrong.ca : undefined, lookup: c.fixture.lookup }), "tls_failure");
    assert.ok(c.fixture.stats.authentications === 0, "sparse_session_authenticated_without_tls");
  }
});
test("invalid password, plan, deadline, abort and private literal reject with zero raw TCP", async t => {
  const c = await context(t), aborted = new AbortController(); aborted.abort();
  const base = { plan: c.manifest, password, signal: new AbortController().signal, deadlineAtMs: Date.now() + 2000, ca: c.fixture.ca, lookup: c.fixture.lookup };
  for (const value of ["", "bad\u0000password", "bad\u0085password", "\ud800", "x".repeat(4097)]) await rejected(runProtectedMailSparseReadSession({ ...base, plan: undefined as unknown as ConnectorSparseReadV1, password: value }), "authentication_failed");
  for (const value of [0, NaN, Number.MAX_SAFE_INTEGER + 1, Date.now() - 1]) await rejected(runProtectedMailSparseReadSession({ ...base, deadlineAtMs: value }), "deadline_exceeded");
  await rejected(runProtectedMailSparseReadSession({ ...base, signal: aborted.signal }), "aborted");
  await rejected(runProtectedMailSparseReadSession({ ...base, plan: { ...c.manifest, mailbox: { ...c.manifest.mailbox, host: "127.0.0.1" } } }), "tls_failure");
  await rejected(runProtectedMailSparseReadSession({ ...base, plan: { ...c.manifest, kind: "mail.connector.read" } as unknown as ConnectorSparseReadV1 }), "protocol_failure");
  await rejected(runProtectedMailSparseReadSession({ ...base, plan: { ...c.manifest, observation: { ...c.manifest.observation, presentUids: [2, 4, 8] } } }), "protocol_failure");
  await rejected(runProtectedMailSparseReadSession({ ...base, plan: { ...c.manifest, expiresAtMs: Date.now() - 1 } }), "read_expired");
  assert.ok(c.fixture.stats.tcpConnections === 0, "sparse_session_invalid_preflight_dialed");
});
test("deadline expiry and abort close an owned greeting socket without retry", async t => {
  for (const mode of ["deadline", "expiry", "abort"]) {
    const c = await context(t, { greeting: null }, { expires: Date.now() + (mode === "expiry" ? 150 : 60000) }), controller = new AbortController();
    const pending = c.run(controller.signal, mode === "deadline" ? 150 : 2000); await until(() => c.fixture.stats.connections === 1); if (mode === "abort") controller.abort();
    await rejected(pending, mode === "expiry" ? "read_expired" : mode === "deadline" ? "deadline_exceeded" : "aborted");
    await until(() => c.fixture.stats.closedConnections === 1);
    assert.ok(c.fixture.stats.tcpConnections === 1 && c.fixture.stats.authentications === 0, "sparse_session_deadline_retried");
  }
});
test("midliteral abort closes the only socket and withholds earlier message metadata", async t => {
  const c = await context(t, { fetchReply: request => ({ bytes: request.index === 2 ? Buffer.from(`* 1 FETCH (UID 8 RFC822.SIZE 10 BODY[]<0> {10}\r\nx`) : executorFetchReply(request, body) }) }), controller = new AbortController();
  const pending = c.run(controller.signal); await until(() => c.fixture.stats.fetches.length === 3); controller.abort(); await rejected(pending, "aborted");
  await until(() => c.fixture.stats.closedConnections === 1); assert.ok(c.fixture.stats.tcpConnections === 1, "sparse_session_abort_retried");
});
test("delayed DNS callbacks after abort expiry or absolute deadline never start raw TCP", async t => {
  for (const mode of ["abort", "expiry", "deadline"]) {
    const c = await context(t), controller = new AbortController(), deadline = Date.now() + 2000;
    let finish: Parameters<LookupFunction>[2] | undefined;
    const lookup: LookupFunction = (_host, _options, callback) => { finish = callback; };
    const pending = runProtectedMailSparseReadSession({ plan: c.manifest, password, signal: controller.signal, deadlineAtMs: deadline, ca: c.fixture.ca, lookup });
    await until(() => finish !== undefined);
    const now = Date.now;
    try {
      if (mode === "abort") controller.abort();
      else Date.now = () => mode === "expiry" ? c.manifest.expiresAtMs + 1 : deadline + 1;
      finish!(null, "127.0.0.1", 4); finish!(null, "127.0.0.1", 4);
    } finally { Date.now = now; }
    await rejected(pending, mode === "expiry" ? "read_expired" : mode === "deadline" ? "deadline_exceeded" : "aborted");
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(c.fixture.stats.tcpConnections === 0 && c.fixture.stats.authentications === 0, "sparse_session_late_dns_started_tcp");
  }
});
test("throwing and duplicate DNS callbacks stay fixed and single attempt", async t => {
  const throwing = await context(t); await rejected(throwing.run(new AbortController().signal, 2000, () => { throw Error(`${EXECUTOR_FIXTURE_MARKER}dns`); }), "tls_failure");
  assert.ok(throwing.fixture.stats.tcpConnections === 0, "sparse_session_throwing_dns_dialed");
  const afterCallback = await context(t);
  await rejected(afterCallback.run(new AbortController().signal, 2000, (host, options, callback) => { afterCallback.fixture.lookup(host, options, callback); throw Error(`${EXECUTOR_FIXTURE_MARKER}dns`); }), "tls_failure");
  assert.ok(afterCallback.fixture.stats.authentications === 0, "sparse_session_throwing_dns_authenticated");
  const duplicate = await context(t);
  const lookup: LookupFunction = (host, options, callback) => duplicate.fixture.lookup(host, options, (error, address, family) => { callback(error, address, family); callback(error, address, family); });
  await duplicate.run(new AbortController().signal, 2000, lookup);
  assert.ok(duplicate.fixture.stats.tcpConnections === 1, "sparse_session_duplicate_dns_dialed_twice");
});
