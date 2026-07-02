import { test } from "node:test";
import assert from "node:assert/strict";

import { executeTool, type ConnLike } from "./tools.js";

// ── Minimal read-only fake conn ─────────────────────────────────────────────────

function iterOf<T>(arr: T[]): { iter: () => Iterator<T> } {
  return { iter: () => arr[Symbol.iterator]() };
}

function fakeConn(tables: Record<string, unknown[]>): ConnLike {
  const db: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tables)) db[k] = iterOf(v);
  return { db } as unknown as ConnLike;
}

async function run(
  conn: ConnLike,
  tool: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return JSON.parse(await executeTool(conn, tool, input, 0n, {}));
}

// ── query_database ──────────────────────────────────────────────────────────────

function tasksDbConn(): ConnLike {
  return fakeConn({
    page: [
      { id: 10n, parentId: undefined, title: "Tasks", pageType: { tag: "Database" }, deletedAt: undefined },
      { id: 11n, parentId: 10n, title: "Write tests", pageType: { tag: "Doc" }, deletedAt: undefined },
      { id: 12n, parentId: 10n, title: "Ship", pageType: { tag: "Doc" }, deletedAt: undefined },
      { id: 13n, parentId: 10n, title: "Trashed", pageType: { tag: "Doc" }, deletedAt: { microsSinceUnixEpoch: 1n } },
    ],
    database_schema: [{ id: 100n, pageId: 10n, name: "Tasks" }],
    property_definition: [
      { id: 200n, schemaId: 100n, name: "Status", propertyType: { tag: "Select" }, order: 0 },
      { id: 201n, schemaId: 100n, name: "Done", propertyType: { tag: "Checkbox" }, order: 1 },
    ],
    page_property_value: [
      { pageId: 11n, propertyDefinitionId: 200n, value: { tag: "Select", value: "In progress" } },
      { pageId: 11n, propertyDefinitionId: 201n, value: { tag: "Checkbox", value: false } },
      { pageId: 12n, propertyDefinitionId: 200n, value: { tag: "Select", value: "Done" } },
      { pageId: 12n, propertyDefinitionId: 201n, value: { tag: "Checkbox", value: true } },
    ],
  });
}

test("query_database returns columns and rows with rendered cell values (skips trashed)", async () => {
  const res = await run(tasksDbConn(), "query_database", { page_id: 10 });
  assert.equal(res.ok, true);
  assert.equal(res.total_rows, 2); // trashed row excluded
  assert.deepEqual((res.columns as { name: string }[]).map((c) => c.name), ["Status", "Done"]);
  const rows = res.rows as Record<string, unknown>[];
  const r1 = rows.find((r) => r.page_id === 11)!;
  assert.equal(r1.Status, "In progress");
  assert.equal(r1.Done, false);
  const r2 = rows.find((r) => r.page_id === 12)!;
  assert.equal(r2.Done, true);
});

test("query_database property_filter (contains) narrows rows", async () => {
  const res = await run(tasksDbConn(), "query_database", {
    page_id: 10,
    property_filter: { property: "Status", contains: "done" },
  });
  assert.equal(res.total_rows, 1);
  assert.equal((res.rows as { page_id: number }[])[0].page_id, 12);
});

test("query_database rejects an unknown filter column", async () => {
  const res = await run(tasksDbConn(), "query_database", {
    page_id: 10,
    property_filter: { property: "Nope" },
  });
  assert.equal(res.ok, false);
  assert.match(res.error as string, /Unknown property/);
});

test("query_database rejects a non-database page", async () => {
  const conn = fakeConn({
    page: [{ id: 5n, parentId: undefined, title: "Doc", pageType: { tag: "Doc" }, deletedAt: undefined }],
    database_schema: [],
    property_definition: [],
    page_property_value: [],
  });
  const res = await run(conn, "query_database", { page_id: 5 });
  assert.equal(res.ok, false);
  assert.match(res.error as string, /not a Database/);
});

// ── check_job ───────────────────────────────────────────────────────────────────

test("check_job returns status and per-task counts", async () => {
  const conn = fakeConn({
    orcha_job: [{ id: 5n, userId: "u", prompt: "build it", status: "complete", pageId: undefined }],
    orcha_task: [
      { id: 1n, jobId: 5n, description: "plan", taskType: "orchestrate", status: "done", result: "ok" },
      { id: 2n, jobId: 5n, description: "exec", taskType: "llm", status: "failed", result: "ERROR: boom" },
    ],
  });
  const res = await run(conn, "check_job", { job_id: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.status, "complete");
  assert.equal(res.task_count, 2);
  assert.equal(res.done_count, 1);
  assert.equal(res.failed_count, 1);
});

test("check_job errors for an unknown job", async () => {
  const conn = fakeConn({ orcha_job: [], orcha_task: [] });
  const res = await run(conn, "check_job", { job_id: 99 });
  assert.equal(res.ok, false);
});

// ── list_sensor_findings ─────────────────────────────────────────────────────────

function findingsConn(): ConnLike {
  return fakeConn({
    structural_sensor_finding: [
      { id: 1n, sensorKind: "orphan_detector", code: "page_no_parent", targetKind: "page", targetId: 9n, message: "orphan", severity: "warn", resolvedAt: undefined },
      { id: 2n, sensorKind: "relational_integrity", code: "relation_dangling", targetKind: "property_value", targetId: 8n, message: "dangling", severity: "error", resolvedAt: undefined },
      { id: 3n, sensorKind: "orphan_detector", code: "x", targetKind: "page", targetId: 7n, message: "already fixed", severity: "error", resolvedAt: { microsSinceUnixEpoch: 1n } },
    ],
  });
}

test("list_sensor_findings returns open findings, most severe first", async () => {
  const res = await run(findingsConn(), "list_sensor_findings", {});
  assert.equal(res.ok, true);
  assert.equal(res.total_open, 2); // resolved one excluded
  const findings = res.findings as { finding_id: number; severity: string }[];
  assert.equal(findings[0].severity, "error");
  assert.equal(findings[0].finding_id, 2);
});

test("list_sensor_findings filters by sensor_kind", async () => {
  const res = await run(findingsConn(), "list_sensor_findings", {
    sensor_kind: "orphan_detector",
  });
  assert.equal(res.returned, 1);
  assert.equal((res.findings as { sensor_kind: string }[])[0].sensor_kind, "orphan_detector");
});
