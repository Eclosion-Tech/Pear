import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prepareConnectorSparseRead, type ConnectorSparseReadV1 } from "../../../packages/sentinel/src/index.js";
import { createProtectedMailSparseReadExecutor, type ProtectedMailSparseReadExecutorOptions } from "./protected-mail-sparse-read-executor.js";
import { ProtectedMailSparseReadImapError, type ProtectedMailSparseReadBinding, type ProtectedMailSparseReadCredential } from "./protected-mail-sparse-read-executor-types.js";
import { createExecutorFixture, createExecutorFixtureCertificates, executorFetchReply, EXECUTOR_FIXTURE_HOST } from "../../scripts/protected-mail-executor-fixture.js";
import type { ExecutorFixtureCertificates, ExecutorFixtureOptions } from "../../scripts/protected-mail-executor-fixture.js";

const marker = "SPARSE_EXECUTOR_PRIVATE_SYNTHETIC_", password = `${marker}password`;
const body = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.from(`${marker}* SEARCH 1 3\r\nC7 OK fake\r\n`)]);
let certificates: ExecutorFixtureCertificates;
before(async () => { certificates = await createExecutorFixtureCertificates(); });
after(async () => { await certificates?.close(); });

async function prepared(port: number, expiresAtMs = Date.now() + 60_000) {
  const value: ConnectorSparseReadV1 = { formatVersion: 1, kind: "mail.connector.sparse_read", readId: "891192f3dd1bb101132702d3c82e07fc3bb76d98f0b127d2bc952e214b0b4509",
    eventNonce: "b".repeat(64), workspaceId: "c".repeat(64), ownerId: "d".repeat(64), connection: { id: "1", epoch: "2", snapshotDigest: "e".repeat(64) },
    connector: { identity: "f".repeat(64), runtimeId: "fixture-runtime", runId: "fixture-run" }, mailbox: { host: EXECUTOR_FIXTURE_HOST, port, username: "fixture@example.test", folder: "INBOX", direction: "received" },
    cursor: { id: "mail-connector-cursor:" + "1".repeat(64), generation: "1", digest: "2".repeat(64), uidValidity: "7", lastUid: 0 },
    observation: { id: "a".repeat(64), digest: "3".repeat(64), manifestDigest: "4".repeat(64), headId: "mail-discovery-head:" + "5".repeat(64), headGeneration: "2",
      uidValidity: "7", uidNext: 9, fromUid: 1, throughUid: 8, presentUids: [2, 5, 8], absentUids: [1, 3, 4, 6, 7] },
    limits: { maxMessageBytes: 128, maxTotalBytes: 256 }, profile: "imap.observed-uid-body-peek.v1", reservation: { bodyBytes: 256, messageSlots: 3, operations: 1 },
    notBeforeMs: Date.now() - 1000, expiresAtMs };
  const result = await prepareConnectorSparseRead(value); assert.ok(result.status === "prepared", "sparse_executor_fixture_plan_invalid"); return result.read;
}
function authority(plan: Awaited<ReturnType<typeof prepared>>, mode: "ok" | "denied" | "unknown" | "lost" | "bad_id" | "hung" = "ok", lostReport = false) {
  const stats = { claims: 0, reports: 0, consumed: false, outcomes: [] as number[], nonces: [] as string[] };
  const fetchImpl: typeof fetch = async (input, init) => {
    const route = new URL(String(input)).pathname;
    if (route.endsWith("/begin_protected_mail_sparse_read_dispatch")) {
      stats.claims++;
      if (mode === "hung") return await new Promise<Response>(() => {});
      if (mode === "unknown") throw Error(`${marker}authority_error`);
      if (mode === "denied") return Response.json([1, "protected_mail_sparse_read_service_required"]);
      if (stats.consumed) return Response.json([1, "protected_mail_sparse_read_consumed"]);
      stats.consumed = true;
      const dto = [mode === "bad_id" ? "0".repeat(64) : plan.manifest.readId, plan.planDigest, plan.planBytes, plan.canonical];
      return mode === "lost" ? new Response("[0,[", { headers: { "Content-Type": "application/json" } }) : Response.json([0, dto]);
    }
    if (route.endsWith("/finish_protected_mail_sparse_read_dispatch")) {
      stats.reports++; const args: unknown = JSON.parse(String(init?.body));
      assert.ok(Array.isArray(args) && args.length === 3 && args[0] === plan.manifest.readId && Array.isArray(args[1]) && args[1].length === 2
        && [0, 1, 2].includes(args[1][0]) && typeof args[2] === "string" && /^[a-f0-9]{64}$/.test(args[2]), "sparse_executor_fixture_report_shape");
      stats.outcomes.push(args[1][0]); stats.nonces.push(args[2]);
      if (lostReport) throw Error(`${marker}report_error`);
      return new Response(null, { status: 200 });
    }
    throw Error("sparse_executor_fixture_unexpected_authority_route");
  };
  return { stats, options: { baseUrl: "http://127.0.0.1:1", dbName: "sparse-executor-fixture", token: "synthetic-token", fetchImpl } };
}
const examine = (tag: string, next = 10) => ({ bytes: Buffer.from(`* OK [UIDVALIDITY 7] stable\r\n* OK [UIDNEXT ${next}] next\r\n${tag} OK [READ-ONLY] examined\r\n`) });
async function setup(t: { after(fn: () => Promise<void>): void }, options: ExecutorFixtureOptions = {}) {
  const fixture = await createExecutorFixture({ certificates, password, messages: new Map([[2, body], [5, body], [8, body]]), examineReply: tag => examine(tag), ...options });
  t.after(() => fixture.close());
  const plan = await prepared(fixture.port), host = authority(plan); let resolutions = 0;
  const resolver = async (binding: ProtectedMailSparseReadBinding): Promise<ProtectedMailSparseReadCredential> => {
    resolutions++; assert.ok(Object.isFrozen(binding) && binding.canonical === plan.canonical && binding.planDigest === plan.planDigest, "sparse_executor_binding_not_exact_frozen");
    return { binding, password };
  };
  const execute = createProtectedMailSparseReadExecutor({ authority: host.options, resolveCredential: resolver, ca: fixture.ca, lookup: fixture.lookup, timeoutMs: 3000 });
  return { fixture, plan, host, resolver, execute, resolutions: () => resolutions };
}
function opaque(result: unknown): void {
  assert.ok(result && typeof result === "object" && Object.isFrozen(result), "sparse_executor_result_not_frozen");
  const row = result as Record<string, unknown>, keys = row.kind === "completed" ? ["kind", "readId", "planDigest", "report"]
    : row.kind === "stopped" ? ["kind", "readId", "reason", "report"] : ["kind", "reason"];
  assert.ok(Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)), "sparse_executor_result_exposed_local_metadata");
  if (row.report) {
    const report = row.report as Record<string, unknown>;
    assert.ok(Object.isFrozen(report) && Object.keys(report).length === 3 && ["kind", "eventNonce", "outcome"].every(key => Object.hasOwn(report, key)), "sparse_executor_report_not_closed");
  }
  const encoded = JSON.stringify(result);
  assert.ok(!encoded.includes(marker) && !encoded.includes(Buffer.from(`\0fixture@example.test\0${password}`).toString("base64"))
    && !encoded.includes(EXECUTOR_FIXTURE_HOST) && !encoded.includes("fixture@example.test"), "sparse_executor_public_private_material");
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < deadline, "sparse_executor_fixture_wait_expired"); await new Promise(resolve => setTimeout(resolve, 1)); }
}

test("fresh sparse claim/complete credential echo produces exact three FETCHes and opaque public success", async t => {
  const c = await setup(t, { split: true }), result = await c.execute(c.plan.manifest.readId);
  assert.ok(result.kind === "completed" && result.planDigest === c.plan.planDigest && result.report.kind === "recorded" && result.report.outcome === "ReadReported", "sparse_executor_completion_changed"); opaque(result);
  assert.ok(c.fixture.stats.fetches.map(item => item.uid).join(",") === "2,5,8" && c.fixture.stats.searches.length === 0 && !c.fixture.stats.forbidden
    && c.fixture.stats.tagsSequential && c.fixture.stats.mailboxMatched && c.fixture.stats.authenticationMatched, "sparse_executor_targets_or_protocol_widened");
  assert.ok(c.host.stats.claims === 1 && c.resolutions() === 1 && c.host.stats.reports === 1 && c.host.stats.outcomes[0] === 0, "sparse_executor_lifecycle_count");
  const again = await c.execute(c.plan.manifest.readId); opaque(again);
  assert.ok(again.kind === "denied" && c.fixture.stats.tcpConnections === 1 && c.resolutions() === 1 && c.host.stats.reports === 1, "sparse_executor_consumed_retry_started_work");
});

for (const mode of ["denied", "unknown", "lost", "bad_id"] as const) test(`claim ${mode} yields zero credentials/TCP/reports`, async t => {
  const c = await setup(t), host = authority(c.plan, mode); let resolutions = 0;
  const execute = createProtectedMailSparseReadExecutor({ authority: host.options, resolveCredential: async binding => { resolutions++; return { binding, password }; }, ca: c.fixture.ca, lookup: c.fixture.lookup });
  const result = await execute(c.plan.manifest.readId); opaque(result);
  assert.ok(result.kind === (mode === "denied" ? "denied" : "unknown") && resolutions === 0 && c.fixture.stats.tcpConnections === 0 && host.stats.reports === 0, "sparse_executor_work_without_claim");
});

test("concurrent executions receive one fresh claim and one TLS session", async t => {
  const c = await setup(t), results = await Promise.all(Array.from({ length: 8 }, () => c.execute(c.plan.manifest.readId)));
  results.forEach(opaque);
  assert.ok(results.filter(result => result.kind === "completed").length === 1 && results.filter(result => result.kind === "denied").length === 7
    && c.fixture.stats.tcpConnections === 1 && c.resolutions() === 1 && c.host.stats.reports === 1, "sparse_executor_concurrent_reexecution");
});

test("every credential binding field, password scalar and descriptor is exact before dialing", async t => {
  const c = await setup(t); let getter = false;
  const changes: Array<(binding: ProtectedMailSparseReadBinding) => unknown> = [
    ...["readId", "planDigest", "canonical", "workspaceId", "ownerId", "connectionId", "connectionEpoch", "snapshotDigest", "host", "username", "folder", "direction"].map(key =>
      (binding: ProtectedMailSparseReadBinding) => ({ binding: { ...binding, [key]: "substituted" }, password })),
    ...["port", "notBeforeMs", "expiresAtMs"].map(key => (binding: ProtectedMailSparseReadBinding) => ({ binding: { ...binding, [key]: -1 }, password })),
    ...["", "x\u0085y", "\ud800", "🍐".repeat(1025)].map(value => (binding: ProtectedMailSparseReadBinding) => ({ binding, password: value })),
    binding => ({ binding: { ...binding, approved: true }, password }), binding => Object.assign(Object.create({ approved: true }), { binding, password }),
    binding => Object.defineProperty({ binding }, "password", { enumerable: true, get() { getter = true; return password; } }),
    binding => ({ binding: Object.defineProperty({ ...binding }, "canonical", { enumerable: true, get() { getter = true; return binding.canonical; } }), password }),
    binding => ({ binding: Object.defineProperty({ ...binding }, "canonical", { value: binding.canonical, enumerable: false }), password }),
    binding => ({ binding, password, [Symbol("extra")]: true }),
  ];
  for (const change of changes) {
    const host = authority(c.plan), execute = createProtectedMailSparseReadExecutor({ authority: host.options,
      resolveCredential: async binding => change(binding) as ProtectedMailSparseReadCredential, ca: c.fixture.ca, lookup: c.fixture.lookup });
    const result = await execute(c.plan.manifest.readId); opaque(result);
    assert.ok(result.kind === "stopped" && result.reason === "credential_binding_mismatch" && host.stats.reports === 1 && host.stats.outcomes[0] === 1
      && c.fixture.stats.tcpConnections === 0, "sparse_executor_unbound_credential_dialed");
  }
  assert.ok(!getter, "sparse_executor_invoked_credential_getter");
});

test("factory copies closed host options once and refuses getters/symbols/prototypes before claim", async t => {
  const c = await setup(t), config = { authority: { ...c.host.options }, resolveCredential: c.resolver, ca: c.fixture.ca, lookup: c.fixture.lookup };
  const execute = createProtectedMailSparseReadExecutor(config);
  config.authority.token = "changed"; config.authority.baseUrl = "http://attacker.invalid";
  config.resolveCredential = async () => { throw Error(`${marker}mutated_resolver`); };
  const result = await execute(c.plan.manifest.readId); opaque(result); assert.ok(result.kind === "completed", "sparse_executor_options_alias_changed_work");
  let claims = 0, getter = false;
  const safe = { authority: { ...c.host.options, fetchImpl: (async () => { claims++; throw Error("unexpected_fetch"); }) as typeof fetch }, resolveCredential: c.resolver };
  const bad: unknown[] = [Object.defineProperty({ ...safe }, "resolveCredential", { enumerable: true, get() { getter = true; return c.resolver; } }),
    { ...safe, authority: Object.defineProperty({ ...safe.authority }, "token", { enumerable: true, get() { getter = true; return "x"; } }) },
    { ...safe, [Symbol("extra")]: true }, { ...safe, session: () => {} }, Object.assign(Object.create({ approved: true }), safe),
    Object.defineProperty({ ...safe }, "authority", { value: safe.authority, enumerable: false }), { ...safe, timeoutMs: 0 }, { ...safe, timeoutMs: 60001 },
    { ...safe, ca: "🍐".repeat(16385) }, { ...safe, authority: { ...safe.authority, baseUrl: "http://attacker.invalid" } }];
  for (const invalid of bad) { const denied = await createProtectedMailSparseReadExecutor(invalid as ProtectedMailSparseReadExecutorOptions)(c.plan.manifest.readId); opaque(denied); assert.ok(denied.kind === "denied", "sparse_executor_invalid_configuration_claimed"); }
  const controller = new AbortController(); controller.abort();
  opaque(await createProtectedMailSparseReadExecutor(safe)(c.plan.manifest.readId, controller.signal));
  assert.ok(claims === 0 && !getter, "sparse_executor_config_getter_or_preabort_sent_claim");
});

test("late successful claim after abort stays unknown with zero resolver/TCP/report", async t => {
  const c = await setup(t); let release!: (response: Response) => void, resolutions = 0, reports = 0;
  const fetchImpl: typeof fetch = async input => {
    if (new URL(String(input)).pathname.endsWith("/begin_protected_mail_sparse_read_dispatch")) return new Promise(resolve => { release = resolve; });
    reports++; return new Response(null, { status: 200 });
  };
  const execute = createProtectedMailSparseReadExecutor({ authority: { ...c.host.options, fetchImpl }, resolveCredential: async binding => { resolutions++; return { binding, password }; }, ca: c.fixture.ca, lookup: c.fixture.lookup });
  const controller = new AbortController(), pending = execute(c.plan.manifest.readId, controller.signal);
  await until(() => Boolean(release)); controller.abort(); const result = await pending;
  release(Response.json([0, [c.plan.manifest.readId, c.plan.planDigest, c.plan.planBytes, c.plan.canonical]]));
  await new Promise(resolve => setTimeout(resolve, 20)); opaque(result);
  assert.ok(result.kind === "unknown" && resolutions === 0 && c.fixture.stats.tcpConnections === 0 && reports === 0, "sparse_executor_late_claim_started_work");
});

test("postclaim absolute deadline/expiry/inactive guards run before attachment even before timer delivery", async t => {
  const c = await setup(t);
  for (const mode of ["deadline", "expired", "inactive"] as const) {
    const host = authority(c.plan), original = Date.now; let now = original(), resolutions = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await host.options.fetchImpl(input, init);
      if (new URL(String(input)).pathname.endsWith("/begin_protected_mail_sparse_read_dispatch")) now += mode === "expired" ? 120000 : mode === "inactive" ? -120000 : 1000;
      return response;
    };
    const execute = createProtectedMailSparseReadExecutor({ authority: { ...host.options, fetchImpl }, timeoutMs: 100,
      resolveCredential: async binding => { resolutions++; return { binding, password }; }, ca: c.fixture.ca, lookup: c.fixture.lookup });
    Date.now = () => now;
    try {
      const result = await execute(c.plan.manifest.readId); opaque(result);
      assert.ok(result.kind === "unknown" && resolutions === 0 && host.stats.reports === 0 && c.fixture.stats.tcpConnections === 0, "sparse_executor_late_claim_attached_or_reported");
    } finally { Date.now = original; }
  }
});

test("queued resolver guard catches deadline advancement after attachment with one Failed report", async t => {
  const c = await setup(t), host = authority(c.plan), original = Date.now; let now = original(), reads = 0, resolutions = 0;
  const execute = createProtectedMailSparseReadExecutor({ authority: host.options, timeoutMs: 100,
    resolveCredential: async binding => { resolutions++; return { binding, password }; }, ca: c.fixture.ca, lookup: c.fixture.lookup });
  Date.now = () => { if (++reads === 3) queueMicrotask(() => { now += 1000; }); return now; };
  try {
    const result = await execute(c.plan.manifest.readId); opaque(result);
    assert.ok(result.kind === "stopped" && result.reason === "deadline_exceeded" && resolutions === 0 && c.fixture.stats.tcpConnections === 0
      && host.stats.reports === 1 && host.stats.outcomes[0] === 1, "sparse_executor_queued_resolver_after_deadline");
  } finally { Date.now = original; }
});

test("late resolver after abort and hung resolver at grant expiry never dial or repeat report", async t => {
  const c = await setup(t);
  for (const mode of ["abort", "expiry"] as const) {
    const plan = mode === "expiry" ? await prepared(c.fixture.port, Date.now() + 250) : c.plan, host = authority(plan);
    let release!: (value: ProtectedMailSparseReadCredential) => void, binding!: ProtectedMailSparseReadBinding, aborted = false;
    const execute = createProtectedMailSparseReadExecutor({ authority: host.options, timeoutMs: 2000, ca: c.fixture.ca, lookup: c.fixture.lookup,
      resolveCredential: (value, signal) => { binding = value; signal.addEventListener("abort", () => { aborted = true; }, { once: true }); return new Promise(resolve => { release = resolve; }); } });
    const controller = new AbortController(), pending = execute(plan.manifest.readId, controller.signal); await until(() => Boolean(release)); if (mode === "abort") controller.abort();
    const result = await pending; release({ binding, password }); await new Promise(resolve => setTimeout(resolve, 20)); opaque(result);
    assert.ok(result.kind === "stopped" && result.reason === (mode === "expiry" ? "read_expired" : "aborted") && aborted && c.fixture.stats.tcpConnections === 0
      && host.stats.reports === 1 && host.stats.outcomes[0] === 1, "sparse_executor_late_resolver_dialed_or_changed_report");
  }
});

test("resolver completion after absolute deadline is rejected before inspecting credentials or dialing", async t => {
  const c = await setup(t), original = Date.now; let now = original();
  const execute = createProtectedMailSparseReadExecutor({ authority: c.host.options, timeoutMs: 100, ca: c.fixture.ca, lookup: c.fixture.lookup,
    resolveCredential: async binding => { now += 1000; return { binding, password }; } });
  Date.now = () => now;
  try { const result = await execute(c.plan.manifest.readId); opaque(result); assert.ok(result.kind === "stopped" && result.reason === "deadline_exceeded" && c.fixture.stats.tcpConnections === 0
    && c.host.stats.reports === 1 && c.host.stats.outcomes[0] === 1, "sparse_executor_used_expired_resolver_result"); }
  finally { Date.now = original; }
});

test("hung claim and connected greeting obey host deadline without retries or partial results", async t => {
  const c = await setup(t, { greeting: null }), host = authority(c.plan, "hung"); let resolutions = 0;
  const execute = createProtectedMailSparseReadExecutor({ authority: host.options, timeoutMs: 100,
    resolveCredential: async binding => { resolutions++; return { binding, password }; }, ca: c.fixture.ca, lookup: c.fixture.lookup });
  const unknown = await execute(c.plan.manifest.readId); opaque(unknown);
  assert.ok(unknown.kind === "unknown" && resolutions === 0 && c.fixture.stats.tcpConnections === 0 && host.stats.reports === 0, "sparse_executor_hung_claim_started_work");
  const greeting = createProtectedMailSparseReadExecutor({ authority: c.host.options, resolveCredential: c.resolver, timeoutMs: 150, ca: c.fixture.ca, lookup: c.fixture.lookup });
  const stopped = await greeting(c.plan.manifest.readId); opaque(stopped); await until(() => c.fixture.stats.closedConnections === 1);
  assert.ok(stopped.kind === "stopped" && stopped.reason === "deadline_exceeded" && c.fixture.stats.authentications === 0 && c.host.stats.reports === 1 && c.host.stats.outcomes[0] === 2, "sparse_executor_hung_session_not_unknown");
});

test("missing final UID fails entire batch and lost success report exposes no body-derived metadata", async t => {
  const missing = await setup(t, { messages: new Map([[2, body], [5, body]]) }), failed = await missing.execute(missing.plan.manifest.readId); opaque(failed);
  assert.ok(failed.kind === "stopped" && failed.reason === "missing_uid" && missing.fixture.stats.fetches.map(item => item.uid).join(",") === "2,5,8"
    && missing.host.stats.outcomes[0] === 1 && missing.host.stats.reports === 1, "sparse_executor_partial_batch_reported_success");
  const c = await setup(t), host = authority(c.plan, "ok", true), execute = createProtectedMailSparseReadExecutor({ authority: host.options, resolveCredential: c.resolver, ca: c.fixture.ca, lookup: c.fixture.lookup });
  const result = await execute(c.plan.manifest.readId); opaque(result);
  assert.ok(result.kind === "completed" && result.report.kind === "unknown" && result.report.outcome === "ReadReported" && result.report.eventNonce === host.stats.nonces[0]
    && host.stats.reports === 1 && host.stats.outcomes[0] === 0, "sparse_executor_lost_report_changed_choice");
  opaque(await execute(c.plan.manifest.readId)); assert.ok(c.fixture.stats.tcpConnections === 1 && host.stats.reports === 1, "sparse_executor_lost_report_reread");
});

test("abort in a literal and TLS failure choose Unknown once without raw/partial output", async t => {
  const c = await setup(t, { fetchReply: request => ({ bytes: executorFetchReply(request, body.subarray(0, 3), { declaredLength: body.length, size: body.length, suffix: "" }) }) });
  const controller = new AbortController(), pending = c.execute(c.plan.manifest.readId, controller.signal); await until(() => c.fixture.stats.fetches.length === 1); controller.abort();
  const result = await pending; opaque(result); await until(() => c.fixture.stats.closedConnections === 1);
  assert.ok(result.kind === "stopped" && result.reason === "aborted" && c.host.stats.reports === 1 && c.host.stats.outcomes[0] === 2 && c.fixture.stats.tcpConnections === 1, "sparse_executor_aborted_literal_retry_or_wrong_report");
  const tls = await setup(t), execute = createProtectedMailSparseReadExecutor({ authority: tls.host.options, resolveCredential: tls.resolver, lookup: tls.fixture.lookup });
  const tlsResult = await execute(tls.plan.manifest.readId); opaque(tlsResult);
  assert.ok(tlsResult.kind === "stopped" && tlsResult.reason === "tls_failure" && tls.host.stats.outcomes[0] === 2 && tls.fixture.stats.authentications === 0, "sparse_executor_tls_failure_exposed_credentials");
});

test("resolver and server diagnostic material never enters public results or logs", async t => {
  const c = await setup(t, { fetchReply: request => ({ bytes: Buffer.from(`${request.tag} NO ${marker}server_error\r\n`) }) });
  const captured: string[] = [], original = [console.log, console.warn, console.error]; console.log = console.warn = console.error = (...values: unknown[]) => { captured.push(values.map(value => String(value)).join(" ")); };
  try {
    opaque(await c.execute(c.plan.manifest.readId));
    for (const failure of [Error(`${marker}resolver_error`), new Proxy({}, { getPrototypeOf() { throw Error(`${marker}hostile_error`); } })]) {
      const host = authority(c.plan), execute = createProtectedMailSparseReadExecutor({ authority: host.options, resolveCredential: async () => { throw failure; } });
      const result = await execute(c.plan.manifest.readId); opaque(result);
      assert.ok(result.kind === "stopped" && result.reason === "credential_unavailable" && host.stats.reports === 1 && host.stats.outcomes[0] === 1, "sparse_executor_raw_resolver_error");
    }
  } finally { [console.log, console.warn, console.error] = original; }
  assert.ok(captured.every(value => !value.includes(marker)), "sparse_executor_logged_private_material");
});

test("public fixed IMAP error cannot carry a caller-chosen diagnostic reason", () => {
  const error = new ProtectedMailSparseReadImapError(`${marker}error` as never);
  assert.ok(Object.isFrozen(error) && error.reason === "protocol_failure" && error.message === "protocol_failure", "sparse_executor_error_not_fixed");
});
