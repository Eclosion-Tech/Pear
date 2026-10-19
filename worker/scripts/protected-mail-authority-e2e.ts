/** Disposable staged S2a authority-state test against localhost SpacetimeDB 2.0.3.
 * No mailbox, model, worker, real credentials or production workspace is used.
 * PEAR_AUTHORITY_BASELINE_WASM optionally seeds retained S1c private records
 * before an additive upgrade to PEAR_PROTECTED_MAIL_WASM. The default is fresh.
 * Disk-backed fixtures require PEAR_PROTECTED_MAIL_RETAIN_UNTIL_SERVER_CLEANUP=1;
 * after socket drain their databases are removed with the caller-owned server.
 * PEAR_AUTHORITY_RESTART_PHASE=seed|resume uses an exclusive private checkpoint
 * at PEAR_AUTHORITY_RESTART_STATE_FILE; only the caller restarts the server.
 * Output contains fixed stage codes only, never fixture values or raw errors.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { setGlobalLogLevel } from "spacetimedb";
import { DbConnection, tables } from "../src/module_bindings/index.js";
import { HttpStdbTransport } from "../../web/src/lib/api-endpoint/http-transport.js";
import { buildPearSnapshotV2, SNAPSHOT_TABLES_V2, snapshotExportQueriesV2 } from "../../packages/snapshot-core/src/index.js";
import { decodeOptionSome } from "../../web/src/lib/api-endpoint/codec.js";
import { subscribeToAvailableTables } from "../src/subscriptions.js";
import { drainFixtureConnections, retainFixtureDatabaseUntilServerCleanup } from "./protected-mail-fixture-lifecycle.js";

type Row = Record<string, unknown>;
type IdentityToken = { identity: string; token: string };
type Actor = IdentityToken & { transport: HttpStdbTransport; live: DbConnection };
type ConnectionRow = { id: number; root_page_id: number };
type SourceRow = Row & { id: string; collection_id: number; revision: number; digest: string };
type SourceRef = [string, number, string];
type Processor = [string, string, string, string];
type InstructionScope = [number, number, string, number, string];
type ProcessorConfig = [number, unknown, string, string, string, string];
type Checkpoint = {
  version: 1; base: string; name: string; actors: Record<string, IdentityToken>;
  expected: Record<string, Row[]>; ownerMailView: Row[]; ownerInstructionView: Row[];
  authorityReplay: number; processorReplay: unknown[]; retireReplay: unknown[];
};

const none = { none: [] };
const ident = (hex: string) => [`0x${hex.replace(/^0x/, "")}`];
const marker = `S2A_PRIVATE_SYNTHETIC_${randomBytes(12).toString("hex")}`;
const password = "synthetic-local-fixture-password";
const mailTables = ["protected_mail_collection", "protected_mail_source", "protected_mail_record", "protected_mail_receipt"] as const;
const stateTables = ["protected_mail_source_policy_head", "protected_mail_source_policy_history", "protected_mail_context", "protected_mail_exposure", "protected_mail_derivation"] as const;
const legacyTables = [...mailTables, ...stateTables];
const instructionTables = ["protected_mail_instruction_head", "protected_mail_instruction_revision", "protected_mail_instruction_decision"] as const;
const retainedTables = [...legacyTables, ...instructionTables];
const authorityTables = ["protected_mail_connection_authority_head", "protected_mail_connection_authority_history"] as const;
const processorTables = ["protected_mail_processor_head", "protected_mail_processor_revision", "protected_mail_processor_event"] as const;
const privateTables = [...retainedTables, ...authorityTables, ...processorTables];
const effectsTables = ["mail_connection", "page", "page_content", "component_node", "page_access_rule", "mail_import_receipt", "orcha_job", "orcha_task", "conversation", "conversation_message", "bridge_command", "automation_event_queue"] as const;
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

function hashFields(domain: string, fields: string[]): string {
  const hash = createHash("sha256");
  for (const field of [domain, ...fields]) {
    const bytes = Buffer.from(field, "utf8"), length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

function adapterToken(value: unknown): string {
  const tag = typeof value === "string" ? value : Array.isArray(value) ? value[0]
    : value && typeof value === "object" ? (value as Row).tag ?? Object.keys(value)[0] : undefined;
  if (tag === 0 || typeof tag === "string" && tag.replace(/_/g, "").toLowerCase() === "anthropicmessagesv1") return "anthropic.messages.v1";
  if (tag === 1 || typeof tag === "string" && tag.replace(/_/g, "").toLowerCase() === "openaichatcompletionsv1") return "openai.chat-completions.v1";
  assert.fail("processor_adapter_shape");
}

function configTuple(value: unknown): ProcessorConfig {
  if (Array.isArray(value)) {
    assert.equal(value.length, 6, "processor_config_shape");
    return [Number(value[0]), value[1], String(value[2]), String(value[3]), String(value[4]), String(value[5])];
  }
  assert.ok(value && typeof value === "object", "processor_config_shape");
  const row = value as Row;
  return [Number(row.format_version), row.adapter, String(row.endpoint), String(row.model), String(row.credential_handle), String(row.credential_version)];
}

function configDigest(value: ProcessorConfig): string {
  return hashFields("pear-mail-processor-config-v1", [String(value[0]), adapterToken(value[1]), ...value.slice(2).map(String)]);
}

function instructionScopeOf(value: unknown): InstructionScope {
  if (Array.isArray(value)) {
    assert.equal(value.length, 5, "instruction_scope_shape");
    return [Number(value[0]), Number(value[1]), String(value[2]), Number(value[3]), String(value[4])];
  }
  assert.ok(value && typeof value === "object", "instruction_scope_shape");
  const row = value as Row;
  return [Number(row.format_version), Number(row.scope_version), String(row.purpose), Number(row.collection_id), String(row.instruction_key)];
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

async function main(): Promise<void> {
  const base = localBase(process.argv[2] ?? "http://127.0.0.1:3099");
  assert.ok(process.argv.length <= 3, "unexpected_arguments");
  const retainUntilServerCleanup = retainFixtureDatabaseUntilServerCleanup();
  const restartPhase = process.env.PEAR_AUTHORITY_RESTART_PHASE;
  const checkpointPath = process.env.PEAR_AUTHORITY_RESTART_STATE_FILE;
  assert.ok(restartPhase === undefined || restartPhase === "seed" || restartPhase === "resume", "invalid_restart_phase");
  assert.ok(!restartPhase || checkpointPath, "restart_checkpoint_required");
  assert.ok(restartPhase || !checkpointPath, "restart_phase_required");
  let checkpoint: Checkpoint | undefined;
  if (restartPhase === "resume") {
    stage = "restart_checkpoint_validation";
    const info = await lstat(checkpointPath!);
    assert.ok(info.isFile() && info.size > 0 && info.size <= 4 * 1024 * 1024 && (info.mode & 0o777) === 0o600, "invalid_restart_checkpoint_file");
    const value: unknown = JSON.parse(await readFile(checkpointPath!, "utf8"));
    assert.ok(value && typeof value === "object", "invalid_restart_checkpoint");
    const candidate = value as Checkpoint;
    assert.equal(candidate.version, 1, "invalid_restart_checkpoint_version");
    assert.equal(candidate.base, base, "restart_origin_mismatch");
    assert.ok(typeof candidate.name === "string" && /^pear-protected-authority-e2e-[0-9]+-[0-9a-f]{12}$/.test(candidate.name), "invalid_restart_database");
    assert.ok(candidate.actors && typeof candidate.actors === "object", "invalid_restart_identities");
    for (const name of ["publisher", "owner"]) {
      const account = candidate.actors[name];
      assert.ok(account && typeof account.identity === "string" && /^[0-9a-f]{64}$/i.test(account.identity.replace(/^0x/, ""))
        && typeof account.token === "string" && account.token.length > 0 && account.token.length <= 8192, "invalid_restart_identity");
    }
    assert.ok(candidate.expected && typeof candidate.expected === "object"
      && Object.keys(candidate.expected).length === privateTables.length
      && privateTables.every(table => Array.isArray(candidate.expected[table]) && candidate.expected[table].every(row => row !== null && typeof row === "object" && !Array.isArray(row))), "invalid_restart_expected_state");
    assert.ok(Array.isArray(candidate.ownerMailView) && Array.isArray(candidate.ownerInstructionView)
      && Number.isSafeInteger(candidate.authorityReplay) && candidate.authorityReplay > 0
      && Array.isArray(candidate.processorReplay) && candidate.processorReplay.length === 4
      && Array.isArray(candidate.retireReplay) && candidate.retireReplay.length === 3, "invalid_restart_replay_state");
    checkpoint = candidate;
  }
  setGlobalLogLevel("error");
  const fixedLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("%c")) {
      fixedLog("WARN protected_mail_authority_sdk_diagnostic");
      return;
    }
    fixedLog(...args);
  };
  const name = checkpoint?.name ?? `pear-protected-authority-e2e-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const databaseUrl = `${base}/v1/database/${name}`;
  const processorOnlyName = `${name}-processor-only`;
  const processorOnlyUrl = `${base}/v1/database/${processorOnlyName}`;
  const connections: DbConnection[] = [];
  const connectionsByDatabase = new Map<string, DbConnection[]>();
  let publisherIdentity: IdentityToken | undefined;
  let retainFixture = false;
  let processorOnlyFixture = false;

  const localFetch: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(target.origin, base, "local_origin_required");
    assert.ok(!target.username && !target.password, "userinfo_forbidden");
    assert.ok(target.pathname === "/v1/identity" || [name, processorOnlyName].some(database => target.pathname === `/v1/database/${database}`
      || target.pathname.startsWith(`/v1/database/${database}/`)), "disposable_path_required");
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

  async function connect(value: IdentityToken, databaseName = name): Promise<Actor> {
    const live = await new Promise<DbConnection>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connection_timeout")), 12000);
      const connection = DbConnection.builder().withUri(base).withDatabaseName(databaseName).withToken(value.token)
        .onConnect(connected => { clearTimeout(timer); resolve(connected); })
        .onConnectError(() => { clearTimeout(timer); reject(new Error("connection_failed")); })
        .build();
      connections.push(connection);
      connectionsByDatabase.set(databaseName, [...(connectionsByDatabase.get(databaseName) ?? []), connection]);
    });
    return { ...value, live, transport: new HttpStdbTransport({ baseUrl: base, dbName: databaseName, token: value.token, fetchImpl: localFetch, timeoutMs: 15000 }) };
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

  async function publish(wasm: Uint8Array, upgrade = false, moduleUrl = databaseUrl): Promise<void> {
    assert.ok(publisherIdentity, "publisher_required");
    let suffix = "";
    if (upgrade) {
      const response = await localFetch(`${moduleUrl}/pre_publish`, {
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
    const response = await localFetch(moduleUrl + suffix, {
      method: "PUT", headers: { Authorization: `Bearer ${publisherIdentity.token}` }, body: new Uint8Array(wasm), signal: AbortSignal.timeout(60000),
    });
    assert.ok(response.ok, "module_publish_failed");
  }

  try {
    if (checkpoint) {
      stage = "restart_retained_authority_and_history";
      publisherIdentity = checkpoint.actors.publisher;
      const publisher = await connect(publisherIdentity), owner = await connect(checkpoint.actors.owner);
      async function currentState(): Promise<Record<string, Row[]>> {
        return Object.fromEntries(await Promise.all(privateTables.map(async table => [table, sorted(await publisher.transport.sql<Row>(`SELECT * FROM ${table}`))] as const)));
      }
      assert.deepEqual(await currentState(), checkpoint.expected, "restart_changed_private_state");
      assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), checkpoint.ownerMailView, "restart_changed_owner_mail_history");
      assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions")), checkpoint.ownerInstructionView, "restart_changed_owner_instruction_history");
      await publisher.transport.call("initialize_protected_mail_connection_authority", [checkpoint.authorityReplay]);
      await publisher.transport.call("configure_protected_mail_processor", checkpoint.processorReplay);
      await publisher.transport.call("retire_protected_mail_processor", checkpoint.retireReplay);
      assert.deepEqual(await currentState(), checkpoint.expected, "restart_historical_replay_changed_state");
      console.log("PASS protected_mail_authority_restart_retained_state_and_replays");
      stage = "complete";
      return;
    }
    stage = "publish_fixture";
    const currentWasm = await readFile(process.env.PEAR_PROTECTED_MAIL_WASM
      ?? new URL("../../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm", import.meta.url));
    const baseline = process.env.PEAR_AUTHORITY_BASELINE_WASM;
    const baselineWasm = baseline ? await readFile(baseline) : undefined;
    assert.ok(currentWasm.length > 0 && (!baselineWasm || baselineWasm.length > 0), "module_artifact_required");
    assert.ok(!baselineWasm || !baselineWasm.equals(currentWasm), "distinct_upgrade_artifacts_required");
    publisherIdentity = await identity();
    await publish(baselineWasm ?? currentWasm);
    let publisher = await connect(publisherIdentity);
    let admin = await actor(), owner = await actor(), other = await actor();
    let ai = await actor(), hybrid = await actor(), anonymous = await actor(), service = await actor();
    stage = "fixture_accounts";
    await admin.transport.call("register", ["authority-admin@example.test", "Fixture admin", password]);
    for (const [account, email] of [[owner, "authority-owner@example.test"], [other, "authority-other@example.test"]] as const) {
      await admin.transport.call("create_local_user", [email, "Fixture member", password]);
      await account.transport.call("login", [email, password]);
    }
    for (const account of [ai, hybrid]) {
      await publisher.transport.call("create_ai_user", [ident(account.identity), ident(admin.identity), "Fixture AI", { anthropic: [] }, "synthetic-model", none, none, none, none, none]);
    }
    await hybrid.transport.call("login", ["authority-owner@example.test", password]);
    const key = (digit: string) => digit.repeat(64);
    const keyId = key("a");
    const initialJwk = JSON.stringify({ kty: "RSA", n: "synthetic-descriptor-a", e: "AQAB" });
    const changedJwk = JSON.stringify({ kty: "RSA", n: "synthetic-descriptor-b", e: "AQAB" });
    await publisher.transport.call("publish_mail_encryption_key", [initialJwk, keyId]);
    const credential = (label: string) => JSON.stringify({ v: 1, keyId, key: "synthetic", nonce: "synthetic", ciphertext: label });
    const credentialA = credential("synthetic-a"), credentialB = credential("synthetic-b");

    async function createConnection(account: Actor, protectedStorage = true): Promise<ConnectionRow> {
      await account.transport.call("create_mail_connection", ["Fixture mailbox", "imap.example.test", 993, "fixture@example.test", credentialA, "INBOX", { some: "Sent" }, none, 0]);
      const rows = await account.transport.sql<ConnectionRow>("SELECT id, root_page_id FROM mail_connection");
      const created = rows.sort((a, b) => Number(a.id) - Number(b.id)).at(-1)!;
      assert.ok(created, "connection_missing");
      await account.transport.call("set_mail_connection_enabled", [created.id, false]);
      if (protectedStorage) await publisher.transport.call("create_protected_mail_collection", [created.id]);
      return created;
    }

    async function state(names: readonly string[]): Promise<Record<string, Row[]>> {
      return Object.fromEntries(await Promise.all(names.map(async table => [table, sorted(await publisher.transport.sql<Row>(`SELECT * FROM ${table}`))] as const)));
    }

    const ref = (source: SourceRow): SourceRef => [source.id, Number(source.revision), source.digest];
    async function append(connection: ConnectionRow, event: string, uid: number, label: string): Promise<SourceRow> {
      const message = ["INBOX", "7", uid, { received: [] }, "2026-10-19T12:00:00Z", "sender@example.test", "owner@example.test", "", `${marker}_${label}`,
        `Literal ${marker}_${label}\nNo action is authorized.`, "Synthetic fixture", "fixture-v1"];
      await publisher.transport.call("append_protected_mail_message", [connection.id, event, message]);
      const source = (await publisher.transport.sql<SourceRow>("SELECT * FROM protected_mail_source WHERE collection_id = ?", [connection.id]))
        .find(row => row.id.endsWith(event));
      assert.ok(source, "source_missing");
      return source;
    }

    stage = "seed_retained_s1c_state";
    const connection = await createConnection(owner);
    const retainedConnection = await createConnection(owner);
    const uninitializedConnection = await createConnection(owner);
    const legacyConnection = await createConnection(owner, false);
    const otherConnection = await createConnection(other);
    const sourceA = await append(connection, key("a"), 1, "source_a");
    const sourceB = await append(connection, key("b"), 2, "source_b");
    const historySource = await append(retainedConnection, key("c"), 1, "retained_source");
    const processor: Processor = ["fixture-profile-p", "revision-1", "https://models.example.test/v1/messages", "fixture-model-p"];
    for (const source of [sourceA, sourceB, historySource]) {
      await publisher.transport.call("initialize_protected_mail_source_policy", [ref(source), [processor]]);
    }
    async function derivation(collection: ConnectionRow, run: string, sources: SourceRow[], event: string): Promise<SourceRow> {
      await publisher.transport.call("record_protected_mail_exposure", [collection.id, "authority-fixture-runtime", run, 0, event, sources.map(ref), []]);
      const seal = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_exposure"))
        .find(row => row.run_id === run && Number(row.collection_id) === Number(collection.id));
      assert.ok(seal && typeof seal.id === "string", "seed_seal_missing");
      await publisher.transport.call("append_protected_mail_derivation", [collection.id, "authority-fixture-runtime", run, seal.id, event, `${marker}_derived_${run}`, "fixture-derived-v1"]);
      const derived = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_derivation"))
        .find(row => row.event_key === event && Number(row.collection_id) === Number(collection.id));
      assert.ok(derived && typeof derived.source_id === "string" && typeof derived.digest === "string", "seed_derivation_missing");
      return { ...derived, id: derived.source_id, collection_id: Number(derived.collection_id), revision: Number(derived.revision), digest: derived.digest } as SourceRow;
    }
    const derived = await derivation(connection, "retained-ab", [sourceA, sourceB], key("1"));
    const retainedDerived = await derivation(retainedConnection, "retained-disconnected", [historySource], key("2"));

    async function instructionReference(collectionId: number, instructionKey: string): Promise<SourceRef> {
      const row = (await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions"))
        .find(value => {
          const scope = instructionScopeOf(value.scope);
          return scope[3] === Number(collectionId) && scope[4] === instructionKey;
        });
      assert.ok(row, "retained_instruction_review_missing");
      return sourceReference(row.reference);
    }
    const instructionScope: InstructionScope = [1, 1, "mail.summary", connection.id, "retained-instruction"];
    await publisher.transport.call("draft_protected_mail_instruction_from_derivation", [instructionScope, 0, key("3"), ref(derived)]);
    const firstInstruction = await instructionReference(connection.id, "retained-instruction");
    await owner.transport.call("approve_protected_mail_instruction", [instructionScope, 1, key("4"), firstInstruction]);
    await owner.transport.call("revoke_protected_mail_instruction", [instructionScope, 2, key("5"), firstInstruction]);
    await owner.transport.call("draft_protected_mail_instruction", [instructionScope, 3, key("6"), `${marker}_retained_exact_owner_edit\r\n`]);
    const currentInstruction = await instructionReference(connection.id, "retained-instruction");
    await owner.transport.call("approve_protected_mail_instruction", [instructionScope, 4, key("7"), currentInstruction]);
    const historyScope: InstructionScope = [1, 1, "mail.summary", retainedConnection.id, "retained-deleted-instruction"];
    await publisher.transport.call("draft_protected_mail_instruction_from_derivation", [historyScope, 0, key("8"), ref(retainedDerived)]);
    await owner.transport.call("approve_protected_mail_instruction", [historyScope, 1, key("9"), await instructionReference(retainedConnection.id, "retained-deleted-instruction")]);
    await owner.transport.call("delete_mail_connection", [retainedConnection.id]);
    const retainedState = await state(retainedTables);
    const retainedMailView = sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail"));
    const retainedInstructionView = sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions"));
    assert.equal(retainedInstructionView.length, 2, "instruction_history_fixture_missing");
    const legacyBefore = await owner.transport.sql<Row>("SELECT * FROM mail_connection WHERE id = ?", [legacyConnection.id]);
    const uninitializedBefore = await owner.transport.sql<Row>("SELECT * FROM mail_connection WHERE id = ?", [uninitializedConnection.id]);

    if (baseline) {
      stage = "additive_upgrade_retained_s1c_state";
      for (const live of connections) live.disconnect();
      await publish(currentWasm, true);
      [publisher, admin, owner, other, ai, hybrid, anonymous, service] = await Promise.all(
        [publisher, admin, owner, other, ai, hybrid, anonymous, service].map(account => connect(account)),
      );
      assert.deepEqual(await state(retainedTables), retainedState, "upgrade_changed_existing_private_state");
      assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), retainedMailView, "upgrade_changed_owner_mail_history");
      assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions")), retainedInstructionView, "upgrade_changed_owner_instruction_history");
      assert.deepEqual(await owner.transport.sql<Row>("SELECT * FROM mail_connection WHERE id = ?", [legacyConnection.id]), legacyBefore, "upgrade_changed_legacy_connection");
      assert.deepEqual(await owner.transport.sql<Row>("SELECT * FROM mail_connection WHERE id = ?", [uninitializedConnection.id]), uninitializedBefore, "upgrade_changed_uninitialized_connection");
      console.log("PASS protected_mail_authority_retained_s1c_upgrade");
    }

    stage = "no_automatic_authority_or_processor_backfill";
    for (const rows of Object.values(await state([...authorityTables, ...processorTables]))) assert.equal(rows.length, 0, "automatic_authority_or_processor_backfill");
    console.log("PASS protected_mail_authority_no_automatic_backfill");

    stage = "isolated_processor_only_restore_mutual_exclusion";
    processorOnlyFixture = true;
    await publish(currentWasm, false, processorOnlyUrl);
    const processorOnlyPublisher = await connect(publisherIdentity, processorOnlyName);
    const processorOnlyOwner = await connect(owner, processorOnlyName);
    stage = "processor_only_empty_restore";
    await processorOnlyOwner.transport.call("register", ["authority-preflight@example.test", "Fixture preflight owner", password]);
    assert.equal((await processorOnlyPublisher.transport.sql("SELECT * FROM page")).length, 0, "processor_only_preflight_has_pages");
    assert.equal((await processorOnlyPublisher.transport.sql("SELECT * FROM protected_mail_collection")).length, 0, "processor_only_preflight_has_collections");
    await processorOnlyOwner.transport.call("import_pear_snapshot_v_1", [JSON.stringify({ format: "pear-snapshot-v1", tables: {} })]);
    await processorOnlyOwner.transport.call("import_v_2_begin", [JSON.stringify({ format: "pear-snapshot-v2" })]);
    // SATS JSON's numeric sum tags match the closed adapter declaration order.
    const preflightConfig: ProcessorConfig = [1, [0, []], "https://models.example.test/v1/messages", "fixture-preflight-model", "fixture-preflight-credential", "version-1"];
    const preflightArgs = ["fixture-preflight-profile", 0, key("a"), preflightConfig];
    stage = "processor_only_active_import_blocks_configure";
    await denied(processorOnlyPublisher.transport.call("configure_protected_mail_processor", preflightArgs), "protected_mail_restore_not_supported");
    for (const table of processorTables) assert.equal((await processorOnlyPublisher.transport.sql(`SELECT * FROM ${table}`)).length, 0, "active_restore_partially_created_processor");
    stage = "processor_only_abort_then_configure";
    await processorOnlyOwner.transport.call("import_v_2_abort", []);
    await processorOnlyPublisher.transport.call("configure_protected_mail_processor", preflightArgs);
    async function preflightProcessorState(): Promise<Record<string, Row[]>> {
      return Object.fromEntries(await Promise.all(processorTables.map(async table => [table, sorted(await processorOnlyPublisher.transport.sql<Row>(`SELECT * FROM ${table}`))] as const)));
    }
    for (const retired of [false, true]) {
      stage = retired ? "processor_only_retired_restore_fenced" : "processor_only_live_restore_fenced";
      if (retired) await processorOnlyPublisher.transport.call("retire_protected_mail_processor", ["fixture-preflight-profile", 1, key("b")]);
      const before = await preflightProcessorState();
      await denied(processorOnlyOwner.transport.call("import_pear_snapshot_v_1", [JSON.stringify({ format: "pear-snapshot-v1", tables: {} })]), "protected_mail_restore_not_supported");
      await denied(processorOnlyOwner.transport.call("import_v_2_begin", [JSON.stringify({ format: "pear-snapshot-v2" })]), "protected_mail_restore_not_supported");
      assert.deepEqual(await preflightProcessorState(), before, "ordinary_restore_changed_processor_only_history");
      assert.equal((await processorOnlyPublisher.transport.sql("SELECT * FROM protected_mail_collection")).length, 0, "processor_restore_fence_depended_on_collection");
    }
    console.log("PASS protected_mail_authority_processor_only_restore_and_active_import_fences");

    async function atomicDenied(action: () => Promise<unknown>, code?: string): Promise<void> {
      const names = [...privateTables, "mail_connection", "mail_connection_secret", "mail_encryption_key"];
      const before = await state(names);
      await denied(action(), code);
      assert.deepEqual(await state(names), before, "rejected_authority_write_not_atomic");
    }

    stage = "new_private_table_identity_boundary";
    const ordinary = [owner, other, admin, ai, hybrid, anonymous, service];
    const generatedNames = Object.values(tables).map(table => (table as { sourceName: string }).sourceName);
    for (const table of [...authorityTables, ...processorTables]) {
      assert.ok(!generatedNames.includes(table), "private_authority_has_public_binding");
      for (const account of ordinary) {
        await denied(account.transport.sql(`SELECT * FROM ${table}`));
        await privateSubscriptionDenied(account, table);
      }
    }
    console.log("PASS protected_mail_authority_private_http_and_individual_ws_boundaries");

    const noRuntimeState = await state([...retainedTables, ...effectsTables.filter(table => table !== "mail_connection")]);
    const initAuthority = (id: number, account = publisher) => account.transport.call("initialize_protected_mail_connection_authority", [id]);
    async function authority(id: number): Promise<Row> {
      const rows = await publisher.transport.sql<Row>("SELECT * FROM protected_mail_connection_authority_head WHERE connection_id = ?", [id]);
      assert.equal(rows.length, 1, "authority_head_missing_or_duplicated");
      return rows[0];
    }
    async function assertCurrentSnapshot(id: number): Promise<void> {
      const current = await authority(id);
      const connection = (await publisher.transport.sql<Row>("SELECT * FROM mail_connection WHERE id = ?", [id]))[0];
      const collection = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_collection WHERE id = ?", [id]))[0];
      const secret = (await publisher.transport.sql<Row>("SELECT * FROM mail_connection_secret WHERE connection_id = ?", [id]))[0];
      const encryptionKey = (await publisher.transport.sql<Row>("SELECT * FROM mail_encryption_key"))[0];
      assert.ok(connection && collection && secret && encryptionKey, "authority_snapshot_association_missing");
      const sent = decodeOptionSome(connection.sent_folder);
      const fields = [String(connection.id), String(collection.id), String(connection.owner).replace(/^0x/, ""),
        String(collection.owner).replace(/^0x/, ""), String(connection.host), String(connection.port), String(connection.username),
        String(connection.inbox_folder), sent === undefined ? "none" : "some", ...(sent === undefined ? [] : [String(sent)]),
        String(connection.backfill), String(connection.enabled), String(secret.encrypted_password), String(encryptionKey.id),
        String(encryptionKey.key_id), String(encryptionKey.public_key_jwk)];
      assert.equal(current.snapshot_digest, hashFields("pear-protected-mail-connection-snapshot-v1", fields), "authority_digest_not_bound_to_exact_current_snapshot");
    }
    async function assertAuthorityStep(id: number, previous: Row, tombstoned = false, sameDigest = false): Promise<Row> {
      const current = await authority(id);
      assert.equal(Number(current.epoch), Number(previous.epoch) + 1, "authority_epoch_not_monotonic_step");
      assert.equal(current.tombstoned, tombstoned, "authority_tombstone_mismatch");
      assert.equal(current.collection_id, previous.collection_id, "authority_collection_binding_changed");
      assert.deepEqual(current.owner, previous.owner, "authority_owner_binding_changed");
      assert.ok(typeof current.snapshot_digest === "string" && /^[0-9a-f]{64}$/.test(current.snapshot_digest), "authority_digest_invalid");
      if (sameDigest) assert.equal(current.snapshot_digest, previous.snapshot_digest, "identical_snapshot_digest_changed");
      const history = await publisher.transport.sql<Row>("SELECT * FROM protected_mail_connection_authority_history WHERE connection_id = ?", [id]);
      assert.equal(history.length, Number(current.epoch), "authority_history_not_append_only");
      const latest = history.find(row => Number(row.epoch) === Number(current.epoch));
      assert.ok(latest, "authority_history_latest_missing");
      for (const field of ["connection_id", "collection_id", "owner", "epoch", "snapshot_digest", "tombstoned"])
        assert.deepEqual(latest[field], current[field], "authority_history_head_mismatch");
      assert.ok(history.every(row => ["initialized", "paused", "credential_changed", "encryption_key_changed", "deleted"].includes(String(row.reason))), "authority_history_reason_not_fixed_code");
      for (const row of history) assert.equal(row.id, `mail-connection-authority-history:${hashFields("pear-protected-mail-connection-authority-history-v1",
        [String(row.connection_id), String(row.collection_id), String(row.owner).replace(/^0x/, ""), String(row.epoch)])}`, "authority_history_id_not_bound_to_scope_and_epoch");
      if (!tombstoned) await assertCurrentSnapshot(id);
      return current;
    }
    stage = "publisher_only_explicit_connection_authority";
    for (const account of ordinary) {
      const errors = [];
      for (const id of [connection.id, 0]) errors.push(await denied(initAuthority(id, account), "protected_mail_publisher_required"));
      assert.equal(new Set(errors).size, 1, "authority_management_denial_reveals_metadata");
    }
    await atomicDenied(() => initAuthority(legacyConnection.id));
    await atomicDenied(() => initAuthority(retainedConnection.id));
    await initAuthority(connection.id);
    await other.transport.call("logout", []);
    await atomicDenied(() => initAuthority(otherConnection.id), "protected_mail_connection_authority_owner_unavailable");
    await other.transport.call("login", ["authority-other@example.test", password]);
    await initAuthority(otherConnection.id);
    let head = await authority(connection.id);
    let otherHead = await authority(otherConnection.id);
    assert.equal(Number(head.epoch), 1, "authority_initial_epoch");
    assert.equal(head.collection_id, connection.id, "authority_initial_collection");
    assert.equal(String(head.owner).replace(/^0x/, ""), owner.identity.replace(/^0x/, ""), "authority_initial_owner");
    assert.equal(head.tombstoned, false, "authority_initial_tombstone");
    await assertCurrentSnapshot(connection.id);
    await assertCurrentSnapshot(otherConnection.id);
    const initialized = await state(authorityTables);
    await initAuthority(connection.id);
    assert.deepEqual(await state(authorityTables), initialized, "authority_initialization_retry_changed_history");
    console.log("PASS protected_mail_authority_explicit_publisher_init_and_no_owner_override");

    stage = "authority_failed_mutations_are_atomic";
    for (const account of [other, admin, ai, hybrid, anonymous, service, publisher]) {
      await atomicDenied(() => account.transport.call("set_mail_connection_enabled", [connection.id, false]));
      await atomicDenied(() => account.transport.call("update_mail_connection_password", [connection.id, credentialB]));
      await atomicDenied(() => account.transport.call("delete_mail_connection", [connection.id]));
    }
    await atomicDenied(() => owner.transport.call("set_mail_connection_enabled", [connection.id, true]));
    await atomicDenied(() => owner.transport.call("update_mail_connection_password", [connection.id, "malformed-credential"]));
    await atomicDenied(() => publisher.transport.call("publish_mail_encryption_key", [changedJwk, key("b")]));
    console.log("PASS protected_mail_authority_rejected_lifecycle_mutations_atomic");

    stage = "password_aba_identical_updates_and_repeated_pause";
    const originalSnapshotDigest = head.snapshot_digest;
    await owner.transport.call("update_mail_connection_password", [connection.id, credentialB]);
    head = await assertAuthorityStep(connection.id, head);
    assert.notEqual(head.snapshot_digest, originalSnapshotDigest, "password_change_not_bound_to_snapshot");
    await owner.transport.call("update_mail_connection_password", [connection.id, credentialA]);
    head = await assertAuthorityStep(connection.id, head);
    assert.equal(head.snapshot_digest, originalSnapshotDigest, "password_aba_snapshot_not_exact");
    await owner.transport.call("update_mail_connection_password", [connection.id, credentialA]);
    head = await assertAuthorityStep(connection.id, head, false, true);
    for (let repeat = 0; repeat < 2; repeat++) {
      await owner.transport.call("set_mail_connection_enabled", [connection.id, false]);
      head = await assertAuthorityStep(connection.id, head, false, true);
    }
    const beforeLateInit = await state(authorityTables);
    await initAuthority(connection.id);
    assert.deepEqual(await state(authorityTables), beforeLateInit, "authority_retry_reset_later_epochs");
    console.log("PASS protected_mail_authority_password_aba_identical_update_and_pause_epochs");

    stage = "public_key_descriptor_aba_invalidates_live_authorities";
    const beforeIdenticalKey = await state(authorityTables);
    await publisher.transport.call("publish_mail_encryption_key", [initialJwk, keyId]);
    assert.deepEqual(await state(authorityTables), beforeIdenticalKey, "identical_key_descriptor_bumped_authority");
    const beforeKeyDigest = head.snapshot_digest;
    await publisher.transport.call("publish_mail_encryption_key", [changedJwk, keyId]);
    head = await assertAuthorityStep(connection.id, head);
    otherHead = await assertAuthorityStep(otherConnection.id, otherHead);
    assert.notEqual(head.snapshot_digest, beforeKeyDigest, "same_key_id_descriptor_change_not_bound");
    await publisher.transport.call("publish_mail_encryption_key", [initialJwk, keyId]);
    head = await assertAuthorityStep(connection.id, head);
    otherHead = await assertAuthorityStep(otherConnection.id, otherHead);
    assert.equal(head.snapshot_digest, beforeKeyDigest, "key_descriptor_aba_snapshot_not_exact");
    const beforeIdenticalKeyAgain = await state(authorityTables);
    await publisher.transport.call("publish_mail_encryption_key", [initialJwk, keyId]);
    assert.deepEqual(await state(authorityTables), beforeIdenticalKeyAgain, "identical_key_retry_changed_epochs");
    console.log("PASS protected_mail_authority_same_key_id_descriptor_aba_and_exact_retry");

    stage = "delete_is_terminal_and_legacy_connections_remain_unenrolled";
    await owner.transport.call("delete_mail_connection", [connection.id]);
    head = await assertAuthorityStep(connection.id, head, true);
    const deletedAuthority = await state(authorityTables);
    await initAuthority(connection.id);
    assert.deepEqual(await state(authorityTables), deletedAuthority, "deleted_authority_reenrolled_or_rewound");
    await atomicDenied(() => owner.transport.call("update_mail_connection_password", [connection.id, credentialA]));
    await atomicDenied(() => owner.transport.call("set_mail_connection_enabled", [connection.id, false]));
    await atomicDenied(() => owner.transport.call("delete_mail_connection", [connection.id]));
    await publisher.transport.call("publish_mail_encryption_key", [changedJwk, keyId]);
    assert.deepEqual(await authority(connection.id), head, "key_rotation_changed_tombstone");
    otherHead = await assertAuthorityStep(otherConnection.id, otherHead);
    for (const id of [legacyConnection.id, uninitializedConnection.id]) {
      await owner.transport.call("set_mail_connection_enabled", [id, false]);
      await owner.transport.call("update_mail_connection_password", [id, credentialA]);
      assert.equal((await publisher.transport.sql("SELECT * FROM protected_mail_connection_authority_head WHERE connection_id = ?", [id])).length, 0, "legacy_lifecycle_auto_enrolled_authority");
    }
    console.log("PASS protected_mail_authority_terminal_tombstone_and_no_legacy_auto_enrollment");

    stage = "publisher_only_exact_processor_configuration";
    const profileId = "authority-fixture-profile";
    const adapter = [0, []];
    const configA: ProcessorConfig = [1, adapter, "https://models.example.test/v1/messages", `${marker}_model`, `${marker}_credential`, "version-a"];
    const configB: ProcessorConfig = [...configA]; configB[5] = "version-b";
    const configOther: ProcessorConfig = [1, [1, []], "https://models.example.test/v1/chat/completions", `${marker}_other_model`, `${marker}_credential`, "version-a"];
    const configure = (generation: number, event: string, config: ProcessorConfig, account = publisher, profile = profileId) =>
      account.transport.call("configure_protected_mail_processor", [profile, generation, event, config]);
    const retire = (generation: number, event: string, account = publisher, profile = profileId) =>
      account.transport.call("retire_protected_mail_processor", [profile, generation, event]);
    const initialConfigArgs = [profileId, 0, key("a"), configA];
    await publisher.transport.call("configure_protected_mail_processor", initialConfigArgs);
    for (const account of ordinary) {
      const configErrors = [], retireErrors = [];
      for (const profile of [profileId, "missing-profile", "invalid/profile"]) {
        configErrors.push(await denied(configure(0, key("a"), configA, account, profile), "protected_mail_publisher_required"));
        retireErrors.push(await denied(retire(0, key("b"), account, profile), "protected_mail_publisher_required"));
      }
      assert.equal(new Set(configErrors).size, 1, "processor_config_denial_reveals_metadata");
      assert.equal(new Set(retireErrors).size, 1, "processor_retire_denial_reveals_metadata");
    }
    async function processorHead(): Promise<Row> {
      const rows = await publisher.transport.sql<Row>("SELECT * FROM protected_mail_processor_head WHERE profile_id = ?", [profileId]);
      assert.equal(rows.length, 1, "processor_head_missing_or_duplicated");
      return rows[0];
    }
    async function processorRevision(current: Row, expectedConfig?: ProcessorConfig): Promise<Row> {
      const rows = await publisher.transport.sql<Row>("SELECT * FROM protected_mail_processor_revision WHERE id = ?", [current.current_revision_id]);
      assert.equal(rows.length, 1, "processor_revision_missing_or_duplicated");
      const revision = rows[0];
      assert.equal(revision.profile_id, profileId, "processor_revision_profile_mismatch");
      assert.equal(Number(revision.generation), Number(current.generation), "processor_revision_generation_mismatch");
      assert.ok(typeof revision.id === "string" && /^mail-processor-revision:[0-9a-f]{64}$/.test(revision.id), "processor_revision_id_invalid");
      assert.ok(typeof revision.digest === "string" && /^[0-9a-f]{64}$/.test(revision.digest), "processor_digest_invalid");
      const config = configTuple(revision.config);
      assert.equal(revision.digest, configDigest(config), "processor_digest_not_bound_to_exact_config");
      assert.equal(revision.id, `mail-processor-revision:${hashFields("pear-mail-processor-revision-v1", [profileId, String(revision.generation), String(revision.digest)])}`, "processor_revision_id_not_bound_to_generation_and_digest");
      if (expectedConfig) assert.deepEqual([config[0], adapterToken(config[1]), ...config.slice(2)], [expectedConfig[0], adapterToken(expectedConfig[1]), ...expectedConfig.slice(2)], "processor_stored_config_not_exact");
      const event = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_processor_event WHERE id = ?", [revision.event_id]))[0];
      assert.ok(event, "processor_revision_event_missing");
      assert.equal(event.revision_id, revision.id, "processor_revision_event_association_mismatch");
      assert.equal(event.generation, revision.generation, "processor_revision_event_generation_mismatch");
      assert.deepEqual(event.actor, revision.created_by, "processor_revision_event_actor_mismatch");
      assert.equal(String(revision.created_by).replace(/^0x/, ""), publisher.identity.replace(/^0x/, ""), "processor_revision_not_publisher_authored");
      assert.equal(event.id, `mail-processor-event:${hashFields("pear-mail-processor-event-v1", [profileId, String(event.event_key)])}`, "processor_event_id_not_bound_to_profile_and_event");
      return revision;
    }
    let processorCurrent = await processorHead();
    let revisionCurrent = await processorRevision(processorCurrent, configA);
    assert.equal(Number(processorCurrent.generation), 1, "processor_initial_generation");
    assert.equal(Number(revisionCurrent.generation), 1, "processor_initial_revision_generation");
    assert.equal(processorCurrent.retired, false, "processor_initial_retired");
    const initialProcessorState = await state(processorTables);
    await publisher.transport.call("configure_protected_mail_processor", initialConfigArgs);
    assert.deepEqual(await state(processorTables), initialProcessorState, "processor_configuration_retry_changed_state");
    await atomicDenied(() => configure(0, key("a"), configB), "protected_mail_processor_event_conflict");
    await atomicDenied(() => retire(0, key("a")), "protected_mail_processor_event_conflict");
    console.log("PASS protected_mail_authority_publisher_only_processor_config_and_replay");

    stage = "processor_config_validation_and_failed_cas_are_atomic";
    for (const invalidProfile of ["", "bad/profile", "é", "x".repeat(129)])
      await atomicDenied(() => configure(1, key("b"), configA, publisher, invalidProfile), "protected_mail_processor_invalid_profile");
    for (const invalidEvent of ["", "a".repeat(63), "G".repeat(64), "a".repeat(65)])
      await atomicDenied(() => configure(1, invalidEvent, configA), "protected_mail_processor_invalid_event");
    const invalidConfigs: ProcessorConfig[] = [
      [0, ...configA.slice(1)] as ProcessorConfig,
      ...["http://models.example.test/v1/messages", "https://user:pass@models.example.test/v1/messages", "https://models.example.test/v1/messages?query=private", "https://models.example.test/v1/messages#fragment", "https://MODELS.example.test/v1/messages", "https://models.example.test:443/v1/messages", `https://models.example.test/${"x".repeat(2048)}`].map(endpoint => [1, adapter, endpoint, configA[3], configA[4], configA[5]] as ProcessorConfig),
      ...["", " leading-space", "trailing-space ", "control\u0001model", "é".repeat(129)].map(model => [1, adapter, configA[2], model, configA[4], configA[5]] as ProcessorConfig),
      ...["", "invalid/handle", "handle with spaces", "é", "x".repeat(129)].map(handle => [1, adapter, configA[2], configA[3], handle, configA[5]] as ProcessorConfig),
      ...["", "invalid/version", "version\n", "x".repeat(129)].map(version => [1, adapter, configA[2], configA[3], configA[4], version] as ProcessorConfig),
    ];
    for (const invalidConfig of invalidConfigs) await atomicDenied(() => configure(1, key("b"), invalidConfig), "protected_mail_processor_invalid_config");
    await atomicDenied(() => configure(1, key("b"), [1, { unknown_adapter: [] }, ...configA.slice(2)] as ProcessorConfig));
    await atomicDenied(() => publisher.transport.call("configure_protected_mail_processor", [profileId, 1, key("b"), [...configA, "unsupported-extra-field"]]));
    await atomicDenied(() => configure(0, key("b"), configA), "protected_mail_processor_stale");
    await atomicDenied(() => retire(0, key("b")), "protected_mail_processor_stale");
    await atomicDenied(() => retire(0, key("b"), publisher, "missing-profile"), "protected_mail_processor_required");
    console.log("PASS protected_mail_authority_processor_typed_validation_and_atomic_denials");

    stage = "processor_credential_version_aba_and_identical_configuration";
    const firstRevision = revisionCurrent;
    await configure(1, key("b"), configB);
    processorCurrent = await processorHead(); revisionCurrent = await processorRevision(processorCurrent, configB);
    assert.equal(Number(processorCurrent.generation), 2, "processor_credential_change_generation");
    assert.notEqual(revisionCurrent.digest, firstRevision.digest, "credential_version_not_bound_to_digest");
    const versionBRevision = revisionCurrent;
    await configure(2, key("c"), configA);
    processorCurrent = await processorHead(); revisionCurrent = await processorRevision(processorCurrent, configA);
    assert.equal(Number(processorCurrent.generation), 3, "processor_aba_generation");
    assert.equal(revisionCurrent.digest, firstRevision.digest, "processor_aba_digest_not_exact");
    assert.notEqual(revisionCurrent.id, firstRevision.id, "processor_aba_reused_revision");
    assert.notEqual(revisionCurrent.id, versionBRevision.id, "processor_aba_reused_intermediate_revision");
    const beforeIdenticalRevision = revisionCurrent;
    await configure(3, key("d"), configA);
    processorCurrent = await processorHead(); revisionCurrent = await processorRevision(processorCurrent, configA);
    assert.equal(Number(processorCurrent.generation), 4, "identical_processor_config_did_not_advance_generation");
    assert.equal(revisionCurrent.digest, beforeIdenticalRevision.digest, "identical_processor_config_digest_changed");
    assert.notEqual(revisionCurrent.id, beforeIdenticalRevision.id, "identical_processor_config_reused_revision");
    await configure(4, key("e"), configOther);
    processorCurrent = await processorHead(); revisionCurrent = await processorRevision(processorCurrent, configOther);
    assert.equal(Number(processorCurrent.generation), 5, "processor_adapter_change_generation");
    assert.notEqual(revisionCurrent.digest, firstRevision.digest, "processor_adapter_endpoint_model_not_bound");
    const beforeOldConfigure = await state(processorTables);
    await publisher.transport.call("configure_protected_mail_processor", initialConfigArgs);
    assert.deepEqual(await state(processorTables), beforeOldConfigure, "processor_historical_replay_rewound_head");
    console.log("PASS protected_mail_authority_processor_credential_aba_and_new_immutable_revisions");

    stage = "processor_concurrent_configuration_cas";
    const raceResults = await Promise.allSettled([configure(5, key("f"), configA), configure(5, key("1"), configB)]);
    assert.equal(raceResults.filter(result => result.status === "fulfilled").length, 1, "processor_concurrent_cas_multiple_or_no_winners");
    const raceLoser = raceResults.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(raceLoser.reason instanceof Error && raceLoser.reason.message.includes("protected_mail_processor_stale")
      && !containsMarker(raceLoser.reason.message), "processor_concurrent_cas_loser_not_stale");
    processorCurrent = await processorHead(); revisionCurrent = await processorRevision(processorCurrent);
    assert.equal(Number(processorCurrent.generation), 6, "processor_concurrent_cas_advanced_twice");
    const winnerDigest = raceResults[0].status === "fulfilled" ? firstRevision.digest : versionBRevision.digest;
    assert.equal(revisionCurrent.digest, winnerDigest, "processor_concurrent_winner_configuration_mismatch");
    assert.equal((await publisher.transport.sql("SELECT * FROM protected_mail_processor_revision WHERE profile_id = ?", [profileId])).length, 6, "processor_concurrent_revision_count");
    assert.equal((await publisher.transport.sql("SELECT * FROM protected_mail_processor_event WHERE profile_id = ?", [profileId])).length, 6, "processor_concurrent_event_count");
    console.log("PASS protected_mail_authority_processor_concurrent_cas_one_winner");

    stage = "processor_terminal_retirement_and_old_event_replay";
    const retiredRevisionId = processorCurrent.current_revision_id;
    const retireArgs = [profileId, 6, key("2")];
    await publisher.transport.call("retire_protected_mail_processor", retireArgs);
    processorCurrent = await processorHead();
    assert.equal(Number(processorCurrent.generation), 7, "processor_retire_generation");
    assert.equal(processorCurrent.retired, true, "processor_retire_not_terminal");
    assert.equal(processorCurrent.current_revision_id, retiredRevisionId, "processor_retire_changed_exact_revision");
    const terminalProcessorState = await state(processorTables);
    await publisher.transport.call("configure_protected_mail_processor", initialConfigArgs);
    await publisher.transport.call("retire_protected_mail_processor", retireArgs);
    assert.deepEqual(await state(processorTables), terminalProcessorState, "old_processor_replay_reactivated_or_rewound_head");
    await atomicDenied(() => configure(7, key("3"), configA), "protected_mail_processor_retired");
    await atomicDenied(() => retire(7, key("4")), "protected_mail_processor_retired");
    await atomicDenied(() => configure(6, key("2"), configA), "protected_mail_processor_event_conflict");
    assert.equal((await publisher.transport.sql("SELECT * FROM protected_mail_processor_revision WHERE profile_id = ?", [profileId])).length, 6, "processor_retire_created_revision");
    assert.equal((await publisher.transport.sql("SELECT * FROM protected_mail_processor_event WHERE profile_id = ?", [profileId])).length, 7, "processor_retire_event_history_count");
    console.log("PASS protected_mail_authority_processor_terminal_retirement_and_inert_replays");

    stage = "no_ordinary_projection_export_or_processing_effect";
    assert.deepEqual(await state([...retainedTables, ...effectsTables.filter(table => table !== "mail_connection")]), noRuntimeState, "authority_state_changed_grants_sources_approvals_or_runtime");
    assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), retainedMailView, "authority_changed_owner_mail_history");
    assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions")), retainedInstructionView, "authority_changed_owner_instruction_history");
    for (const table of [...authorityTables, ...processorTables]) {
      for (const account of ordinary) {
        await denied(account.transport.sql(`SELECT * FROM ${table}`));
        await privateSubscriptionDenied(account, table);
      }
    }
    const queryBatches: string[][] = [];
    const builder = { onApplied: (_callback: () => void) => builder, onError: (_callback: (_context: unknown, error: unknown) => void) => builder,
      subscribe: (queries: string[]) => { queryBatches.push(queries); } };
    subscribeToAvailableTables({ subscriptionBuilder: () => builder }, "[authority-fixture]", () => {});
    const broadQueries = queryBatches.flat();
    const exportQueries = snapshotExportQueriesV2();
    for (const table of [...authorityTables, ...processorTables]) {
      assert.ok(!SNAPSHOT_TABLES_V2.includes(table as typeof SNAPSHOT_TABLES_V2[number]), "private_authority_exportable");
      assert.ok(!exportQueries.some(query => query.includes(table)), "export_hydrated_private_authority");
      assert.ok(!broadQueries.some(query => query.includes(table)), "worker_auto_subscribed_private_authority");
    }
    await subscribe(owner, exportQueries);
    const snapshot = buildPearSnapshotV2(owner.live.db, { wsUri: base, dbName: name, tablesRegistry: tables });
    assert.ok(!containsMarker(snapshot), "ordinary_snapshot_contains_authority_fixture");
    for (const table of SNAPSHOT_TABLES_V2) assert.ok(!containsMarker(await publisher.transport.sql(`SELECT * FROM ${table}`)), "ordinary_surface_contains_authority_fixture");
    console.log("PASS protected_mail_authority_no_runtime_grant_projection_or_export_effect");

    if (restartPhase === "seed") {
      stage = "restart_checkpoint_write";
      const identityOnly = (account: Actor): IdentityToken => ({ identity: account.identity, token: account.token });
      const checkpointToWrite: Checkpoint = {
        version: 1, base, name,
        actors: Object.fromEntries(Object.entries({ publisher, owner }).map(([key, account]) => [key, identityOnly(account)])),
        expected: await state(privateTables), ownerMailView: retainedMailView, ownerInstructionView: retainedInstructionView,
        authorityReplay: connection.id, processorReplay: initialConfigArgs, retireReplay: retireArgs,
      };
      const handle = await open(checkpointPath!, "wx", 0o600);
      let written = false;
      try { await handle.writeFile(JSON.stringify(checkpointToWrite)); await handle.sync(); written = true; }
      finally {
        await handle.close();
        if (!written) await unlink(checkpointPath!);
      }
      retainFixture = true;
      console.log("PASS protected_mail_authority_restart_checkpoint_written");
    }

    stage = "complete";
  } finally {
    const cleanup: Promise<unknown>[] = [];
    if (publisherIdentity) {
      const token = publisherIdentity.token;
      const drained = await Promise.allSettled([...connectionsByDatabase].map(async ([databaseName, databaseConnections]) => {
        const transport = new HttpStdbTransport({ baseUrl: base, dbName: databaseName, token, fetchImpl: localFetch, timeoutMs: 15000 });
        await drainFixtureConnections(databaseConnections, () => transport.sql("SELECT * FROM st_client"));
      }));
      const drainedOk = drained.every(result => result.status === "fulfilled");
      cleanup.push(Promise.resolve().then(() => assert.ok(drainedOk, "fixture_drain_failed")));
      for (const url of [...(drainedOk && !retainFixture && !retainUntilServerCleanup ? [databaseUrl] : []), ...(drainedOk && processorOnlyFixture && !retainUntilServerCleanup ? [processorOnlyUrl] : [])]) {
        cleanup.push((async () => {
          const response = await localFetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
          assert.ok(response.ok || response.status === 404, "fixture_database_cleanup_failed");
        })());
      }
    } else {
      for (const live of connections) live.disconnect();
    }
    if (restartPhase === "resume") cleanup.push(unlink(checkpointPath!));
    const cleaned = await Promise.allSettled(cleanup);
    assert.ok(cleaned.every(result => result.status === "fulfilled"), "fixture_cleanup_failed");
  }
}

void main().catch(() => {
  console.error(`FAIL protected_mail_authority_e2e stage=${stage}`);
  process.exitCode = 1;
});
