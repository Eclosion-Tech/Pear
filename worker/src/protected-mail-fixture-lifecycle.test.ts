import assert from "node:assert/strict";
import { test } from "node:test";
import { drainFixtureConnections, fixtureFailureCode, withFixtureCleanup } from "../scripts/protected-mail-fixture-lifecycle.js";

test("fixture drain waits for asynchronous server-side client removal before an upgrade can start", async () => {
  let connected = true;
  let queries = 0;
  let disconnectCalled = false;
  const connection = { disconnect() { disconnectCalled = true; } };
  await drainFixtureConnections([connection], async () => {
    assert.equal(disconnectCalled, true);
    queries++;
    // Native client-disconnected reducers can trail the local close request.
    if (queries === 3) connected = false;
    return connected ? [{ syntheticClient: true }] : [];
  });
  assert.equal(connected, false);
  assert.equal(queries, 3);
});

test("fixture drain propagates a failed server observation instead of permitting an upgrade", async () => {
  const failure = new Error("synthetic query failure");
  await assert.rejects(drainFixtureConnections([{ disconnect() {} }], async () => { throw failure; }), error => error === failure);
});

test("fixture diagnostics identify timeout/transport/assertion classes without printing private error data", () => {
  const marker = "PRIVATE_SYNTHETIC_BEARER_AND_BODY";
  for (const code of ["connection_timeout", "connection_failed", "subscription_timeout", "private_subscription_timeout", "fixture_client_shutdown_timeout"]) {
    assert.equal(fixtureFailureCode(new Error(code)), code);
  }
  assert.equal(fixtureFailureCode(Object.assign(new Error(marker), { code: "stdb_sql_error" })), "sql_failed");
  assert.equal(fixtureFailureCode(Object.assign(new Error(marker), { code: "stdb_reducer_error" })), "reducer_failed");
  assert.equal(fixtureFailureCode(Object.assign(new Error(marker), { name: "TimeoutError" })), "request_timeout");
  assert.equal(fixtureFailureCode(Object.assign(new Error(marker), { name: "AbortError" })), "request_timeout");
  let assertion: unknown;
  try { assert.deepEqual({ body: marker }, {}, "retained_storage"); } catch (error) { assertion = error; }
  assert.equal(fixtureFailureCode(assertion), "assertion_failed");
  for (const error of [new Error(marker), marker, undefined, { message: marker }]) {
    assert.equal(fixtureFailureCode(error), "operation_failed");
  }
});

test("a failed fixture retains its original error even when cleanup also fails", async () => {
  const primary = new Error("synthetic publish failure"), secondary = new Error("synthetic cleanup failure");
  for (const cleanupFails of [false, true]) {
    let cleaned = false, warnings = 0;
    await assert.rejects(withFixtureCleanup(async () => { throw primary; }, async () => {
      cleaned = true;
      if (cleanupFails) throw secondary;
    }, () => { warnings++; }), error => error === primary);
    assert.equal(cleaned, true);
    assert.equal(warnings, cleanupFails ? 1 : 0);
  }
  await assert.rejects(withFixtureCleanup(async () => { throw primary; }, async () => { throw secondary; }, () => { throw secondary; }), error => error === primary);
});

test("cleanup errors still fail successful fixtures and successful cleanup preserves their return value", async () => {
  const failure = new Error("synthetic cleanup failure");
  await assert.rejects(withFixtureCleanup(async () => "passed", async () => { throw failure; }, () => assert.fail("not a secondary failure")), error => error === failure);
  assert.equal(await withFixtureCleanup(async () => "passed", async () => {}, () => assert.fail("cleanup succeeded")), "passed");
});
