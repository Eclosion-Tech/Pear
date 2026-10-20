/** Disposable staged instruction/source test against localhost SpacetimeDB 2.0.3.
 * No mailbox, model, worker, real credentials or production workspace is used.
 * PEAR_INSTRUCTION_BASELINE_WASM optionally seeds retained S1b private records
 * before an additive upgrade to PEAR_PROTECTED_MAIL_WASM. The default is fresh.
 * PEAR_INSTRUCTION_INPUT_BASELINE_WASM instead seeds populated S2a records;
 * the two baseline options are mutually exclusive.
 * Output contains fixed stage codes only, never fixture values or raw errors.
 */
import assert from "node:assert/strict";
import { drainFixtureConnections, retainFixtureDatabaseUntilServerCleanup } from "./protected-mail-fixture-lifecycle.js";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setGlobalLogLevel } from "spacetimedb";
import { DbConnection, tables } from "../src/module_bindings/index.js";
import { HttpStdbTransport } from "../../web/src/lib/api-endpoint/http-transport.js";
import { buildPearSnapshotV2, SNAPSHOT_TABLES_V2, snapshotExportQueriesV2 } from "../../packages/snapshot-core/src/index.js";
import { decodeOptionSome } from "../../web/src/lib/api-endpoint/codec.js";
import { subscribeToAvailableTables } from "../src/subscriptions.js";

type Row = Record<string, unknown>;
type IdentityToken = { identity: string; token: string };
type Actor = IdentityToken & { transport: HttpStdbTransport; live: DbConnection };
type ConnectionRow = { id: number; root_page_id: number };
type SourceRow = Row & { id: string; collection_id: number; revision: number; digest: string };
type SourceRef = [string, number, string];
type Processor = [string, string, string, string];
type InstructionScope = [number, number, string, number, string];
type CachedTable = { iter(): Iterable<Row>; count(): bigint };

const none = { none: [] };
const ident = (hex: string) => [`0x${hex.replace(/^0x/, "")}`];
const marker = `S1C_PRIVATE_SYNTHETIC_${randomBytes(12).toString("hex")}`;
const password = "synthetic-local-fixture-password";
const mailTables = ["protected_mail_collection", "protected_mail_source", "protected_mail_record", "protected_mail_receipt"] as const;
const stateTables = ["protected_mail_source_policy_head", "protected_mail_source_policy_history", "protected_mail_context", "protected_mail_exposure", "protected_mail_derivation"] as const;
const legacyTables = [...mailTables, ...stateTables];
const instructionTables = ["protected_mail_instruction_head", "protected_mail_instruction_revision", "protected_mail_instruction_decision"] as const;
const privateTables = [...legacyTables, ...instructionTables];
const authorityTables = ["protected_mail_connection_authority_head", "protected_mail_connection_authority_history", "protected_mail_processor_head", "protected_mail_processor_revision", "protected_mail_processor_event"] as const;
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

function references(value: unknown): SourceRef[] {
  assert.ok(Array.isArray(value), "source_members_shape");
  return value.map(sourceReference).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function scopeTuple(value: unknown): InstructionScope {
  if (Array.isArray(value)) {
    assert.equal(value.length, 5, "instruction_scope_shape");
    return [Number(value[0]), Number(value[1]), String(value[2]), Number(value[3]), String(value[4])];
  }
  assert.ok(value && typeof value === "object", "instruction_scope_shape");
  const row = value as Row;
  return [Number(row.format_version ?? row.formatVersion), Number(row.scope_version ?? row.scopeVersion), String(row.purpose),
    Number(row.collection_id ?? row.collectionId), String(row.instruction_key ?? row.instructionKey)];
}

function statusName(value: unknown): string {
  const statuses = ["Draft", "InstructionApproved", "InstructionRevoked"];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return typeof value[0] === "number" ? statuses[value[0]] : String(value[0]);
  assert.ok(value && typeof value === "object", "instruction_status_shape");
  const row = value as Row;
  return typeof row.tag === "string" ? row.tag : Object.keys(row)[0];
}

function normalizedReview(row: Row): Row {
  return {
    scope: scopeTuple(row.scope), reference: sourceReference(row.reference), body: row.body, origin: row.origin,
    parents: references(row.parents), generation: Number(row.generation), status: statusName(row.status),
    decision: decodeOptionSome(row.decision_id ?? row.decisionId),
  };
}

function instructionDigest(s: InstructionScope, body: string, origin: string, parents: SourceRef[], derived?: SourceRef): string {
  const orderedParents = [...parents].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])) || a[1] - b[1]);
  const fields = [...s.map(String), body, origin, String(orderedParents.length), ...orderedParents.flatMap(value => value.map(String)),
    derived ? "some" : "none", ...(derived ? derived.map(String) : [])];
  const hash = createHash("sha256");
  for (const field of ["pear-mail-instruction-content-v1", ...fields]) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
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
      fixedLog("WARN protected_mail_instructions_sdk_diagnostic");
      return;
    }
    fixedLog(...args);
  };
  const name = `pear-protected-instructions-e2e-${Date.now()}-${randomBytes(6).toString("hex")}`;
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

  async function eventually(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 12000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "instruction_live_view_timeout");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
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
    const inputBaseline = process.env.PEAR_INSTRUCTION_INPUT_BASELINE_WASM || undefined;
    const legacyBaseline = process.env.PEAR_INSTRUCTION_BASELINE_WASM || undefined;
    assert.ok(!(inputBaseline && legacyBaseline), "exclusive_instruction_baseline_required");
    const baseline = inputBaseline ?? legacyBaseline;
    const baselineWasm = baseline ? await readFile(baseline) : undefined;
    assert.ok(currentWasm.length > 0 && (!baselineWasm || baselineWasm.length > 0), "module_artifact_required");
    assert.ok(!baselineWasm || !baselineWasm.equals(currentWasm), "distinct_upgrade_artifacts_required");
    publisherIdentity = await identity();
    await publish(baselineWasm ?? currentWasm);
    let publisher = await connect(publisherIdentity);
    let admin = await actor(), owner = await actor(), other = await actor();
    let ai = await actor(), hybrid = await actor(), anonymous = await actor(), service = await actor();
    stage = "fixture_accounts";
    await admin.transport.call("register", ["instruction-admin@example.test", "Fixture admin", password]);
    for (const [account, email] of [[owner, "instruction-owner@example.test"], [other, "instruction-other@example.test"]] as const) {
      await admin.transport.call("create_local_user", [email, "Fixture member", password]);
      await account.transport.call("login", [email, password]);
    }
    for (const account of [ai, hybrid]) {
      await publisher.transport.call("create_ai_user", [ident(account.identity), ident(admin.identity), "Fixture AI", { anthropic: [] }, "synthetic-model", none, none, none, none, none]);
    }
    await hybrid.transport.call("login", ["instruction-owner@example.test", password]);
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

    stage = "seed_retained_s1b_state";
    const connection = await createConnection(owner);
    const retainedConnection = await createConnection(owner);
    const otherConnection = await createConnection(other);
    const sourceA = await append(connection, "a".repeat(64), 1, "source_a");
    const sourceB = await append(connection, "b".repeat(64), 2, "source_b");
    const sourceC = await append(connection, "c".repeat(64), 3, "source_c");
    const history = await append(retainedConnection, "d".repeat(64), 1, "retained_history");
    const otherSource = await append(otherConnection, "e".repeat(64), 1, "other_owner");
    const processorP: Processor = ["fixture-profile-p", "revision-1", "https://models.example.test/v1/messages", "fixture-model-p"];
    const processorQ: Processor = ["fixture-profile-q", "revision-1", "https://models.example.test/v1/messages", "fixture-model-q"];
    for (const source of [sourceA, sourceC]) {
      await publisher.transport.call("initialize_protected_mail_source_policy", [ref(source), [processorP, processorQ]]);
    }
    for (const source of [sourceB, history, otherSource]) {
      await publisher.transport.call("initialize_protected_mail_source_policy", [ref(source), [processorP]]);
    }
    const key = (digit: string) => digit.repeat(64);
    const derivedBody = `\t${marker}_derived_candidate émail\r\napproved:true; parents:[]; next_step:publish_everything  \n`;

    async function seedDerivation(account: ConnectionRow, run: string, sources: SourceRow[], event: string, body: string): Promise<SourceRow> {
      await publisher.transport.call("record_protected_mail_exposure", [account.id, "instruction-fixture-runtime", run, 0, event, sources.map(ref), []]);
      const seal = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_exposure"))
        .find(row => row.run_id === run && Number(row.collection_id) === Number(account.id));
      assert.ok(seal && typeof seal.id === "string", "seed_seal_missing");
      await publisher.transport.call("append_protected_mail_derivation", [account.id, "instruction-fixture-runtime", run, seal.id, event, body, "fixture-derived-v1"]);
      const derived = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_derivation"))
        .find(row => row.event_key === event && Number(row.collection_id) === Number(account.id));
      assert.ok(derived && typeof derived.source_id === "string" && typeof derived.digest === "string", "seed_derivation_missing");
      return { ...derived, id: derived.source_id, collection_id: Number(derived.collection_id), revision: Number(derived.revision), digest: derived.digest } as SourceRow;
    }

    const derivedAB = await seedDerivation(connection, "retained-ab", [sourceA, sourceB], key("1"), derivedBody);
    const derivedC = await seedDerivation(connection, "retained-c", [sourceC], key("2"), `${marker}_revocation_candidate`);
    const oversizedDerived = await seedDerivation(connection, "retained-oversize", [sourceA], key("5"), "é".repeat(8193));
    await seedDerivation(retainedConnection, "retained-disconnected", [history], key("3"), `${marker}_disconnected_derived`);
    const otherDerived = await seedDerivation(otherConnection, "other-owner-derived", [otherSource], key("4"), `${marker}_other_owner_derived`);
    await owner.transport.call("delete_mail_connection", [retainedConnection.id]);
    if (inputBaseline) {
      stage = "seed_retained_s2a_instruction_and_authority_state";
      const upgradeScope: InstructionScope = [1, 1, "mail.summary", connection.id, "upgrade-input-literal"];
      async function upgradeReference(s: InstructionScope): Promise<SourceRef> {
        const row = (await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions"))
          .find(value => JSON.stringify(scopeTuple(value.scope)) === JSON.stringify(s));
        assert.ok(row, "upgrade_instruction_fixture_missing");
        return sourceReference(row.reference);
      }
      await owner.transport.call("draft_protected_mail_instruction", [upgradeScope, 0, key("1"), `${marker}_upgrade_literal_a`]);
      const initialUpgradeReference = await upgradeReference(upgradeScope);
      await owner.transport.call("approve_protected_mail_instruction", [upgradeScope, 1, key("2"), initialUpgradeReference]);
      await owner.transport.call("revoke_protected_mail_instruction", [upgradeScope, 2, key("3"), initialUpgradeReference]);
      await owner.transport.call("draft_protected_mail_instruction", [upgradeScope, 3, key("4"), `${marker}_upgrade_literal_b\r\n`]);
      await owner.transport.call("approve_protected_mail_instruction", [upgradeScope, 4, key("5"), await upgradeReference(upgradeScope)]);
      const derivedUpgradeScope: InstructionScope = [1, 1, "mail.summary", retainedConnection.id, "upgrade-input-derived"];
      const retainedDerived = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_derivation"))
        .find(row => Number(row.collection_id) === Number(retainedConnection.id));
      assert.ok(retainedDerived, "upgrade_retained_derivation_missing");
      await publisher.transport.call("draft_protected_mail_instruction_from_derivation", [derivedUpgradeScope, 0, key("6"), [retainedDerived.source_id, retainedDerived.revision, retainedDerived.digest]]);
      await owner.transport.call("approve_protected_mail_instruction", [derivedUpgradeScope, 1, key("7"), await upgradeReference(derivedUpgradeScope)]);
      await publisher.transport.call("initialize_protected_mail_connection_authority", [connection.id]);
      await owner.transport.call("update_mail_connection_password", [connection.id, ciphertext]);
      const upgradeProcessor = [1, [0, []], "https://models.example.test/v1/messages", "fixture-upgrade-model", "fixture-upgrade-credential", "version-a"];
      await publisher.transport.call("configure_protected_mail_processor", ["fixture-upgrade-profile", 0, key("8"), upgradeProcessor]);
      await publisher.transport.call("configure_protected_mail_processor", ["fixture-upgrade-profile", 1, key("9"), [...upgradeProcessor.slice(0, 5), "version-b"]]);
      await publisher.transport.call("retire_protected_mail_processor", ["fixture-upgrade-profile", 2, key("a")]);
    }
    const retainedState = await state(legacyTables);
    const inputUpgradeState = inputBaseline ? await state([...privateTables, ...authorityTables]) : undefined;
    const inputUpgradeView = inputBaseline ? sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions")) : undefined;
    const retainedOwnerRows = sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail"));
    assert.equal(retainedOwnerRows.length, 4, "retained_owner_history_missing");

    if (baseline) {
      stage = inputBaseline ? "additive_upgrade_retained_s2a_state" : "additive_upgrade_retained_s1b_state";
      for (const live of connections) live.disconnect();
      await publish(currentWasm, true);
      [publisher, admin, owner, other, ai, hybrid, anonymous, service] = await Promise.all(
        [publisher, admin, owner, other, ai, hybrid, anonymous, service].map(account => connect(account)),
      );
      assert.deepEqual(await state(legacyTables), retainedState, "upgrade_changed_private_source_or_policy_state");
      assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), retainedOwnerRows, "upgrade_changed_owner_history");
      if (inputUpgradeState) {
        assert.deepEqual(await state([...privateTables, ...authorityTables]), inputUpgradeState, "upgrade_changed_retained_s2a_private_state");
        assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions")), inputUpgradeView, "upgrade_changed_exact_instruction_history");
      }
      console.log(inputBaseline ? "PASS protected_mail_instructions_retained_s2a_upgrade" : "PASS protected_mail_instructions_retained_s1b_upgrade");
    }

    stage = "no_automatic_instruction_or_approval";
    if (!inputBaseline) {
      for (const rows of Object.values(await state(instructionTables))) assert.equal(rows.length, 0, "automatic_instruction_approval_backfill");
      assert.equal((await owner.transport.sql("SELECT * FROM my_protected_mail_instructions")).length, 0, "automatic_instruction_review_row");
    }
    assert.ok((await publisher.transport.sql<Row>("SELECT * FROM protected_mail_source_policy_head"))
      .every(row => !sourceReference(row.source)[0].startsWith("mail-instruction-head:")), "automatic_instruction_source_policy_backfill");
    console.log("PASS protected_mail_instructions_no_automatic_approval");

    const scope = (instructionKey: string, collectionId = Number(connection.id)): InstructionScope => [1, 1, "mail.summary", collectionId, instructionKey];
    const literalBody = `\t  ${marker}_owner_literal émail\r\nKeep exact spacing.  \n`;
    const literalScope = scope("literal-main");
    const draft = (s: InstructionScope, generation: number, event: string, body: string, account = owner) =>
      account.transport.call("draft_protected_mail_instruction", [s, generation, event, body]);
    const sourceDraft = (s: InstructionScope, generation: number, event: string, source: SourceRow, account = publisher) =>
      account.transport.call("draft_protected_mail_instruction_from_derivation", [s, generation, event, ref(source)]);
    const approve = (s: InstructionScope, generation: number, event: string, instruction: SourceRef, account = owner) =>
      account.transport.call("approve_protected_mail_instruction", [s, generation, event, instruction]);
    const revoke = (s: InstructionScope, generation: number, event: string, instruction: SourceRef, account = owner) =>
      account.transport.call("revoke_protected_mail_instruction", [s, generation, event, instruction]);

    async function review(instructionKey: string, account = owner): Promise<Row> {
      const rows = (await account.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions"))
        .filter(row => scopeTuple(row.scope)[4] === instructionKey && scopeTuple(row.scope)[3] === Number(connection.id));
      assert.equal(rows.length, 1, "instruction_review_row_missing_or_duplicated");
      return normalizedReview(rows[0]);
    }

    function reviewCache(instructionKey: string): Row | undefined {
      const row = [...cache(owner.live, "my_protected_mail_instructions").iter()]
        .find(value => scopeTuple(value.scope)[4] === instructionKey && scopeTuple(value.scope)[3] === Number(connection.id));
      return row ? normalizedReview(row) : undefined;
    }

    async function assertReview(instructionKey: string, body: string, expectedStatus: string, parents?: SourceRef[]): Promise<Row> {
      const row = await review(instructionKey);
      assert.equal(row.body, body, "review_body_not_exact");
      assert.equal(row.status, expectedStatus, "review_status_mismatch");
      assert.deepEqual(row.scope, scope(instructionKey), "review_scope_mismatch");
      const reference = sourceReference(row.reference);
      assert.ok(/^[0-9a-f]{64}$/.test(reference[2]), "review_digest_invalid");
      if (parents) assert.deepEqual(row.parents, references(parents), "review_ancestry_mismatch");
      const revision = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_instruction_revision WHERE head_id = ?", [reference[0]]))
        .find(value => Number(value.revision) === reference[1]);
      assert.ok(revision, "review_revision_missing");
      const derivedSource = decodeOptionSome(revision.derived_source);
      assert.equal(reference[2], instructionDigest(scopeTuple(row.scope), String(row.body), String(row.origin), references(row.parents),
        derivedSource === undefined ? undefined : sourceReference(derivedSource)), "review_digest_not_bound_to_exact_bytes_scope_and_ancestry");
      await eventually(() => JSON.stringify(reviewCache(instructionKey)) === JSON.stringify(row));
      return row;
    }

    async function atomicDenied(action: () => Promise<unknown>, code?: string): Promise<void> {
      const before = await state(privateTables);
      await denied(action(), code);
      assert.deepEqual(await state(privateTables), before, "rejected_instruction_write_not_atomic");
    }

    async function noAuthorityEffect(action: () => Promise<unknown>): Promise<void> {
      const before = await state([...legacyTables, ...effectsTables]);
      await action();
      assert.deepEqual(await state([...legacyTables, ...effectsTables]), before, "instruction_changed_grants_processors_or_runtime_state");
    }

    stage = "private_table_view_and_mutation_identity_boundary";
    const hidden = [other, admin, ai, hybrid, anonymous, service, publisher];
    const reviewQueries = ["SELECT * FROM user", "SELECT * FROM my_protected_mail_instructions"];
    await Promise.all([owner, ...hidden].map(account => subscribe(account, reviewQueries)));
    const generatedNames = Object.values(tables).map(table => (table as { sourceName: string }).sourceName);
    for (const table of instructionTables) {
      assert.ok(!generatedNames.includes(table), "private_instruction_has_public_binding");
      for (const candidate of [owner, ...hidden.filter(account => account !== publisher)]) {
        await denied(candidate.transport.sql(`SELECT * FROM ${table}`));
        await privateSubscriptionDenied(candidate, table);
      }
    }
    const boundaryState = await state(privateTables);
    for (const candidate of hidden) {
      assert.equal((await candidate.transport.sql("SELECT * FROM my_protected_mail_instructions")).length, 0, "hidden_instruction_review_projection");
      assert.equal(cache(candidate.live, "my_protected_mail_instructions").count(), 0n, "hidden_instruction_review_ws_projection");
      await denied(draft(literalScope, 0, key("5"), literalBody, candidate), "protected_mail_instruction_owner_required");
      await denied(approve(literalScope, 0, key("6"), ["missing-head", 1, key("a")], candidate), "protected_mail_instruction_owner_required");
      await denied(revoke(literalScope, 0, key("7"), ["missing-head", 1, key("a")], candidate), "protected_mail_instruction_owner_required");
    }
    for (const candidate of [owner, ...hidden.filter(account => account !== publisher)]) {
      await denied(sourceDraft(scope("unauthorized-derived"), 0, key("8"), derivedAB, candidate), "protected_mail_publisher_required");
    }
    assert.deepEqual(await state(privateTables), boundaryState, "wrong_identity_changed_instruction_state");
    console.log("PASS protected_mail_instructions_private_protocol_and_identity_boundary");

    stage = "owner_literal_exact_review_and_approval";
    const originalDraftArgs = [literalScope, 0, key("5"), literalBody];
    await noAuthorityEffect(() => owner.transport.call("draft_protected_mail_instruction", originalDraftArgs));
    const original = await assertReview("literal-main", literalBody, "Draft", []);
    assert.equal(original.origin, "unknown", "literal_draft_claimed_source_authority");
    assert.equal(Number(original.generation), 1, "first_draft_generation");
    for (const candidate of hidden) {
      assert.equal((await candidate.transport.sql("SELECT * FROM my_protected_mail_instructions")).length, 0, "draft_exposed_http_review_to_other_identity");
      assert.equal(cache(candidate.live, "my_protected_mail_instructions").count(), 0n, "draft_exposed_ws_review_to_other_identity");
    }
    const originalRef = sourceReference(original.reference);
    const beforeDraftReplay = await state(instructionTables);
    await owner.transport.call("draft_protected_mail_instruction", originalDraftArgs);
    assert.deepEqual(await state(instructionTables), beforeDraftReplay, "literal_draft_replay_mutated_history");
    await atomicDenied(() => draft(literalScope, 0, key("5"), "changed body"), "protected_mail_instruction_event_conflict");
    await atomicDenied(() => sourceDraft(literalScope, 0, key("5"), derivedAB));
    await draft(scope("literal-mode-identical-body"), 0, key("1"), derivedBody);
    await atomicDenied(() => sourceDraft(scope("literal-mode-identical-body"), 0, key("1"), derivedAB), "protected_mail_instruction_event_conflict");
    const originalApproveArgs = [literalScope, 1, key("6"), originalRef];
    await noAuthorityEffect(() => owner.transport.call("approve_protected_mail_instruction", originalApproveArgs));
    const approved = await assertReview("literal-main", literalBody, "InstructionApproved", []);
    assert.deepEqual(approved.reference, original.reference, "approval_changed_reviewed_revision");
    assert.ok(typeof approved.decision === "string" && approved.decision.length > 0, "approval_receipt_missing");
    assert.equal(Number(approved.generation), 2, "approval_did_not_advance_head");
    const approvedState = await state(instructionTables);
    await owner.transport.call("approve_protected_mail_instruction", originalApproveArgs);
    assert.deepEqual(await state(instructionTables), approvedState, "approval_replay_mutated_state");
    // Approval does not enroll a disclosure ceiling. Literal-main stays
    // unenrolled so its later edit/logout/disconnect checks remain independent.
    assert.ok((await publisher.transport.sql<Row>("SELECT * FROM protected_mail_source_policy_head"))
      .every(row => JSON.stringify(sourceReference(row.source)) !== JSON.stringify(originalRef)), "approval_automatically_enrolled_instruction_source");
    for (const candidate of hidden) {
      assert.equal((await candidate.transport.sql("SELECT * FROM my_protected_mail_instructions")).length, 0, "approval_exposed_http_review_to_other_identity");
      assert.equal(cache(candidate.live, "my_protected_mail_instructions").count(), 0n, "approval_exposed_ws_review_to_other_identity");
    }
    console.log("PASS protected_mail_instructions_exact_owner_review_and_bound_approval");

    stage = "instruction_metadata_oracle_and_invalid_approval_atomicity";
    const oracleScopes = [literalScope, scope("missing-instruction"), scope("literal-main", 0), [2, 1, "mail.summary", connection.id, "literal-main"] as InstructionScope];
    for (const candidate of hidden) {
      const draftErrors: string[] = [], approveErrors: string[] = [], revokeErrors: string[] = [];
      for (const oracleScope of oracleScopes) {
        draftErrors.push(await denied(draft(oracleScope, 2, key("9"), literalBody, candidate), "protected_mail_instruction_owner_required"));
        approveErrors.push(await denied(approve(oracleScope, 2, key("a"), originalRef, candidate), "protected_mail_instruction_owner_required"));
        revokeErrors.push(await denied(revoke(oracleScope, 2, key("b"), originalRef, candidate), "protected_mail_instruction_owner_required"));
      }
      for (const oracleReference of [
        [originalRef[0], originalRef[1], key("0")], [originalRef[0], originalRef[1] + 1, originalRef[2]],
        ["missing-head", 1, originalRef[2]], ["", 0, "malformed-digest"],
      ] as SourceRef[]) {
        approveErrors.push(await denied(approve(literalScope, 2, key("a"), oracleReference, candidate), "protected_mail_instruction_owner_required"));
        revokeErrors.push(await denied(revoke(literalScope, 2, key("b"), oracleReference, candidate), "protected_mail_instruction_owner_required"));
      }
      assert.equal(new Set(draftErrors).size, 1, "draft_denial_reveals_instruction_metadata");
      assert.equal(new Set(approveErrors).size, 1, "approval_denial_reveals_instruction_metadata");
      assert.equal(new Set(revokeErrors).size, 1, "revocation_denial_reveals_instruction_metadata");
    }
    for (const instruction of [
      [originalRef[0], originalRef[1], key("0")],
      [originalRef[0], originalRef[1] + 1, originalRef[2]],
      ["missing-head", originalRef[1], originalRef[2]],
      ["", 0, "malformed-digest"],
    ] as SourceRef[]) {
      await atomicDenied(() => approve(literalScope, 2, key("c"), instruction));
      await atomicDenied(() => revoke(literalScope, 2, key("d"), instruction));
    }
    await atomicDenied(() => approve(literalScope, 1, key("c"), originalRef));
    for (const invalidScope of [
      [0, 1, "mail.summary", connection.id, "literal-main"], [1, 2, "mail.summary", connection.id, "literal-main"],
      [1, 1, "other.purpose", connection.id, "literal-main"], [1, 1, "mail.summary", connection.id, "invalid/key"],
    ] as InstructionScope[]) await atomicDenied(() => approve(invalidScope, 2, key("c"), originalRef));
    await atomicDenied(() => draft(literalScope, 2, key("c"), `${marker}\u0000body`));
    await atomicDenied(() => draft(literalScope, 2, key("c"), "é".repeat(8193)));
    await draft(scope("exact-byte-bound"), 0, key("c"), "é".repeat(8192));
    await assertReview("exact-byte-bound", "é".repeat(8192), "Draft", []);
    console.log("PASS protected_mail_instructions_uniform_oracles_and_exact_revision_cas");

    stage = "revoke_edit_revert_and_historical_replay";
    await noAuthorityEffect(() => revoke(literalScope, 2, key("7"), originalRef));
    const revoked = await assertReview("literal-main", literalBody, "InstructionRevoked", []);
    const revokedState = await state(instructionTables);
    await owner.transport.call("approve_protected_mail_instruction", originalApproveArgs);
    await owner.transport.call("draft_protected_mail_instruction", originalDraftArgs);
    assert.deepEqual(await state(instructionTables), revokedState, "old_event_reactivated_or_rewound_instruction");
    await atomicDenied(() => approve(literalScope, Number(revoked.generation), key("6"), originalRef));
    await draft(literalScope, Number(revoked.generation), key("8"), `${marker}_edited_literal`);
    const edited = await assertReview("literal-main", `${marker}_edited_literal`, "Draft", []);
    assert.ok(sourceReference(edited.reference)[1] !== originalRef[1], "edit_reused_revision");
    assert.ok(!edited.decision, "edit_retained_active_approval");
    await draft(literalScope, Number(edited.generation), key("9"), literalBody);
    const reverted = await assertReview("literal-main", literalBody, "Draft", []);
    assert.ok(sourceReference(reverted.reference)[1] > sourceReference(edited.reference)[1], "revert_reused_old_revision");
    assert.ok(!reverted.decision, "revert_reactivated_approval");
    const beforeOldApproval = await state(instructionTables);
    await owner.transport.call("approve_protected_mail_instruction", originalApproveArgs);
    assert.deepEqual(await state(instructionTables), beforeOldApproval, "approval_retry_rewound_edited_head");
    await atomicDenied(() => approve(literalScope, Number(reverted.generation), key("a"), originalRef));
    await noAuthorityEffect(() => approve(literalScope, Number(reverted.generation), key("a"), sourceReference(reverted.reference)));
    await assertReview("literal-main", literalBody, "InstructionApproved", []);
    console.log("PASS protected_mail_instructions_revoke_edit_revert_never_reactivate_old_approval");

    stage = "concurrent_approve_versus_edit_cas";
    const raceScope = scope("concurrent-approval-edit");
    const raceBody = `${marker}_race_original`;
    const raceEditedBody = `${marker}_race_edited`;
    await draft(raceScope, 0, key("1"), raceBody);
    const raceOriginal = await assertReview("concurrent-approval-edit", raceBody, "Draft", []);
    const raceReference = sourceReference(raceOriginal.reference);
    let raceResults: PromiseSettledResult<unknown>[] = [];
    await noAuthorityEffect(async () => {
      raceResults = await Promise.allSettled([
        approve(raceScope, 1, key("2"), raceReference),
        draft(raceScope, 1, key("3"), raceEditedBody),
      ]);
    });
    assert.equal(raceResults.filter(value => value.status === "fulfilled").length, 1, "concurrent_cas_committed_multiple_or_no_winners");
    const loser = raceResults.find(value => value.status === "rejected") as PromiseRejectedResult;
    assert.ok(loser.reason instanceof Error && loser.reason.message.includes("protected_mail_instruction_stale")
      && !containsMarker(loser.reason.message), "concurrent_cas_loser_not_stale");
    const approvalWon = raceResults[0].status === "fulfilled";
    const raceFinal = await assertReview("concurrent-approval-edit", approvalWon ? raceBody : raceEditedBody,
      approvalWon ? "InstructionApproved" : "Draft", []);
    assert.equal(Number(raceFinal.generation), 2, "concurrent_cas_head_advanced_twice");
    const raceRevisions = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_instruction_revision WHERE head_id = ?", [raceReference[0]]));
    const raceDecisions = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_instruction_decision WHERE head_id = ?", [raceReference[0]]));
    assert.equal(raceRevisions.length, approvalWon ? 1 : 2, "concurrent_cas_revision_count");
    assert.equal(raceDecisions.length, approvalWon ? 1 : 0, "concurrent_cas_decision_count");
    if (approvalWon) assert.deepEqual(raceFinal.reference, raceOriginal.reference, "winning_approval_changed_revision");
    else assert.equal(sourceReference(raceFinal.reference)[1], 2, "winning_edit_reused_revision");
    console.log("PASS protected_mail_instructions_concurrent_approve_edit_one_cas_winner");

    stage = "byte_identical_new_edit_clears_approval";
    const identicalScope = scope("identical-approved-edit");
    const identicalBody = `${marker}_byte_identical_edit`;
    await draft(identicalScope, 0, key("1"), identicalBody);
    const identicalDraft = await assertReview("identical-approved-edit", identicalBody, "Draft", []);
    const identicalApproveArgs = [identicalScope, 1, key("2"), sourceReference(identicalDraft.reference)];
    await noAuthorityEffect(() => owner.transport.call("approve_protected_mail_instruction", identicalApproveArgs));
    await assertReview("identical-approved-edit", identicalBody, "InstructionApproved", []);
    await noAuthorityEffect(() => draft(identicalScope, 2, key("3"), identicalBody));
    const identicalEdited = await assertReview("identical-approved-edit", identicalBody, "Draft", []);
    assert.equal(Number(identicalEdited.generation), 3, "identical_edit_did_not_advance_head");
    assert.equal(sourceReference(identicalEdited.reference)[1], 3, "identical_edit_reused_approved_revision");
    assert.ok(!identicalEdited.decision, "identical_edit_retained_active_approval");
    const identicalEditedState = await state(instructionTables);
    await owner.transport.call("approve_protected_mail_instruction", identicalApproveArgs);
    assert.deepEqual(await state(instructionTables), identicalEditedState, "old_approval_reactivated_identical_edit");
    console.log("PASS protected_mail_instructions_identical_new_edit_clears_approval");

    stage = "source_backed_exact_body_and_immutable_ancestry";
    const derivedScope = scope("source-backed");
    const expectedParents = references([ref(derivedAB), ref(sourceA), ref(sourceB)]);
    const sourceDraftArgs = [derivedScope, 0, key("b"), ref(derivedAB)];
    await noAuthorityEffect(() => publisher.transport.call("draft_protected_mail_instruction_from_derivation", sourceDraftArgs));
    const sourceReview = await assertReview("source-backed", derivedBody, "Draft", expectedParents);
    assert.equal(sourceReview.origin, "derived", "source_draft_promoted_origin");
    const sourceState = await state(instructionTables);
    await publisher.transport.call("draft_protected_mail_instruction_from_derivation", sourceDraftArgs);
    assert.deepEqual(await state(instructionTables), sourceState, "source_draft_replay_mutated_state");
    await atomicDenied(() => sourceDraft(derivedScope, 0, key("b"), derivedC));
    await atomicDenied(() => draft(derivedScope, 0, key("b"), derivedBody), "protected_mail_instruction_event_conflict");
    await atomicDenied(() => sourceDraft(scope("wrong-source-owner"), 0, key("c"), otherDerived));
    await atomicDenied(() => sourceDraft(scope("external-source-not-derived"), 0, key("c"), sourceA));
    await atomicDenied(() => sourceDraft(scope("oversized-derived-body"), 0, key("c"), oversizedDerived), "protected_mail_instruction_invalid_body");
    await atomicDenied(() => publisher.transport.call("draft_protected_mail_instruction_from_derivation", [scope("wrong-source-digest"), 0, key("c"), [derivedAB.id, derivedAB.revision, key("0")]]));
    await noAuthorityEffect(() => approve(derivedScope, Number(sourceReview.generation), key("c"), sourceReference(sourceReview.reference)));
    const sourceApproved = await assertReview("source-backed", derivedBody, "InstructionApproved", expectedParents);
    await draft(derivedScope, Number(sourceApproved.generation), key("d"), `${marker}_owner_edit_of_derived`);
    const sourceEdited = await assertReview("source-backed", `${marker}_owner_edit_of_derived`, "Draft", expectedParents);
    assert.equal(sourceEdited.origin, "unknown", "manual_edit_claimed_source_authority");
    await sourceDraft(derivedScope, Number(sourceEdited.generation), key("e"), derivedC);
    const unionParents = references([...expectedParents, ref(derivedC), ref(sourceC)]);
    const unionReview = await assertReview("source-backed", `${marker}_revocation_candidate`, "Draft", unionParents);
    assert.equal(unionReview.origin, "derived", "mode_change_erased_derived_origin");
    assert.deepEqual(await state(legacyTables), retainedState, "instruction_review_changed_source_policy_or_exposure");
    console.log("PASS protected_mail_instructions_source_body_copy_and_ancestry_union");

    stage = "current_ancestor_ceiling_blocks_new_revision";
    const revokedScope = scope("revoked-source-candidate");
    await sourceDraft(revokedScope, 0, key("f"), derivedC);
    const beforeStorageNarrowing = await state(instructionTables);
    await owner.transport.call("narrow_protected_mail_source_policy", [ref(sourceB), 1, [processorP], false, false]);
    await atomicDenied(() => draft(derivedScope, Number(unionReview.generation), key("f"), "attempted ancestry removal"));
    await atomicDenied(() => sourceDraft(scope("storage-denied-new-source"), 0, key("f"), derivedAB));
    assert.deepEqual(await state(instructionTables), beforeStorageNarrowing, "ancestor_storage_denial_changed_instruction_history");
    await owner.transport.call("narrow_protected_mail_source_policy", [ref(sourceC), 1, [], false, true]);
    const revokedSourceReview = await review("revoked-source-candidate");
    await atomicDenied(() => draft(revokedScope, Number(revokedSourceReview.generation), key("e"), "attempted revoked-source edit"));
    await atomicDenied(() => sourceDraft(scope("revoked-new-source"), 0, key("f"), derivedC));
    const beforeHistoricalSourceReplay = await state(instructionTables);
    await publisher.transport.call("draft_protected_mail_instruction_from_derivation", sourceDraftArgs);
    assert.deepEqual(await state(instructionTables), beforeHistoricalSourceReplay, "historical_source_retry_changed_head_after_ancestor_denial");
    await atomicDenied(() => sourceDraft(scope("still-storage-denied-after-retry"), 0, key("f"), derivedAB));
    // Exact owner approval remains a metadata assertion. It neither restores
    // the ancestor policy nor makes this stored revision executable.
    await noAuthorityEffect(() => approve(revokedScope, Number(revokedSourceReview.generation), key("e"), sourceReference(revokedSourceReview.reference)));
    await assertReview("revoked-source-candidate", `${marker}_revocation_candidate`, "InstructionApproved", references([ref(derivedC), ref(sourceC)]));
    await atomicDenied(() => sourceDraft(scope("still-revoked-after-approval"), 0, key("e"), derivedC));
    console.log("PASS protected_mail_instructions_current_ancestor_storage_and_revocation_fence");

    const inputEffectsBefore = await state([...effectsTables, ...(inputBaseline ? authorityTables : [])]);
    const initInput = (reference: SourceRef, processors: Processor[], account = publisher) =>
      account.transport.call("initialize_protected_mail_source_policy", [reference, processors]);
    const narrowInput = (reference: SourceRef, generation: number, processors: Processor[], storage: boolean, revoked: boolean, account = owner) =>
      account.transport.call("narrow_protected_mail_source_policy", [reference, generation, processors, storage, revoked]);
    async function inputHeads(reference: SourceRef): Promise<Row[]> {
      return (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_source_policy_head"))
        .filter(row => JSON.stringify(sourceReference(row.source)) === JSON.stringify(reference));
    }
    async function inputPolicy(reference: SourceRef): Promise<Row> {
      const heads = await inputHeads(reference);
      assert.equal(heads.length, 1, "instruction_input_policy_missing_or_duplicated");
      const history = await publisher.transport.sql<Row>("SELECT * FROM protected_mail_source_policy_history WHERE policy_id = ? AND generation = ?", [heads[0].id, Number(heads[0].generation)]);
      assert.equal(history.length, 1, "instruction_input_policy_history_missing");
      return history[0];
    }
    function policyProcessors(policy: Row): Processor[] {
      assert.ok(Array.isArray(policy.processors), "instruction_input_processors_shape");
      return policy.processors.map(value => {
        if (Array.isArray(value)) return value.map(String) as Processor;
        const row = value as Row;
        return [String(row.profile_id), String(row.revision), String(row.endpoint), String(row.model)] as Processor;
      });
    }
    async function inputSeal(run: string, inputs: SourceRef[], expectedMembers: SourceRef[]): Promise<Row> {
      await publisher.transport.call("record_protected_mail_exposure", [connection.id, "instruction-input-runtime", run, 0, key("0"), inputs, []]);
      const seal = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_exposure"))
        .find(row => row.runtime_id === "instruction-input-runtime" && row.run_id === run);
      assert.ok(seal, "instruction_input_seal_missing");
      assert.deepEqual(references(seal.members), references(expectedMembers), "instruction_input_graph_not_exact");
      return seal;
    }
    const appendInput = (seal: Row, event: string, body: string) => publisher.transport.call("append_protected_mail_derivation",
      [connection.id, seal.runtime_id, seal.run_id, seal.id, event, body, "instruction-input-v1"]);
    async function derivedInput(seal: Row, event: string, body: string): Promise<SourceRef> {
      await appendInput(seal, event, body);
      const row = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_derivation"))
        .find(value => value.exposure_id === seal.id && value.event_key === event);
      assert.ok(row, "instruction_input_derivation_missing");
      assert.equal(row.body, body, "instruction_input_derivation_body_changed");
      assert.deepEqual(references(row.parents), references(seal.members), "instruction_input_derivation_dropped_source");
      return [String(row.source_id), Number(row.revision), String(row.digest)];
    }

    if (inputUpgradeView) {
      stage = "instruction_input_explicit_adoption_of_retained_s2a_revisions";
      const retainedLiteral = await assertReview("upgrade-input-literal", `${marker}_upgrade_literal_b\r\n`, "InstructionApproved", []);
      const retainedLiteralReference = sourceReference(retainedLiteral.reference);
      const retainedDerived = inputUpgradeView.find(row => scopeTuple(row.scope)[4] === "upgrade-input-derived");
      assert.ok(retainedDerived, "retained_derived_instruction_missing_after_upgrade");
      const unchangedDecisions = await state(instructionTables);
      await initInput(retainedLiteralReference, [processorP, processorQ]);
      await initInput(sourceReference(retainedDerived.reference), [processorP]);
      assert.deepEqual(await state(instructionTables), unchangedDecisions, "source_adoption_changed_retained_instruction_decisions");
      const firstLiteral = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_instruction_revision WHERE head_id = ?", [retainedLiteralReference[0]]))
        .find(row => Number(row.revision) === 1);
      assert.ok(firstLiteral, "retained_historical_instruction_missing");
      await atomicDenied(() => initInput([retainedLiteralReference[0], 1, String(firstLiteral.digest)], [processorP]), "protected_mail_instruction_source_not_current");
      const retainedSeal = await inputSeal("retained-s2a-current-input", [retainedLiteralReference], [retainedLiteralReference]);
      await derivedInput(retainedSeal, key("1"), `${marker}_retained_instruction_output`);
      console.log("PASS protected_mail_instructions_input_explicit_retained_s2a_adoption");
    }

    stage = "instruction_input_exact_refs_and_missing_policy_denial";
    const inputScope = scope("governed-input-literal");
    const inputBody = `\t${marker}_governed_literal\r\nexact bytes  \n`;
    await draft(inputScope, 0, key("1"), inputBody);
    const inputReview = await assertReview("governed-input-literal", inputBody, "Draft", []);
    const inputReference = sourceReference(inputReview.reference);
    assert.equal((await inputHeads(inputReference)).length, 0, "draft_automatically_enrolled_input");
    const missingPolicySeal = await inputSeal("literal-missing-policy", [inputReference], [inputReference]);
    await atomicDenied(() => appendInput(missingPolicySeal, key("1"), `${marker}_missing_policy_output`), "protected_mail_source_policy_required");
    const inputDerivedBody = `${marker}_derived_instruction_input`;
    const inputDerived = await seedDerivation(connection, "input-derived-a", [sourceA], key("b"), inputDerivedBody);
    const derivedInputScope = scope("governed-input-derived");
    await sourceDraft(derivedInputScope, 0, key("1"), inputDerived);
    const derivedInputReview = await assertReview("governed-input-derived", inputDerivedBody, "Draft", references([ref(inputDerived), ref(sourceA)]));
    const derivedInstructionReference = sourceReference(derivedInputReview.reference);
    await initInput(derivedInstructionReference, [processorP, processorQ]);
    const derivedInstructionSeal = await inputSeal("derived-exact-input", [derivedInstructionReference], [derivedInstructionReference, ref(inputDerived), ref(sourceA)]);
    const derivedInstructionOutput = await derivedInput(derivedInstructionSeal, key("1"), `${marker}_derived_instruction_output`);
    assert.deepEqual(policyProcessors(await inputPolicy(derivedInstructionOutput)), [processorP, processorQ], "derived_instruction_ceiling_not_inherited");
    const foreignScope = scope("governed-input-foreign", otherConnection.id);
    await draft(foreignScope, 0, key("1"), `${marker}_foreign_instruction`, other);
    const foreignReview = (await other.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions"))
      .find(row => JSON.stringify(scopeTuple(row.scope)) === JSON.stringify(foreignScope));
    assert.ok(foreignReview, "foreign_instruction_fixture_missing");
    const foreignReference = sourceReference(foreignReview.reference);
    await initInput(foreignReference, [processorP]);
    await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", [connection.id, "instruction-input-runtime", "foreign-input-ref", 0, key("0"), [foreignReference], []]), "protected_mail_source_scope_mismatch");
    await atomicDenied(() => narrowInput(foreignReference, 1, [], false, true), "protected_mail_source_policy_owner_required");
    for (const malformed of [[inputReference[0], inputReference[1], key("0")], [inputReference[0], inputReference[1] + 1, inputReference[2]], ["", 0, "malformed"]] as SourceRef[]) {
      await atomicDenied(() => publisher.transport.call("record_protected_mail_exposure", [connection.id, "instruction-input-runtime", "invalid-input-ref", 0, key("0"), [malformed], []]));
    }
    console.log("PASS protected_mail_instructions_input_exact_graph_and_missing_policy_denial");

    stage = "instruction_input_current_only_first_enrollment_and_oracles";
    const lateScope = scope("governed-input-edit-before-init");
    await draft(lateScope, 0, key("1"), `${marker}_late_a`);
    const lateA = sourceReference((await assertReview("governed-input-edit-before-init", `${marker}_late_a`, "Draft", [])).reference);
    await approve(lateScope, 1, key("2"), lateA);
    await draft(lateScope, 2, key("3"), `${marker}_late_b`);
    const lateB = sourceReference((await assertReview("governed-input-edit-before-init", `${marker}_late_b`, "Draft", [])).reference);
    await atomicDenied(() => initInput(lateA, [processorP, processorQ]), "protected_mail_instruction_source_not_current");
    assert.equal((await inputHeads(lateA)).length, 0, "historical_first_init_created_policy");
    await initInput(lateB, [processorP, processorQ]);
    await initInput(inputReference, [processorP, processorQ]);
    const oracleReferences: SourceRef[] = [inputReference, [inputReference[0], inputReference[1], key("0")], ["mail-instruction-head:" + key("0"), 1, key("0")], ["", 0, "malformed"]];
    for (const account of [owner, ...hidden.filter(value => value !== publisher)]) {
      const errors = [];
      for (const reference of oracleReferences) errors.push(await denied(initInput(reference, [processorP], account), "protected_mail_publisher_required"));
      assert.equal(new Set(errors).size, 1, "input_initialization_denial_reveals_metadata");
    }
    for (const account of hidden.filter(value => value !== publisher)) {
      const errors = [];
      for (const reference of oracleReferences) errors.push(await denied(narrowInput(reference, 1, [], false, true, account), "protected_mail_source_policy_owner_required"));
      assert.equal(new Set(errors).size, 1, "input_narrowing_denial_reveals_metadata");
    }
    const eligibilityScope = scope("governed-input-owner-eligibility");
    await draft(eligibilityScope, 0, key("1"), `${marker}_owner_eligibility`);
    const eligibilityReference = sourceReference((await assertReview("governed-input-owner-eligibility", `${marker}_owner_eligibility`, "Draft", [])).reference);
    await owner.transport.call("logout", []);
    await atomicDenied(() => initInput(eligibilityReference, [processorP]), "protected_mail_instruction_owner_required");
    await owner.transport.call("login", ["instruction-owner@example.test", password]);
    await initInput(eligibilityReference, [processorP]);
    console.log("PASS protected_mail_instructions_input_current_only_enrollment_and_uniform_oracles");

    stage = "instruction_input_initialize_versus_edit_race";
    const initRaceScope = scope("governed-input-init-edit-race");
    await draft(initRaceScope, 0, key("1"), `${marker}_init_race_a`);
    const initRaceA = sourceReference((await assertReview("governed-input-init-edit-race", `${marker}_init_race_a`, "Draft", [])).reference);
    const initRace = await Promise.allSettled([initInput(initRaceA, [processorP, processorQ]), draft(initRaceScope, 1, key("2"), `${marker}_init_race_b`)]);
    assert.equal(initRace[1].status, "fulfilled", "instruction_input_racing_edit_rejected");
    const raceEnrolled = initRace[0].status === "fulfilled";
    if (!raceEnrolled) {
      const rejected = initRace[0] as PromiseRejectedResult;
      assert.ok(rejected.reason instanceof Error && rejected.reason.message.includes("protected_mail_instruction_source_not_current")
        && !containsMarker(rejected.reason.message), "instruction_input_racing_init_not_current_denial");
    }
    await assertReview("governed-input-init-edit-race", `${marker}_init_race_b`, "Draft", raceEnrolled ? [initRaceA] : []);
    assert.equal((await inputHeads(initRaceA)).length, raceEnrolled ? 1 : 0, "instruction_input_race_policy_parent_mismatch");
    console.log("PASS protected_mail_instructions_input_init_edit_atomic_race");

    stage = "instruction_input_enrolled_ancestors_survive_unenrolled_edits";
    const lineageScope = scope("governed-input-lineage");
    const lineageDraftArgs = [lineageScope, 0, key("1"), `${marker}_lineage_a`];
    await owner.transport.call("draft_protected_mail_instruction", lineageDraftArgs);
    const lineageA = sourceReference((await assertReview("governed-input-lineage", `${marker}_lineage_a`, "Draft", [])).reference);
    await initInput(lineageA, [processorP, processorQ]);
    await draft(lineageScope, 1, key("2"), `${marker}_lineage_b`);
    const lineageB = sourceReference((await assertReview("governed-input-lineage", `${marker}_lineage_b`, "Draft", [lineageA])).reference);
    assert.equal((await inputHeads(lineageB)).length, 0, "edit_automatically_enrolled_input_revision");
    await narrowInput(lineageA, 1, [processorP], true, false);
    await atomicDenied(() => initInput(lineageB, [processorP, processorQ]), "protected_mail_source_policy_expansion");
    await initInput(lineageB, [processorP]);
    const lineageSeal = await inputSeal("lineage-b-input", [lineageB], [lineageA, lineageB]);
    const lineageOutput = await derivedInput(lineageSeal, key("1"), `${marker}_lineage_output`);
    assert.deepEqual(policyProcessors(await inputPolicy(lineageOutput)), [processorP], "lineage_parent_narrowing_ignored_before_child_init");
    await narrowInput(lineageA, 2, [], true, false);
    const afterNarrowOutput = await derivedInput(lineageSeal, key("2"), `${marker}_after_narrow_output`);
    assert.deepEqual(policyProcessors(await inputPolicy(afterNarrowOutput)), [], "lineage_parent_narrowing_ignored_after_child_init");
    await draft(lineageScope, 2, key("3"), `${marker}_lineage_c`);
    const lineageC = sourceReference((await assertReview("governed-input-lineage", `${marker}_lineage_c`, "Draft", [lineageA, lineageB])).reference);
    assert.equal((await inputHeads(lineageC)).length, 0, "intermediate_revision_auto_enrolled");
    await draft(lineageScope, 3, key("4"), `${marker}_lineage_d`);
    const lineageDReview = await assertReview("governed-input-lineage", `${marker}_lineage_d`, "Draft", [lineageA, lineageB]);
    assert.ok(!references(lineageDReview.parents).some(reference => JSON.stringify(reference) === JSON.stringify(lineageC)), "unenrolled_intermediate_invented_policy_parent");
    await atomicDenied(() => initInput(lineageC, []), "protected_mail_instruction_source_not_current");
    console.log("PASS protected_mail_instructions_input_lineage_and_live_ancestor_intersection");

    stage = "instruction_input_revocation_blocks_old_summary_and_new_revision";
    await narrowInput(lineageA, 3, [], false, false);
    await atomicDenied(() => draft(lineageScope, 4, key("5"), "attempted restriction removal"), "protected_mail_source_disclosure_denied");
    const oldSummarySeal = await inputSeal("old-summary-after-storage-denial", [lineageOutput], [lineageOutput, lineageA, lineageB]);
    await atomicDenied(() => appendInput(oldSummarySeal, key("1"), `${marker}_blocked_summary_output`), "protected_mail_source_disclosure_denied");
    const lineageD = sourceReference(lineageDReview.reference);
    await noAuthorityEffect(() => approve(lineageScope, 4, key("5"), lineageD));
    await assertReview("governed-input-lineage", `${marker}_lineage_d`, "InstructionApproved", [lineageA, lineageB]);
    await narrowInput(lineageA, 4, [], false, true);
    await atomicDenied(() => draft(lineageScope, 5, key("6"), "attempted revoked-source edit"), "protected_mail_source_policy_revoked");
    await atomicDenied(() => appendInput(oldSummarySeal, key("2"), `${marker}_revoked_summary_output`), "protected_mail_source_policy_revoked");
    const beforeOldInputReplay = await state(privateTables);
    await initInput(lineageA, [processorP, processorQ]);
    await owner.transport.call("draft_protected_mail_instruction", lineageDraftArgs);
    await appendInput(lineageSeal, key("1"), `${marker}_lineage_output`);
    assert.deepEqual(await state(privateTables), beforeOldInputReplay, "historical_input_replay_rewound_policy_or_head");
    await atomicDenied(() => initInput(lineageA, [processorP]), "protected_mail_source_policy_initialization_conflict");
    await inputSeal("revoked-instruction-still-trackable", [lineageB], [lineageA, lineageB]);
    console.log("PASS protected_mail_instructions_input_revocation_storage_and_inert_historical_replay");

    stage = "instruction_input_prospective_graph_depth_is_bounded";
    const boundedScope = scope("governed-input-depth-bound");
    let boundedParents: SourceRef[] = [];
    for (let generation = 1; generation <= 32; generation++) {
      const event = createHash("sha256").update(`instruction-input-depth-${generation}`).digest("hex");
      await draft(boundedScope, generation - 1, event, `${marker}_bounded_${generation}`);
      const bounded = await assertReview("governed-input-depth-bound", `${marker}_bounded_${generation}`, "Draft", boundedParents);
      const reference = sourceReference(bounded.reference);
      await initInput(reference, [processorP]);
      boundedParents = references([...boundedParents, reference]);
    }
    await atomicDenied(() => draft(boundedScope, 32, key("f"), `${marker}_depth_overflow`), "protected_mail_source_graph_bounds");
    assert.equal(Number((await review("governed-input-depth-bound")).generation), 32, "depth_overflow_advanced_instruction_head");
    assert.equal((await publisher.transport.sql<Row>("SELECT * FROM protected_mail_instruction_revision WHERE head_id = ?", [boundedParents[0][0]])).length, 32, "depth_overflow_truncated_or_inserted_revision");
    assert.deepEqual(await state([...effectsTables, ...(inputBaseline ? authorityTables : [])]), inputEffectsBefore, "instruction_input_management_changed_runtime_or_authority");
    console.log("PASS protected_mail_instructions_input_graph_bounds_and_no_runtime_effect");

    stage = "logout_view_fence_and_retained_disconnect_management";
    const currentLiteral = await review("literal-main");
    const beforeLogout = await state(instructionTables);
    await owner.transport.call("logout", []);
    assert.equal((await owner.transport.sql("SELECT * FROM my_protected_mail_instructions")).length, 0, "logged_out_review_projection");
    await eventually(() => cache(owner.live, "my_protected_mail_instructions").count() === 0n);
    await denied(draft(literalScope, Number(currentLiteral.generation), key("e"), literalBody));
    await denied(approve(literalScope, Number(currentLiteral.generation), key("e"), sourceReference(currentLiteral.reference)));
    await denied(revoke(literalScope, Number(currentLiteral.generation), key("e"), sourceReference(currentLiteral.reference)));
    assert.deepEqual(await state(instructionTables), beforeLogout, "logged_out_actor_changed_instruction_state");
    await owner.transport.call("login", ["instruction-owner@example.test", password]);
    await eventually(() => reviewCache("literal-main")?.status === "InstructionApproved");
    const beforeDelete = await state(privateTables);
    await owner.transport.call("delete_mail_connection", [connection.id]);
    assert.deepEqual(await state(privateTables), beforeDelete, "disconnect_erased_instruction_or_source_history");
    await draft(literalScope, Number(currentLiteral.generation), key("e"), `${marker}_retained_owner_edit`);
    const retainedEdit = await assertReview("literal-main", `${marker}_retained_owner_edit`, "Draft", []);
    await noAuthorityEffect(() => approve(literalScope, Number(retainedEdit.generation), key("f"), sourceReference(retainedEdit.reference)));
    const retainedApproval = await assertReview("literal-main", `${marker}_retained_owner_edit`, "InstructionApproved", []);
    await noAuthorityEffect(() => revoke(literalScope, Number(retainedApproval.generation), key("0"), sourceReference(retainedApproval.reference)));
    await assertReview("literal-main", `${marker}_retained_owner_edit`, "InstructionRevoked", []);
    console.log("PASS protected_mail_instructions_logout_fence_and_retained_owner_management");

    stage = "ordinary_export_and_worker_cache_exclusions";
    const queryBatches: string[][] = [];
    const builder = { onApplied: (_callback: () => void) => builder, onError: (_callback: (_context: unknown, error: unknown) => void) => builder,
      subscribe: (queries: string[]) => { queryBatches.push(queries); } };
    subscribeToAvailableTables({ subscriptionBuilder: () => builder }, "[instruction-fixture]", () => {});
    const broadQueries = queryBatches.flat();
    assert.ok(!broadQueries.some(query => query.includes("my_protected_mail_instructions")), "worker_auto_subscribed_instruction_review");
    const exportQueries = snapshotExportQueriesV2();
    assert.ok(!exportQueries.some(query => query.includes("my_protected_mail_instructions")), "export_hydrated_instruction_review");
    for (const table of instructionTables) {
      assert.ok(!SNAPSHOT_TABLES_V2.includes(table as typeof SNAPSHOT_TABLES_V2[number]), "private_instruction_exportable");
      assert.ok(!exportQueries.some(query => query.includes(table)), "export_hydrated_private_instruction");
      assert.ok(!broadQueries.some(query => query.includes(table)), "worker_auto_subscribed_private_instruction");
    }
    await subscribe(owner, exportQueries);
    const snapshot = buildPearSnapshotV2(owner.live.db, { wsUri: base, dbName: name, tablesRegistry: tables });
    assert.ok(!containsMarker(snapshot), "ordinary_snapshot_contains_instruction_content");
    for (const table of SNAPSHOT_TABLES_V2) assert.ok(!containsMarker(await publisher.transport.sql(`SELECT * FROM ${table}`)), "ordinary_surface_contains_instruction_content");
    assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), retainedOwnerRows, "instruction_lifecycle_changed_mail_owner_history");
    const beforeRestore = await state(privateTables);
    await denied(owner.transport.call("import_pear_snapshot_v_1", [JSON.stringify({ format: "pear-snapshot-v1", tables: {} })]), "protected_mail_restore_not_supported");
    await denied(owner.transport.call("import_v_2_begin", [JSON.stringify({ format: "pear-snapshot-v2" })]), "protected_mail_restore_not_supported");
    assert.deepEqual(await state(privateTables), beforeRestore, "ordinary_restore_changed_instruction_history");
    console.log("PASS protected_mail_instructions_no_ordinary_projection_or_runtime_activation");
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
  console.error(`FAIL protected_mail_instructions_e2e stage=${stage}`);
  process.exitCode = 1;
});
