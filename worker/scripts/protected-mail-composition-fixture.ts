/** Shared PRIVATE localhost fixture setup. Not a runtime/client authority API. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setGlobalLogLevel } from "spacetimedb";
import { DbConnection } from "../src/module_bindings/index.js";
import { HttpStdbTransport } from "../../web/src/lib/api-endpoint/http-transport.js";
import { drainFixtureConnections, retainFixtureDatabaseUntilServerCleanup } from "./protected-mail-fixture-lifecycle.js";

export type CompositionRow = Record<string, unknown>;
export type CompositionActor = { identity: string; token: string; live: DbConnection; transport: HttpStdbTransport };
export const compositionIdentity = (value: string) => [`0x${value.replace(/^0x/, "")}`];
export const compositionNone = { none: [] };
export const compositionSorted = (rows: CompositionRow[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function compositionLocalOrigin(raw: string): string {
  const url = new URL(raw);
  assert.ok(raw === raw.trim() && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && !raw.includes("?") && !raw.includes("#") && url.pathname === "/", "composition_local_origin_required");
  return url.origin;
}

/** Every identity, HTTP request, socket and database belongs to this invocation.
 * Disk-backed controlled-server callers retain the DB for whole-server cleanup.
 */
export async function createCompositionFixture(rawBase: string) {
  const base = compositionLocalOrigin(rawBase), retain = retainFixtureDatabaseUntilServerCleanup();
  const name = `pear-protected-composition-e2e-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const databaseUrl = `${base}/v1/database/${name}`, sockets: DbConnection[] = [];
  const actors: CompositionActor[] = [];
  let publisher: CompositionActor | undefined;
  let publisherAccount: { identity: string; token: string } | undefined;
  setGlobalLogLevel("error");
  const originalLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("%c")) { originalLog("WARN protected_mail_composition_sdk_diagnostic"); return; }
    originalLog(...args);
  };
  const localFetch: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.ok(target.origin === base && !target.username && !target.password && !target.search && !target.hash
      && (target.pathname === "/v1/identity" || target.pathname === `/v1/database/${name}` || target.pathname.startsWith(`/v1/database/${name}/`)), "composition_disposable_path_required");
    return fetch(target, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(15000) });
  };
  async function identity() {
    const response = await localFetch(`${base}/v1/identity`, { method: "POST" });
    assert.ok(response.ok, "composition_identity_failed"); const value: unknown = await response.json();
    assert.ok(value && typeof value === "object", "composition_identity_invalid"); const row = value as CompositionRow;
    assert.ok(typeof row.identity === "string" && /^(0x)?[a-f0-9]{64}$/i.test(row.identity) && typeof row.token === "string" && row.token.length > 0 && row.token.length <= 8192, "composition_identity_invalid");
    return { identity: row.identity, token: row.token };
  }
  async function actor(account?: Awaited<ReturnType<typeof identity>>): Promise<CompositionActor> {
    const value = account ?? await identity();
    const live = await new Promise<DbConnection>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("composition_connection_timeout")), 12000);
      const connection = DbConnection.builder().withUri(base).withDatabaseName(name).withToken(value.token)
        .onConnect(connected => { clearTimeout(timer); resolve(connected); })
        .onConnectError(() => { clearTimeout(timer); reject(Error("composition_connection_failed")); }).build();
      sockets.push(connection);
    });
    const result = { ...value, live, transport: new HttpStdbTransport({ baseUrl: base, dbName: name, token: value.token, fetchImpl: localFetch, timeoutMs: 15000 }) };
    actors.push(result); return result;
  }
  async function procedure(account: CompositionActor, method: string, args: readonly unknown[], maxBytes = 32768): Promise<unknown[]> {
    assert.ok(/^[a-z][a-z0-9_]+$/.test(method) && Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 4 * 1024 * 1024, "composition_procedure_invalid");
    const signal = AbortSignal.timeout(15000), response = await localFetch(`${databaseUrl}/call/${method}`, {
      method: "POST", headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" }, body: JSON.stringify(args), signal,
    });
    assert.ok(response.ok && /^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "") && response.body, "composition_procedure_transport_failed");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; assert.ok(size <= maxBytes && !signal.aborted, "composition_procedure_response_limit"); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    assert.ok(Array.isArray(value) && value.length === 2 && (value[0] === 0 || value[0] === 1), "composition_procedure_shape");
    if (value[0] === 1) {
      assert.ok(typeof value[1] === "string" && /^[a-z0-9_]{1,128}$/.test(value[1]), "composition_procedure_denial_shape");
      throw Object.assign(Error("composition_procedure_denied"), { denial: value[1] });
    }
    assert.ok(Array.isArray(value[1]), "composition_procedure_product_required"); return value[1];
  }
  async function cleanup() {
    let drained = true;
    if (publisherAccount) {
      const transport = new HttpStdbTransport({ baseUrl: base, dbName: name, token: publisherAccount.token, fetchImpl: localFetch, timeoutMs: 15000 });
      try { await drainFixtureConnections(sockets, () => transport.sql("SELECT * FROM st_client")); } catch { drained = false; }
      if (drained && !retain) {
        const response = await localFetch(databaseUrl, { method: "DELETE", headers: { Authorization: `Bearer ${publisherAccount.token}` } });
        assert.ok(response.ok || response.status === 404, "composition_database_cleanup_failed");
      }
    } else sockets.forEach(socket => socket.disconnect());
    assert.ok(drained, "composition_connection_cleanup_failed");
  }
  try {
    const account = await identity(); publisherAccount = account;
    const wasm = await readFile(process.env.PEAR_PROTECTED_MAIL_WASM || new URL("../../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm", import.meta.url));
    assert.ok(wasm.length > 0, "composition_module_missing");
    const baselinePath = process.env.PEAR_COMPOSITION_BASELINE_WASM || undefined;
    const baseline = baselinePath ? await readFile(baselinePath) : undefined;
    assert.ok(!baseline || baseline.length > 0 && !baseline.equals(wasm), "composition_distinct_artifacts_required");
    const response = await localFetch(databaseUrl, { method: "PUT", headers: { Authorization: `Bearer ${account.token}` }, body: new Uint8Array(baseline ?? wasm), signal: AbortSignal.timeout(60000) });
    assert.ok(response.ok, "composition_publish_failed"); publisher = await actor(account);
    return { base, name, databaseUrl, publisher, actor, procedure, localFetch, cleanup,
      upgradeIfRequested: async () => {
        if (!baseline) return false;
        await drainFixtureConnections(sockets, () => publisher!.transport.sql("SELECT * FROM st_client"));
        const review = await localFetch(`${databaseUrl}/pre_publish`, { method: "POST", headers: { Authorization: `Bearer ${account.token}` }, body: new Uint8Array(wasm), signal: AbortSignal.timeout(60000) });
        assert.ok(review.ok, "composition_upgrade_review_failed"); const plan = await review.json() as { AutoMigrate?: { break_clients: boolean; token?: string } };
        assert.ok(plan.AutoMigrate, "composition_additive_upgrade_required"); let suffix = "";
        if (plan.AutoMigrate.break_clients) { assert.ok(typeof plan.AutoMigrate.token === "string" && plan.AutoMigrate.token.length <= 8192, "composition_upgrade_token_required"); suffix = `?policy=BreakClients&token=${encodeURIComponent(plan.AutoMigrate.token)}`; }
        // Only this locally constructed own-database publish may carry the native
        // pre-publish token. It is never emitted or accepted from fixture input.
        const changed = await fetch(databaseUrl + suffix, { method: "PUT", headers: { Authorization: `Bearer ${account.token}` }, body: new Uint8Array(wasm), redirect: "error", signal: AbortSignal.timeout(60000) });
        assert.ok(changed.ok, "composition_upgrade_failed");
        for (const current of [...actors]) { const replacement = await actor(current); Object.assign(current, replacement); actors.pop(); }
        return true;
      },
      options: (value: CompositionActor, fetchImpl = localFetch) => ({ baseUrl: base, dbName: name, token: value.token, fetchImpl, timeoutMs: 15000 }),
      snapshot: async (tables: readonly string[]): Promise<Record<string, CompositionRow[]>> => {
        assert.ok(tables.every(table => /^[a-z][a-z0-9_]{1,95}$/.test(table)), "composition_table_invalid");
        return Object.fromEntries(await Promise.all(tables.map(async table => [table, compositionSorted(await publisher!.transport.sql<CompositionRow>(`SELECT * FROM ${table}`))])));
      },
    };
  } catch (error) { await cleanup(); throw error; }
}
