/** Disposable staged S1b provenance test against localhost SpacetimeDB 2.0.3.
 * No mailbox, model, worker, real credentials or production workspace is used.
 * PEAR_SOURCE_STATE_BASELINE_WASM optionally seeds retained S1a private records
 * before an additive upgrade to PEAR_PROTECTED_MAIL_WASM. The default is fresh.
 * Output contains fixed stage codes only, never fixture values or raw errors.
 */
import assert from "node:assert/strict";
import { drainFixtureConnections, retainFixtureDatabaseUntilServerCleanup } from "./protected-mail-fixture-lifecycle.js";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setGlobalLogLevel } from "spacetimedb";
import { DbConnection, tables } from "../src/module_bindings/index.js";
import { HttpStdbTransport } from "../../web/src/lib/api-endpoint/http-transport.js";
import { SNAPSHOT_TABLES_V2, snapshotExportQueriesV2 } from "../../packages/snapshot-core/src/index.js";

type Row = Record<string, unknown>;
type IdentityToken = { identity: string; token: string };
type Actor = IdentityToken & { transport: HttpStdbTransport; live: DbConnection };
type ConnectionRow = { id: number; root_page_id: number };
type SourceRow = Row & { id: string; collection_id: number; revision: number; digest: string };
type SourceRef = [string, number, string];
type Processor = [string, string, string, string];
type CachedTable = { iter(): Iterable<Row>; count(): bigint };

const none = { none: [] };
const ident = (hex: string) => [`0x${hex.replace(/^0x/, "")}`];
const marker = `S1B_PRIVATE_SYNTHETIC_${randomBytes(12).toString("hex")}`;
const password = "synthetic-local-fixture-password";
const mailTables = ["protected_mail_collection", "protected_mail_source", "protected_mail_record", "protected_mail_receipt"] as const;
const stateTables = ["protected_mail_source_policy_head", "protected_mail_source_policy_history", "protected_mail_context", "protected_mail_exposure", "protected_mail_derivation"] as const;
const privateTables = [...mailTables, ...stateTables];
let stage = "localhost_guard";

function localBase(raw: string): string {
  const value = new URL(raw);
  assert.equal(raw, raw.trim(), "invalid_local_base");
  assert.equal(value.protocol, "http:", "localhost_http_required");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(value.hostname), "localhost_required");
  assert.ok(!value.username && !value.password && !value.search && !value.hash && value.pathname === "/", "origin_only_required");
  assert.ok(!raw.includes("?") && !raw.includes("#"), "origin_only_required");
  return value.origin;
}

function sorted(rows: Row[]): Row[] {
  return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function containsMarker(value: unknown): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(item => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)
      && Buffer.from(value as number[]).toString("utf8").includes(marker)) return true;
    return value.some(containsMarker);
  }
  return value !== null && typeof value === "object" && Object.values(value).some(containsMarker);
}

function sourceReference(value: unknown): SourceRef {
  if (Array.isArray(value)) {
    assert.equal(value.length, 3, "source_reference_shape");
    return [String(value[0]), Number(value[1]), String(value[2])];
  }
  assert.ok(value && typeof value === "object", "source_reference_shape");
  const row = value as Row;
  return [String(row.id), Number(row.revision), String(row.digest)];
}

function references(value: unknown): SourceRef[] {
  assert.ok(Array.isArray(value), "source_members_shape");
  return value.map(sourceReference).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function sameReference(value: unknown, expected: SourceRef): boolean {
  return JSON.stringify(sourceReference(value)) === JSON.stringify(expected);
}

function processors(value: unknown): Processor[] {
  assert.ok(Array.isArray(value), "processor_list_shape");
  return value.map(item => {
    if (Array.isArray(item)) {
      assert.equal(item.length, 4, "processor_shape");
      return item.map(String) as Processor;
    }
    assert.ok(item && typeof item === "object", "processor_shape");
    const row = item as Row;
    return [String(row.profile_id), String(row.revision), String(row.endpoint), String(row.model)] as Processor;
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function denied(operation: Promise<unknown>, code?: string): Promise<string> {
  try { await operation; }
  catch (error) {
    assert.ok(error instanceof Error, "denial_error_required");
    if (code) assert.ok(error.message.includes(code), "unexpected_denial_code");
    assert.ok(!containsMarker(error.message), "denial_contains_private_marker");
    return error.message;
  }
  assert.fail("operation_unexpectedly_accepted");
}

function cache(connection: DbConnection, name: string): CachedTable {
  const result = (connection.db as unknown as Record<string, CachedTable>)[name];
  assert.ok(result && typeof result.iter === "function", "generated_owner_view_required");
  return result;
}

async function main(): Promise<void> {
  const base = localBase(process.argv[2] ?? "http://127.0.0.1:3099");
  assert.ok(process.argv.length <= 3, "unexpected_arguments");
  const retainFixtureDatabase = retainFixtureDatabaseUntilServerCleanup();
  setGlobalLogLevel("error");
  const fixedLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("%c")) {
      fixedLog("WARN protected_mail_state_sdk_diagnostic");
      return;
    }
    fixedLog(...args);
  };
  const name = `pear-protected-state-e2e-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const databaseUrl = `${base}/v1/database/${name}`;
  const connections: DbConnection[] = [];
  let publisherIdentity: IdentityToken | undefined;

  const localFetch: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(target.origin, base, "local_origin_required");
    assert.ok(!target.username && !target.password, "userinfo_forbidden");
    assert.ok(target.pathname === "/v1/identity" || target.pathname === `/v1/database/${name}`
      || target.pathname.startsWith(`/v1/database/${name}/`), "disposable_path_required");
    return fetch(target, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(15000) });
  };

  async function identity(): Promise<IdentityToken> {
    const response = await localFetch(`${base}/v1/identity`, { method: "POST" });
    assert.ok(response.ok, "identity_failed");
    const value = await response.json() as IdentityToken;
    assert.ok(typeof value.identity === "string" && /^[0-9a-f]{64}$/i.test(value.identity.replace(/^0x/, ""))
      && typeof value.token === "string" && value.token.length > 0, "identity_invalid");
    return value;
  }

  async function connect(value: IdentityToken): Promise<Actor> {
    const live = await new Promise<DbConnection>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connection_timeout")), 12000);
      const connection = DbConnection.builder().withUri(base).withDatabaseName(name).withToken(value.token)
        .onConnect(connected => { clearTimeout(timer); resolve(connected); })
        .onConnectError(() => { clearTimeout(timer); reject(new Error("connection_failed")); })
        .build();
      connections.push(connection);
    });
    return { ...value, live, transport: new HttpStdbTransport({ baseUrl: base, dbName: name, token: value.token, fetchImpl: localFetch, timeoutMs: 15000 }) };
  }

  async function actor(): Promise<Actor> { return connect(await identity()); }

  async function subscribe(account: Actor, queries: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("subscription_timeout")), 12000);
      account.live.subscriptionBuilder()
        .onApplied(() => { clearTimeout(timer); resolve(); })
        .onError(() => { clearTimeout(timer); reject(new Error("subscription_failed")); })
        .subscribe(queries);
    });
  }

  async function privateSubscriptionDenied(account: Actor, table: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("private_subscription_timeout")), 12000);
      account.live.subscriptionBuilder()
        .onApplied(() => { clearTimeout(timer); reject(new Error("private_subscription_accepted")); })
        .onError(() => { clearTimeout(timer); resolve(); })
        .subscribe([`SELECT * FROM ${table}`]);
    });
  }

  async function publish(wasm: Uint8Array, upgrade = false): Promise<void> {
    assert.ok(publisherIdentity, "publisher_required");
    let suffix = "";
    if (upgrade) {
      const response = await localFetch(`${databaseUrl}/pre_publish`, {
        method: "POST", headers: { Authorization: `Bearer ${publisherIdentity.token}` }, body: new Uint8Array(wasm), signal: AbortSignal.timeout(60000),
      });
      assert.ok(response.ok, "upgrade_plan_failed");
      const value = await response.json() as { AutoMigrate?: { break_clients: boolean; token?: string } };
      assert.ok(value.AutoMigrate, "additive_upgrade_required");
      if (value.AutoMigrate.break_clients) {
        assert.ok(value.AutoMigrate.token, "migration_token_required");
        suffix = `?policy=BreakClients&token=${encodeURIComponent(value.AutoMigrate.token)}`;
      }
    }
    const response = await localFetch(databaseUrl + suffix, {
      method: "PUT", headers: { Authorization: `Bearer ${publisherIdentity.token}` }, body: new Uint8Array(wasm), signal: AbortSignal.timeout(60000),
    });
    assert.ok(response.ok, "module_publish_failed");
  }

  try {
    stage = "publish_fixture";
    const currentWasm = await readFile(process.env.PEAR_PROTECTED_MAIL_WASM
      ?? new URL("../../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm", import.meta.url));
    const baseline = process.env.PEAR_SOURCE_STATE_BASELINE_WASM;
    const baselineWasm = baseline ? await readFile(baseline) : undefined;
    assert.ok(currentWasm.length > 0 && (!baselineWasm || baselineWasm.length > 0), "module_artifact_required");
    assert.ok(!baselineWasm || !baselineWasm.equals(currentWasm), "distinct_upgrade_artifacts_required");
    publisherIdentity = await identity();
    await publish(baselineWasm ?? currentWasm);
    let publisher = await connect(publisherIdentity);
    let admin = await actor(), owner = await actor(), other = await actor();
    let ai = await actor(), hybrid = await actor(), anonymous = await actor(), service = await actor();
    stage = "fixture_accounts";
    await admin.transport.call("register", ["state-admin@example.test", "Fixture admin", password]);
    for (const [account, email] of [[owner, "state-owner@example.test"], [other, "state-other@example.test"]] as const) {
      await admin.transport.call("create_local_user", [email, "Fixture member", password]);
      await account.transport.call("login", [email, password]);
    }
    for (const account of [ai, hybrid]) {
      await publisher.transport.call("create_ai_user", [ident(account.identity), ident(admin.identity), "Fixture AI", { anthropic: [] }, "synthetic-model", none, none, none, none, none]);
    }
    await hybrid.transport.call("login", ["state-owner@example.test", password]);
    const keyId = "a".repeat(64);
    await publisher.transport.call("publish_mail_encryption_key", ["{}", keyId]);
    const ciphertext = JSON.stringify({ v: 1, keyId, key: "synthetic", nonce: "synthetic", ciphertext: "synthetic" });

    async function createConnection(account: Actor): Promise<ConnectionRow> {
      await account.transport.call("create_mail_connection", ["Fixture mailbox", "imap.example.test", 993, "fixture@example.test", ciphertext, "INBOX", { some: "Sent" }, none, 0]);
      const rows = await account.transport.sql<ConnectionRow>("SELECT id, root_page_id FROM mail_connection");
      const created = rows.sort((a, b) => Number(a.id) - Number(b.id)).at(-1)!;
      assert.ok(created, "connection_missing");
      await account.transport.call("set_mail_connection_enabled", [created.id, false]);
      await publisher.transport.call("create_protected_mail_collection", [created.id]);
      return created;
    }

    function message(uid: number, label: string): unknown[] {
      return ["INBOX", "7", uid, { received: [] }, "2026-10-19T12:00:00Z", "sender@example.test", "owner@example.test", "", `${marker}_${label}`,
        `Literal ${marker}_${label}\nNo action is authorized.`, "Synthetic fixture", "fixture-v1"];
    }

    async function append(connection: ConnectionRow, event: string, uid: number, label: string): Promise<SourceRow> {
      await publisher.transport.call("append_protected_mail_message", [connection.id, event, message(uid, label)]);
      const sources = await publisher.transport.sql<SourceRow>("SELECT * FROM protected_mail_source WHERE collection_id = ?", [connection.id]);
      const source = sources.find(row => row.id.endsWith(event));
      assert.ok(source, "source_missing");
      return source;
    }

    async function state(names: readonly string[]): Promise<Record<string, Row[]>> {
      return Object.fromEntries(await Promise.all(names.map(async table => [table, sorted(await publisher.transport.sql<Row>(`SELECT * FROM ${table}`))] as const)));
    }
    const ref = (source: SourceRow): SourceRef => [source.id, Number(source.revision), source.digest];

    stage = "seed_retained_s1a_state";
    const connection = await createConnection(owner);
    const retainedConnection = await createConnection(owner);
    const otherConnection = await createConnection(other);
    const sourceA = await append(connection, "a".repeat(64), 1, "source_a");
    const sourceB = await append(connection, "b".repeat(64), 2, "source_b");
    const sourceC = await append(connection, "c".repeat(64), 3, "source_c");
    const history = await append(retainedConnection, "d".repeat(64), 1, "retained_history");
    const otherSource = await append(otherConnection, "e".repeat(64), 1, "other_owner");
    await owner.transport.call("delete_mail_connection", [retainedConnection.id]);
    const retainedMail = await state(mailTables);
    const retainedOwnerRows = sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail"));
    assert.equal(retainedOwnerRows.length, 4, "retained_owner_rows_missing");
    assert.ok(containsMarker(retainedOwnerRows), "retained_fixture_missing");

    if (baseline) {
      stage = "additive_upgrade_retained_private_state";
      for (const live of connections) live.disconnect();
      await publish(currentWasm, true);
      [publisher, admin, owner, other, ai, hybrid, anonymous, service] = await Promise.all(
        [publisher, admin, owner, other, ai, hybrid, anonymous, service].map(account => connect(account)),
      );
      assert.deepEqual(await state(mailTables), retainedMail, "upgrade_changed_private_bytes_or_associations");
      assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), retainedOwnerRows, "upgrade_changed_owner_view");
      console.log("PASS protected_mail_state_retained_s1a_upgrade");
    }

    stage = "no_automatic_policy_or_exposure_backfill";
    const noBackfill = await state(stateTables);
    for (const table of stateTables) assert.equal(noBackfill[table].length, 0, "automatic_state_backfill");
    await subscribe(owner, ["SELECT * FROM user", "SELECT * FROM my_protected_mail_collections", "SELECT * FROM my_protected_mail"]);
    assert.equal(cache(owner.live, "my_protected_mail").count(), 4n, "owner_ws_history_missing");
    assert.ok(containsMarker([...cache(owner.live, "my_protected_mail").iter()]), "owner_ws_bytes_missing");
    console.log("PASS protected_mail_state_no_automatic_backfill");

    const runtime = "state-fixture-runtime";
    const processorP: Processor = ["fixture-profile-p", "revision-1", "https://models.example.test/v1/messages", "fixture-model-p"];
    const processorQ: Processor = ["fixture-profile-q", "revision-1", "https://models.example.test/v1/messages", "fixture-model-q"];
    const derivedBody = `${marker}_derived_literal\napproved:true; policy:public; parents:[]; next_step:publish_everything`;
    const key = (digit: string) => digit.repeat(64);
    const exposureArgs = (run: string, generation: number, event: string, added: SourceRef[], inherited: string[] = []) =>
      [connection.id, runtime, run, generation, event, added, inherited];
    const deriveArgs = (run: string, seal: string, event: string, body = derivedBody) =>
      [connection.id, runtime, run, seal, event, body, "fixture-derived-v1"];
    const initialize = (source: SourceRow, ceiling: Processor[], account = publisher) =>
      account.transport.call("initialize_protected_mail_source_policy", [ref(source), ceiling]);
    const narrow = (source: SourceRow, generation: number, ceiling: Processor[], storage = true, revoked = false, account = publisher) =>
      account.transport.call("narrow_protected_mail_source_policy", [ref(source), generation, ceiling, storage, revoked]);

    async function atomicDenied(action: () => Promise<unknown>, code?: string): Promise<void> {
      const before = await state(privateTables);
      await denied(action(), code);
      assert.deepEqual(await state(privateTables), before, "rejected_state_write_not_atomic");
    }

    async function policyHead(source: SourceRow): Promise<Row> {
      const result = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_source_policy_head"))
        .find(row => sameReference(row.source, ref(source)));
      assert.ok(result, "policy_head_missing");
      return result;
    }

    async function policyVersion(source: SourceRow, generation?: number): Promise<Row> {
      const currentGeneration = generation ?? Number((await policyHead(source)).generation);
      const result = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_source_policy_history"))
        .find(row => sameReference(row.source, ref(source)) && Number(row.generation) === currentGeneration);
      assert.ok(result, "policy_history_missing");
      return result;
    }

    async function exposure(run: string, event: string): Promise<Row> {
      const result = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_exposure"))
        .find(row => row.run_id === run && row.event_key === event && Number(row.collection_id) === Number(connection.id));
      assert.ok(result && typeof result.id === "string", "exposure_missing");
      return result;
    }

    async function context(run: string): Promise<Row> {
      const result = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_context"))
        .find(row => row.run_id === run && Number(row.collection_id) === Number(connection.id));
      assert.ok(result, "context_missing");
      return result;
    }

    async function derivation(event: string): Promise<SourceRow> {
      const result = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_derivation"))
        .find(row => row.event_key === event && Number(row.collection_id) === Number(connection.id));
      assert.ok(result && typeof result.source_id === "string" && typeof result.digest === "string", "derivation_missing");
      return { ...result, id: result.source_id, collection_id: Number(result.collection_id), revision: Number(result.revision), digest: result.digest } as SourceRow;
    }

    stage = "new_private_http_ws_and_mutation_boundary";
    const ordinary = [owner, other, admin, ai, hybrid, anonymous, service];
    const boundaryState = await state(privateTables);
    const generatedNames = Object.values(tables).map(table => (table as { sourceName: string }).sourceName);
    for (const table of stateTables) {
      assert.ok(!generatedNames.includes(table), "private_state_has_generated_public_binding");
      assert.ok(!SNAPSHOT_TABLES_V2.includes(table as typeof SNAPSHOT_TABLES_V2[number]), "private_state_is_exportable");
      assert.ok(!snapshotExportQueriesV2().some(query => query.includes(table)), "private_state_export_hydration");
    }
    for (const candidate of ordinary) {
      for (const table of stateTables) {
        await denied(candidate.transport.sql(`SELECT * FROM ${table}`));
        await privateSubscriptionDenied(candidate, table);
      }
      await denied(initialize(sourceA, [processorP], candidate));
      await denied(candidate.transport.call("record_protected_mail_exposure", exposureArgs("unauthorized", 0, key("1"), [ref(sourceA)])));
      await denied(candidate.transport.call("block_protected_mail_context", [connection.id, runtime, "unauthorized"]));
      await denied(candidate.transport.call("append_protected_mail_derivation", deriveArgs("unauthorized", `mail-exposure:${key("1")}`, key("2"))));
    }
    assert.deepEqual(await state(privateTables), boundaryState, "ordinary_actor_changed_private_state");
    console.log("PASS protected_mail_state_private_protocol_and_publisher_boundary");

    stage = "missing_policy_blocks_output_but_not_tracking";
    await publisher.transport.call("record_protected_mail_exposure", exposureArgs("missing-policy", 0, key("1"), [ref(sourceA)]));
    const missingPolicySeal = await exposure("missing-policy", key("1"));
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs("missing-policy", String(missingPolicySeal.id), key("2"))), "protected_mail_source_policy_required");
    assert.equal((await publisher.transport.sql("SELECT * FROM protected_mail_source_policy_head")).length, 0, "tracking_created_policy");

    stage = "initial_ceiling_replay_and_live_subset_cas";
    await initialize(sourceA, [processorQ, processorP]);
    await initialize(sourceB, [processorP]);
    await initialize(sourceC, [processorP, processorQ]);
    await initialize(history, [processorP, processorQ]);
    await initialize(otherSource, [processorP]);
    const initialized = await state(stateTables);
    await initialize(sourceA, [processorP, processorQ]);
    assert.deepEqual(await state(stateTables), initialized, "exact_initialization_replay_mutated_state");
    await atomicDenied(() => initialize(sourceA, [processorP]), "protected_mail_source_policy_initialization_conflict");
    await atomicDenied(() => initialize(sourceA, [processorP, processorP]), "protected_mail_invalid_processors");
    assert.equal(Number((await policyHead(sourceA)).generation), 1, "initial_policy_generation");
    assert.deepEqual(processors((await policyVersion(sourceA)).processors), processors([processorP, processorQ]));
    await narrow(sourceA, 1, [processorP], true, false, owner);
    const narrowedHead = await policyHead(sourceA);
    assert.equal(Number(narrowedHead.generation), 2, "narrowing_did_not_advance_head");
    assert.deepEqual(processors((await policyVersion(sourceA)).processors), processors([processorP]));
    await atomicDenied(() => narrow(sourceA, 1, [processorP]), "protected_mail_source_policy_stale");
    await atomicDenied(() => narrow(sourceA, 2, [processorP, processorQ]), "protected_mail_source_policy_expansion");
    for (const tupleField of [0, 1, 2, 3]) {
      const substituted = [...processorP] as Processor;
      substituted[tupleField] = tupleField === 2 ? "https://other.example.test/v1/messages" : "substituted";
      await atomicDenied(() => narrow(sourceA, 2, [substituted]), "protected_mail_source_policy_expansion");
    }
    for (const candidate of [other, admin, ai, hybrid, anonymous, service]) {
      await atomicDenied(() => narrow(sourceA, 2, [], false, true, candidate), "protected_mail_source_policy_owner_required");
    }
    const oracleRefs: SourceRef[] = [
      ref(sourceA),
      ["mail-source:missing", 1, sourceA.digest],
      [sourceA.id, sourceA.revision, "0".repeat(64)],
      [sourceA.id, Number(sourceA.revision) + 1, sourceA.digest],
      ["", 0, "malformed-digest"],
    ];
    const beforeOracle = await state(privateTables);
    const oracleResponses: string[] = [];
    for (const candidate of [other, admin, ai, hybrid, anonymous, service]) {
      for (const reference of oracleRefs) {
        oracleResponses.push(await denied(candidate.transport.call("narrow_protected_mail_source_policy", [reference, 2, [], false, true]), "protected_mail_source_policy_owner_required"));
      }
    }
    for (const reference of oracleRefs.slice(1)) {
      oracleResponses.push(await denied(owner.transport.call("narrow_protected_mail_source_policy", [reference, 2, [], false, true]), "protected_mail_source_policy_owner_required"));
    }
    assert.equal(new Set(oracleResponses).size, 1, "policy_denial_distinguishes_source_existence");
    assert.deepEqual(await state(privateTables), beforeOracle, "policy_metadata_oracle_changed_state");
    await atomicDenied(() => narrow(otherSource, 1, [], false, true, owner), "protected_mail_source_policy_owner_required");
    const beforeOldInit = await state(stateTables);
    await initialize(sourceA, [processorP, processorQ]);
    assert.deepEqual(await state(stateTables), beforeOldInit, "old_initialization_replay_reset_head");
    await narrow(history, 1, [processorP], false, false, owner);
    assert.equal(Number((await policyHead(history)).generation), 2, "disconnected_history_narrowing_failed");
    assert.equal((await policyVersion(history)).allow_owner_storage, false, "disconnected_history_storage_not_narrowed");
    console.log("PASS protected_mail_state_immutable_initial_ceiling_and_current_cas");

    stage = "policy_reference_validation_atomicity";
    for (const invalid of [
      [sourceC.id, Number(sourceC.revision) + 1, sourceC.digest],
      [sourceC.id, sourceC.revision, "0".repeat(64)],
      ["mail-source:missing", 1, sourceC.digest],
    ]) {
      await atomicDenied(() => publisher.transport.call("initialize_protected_mail_source_policy", [invalid, [processorP]]));
      await atomicDenied(() => publisher.transport.call("narrow_protected_mail_source_policy", [invalid, 1, [], false, true]));
    }
    for (const invalidProcessor of [
      ["fixture-profile-p", "revision-1", "https://user:secret@models.example.test/v1/messages", "fixture-model-p"],
      ["fixture-profile-p", "revision-1", "https://models.example.test/v1/messages?secret=fixture", "fixture-model-p"],
      ["fixture-profile-p", "revision-1", "http://models.example.test/v1/messages", "fixture-model-p"],
    ]) {
      await atomicDenied(() => publisher.transport.call("initialize_protected_mail_source_policy", [ref(sourceC), [invalidProcessor]]));
    }
    const tooManyProcessors = Array.from({ length: 33 }, (_, index) => [`fixture-profile-${index}`, "revision-1", "https://models.example.test/v1/messages", `fixture-model-${index}`]);
    await atomicDenied(() => publisher.transport.call("initialize_protected_mail_source_policy", [ref(sourceC), tooManyProcessors]));

    stage = "cumulative_sealed_exposure_and_replay";
    const run = "cumulative-context";
    const firstArgs = exposureArgs(run, 0, key("3"), [ref(sourceA)]);
    await publisher.transport.call("record_protected_mail_exposure", firstArgs);
    const firstSeal = await exposure(run, key("3"));
    assert.deepEqual(references(firstSeal.members), references([ref(sourceA)]));
    await publisher.transport.call("record_protected_mail_exposure", exposureArgs(run, 1, key("4"), [ref(sourceB)]));
    const secondSeal = await exposure(run, key("4"));
    assert.deepEqual(references(secondSeal.members), references([ref(sourceA), ref(sourceB)]));
    const secondHead = await context(run);
    const sealedState = await state(stateTables);
    await publisher.transport.call("record_protected_mail_exposure", firstArgs);
    assert.deepEqual(await context(run), secondHead, "old_event_replay_rewound_context_head");
    assert.deepEqual(await state(stateTables), sealedState, "old_exposure_replay_mutated_seal");
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs(run, 0, key("5"), [ref(sourceA)])), "protected_mail_exposure_stale");
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs(run, 0, key("3"), [ref(sourceB)])), "protected_mail_exposure_conflict");
    // Adding only A again cannot delete historical B from the next seal.
    await publisher.transport.call("record_protected_mail_exposure", exposureArgs(run, 2, key("5"), [ref(sourceA)]));
    const fullSeal = await exposure(run, key("5"));
    assert.deepEqual(references(fullSeal.members), references([ref(sourceA), ref(sourceB)]));
    assert.deepEqual(await exposure(run, key("3")), firstSeal, "sealed_members_changed");
    await publisher.transport.call("record_protected_mail_exposure", exposureArgs("inherited-context", 0, key("6"), [], [String(fullSeal.id)]));
    const inheritedSeal = await exposure("inherited-context", key("6"));
    assert.deepEqual(references(inheritedSeal.members), references(fullSeal.members));
    await publisher.transport.call("record_protected_mail_exposure", exposureArgs("inherited-context", 1, key("7"), [ref(sourceA)]));
    assert.deepEqual(references((await exposure("inherited-context", key("7"))).members), references(fullSeal.members));
    console.log("PASS protected_mail_state_cumulative_seals_and_historical_replay");

    stage = "reference_bounds_and_context_substitution";
    for (const [index, invalid] of [
      [sourceA.id, sourceA.revision, "0".repeat(64)],
      [sourceA.id, Number(sourceA.revision) + 1, sourceA.digest],
      ref(otherSource),
      ref(history),
    ].entries()) {
      stage = `exposure_reference_rejection_${index}`;
      await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs("invalid-reference", 0, key("8"), [invalid as SourceRef])));
    }
    stage = "exposure_conflicting_digest_rejection";
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs("invalid-reference", 0, key("8"), [ref(sourceA), [sourceA.id, sourceA.revision, "0".repeat(64)]])), "protected_mail_source_conflict");
    stage = "exposure_direct_count_bound";
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs("invalid-reference", 0, key("8"), Array.from({ length: 65 }, () => ref(sourceA)))), "protected_mail_invalid_exposure");
    stage = "exposure_inherited_count_bound";
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs("invalid-reference", 0, key("8"), [], Array.from({ length: 17 }, () => String(fullSeal.id)))), "protected_mail_invalid_exposure");
    stage = "exposure_context_identifier_bound";
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs("invalid/reference", 0, key("8"), [ref(sourceA)])), "protected_mail_invalid_context");
    stage = "exposure_inherited_identifier_bound";
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs("invalid-reference", 0, key("8"), [], ["arbitrary-page-id"])), "protected_mail_invalid_exposure");
    stage = "derivation_context_seal_substitution";
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs("inherited-context", String(fullSeal.id), key("9"))), "protected_mail_context_mismatch");
    stage = "derivation_missing_seal_rejection";
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs(run, `mail-exposure:${key("0")}`, key("9"))), "protected_mail_exposure_missing");
    stage = "empty_exposure_cannot_authorize_output";
    await publisher.transport.call("record_protected_mail_exposure", exposureArgs("empty-context", 0, key("8"), []));
    const emptySeal = await exposure("empty-context", key("8"));
    assert.deepEqual(references(emptySeal.members), [], "empty_exposure_has_sources");
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs("empty-context", String(emptySeal.id), key("9"))), "protected_mail_source_required");
    stage = "cross_owner_seal_fixture";
    await publisher.transport.call("record_protected_mail_exposure", [otherConnection.id, runtime, "other-owner-context", 0, key("8"), [ref(otherSource)], []]);
    const otherSeal = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_exposure"))
      .find(row => row.run_id === "other-owner-context")!;
    assert.ok(otherSeal, "cross_owner_fixture_seal_missing");
    stage = "cross_owner_seal_inheritance_rejection";
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs("cross-owner-seal", 0, key("9"), [], [String(otherSeal.id)])));
    stage = "cross_owner_derivation_seal_rejection";
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs(run, String(otherSeal.id), key("9"))));

    stage = "derived_output_exact_parents_and_replay";
    const derivedArgs = deriveArgs(run, String(fullSeal.id), key("a"));
    await publisher.transport.call("append_protected_mail_derivation", derivedArgs);
    const derived = await derivation(key("a"));
    assert.deepEqual(references(derived.parents), references(fullSeal.members), "derived_parents_omit_sealed_member");
    assert.equal(derived.body, derivedBody, "derived_bytes_changed");
    assert.deepEqual(processors((await policyVersion(derived)).processors), processors([processorP]), "derived_policy_not_intersection");
    await atomicDenied(() => initialize(derived, [processorP, processorQ]), "protected_mail_source_policy_initialization_conflict");
    await atomicDenied(() => narrow(derived, 1, [processorP, processorQ]), "protected_mail_source_policy_expansion");
    const beforeDerivedReplay = await state(privateTables);
    await publisher.transport.call("append_protected_mail_derivation", derivedArgs);
    assert.deepEqual(await state(privateTables), beforeDerivedReplay, "derived_replay_mutated_state");
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs(run, String(fullSeal.id), key("a"), "changed body")), "protected_mail_derivation_conflict");
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", [...derivedArgs.slice(0, 6), "changed-version"]), "protected_mail_derivation_conflict");
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs(run, String(fullSeal.id), key("b"), "é".repeat(80001))), "protected_mail_invalid_derivation");
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs(run, String(fullSeal.id), key("b"), "hostile\u0000body")), "protected_mail_invalid_derivation");
    // A delayed result can name the exact earlier seal. It never changes the
    // current context or rewrites that immutable invocation's parent set.
    const beforeDelayedHead = await context(run);
    await publisher.transport.call("append_protected_mail_derivation", deriveArgs(run, String(firstSeal.id), key("b"), `${marker}_delayed_original_input`));
    assert.deepEqual(references((await derivation(key("b"))).parents), references(firstSeal.members));
    assert.deepEqual(await context(run), beforeDelayedHead, "delayed_output_changed_context_head");
    await publisher.transport.call("record_protected_mail_exposure", exposureArgs("derived-context", 0, key("c"), [ref(derived)]));
    const derivedSeal = await exposure("derived-context", key("c"));
    assert.deepEqual(references(derivedSeal.members), references([ref(derived), ref(sourceA), ref(sourceB)]), "derived_exposure_lost_ancestor_closure");
    console.log("PASS protected_mail_state_derived_bytes_full_ancestry_and_replay");

    stage = "current_ancestor_narrowing_and_irreversible_revocation";
    await narrow(sourceB, 1, [processorP], false, false, owner);
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs("derived-context", String(derivedSeal.id), key("d"))), "protected_mail_source_disclosure_denied");
    await atomicDenied(() => narrow(sourceB, 2, [processorP], true, false, owner), "protected_mail_source_policy_expansion");
    await narrow(sourceA, Number((await policyHead(sourceA)).generation), [], false, true, owner);
    const revokedHead = await policyHead(sourceA);
    const revokedVersion = await policyVersion(sourceA);
    assert.equal(revokedVersion.revoked, true, "owner_revocation_not_recorded");
    assert.equal(revokedVersion.allow_owner_storage, false, "revoked_storage_not_disabled");
    await atomicDenied(() => narrow(sourceA, Number(revokedHead.generation), [], false, false, owner), "protected_mail_source_policy_expansion");
    await atomicDenied(() => narrow(sourceA, Number(revokedHead.generation), [processorP], true, true, owner), "protected_mail_source_policy_expansion");
    const beforeRevokedInitReplay = await state(stateTables);
    await initialize(sourceA, [processorP, processorQ]);
    assert.deepEqual(await state(stateTables), beforeRevokedInitReplay, "initialization_replay_cleared_revocation");
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs(run, String(firstSeal.id), key("e"))), "protected_mail_source_policy_revoked");
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs("derived-context", String(derivedSeal.id), key("e"))), "protected_mail_source_policy_revoked");
    console.log("PASS protected_mail_state_current_ancestor_ceiling_and_irreversible_revoke");

    stage = "terminal_context_and_disconnect";
    const terminalRun = "terminal-context";
    const terminalArgs = exposureArgs(terminalRun, 0, key("f"), [ref(sourceC)]);
    await publisher.transport.call("record_protected_mail_exposure", terminalArgs);
    const terminalSeal = await exposure(terminalRun, key("f"));
    await publisher.transport.call("block_protected_mail_context", [connection.id, runtime, terminalRun]);
    const blocked = await state(stateTables);
    await publisher.transport.call("block_protected_mail_context", [connection.id, runtime, terminalRun]);
    assert.deepEqual(await state(stateTables), blocked, "blocking_replay_mutated_state");
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", terminalArgs), "protected_mail_context_blocked");
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs(terminalRun, 1, key("e"), [ref(sourceC)])), "protected_mail_context_blocked");
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs(terminalRun, String(terminalSeal.id), key("f"))), "protected_mail_context_blocked");
    await publisher.transport.call("block_protected_mail_context", [connection.id, runtime, "blocked-before-first-seal"]);
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs("blocked-before-first-seal", 0, key("e"), [ref(sourceC)])), "protected_mail_context_blocked");
    const beforeDisconnect = await state(privateTables);
    await owner.transport.call("delete_mail_connection", [connection.id]);
    assert.deepEqual(await state(privateTables), beforeDisconnect, "disconnect_erased_source_state");
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", exposureArgs("after-disconnect", 0, key("d"), [ref(sourceC)])), "protected_mail_connection_required");
    await atomicDenied(() => publisher.transport.call("append_protected_mail_derivation", deriveArgs(run, String(fullSeal.id), key("d"))), "protected_mail_connection_required");
    await narrow(sourceC, 1, [processorP], false, true, owner);
    assert.equal((await policyVersion(sourceC)).revoked, true, "disconnected_owner_revocation_failed");
    await publisher.transport.call("block_protected_mail_context", [connection.id, runtime, run]);
    assert.equal((await context(run)).blocked, true, "disconnected_context_block_failed");
    console.log("PASS protected_mail_state_terminal_context_and_retained_disconnect_controls");

    stage = "no_ordinary_or_owner_projection_and_restore_fence";
    assert.deepEqual(await state(mailTables), retainedMail, "source_state_rewrote_s1a_content");
    assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), retainedOwnerRows, "state_added_owner_projection");
    assert.equal(cache(owner.live, "my_protected_mail").count(), 4n, "state_changed_owner_ws_projection");
    for (const table of SNAPSHOT_TABLES_V2) {
      assert.ok(!containsMarker(await publisher.transport.sql(`SELECT * FROM ${table}`)), "ordinary_surface_contains_private_marker");
    }
    const beforeRestore = await state(privateTables);
    await denied(owner.transport.call("import_pear_snapshot_v_1", [JSON.stringify({ format: "pear-snapshot-v1", tables: {} })]), "protected_mail_restore_not_supported");
    await denied(owner.transport.call("import_v_2_begin", [JSON.stringify({ format: "pear-snapshot-v2" })]), "protected_mail_restore_not_supported");
    assert.deepEqual(await state(privateTables), beforeRestore, "ordinary_restore_changed_source_state");
    console.log("PASS protected_mail_state_no_new_projection_or_ordinary_restore");
    stage = "complete";
  } finally {
    if (publisherIdentity) {
      const cleanupTransport = new HttpStdbTransport({ baseUrl: base, dbName: name, token: publisherIdentity.token, fetchImpl: localFetch, timeoutMs: 15000 });
      await drainFixtureConnections(connections, () => cleanupTransport.sql("SELECT * FROM st_client"));
      if (!retainFixtureDatabase) {
        const response = await localFetch(databaseUrl, { method: "DELETE", headers: { Authorization: `Bearer ${publisherIdentity.token}` } });
        assert.ok(response.ok || response.status === 404, "fixture_cleanup_failed");
      }
    }
  }
}

void main().catch(() => {
  console.error(`FAIL protected_mail_state_e2e stage=${stage}`);
  process.exitCode = 1;
});
