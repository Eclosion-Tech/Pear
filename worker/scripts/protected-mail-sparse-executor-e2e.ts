/** Real c7 sparse authority + synthetic TLS conformance. No real mailbox/provider,
 * credential vault, production workspace, source insertion or cursor ACK runs
 * during execution. Caller owns the disposable authority server and cleanup. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setGlobalLogLevel } from "spacetimedb";
import { DbConnection } from "../src/module_bindings/index.js";
import { HttpStdbTransport } from "../../web/src/lib/api-endpoint/http-transport.js";
import { createProtectedMailSparseReadExecutor } from "../src/mail/protected-mail-sparse-read-executor.js";
import { prepareConnectorSparseRead } from "../../packages/sentinel/src/index.js";
import { beginProtectedMailDiscoveryDispatch } from "../src/mail/protected-mail-discovery-dispatch.js";
import { completeProtectedMailDiscovery } from "../src/mail/protected-mail-discovery-report.js";
import { finishProtectedMailSparseReadDispatch } from "../src/mail/protected-mail-sparse-read-report.js";
import { acknowledgeProtectedMailConnectorSelection } from "../src/mail/protected-connector-ack.js";
import { createExecutorFixture, executorFetchReply, EXECUTOR_FIXTURE_HOST, EXECUTOR_FIXTURE_MARKER } from "./protected-mail-executor-fixture.js";
import { drainFixtureConnections, retainFixtureDatabaseUntilServerCleanup } from "./protected-mail-fixture-lifecycle.js";

type Row = Record<string, unknown>;
type Identity = { identity: string; token: string };
const ident = (value: string) => [`0x${value.replace(/^0x/, "")}`], none = { none: [] };
const event = (value: string) => createHash("sha256").update(`sparse-executor-e2e-${value}`).digest("hex");
const retainedTables = [
  "protected_mail_collection", "protected_mail_source", "protected_mail_record", "protected_mail_receipt",
  "protected_mail_source_policy_head", "protected_mail_source_policy_history", "protected_mail_context", "protected_mail_exposure", "protected_mail_derivation",
  "protected_mail_instruction_head", "protected_mail_instruction_revision", "protected_mail_instruction_decision",
  "protected_mail_connection_authority_head", "protected_mail_connection_authority_history",
  "protected_mail_processor_head", "protected_mail_processor_revision", "protected_mail_processor_event",
  "protected_mail_summary_grant", "protected_mail_summary_grant_event", "protected_mail_summary_run", "protected_mail_summary_budget", "protected_mail_summary_admission_receipt", "protected_mail_committed_summary",
] as const;
const effects = ["page", "page_content", "component_node", "page_access_rule", "mail_import_receipt", "mail_sync_cursor", "orcha_job", "orcha_task", "conversation", "conversation_message", "bridge_command", "automation_event_queue"] as const;
// Frozen alongside the Rust module's closed inference table contract.
const inferenceTables = ["protected_mail_inference_grant", "protected_mail_inference_grant_event", "protected_mail_inference_run", "protected_mail_inference_budget", "protected_mail_inference_admission", "protected_mail_inference_state", "protected_mail_inference_event"] as const;
const resultTables = ["protected_mail_result_authorization", "protected_mail_result_authorization_event", "protected_mail_result_receipt"] as const;
const resultRetainedTables = [...retainedTables, ...inferenceTables, ...resultTables];
const connectorTables = ["protected_mail_connector_selection", "protected_mail_connector_selection_event", "protected_mail_connector_cursor", "protected_mail_connector_cursor_history", "protected_mail_connector_ack_receipt"] as const;
const oldTables = [...resultRetainedTables, ...connectorTables];
const readTables = ["protected_mail_read_grant", "protected_mail_read_grant_event", "protected_mail_read_state", "protected_mail_read_event"] as const;
const old42Tables = [...oldTables, ...readTables];
const ingestionTables = ["protected_mail_ingestion_authorization", "protected_mail_ingestion_authorization_event", "protected_mail_ingestion_disposition", "protected_mail_ingestion_receipt", "protected_mail_ingestion_cursor_history"] as const;
const old47Tables = [...old42Tables, ...ingestionTables];
const discoveryTables = ["protected_mail_discovery_grant", "protected_mail_discovery_grant_event", "protected_mail_discovery_state", "protected_mail_discovery_event", "protected_mail_discovery_observation", "protected_mail_discovery_head"] as const;
const old53Tables = [...old47Tables, ...discoveryTables];
const sparseTables = ["protected_mail_sparse_checkpoint_grant", "protected_mail_sparse_checkpoint_grant_event", "protected_mail_sparse_checkpoint_receipt", "protected_mail_sparse_checkpoint_cursor_history"] as const;
const old57Tables = [...old53Tables, ...sparseTables];
const sparseReadTables = ["protected_mail_sparse_read_grant", "protected_mail_sparse_read_grant_event", "protected_mail_sparse_read_state", "protected_mail_sparse_read_event"] as const;
const privateTables = [...old57Tables, ...sparseReadTables];
const sorted = (rows: Row[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function readStatus(value: unknown): string {
  const names = ["Pending", "Dispatching", "ReadReported", "Failed", "Unknown", "CancelledBeforeDispatch"];
  if (Array.isArray(value) && value.length === 2 && Number.isInteger(value[0]) && names[Number(value[0])]) return names[Number(value[0])];
  const tag = typeof value === "string" ? value : value && typeof value === "object" && !Array.isArray(value)
    ? typeof (value as Row).tag === "string" ? String((value as Row).tag) : Object.keys(value)[0] : undefined;
  const found = names.find(name => name.toLowerCase() === tag?.replace(/_/g, "").toLowerCase()); assert.ok(found, "executor_read_status_shape"); return found;
}
let stage = "localhost_guard";
async function main(): Promise<void> {
  const raw = process.argv[2] ?? "http://127.0.0.1:3099", url = new URL(raw);
  assert.ok(process.argv.length <= 3 && raw === raw.trim() && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && !raw.includes("?") && !raw.includes("#") && url.pathname === "/", "sparse_executor_local_origin_required");
  const base = url.origin, retain = retainFixtureDatabaseUntilServerCleanup(), name = `pear-protected-sparse-executor-e2e-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const databaseUrl = `${base}/v1/database/${name}`, sockets: DbConnection[] = [];
  setGlobalLogLevel("error");
  const fixedLog = console.log.bind(console);
  console.log = (...args: unknown[]) => { if (typeof args[0] === "string" && args[0].startsWith("%c")) { fixedLog("WARN protected_mail_sparse_executor_sdk_diagnostic"); return; } fixedLog(...args); };
  const marker = `SPARSE_EXECUTOR_PRIVATE_SYNTHETIC_${randomBytes(12).toString("hex")}`, password = `${EXECUTOR_FIXTURE_MARKER}${marker}_password`;
  const messages = new Map([[2, Buffer.from(`${marker}_two\r\nC99 OK fake\r\n\0🍐`)], [5, Buffer.from(`${marker}_five\r\n* 9 FETCH (UID 99 BODY[] {3}\r\n`) ], [8, Buffer.from(`${marker}_eight`)], [3, Buffer.from(`${marker}_absent_must_not_fetch`)]]);
  let wire: "complete" | "missing_final" = "complete";
  const fixture = await createExecutorFixture({ split: true, password, messages,
    examineReply: tag => ({ bytes: Buffer.from(`* FLAGS (\\Seen)\r\n* 8 EXISTS\r\n* OK [UIDVALIDITY 7] stable\r\n* OK [UIDNEXT 10] newer\r\n${tag} OK [READ-ONLY] examined\r\n`), split: true }),
    fetchReply: request => {
      const body = messages.get(request.uid);
      return wire === "missing_final" && request.uid === 8 || !body
        ? { bytes: Buffer.from(`${request.tag} OK no matching message\r\n`), split: true }
        : { bytes: executorFetchReply(request, body), split: true };
    } });
  let publisherIdentity: Identity | undefined;
  const attempts = { claims: 0, reports: 0 };
  const localFetch: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.ok(target.origin === base && !target.username && !target.password && (target.pathname === "/v1/identity" || target.pathname === `/v1/database/${name}` || target.pathname.startsWith(`/v1/database/${name}/`)), "sparse_executor_disposable_path_required");
    if (target.pathname.endsWith("/begin_protected_mail_sparse_read_dispatch")) attempts.claims++;
    if (target.pathname.endsWith("/finish_protected_mail_sparse_read_dispatch")) attempts.reports++;
    return fetch(target, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(15000) });
  };
  const identity = async (): Promise<Identity> => {
    const response = await localFetch(`${base}/v1/identity`, { method: "POST" }); assert.ok(response.ok, "sparse_executor_identity_failed");
    const value = await response.json() as Identity;
    assert.ok(typeof value.identity === "string" && /^(0x)?[a-f0-9]{64}$/i.test(value.identity) && typeof value.token === "string" && value.token.length > 0 && value.token.length <= 8192, "sparse_executor_identity_invalid"); return value;
  };
  async function actor(value = identity()) {
    const account = await value;
    const live = await new Promise<DbConnection>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("sparse_executor_connection_timeout")), 12000);
      const connection = DbConnection.builder().withUri(base).withDatabaseName(name).withToken(account.token).onConnect(connected => { clearTimeout(timer); resolve(connected); })
        .onConnectError(() => { clearTimeout(timer); reject(Error("sparse_executor_connection_failed")); }).build(); sockets.push(connection);
    });
    return { ...account, live, transport: new HttpStdbTransport({ baseUrl: base, dbName: name, token: account.token, fetchImpl: localFetch, timeoutMs: 15000 }) };
  }
  const exactKeys = (value: unknown, keys: string[]) => {
    assert.ok(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) && Object.isFrozen(value), "sparse_executor_public_result_not_closed_frozen");
  };
  const privateResult = (result: unknown) => {
    assert.ok(result && typeof result === "object", "sparse_executor_result_shape");
    const row = result as Row, keys = row.kind === "completed" ? ["kind", "readId", "planDigest", "report"] : row.kind === "stopped" ? ["kind", "readId", "reason", "report"] : ["kind", "reason"];
    exactKeys(row, keys); if (row.report) exactKeys(row.report, ["kind", "eventNonce", "outcome"]);
    const encoded = JSON.stringify(result), authentication = Buffer.from(`\0fixture@example.test\0${password}`).toString("base64");
    assert.ok(!encoded.includes(marker) && !encoded.includes(EXECUTOR_FIXTURE_MARKER) && !encoded.includes(authentication)
      && !["messages", "bodyBytes", "uidValidity", "uidNext", "presentUids", "canonical"].some(key => Object.hasOwn(row, key)), "sparse_executor_exposed_local_mail_or_authentication");
  };
  try {
    stage = "publish_owned_sparse_executor_fixture"; publisherIdentity = await identity();
    const wasm = await readFile(process.env.PEAR_PROTECTED_MAIL_WASM ?? new URL("../../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm", import.meta.url));
    assert.ok(wasm.byteLength > 0, "sparse_executor_artifact_required");
    const publication = await localFetch(databaseUrl, { method: "PUT", headers: { Authorization: `Bearer ${publisherIdentity.token}` }, body: new Uint8Array(wasm), signal: AbortSignal.timeout(60000) }); assert.ok(publication.ok, "sparse_executor_publish_failed");
    const publisher = await actor(Promise.resolve(publisherIdentity)), owner = await actor(), service = await actor();
    await owner.transport.call("register", ["sparse-executor-owner@example.test", "Synthetic owner", "synthetic-local-password"]);
    const keyId = event("key"); await publisher.transport.call("publish_mail_encryption_key", ["{}", keyId]);
    const credential = JSON.stringify({ v: 1, keyId, key: "synthetic", nonce: "synthetic", ciphertext: "synthetic" });
    await owner.transport.call("create_mail_connection", ["Synthetic sparse mailbox", EXECUTOR_FIXTURE_HOST, fixture.port, "fixture@example.test", credential, "INBOX", none, none, 0]);
    const connection = (await owner.transport.sql<Row>("SELECT * FROM mail_connection"))[0]; assert.ok(connection, "sparse_executor_connection_missing"); const connectionId = Number(connection.id);
    await owner.transport.call("set_mail_connection_enabled", [connectionId, false]); await publisher.transport.call("create_protected_mail_collection", [connectionId]); await publisher.transport.call("initialize_protected_mail_connection_authority", [connectionId]);
    async function procedure(method: string, args: unknown[]): Promise<unknown[]> {
      const response = await localFetch(`${databaseUrl}/call/${method}`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
      assert.ok(response.ok && /^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "") && response.body, "sparse_executor_review_transport_failed");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; assert.ok(size <= 32768, "sparse_executor_review_response_limit"); chunks.push(next.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      assert.ok(Array.isArray(value) && value.length === 2 && value[0] === 0 && Array.isArray(value[1]), "sparse_executor_review_denied"); return value[1];
    }
    const options = (fetchImpl = localFetch) => ({ baseUrl: base, dbName: name, token: service.token, fetchImpl });
    stage = "owner_cursor_discovery_and_sparse_read_approval";
    const interval = () => [Date.now() - 1000, Date.now() + 600000];
    const bootstrapRequest = [connectionId, ident(service.identity), "sparse-executor", "bootstrap", [0, []], [0, ["7", 1]], ...interval(), event("bootstrap")], bootstrapPreview = await procedure("review_protected_mail_connector_selection", [bootstrapRequest]);
    assert.ok(bootstrapPreview.length === 6 && typeof bootstrapPreview[0] === "string", "sparse_executor_bootstrap_shape");
    await owner.transport.call("issue_protected_mail_connector_selection", [bootstrapRequest, bootstrapPreview[1], bootstrapPreview[2], bootstrapPreview[3]]);
    const bootstrap = await acknowledgeProtectedMailConnectorSelection(options(), bootstrapPreview[0], event("bootstrap-ack"), []); assert.equal(bootstrap.kind, "ok", "sparse_executor_bootstrap_failed");
    const approvedBindings = new Map<string, { digest: string; canonical: string }>();
    async function approvedRead(label: string) {
      const discoveryRequest = [connectionId, ident(service.identity), "sparse-executor", `run-${label}`, [0, []], [1, [1, 8]], ...interval(), event(`discovery-${label}`)], preview = await procedure("review_protected_mail_discovery", [discoveryRequest]);
      assert.ok(preview.length === 6 && typeof preview[0] === "string", "sparse_executor_discovery_preview_shape");
      await owner.transport.call("issue_protected_mail_discovery", [discoveryRequest, preview[1], preview[2], preview[3]]);
      const dispatch = await beginProtectedMailDiscoveryDispatch(options(), preview[0]); assert.equal(dispatch.kind, "ok", "sparse_executor_discovery_claim_failed");
      const complete = await completeProtectedMailDiscovery(options(), preview[0], event(`observation-${label}`), { uidValidity: "7", uidNext: 9, presentUids: [2, 5, 8] }); assert.equal(complete.kind, "ok", "sparse_executor_discovery_completion_failed");
      const readRequest = [preview[0], ...interval(), 1024, 2048, event(`read-${label}`)], readPreview = await procedure("review_protected_mail_sparse_read_grant", [readRequest]);
      assert.ok(readPreview.length === 6 && typeof readPreview[0] === "string" && typeof readPreview[5] === "string", "sparse_executor_read_preview_shape");
      const prepared = await prepareConnectorSparseRead(JSON.parse(readPreview[5])); assert.equal(prepared.status, "prepared", "sparse_executor_read_codec_rejected");
      assert.ok(prepared.read.planDigest === readPreview[3] && prepared.read.planBytes === Number(readPreview[4]) && prepared.read.manifest.observation.presentUids.join(",") === "2,5,8"
        && prepared.read.manifest.observation.uidNext === 9 && prepared.read.manifest.reservation.messageSlots === 3 && prepared.read.manifest.reservation.bodyBytes === 2048, "sparse_executor_approval_binding_changed");
      await owner.transport.call("issue_protected_mail_sparse_read_grant", [readRequest, readPreview[1], readPreview[2], readPreview[3]]);
      const approved = { id: String(readPreview[0]), digest: String(readPreview[3]), canonical: readPreview[5] };
      approvedBindings.set(approved.id, { digest: approved.digest, canonical: approved.canonical }); return approved;
    }
    const snapshot = async (names: readonly string[] = privateTables): Promise<Record<string, Row[]>> => Object.fromEntries(await Promise.all(names.map(async table => [table, sorted(await publisher.transport.sql<Row>(`SELECT * FROM ${table}`))])));
    const ownerViews = async () => ({ mail: sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), instructions: sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions")) });
    async function assertLifecycle(id: string, status: string, generation: number) {
      const rows = await snapshot(["protected_mail_sparse_read_state", "protected_mail_sparse_read_event"]), state = rows.protected_mail_sparse_read_state.find(row => row.read_id === id);
      assert.ok(state && readStatus(state.status) === status && Number(state.generation) === generation && Number(state.reserved_operations) === (generation === 1 ? 0 : 1)
        && Number(state.reserved_message_slots) === (generation === 1 ? 0 : 3) && Number(state.reserved_body_bytes) === (generation === 1 ? 0 : 2048), "sparse_executor_full_reservation_or_state_changed");
      const events = rows.protected_mail_sparse_read_event.filter(row => row.read_id === id).sort((a, b) => Number(a.generation) - Number(b.generation));
      assert.ok(events.length === generation && events.every((row, index) => Number(row.generation) === index + 1 && readStatus(row.status) === ["Pending", "Dispatching", status][index]
        && Number(row.reserved_operations) === (index === 0 ? 0 : 1) && Number(row.reserved_message_slots) === (index === 0 ? 0 : 3) && Number(row.reserved_body_bytes) === (index === 0 ? 0 : 2048))
        && events.at(-1)?.id === state.last_event_id, "sparse_executor_lifecycle_events_changed");
    }
    async function executionOnly(before: Record<string, Row[]>, ordinary: Record<string, Row[]>, views: Awaited<ReturnType<typeof ownerViews>>, id: string, eventDelta: number) {
      const after = await snapshot();
      for (const table of privateTables) if (table !== "protected_mail_sparse_read_state" && table !== "protected_mail_sparse_read_event") assert.deepEqual(after[table], before[table], "sparse_executor_changed_prior_private_storage_authority_or_pool");
      assert.equal(after.protected_mail_sparse_read_state.length, before.protected_mail_sparse_read_state.length, "sparse_executor_created_another_state");
      for (const row of before.protected_mail_sparse_read_state) if (row.read_id !== id) assert.deepEqual(after.protected_mail_sparse_read_state.find(actual => actual.read_id === row.read_id), row, "sparse_executor_changed_unselected_read_state");
      assert.equal(after.protected_mail_sparse_read_event.length, before.protected_mail_sparse_read_event.length + eventDelta, "sparse_executor_lifecycle_event_delta");
      for (const row of before.protected_mail_sparse_read_event) assert.ok(after.protected_mail_sparse_read_event.some(actual => JSON.stringify(actual) === JSON.stringify(row)), "sparse_executor_changed_immutable_event");
      for (const row of after.protected_mail_sparse_read_event) if (!before.protected_mail_sparse_read_event.some(old => old.id === row.id)) assert.equal(row.read_id, id, "sparse_executor_created_unselected_lifecycle_event");
      assert.deepEqual(await snapshot(effects), ordinary, "sparse_executor_created_ordinary_effect"); assert.deepEqual(await ownerViews(), views, "sparse_executor_changed_owner_mail_or_instruction_history");
    }
    let resolutions = 0;
    const resolver: Parameters<typeof createProtectedMailSparseReadExecutor>[0]["resolveCredential"] = async binding => {
      resolutions++; const expected = approvedBindings.get(binding.readId); assert.ok(expected, "sparse_executor_unreviewed_credential_request");
      const manifest = JSON.parse(expected.canonical);
      assert.ok(Object.isFrozen(binding) && binding.planDigest === expected.digest && binding.canonical === expected.canonical
        && binding.workspaceId === manifest.workspaceId && binding.ownerId === owner.identity.replace(/^0x/, "") && binding.connectionId === String(connectionId)
        && binding.connectionEpoch === manifest.connection.epoch && binding.snapshotDigest === manifest.connection.snapshotDigest
        && binding.host === EXECUTOR_FIXTURE_HOST && binding.port === fixture.port && binding.username === "fixture@example.test" && binding.folder === "INBOX"
        && binding.direction === "received" && binding.notBeforeMs === manifest.notBeforeMs && binding.expiresAtMs === manifest.expiresAtMs, "sparse_executor_credential_binding_changed"); return { binding, password };
    };
    const execute = createProtectedMailSparseReadExecutor({ authority: options(), ca: fixture.ca, lookup: fixture.lookup, resolveCredential: resolver });
    stage = "real_sparse_claim_tls_and_recorded_completion";
    const success = await approvedRead("complete"); await assertLifecycle(success.id, "Pending", 1);
    const before = await snapshot(), ordinary = await snapshot(effects), views = await ownerViews(), beforeAttempts = { ...attempts }, tcpBefore = fixture.stats.tcpConnections, fetchBefore = fixture.stats.fetches.length;
    const result = await execute(success.id); privateResult(result);
    assert.ok(result.kind === "completed" && result.readId === success.id && result.planDigest === success.digest && result.report.kind === "recorded" && result.report.outcome === "ReadReported", "sparse_executor_real_completion_failed");
    assert.ok(attempts.claims === beforeAttempts.claims + 1 && attempts.reports === beforeAttempts.reports + 1 && resolutions === 1 && fixture.stats.tcpConnections === tcpBefore + 1, "sparse_executor_real_attempt_count");
    const selectedFetches = fixture.stats.fetches.slice(fetchBefore);
    assert.ok(selectedFetches.map(fetch => fetch.uid).join(",") === "2,5,8" && selectedFetches.every(fetch => fetch.limit === 1024) && fixture.stats.searches.length === 0
      && fixture.stats.commands.join(",") === "CAPABILITY,AUTHENTICATE_PLAIN,EXAMINE,UID_FETCH_PEEK,UID_FETCH_PEEK,UID_FETCH_PEEK"
      && fixture.stats.authenticationMatched && fixture.stats.mailboxMatched && fixture.stats.tagsSequential && !fixture.stats.forbidden, "sparse_executor_wire_targets_or_profile_changed");
    await assertLifecycle(success.id, "ReadReported", 3); await executionOnly(before, ordinary, views, success.id, 2);
    const completedSnapshot = await snapshot(), completedAttempts = { ...attempts }, repeated = await execute(success.id); privateResult(repeated);
    assert.ok(repeated.kind === "denied" && repeated.reason === "protected_mail_sparse_read_consumed" && resolutions === 1 && fixture.stats.tcpConnections === tcpBefore + 1
      && attempts.claims === completedAttempts.claims + 1 && attempts.reports === completedAttempts.reports, "sparse_executor_consumed_retry_resolved_or_dialed");
    assert.deepEqual(await snapshot(), completedSnapshot, "sparse_executor_consumed_retry_mutated_state");
    console.log("PASS protected_mail_sparse_executor_real_claim_exact_sparse_tls_and_once_report");

    stage = "committed_lost_claim_never_resolves_dials_or_reports";
    const lost = await approvedRead("lost-claim"); await assertLifecycle(lost.id, "Pending", 1);
    const beforeLost = await snapshot(), lostOrdinary = await snapshot(effects), lostViews = await ownerViews(), lostAttempts = { ...attempts }, lostTcp = fixture.stats.tcpConnections, lostResolutions = resolutions;
    let truncated = 0;
    const lostFetch: typeof fetch = async (input, init) => {
      const response = await localFetch(input, init);
      if (new URL(String(input)).pathname.endsWith("/begin_protected_mail_sparse_read_dispatch")) {
        const raw = await response.text(); assert.ok(response.ok && raw.startsWith("[0,"), "sparse_executor_lost_claim_setup_failed"); truncated++;
        return new Response("[0,[", { headers: { "Content-Type": "application/json" } });
      }
      return response;
    };
    const lostExecute = createProtectedMailSparseReadExecutor({ authority: options(lostFetch), ca: fixture.ca, lookup: fixture.lookup, resolveCredential: resolver });
    const lostResult = await lostExecute(lost.id); privateResult(lostResult);
    assert.ok(lostResult.kind === "unknown" && lostResult.reason === "claim_outcome_unknown" && truncated === 1 && attempts.claims === lostAttempts.claims + 1
      && attempts.reports === lostAttempts.reports && resolutions === lostResolutions && fixture.stats.tcpConnections === lostTcp, "sparse_executor_lost_claim_started_work_or_reported");
    await assertLifecycle(lost.id, "Dispatching", 2); await executionOnly(beforeLost, lostOrdinary, lostViews, lost.id, 1);
    const beforeLostRetry = await snapshot(), lostRetry = await execute(lost.id); privateResult(lostRetry);
    assert.ok(lostRetry.kind === "denied" && lostRetry.reason === "protected_mail_sparse_read_consumed" && attempts.claims === lostAttempts.claims + 2
      && attempts.reports === lostAttempts.reports && resolutions === lostResolutions && fixture.stats.tcpConnections === lostTcp, "sparse_executor_lost_claim_retry_released_again");
    assert.deepEqual(await snapshot(), beforeLostRetry, "sparse_executor_lost_claim_retry_changed_state");
    const recoveryNonce = event("lost-claim-explicit-unknown"), recovery = await finishProtectedMailSparseReadDispatch(options(), lost.id, "Unknown", recoveryNonce);
    assert.ok(recovery.kind === "recorded" && recovery.eventNonce === recoveryNonce && recovery.outcome === "Unknown", "sparse_executor_explicit_recovery_failed");
    await assertLifecycle(lost.id, "Unknown", 3); await executionOnly(beforeLost, lostOrdinary, lostViews, lost.id, 2);
    const recoveredSnapshot = await snapshot(), repeatedReport = await finishProtectedMailSparseReadDispatch(options(), lost.id, "Unknown", recoveryNonce);
    assert.equal(repeatedReport.kind, "recorded", "sparse_executor_recovery_retry_not_recorded"); assert.deepEqual(await snapshot(), recoveredSnapshot, "sparse_executor_recovery_retry_mutated_state");
    assert.ok(resolutions === lostResolutions && fixture.stats.tcpConnections === lostTcp, "sparse_executor_recovery_opened_mailbox");
    console.log("PASS protected_mail_sparse_executor_lost_claim_stays_spent_without_connection");

    stage = "missing_final_present_uid_withholds_prior_local_metadata";
    const missing = await approvedRead("missing-final"); await assertLifecycle(missing.id, "Pending", 1); wire = "missing_final";
    const beforeMissing = await snapshot(), missingOrdinary = await snapshot(effects), missingViews = await ownerViews(), missingAttempts = { ...attempts }, missingTcp = fixture.stats.tcpConnections, missingResolutions = resolutions, missingFetches = fixture.stats.fetches.length;
    const failure = await execute(missing.id); privateResult(failure);
    assert.ok(failure.kind === "stopped" && failure.reason === "missing_uid" && failure.report.kind === "recorded" && failure.report.outcome === "Failed", "sparse_executor_missing_final_not_failed_whole_batch");
    assert.ok(attempts.claims === missingAttempts.claims + 1 && attempts.reports === missingAttempts.reports + 1 && resolutions === missingResolutions + 1 && fixture.stats.tcpConnections === missingTcp + 1
      && fixture.stats.fetches.slice(missingFetches).map(fetch => fetch.uid).join(",") === "2,5,8" && fixture.stats.searches.length === 0 && !fixture.stats.forbidden, "sparse_executor_failed_batch_retried_or_widened");
    await assertLifecycle(missing.id, "Failed", 3); await executionOnly(beforeMissing, missingOrdinary, missingViews, missing.id, 2);
    const failedSnapshot = await snapshot(), failedRetry = await execute(missing.id); privateResult(failedRetry);
    assert.ok(failedRetry.kind === "denied" && failedRetry.reason === "protected_mail_sparse_read_consumed" && fixture.stats.tcpConnections === missingTcp + 1 && resolutions === missingResolutions + 1
      && attempts.claims === missingAttempts.claims + 2 && attempts.reports === missingAttempts.reports + 1, "sparse_executor_failed_batch_reconnected_or_reported");
    assert.deepEqual(await snapshot(), failedSnapshot, "sparse_executor_failed_retry_mutated_state");
    console.log("PASS protected_mail_sparse_executor_final_uid_failure_no_partial_or_storage_effect");
    stage = "complete";
  } finally {
    const cleanup = [fixture.close()]; let drained = true;
    if (publisherIdentity) {
      const token = publisherIdentity.token, transport = new HttpStdbTransport({ baseUrl: base, dbName: name, token, fetchImpl: localFetch, timeoutMs: 15000 });
      try { await drainFixtureConnections(sockets, () => transport.sql("SELECT * FROM st_client")); } catch { drained = false; }
      if (drained && !retain) cleanup.push((async () => { const response = await localFetch(databaseUrl, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); assert.ok(response.ok || response.status === 404, "sparse_executor_database_cleanup_failed"); })());
    } else sockets.forEach(socket => socket.disconnect());
    assert.ok((await Promise.allSettled(cleanup)).every(result => result.status === "fulfilled") && drained, "sparse_executor_fixture_cleanup_failed");
  }
}
void main().catch(() => { console.error(`FAIL protected_mail_sparse_executor_e2e stage=${stage}`); process.exitCode = 1; });
