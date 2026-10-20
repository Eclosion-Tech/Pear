/** Disposable local-promotion conformance against localhost SpacetimeDB 2.0.3.
 * No mailbox, model, worker, real credential or production workspace is used.
 * PEAR_ADMISSION_BASELINE_WASM optionally seeds S2b1 state before an additive
 * upgrade. PEAR_ADMISSION_RESTART_PHASE=seed|resume uses a caller-owned private
 * checkpoint; only the caller restarts/removes the entire disposable server.
 * Output contains fixed stage codes only, never fixture values or raw errors.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { setGlobalLogLevel } from "spacetimedb";
import { DbConnection, tables } from "../src/module_bindings/index.js";
import { HttpStdbTransport } from "../../web/src/lib/api-endpoint/http-transport.js";
import { decodeOptionSome } from "../../web/src/lib/api-endpoint/codec.js";
import { buildPearSnapshotV2, SNAPSHOT_TABLES_V2, snapshotExportQueriesV2 } from "../../packages/snapshot-core/src/index.js";
import { subscribeToAvailableTables } from "../src/subscriptions.js";
import { drainFixtureConnections, retainFixtureDatabaseUntilServerCleanup } from "./protected-mail-fixture-lifecycle.js";
import { prepareMailAppend } from "../../packages/sentinel/src/index.js";

type Row = Record<string, unknown>;
type IdentityToken = { identity: string; token: string };
type Actor = IdentityToken & { transport: HttpStdbTransport; live: DbConnection };
type SourceRef = [string, number, string];
type InstructionScope = [number, number, string, number, string];
type Checkpoint = {
  version: 1; base: string; name: string; actors: Record<string, IdentityToken>;
  expected: Record<string, Row[]>; replay: unknown[]; spent: unknown[]; issue: unknown[];
  ownerMailView: Row[]; ownerInstructionView: Row[];
};

const none = { none: [] };
const ident = (hex: string) => [`0x${hex.replace(/^0x/, "")}`];
const marker = `S2B_PRIVATE_SYNTHETIC_${randomBytes(12).toString("hex")}`;
const password = "synthetic-local-fixture-password";
const retainedTables = [
  "protected_mail_collection", "protected_mail_source", "protected_mail_record", "protected_mail_receipt",
  "protected_mail_source_policy_head", "protected_mail_source_policy_history", "protected_mail_context", "protected_mail_exposure", "protected_mail_derivation",
  "protected_mail_instruction_head", "protected_mail_instruction_revision", "protected_mail_instruction_decision",
  "protected_mail_connection_authority_head", "protected_mail_connection_authority_history",
  "protected_mail_processor_head", "protected_mail_processor_revision", "protected_mail_processor_event",
] as const;
const effectsTables = ["page", "page_content", "component_node", "page_access_rule", "mail_import_receipt", "orcha_job", "orcha_task", "conversation", "conversation_message", "bridge_command", "automation_event_queue"] as const;
const admissionTables = ["protected_mail_summary_grant", "protected_mail_summary_grant_event", "protected_mail_summary_run", "protected_mail_summary_budget", "protected_mail_summary_admission_receipt", "protected_mail_committed_summary"] as const;
const privateTables = [...retainedTables, ...admissionTables];
let stage = "localhost_guard";
let failureReason = "assertion_failed";

function localBase(raw: string): string {
  const value = new URL(raw);
  assert.equal(raw, raw.trim(), "invalid_local_base");
  assert.equal(value.protocol, "http:", "localhost_http_required");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(value.hostname), "localhost_required");
  assert.ok(!value.username && !value.password && !value.search && !value.hash && value.pathname === "/", "origin_only_required");
  assert.ok(!raw.includes("?") && !raw.includes("#"), "origin_only_required");
  return value.origin;
}

function sorted(rows: Row[]): Row[] { return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); }
function containsMarker(value: unknown): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(item => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)
      && Buffer.from(value as number[]).toString("utf8").includes(marker)) return true;
    return value.some(containsMarker);
  }
  return value !== null && typeof value === "object" && Object.values(value).some(containsMarker);
}
function reference(value: unknown): SourceRef {
  if (Array.isArray(value)) { assert.equal(value.length, 3, "reference_shape"); return [String(value[0]), Number(value[1]), String(value[2])]; }
  assert.ok(value && typeof value === "object", "reference_shape");
  const row = value as Row;
  return [String(row.id), Number(row.revision), String(row.digest)];
}
function scopeOf(value: unknown): InstructionScope {
  if (Array.isArray(value)) { assert.equal(value.length, 5, "scope_shape"); return [Number(value[0]), Number(value[1]), String(value[2]), Number(value[3]), String(value[4])]; }
  assert.ok(value && typeof value === "object", "scope_shape");
  const row = value as Row;
  return [Number(row.format_version), Number(row.scope_version), String(row.purpose), Number(row.collection_id), String(row.instruction_key)];
}
function event(label: string): string { return createHash("sha256").update(`local-admission-${label}`).digest("hex"); }
async function denied(operation: Promise<unknown>, code?: string): Promise<string> {
  try { await operation; }
  catch (error) {
    assert.ok(error instanceof Error, "denial_error_required");
    assert.ok(!containsMarker(error.message), "denial_contains_private_marker");
    if (code && !error.message.includes(code)) {
      // Whitelist only host-authored diagnostics; never print a raw response.
      const known = ["protected_mail_summary_owner_required", "protected_mail_summary_service_required", "protected_mail_summary_instruction_stale",
        "protected_mail_summary_stage_required", "protected_mail_summary_stage_not_allowed", "protected_mail_summary_instruction_source_required",
        "protected_mail_summary_mail_source_required", "protected_mail_source_policy_required", "protected_mail_summary_invalid_request",
        "protected_mail_summary_grant_not_active", "protected_mail_summary_budget_exceeded", "protected_mail_summary_grant_revoked",
        "protected_mail_summary_effect_consumed", "protected_mail_summary_run_limit"];
      failureReason = known.find(value => error.message.includes(value)) ?? "unexpected_denial_code";
      assert.fail("unexpected_denial_code");
    }
    return error.message.match(/protected_mail_[a-z_]+/)?.[0] ?? "decoder_denial";
  }
  assert.fail("operation_unexpectedly_accepted");
}

async function main(): Promise<void> {
  const base = localBase(process.argv[2] ?? "http://127.0.0.1:3099");
  assert.ok(process.argv.length <= 3, "unexpected_arguments");
  const retainUntilServerCleanup = retainFixtureDatabaseUntilServerCleanup();
  const restartPhase = process.env.PEAR_ADMISSION_RESTART_PHASE;
  const checkpointPath = process.env.PEAR_ADMISSION_RESTART_STATE_FILE;
  assert.ok(restartPhase === undefined || restartPhase === "seed" || restartPhase === "resume", "invalid_restart_phase");
  assert.ok(!restartPhase || checkpointPath, "restart_checkpoint_required");
  assert.ok(restartPhase || !checkpointPath, "restart_phase_required");
  let checkpoint: Checkpoint | undefined;
  if (restartPhase === "resume") {
    const info = await lstat(checkpointPath!);
    assert.ok(info.isFile() && info.size > 0 && info.size <= 8 * 1024 * 1024 && (info.mode & 0o777) === 0o600, "invalid_restart_checkpoint_file");
    const value: unknown = JSON.parse(await readFile(checkpointPath!, "utf8"));
    assert.ok(value && typeof value === "object", "invalid_restart_checkpoint");
    const candidate = value as Checkpoint;
    assert.equal(candidate.version, 1, "invalid_restart_checkpoint_version");
    assert.equal(candidate.base, base, "restart_origin_mismatch");
    assert.ok(/^pear-protected-admission-e2e-[0-9]+-[0-9a-f]{12}$/.test(candidate.name), "invalid_restart_database");
    assert.ok(candidate.actors && typeof candidate.actors === "object", "invalid_restart_identities");
    for (const key of ["publisher", "service", "owner"]) {
      const account = candidate.actors[key];
      assert.ok(account && /^[0-9a-f]{64}$/i.test(account.identity.replace(/^0x/, ""))
        && typeof account.token === "string" && account.token.length > 0 && account.token.length <= 8192, "invalid_restart_identity");
    }
    assert.ok(candidate.expected && typeof candidate.expected === "object" && Object.keys(candidate.expected).length === privateTables.length
      && privateTables.every(table => Array.isArray(candidate.expected[table]) && candidate.expected[table].every(row => row !== null && typeof row === "object" && !Array.isArray(row))), "invalid_restart_expected_state");
    assert.ok(Array.isArray(candidate.replay) && candidate.replay.length === 4 && Array.isArray(candidate.spent) && candidate.spent.length === 4
      && Array.isArray(candidate.issue) && candidate.issue.length === 14
      && Array.isArray(candidate.ownerMailView) && Array.isArray(candidate.ownerInstructionView), "invalid_restart_replay_state");
    checkpoint = candidate;
  }
  setGlobalLogLevel("error");
  const fixedLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("%c")) { fixedLog("WARN protected_mail_admission_sdk_diagnostic"); return; }
    fixedLog(...args);
  };
  const name = checkpoint?.name ?? `pear-protected-admission-e2e-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const databaseUrl = `${base}/v1/database/${name}`;
  const connections: DbConnection[] = [];
  let publisherIdentity: IdentityToken | undefined;
  let moduleIdentity: string | undefined;
  let retainFixture = false;
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
    assert.ok(/^[0-9a-f]{64}$/i.test(value.identity.replace(/^0x/, "")) && typeof value.token === "string" && value.token.length > 0, "identity_invalid");
    return value;
  }
  async function connect(value: IdentityToken): Promise<Actor> {
    const live = await new Promise<DbConnection>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connection_timeout")), 12000);
      const connection = DbConnection.builder().withUri(base).withDatabaseName(name).withToken(value.token)
        .onConnect(connected => { clearTimeout(timer); resolve(connected); })
        .onConnectError(() => { clearTimeout(timer); reject(new Error("connection_failed")); }).build();
      connections.push(connection);
    });
    return { ...value, live, transport: new HttpStdbTransport({ baseUrl: base, dbName: name, token: value.token, fetchImpl: localFetch, timeoutMs: 15000 }) };
  }
  async function actor(): Promise<Actor> { return connect(await identity()); }
  async function privateSubscriptionDenied(account: Actor, table: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("private_subscription_timeout")), 12000);
      account.live.subscriptionBuilder().onApplied(() => { clearTimeout(timer); reject(new Error("private_subscription_accepted")); })
        .onError(() => { clearTimeout(timer); resolve(); }).subscribe([`SELECT * FROM ${table}`]);
    });
  }
  async function publish(wasm: Uint8Array, upgrade = false): Promise<void> {
    assert.ok(publisherIdentity, "publisher_required");
    let suffix = "";
    if (upgrade) {
      const response = await localFetch(`${databaseUrl}/pre_publish`, { method: "POST", headers: { Authorization: `Bearer ${publisherIdentity.token}` }, body: new Uint8Array(wasm), signal: AbortSignal.timeout(60000) });
      assert.ok(response.ok, "upgrade_plan_failed");
      const value = await response.json() as { AutoMigrate?: { break_clients: boolean; token?: string } };
      assert.ok(value.AutoMigrate, "additive_upgrade_required");
      if (value.AutoMigrate.break_clients) { assert.ok(value.AutoMigrate.token, "migration_token_required"); suffix = `?policy=BreakClients&token=${encodeURIComponent(value.AutoMigrate.token)}`; }
    }
    const response = await localFetch(databaseUrl + suffix, { method: "PUT", headers: { Authorization: `Bearer ${publisherIdentity.token}` }, body: new Uint8Array(wasm), signal: AbortSignal.timeout(60000) });
    assert.ok(response.ok, "module_publish_failed");
    const result: unknown = await response.json();
    const findIdentity = (value: unknown): string | undefined => {
      if (typeof value === "string" && /^(0x)?[0-9a-f]{64}$/i.test(value)) return value.replace(/^0x/, "").toLowerCase();
      if (Array.isArray(value)) return value.map(findIdentity).find(value => value !== undefined);
      if (value !== null && typeof value === "object") {
        const row = value as Row;
        for (const key of ["identity", "database_identity", "Success", "success", "Updated", "updated", "Created", "created"]) {
          const found = findIdentity(row[key]);
          if (found) return found;
        }
      }
      return undefined;
    };
    moduleIdentity = findIdentity(result) ?? moduleIdentity;
  }
  try {
    if (checkpoint) {
      stage = "restart_retained_admission_and_replays";
      publisherIdentity = checkpoint.actors.publisher;
      const publisher = await connect(publisherIdentity), service = await connect(checkpoint.actors.service), owner = await connect(checkpoint.actors.owner);
      const state = async () => Object.fromEntries(await Promise.all(privateTables.map(async table => [table, sorted(await publisher.transport.sql<Row>(`SELECT * FROM ${table}`))])));
      assert.deepEqual(await state(), checkpoint.expected, "restart_changed_private_state");
      assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), checkpoint.ownerMailView, "restart_changed_mail_owner_history");
      assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions")), checkpoint.ownerInstructionView, "restart_changed_instruction_owner_history");
      await owner.transport.call("issue_protected_mail_summary_grant", checkpoint.issue);
      await service.transport.call("admit_and_promote_protected_mail_derivation", checkpoint.replay);
      await denied(service.transport.call("admit_and_promote_protected_mail_derivation", checkpoint.spent), "protected_mail_summary_budget_exceeded");
      assert.deepEqual(await state(), checkpoint.expected, "restart_replay_refilled_or_repromoted");
      console.log("PASS protected_mail_admission_restart_retained_state_and_spent_budget");
      stage = "complete";
      return;
    }
    stage = "publish_fixture";
    const currentWasm = await readFile(process.env.PEAR_PROTECTED_MAIL_WASM
      ?? new URL("../../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm", import.meta.url));
    const baselinePath = process.env.PEAR_ADMISSION_BASELINE_WASM || undefined;
    const baselineWasm = baselinePath ? await readFile(baselinePath) : undefined;
    assert.ok(currentWasm.length > 0 && (!baselineWasm || baselineWasm.length > 0 && !baselineWasm.equals(currentWasm)), "distinct_module_artifacts_required");
    publisherIdentity = await identity();
    await publish(baselineWasm ?? currentWasm);
    let publisher = await connect(publisherIdentity);
    let admin = await actor(), owner = await actor(), other = await actor(), ai = await actor(), hybrid = await actor(), anonymous = await actor(), service = await actor(), unbound = await actor();
    stage = "fixture_accounts";
    await admin.transport.call("register", ["admission-admin@example.test", "Fixture admin", password]);
    for (const [account, email] of [[owner, "admission-owner@example.test"], [other, "admission-other@example.test"]] as const) {
      await admin.transport.call("create_local_user", [email, "Fixture member", password]);
      await account.transport.call("login", [email, password]);
    }
    const makeAi = (account: Actor) => publisher.transport.call("create_ai_user", [ident(account.identity), ident(admin.identity), "Fixture AI", { anthropic: [] }, "synthetic-model", none, none, none, none, none]);
    await makeAi(ai); await makeAi(hybrid);
    await hybrid.transport.call("login", ["admission-owner@example.test", password]);
    const keyId = event("mail-key");
    await publisher.transport.call("publish_mail_encryption_key", ["{}", keyId]);
    const credential = JSON.stringify({ v: 1, keyId, key: "synthetic", nonce: "synthetic", ciphertext: "synthetic" });
    async function state(names: readonly string[] = privateTables): Promise<Record<string, Row[]>> {
      return Object.fromEntries(await Promise.all(names.map(async table => [table, sorted(await publisher.transport.sql<Row>(`SELECT * FROM ${table}`))])));
    }
    async function atomicDenial(operation: () => Promise<unknown>, code?: string): Promise<void> {
      const before = await state();
      await denied(operation(), code);
      assert.deepEqual(await state(), before, "rejected_admission_write_not_atomic");
    }
    async function subscribe(account: Actor, queries: string[]): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("subscription_timeout")), 12000);
        account.live.subscriptionBuilder().onApplied(() => { clearTimeout(timer); resolve(); })
          .onError(() => { clearTimeout(timer); reject(new Error("subscription_failed")); }).subscribe(queries);
      });
    }
    type Unit = { id: number; scope: InstructionScope; instruction: SourceRef; instructionGeneration: number; decision: string; source: SourceRef; stages: SourceRef[]; runtime: string };
    async function review(s: InstructionScope): Promise<Row> {
      const row = (await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions"))
        .find(row => JSON.stringify(scopeOf(row.scope)) === JSON.stringify(s));
      assert.ok(row, "instruction_review_missing");
      return row;
    }
    async function seedUnit(label: string, count = 3): Promise<Unit> {
      await owner.transport.call("create_mail_connection", ["Fixture mailbox", "imap.example.test", 993, "fixture@example.test", credential, "INBOX", { some: "Sent" }, none, 0]);
      const row = (await owner.transport.sql<Row>("SELECT * FROM mail_connection")).sort((a, b) => Number(a.id) - Number(b.id)).at(-1);
      assert.ok(row, "connection_missing");
      const id = Number(row.id), runtime = `admission-${label}`;
      await owner.transport.call("set_mail_connection_enabled", [id, false]);
      await publisher.transport.call("create_protected_mail_collection", [id]);
      const e = event(`mail-${label}`);
      await publisher.transport.call("append_protected_mail_message", [id, e, ["INBOX", "7", 1, { received: [] }, "2026-10-19T12:00:00Z", "sender@example.test", "owner@example.test", "", `${marker}_${label}`, `Literal ${marker}_${label}`, "Synthetic fixture", "fixture-v1"]]);
      const sourceRow = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_source WHERE collection_id = ?", [id])).find(value => String(value.id).endsWith(e));
      assert.ok(sourceRow, "source_missing");
      const source = reference(sourceRow);
      await publisher.transport.call("initialize_protected_mail_source_policy", [source, []]);
      const scope: InstructionScope = [1, 1, "mail.summary", id, "fixture-instruction"];
      await owner.transport.call("draft_protected_mail_instruction", [scope, 0, event(`${label}-draft-a`), `${marker}_instruction_a`]);
      const old = reference((await review(scope)).reference);
      await owner.transport.call("approve_protected_mail_instruction", [scope, 1, event(`${label}-approve-a`), old]);
      await owner.transport.call("revoke_protected_mail_instruction", [scope, 2, event(`${label}-revoke-a`), old]);
      await owner.transport.call("draft_protected_mail_instruction", [scope, 3, event(`${label}-draft-b`), `${marker}_instruction_b\r\n`]);
      const instruction = reference((await review(scope)).reference);
      await owner.transport.call("approve_protected_mail_instruction", [scope, 4, event(`${label}-approve-b`), instruction]);
      const approved = await review(scope);
      const decision = decodeOptionSome(approved.decision_id);
      assert.equal(typeof decision, "string", "approval_decision_missing");
      assert.ok(typeof decision === "string", "approval_decision_missing");
      if (!/^mail-instruction-decision:[a-f0-9]{64}$/.test(decision)) { failureReason = "fixture_decision_shape"; assert.fail("fixture_decision_shape"); }
      await publisher.transport.call("initialize_protected_mail_source_policy", [instruction, []]);
      const stages: SourceRef[] = [];
      for (let i = 0; i < count; i++) {
        const run = `stage-${label}-${i}`, ev = event(run);
        await publisher.transport.call("record_protected_mail_exposure", [id, runtime, run, 0, ev, [source, instruction], []]);
        const seal = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_exposure")).find(value => value.run_id === run && Number(value.collection_id) === id);
        assert.ok(seal, "exposure_missing");
        const body = `\t${marker}_${label}_${i} 🍐\u2028e\u0301\r\n"quoted"\\\t`;
        await publisher.transport.call("append_protected_mail_derivation", [id, runtime, run, seal.id, ev, body, "fixture-derived-v1"]);
        const derived = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_derivation")).find(value => value.event_key === ev && Number(value.collection_id) === id);
        assert.ok(derived, "derivation_missing");
        const stageRef: SourceRef = [String(derived.source_id), Number(derived.revision), String(derived.digest)];
        await publisher.transport.call("initialize_protected_mail_source_policy", [stageRef, []]);
        stages.push(stageRef);
      }
      await publisher.transport.call("initialize_protected_mail_connection_authority", [id]);
      return { id, scope, instruction, instructionGeneration: Number(approved.generation), decision, source, stages, runtime };
    }
    stage = "seed_populated_s2b1_state";
    const mainUnit = await seedUnit("main", 4), retainedUnit = await seedUnit("retained", 1);
    await owner.transport.call("delete_mail_connection", [retainedUnit.id]);
    const processorConfig = [1, [0, []], "https://models.example.test/v1/messages", "fixture-model", "fixture-credential-handle", "version-a"];
    await publisher.transport.call("configure_protected_mail_processor", ["fixture-retained-profile", 0, event("processor-a"), processorConfig]);
    await publisher.transport.call("configure_protected_mail_processor", ["fixture-retained-profile", 1, event("processor-b"), [...processorConfig.slice(0, 5), "version-b"]]);
    await publisher.transport.call("retire_protected_mail_processor", ["fixture-retained-profile", 2, event("processor-retire")]);
    const oldState = await state(retainedTables), oldMailView = sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), oldInstructionView = sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions"));
    if (baselineWasm) {
      stage = "additive_upgrade_retains_all_s2b1_state";
      for (const live of connections) live.disconnect();
      await publish(currentWasm, true);
      [publisher, admin, owner, other, ai, hybrid, anonymous, service, unbound] = await Promise.all([publisher, admin, owner, other, ai, hybrid, anonymous, service, unbound].map(connect));
      assert.deepEqual(await state(retainedTables), oldState, "upgrade_changed_existing_private_state");
      assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), oldMailView, "upgrade_changed_owner_mail_history");
      assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions")), oldInstructionView, "upgrade_changed_owner_instruction_history");
      console.log("PASS protected_mail_admission_retained_s2b1_upgrade");
    }
    for (const rows of Object.values(await state(admissionTables))) assert.equal(rows.length, 0, "automatic_authority_or_admission_backfill");
    console.log("PASS protected_mail_admission_no_automatic_backfill");

    stage = "isolated_fence_fixtures";
    const instructionUnit = await seedUnit("instruction", 2), sourceUnit = await seedUnit("source", 1), stageUnit = await seedUnit("stage-policy", 1), contextUnit = await seedUnit("context", 1), epochUnit = await seedUnit("epoch", 2), logoutUnit = await seedUnit("logout", 2), aiServiceUnit = await seedUnit("ai-service", 1), byteUnit = await seedUnit("bytes", 2), ttlUnit = await seedUnit("ttl", 2), acknowledgementUnit = await seedUnit("acknowledgement", 1);
    const effectsBefore = await state(effectsTables);
    const mailViewBefore = sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail"));
    const promote = (account: Actor, grant: string, run: string, source: SourceRef, nonce: string) => account.transport.call("admit_and_promote_protected_mail_derivation", [grant, run, source, nonce]);
    const start = (grant: string, run: string, parent?: string, account = service) => account.transport.call("start_protected_mail_summary_run", [grant, run, parent === undefined ? none : { some: parent }]);
    async function grantArgs(unit: Unit, label: string, limits: { ops?: number; bytes?: number; perOp?: number; start?: number; expiry?: number; stages?: SourceRef[]; actor?: Actor } = {}): Promise<unknown[]> {
      const authority = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_connection_authority_head WHERE connection_id = ?", [unit.id]))[0];
      assert.ok(authority, "authority_missing");
      const now = Date.now();
      const args = [event(`grant-${label}`), unit.id, Number(authority.epoch), ident((limits.actor ?? service).identity), unit.runtime, unit.instruction, unit.instructionGeneration, unit.decision,
        limits.stages ?? unit.stages, limits.start ?? now - 1000, limits.expiry ?? now + 600000, limits.ops ?? 10, limits.bytes ?? 1000000, limits.perOp ?? 512 * 1024];
      if (!(Number(authority.epoch) > 0 && unit.instructionGeneration > 0)) { failureReason = "fixture_grant_generation"; assert.fail("fixture_grant_generation"); }
      return args;
    }
    async function issue(unit: Unit, label: string, limits: Parameters<typeof grantArgs>[2] = {}): Promise<unknown[]> {
      const args = await grantArgs(unit, label, limits);
      await owner.transport.call("issue_protected_mail_summary_grant", args);
      return args;
    }
    async function closure(root: SourceRef): Promise<SourceRef[]> {
      const sourceRows = await publisher.transport.sql<Row>("SELECT * FROM protected_mail_source"), derivedRows = await publisher.transport.sql<Row>("SELECT * FROM protected_mail_derivation"), instructionRows = await publisher.transport.sql<Row>("SELECT * FROM protected_mail_instruction_revision");
      const found = new Map<string, SourceRef>();
      function visit(r: SourceRef): void {
        const key = JSON.stringify(r.slice(0, 2));
        if (found.has(key)) { assert.deepEqual(found.get(key), r, "source_conflict"); return; }
        found.set(key, r);
        const row = sourceRows.find(row => row.id === r[0] && Number(row.revision) === r[1])
          ?? derivedRows.find(row => row.source_id === r[0] && Number(row.revision) === r[1])
          ?? instructionRows.find(row => row.head_id === r[0] && Number(row.revision) === r[1]);
        assert.ok(row && row.digest === r[2], "closure_source_missing");
        for (const parent of (row.parents ?? []) as unknown[]) visit(reference(parent));
      }
      visit(root);
      return [...found.values()];
    }
    async function prepared(unit: Unit, stageRef: SourceRef, run: string, parentRunId?: string) {
      const row = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_derivation")).find(value => value.source_id === stageRef[0]);
      const authority = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_connection_authority_head WHERE connection_id = ?", [unit.id]))[0];
      assert.ok(row && authority && moduleIdentity, "frozen_append_binding_required");
      const object = (r: SourceRef) => ({ id: r[0], revision: String(r[1]), digest: r[2] });
      const result = await prepareMailAppend({ scope: { workspaceId: moduleIdentity, principalId: owner.identity.replace(/^0x/, ""), runtimeId: unit.runtime, runId: run, ...(parentRunId ? { parentRunId } : {}) }, connectionId: String(unit.id), epoch: Number(authority.epoch), destination: { workspaceId: moduleIdentity, rootId: String(unit.id), ownerId: owner.identity.replace(/^0x/, "") } },
        { body: row.body, contractVersion: 1, kind: "mail.summary", parents: (await closure(stageRef)).map(object), sanitizationVersion: row.sanitization_version, stage: object(stageRef) });
      assert.equal(result.status, "prepared", "frozen_append_preparation_failed");
      if (result.status !== "prepared") assert.fail("frozen_append_preparation_failed");
      return result.request;
    }
    async function negativeStage(label: string, roots: SourceRef[]): Promise<SourceRef> {
      const run = `negative-${label}`, nonce = event(run);
      await publisher.transport.call("record_protected_mail_exposure", [mainUnit.id, mainUnit.runtime, run, 0, nonce, roots, []]);
      const exposure = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_exposure")).find(row => row.run_id === run && Number(row.collection_id) === mainUnit.id);
      assert.ok(exposure, "negative_stage_exposure_missing");
      await publisher.transport.call("append_protected_mail_derivation", [mainUnit.id, mainUnit.runtime, run, exposure.id, nonce, `${marker}_${label}`, "fixture-derived-v1"]);
      const derivation = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_derivation")).find(row => row.event_key === nonce && Number(row.collection_id) === mainUnit.id);
      assert.ok(derivation, "negative_stage_missing");
      const value: SourceRef = [String(derivation.source_id), Number(derivation.revision), String(derivation.digest)];
      await publisher.transport.call("initialize_protected_mail_source_policy", [value, []]);
      return value;
    }
    stage = "seed_without_instruction_stage";
    const noInstruction = await negativeStage("without-instruction", [mainUnit.source]);
    stage = "seed_without_mail_stage";
    const noMail = await negativeStage("without-mail", [mainUnit.instruction]);
    for (const [label, candidate, code] of [["missing-instruction", noInstruction, "protected_mail_summary_instruction_source_required"],
      ["missing-mail", noMail, "protected_mail_summary_mail_source_required"]] as const) {
      stage = `required_closure_${label.replaceAll("-", "_")}`;
      await atomicDenial(async () => owner.transport.call("issue_protected_mail_summary_grant", await grantArgs(mainUnit, label, { stages: [candidate] })), code);
    }
    stage = "missing_instruction_ancestor_policy_blocks_staging";
    // Every valid derivation installs its own inherited policy. Exercise a
    // reachable missing policy instead of corrupting that private invariant.
    const unenrolledScope: InstructionScope = [1, 1, "mail.summary", mainUnit.id, "unenrolled-instruction"];
    await owner.transport.call("draft_protected_mail_instruction", [unenrolledScope, 0, event("unenrolled-draft"), `${marker}_unenrolled_instruction`]);
    const unenrolledInstruction = reference((await review(unenrolledScope)).reference);
    await owner.transport.call("approve_protected_mail_instruction", [unenrolledScope, 1, event("unenrolled-approval"), unenrolledInstruction]);
    const unenrolledEvent = event("unenrolled-stage");
    await publisher.transport.call("record_protected_mail_exposure", [mainUnit.id, mainUnit.runtime, "unenrolled-stage", 0, unenrolledEvent, [mainUnit.source, unenrolledInstruction], []]);
    const unenrolledSeal = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_exposure")).find(row => row.run_id === "unenrolled-stage" && Number(row.collection_id) === mainUnit.id);
    assert.ok(unenrolledSeal, "unenrolled_exposure_missing");
    await atomicDenial(() => publisher.transport.call("append_protected_mail_derivation", [mainUnit.id, mainUnit.runtime, "unenrolled-stage", unenrolledSeal.id, unenrolledEvent, `${marker}_denied_stage`, "fixture-derived-v1"]), "protected_mail_source_policy_required");
    console.log("PASS protected_mail_admission_requires_full_instruction_mail_and_stage_policy");
    stage = "private_protocol_and_management_identity_boundary";
    const generatedNames = Object.values(tables).map(table => table.sourceName);
    for (const table of privateTables) {
      assert.ok(!generatedNames.includes(table), "private_admission_has_public_binding");
      for (const account of [admin, owner, other, ai, hybrid, anonymous, service, unbound]) {
        await denied(account.transport.sql(`SELECT * FROM ${table}`));
        await privateSubscriptionDenied(account, table);
      }
    }
    const mainArgs = await grantArgs(mainUnit, "main", { ops: 2 });
    for (const account of [publisher, admin, other, ai, hybrid, anonymous, service, unbound]) {
      await atomicDenial(() => account.transport.call("issue_protected_mail_summary_grant", mainArgs), "protected_mail_summary_owner_required");
      await atomicDenial(() => account.transport.call("revoke_protected_mail_summary_grant", [mainArgs[0], event("wrong-role-revoke")]), "protected_mail_summary_owner_required");
      const missing = [...mainArgs]; missing[1] = 999999999;
      await atomicDenial(() => account.transport.call("issue_protected_mail_summary_grant", missing), "protected_mail_summary_owner_required");
    }
    await owner.transport.call("issue_protected_mail_summary_grant", mainArgs);
    const mainGrant = String(mainArgs[0]), rootRun = "main-root";
    await start(mainGrant, rootRun);
    for (const account of [publisher, admin, other, ai, hybrid, anonymous, service, unbound]) {
      await atomicDenial(() => account.transport.call("revoke_protected_mail_summary_grant", [mainGrant, event("existing-wrong-role-revoke")]), "protected_mail_summary_owner_required");
    }
    for (const account of [publisher, admin, owner, other, ai, hybrid, anonymous, unbound]) {
      const valid = await denied(start(mainGrant, "wrong-role-run", undefined, account));
      const missing = await denied(start(event("missing-grant"), "wrong-role-run", undefined, account));
      assert.equal(valid, missing, "grant_existence_oracle");
      const existingPromotion = await denied(promote(account, mainGrant, rootRun, mainUnit.stages[0], event("wrong-role-promote")));
      const missingPromotion = await denied(promote(account, event("missing-grant"), rootRun, mainUnit.stages[0], event("wrong-role-promote")));
      assert.equal(existingPromotion, missingPromotion, "promotion_existence_oracle");
    }
    const originalIssueState = await state(admissionTables);
    await owner.transport.call("issue_protected_mail_summary_grant", mainArgs);
    assert.deepEqual(await state(admissionTables), originalIssueState, "issue_replay_changed_state");
    await atomicDenial(() => owner.transport.call("issue_protected_mail_summary_grant", [...mainArgs.slice(0, 11), 3, ...mainArgs.slice(12)]));
    for (const index of [2, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
      const changed = [...await grantArgs(mainUnit, `invalid-${index}`)];
      changed[index] = index === 5 ? [mainUnit.instruction[0], mainUnit.instruction[1], "f".repeat(64)]
        : index === 7 ? event("missing-decision") : index === 8 ? [retainedUnit.stages[0]]
        : index === 2 || index === 6 ? 0 : index === 9 ? Number(changed[10])
        : index === 10 ? Number(changed[9]) + 3600001 : index === 13 ? 0 : Number.MAX_SAFE_INTEGER + 1;
      await atomicDenial(() => owner.transport.call("issue_protected_mail_summary_grant", changed));
    }
    for (const account of [publisher, admin, owner, ai, hybrid]) {
      await atomicDenial(async () => { await owner.transport.call("issue_protected_mail_summary_grant", await grantArgs(mainUnit, `invalid-service-${account.identity}`, { actor: account })); });
    }
    console.log("PASS protected_mail_admission_private_protocol_roles_and_closed_grants");

    stage = "same_stage_concurrent_children_and_frozen_payload_parity";
    const children = Array.from({ length: 10 }, (_, i) => `main-child-${i}`);
    await Promise.all(children.map(run => start(mainGrant, run, rootRun)));
    const raceBefore = await state(admissionTables);
    const onceRace = await Promise.allSettled(children.map(run => promote(service, mainGrant, run, mainUnit.stages[0], event(`once-${run}`))));
    assert.equal(onceRace.filter(result => result.status === "fulfilled").length, 1, "same_stage_multiple_winners");
    assert.equal(onceRace.filter(result => result.status === "rejected").length, 9, "same_stage_not_globally_consumed");
    for (const result of onceRace) if (result.status === "rejected") {
      assert.ok(result.reason instanceof Error && result.reason.message.includes("protected_mail_summary_effect_consumed"), "same_stage_unexpected_denial");
      assert.ok(!containsMarker(result.reason.message), "race_denial_contains_private_marker");
    }
    const receipts = await publisher.transport.sql<Row>("SELECT * FROM protected_mail_summary_admission_receipt"), summaries = await publisher.transport.sql<Row>("SELECT * FROM protected_mail_committed_summary");
    assert.equal(receipts.length, 1, "same_stage_created_multiple_receipts");
    assert.equal(summaries.length, 1, "same_stage_created_multiple_pointers");
    const receipt = receipts[0], winningRun = String(receipt.run_id);
    assert.ok(children.includes(winningRun), "receipt_not_bound_to_racing_run");
    const winningArgs = [mainGrant, winningRun, mainUnit.stages[0], event(`once-${winningRun}`)];
    const frozen = await prepared(mainUnit, mainUnit.stages[0], winningRun, rootRun);
    assert.equal(Number(receipt.append_bytes), frozen.operation.bytes, "whole_envelope_cost_mismatch");
    assert.equal(receipt.payload_digest, frozen.operation.payloadDigest, "payload_digest_not_exact_envelope");
    assert.equal(receipt.operation_fingerprint, frozen.fingerprint, "s0_operation_fingerprint_mismatch");
    assert.equal(Number(receipt.stage_policy_generation), 1, "stage_policy_generation_not_captured");
    const bindings = receipt.source_bindings as unknown[];
    const receiptSources = bindings.map(binding => reference(Array.isArray(binding) ? binding[0] : (binding as Row).source));
    assert.deepEqual(receiptSources, JSON.parse(new TextDecoder().decode(frozen.copyPayload())).parents.map(reference), "full_closure_not_frozen_in_receipt");
    assert.ok(bindings.every(binding => Number(Array.isArray(binding) ? binding[1] : (binding as Row).generation) === 1), "source_policy_generations_not_captured");
    assert.equal(Number(receipt.budget_generation), 2, "receipt_budget_generation_not_atomic");
    assert.equal(Number(receipt.remaining_operations), 1, "same_stage_debited_multiple_operations");
    assert.equal(Number(receipt.remaining_append_bytes), Number(mainArgs[12]) - frozen.operation.bytes, "same_stage_debited_wrong_bytes");
    assert.notEqual(receipt.payload_digest, mainUnit.stages[0][2], "stage_digest_substituted_for_payload_digest");
    assert.ok(frozen.operation.bytes > Buffer.byteLength(marker), "body_only_budget_accounting");
    assert.equal((await state(admissionTables)).protected_mail_summary_admission_receipt.length - raceBefore.protected_mail_summary_admission_receipt.length, 1, "duplicate_race_debit");
    const spentAfterOnce = await state(admissionTables);
    await service.transport.call("admit_and_promote_protected_mail_derivation", winningArgs);
    assert.deepEqual(await state(admissionTables), spentAfterOnce, "exact_promotion_replay_mutated_state");
    await atomicDenial(() => service.transport.call("admit_and_promote_protected_mail_derivation", [mainGrant, winningRun, mainUnit.stages[1], winningArgs[3]]));
    await atomicDenial(() => promote(service, mainGrant, rootRun, retainedUnit.stages[0], event("foreign-stage")), "protected_mail_summary_stage_not_allowed");
    await atomicDenial(() => promote(service, mainGrant, rootRun, [mainUnit.stages[1][0], mainUnit.stages[1][1], "f".repeat(64)], event("changed-stage-digest")), "protected_mail_summary_stage_not_allowed");
    await atomicDenial(() => service.transport.call("admit_and_promote_protected_mail_derivation", [...winningArgs, marker]));
    console.log("PASS protected_mail_admission_concurrent_once_and_frozen_bytes");

    stage = "global_once_across_grants_and_shared_operation_budget";
    const duplicateArgs = await issue(mainUnit, "duplicate-grant", { ops: 3 });
    await start(String(duplicateArgs[0]), "duplicate-root");
    const globalOnceBefore = await state(admissionTables);
    await denied(promote(service, String(duplicateArgs[0]), "duplicate-root", mainUnit.stages[0], event("duplicate-grant-promotion")), "protected_mail_summary_effect_consumed");
    assert.deepEqual(await state(admissionTables), globalOnceBefore, "new_grant_repromoted_same_stage_or_debited_budget");
    const lastOpRace = await Promise.allSettled(mainUnit.stages.slice(1, 3).map((r, i) => promote(service, mainGrant, children[i], r, event(`last-op-${i}`))));
    assert.equal(lastOpRace.filter(result => result.status === "fulfilled").length, 1, "shared_last_operation_not_atomic");
    assert.equal(lastOpRace.filter(result => result.status === "rejected").length, 1, "shared_last_operation_not_exhausted");
    for (const result of lastOpRace) if (result.status === "rejected") assert.ok(result.reason instanceof Error
      && result.reason.message.includes("protected_mail_summary_budget_exceeded") && !containsMarker(result.reason.message), "last_operation_unexpected_denial");
    assert.equal((await publisher.transport.sql<Row>("SELECT * FROM protected_mail_committed_summary")).length, 2, "last_operation_wrong_pointer_count");
    const spentArgs = [mainGrant, rootRun, mainUnit.stages[3], event("spent-budget-stage")];
    await atomicDenial(() => service.transport.call("admit_and_promote_protected_mail_derivation", spentArgs), "protected_mail_summary_budget_exceeded");
    const noRefill = await state(admissionTables);
    await owner.transport.call("issue_protected_mail_summary_grant", mainArgs);
    assert.deepEqual(await state(admissionTables), noRefill, "issue_replay_refilled_spent_budget");
    console.log("PASS protected_mail_admission_global_once_and_shared_operation_budget");

    stage = "whole_envelope_byte_budget_and_per_operation_limit";
    const stageCost = await prepared(byteUnit, byteUnit.stages[0], "byte-root");
    const secondCost = await prepared(byteUnit, byteUnit.stages[1], "byte-root");
    assert.equal(secondCost.operation.bytes, stageCost.operation.bytes, "byte_race_costs_not_equal");
    await atomicDenial(async () => owner.transport.call("issue_protected_mail_summary_grant", await grantArgs(byteUnit, "per-op-too-small", { perOp: stageCost.operation.bytes - 1 })), "protected_mail_summary_budget_exceeded");
    const byteArgs = await issue(byteUnit, "exact-byte", { ops: 3, bytes: stageCost.operation.bytes, perOp: stageCost.operation.bytes });
    await start(String(byteArgs[0]), "byte-root");
    const byteRace = await Promise.allSettled(byteUnit.stages.map((r, i) => promote(service, String(byteArgs[0]), "byte-root", r, event(`exact-byte-${i}`))));
    assert.equal(byteRace.filter(result => result.status === "fulfilled").length, 1, "shared_byte_budget_not_atomic");
    assert.equal(byteRace.filter(result => result.status === "rejected").length, 1, "shared_byte_budget_not_exhausted");
    for (const result of byteRace) if (result.status === "rejected") assert.ok(result.reason instanceof Error
      && result.reason.message.includes("protected_mail_summary_budget_exceeded") && !containsMarker(result.reason.message), "shared_byte_unexpected_denial");
    const byteReceipt = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_summary_admission_receipt")).find(row => row.grant_id === byteArgs[0]);
    assert.ok(byteReceipt && Number(byteReceipt.append_bytes) === stageCost.operation.bytes, "exact_byte_boundary_not_charged");
    assert.equal(Number(byteReceipt.remaining_append_bytes), 0, "exact_byte_budget_not_zero");
    const byteWinner = reference(byteReceipt.stage), byteLoser = byteUnit.stages.find(r => r[0] !== byteWinner[0]);
    assert.ok(byteLoser, "byte_race_loser_missing");
    const restartSpentArgs = [byteArgs[0], "byte-root", byteLoser, event("restart-spent-bytes")];
    await atomicDenial(() => service.transport.call("admit_and_promote_protected_mail_derivation", restartSpentArgs), "protected_mail_summary_budget_exceeded");
    const byteSnapshot = await state(admissionTables);
    await owner.transport.call("issue_protected_mail_summary_grant", byteArgs);
    await promote(service, String(byteArgs[0]), "byte-root", byteWinner, String(byteReceipt.event_nonce));
    assert.deepEqual(await state(admissionTables), byteSnapshot, "byte_budget_replay_refilled");
    console.log("PASS protected_mail_admission_exact_envelope_budget_and_per_op_bound");

    stage = "committed_local_effect_with_lost_client_acknowledgement";
    const ackArgs = await issue(acknowledgementUnit, "acknowledgement"), ackGrant = String(ackArgs[0]);
    await start(ackGrant, "ack-root");
    const ackReplay = [ackGrant, "ack-root", acknowledgementUnit.stages[0], event("lost-ack")];
    let committedResponseObserved = false;
    const lostAcknowledgement = new HttpStdbTransport({ baseUrl: base, dbName: name, token: service.token, timeoutMs: 15000,
      fetchImpl: async (input, init) => {
        const response = await localFetch(input, init);
        assert.ok(response.ok, "lost_ack_expected_successful_commit");
        committedResponseObserved = true;
        throw new Error("synthetic_client_acknowledgement_lost");
      } });
    await denied(lostAcknowledgement.call("admit_and_promote_protected_mail_derivation", ackReplay));
    assert.ok(committedResponseObserved, "lost_ack_did_not_follow_server_success");
    const afterLostAck = await state(admissionTables);
    assert.equal(afterLostAck.protected_mail_summary_admission_receipt.filter(row => row.grant_id === ackGrant).length, 1, "lost_ack_has_no_durable_receipt");
    await service.transport.call("admit_and_promote_protected_mail_derivation", ackReplay);
    assert.deepEqual(await state(admissionTables), afterLostAck, "lost_ack_retry_recharged_or_repromoted");
    console.log("PASS protected_mail_admission_lost_client_acknowledgement_exact_retry");

    stage = "run_parent_bounds_and_service_identity_change";
    await atomicDenial(() => start(mainGrant, "orphan-run", "missing-parent"));
    await atomicDenial(() => start(mainGrant, rootRun, "different-parent"));
    let parent = rootRun;
    for (let depth = 1; depth <= 15; depth++) { const run = `depth-${depth}`; await start(mainGrant, run, parent); parent = run; }
    await atomicDenial(() => start(mainGrant, "depth-overflow", parent));
    // Independent roots still count against the same grant's bounded run set.
    // duplicate-root already occupies one slot; no promotion budget is spent.
    for (let offset = 0; offset < 255; offset += 32) {
      await Promise.all(Array.from({ length: Math.min(32, 255 - offset) }, (_, i) => start(String(duplicateArgs[0]), `bounded-root-${offset + i}`)));
    }
    assert.equal((await publisher.transport.sql<Row>("SELECT * FROM protected_mail_summary_run")).filter(row => row.grant_id === duplicateArgs[0]).length, 256, "grant_run_limit_fixture_not_full");
    await atomicDenial(() => start(String(duplicateArgs[0]), "run-257"), "protected_mail_summary_run_limit");
    const changingService = await actor();
    const aiArgs = await issue(aiServiceUnit, "changing-service", { actor: changingService });
    await start(String(aiArgs[0]), "service-before-ai", undefined, changingService);
    await makeAi(changingService);
    await atomicDenial(() => start(String(aiArgs[0]), "service-after-ai", undefined, changingService));
    await atomicDenial(() => promote(changingService, String(aiArgs[0]), "service-before-ai", aiServiceUnit.stages[0], event("ai-service-promote")));
    console.log("PASS protected_mail_admission_run_tree_and_service_reclassification");

    stage = "grant_revocation_and_bounded_expiry_replays";
    const revokedArgs = await issue(mainUnit, "revoked"), revokedGrant = String(revokedArgs[0]);
    await start(revokedGrant, "revoked-root");
    const revokeArgs = [revokedGrant, event("revoke-grant")];
    await owner.transport.call("revoke_protected_mail_summary_grant", revokeArgs);
    const revokedState = await state(admissionTables);
    await owner.transport.call("revoke_protected_mail_summary_grant", revokeArgs);
    await owner.transport.call("issue_protected_mail_summary_grant", revokedArgs);
    assert.deepEqual(await state(admissionTables), revokedState, "old_issue_or_revoke_reactivated_grant");
    await atomicDenial(() => start(revokedGrant, "revoked-new-run"));
    const time = Date.now();
    const futureArgs = await issue(mainUnit, "not-before", { start: time + 10000, expiry: time + 60000 });
    await atomicDenial(() => start(String(futureArgs[0]), "future-root"));
    const expiryTime = Date.now();
    const expiringArgs = await issue(ttlUnit, "expiring", { start: expiryTime - 1000, expiry: expiryTime + 5000 });
    await start(String(expiringArgs[0]), "expiry-root");
    const expiryReplayArgs = [expiringArgs[0], "expiry-root", ttlUnit.stages[0], event("expiry-before-timeout")];
    await service.transport.call("admit_and_promote_protected_mail_derivation", expiryReplayArgs);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(expiringArgs[10]) - Date.now() + 100)));
    await atomicDenial(() => start(String(expiringArgs[0]), "expired-new-run"));
    await atomicDenial(() => promote(service, String(expiringArgs[0]), "expiry-root", ttlUnit.stages[1], event("expired-new-promotion")), "protected_mail_summary_grant_not_active");
    const expiredState = await state(admissionTables);
    await service.transport.call("admit_and_promote_protected_mail_derivation", expiryReplayArgs);
    assert.deepEqual(await state(admissionTables), expiredState, "completed_retry_changed_expired_grant");
    await owner.transport.call("revoke_protected_mail_summary_grant", [mainGrant, event("main-revoke")]);
    const completedRevoked = await state(admissionTables);
    await service.transport.call("admit_and_promote_protected_mail_derivation", winningArgs);
    await owner.transport.call("issue_protected_mail_summary_grant", mainArgs);
    assert.deepEqual(await state(admissionTables), completedRevoked, "completed_retry_reactivated_or_recharged_revoked_grant");
    await atomicDenial(() => promote(service, mainGrant, winningRun, mainUnit.stages[0], event("new-nonce-after-revoke")), "protected_mail_summary_grant_revoked");
    console.log("PASS protected_mail_admission_revocation_expiry_and_inert_completed_replay");

    stage = "current_instruction_decision_generation_and_aba";
    const instructionArgs = await issue(instructionUnit, "instruction"), instructionGrant = String(instructionArgs[0]);
    await start(instructionGrant, "instruction-root");
    const instructionReplay = [instructionGrant, "instruction-root", instructionUnit.stages[0], event("instruction-before-change")];
    await service.transport.call("admit_and_promote_protected_mail_derivation", instructionReplay);
    await owner.transport.call("revoke_protected_mail_instruction", [instructionUnit.scope, instructionUnit.instructionGeneration, event("instruction-revoke"), instructionUnit.instruction]);
    await atomicDenial(() => promote(service, instructionGrant, "instruction-root", instructionUnit.stages[1], event("instruction-revoked-promotion")), "protected_mail_summary_instruction_stale");
    await owner.transport.call("approve_protected_mail_instruction", [instructionUnit.scope, instructionUnit.instructionGeneration + 1, event("instruction-reapprove"), instructionUnit.instruction]);
    await atomicDenial(() => promote(service, instructionGrant, "instruction-root", instructionUnit.stages[1], event("instruction-aba-promotion")), "protected_mail_summary_instruction_stale");
    await owner.transport.call("draft_protected_mail_instruction", [instructionUnit.scope, instructionUnit.instructionGeneration + 2, event("instruction-edit"), `${marker}_new_instruction`]);
    await atomicDenial(() => start(instructionGrant, "instruction-edited-run"));
    const changedInstruction = await state();
    await service.transport.call("admit_and_promote_protected_mail_derivation", instructionReplay);
    assert.deepEqual(await state(), changedInstruction, "completed_retry_changed_after_own_instruction_edit");
    console.log("PASS protected_mail_admission_exact_current_instruction_and_decision_generation");

    stage = "source_ancestor_stage_policy_and_context_fences";
    for (const [unit, label, refToNarrow, storage, revoked] of [
      [sourceUnit, "ancestor", sourceUnit.source, true, true], [stageUnit, "stage", stageUnit.stages[0], false, false],
    ] as const) {
      const args = await issue(unit, label), grant = String(args[0]);
      await start(grant, `${label}-root`);
      await owner.transport.call("narrow_protected_mail_source_policy", [refToNarrow, 1, [], storage, revoked]);
      await atomicDenial(() => promote(service, grant, `${label}-root`, unit.stages[0], event(`${label}-narrowed`)));
    }
    const contextArgs = await issue(contextUnit, "context"), contextGrant = String(contextArgs[0]);
    await start(contextGrant, "context-root");
    const stageRow = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_derivation")).find(row => row.source_id === contextUnit.stages[0][0]);
    assert.ok(stageRow, "blocked_stage_context_missing");
    const contextRow = (await publisher.transport.sql<Row>("SELECT * FROM protected_mail_context")).find(row => row.id === stageRow.context_id);
    assert.ok(contextRow, "blocked_stage_context_missing");
    await publisher.transport.call("block_protected_mail_context", [contextUnit.id, contextRow.runtime_id, contextRow.run_id]);
    await atomicDenial(() => promote(service, contextGrant, "context-root", contextUnit.stages[0], event("blocked-context")));
    console.log("PASS protected_mail_admission_live_ancestral_policy_and_blocked_stage_context");

    stage = "epoch_password_pause_and_delete_fences";
    const epochArgs = await issue(epochUnit, "epoch"), epochGrant = String(epochArgs[0]);
    await start(epochGrant, "epoch-root");
    const epochReplayArgs = [epochGrant, "epoch-root", epochUnit.stages[0], event("epoch-before-change")];
    await service.transport.call("admit_and_promote_protected_mail_derivation", epochReplayArgs);
    await owner.transport.call("update_mail_connection_password", [epochUnit.id, credential]);
    await owner.transport.call("update_mail_connection_password", [epochUnit.id, credential]);
    await atomicDenial(() => promote(service, epochGrant, "epoch-root", epochUnit.stages[1], event("password-aba")));
    const postPassword = await state(admissionTables);
    await service.transport.call("admit_and_promote_protected_mail_derivation", epochReplayArgs);
    assert.deepEqual(await state(admissionTables), postPassword, "completed_retry_changed_after_password_aba");
    const pausedArgs = await issue(epochUnit, "paused"), pausedGrant = String(pausedArgs[0]);
    await start(pausedGrant, "paused-root");
    await owner.transport.call("set_mail_connection_enabled", [epochUnit.id, false]);
    await atomicDenial(() => promote(service, pausedGrant, "paused-root", epochUnit.stages[1], event("repeated-pause")));
    const deletedArgs = await issue(epochUnit, "deleted"), deletedGrant = String(deletedArgs[0]);
    await start(deletedGrant, "deleted-root");
    await owner.transport.call("delete_mail_connection", [epochUnit.id]);
    await atomicDenial(() => promote(service, deletedGrant, "deleted-root", epochUnit.stages[1], event("deleted-connection")));
    const completedBeforeDelete = await state(admissionTables);
    await service.transport.call("admit_and_promote_protected_mail_derivation", epochReplayArgs);
    assert.deepEqual(await state(admissionTables), completedBeforeDelete, "completed_retry_changed_after_own_connection_delete");
    console.log("PASS protected_mail_admission_epoch_aba_pause_and_delete");

    stage = "owner_logout_blocks_pending_service_effect";
    const logoutArgs = await issue(logoutUnit, "logout"), logoutGrant = String(logoutArgs[0]);
    await start(logoutGrant, "logout-root");
    const logoutReplay = [logoutGrant, "logout-root", logoutUnit.stages[0], event("logout-before-change")];
    await service.transport.call("admit_and_promote_protected_mail_derivation", logoutReplay);
    await owner.transport.call("logout", []);
    await atomicDenial(() => promote(service, logoutGrant, "logout-root", logoutUnit.stages[1], event("owner-logged-out")));
    const loggedOut = await state();
    await service.transport.call("admit_and_promote_protected_mail_derivation", logoutReplay);
    assert.deepEqual(await state(), loggedOut, "completed_retry_changed_while_owner_logged_out");
    await owner.transport.call("login", ["admission-owner@example.test", password]);
    console.log("PASS protected_mail_admission_owner_logout_fence");

    stage = "ordinary_projection_export_and_restore_exclusions";
    assert.deepEqual(await state(effectsTables), effectsBefore, "local_promotion_changed_ordinary_or_runtime_surfaces");
    assert.deepEqual(sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), mailViewBefore, "promotion_rewrote_existing_owner_mail_projection");
    const queryBatches: string[][] = [];
    const builder = { onApplied: (_callback: () => void) => builder, onError: (_callback: (_context: unknown, error: unknown) => void) => builder, subscribe: (queries: string[]) => { queryBatches.push(queries); } };
    subscribeToAvailableTables({ subscriptionBuilder: () => builder }, "[admission-fixture]", () => {});
    const broadQueries = queryBatches.flat(), exportQueries = snapshotExportQueriesV2();
    for (const table of privateTables) {
      assert.ok(!SNAPSHOT_TABLES_V2.includes(table as typeof SNAPSHOT_TABLES_V2[number]), "admission_table_exportable");
      assert.ok(!broadQueries.some(query => query.includes(table)) && !exportQueries.some(query => query.includes(table)), "private_admission_auto_subscribed_or_hydrated");
      for (const account of [owner, admin, other, ai, hybrid, service, anonymous]) await denied(account.transport.sql(`SELECT * FROM ${table}`));
      if (admissionTables.some(candidate => candidate === table)) {
        for (const account of [owner, admin, other, ai, hybrid, service, anonymous, unbound]) await privateSubscriptionDenied(account, table);
      }
    }
    await subscribe(owner, exportQueries);
    assert.ok(!containsMarker(buildPearSnapshotV2(owner.live.db, { wsUri: base, dbName: name, tablesRegistry: tables })), "ordinary_snapshot_contains_private_fixture");
    await atomicDenial(() => owner.transport.call("import_pear_snapshot_v_1", [JSON.stringify({ format: "pear-snapshot-v1", tables: {} })]), "protected_mail_restore_not_supported");
    await atomicDenial(() => owner.transport.call("import_v_2_begin", [JSON.stringify({ format: "pear-snapshot-v2" })]), "protected_mail_restore_not_supported");
    console.log("PASS protected_mail_admission_no_ordinary_projection_export_or_restore");

    if (restartPhase === "seed") {
      stage = "restart_checkpoint_write";
      const identityOnly = (account: Actor): IdentityToken => ({ identity: account.identity, token: account.token });
      const value: Checkpoint = { version: 1, base, name, actors: Object.fromEntries(Object.entries({ publisher, service, owner }).map(([key, account]) => [key, identityOnly(account)])),
        expected: await state(), replay: winningArgs, spent: restartSpentArgs, issue: mainArgs,
        ownerMailView: sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail")), ownerInstructionView: sorted(await owner.transport.sql<Row>("SELECT * FROM my_protected_mail_instructions")) };
      const handle = await open(checkpointPath!, "wx", 0o600);
      let written = false;
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); written = true; }
      finally { await handle.close(); if (!written) await unlink(checkpointPath!); }
      retainFixture = true;
      console.log("PASS protected_mail_admission_restart_checkpoint_written");
    }
    stage = "complete";
  } finally {
    const cleanup: Promise<unknown>[] = [];
    if (publisherIdentity) {
      const token = publisherIdentity.token;
      const transport = new HttpStdbTransport({ baseUrl: base, dbName: name, token, fetchImpl: localFetch, timeoutMs: 15000 });
      let drained = false;
      try { await drainFixtureConnections(connections, () => transport.sql("SELECT * FROM st_client")); drained = true; }
      catch { cleanup.push(Promise.reject(new Error("fixture_drain_failed"))); }
      if (drained && !retainFixture && !retainUntilServerCleanup) cleanup.push((async () => {
        const response = await localFetch(databaseUrl, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
        assert.ok(response.ok || response.status === 404, "fixture_database_cleanup_failed");
      })());
    } else { for (const live of connections) live.disconnect(); }
    if (restartPhase === "resume") cleanup.push(unlink(checkpointPath!));
    const cleaned = await Promise.allSettled(cleanup);
    assert.ok(cleaned.every(result => result.status === "fulfilled"), "fixture_cleanup_failed");
  }
}
void main().catch(() => { console.error(`FAIL protected_mail_admission_e2e stage=${stage} reason=${failureReason}`); process.exitCode = 1; });
