/** Disposable S1a substrate test against an already-running localhost STDB
 * 2.0.3 server. No real mail, model, credentials, blob service or worker runs.
 * Run from pear/worker:
 *   node --import tsx/esm scripts/protected-mail-e2e.ts http://127.0.0.1:3099
 * Optional PEAR_PROTECTED_MAIL_WASM selects the new module; optional
 * PEAR_UPGRADE_FROM_WASM publishes an older module first, then probes an
 * additive upgrade without clearing the disposable database.
 * Logs deliberately contain only fixed stage codes, never tokens/fixtures.
 */
import assert from "node:assert/strict";
import { drainFixtureConnections, retainFixtureDatabaseUntilServerCleanup } from "./protected-mail-fixture-lifecycle.js";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setGlobalLogLevel } from "spacetimedb";
import { DbConnection, tables } from "../src/module_bindings/index.js";
import { HttpStdbTransport } from "../../web/src/lib/api-endpoint/http-transport.js";
import { dispatchApiEndpointRequest } from "../../web/src/lib/api-endpoint/dispatcher.js";
import { buildToolRegistry } from "../../web/src/lib/mcp/tools.js";
import {
  buildPearSnapshotV2,
  snapshotExportQueriesV2,
  SNAPSHOT_TABLES_V2,
} from "../../packages/snapshot-core/src/index.js";

type IdentityToken = { identity: string; token: string };
type Actor = IdentityToken & { transport: HttpStdbTransport; live: DbConnection };
type CachedTable = { iter(): Iterable<Record<string, unknown>>; count(): bigint };
type ConnectionRow = { id: number; root_page_id: number; enabled: boolean };
type ProtectedRow = { id: string; collection_id: number; source_id: string; digest: string; message: unknown };

const none = { none: [] };
const ident = (hex: string) => [`0x${hex.replace(/^0x/, "")}`];
const marker = `S1A_PRIVATE_SYNTHETIC_${randomBytes(12).toString("hex")}`;
const password = "synthetic-local-fixture-password";
const privateTables = ["protected_mail_collection", "protected_mail_source", "protected_mail_record", "protected_mail_receipt"] as const;
// The generated SDK also caches the public auth dependency. This keeps its
// cache initialized before native login/logout updates arrive during the test.
const viewQueries = ["SELECT * FROM user", "SELECT * FROM my_protected_mail_collections", "SELECT * FROM my_protected_mail"];
let stage = "localhost_guard";

function localBase(raw: string): string {
  const value = new URL(raw);
  assert.equal(raw, raw.trim(), "invalid_local_base");
  assert.equal(value.protocol, "http:", "localhost_http_required");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(value.hostname), "localhost_required");
  assert.ok(!value.username && !value.password && !value.search && !value.hash && value.pathname === "/", "origin_only_required");
  // URL.search/hash are empty even for bare trailing '?'/'#'.
  assert.ok(!raw.includes("?") && !raw.includes("#"), "origin_only_required");
  return value.origin;
}

function containsMarker(value: unknown): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)
      && Buffer.from(value as number[]).toString("utf8").includes(marker)) return true;
    return value.some(containsMarker);
  }
  return value !== null && typeof value === "object" && Object.values(value).some(containsMarker);
}

function sameIdentity(value: unknown, hex: string): boolean {
  return JSON.stringify(value).toLowerCase().includes(hex.replace(/^0x/, "").toLowerCase());
}

async function rejectsWithCode(operation: Promise<unknown>, code: string): Promise<void> {
  let rejected = false;
  try { await operation; }
  catch (error) {
    rejected = true;
    assert.ok(error instanceof Error && error.message.includes(code), "unexpected_denial_code");
  }
  assert.ok(rejected, "operation_unexpectedly_accepted");
}

function cache(connection: DbConnection, name: string): CachedTable {
  const result = (connection.db as unknown as Record<string, CachedTable>)[name];
  assert.ok(result && typeof result.iter === "function", "generated_view_binding_required");
  return result;
}

async function main(): Promise<void> {
  const base = localBase(process.argv[2] ?? "http://127.0.0.1:3099");
  const retainFixtureDatabase = retainFixtureDatabaseUntilServerCleanup();
  setGlobalLogLevel("error");
  // SDK 2.0.3 emits CSS-prefixed diagnostics through console.log, including
  // fixture row IDs and potentially transport error details. Keep errors
  // visible as a fixed code; never print SDK arguments from this test process.
  const fixedLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("%c")) {
      fixedLog("WARN protected_mail_sdk_diagnostic");
      return;
    }
    fixedLog(...args);
  };
  assert.ok(process.argv.length <= 3, "unexpected_arguments");
  const name = `pear-protected-mail-e2e-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const databaseUrl = `${base}/v1/database/${name}`;
  const connections: DbConnection[] = [];
  let subscriptionFault = false;
  let publisherIdentity: IdentityToken | undefined;

  // All HTTP, including transport and module-publish calls, shares this
  // origin restriction and rejects redirects before forwarding a bearer.
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
        .onConnect((connected) => { clearTimeout(timer); resolve(connected); })
        .onConnectError(() => { clearTimeout(timer); reject(new Error("connection_failed")); })
        .build();
      connections.push(connection);
    });
    return { ...value, live, transport: new HttpStdbTransport({ baseUrl: base, dbName: name, token: value.token, fetchImpl: localFetch, timeoutMs: 15000 }) };
  }

  async function actor(): Promise<Actor> { return connect(await identity()); }

  async function subscribe(actor: Actor, queries: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("subscription_timeout")), 12000);
      actor.live.subscriptionBuilder()
        .onApplied(() => { clearTimeout(timer); resolve(); })
        .onError(() => { clearTimeout(timer); subscriptionFault = true; reject(new Error("subscription_failed")); })
        .subscribe(queries);
    });
  }

  async function privateSubscriptionDenied(actor: Actor): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("private_subscription_timeout")), 12000);
      actor.live.subscriptionBuilder()
        .onApplied(() => { clearTimeout(timer); reject(new Error("private_subscription_accepted")); })
        .onError(() => { clearTimeout(timer); resolve(); })
        .subscribe(privateTables.map((table) => `SELECT * FROM ${table}`));
    });
  }

  async function eventually(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 12000;
    while (!predicate()) {
      assert.ok(!subscriptionFault && Date.now() < deadline, "live_visibility_timeout");
      await new Promise((resolve) => setTimeout(resolve, 20));
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
    const baseline = process.env.PEAR_UPGRADE_FROM_WASM;
    publisherIdentity = await identity();
    await publish(baseline ? await readFile(baseline) : currentWasm);
    stage = "fixture_accounts";
    let publisher = await connect(publisherIdentity);
    let admin = await actor(), owner = await actor(), other = await actor();
    let ai = await actor(), anonymous = await actor(), service = await actor();
    await admin.transport.call("register", ["admin@example.test", "Fixture admin", password]);
    for (const [account, email] of [[owner, "owner@example.test"], [other, "other@example.test"]] as const) {
      await admin.transport.call("create_local_user", [email, "Fixture member", password]);
      await account.transport.call("login", [email, password]);
    }
    await publisher.transport.call("create_ai_user", [ident(ai.identity), ident(admin.identity), "Fixture AI", { anthropic: [] }, "synthetic-model", none, none, none, none, none]);
    const aiId = Number((await publisher.transport.sql<{ ai_user_id: number }>("SELECT ai_user_id FROM ai_user_profile"))[0].ai_user_id);
    stage = "empty_restore_pages_check";
    assert.equal((await publisher.transport.sql("SELECT * FROM page")).length, 0, "fresh_fixture_has_pages");
    // Ordinary import remains usable in an otherwise empty fixture. Keep a
    // v2 session open across connection creation (and the optional upgrade) to
    // prove private collection creation cannot race an existing restore.
    stage = "empty_restore_v1";
    await owner.transport.call("import_pear_snapshot_v_1", [JSON.stringify({ format: "pear-snapshot-v1", tables: {} })]);
    stage = "empty_restore_v2";
    await owner.transport.call("import_v_2_begin", [JSON.stringify({ format: "pear-snapshot-v2" })]);
    stage = "fixture_mail_connection";
    // No actual encryption/decryption or IMAP access: only the reducer's
    // synthetic ciphertext envelope is needed to bind a legacy connection.
    const keyId = "a".repeat(64);
    await publisher.transport.call("publish_mail_encryption_key", ["{}", keyId]);
    const ciphertext = JSON.stringify({ v: 1, keyId, key: "synthetic", nonce: "synthetic", ciphertext: "synthetic" });
    async function createConnection(account: Actor, sentFolder: unknown = { some: "Sent" }): Promise<ConnectionRow> {
      await account.transport.call("create_mail_connection", ["Fixture mailbox", "imap.example.test", 993, "fixture@example.test", ciphertext, "INBOX", sentFolder, none, 0]);
      const rows = await account.transport.sql<ConnectionRow>("SELECT id, root_page_id, enabled FROM mail_connection");
      return rows.at(-1)!;
    }
    const account = await createConnection(owner);
    assert.ok(account, "connection_missing");
    await owner.transport.call("create_page", [none, { doc: [] }, "Preserved ordinary fixture"]);
    const preservedPage = (await publisher.transport.sql<{ id: number; title: string }>("SELECT id, title FROM page"))
      .find((row) => row.title === "Preserved ordinary fixture")!;
    assert.ok(preservedPage, "ordinary_fixture_missing");

    if (baseline) {
      stage = "additive_upgrade";
      await owner.transport.call("set_mail_connection_enabled", [account.id, false]);
      for (const connection of connections) connection.disconnect();
      await publish(currentWasm, true);
      [publisher, admin, owner, other, ai, anonymous, service] = await Promise.all(
        [publisher, admin, owner, other, ai, anonymous, service].map((value) => connect(value)),
      );
      assert.ok((await owner.transport.sql<ConnectionRow>("SELECT * FROM mail_connection")).some((row) => Number(row.id) === Number(account.id)), "upgrade_connection_lost");
      assert.ok((await publisher.transport.sql<{ id: number; title: string }>("SELECT id, title FROM page"))
        .some((row) => Number(row.id) === Number(preservedPage.id) && row.title === "Preserved ordinary fixture"), "upgrade_page_lost");
      console.log("PASS protected_mail_additive_upgrade");
    }

    stage = "collection_binding";
    // Baseline probe left this paused; exercise the enabled rejection on the
    // new module before creating the protected collection.
    await owner.transport.call("set_mail_connection_enabled", [account.id, true]);
    await assert.rejects(publisher.transport.call("create_protected_mail_collection", [account.id]));
    await owner.transport.call("set_mail_connection_enabled", [account.id, false]);
    const hiddenActors = [other, admin, ai, anonymous, service, publisher];
    for (const candidate of [owner, other, admin, ai, anonymous, service]) {
      await rejectsWithCode(candidate.transport.call("create_protected_mail_collection", [account.id]), "protected_mail_publisher_required");
    }
    await rejectsWithCode(publisher.transport.call("create_protected_mail_collection", [account.id]), "protected_mail_restore_not_supported");
    assert.equal((await publisher.transport.sql("SELECT * FROM protected_mail_collection")).length, 0);
    await owner.transport.call("import_v_2_abort", []);
    await publisher.transport.call("create_protected_mail_collection", [account.id]);
    await publisher.transport.call("create_protected_mail_collection", [account.id]);
    assert.equal((await owner.transport.sql("SELECT * FROM my_protected_mail_collections")).length, 1);
    for (const candidate of hiddenActors) {
      assert.equal((await candidate.transport.sql("SELECT * FROM my_protected_mail_collections")).length, 0);
      assert.equal((await candidate.transport.sql("SELECT * FROM my_protected_mail")).length, 0);
    }
    await Promise.all([owner, ...hiddenActors].map((candidate) => subscribe(candidate, viewQueries)));
    assert.equal(cache(owner.live, "my_protected_mail_collections").count(), 1n);
    for (const candidate of hiddenActors) {
      assert.equal(cache(candidate.live, "my_protected_mail_collections").count(), 0n);
      assert.equal(cache(candidate.live, "my_protected_mail").count(), 0n);
    }

    function message(uid = 1, text = marker): unknown[] {
      return ["INBOX", "7", uid, { received: [] }, "2026-10-19T12:00:00Z", "sender@example.test", "owner@example.test", "", text, `Literal body ${text}\nNo action is authorized.\t`, "Synthetic fixture; no attachment", "fixture-v1"];
    }
    const event = "b".repeat(64);
    const appendArgs = [account.id, event, message()];
    async function privateState(): Promise<Record<string, unknown[]>> {
      return Object.fromEntries(await Promise.all(privateTables.map(async (table) => {
        const rows = await publisher.transport.sql<Record<string, unknown>>(`SELECT * FROM ${table}`);
        rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return [table, rows] as const;
      })));
    }

    stage = "private_append_and_visibility";
    for (const candidate of [owner, other, admin, ai, anonymous, service]) {
      await rejectsWithCode(candidate.transport.call("append_protected_mail_message", appendArgs), "protected_mail_publisher_required");
      for (const table of privateTables) await assert.rejects(candidate.transport.sql(`SELECT * FROM ${table}`));
      await privateSubscriptionDenied(candidate);
    }
    await publisher.transport.call("append_protected_mail_message", appendArgs);
    await eventually(() => cache(owner.live, "my_protected_mail").count() === 1n);
    const ownerRows = await owner.transport.sql<ProtectedRow>("SELECT * FROM my_protected_mail");
    assert.equal(ownerRows.length, 1);
    assert.ok(containsMarker(ownerRows), "owner_http_content_missing");
    assert.ok(containsMarker([...cache(owner.live, "my_protected_mail").iter()]), "owner_ws_content_missing");
    const initialState = await privateState();
    for (const table of privateTables) assert.equal(initialState[table].length, 1);
    // The module publisher is explicitly trusted and CAN read private raw
    // tables. The owner view is not a barrier against that management identity.
    assert.ok(containsMarker(initialState.protected_mail_record), "publisher_raw_read_missing");
    for (const candidate of hiddenActors) {
      assert.equal((await candidate.transport.sql("SELECT * FROM my_protected_mail")).length, 0);
      assert.equal(cache(candidate.live, "my_protected_mail").count(), 0n);
    }
    console.log("PASS protected_mail_owner_http_ws_and_private_raw_boundary");

    stage = "replay_and_atomic_rollback";
    await publisher.transport.call("append_protected_mail_message", appendArgs);
    assert.deepEqual(await privateState(), initialState, "exact_replay_mutated_state");
    const conflict = message(); conflict[9] = "changed body";
    await rejectsWithCode(publisher.transport.call("append_protected_mail_message", [account.id, event, conflict]), "protected_mail_event_conflict");
    const metadataConflict = message(); metadataConflict[11] = "fixture-v2";
    await rejectsWithCode(publisher.transport.call("append_protected_mail_message", [account.id, event, metadataConflict]), "protected_mail_event_conflict");
    await rejectsWithCode(publisher.transport.call("append_protected_mail_message", [account.id, "f".repeat(64), message()]), "protected_mail_event_conflict");
    assert.deepEqual(await privateState(), initialState, "mailbox_identity_replay_mutated_state");
    const invalidUid = message(); invalidUid[2] = 0;
    const invalidValidity = message(); invalidValidity[1] = "07";
    const invalidBody = message(); invalidBody[9] = "é".repeat(80001);
    const invalidHeader = message(); invalidHeader[8] = "subject\nnot-a-header";
    for (const invalid of [invalidUid, invalidValidity, invalidBody, invalidHeader, [...message(), ident(other.identity)]]) {
      await assert.rejects(publisher.transport.call("append_protected_mail_message", [account.id, "c".repeat(64), invalid]));
      assert.deepEqual(await privateState(), initialState, "invalid_write_not_atomic");
    }
    const wrongFolder = message(); wrongFolder[0] = "Archive";
    const wrongDirection = message(); wrongDirection[3] = { sent: [] };
    for (const invalid of [wrongFolder, wrongDirection]) {
      await rejectsWithCode(publisher.transport.call("append_protected_mail_message", [account.id, "c".repeat(64), invalid]), "protected_mail_source_mismatch");
      assert.deepEqual(await privateState(), initialState, "source_binding_write_not_atomic");
    }
    assert.equal(cache(owner.live, "my_protected_mail").count(), 1n);
    console.log("PASS protected_mail_replay_conflict_and_atomic_rollback");

    stage = "legacy_runner_fence";
    await assert.rejects(owner.transport.call("set_mail_connection_enabled", [account.id, true]));
    await assert.rejects(publisher.transport.call("claim_mail_sync", [account.id, "legacy-lease"]));
    await assert.rejects(publisher.transport.call("renew_mail_sync", [account.id, "legacy-lease"]));
    await assert.rejects(publisher.transport.call("authorize_mail_triage", [account.id, "legacy-lease"]));
    await assert.rejects(publisher.transport.call("import_mail_message", [account.id, "legacy-lease", "d".repeat(64), marker, "{}", [["RichText", "{}", { some: [1] }]]]));
    assert.deepEqual(await privateState(), initialState);
    console.log("PASS protected_mail_legacy_runner_fenced");

    stage = "cross_owner_and_hybrid_identity";
    const otherAccount = await createConnection(other, none);
    await other.transport.call("set_mail_connection_enabled", [otherAccount.id, false]);
    await publisher.transport.call("create_protected_mail_collection", [otherAccount.id]);
    await publisher.transport.call("append_protected_mail_message", [otherAccount.id, event, message(2, "Other owner's independent fixture")]);
    await eventually(() => cache(other.live, "my_protected_mail").count() === 1n);
    assert.equal((await owner.transport.sql<ProtectedRow>("SELECT * FROM my_protected_mail"))[0].id, ownerRows[0].id);
    assert.ok((await other.transport.sql<ProtectedRow>("SELECT * FROM my_protected_mail")).every((row) => Number(row.collection_id) === Number(otherAccount.id)));
    const separated = await privateState();
    const unapprovedSent = message(3); unapprovedSent[0] = "Sent"; unapprovedSent[3] = { sent: [] };
    await rejectsWithCode(publisher.transport.call("append_protected_mail_message", [otherAccount.id, "e".repeat(64), unapprovedSent]), "protected_mail_source_mismatch");
    assert.deepEqual(await privateState(), separated, "unapproved_sent_folder_written");
    for (const table of ["protected_mail_source", "protected_mail_record", "protected_mail_receipt"] as const) {
      assert.equal(separated[table].length, 2);
      assert.ok(separated[table].some((row) => sameIdentity((row as Record<string, unknown>).owner, owner.identity)));
      assert.ok(separated[table].some((row) => sameIdentity((row as Record<string, unknown>).owner, other.identity)));
    }
    // A provisioned AI identity also authenticated through native login must
    // still be excluded; matching a human email does not change its identity.
    await ai.transport.call("login", ["owner@example.test", password]);
    assert.equal((await ai.transport.sql("SELECT * FROM my_protected_mail")).length, 0);
    assert.equal(cache(ai.live, "my_protected_mail").count(), 0n);
    const hybridConnection = await createConnection(ai);
    await ai.transport.call("set_mail_connection_enabled", [hybridConnection.id, false]);
    await assert.rejects(publisher.transport.call("create_protected_mail_collection", [hybridConnection.id]));
    assert.deepEqual(await privateState(), separated, "hybrid_identity_created_collection");
    console.log("PASS protected_mail_source_owner_isolation_and_hybrid_denial");

    stage = "ordinary_surfaces_mcp_crud_and_export";
    async function assertOrdinarySurfaces(): Promise<void> {
      for (const table of [...SNAPSHOT_TABLES_V2, "mail_import_receipt"]) {
        assert.ok(!containsMarker(await publisher.transport.sql(`SELECT * FROM ${table}`)), "ordinary_surface_contains_private_marker");
      }
      assert.equal((await publisher.transport.sql("SELECT * FROM mail_import_receipt")).length, 0, "legacy_source_receipt_created");
    }
    await assertOrdinarySurfaces();
    const registry = new Map(buildToolRegistry().map((entry) => [entry.name, entry]));
    for (const transport of [publisher.transport, service.transport, ai.transport]) {
      const ctx = { transport, aiUserId: BigInt(aiId) };
      for (const [tool, input] of [
        ["get_page", { page_id: account.root_page_id }],
        ["get_page_components", { page_id: account.root_page_id }],
        ["search_pages", { query: marker }],
        // No workspace blob exists for a protected record. This tests the
        // fixed tool's unavailable-reader branch, not external blob hosting.
        ["read_file", { storage_key: ownerRows[0].source_id }],
      ] as const) {
        const result = await registry.get(tool)!.execute(ctx, input);
        assert.ok(!containsMarker(result), "mcp_returned_private_marker");
      }
    }
    await owner.transport.call("create_page", [none, { database: [] }, "Ordinary CRUD fixture"]);
    const database = (await publisher.transport.sql<{ id: number; title: string }>("SELECT id, title FROM page"))
      .find((row) => row.title === "Ordinary CRUD fixture")!;
    await owner.transport.call("create_api_endpoint", [database.id, "fixture-mail-boundary", "Fixture endpoint", "Synthetic ordinary database", [{ get: [] }], false]);
    const response = await dispatchApiEndpointRequest({
      url: new URL(`${base}/e/fixture-mail-boundary`), method: "GET", body: undefined,
      endpointSlug: "fixture-mail-boundary", transport: publisher.transport, auth: { kind: "session", identityHex: owner.identity }, baseUrl: `${base}/e/fixture-mail-boundary`,
    });
    assert.equal(response.status, 200, "ordinary_crud_unavailable");
    assert.ok(!containsMarker(await response.text()), "crud_returned_private_marker");
    const aliasedRow = await dispatchApiEndpointRequest({
      url: new URL(`${base}/e/fixture-mail-boundary/${account.id}`), method: "GET", body: undefined,
      endpointSlug: "fixture-mail-boundary", trailing: String(account.id), transport: publisher.transport,
      auth: { kind: "session", identityHex: owner.identity }, baseUrl: `${base}/e/fixture-mail-boundary`,
    });
    assert.equal(aliasedRow.status, 404, "crud_private_id_alias_resolved");
    assert.ok(!containsMarker(await aliasedRow.text()), "crud_private_id_alias_leaked");
    await subscribe(owner, snapshotExportQueriesV2());
    const snapshot = buildPearSnapshotV2(owner.live.db, { wsUri: base, dbName: name, tablesRegistry: tables });
    assert.ok(!containsMarker(snapshot), "snapshot_contains_private_marker");
    assert.ok(Object.keys(snapshot.tables).every((table) => !table.startsWith("protected_mail_") && !table.startsWith("my_protected_mail")), "snapshot_includes_private_mail");
    await assertOrdinarySurfaces();
    console.log("PASS protected_mail_no_ordinary_mcp_crud_or_snapshot_projection");

    stage = "logout_revokes_live_owner_view";
    await owner.transport.call("logout", []);
    assert.equal((await owner.transport.sql("SELECT * FROM my_protected_mail")).length, 0);
    assert.equal((await owner.transport.sql("SELECT * FROM my_protected_mail_collections")).length, 0);
    await eventually(() => cache(owner.live, "my_protected_mail").count() === 0n && cache(owner.live, "my_protected_mail_collections").count() === 0n);
    await assert.rejects(publisher.transport.call("append_protected_mail_message", [account.id, event, message()]));
    await assert.rejects(publisher.transport.call("create_protected_mail_collection", [account.id]));
    await owner.transport.call("login", ["owner@example.test", password]);
    await eventually(() => cache(owner.live, "my_protected_mail").count() === 1n);
    assert.equal((await owner.transport.sql("SELECT * FROM my_protected_mail")).length, 1);
    console.log("PASS protected_mail_logout_http_ws_revocation");

    stage = "disconnect_preserves_private_history";
    const beforeDelete = await privateState();
    await owner.transport.call("delete_mail_connection", [account.id]);
    assert.deepEqual(await privateState(), beforeDelete, "disconnect_erased_private_history");
    assert.equal((await owner.transport.sql("SELECT * FROM my_protected_mail")).length, 1);
    assert.equal(cache(owner.live, "my_protected_mail").count(), 1n);
    await assert.rejects(publisher.transport.call("append_protected_mail_message", appendArgs));
    await assert.rejects(publisher.transport.call("append_protected_mail_message", [account.id, "e".repeat(64), message(3)]));
    await assert.rejects(publisher.transport.call("create_protected_mail_collection", [account.id]));
    assert.deepEqual(await privateState(), beforeDelete);
    await assertOrdinarySurfaces();
    console.log("PASS protected_mail_disconnect_retains_history_rejects_append");

    stage = "ordinary_restore_purge";
    const pages = await publisher.transport.sql<{ id: number }>("SELECT id FROM page");
    for (const page of pages) await publisher.transport.call("delete_page_subtree", [page.id]);
    await publisher.transport.call("empty_trash", []);
    assert.equal((await publisher.transport.sql("SELECT * FROM page")).length, 0, "ordinary_pages_not_empty");
    const retained = await privateState();
    async function authState(): Promise<unknown[]> {
      return Promise.all(["user", "user_credential", "oidc_trust_policy", "ai_user_profile", "ai_user_config"].map(async (table) => {
        // HTTP connection lifecycle may legitimately update last_seen_at even
        // when the invoked reducer rolls back. Preserve every authority field,
        // plus credentials/trust/profile/config, rather than that liveness clock.
        const query = table === "user"
          ? "SELECT identity, name, email, is_authenticated, created_at, is_admin FROM user"
          : `SELECT * FROM ${table}`;
        const rows = await publisher.transport.sql(query);
        return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }));
    }
    const authenticated = await authState();
    stage = "ordinary_restore_v1_refused";
    await rejectsWithCode(owner.transport.call("import_pear_snapshot_v_1", [JSON.stringify({ format: "pear-snapshot-v1", tables: {} })]), "protected_mail_restore_not_supported");
    stage = "ordinary_restore_v2_refused";
    await rejectsWithCode(owner.transport.call("import_v_2_begin", [JSON.stringify({ format: "pear-snapshot-v2" })]), "protected_mail_restore_not_supported");
    stage = "ordinary_restore_private_state_retained";
    assert.deepEqual(await privateState(), retained, "restore_changed_private_history");
    stage = "ordinary_restore_auth_state_retained";
    assert.deepEqual(await authState(), authenticated, "restore_changed_auth_or_profiles");
    stage = "ordinary_restore_pages_remain_empty";
    assert.equal((await publisher.transport.sql("SELECT * FROM page")).length, 0, "restore_created_ordinary_pages");
    stage = "ordinary_restore_owner_retains_view";
    assert.equal((await owner.transport.sql("SELECT * FROM my_protected_mail")).length, 1);
    console.log("PASS protected_mail_ordinary_restore_fenced_with_retained_history");
    stage = "complete";
  } finally {
    // The name/token are generated here. Retention is only for a controller
    // that owns and removes this entire disposable server and its storage.
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
  console.error(`FAIL protected_mail_e2e stage=${stage}`);
  process.exitCode = 1;
});
