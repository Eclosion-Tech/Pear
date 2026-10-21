import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prepareConnectorDiscovery, type ConnectorDiscoveryV1 } from "../../../packages/sentinel/src/index.js";
import { createProtectedMailDiscoveryExecutor } from "./protected-mail-discovery-executor.js";
import type { ProtectedMailDiscoveryBinding, ProtectedMailDiscoveryCredential } from "./protected-mail-discovery-types.js";
import { createExecutorFixture, createExecutorFixtureCertificates, EXECUTOR_FIXTURE_HOST, EXECUTOR_FIXTURE_MARKER } from "../../scripts/protected-mail-executor-fixture.js";
import type { ExecutorFixtureCertificates, ExecutorFixtureOptions } from "../../scripts/protected-mail-executor-fixture.js";

const password = `${EXECUTOR_FIXTURE_MARKER}password`;
let certificates: ExecutorFixtureCertificates;
before(async () => { certificates = await createExecutorFixtureCertificates(); });
after(async () => { await certificates?.close(); });

async function prepared(port: number, expiresAtMs = Date.now() + 60_000) {
  const value: ConnectorDiscoveryV1 = {
    formatVersion: 1, kind: "mail.connector.discovery", profile: "imap.uid-discovery.v1",
    discoveryId: "a".repeat(64), eventNonce: "b".repeat(64), workspaceId: "c".repeat(64), ownerId: "d".repeat(64),
    connection: { id: "1", epoch: "1", snapshotDigest: "e".repeat(64) },
    connector: { identity: "f".repeat(64), runtimeId: "fixture", runId: "fixture" },
    mailbox: { host: EXECUTOR_FIXTURE_HOST, port, username: "fixture@example.test", folder: "INBOX", direction: "received" },
    cursor: { id: `mail-connector-cursor:${"1".repeat(64)}`, generation: "1", digest: "2".repeat(64), uidValidity: "7", lastUid: 6 },
    head: null, window: { mode: "next_window", maxSlots: 3, fromUid: 7, maxThroughUid: 9 },
    notBeforeMs: Date.now() - 1000, expiresAtMs,
    reservation: { operations: 1, numericSlots: 3, controlBytes: 65536 },
  };
  const result = await prepareConnectorDiscovery(value);
  assert.ok(result.status === "prepared", "discovery_executor_fixture_plan_invalid"); return result.discovery;
}
function authority(plan: Awaited<ReturnType<typeof prepared>>, mode: "ok" | "denied" | "unknown" | "lost" | "bad_id" | "hung" = "ok",
  completeMode: "ok" | "lost" | "denied" = "ok") {
  const stats = { claims: 0, completes: 0, finishes: 0, consumed: false, outcomes: [] as number[], nonces: [] as string[], declarations: [] as unknown[] };
  const fetchImpl: typeof fetch = async (input, init) => {
    const target = new URL(String(input));
    assert.equal(init?.redirect, "error", "discovery_executor_authority_redirect");
    if (target.pathname.endsWith("/begin_protected_mail_discovery_dispatch")) {
      stats.claims++;
      if (mode === "hung") return await new Promise<Response>(() => {});
      if (mode === "unknown") throw Error(`${EXECUTOR_FIXTURE_MARKER}authority_error`);
      if (mode === "denied") return Response.json([1, "protected_mail_discovery_service_required"]);
      if (stats.consumed) return Response.json([1, "protected_mail_discovery_consumed"]);
      stats.consumed = true;
      const payload = [mode === "bad_id" ? "0".repeat(64) : plan.manifest.discoveryId, plan.manifestDigest, plan.manifestBytes, plan.canonical];
      return mode === "lost" ? new Response("[0,[", { headers: { "Content-Type": "application/json" } }) : Response.json([0, payload]);
    }
    const args: unknown = JSON.parse(String(init?.body));
    assert.ok(Array.isArray(args) && args.length === 3 && args[0] === plan.manifest.discoveryId, "discovery_executor_report_id");
    if (target.pathname.endsWith("/complete_protected_mail_discovery")) {
      stats.completes++; stats.nonces.push(String(args[1])); stats.declarations.push(args[2]);
      if (completeMode === "lost") throw Error(`${EXECUTOR_FIXTURE_MARKER}report_error`);
      if (completeMode === "denied") return Response.json([1, "protected_mail_discovery_stale"]);
      return Response.json([0, [plan.manifest.discoveryId, "3".repeat(64), `mail-discovery-head:${"4".repeat(64)}`, 1]]);
    }
    assert.ok(target.pathname.endsWith("/finish_protected_mail_discovery_dispatch"), "discovery_executor_unexpected_route");
    assert.ok(Array.isArray(args[1]) && args[1].length === 2, "discovery_executor_finish_shape");
    stats.finishes++; stats.outcomes.push(args[1][0]); stats.nonces.push(String(args[2]));
    return new Response(null, { status: 200 });
  };
  return { stats, options: { baseUrl: "http://127.0.0.1:1", dbName: "discovery-fixture", token: "synthetic-token", fetchImpl } };
}
async function setup(t: { after(fn: () => Promise<void>): void }, options: ExecutorFixtureOptions = {}) {
  const fixture = await createExecutorFixture({ certificates, mode: "discovery", uidNext: 10, presentUids: [7, 9], ...options });
  t.after(() => fixture.close()); const plan = await prepared(fixture.port), host = authority(plan); let resolutions = 0;
  const resolver = async (binding: ProtectedMailDiscoveryBinding): Promise<ProtectedMailDiscoveryCredential> => {
    resolutions++; assert.ok(Object.isFrozen(binding), "discovery_executor_binding_not_frozen");
    assert.equal(binding.canonical, plan.canonical, "discovery_executor_full_binding_changed"); return { binding, password };
  };
  const executor = createProtectedMailDiscoveryExecutor({ authority: host.options, resolveCredential: resolver, ca: fixture.ca, lookup: fixture.lookup, timeoutMs: 3000 });
  return { fixture, plan, host, executor, resolver, resolutions: () => resolutions };
}
function noLocalObservation(result: unknown): void {
  const value = JSON.stringify(result);
  assert.ok(!value.includes(EXECUTOR_FIXTURE_MARKER) && !value.includes("fixture@example.test")
    && !value.includes(Buffer.from(`\0fixture@example.test\0${password}`).toString("base64")), "discovery_executor_material_exposed");
  for (const key of ["uidValidity", "uidNext", "presentUids", "absentUids", "fromUid", "throughUid", "canonical"])
    assert.ok(!value.includes(`"${key}"`), "discovery_executor_local_observation_exposed");
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < deadline, "discovery_executor_fixture_wait_expired"); await new Promise(resolve => setTimeout(resolve, 1)); }
}

test("fresh claim and exact credential binding yield one metadata search and authoritative receipt only", async t => {
  const c = await setup(t, { split: true }), result = await c.executor(c.plan.manifest.discoveryId);
  assert.ok(result.kind === "completed" && result.receipt.headGeneration === "1", "discovery_executor_expected_completion");
  assert.equal(c.fixture.stats.commands.join(","), "CAPABILITY,AUTHENTICATE_PLAIN,EXAMINE,UID_SEARCH", "discovery_executor_unapproved_commands");
  assert.ok(c.fixture.stats.authenticationMatched && c.fixture.stats.mailboxMatched && !c.fixture.stats.forbidden, "discovery_executor_transcript_changed");
  assert.ok(c.resolutions() === 1 && c.host.stats.claims === 1 && c.host.stats.completes === 1 && c.host.stats.finishes === 0, "discovery_executor_lifecycle_count");
  noLocalObservation(result);
  const again = await c.executor(c.plan.manifest.discoveryId);
  assert.ok(again.kind === "denied" && c.fixture.stats.tcpConnections === 1 && c.resolutions() === 1, "discovery_executor_repeated_consumed_grant");
});

for (const mode of ["denied", "unknown", "lost", "bad_id"] as const) test(`claim ${mode} causes zero credential and socket access`, async t => {
  const c = await setup(t), host = authority(c.plan, mode); let resolutions = 0;
  const execute = createProtectedMailDiscoveryExecutor({ authority: host.options, resolveCredential: async binding => { resolutions++; return { binding, password }; }, ca: c.fixture.ca, lookup: c.fixture.lookup });
  const result = await execute(c.plan.manifest.discoveryId);
  assert.ok(result.kind === (mode === "denied" ? "denied" : "unknown") && resolutions === 0 && c.fixture.stats.tcpConnections === 0
    && host.stats.completes === 0 && host.stats.finishes === 0, "discovery_executor_dial_without_claim"); noLocalObservation(result);
});

test("concurrent executions consume one authority winner and one TLS session", async t => {
  const c = await setup(t), results = await Promise.all(Array.from({ length: 8 }, () => c.executor(c.plan.manifest.discoveryId)));
  assert.ok(results.filter(r => r.kind === "completed").length === 1 && results.filter(r => r.kind === "denied").length === 7
    && c.fixture.stats.tcpConnections === 1 && c.resolutions() === 1 && c.host.stats.completes === 1, "discovery_executor_concurrent_replay");
  results.forEach(noLocalObservation);
});

for (const mode of ["lost", "denied"] as const) test(`completion ${mode} reveals no local observation and never sends an alternate outcome`, async t => {
  const c = await setup(t), host = authority(c.plan, "ok", mode);
  const execute = createProtectedMailDiscoveryExecutor({ authority: host.options, resolveCredential: c.resolver, ca: c.fixture.ca, lookup: c.fixture.lookup });
  const result = await execute(c.plan.manifest.discoveryId);
  assert.ok(result.kind === "unconfirmed" && result.report.kind === (mode === "lost" ? "unknown" : "denied")
    && host.stats.completes === 1 && host.stats.finishes === 0 && c.fixture.stats.tcpConnections === 1, "discovery_executor_changed_lost_outcome");
  assert.ok(/^[a-f0-9]{64}$/.test(result.eventNonce) && host.stats.nonces[0] === result.eventNonce, "discovery_executor_report_nonce_changed");
  noLocalObservation(result); await execute(c.plan.manifest.discoveryId);
  assert.ok(host.stats.completes === 1 && host.stats.finishes === 0 && c.fixture.stats.tcpConnections === 1, "discovery_executor_retry_after_report_loss");
});

test("every bound field and closed credential descriptors fail before dial without invoking getters", async t => {
  const c = await setup(t); let getter = false;
  for (const key of ["canonical", "manifestDigest", "discoveryId", "workspaceId", "ownerId", "connectionId", "connectionEpoch", "snapshotDigest", "host", "port", "username", "folder", "direction", "notBeforeMs", "expiresAtMs", "extra", "getter", "control", "surrogate"]) {
    const host = authority(c.plan);
    const execute = createProtectedMailDiscoveryExecutor({ authority: host.options, resolveCredential: async binding => {
      if (key === "getter") {
        const result = { binding } as ProtectedMailDiscoveryCredential;
        Object.defineProperty(result, "password", { enumerable: true, get() { getter = true; throw Error("getter_invoked"); } }); return result;
      }
      if (key === "control" || key === "surrogate") return { binding, password: key === "control" ? "x\0y" : "\ud800" };
      return { binding: { ...binding, [key]: "changed" }, password } as ProtectedMailDiscoveryCredential;
    }, ca: c.fixture.ca, lookup: c.fixture.lookup });
    const result = await execute(c.plan.manifest.discoveryId);
    assert.ok(result.kind === "stopped" && result.reason === "credential_binding_mismatch" && !getter
      && c.fixture.stats.tcpConnections === 0 && host.stats.finishes === 1 && host.stats.completes === 0, "discovery_executor_unbound_credential"); noLocalObservation(result);
  }
});

test("late resolver result after abort cannot dial or repeat its chosen report", async t => {
  const c = await setup(t); let release!: (value: ProtectedMailDiscoveryCredential) => void, captured!: ProtectedMailDiscoveryBinding;
  const execute = createProtectedMailDiscoveryExecutor({ authority: c.host.options, resolveCredential: binding => { captured = binding; return new Promise(resolve => { release = resolve; }); }, ca: c.fixture.ca, lookup: c.fixture.lookup });
  const controller = new AbortController(), pending = execute(c.plan.manifest.discoveryId, controller.signal);
  await until(() => Boolean(release)); controller.abort(); const result = await pending;
  release({ binding: captured, password }); await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(result.kind === "stopped" && c.fixture.stats.tcpConnections === 0 && c.host.stats.finishes === 1 && c.host.stats.completes === 0, "discovery_executor_late_resolver_dialed"); noLocalObservation(result);
});

test("late successful claim after abort cannot resolve credentials, dial or report", async t => {
  const c = await setup(t); let release!: (response: Response) => void, resolutions = 0, reports = 0;
  const fetchImpl: typeof fetch = async input => {
    if (new URL(String(input)).pathname.endsWith("/begin_protected_mail_discovery_dispatch")) return await new Promise<Response>(resolve => { release = resolve; });
    reports++; return new Response(null, { status: 200 });
  };
  const execute = createProtectedMailDiscoveryExecutor({ authority: { ...c.host.options, fetchImpl }, resolveCredential: async binding => { resolutions++; return { binding, password }; }, ca: c.fixture.ca, lookup: c.fixture.lookup });
  const controller = new AbortController(), pending = execute(c.plan.manifest.discoveryId, controller.signal);
  await until(() => Boolean(release)); controller.abort(); const result = await pending;
  release(Response.json([0, [c.plan.manifest.discoveryId, c.plan.manifestDigest, c.plan.manifestBytes, c.plan.canonical]]));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(result.kind === "unknown" && resolutions === 0 && c.fixture.stats.tcpConnections === 0 && reports === 0, "discovery_executor_late_claim_dialed"); noLocalObservation(result);
});

test("absolute deadline rejects a late claim before credentials even before its timer callback runs", async t => {
  const c = await setup(t), original = Date.now; let now = original(), resolutions = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await c.host.options.fetchImpl(input, init);
    if (new URL(String(input)).pathname.endsWith("/begin_protected_mail_discovery_dispatch")) now += 1000;
    return response;
  };
  const execute = createProtectedMailDiscoveryExecutor({ authority: { ...c.host.options, fetchImpl }, timeoutMs: 100,
    resolveCredential: async binding => { resolutions++; return { binding, password }; }, ca: c.fixture.ca, lookup: c.fixture.lookup });
  Date.now = () => now;
  try {
    const result = await execute(c.plan.manifest.discoveryId);
    assert.ok(result.kind === "stopped" && result.reason === "deadline_exceeded" && resolutions === 0 && c.fixture.stats.tcpConnections === 0
      && c.host.stats.finishes === 1 && c.host.stats.completes === 0, "discovery_executor_late_clock_credential_lookup"); noLocalObservation(result);
  } finally { Date.now = original; }
});

test("grant expiry bounds a hung resolver and late success cannot dial", async t => {
  const c = await setup(t), plan = await prepared(c.fixture.port, Date.now() + 300), host = authority(plan);
  let release!: (value: ProtectedMailDiscoveryCredential) => void, captured!: ProtectedMailDiscoveryBinding, aborted = false;
  const execute = createProtectedMailDiscoveryExecutor({ authority: host.options, timeoutMs: 2000, ca: c.fixture.ca, lookup: c.fixture.lookup,
    resolveCredential: (binding, signal) => { captured = binding; signal.addEventListener("abort", () => { aborted = true; }, { once: true }); return new Promise(resolve => { release = resolve; }); } });
  const started = Date.now(), result = await execute(plan.manifest.discoveryId);
  assert.ok(result.kind === "stopped" && result.reason === "discovery_expired" && Date.now() - started < 1200 && aborted
    && c.fixture.stats.tcpConnections === 0 && host.stats.finishes === 1, "discovery_executor_outlived_grant");
  assert.ok(Boolean(release), "discovery_executor_expiry_resolver_not_started"); release({ binding: captured, password });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(c.fixture.stats.tcpConnections, 0); noLocalObservation(result);
});

test("hung claim and greeting stop at the host deadline with one attempt", async t => {
  const c = await setup(t, { greeting: null }), host = authority(c.plan, "hung"); let resolutions = 0;
  const execute = createProtectedMailDiscoveryExecutor({ authority: host.options, timeoutMs: 100, resolveCredential: async binding => { resolutions++; return { binding, password }; }, ca: c.fixture.ca, lookup: c.fixture.lookup });
  const result = await execute(c.plan.manifest.discoveryId);
  assert.ok(result.kind === "unknown" && resolutions === 0 && c.fixture.stats.tcpConnections === 0, "discovery_executor_hung_claim_dialed");
  const greeting = createProtectedMailDiscoveryExecutor({ authority: c.host.options, resolveCredential: c.resolver, ca: c.fixture.ca, lookup: c.fixture.lookup, timeoutMs: 250 });
  const stopped = await greeting(c.plan.manifest.discoveryId); await until(() => c.fixture.stats.closedConnections === 1);
  assert.ok(stopped.kind === "stopped" && stopped.reason === "deadline_exceeded" && c.fixture.stats.authentications === 0
    && c.host.stats.finishes === 1 && c.host.stats.outcomes[0] === 1, "discovery_executor_hung_greeting_not_bounded"); noLocalObservation(stopped);
});

test("abort after SEARCH reports Unknown once and reveals no partial observation", async t => {
  const c = await setup(t, { searchReply: () => ({ bytes: Buffer.from("* SEARCH 7\r\n") }) });
  const controller = new AbortController(), pending = c.executor(c.plan.manifest.discoveryId, controller.signal);
  await until(() => c.fixture.stats.searches.length === 1); controller.abort(); const result = await pending;
  await until(() => c.fixture.stats.closedConnections === 1);
  assert.ok(result.kind === "stopped" && result.reason === "aborted" && c.host.stats.finishes === 1
    && c.host.stats.outcomes[0] === 1 && c.host.stats.completes === 0 && c.fixture.stats.tcpConnections === 1, "discovery_executor_abort_partial_observation");
  noLocalObservation(result);
});

test("resolver and server error material cannot enter results or diagnostics", async t => {
  const c = await setup(t, { searchReply: request => ({ bytes: Buffer.from(`${request.tag} NO ${EXECUTOR_FIXTURE_MARKER}server_error\r\n`) }) });
  const captured: string[] = [], original = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...values: unknown[]) => { captured.push(values.map(value => String(value)).join(" ")); };
  try {
    const result = await c.executor(c.plan.manifest.discoveryId);
    assert.ok(result.kind === "stopped" && c.host.stats.completes === 0 && c.host.stats.finishes === 1, "discovery_executor_server_error_accepted"); noLocalObservation(result);
    const host = authority(c.plan), execute = createProtectedMailDiscoveryExecutor({ authority: host.options, resolveCredential: async () => { throw Error(`${EXECUTOR_FIXTURE_MARKER}resolver_error`); } });
    const stopped = await execute(c.plan.manifest.discoveryId);
    assert.ok(stopped.kind === "stopped" && stopped.reason === "credential_unavailable" && host.stats.finishes === 1, "discovery_executor_resolver_error_exposed"); noLocalObservation(stopped);
  } finally { [console.log, console.warn, console.error] = original; }
  assert.ok(captured.every(value => !value.includes(EXECUTOR_FIXTURE_MARKER)), "discovery_executor_logged_private_material");
});

test("invalid configuration and pre-aborted calls cannot reach authority", async () => {
  let claims = 0;
  const options = { authority: { baseUrl: "http://127.0.0.1:1", dbName: "discovery-fixture", token: "synthetic-token", fetchImpl: (async () => { claims++; throw Error("unexpected_fetch"); }) as typeof fetch }, resolveCredential: async () => undefined };
  for (const extra of [{ timeoutMs: 0 }, { timeoutMs: 60001 }, { ca: "🍐".repeat(20000) }])
    assert.equal((await createProtectedMailDiscoveryExecutor({ ...options, ...extra })("a".repeat(64))).kind, "denied");
  const controller = new AbortController(); controller.abort();
  assert.equal((await createProtectedMailDiscoveryExecutor(options)("a".repeat(64), controller.signal)).kind, "denied");
  assert.equal(claims, 0, "discovery_executor_invalid_configuration_claimed");
});
