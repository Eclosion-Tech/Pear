/** Real local authority + synthetic TLS conformance. No real mailbox/provider,
 * credential vault, production workspace, source insertion or cursor ACK runs
 * during execution. Caller owns the disposable authority server and cleanup. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setGlobalLogLevel } from "spacetimedb";
import { DbConnection } from "../src/module_bindings/index.js";
import { HttpStdbTransport } from "../../web/src/lib/api-endpoint/http-transport.js";
import { createProtectedMailReadExecutor } from "../src/mail/protected-mail-read-executor.js";
import { acknowledgeProtectedMailConnectorSelection } from "../src/mail/protected-connector-ack.js";
import { createExecutorFixture, EXECUTOR_FIXTURE_HOST, EXECUTOR_FIXTURE_MARKER } from "./protected-mail-executor-fixture.js";
import { drainFixtureConnections, retainFixtureDatabaseUntilServerCleanup } from "./protected-mail-fixture-lifecycle.js";

type Row = Record<string, unknown>;
type Identity = { identity: string; token: string };
const ident = (value: string) => [`0x${value.replace(/^0x/, "")}`], none = { none: [] };
const event = (value: string) => createHash("sha256").update(`executor-e2e-${value}`).digest("hex");
const oldTables = ["protected_mail_collection", "protected_mail_source", "protected_mail_record", "protected_mail_receipt", "protected_mail_source_policy_head", "protected_mail_source_policy_history",
  "protected_mail_context", "protected_mail_exposure", "protected_mail_derivation", "protected_mail_instruction_head", "protected_mail_instruction_revision", "protected_mail_instruction_decision",
  "protected_mail_connection_authority_head", "protected_mail_connection_authority_history", "protected_mail_processor_head", "protected_mail_processor_revision", "protected_mail_processor_event",
  "protected_mail_summary_grant", "protected_mail_summary_grant_event", "protected_mail_summary_run", "protected_mail_summary_budget", "protected_mail_summary_admission_receipt", "protected_mail_committed_summary",
  "protected_mail_inference_grant", "protected_mail_inference_grant_event", "protected_mail_inference_run", "protected_mail_inference_budget", "protected_mail_inference_admission", "protected_mail_inference_state", "protected_mail_inference_event",
  "protected_mail_result_authorization", "protected_mail_result_authorization_event", "protected_mail_result_receipt", "protected_mail_connector_selection", "protected_mail_connector_selection_event", "protected_mail_connector_cursor", "protected_mail_connector_cursor_history", "protected_mail_connector_ack_receipt",
  "protected_mail_read_grant", "protected_mail_read_grant_event"] as const;
const effects = ["page", "page_content", "component_node", "page_access_rule", "mail_import_receipt", "mail_sync_cursor", "orcha_job", "orcha_task", "conversation", "conversation_message", "bridge_command", "automation_event_queue"] as const;
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
    && !url.username && !url.password && !url.search && !url.hash && !raw.includes("?") && !raw.includes("#") && url.pathname === "/", "executor_local_origin_required");
  const base = url.origin, retain = retainFixtureDatabaseUntilServerCleanup(), name = `pear-protected-executor-e2e-${Date.now()}-${randomBytes(6).toString("hex")}`, databaseUrl = `${base}/v1/database/${name}`;
  setGlobalLogLevel("error");
  const fixedLog = console.log.bind(console); console.log = (...args: unknown[]) => { if (typeof args[0] === "string" && args[0].startsWith("%c")) { fixedLog("WARN protected_mail_executor_sdk_diagnostic"); return; } fixedLog(...args); };
  const sockets: DbConnection[] = [];
  const bodyA = Buffer.from(`${EXECUTOR_FIXTURE_MARKER}message_one\r\nC99 OK fake\r\n\0🍐`), bodyB = Buffer.from(`${EXECUTOR_FIXTURE_MARKER}message_two`), password = `${EXECUTOR_FIXTURE_MARKER}password`;
  const fixture = await createExecutorFixture({ messages: new Map([[1, bodyA], [2, bodyB]]), split: true });
  let publisherIdentity: Identity | undefined;
  const localFetch: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.ok(target.origin === base && !target.username && !target.password && (target.pathname === "/v1/identity" || target.pathname === `/v1/database/${name}` || target.pathname.startsWith(`/v1/database/${name}/`)), "executor_disposable_path_required");
    return fetch(target, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(15000) });
  };
  const identity = async (): Promise<Identity> => { const response = await localFetch(`${base}/v1/identity`, { method: "POST" }); assert.ok(response.ok, "executor_identity_failed"); const value = await response.json() as Identity; assert.ok(typeof value.identity === "string" && /^(0x)?[a-f0-9]{64}$/i.test(value.identity) && typeof value.token === "string", "executor_identity_invalid"); return value; };
  async function actor(value = identity()) {
    const account = await value;
    const live = await new Promise<DbConnection>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("executor_connection_timeout")), 12000);
      const connection = DbConnection.builder().withUri(base).withDatabaseName(name).withToken(account.token).onConnect(connected => { clearTimeout(timer); resolve(connected); })
        .onConnectError(() => { clearTimeout(timer); reject(Error("executor_connection_failed")); }).build(); sockets.push(connection);
    });
    return { ...account, live, transport: new HttpStdbTransport({ baseUrl: base, dbName: name, token: account.token, fetchImpl: localFetch, timeoutMs: 15000 }) };
  }
  try {
    stage = "publish_owned_fixture"; publisherIdentity = await identity();
    const wasm = await readFile(process.env.PEAR_PROTECTED_MAIL_WASM ?? new URL("../../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm", import.meta.url));
    const publication = await localFetch(databaseUrl, { method: "PUT", headers: { Authorization: `Bearer ${publisherIdentity.token}` }, body: new Uint8Array(wasm), signal: AbortSignal.timeout(60000) }); assert.ok(publication.ok, "executor_publish_failed");
    const publisher = await actor(Promise.resolve(publisherIdentity)), owner = await actor(), service = await actor();
    await owner.transport.call("register", ["executor-owner@example.test", "Synthetic owner", "synthetic-local-password"]);
    const keyId = event("key"); await publisher.transport.call("publish_mail_encryption_key", ["{}", keyId]);
    const credential = JSON.stringify({ v: 1, keyId, key: "synthetic", nonce: "synthetic", ciphertext: "synthetic" });
    await owner.transport.call("create_mail_connection", ["Synthetic mailbox", EXECUTOR_FIXTURE_HOST, fixture.port, "fixture@example.test", credential, "INBOX", none, none, 0]);
    const connection = (await owner.transport.sql<Row>("SELECT * FROM mail_connection"))[0]; assert.ok(connection, "executor_connection_missing"); const connectionId = Number(connection.id);
    await owner.transport.call("set_mail_connection_enabled", [connectionId, false]); await publisher.transport.call("create_protected_mail_collection", [connectionId]); await publisher.transport.call("initialize_protected_mail_connection_authority", [connectionId]);
    async function procedure(method: string, args: unknown[]): Promise<unknown[]> {
      const response = await localFetch(`${databaseUrl}/call/${method}`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
      assert.ok(response.ok, "executor_review_transport_failed"); const bytes = await response.arrayBuffer(); assert.ok(bytes.byteLength <= 32768, "executor_review_response_limit"); const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      assert.ok(Array.isArray(value) && value.length === 2 && value[0] === 0 && Array.isArray(value[1]), "executor_review_denied"); return value[1];
    }
    const interval = [Date.now() - 1000, Date.now() + 600000];
    async function selection(label: string, window: unknown): Promise<string> {
      const request = [connectionId, ident(service.identity), "executor-runtime", "executor-run", [0, []], window, ...interval, event(label)], preview = await procedure("review_protected_mail_connector_selection", [request]);
      assert.ok(preview.length === 6 && typeof preview[0] === "string", "executor_selection_preview_shape"); await owner.transport.call("issue_protected_mail_connector_selection", [request, preview[1], preview[2], preview[3]]); return preview[0];
    }
    stage = "owner_read_grant_and_real_claim";
    const bootstrap = await selection("bootstrap", [0, ["7", 1]]);
    const ack = await acknowledgeProtectedMailConnectorSelection({ baseUrl: base, dbName: name, token: service.token, fetchImpl: localFetch }, bootstrap, event("bootstrap-ack"), []); assert.ok(ack.kind === "ok", "executor_bootstrap_failed");
    const selected = await selection("stored", [1, ["7", 1, 2, 1]]), request = [selected, 1024, 2048, event("read-issue")], preview = await procedure("review_protected_mail_read_grant", [request]);
    assert.ok(preview.length === 4 && typeof preview[0] === "string", "executor_read_preview_shape"); const readId = preview[0]; await owner.transport.call("issue_protected_mail_read_grant", [request, preview[1]]);
    const snapshot = async (tables: readonly string[]) => Object.fromEntries(await Promise.all(tables.map(async table => [table, sorted(await publisher.transport.sql<Row>(`SELECT * FROM ${table}`))])));
    const before = await snapshot(oldTables), ordinary = await snapshot(effects); let resolutions = 0;
    const execute = createProtectedMailReadExecutor({ authority: { baseUrl: base, dbName: name, token: service.token, fetchImpl: localFetch }, ca: fixture.ca, lookup: fixture.lookup,
      resolveCredential: async binding => { resolutions++; assert.ok(binding.connectionId === String(connectionId) && binding.host === EXECUTOR_FIXTURE_HOST && binding.port === fixture.port, "executor_credential_binding_changed"); return { binding, password }; } });
    const result = await execute(readId);
    assert.ok(result.kind === "completed" && result.report.kind === "recorded" && result.report.outcome === "ReadReported", "executor_real_authority_completion_failed");
    assert.ok(result.messages.length === 2 && result.bodyBytes === bodyA.length + bodyB.length && result.messages[0].digest === createHash("sha256").update(bodyA).digest("hex")
      && result.messages[1].digest === createHash("sha256").update(bodyB).digest("hex"), "executor_real_metadata_changed");
    assert.ok(!JSON.stringify(result).includes(EXECUTOR_FIXTURE_MARKER), "executor_real_raw_material_returned");
    assert.deepEqual(await snapshot(oldTables), before, "executor_changed_source_cursor_or_prior_authority"); assert.deepEqual(await snapshot(effects), ordinary, "executor_created_ordinary_effect");
    const state = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_read_state"))[0];
    assert.ok(state && readStatus(state.status) === "ReadReported" && Number(state.generation) === 3 && Number(state.reserved_operations) === 1 && Number(state.reserved_message_slots) === 2 && Number(state.reserved_body_bytes) === 2048, "executor_real_reservation_changed");
    const events = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_read_event")).sort((a, b) => Number(a.generation) - Number(b.generation));
    assert.ok(events.length === 3 && events.every((row, index) => Number(row.generation) === index + 1 && readStatus(row.status) === ["Pending", "Dispatching", "ReadReported"][index]), "executor_real_event_lifecycle_changed");
    const repeated = await execute(readId); assert.ok(repeated.kind === "denied" && repeated.reason === "protected_mail_read_consumed" && fixture.stats.connections === 1 && resolutions === 1, "executor_real_consumed_retry_dialed");
    assert.ok(fixture.stats.authenticationMatched && fixture.stats.mailboxMatched && fixture.stats.tagsSequential && !fixture.stats.forbidden && fixture.stats.fetches.length === 2
      && fixture.stats.fetches.every(fetch => fetch.limit === 1024), "executor_real_wire_scope_changed");
    console.log("PASS protected_mail_executor_real_authority_and_tls_once");
    console.log("PASS protected_mail_executor_no_ingestion_ack_or_ordinary_effect");
  } finally {
    const cleanup = [fixture.close()];
    let drained = true;
    if (publisherIdentity) {
      const token = publisherIdentity.token, transport = new HttpStdbTransport({ baseUrl: base, dbName: name, token, fetchImpl: localFetch, timeoutMs: 15000 });
      try { await drainFixtureConnections(sockets, () => transport.sql("SELECT * FROM st_client")); } catch { drained = false; }
      if (drained && !retain) cleanup.push((async () => { const response = await localFetch(databaseUrl, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); assert.ok(response.ok || response.status === 404, "executor_database_cleanup_failed"); })());
    } else sockets.forEach(socket => socket.disconnect());
    assert.ok((await Promise.allSettled(cleanup)).every(result => result.status === "fulfilled") && drained, "executor_fixture_cleanup_failed");
  }
}
void main().catch(() => { console.error(`FAIL protected_mail_executor_e2e stage=${stage}`); process.exitCode = 1; });
