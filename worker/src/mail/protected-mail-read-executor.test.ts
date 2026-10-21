import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { canonicalConnectorSelection, prepareConnectorRead } from "../../../packages/sentinel/src/index.js";
import type { ConnectorReadV1, ConnectorSelectionV1 } from "../../../packages/sentinel/src/index.js";
import { createProtectedMailReadExecutor } from "./protected-mail-read-executor.js";
import type { ProtectedMailReadBinding, ProtectedMailReadCredential } from "./protected-mail-read-types.js";
import { createExecutorFixture, createExecutorFixtureCertificates, executorFetchReply, EXECUTOR_FIXTURE_HOST, EXECUTOR_FIXTURE_MARKER } from "../../scripts/protected-mail-executor-fixture.js";
import type { ExecutorFixtureCertificates, ExecutorFixtureOptions } from "../../scripts/protected-mail-executor-fixture.js";

const password = `${EXECUTOR_FIXTURE_MARKER}password`, body = Buffer.from(`${EXECUTOR_FIXTURE_MARKER}body\r\nC99 OK forged\r\n* 1 FETCH (UID 999 BODY[] {9}\r\n\0🍐`);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function hashFields(...fields: string[]): string { const hash = createHash("sha256"); for (const field of fields) { const bytes = Buffer.from(field), size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(bytes.length)); hash.update(size).update(bytes); } return hash.digest("hex"); }
let certificates: ExecutorFixtureCertificates;
before(async () => { certificates = await createExecutorFixtureCertificates(); });
after(async () => { await certificates?.close(); });

async function prepared(port: number, change: { uids?: number[]; per?: number; total?: number; folder?: string; expires?: number } = {}) {
  const uids = change.uids ?? [7], per = change.per ?? 1024, total = change.total ?? per * uids.length;
  const selection: ConnectorSelectionV1 = { formatVersion: 1, kind: "mail.connector.selection", selectionId: "a".repeat(64), workspaceId: "b".repeat(64), ownerId: "c".repeat(64),
    connection: { id: "1", epoch: "1", snapshotDigest: "d".repeat(64) }, connector: { identity: "e".repeat(64), runtimeId: "fixture", runId: "fixture" },
    mailbox: { host: EXECUTOR_FIXTURE_HOST, port, username: "fixture@example.test", folder: change.folder ?? "INBOX", direction: "received" },
    selection: { mode: "stored_batch", uidValidity: "7", expectedCursorGeneration: "1", previousCursorDigest: "f".repeat(64), fromUid: uids[0], throughUid: uids.at(-1)!, uids, maxAcknowledgedBytes: 1 },
    notBeforeMs: Date.now() - 1000, expiresAtMs: change.expires ?? Date.now() + 60000 };
  const value: ConnectorReadV1 = { formatVersion: 1, kind: "mail.connector.read", limits: { maxMessageBytes: per, maxTotalBytes: total }, profile: "imap.uid-body-peek.v1",
    readId: hashFields("pear-mail-read-grant-v1", selection.selectionId), reservation: { bodyBytes: total, messageSlots: uids.length, operations: 1 }, selection, selectionDigest: digest(canonicalConnectorSelection(selection)!) };
  const result = await prepareConnectorRead(value); assert.ok(result.status === "prepared", "executor_fixture_plan_invalid"); return result.read;
}
function authority(plan: Awaited<ReturnType<typeof prepared>>, mode: "ok" | "denied" | "unknown" | "lost" | "bad_id" | "hung" = "ok", lostReport = false) {
  const stats = { claims: 0, reports: 0, consumed: false, outcomes: [] as number[], nonces: [] as string[] };
  const fetchImpl: typeof fetch = async (input, init) => {
    const target = new URL(String(input));
    if (target.pathname.endsWith("/begin_protected_mail_read_dispatch")) {
      stats.claims++;
      if (mode === "hung") return await new Promise<Response>(() => {});
      if (mode === "unknown") throw Error(`${EXECUTOR_FIXTURE_MARKER}authority_error`);
      if (mode === "denied") return Response.json([1, "protected_mail_read_service_required"]);
      if (stats.consumed) return Response.json([1, "protected_mail_read_consumed"]);
      stats.consumed = true;
      const payload = [mode === "bad_id" ? "0".repeat(64) : plan.manifest.readId, plan.planDigest, plan.planBytes, plan.canonical];
      return mode === "lost" ? new Response("[0,[", { headers: { "Content-Type": "application/json" } }) : Response.json([0, payload]);
    }
    if (target.pathname.endsWith("/finish_protected_mail_read_dispatch")) {
      stats.reports++; const args: unknown = JSON.parse(String(init?.body));
      assert.ok(Array.isArray(args) && args.length === 3 && args[0] === plan.manifest.readId && Array.isArray(args[1]) && typeof args[2] === "string" && /^[a-f0-9]{64}$/.test(args[2]), "executor_fixture_report_shape");
      stats.outcomes.push(args[1][0]); stats.nonces.push(args[2]);
      if (lostReport) throw Error(`${EXECUTOR_FIXTURE_MARKER}report_error`);
      return new Response(null, { status: 200 });
    }
    throw Error("executor_fixture_unexpected_authority_route");
  };
  return { stats, options: { baseUrl: "http://127.0.0.1:1", dbName: "executor-fixture", token: "synthetic-token", fetchImpl } };
}
async function setup(t: { after(fn: () => Promise<void>): void }, options: ExecutorFixtureOptions = {}, change: Parameters<typeof prepared>[1] = {}) {
  const fixture = await createExecutorFixture({ certificates, messages: new Map([[7, body]]), ...options }); t.after(() => fixture.close());
  const plan = await prepared(fixture.port, change), host = authority(plan); let resolutions = 0;
  const resolver = async (binding: ProtectedMailReadBinding): Promise<ProtectedMailReadCredential> => { resolutions++; assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.uids), "executor_binding_not_frozen"); return { binding, password }; };
  const executor = createProtectedMailReadExecutor({ authority: host.options, resolveCredential: resolver, ca: fixture.ca, lookup: fixture.lookup, timeoutMs: 3000 });
  return { fixture, plan, host, executor, resolver, resolutions: () => resolutions };
}
function noRaw(result: unknown): void { const encoded = JSON.stringify(result); assert.ok(!encoded.includes(EXECUTOR_FIXTURE_MARKER) && !encoded.includes(Buffer.from(`\0fixture@example.test\0${password}`).toString("base64")), "executor_returned_raw_fixture_material"); }
async function until(check: () => boolean): Promise<void> { const deadline = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < deadline, "executor_fixture_wait_expired"); await new Promise(resolve => setTimeout(resolve, 1)); } }

test("private certificates and exact TLS/PLAIN/EXAMINE/PEEK transcript release metadata only", async t => {
  const { fixture, plan, host, executor, resolutions } = await setup(t, { split: true });
  assert.ok((await lstat(certificates.directory)).mode % 512 === 0o700, "executor_fixture_directory_mode");
  for (const name of await readdir(certificates.directory)) assert.ok(((await lstat(join(certificates.directory, name))).mode & 0o777) === 0o600, "executor_fixture_file_mode");
  const result = await executor(plan.manifest.readId); assert.ok(result.kind === "completed", "executor_expected_completion");
  assert.ok(result.bodyBytes === body.length && result.messages.length === 1 && result.messages[0].uid === 7 && result.messages[0].bytes === body.length && result.messages[0].digest === digest(body), "executor_metadata_changed");
  assert.ok(fixture.stats.tagsSequential && fixture.stats.mailboxMatched && fixture.stats.authenticationMatched && !fixture.stats.forbidden, "executor_transcript_binding_changed");
  assert.ok(fixture.stats.commands.join(",") === "CAPABILITY,AUTHENTICATE_PLAIN,EXAMINE,UID_FETCH_PEEK" && fixture.stats.fetches[0].limit === 1024, "executor_issued_unapproved_commands");
  assert.ok(resolutions() === 1 && host.stats.claims === 1 && host.stats.reports === 1 && host.stats.outcomes[0] === 0, "executor_lifecycle_count"); noRaw(result);
  const repeated = await executor(plan.manifest.readId); assert.ok(repeated.kind === "denied" && fixture.stats.connections === 1 && resolutions() === 1, "executor_retried_consumed_read");
});

test("modified UTF7 encodes the exact Unicode folder and UID/SIZE ordering may vary before BODY", async t => {
  const folder = '旅行 & "quoted"\\', wire = '&ZcWITA- &- \\"quoted\\"\\\\';
  const context = await setup(t, { folderWire: wire, fetchReply: request => ({ bytes: executorFetchReply(request, body, { prefix: `* 99 FETCH (RFC822.SIZE ${body.length} UID ${request.uid} BODY[]<0> {${body.length}}\r\n` }) }) }, { folder });
  const result = await context.executor(context.plan.manifest.readId);
  assert.ok(result.kind === "completed" && context.fixture.stats.mailboxMatched, "executor_utf7_or_fetch_order_changed"); noRaw(result);
});

for (const mode of ["denied", "unknown", "lost", "bad_id"] as const) test(`claim ${mode} prevents credential resolution and every TLS connection`, async t => {
  const fixture = await createExecutorFixture({ certificates }); t.after(() => fixture.close()); const plan = await prepared(fixture.port), host = authority(plan, mode); let resolved = 0;
  const executor = createProtectedMailReadExecutor({ authority: host.options, resolveCredential: async binding => { resolved++; return { binding, password }; }, ca: fixture.ca, lookup: fixture.lookup, timeoutMs: 500 });
  const result = await executor(plan.manifest.readId); assert.ok(result.kind === (mode === "denied" ? "denied" : "unknown") && resolved === 0 && fixture.stats.tcpConnections === 0 && host.stats.reports === 0 && host.stats.claims === 1, "executor_dialed_without_fresh_claim"); noRaw(result);
});

test("credential binding mismatch and raw resolver errors stop before dial without an environment fallback", async t => {
  const fixture = await createExecutorFixture({ certificates }); t.after(() => fixture.close());
  for (const mismatch of [true, false]) {
    const plan = await prepared(fixture.port), host = authority(plan);
    const executor = createProtectedMailReadExecutor({ authority: host.options, resolveCredential: async binding => { if (!mismatch) throw Error(`${EXECUTOR_FIXTURE_MARKER}resolver`); return { binding: { ...binding, connectionEpoch: "2" }, password }; }, ca: fixture.ca, lookup: fixture.lookup });
    const result = await executor(plan.manifest.readId); assert.ok(result.kind === "stopped" && fixture.stats.tcpConnections === 0 && host.stats.reports === 1, "executor_accepted_unbound_credential"); noRaw(result);
  }
});

test("late resolver success after abort cannot dial and reports a single chosen outcome", async t => {
  const context = await setup(t); let release!: (value: ProtectedMailReadCredential) => void, captured!: ProtectedMailReadBinding;
  const executor = createProtectedMailReadExecutor({ authority: context.host.options, resolveCredential: binding => { captured = binding; return new Promise(resolve => { release = resolve; }); }, ca: context.fixture.ca, lookup: context.fixture.lookup });
  const controller = new AbortController(), pending = executor(context.plan.manifest.readId, controller.signal);
  await until(() => Boolean(release)); controller.abort();
  const result = await pending; release({ binding: captured, password }); await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(result.kind === "stopped" && context.fixture.stats.tcpConnections === 0 && context.host.stats.reports === 1, "executor_late_resolver_dialed"); noRaw(result);
});

test("late successful claim after abort never resolves credentials, dials or reports", async t => {
  const fixture = await createExecutorFixture({ certificates }); t.after(() => fixture.close()); const plan = await prepared(fixture.port);
  let release!: (response: Response) => void, claims = 0, reports = 0, resolutions = 0;
  const fetchImpl: typeof fetch = async input => {
    if (new URL(String(input)).pathname.endsWith("/begin_protected_mail_read_dispatch")) { claims++; return await new Promise<Response>(resolve => { release = resolve; }); }
    reports++; return new Response(null, { status: 200 });
  };
  const execute = createProtectedMailReadExecutor({ authority: { baseUrl: "http://127.0.0.1:1", dbName: "executor-fixture", token: "synthetic-token", fetchImpl },
    resolveCredential: async binding => { resolutions++; return { binding, password }; }, ca: fixture.ca, lookup: fixture.lookup });
  const controller = new AbortController(), pending = execute(plan.manifest.readId, controller.signal);
  await until(() => Boolean(release)); controller.abort(); const result = await pending;
  release(Response.json([0, [plan.manifest.readId, plan.planDigest, plan.planBytes, plan.canonical]])); await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(result.kind === "unknown" && claims === 1 && resolutions === 0 && fixture.stats.tcpConnections === 0 && reports === 0, "executor_late_claim_dialed"); noRaw(result);
});

test("selection expiry bounds a hung credential resolver and its late success cannot dial", async t => {
  const fixture = await createExecutorFixture({ certificates }); t.after(() => fixture.close());
  const plan = await prepared(fixture.port, { expires: Date.now() + 300 }), host = authority(plan);
  let release!: (value: ProtectedMailReadCredential) => void, captured!: ProtectedMailReadBinding, resolverAborted = false;
  const execute = createProtectedMailReadExecutor({ authority: host.options, ca: fixture.ca, lookup: fixture.lookup, timeoutMs: 2000,
    resolveCredential: (binding, signal) => { captured = binding; signal.addEventListener("abort", () => { resolverAborted = true; }, { once: true }); return new Promise(resolve => { release = resolve; }); } });
  const started = Date.now(), result = await execute(plan.manifest.readId);
  assert.ok(result.kind === "stopped" && result.reason === "read_expired" && Date.now() - started < 1200 && resolverAborted && fixture.stats.tcpConnections === 0 && host.stats.reports === 1, "executor_resolver_outlived_selection");
  assert.ok(Boolean(release), "executor_expiry_resolver_not_started"); release({ binding: captured, password }); await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fixture.stats.tcpConnections === 0 && host.stats.reports === 1, "executor_expired_late_credential_dialed"); noRaw(result);
});

test("hung claim and greeting obey deadlines without credential/socket retries", async t => {
  const fixture = await createExecutorFixture({ certificates, greeting: null }); t.after(() => fixture.close());
  const plan = await prepared(fixture.port), hung = authority(plan, "hung"); let resolved = 0;
  const executeHung = createProtectedMailReadExecutor({ authority: hung.options, resolveCredential: async binding => { resolved++; return { binding, password }; }, ca: fixture.ca, lookup: fixture.lookup, timeoutMs: 100 });
  const unknown = await executeHung(plan.manifest.readId);
  assert.ok(unknown.kind === "unknown" && resolved === 0 && fixture.stats.tcpConnections === 0, "executor_hung_claim_dialed");
  const host = authority(plan), executeGreeting = createProtectedMailReadExecutor({ authority: host.options, resolveCredential: async binding => ({ binding, password }), ca: fixture.ca, lookup: fixture.lookup, timeoutMs: 250 });
  const stopped = await executeGreeting(plan.manifest.readId);
  await until(() => fixture.stats.closedConnections === 1);
  assert.ok(stopped.kind === "stopped" && stopped.reason === "deadline_exceeded" && fixture.stats.authentications === 0 && host.stats.reports === 1 && Number(fixture.stats.tcpConnections) === 1, "executor_hung_greeting_not_bounded"); noRaw(stopped);
});

test("abort during a requested literal yields no partial metadata and no second session", async t => {
  const context = await setup(t, { fetchReply: request => ({ bytes: Buffer.from(`* 1 FETCH (UID ${request.uid} RFC822.SIZE 50 BODY[]<0> {50}\r\nabc`) }) });
  const controller = new AbortController(), pending = context.executor(context.plan.manifest.readId, controller.signal);
  await until(() => context.fixture.stats.fetches.length > 0); controller.abort();
  const result = await pending;
  await until(() => context.fixture.stats.closedConnections === 1);
  assert.ok(result.kind === "stopped" && result.reason === "aborted" && !("messages" in result) && context.fixture.stats.connections === 1 && context.host.stats.outcomes[0] === 2, "executor_abort_returned_partial_data"); noRaw(result);
});

test("credential descriptors and password scalars are closed without invoking data getters", async t => {
  const fixture = await createExecutorFixture({ certificates }); t.after(() => fixture.close()); let getter = false;
  for (const kind of ["extra", "getter", "control", "surrogate"]) {
    const plan = await prepared(fixture.port), host = authority(plan);
    const execute = createProtectedMailReadExecutor({ authority: host.options, ca: fixture.ca, lookup: fixture.lookup, resolveCredential: async binding => {
      if (kind === "extra") return { binding: { ...binding, extra: true }, password } as ProtectedMailReadCredential;
      if (kind === "getter") { const value = { binding } as ProtectedMailReadCredential; Object.defineProperty(value, "password", { enumerable: true, get() { getter = true; throw Error(`${EXECUTOR_FIXTURE_MARKER}getter`); } }); return value; }
      return { binding, password: kind === "control" ? "x\u0000y" : "\ud800" };
    } });
    const result = await execute(plan.manifest.readId); assert.ok(result.kind === "stopped" && fixture.stats.tcpConnections === 0 && !getter, "executor_credential_channel_accepted"); noRaw(result);
  }
});

test("server and resolver secret markers never reach diagnostic methods or returned errors", async t => {
  const context = await setup(t, { fetchReply: request => ({ bytes: Buffer.from(`${request.tag} NO ${EXECUTOR_FIXTURE_MARKER}server_error\r\n`) }) });
  const captured: string[] = [], original = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...values: unknown[]) => { captured.push(values.map(value => String(value)).join(" ")); };
  let result: Awaited<ReturnType<typeof context.executor>>;
  try { result = await context.executor(context.plan.manifest.readId); }
  finally { [console.log, console.warn, console.error] = original; }
  assert.ok(captured.every(value => !value.includes(EXECUTOR_FIXTURE_MARKER) && !value.includes(Buffer.from(`\0fixture@example.test\0${password}`).toString("base64"))), "executor_logged_secret_material"); noRaw(result!);
});

test("untrusted CA and wrong certificate hostname transmit no authentication", async t => {
  const wrongCertificates = await createExecutorFixtureCertificates("wrong.example.test"); t.after(() => wrongCertificates.close());
  for (const mismatch of [false, true]) {
    const fixture = await createExecutorFixture({ certificates: mismatch ? wrongCertificates : certificates }); t.after(() => fixture.close());
    const plan = await prepared(fixture.port), host = authority(plan);
    const executor = createProtectedMailReadExecutor({ authority: host.options, resolveCredential: async binding => ({ binding, password }), ca: mismatch ? wrongCertificates.ca : undefined, lookup: fixture.lookup, timeoutMs: 1000 });
    const result = await executor(plan.manifest.readId); assert.ok(result.kind === "stopped" && result.reason === "tls_failure" && fixture.stats.authentications === 0, "executor_disabled_tls_verification"); noRaw(result);
  }
});

const faults: Array<[string, ExecutorFixtureOptions, string?]> = [
  ["wrong UIDVALIDITY", { uidValidity: "8" }, "uid_validity_mismatch"], ["missing read-only", { readOnly: false }, "read_only_required"],
  ["PREAUTH", { greeting: "* PREAUTH synthetic\r\n" }], ["referral", { greeting: "* OK [REFERRAL imap://attacker.invalid] synthetic\r\n" }],
  ["pure rev2", { capabilities: "IMAP4rev2 AUTH=PLAIN" }], ["UTF8 only", { capabilities: "IMAP4rev1 AUTH=PLAIN UTF8=ONLY" }],
  ["missing PLAIN", { capabilities: "IMAP4rev1 AUTH=LOGIN" }], ["authentication rejection", { authReject: true }, "authentication_failed"],
  ["extra PLAIN challenge", { authExtraChallenge: true }],
  ["wrong UID", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { uid: 999 }) }) }, "uid_mismatch"],
  ["wrong offset", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { offset: 1 }) }) }],
  ["SIZE mismatch", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { size: body.length + 1 }) }) }, "incomplete_read"],
  ["announced oversized literal", { fetchReply: request => ({ bytes: executorFetchReply(request, Buffer.alloc(0), { declaredLength: request.limit + 1, size: request.limit + 1 }) }) }, "limit_reached"],
  ["UID after BODY", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { prefix: `* 1 FETCH (RFC822.SIZE ${body.length} BODY[]<0> {${body.length}}\r\n`, suffix: ` UID ${request.uid})\r\n${request.tag} OK fetched\r\n` }) }) }],
  ["extra attribute", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { prefix: `* 1 FETCH (UID ${request.uid} FLAGS (\\Seen) RFC822.SIZE ${body.length} BODY[]<0> {${body.length}}\r\n` }) }) }],
  ["duplicate FETCH", { fetchReply: request => ({ bytes: Buffer.concat([executorFetchReply(request, body, { suffix: ")\r\n" }), executorFetchReply(request, body)]) }) }],
  ["trailing FETCH after final OK", { fetchReply: request => ({ bytes: Buffer.concat([executorFetchReply(request, body), executorFetchReply(request, body)]) }) }],
  ["wrong tag", { fetchReply: request => ({ bytes: executorFetchReply(request, body, { tag: "C999" }) }) }],
  ["missing UID", { fetchReply: request => ({ bytes: Buffer.from(`${request.tag} OK empty\r\n`) }) }, "missing_uid"],
  ["truncated literal", { fetchReply: request => ({ bytes: executorFetchReply(request, body.subarray(0, 3), { declaredLength: body.length, size: body.length, suffix: "" }), close: true }) }],
  ["oversized control line", { greeting: `* OK ${"x".repeat(8192)}\r\n` }, "limit_reached"],
  ["control response flood", { examineReply: tag => ({ bytes: Buffer.from(`${"* 1 EXISTS\r\n".repeat(129)}${tag} OK [READ-ONLY] synthetic\r\n`) }) }, "limit_reached"],
];
for (const [name, options, reason] of faults) test(`fixed wire rejects ${name} without raw or partial output`, async t => {
  const context = await setup(t, options); const result = await context.executor(context.plan.manifest.readId);
  assert.ok(result.kind === "stopped", "executor_accepted_invalid_wire"); if (reason) assert.ok(result.reason === reason, "executor_wrong_fixed_reason");
  assert.ok(!("messages" in result) && !context.fixture.stats.forbidden && context.host.stats.claims === 1 && context.host.stats.reports === 1, "executor_leaked_partial_or_retried"); noRaw(result);
});

test("exact per-message cap is always incomplete and never probes one extra byte", async t => {
  const context = await setup(t, { messages: new Map([[7, Buffer.alloc(64, 65)]]) }, { per: 64, total: 64 });
  const result = await context.executor(context.plan.manifest.readId);
  assert.ok(result.kind === "stopped" && result.reason === "limit_reached" && context.fixture.stats.fetches.length === 1 && context.fixture.stats.fetches[0].limit === 64, "executor_cap_plus_one_probe"); noRaw(result);
});

test("aggregate remaining cap bounds next UID and final failure exposes no partial batch", async t => {
  const context = await setup(t, { messages: new Map([[7, Buffer.alloc(60, 65)], [8, Buffer.alloc(40, 66)]]) }, { uids: [7, 8], per: 80, total: 100 });
  const result = await context.executor(context.plan.manifest.readId);
  assert.ok(result.kind === "stopped" && result.reason === "limit_reached" && !("messages" in result) && context.fixture.stats.fetches.length === 2
    && context.fixture.stats.fetches[0].limit === 80 && context.fixture.stats.fetches[1].limit === 40, "executor_aggregate_cap_widened"); noRaw(result);
});

test("zero literal is accepted and lost report cannot change outcome or repeat read", async t => {
  const fixture = await createExecutorFixture({ certificates, messages: new Map([[7, Buffer.alloc(0)]]) }); t.after(() => fixture.close());
  const plan = await prepared(fixture.port), host = authority(plan, "ok", true);
  const executor = createProtectedMailReadExecutor({ authority: host.options, resolveCredential: async binding => ({ binding, password }), ca: fixture.ca, lookup: fixture.lookup });
  const result = await executor(plan.manifest.readId);
  assert.ok(result.kind === "completed" && result.bodyBytes === 0 && result.report.kind === "unknown" && result.report.outcome === "ReadReported" && host.stats.reports === 1 && host.stats.outcomes[0] === 0, "executor_changed_chosen_outcome_after_report_loss"); noRaw(result);
  await executor(plan.manifest.readId); assert.ok(fixture.stats.connections === 1 && host.stats.reports === 1, "executor_repeated_after_report_loss");
});

test("concurrent executions consume one authority winner and open one TLS session", async t => {
  const context = await setup(t), results = await Promise.all(Array.from({ length: 8 }, () => context.executor(context.plan.manifest.readId)));
  assert.ok(results.filter(result => result.kind === "completed").length === 1 && results.filter(result => result.kind === "denied").length === 7 && context.fixture.stats.connections === 1
    && context.resolutions() === 1 && context.host.stats.reports === 1, "executor_concurrent_read_replayed"); results.forEach(noRaw);
});
