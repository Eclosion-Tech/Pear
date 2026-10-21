import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ConnectorDiscoveryV1 } from "../../../packages/sentinel/src/index.js";
import { runProtectedMailDiscoverySession } from "./protected-mail-discovery-session.js";
import { ProtectedMailDiscoveryError } from "./protected-mail-discovery-types.js";
import { createExecutorFixture, createExecutorFixtureCertificates, EXECUTOR_FIXTURE_HOST, EXECUTOR_FIXTURE_MARKER } from "../../scripts/protected-mail-executor-fixture.js";
import type { ExecutorFixtureCertificates, ExecutorFixtureOptions } from "../../scripts/protected-mail-executor-fixture.js";

let certificates: ExecutorFixtureCertificates;
const password = `${EXECUTOR_FIXTURE_MARKER}password`;
before(async () => { certificates = await createExecutorFixtureCertificates(); });
after(async () => { await certificates?.close(); });
function plan(port: number, change: { bootstrap?: boolean; last?: number; slots?: number; headNext?: number; headValidity?: string; folder?: string; expires?: number } = {}): ConnectorDiscoveryV1 {
  const last = change.last ?? 6, slots = change.bootstrap ? 0 : change.slots ?? 8;
  return { formatVersion: 1, kind: "mail.connector.discovery", profile: "imap.uid-discovery.v1", discoveryId: "a".repeat(64), eventNonce: "b".repeat(64), workspaceId: "c".repeat(64), ownerId: "d".repeat(64),
    connection: { id: "1", epoch: "1", snapshotDigest: "e".repeat(64) }, connector: { identity: "f".repeat(64), runtimeId: "fixture", runId: "fixture" },
    mailbox: { host: EXECUTOR_FIXTURE_HOST, port, username: "fixture@example.test", folder: change.folder ?? "INBOX", direction: "received" },
    cursor: change.bootstrap ? null : { id: `mail-connector-cursor:${"1".repeat(64)}`, generation: "1", digest: "2".repeat(64), uidValidity: "7", lastUid: last },
    head: change.headNext === undefined ? null : { id: `mail-discovery-head:${"3".repeat(64)}`, generation: "1", digest: "4".repeat(64), observationId: "5".repeat(64), uidValidity: change.headValidity ?? "7", uidNext: change.headNext },
    window: { mode: change.bootstrap ? "bootstrap" : "next_window", maxSlots: slots, fromUid: change.bootstrap ? null : last + 1, maxThroughUid: change.bootstrap ? null : Math.min(last + slots, 4294967295) },
    notBeforeMs: Date.now() - 1000, expiresAtMs: change.expires ?? Date.now() + 60000, reservation: { operations: 1, numericSlots: slots, controlBytes: 65536 } };
}
async function context(t: { after(fn: () => Promise<void>): void }, options: ExecutorFixtureOptions = {}, changes: Parameters<typeof plan>[1] = {}) {
  const fixture = await createExecutorFixture({ certificates, mode: "discovery", uidNext: 10, presentUids: [7, 9], ...options }); t.after(() => fixture.close());
  const manifest = plan(fixture.port, changes);
  const run = (signal = new AbortController().signal, timeout = 2000) => runProtectedMailDiscoverySession({ plan: manifest, password, signal, deadlineAtMs: Date.now() + timeout, ca: fixture.ca, lookup: fixture.lookup });
  return { fixture, manifest, run };
}
async function rejected(work: Promise<unknown>, reason?: string) {
  try { await work; } catch (error) { assert.ok(error instanceof ProtectedMailDiscoveryError && (!reason || error.reason === reason), "discovery_expected_fixed_error"); assert.ok(!error.message.includes(EXECUTOR_FIXTURE_MARKER), "discovery_error_contains_raw_material"); return; }
  assert.fail("discovery_accepted_invalid_wire");
}
const examined = (tag: string, validity = "7", next = "10", extra = "") => Buffer.from(`* OK [UIDVALIDITY ${validity}] stable\r\n* OK [UIDNEXT ${next}] next\r\n${extra}${tag} OK [READ-ONLY] ready\r\n`);
async function until(check: () => boolean) { const deadline = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < deadline, "discovery_fixture_wait_expired"); await new Promise(resolve => setTimeout(resolve, 1)); } }

test("Bootstrap observes UIDNEXT1 with EXAMINE only and no body/SEARCH", async t => {
  const c = await context(t, { uidNext: 1, split: true }, { bootstrap: true }); const value = await c.run();
  assert.ok(value.uidValidity === "7" && value.uidNext === 1 && value.presentUids.length === 0 && Object.isFrozen(value) && Object.isFrozen(value.presentUids), "discovery_bootstrap_metadata_changed");
  assert.ok(c.fixture.stats.commands.join(",") === "CAPABILITY,AUTHENTICATE_PLAIN,EXAMINE" && c.fixture.stats.searches.length === 0 && c.fixture.stats.fetches.length === 0 && !c.fixture.stats.forbidden, "discovery_bootstrap_command_widened");
});
test("NextWindow clips one fixed UID SEARCH to UIDNEXT-1 and retains sparse results", async t => {
  const c = await context(t, { split: true }); const value = await c.run();
  assert.ok(value.presentUids.join(",") === "7,9" && value.uidNext === 10 && c.fixture.stats.searches.length === 1 && c.fixture.stats.searches[0].fromUid === 7 && c.fixture.stats.searches[0].throughUid === 9, "discovery_search_window_widened");
  assert.ok(c.fixture.stats.commands.join(",") === "CAPABILITY,AUTHENTICATE_PLAIN,EXAMINE,UID_SEARCH" && c.fixture.stats.fetches.length === 0 && !c.fixture.stats.forbidden && c.fixture.stats.authenticationMatched && c.fixture.stats.tagsSequential && c.fixture.stats.mailboxMatched, "discovery_issued_unapproved_command");
});
test("all-absent range is distinct from empty horizon without a reversed SEARCH", async t => {
  const absent = await context(t, { uidNext: 15, presentUids: [] }); const a = await absent.run();
  assert.ok(a.presentUids.length === 0 && absent.fixture.stats.searches.length === 1 && absent.fixture.stats.searches[0].throughUid === 14, "discovery_absent_range_changed");
  const horizon = await context(t, { uidNext: 7, presentUids: [] }); const h = await horizon.run();
  assert.ok(h.presentUids.length === 0 && horizon.fixture.stats.searches.length === 0, "discovery_empty_horizon_searched");
});
test("u32 maximum clipping and exact modifiedUTF7 folder stay bounded", async t => {
  const c = await context(t, { uidNext: 4294967295, presentUids: [4294967294], folderWire: '&ZcWITA- &- \\"quoted\\"\\\\' }, { last: 4294967293, folder: '旅行 & "quoted"\\' }); const value = await c.run();
  assert.ok(value.presentUids[0] === 4294967294 && c.fixture.stats.searches[0].fromUid === 4294967294 && c.fixture.stats.searches[0].throughUid === 4294967294 && c.fixture.stats.mailboxMatched, "discovery_max_uid_or_folder_changed");
});

const faults: Array<[string, ExecutorFixtureOptions, Parameters<typeof plan>[1]?, string?]> = [
  ["cursor UIDVALIDITY mismatch", { uidValidity: "8" }, {}, "uid_validity_mismatch"],
  ["head UIDVALIDITY mismatch", { uidValidity: "8" }, { bootstrap: true, headNext: 10 }, "uid_validity_mismatch"],
  ["UIDNEXT cursor rollback", { uidNext: 6 }, {}, "uid_next_rollback"],
  ["UIDNEXT head rollback", { uidNext: 9 }, { headNext: 10 }, "uid_next_rollback"],
  ["duplicate UIDVALIDITY", { examineReply: tag => ({ bytes: examined(tag, "7", "10", "* OK [UIDVALIDITY 7] duplicate\r\n") }) }, {}, "protocol_failure"],
  ["duplicate UIDNEXT", { examineReply: tag => ({ bytes: examined(tag, "7", "10", "* OK [UIDNEXT 10] duplicate\r\n") }) }, {}, "protocol_failure"],
  ["missing UIDNEXT", { examineReply: tag => ({ bytes: Buffer.from(`* OK [UIDVALIDITY 7] stable\r\n${tag} OK [READ-ONLY] ready\r\n`) }) }],
  ["missing UIDVALIDITY", { examineReply: tag => ({ bytes: Buffer.from(`* OK [UIDNEXT 10] next\r\n${tag} OK [READ-ONLY] ready\r\n`) }) }],
  ["zero UIDNEXT", { uidNext: 0 }], ["overflow UIDNEXT", { uidNext: "4294967296" }], ["leading-zero UIDNEXT", { uidNext: "010" }], ["leading-zero UIDVALIDITY", { uidValidity: "07" }],
  ["missing READ-ONLY", { readOnly: false }, {}, "read_only_required"], ["PREAUTH", { greeting: "* PREAUTH synthetic\r\n" }], ["referral", { greeting: "* OK [REFERRAL imap://example.invalid] synthetic\r\n" }],
  ["pure rev2", { capabilities: "IMAP4rev2 AUTH=PLAIN" }], ["UTF8-only", { capabilities: "IMAP4rev1 AUTH=PLAIN UTF8=ONLY" }], ["missing PLAIN", { capabilities: "IMAP4rev1 AUTH=LOGIN" }, {}, "authentication_failed"],
  ["authentication rejection", { authReject: true }, {}, "authentication_failed"], ["extra challenge", { authExtraChallenge: true }],
  ...["7 7", "9 7", "6", "10", "07", "4294967296", "7 8 9 10 11 12 13 14 15", "7 (9)", "{9}"].map((uids, index): [string, ExecutorFixtureOptions, Parameters<typeof plan>[1]?, string?] => [`invalid SEARCH vector ${index}`, { searchReply: request => ({ bytes: Buffer.from(`* SEARCH ${uids}\r\n${request.tag} OK done\r\n`) }) }]),
  ["ESEARCH", { searchReply: request => ({ bytes: Buffer.from(`* ESEARCH UID ALL 7:9\r\n${request.tag} OK done\r\n`) }) }],
  ["duplicate SEARCH", { searchReply: request => ({ bytes: Buffer.from(`* SEARCH 7\r\n* SEARCH 9\r\n${request.tag} OK done\r\n`) }) }],
  ["wrong final tag", { searchReply: () => ({ bytes: Buffer.from("* SEARCH 7\r\nC999 OK done\r\n") }) }],
  ["unsolicited EXPUNGE", { searchReply: request => ({ bytes: Buffer.from(`* 1 EXPUNGE\r\n* SEARCH 7\r\n${request.tag} OK done\r\n`) }) }],
  ["unsolicited FETCH", { searchReply: request => ({ bytes: Buffer.from(`* 1 FETCH (BODY[] {99}\r\n${request.tag} OK done\r\n`) }) }],
  ["literal after tagged OK", { searchReply: request => ({ bytes: Buffer.from(`* SEARCH 7\r\n${request.tag} OK {99}\r\n`) }) }],
  ["buffered trailing data", { searchReply: request => ({ bytes: Buffer.from(`* SEARCH 7\r\n${request.tag} OK done\r\n* SEARCH 9\r\n`) }) }],
  ["oversized line", { greeting: `* OK ${"x".repeat(8192)}\r\n` }, {}, "limit_reached"],
  ["control response flood", { examineReply: tag => ({ bytes: examined(tag, "7", "10", "* 1 EXISTS\r\n".repeat(129)) }) }, {}, "limit_reached"],
  ["accepted metadata overflow", { greeting: `* OK ${"x".repeat(65536)}` }, {}, "limit_reached"],
  ["EOF before final OK", { searchReply: () => ({ bytes: Buffer.from("* SEARCH 7\r\n"), close: true }) }, {}, "transport_closed"],
];
for (const [name, options, changes, reason] of faults) test(`discovery rejects ${name} with no raw or partial output`, async t => {
  const c = await context(t, options, changes); await rejected(c.run(), reason);
  assert.ok(c.fixture.stats.fetches.length === 0 && !c.fixture.stats.forbidden && c.fixture.stats.connections === 1, "discovery_failure_retried_or_fetched");
});
test("TLS CA and hostname are verified before authentication", async t => {
  const wrong = await createExecutorFixtureCertificates("wrong.example.test"); t.after(() => wrong.close());
  for (const mismatch of [false, true]) {
    const fixture = await createExecutorFixture({ certificates: mismatch ? wrong : certificates, mode: "discovery" }); t.after(() => fixture.close());
    await rejected(runProtectedMailDiscoverySession({ plan: plan(fixture.port), password, signal: new AbortController().signal, deadlineAtMs: Date.now() + 2000, ca: mismatch ? wrong.ca : undefined, lookup: fixture.lookup }), "tls_failure");
    assert.ok(fixture.stats.authentications === 0, "discovery_sent_auth_without_verified_tls");
  }
});
test("deadline, expiry and abort close the owned TLS socket without retry", async t => {
  for (const mode of ["deadline", "expiry", "abort"]) {
    const c = await context(t, { greeting: null }, { expires: Date.now() + (mode === "expiry" ? 200 : 60000) }), controller = new AbortController();
    const pending = c.run(controller.signal, mode === "deadline" ? 200 : 2000); await until(() => c.fixture.stats.connections === 1); if (mode === "abort") controller.abort();
    await rejected(pending, mode === "expiry" ? "discovery_expired" : mode === "deadline" ? "deadline_exceeded" : "aborted"); await until(() => c.fixture.stats.closedConnections === 1);
    assert.ok(c.fixture.stats.tcpConnections === 1 && c.fixture.stats.authentications === 0, "discovery_timeout_retried");
  }
});
test("invalid plan/password, preabort and private IP cannot open TCP", async t => {
  const c = await context(t), aborted = new AbortController(); aborted.abort();
  for (const change of [{ password: "bad\u0000password" }, { signal: aborted.signal }, { plan: { ...c.manifest, mailbox: { ...c.manifest.mailbox, host: "127.0.0.1" } } }, { plan: { ...c.manifest, window: { ...c.manifest.window, maxSlots: 9 } } }]) {
    await rejected(runProtectedMailDiscoverySession({ plan: c.manifest, password, signal: new AbortController().signal, deadlineAtMs: Date.now() + 2000, ca: c.fixture.ca, lookup: c.fixture.lookup, ...change }));
  }
  assert.ok(c.fixture.stats.tcpConnections === 0, "discovery_invalid_preflight_dialed");
});
