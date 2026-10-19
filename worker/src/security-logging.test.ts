import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";

import { AuditLogger } from "./audit-logger.js";
import { CompositeToolExecutor } from "./composite-tool-executor.js";
import { McpToolExecutor, type McpClientFactory } from "./mcp-tool-executor.js";
import { executeTool, type ConnLike } from "./tools.js";
import { callLlm, planTasks } from "./llm.js";
import { processRecentConversationMessages } from "./conversation.js";
import { getProviderForAiUser, type ChatResponse, type InferenceProvider } from "./providers.js";
import { AiUserWorker } from "./ai-user-worker.js";
import { DatabaseWorker } from "./database-worker.js";
import { subscribeToAvailableTables } from "./subscriptions.js";
import type { Identity } from "spacetimedb";

const SECRET = "SENTINEL_PRIVATE_MARKER_8675309";
const HOSTILE = `${SECRET}\n\r\u001b[31mforged-log token=${SECRET}`;

function captureConsole(t: TestContext) {
  const lines: string[] = [];
  for (const method of ["log", "warn", "error", "info"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map(arg => typeof arg === "string" ? arg : inspect(arg)).join(" "));
    });
  }
  return {
    text: () => lines.join("\n"),
    assertPrivate() {
      assert.doesNotMatch(lines.join("\n"), /SENTINEL_PRIVATE_MARKER|\u001b|\r/);
    },
  };
}

function table<T>(rows: T[]) {
  return { iter: () => rows[Symbol.iterator]() };
}

test("native diagnostics omit inputs, returned data and unknown tool names", async t => {
  const logs = captureConsole(t);
  const conn: ConnLike = {
    db: { orcha_shared_context: table([{ jobId: 2n, key: HOSTILE, value: HOSTILE }]) },
    reducers: {},
  };
  const result = JSON.parse(await executeTool(conn, "get_context", { key: HOSTILE }, 2n));
  assert.equal(result.value, HOSTILE, "authorized tool results must be preserved");
  assert.match(await executeTool(conn, HOSTILE, { token: HOSTILE }, 2n), /SENTINEL_PRIVATE_MARKER/);
  assert.match(logs.text(), /execution_started tool=get_context/);
  assert.match(logs.text(), /execution_started tool=unknown/);
  logs.assertPrivate();
});

test("search query, credential and result stay out of diagnostics", async t => {
  const logs = captureConsole(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("X-API-KEY"), SECRET);
    assert.equal(JSON.parse(String(init?.body)).q, HOSTILE);
    return new Response(JSON.stringify({ organic: [{ title: HOSTILE, link: `https://example.test/${SECRET}`, snippet: HOSTILE }] }));
  });
  const result = JSON.parse(await executeTool({ db: {}, reducers: {} }, "web_search", { query: HOSTILE }, 0n, { serperApiKey: SECRET }));
  assert.equal(calls, 1);
  assert.equal(result.results[0].snippet, HOSTILE);
  assert.match(logs.text(), /web_search_dispatched provider=serper/);
  logs.assertPrivate();
});

test("fetch diagnostics omit the complete URL, including rejected schemes", async t => {
  const logs = captureConsole(t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network expected"); });
  const url = `file:///${SECRET}?token=${SECRET}`;
  const result = JSON.parse(await executeTool({ db: {}, reducers: {} }, "fetch_url", { url }, 0n));
  assert.equal(result.url, url);
  assert.match(result.content, /Blocked non-http/);
  assert.match(logs.text(), /fetch_url_dispatched/);
  logs.assertPrivate();
});

test("native reducer errors and stacks are private while functional errors remain intact", async t => {
  const logs = captureConsole(t);
  const failure = new Error(HOSTILE);
  failure.stack = HOSTILE;
  const conn: ConnLike = { db: {}, reducers: { setPropertyValue: async () => { throw failure; } } };
  const result = JSON.parse(await executeTool(conn, "set_property_value", {
    page_id: 7, property_definition_id: 8, value_type: "Text", value: HOSTILE,
  }, 0n));
  assert.equal(result.error, HOSTILE);
  assert.match(logs.text(), /execution_failed tool=set_property_value/);
  logs.assertPrivate();
});

test("audit persistence accepts only host outcome codes, not legacy free-text details", async t => {
  const logs = captureConsole(t);
  const rows: Record<string, unknown>[] = [];
  const logger = new AuditLogger({ db: {}, reducers: { recordToolCallAudit: async (row: Record<string, unknown>) => { rows.push(row); } } });
  for (const outcome of ["allowed", "denied", "error"] as const) {
    // An older JS caller may still supply the removed free-text field.
    const entry = { conversationId: 4n, agentId: "worker", toolName: "get_context", rawInput: HOSTILE,
      rawOutput: HOSTILE, outcome, outcomeDetail: HOSTILE };
    await logger.log(entry);
  }
  assert.deepEqual(rows.map(row => row.outcomeDetail), ["tool_allowed", "permission_denied", "tool_execution_failed"]);
  for (const row of rows) {
    assert.match(String(row.inputHash), /^[a-f0-9]{64}$/);
    assert.match(String(row.outputHash), /^[a-f0-9]{64}$/);
    assert.doesNotMatch(inspect(row), /SENTINEL_PRIVATE_MARKER/);
  }
  logs.assertPrivate();
});

test("an audit transport failure cannot echo its request or raw error", async t => {
  const logs = captureConsole(t);
  const logger = new AuditLogger({ db: {}, reducers: { recordToolCallAudit: async () => { throw new Error(HOSTILE); } } });
  await assert.doesNotReject(() => logger.log({ conversationId: 4n, agentId: "worker", toolName: HOSTILE,
    rawInput: HOSTILE, rawOutput: HOSTILE, outcome: "error" }));
  assert.match(logs.text(), /audit_write_failed/);
  logs.assertPrivate();
});

function mcpFixture(action: "Read" | "Write" | "HttpOutbound", name: string, run: () => Promise<string>) {
  const audits: Record<string, unknown>[] = [];
  const health: Record<string, unknown>[] = [];
  let executions = 0;
  let snapshots = 0;
  const conn: ConnLike = {
    db: { ai_extension_runtime: table([{
      installedExtensionId: 41n, serverId: 7n, name: HOSTILE,
      endpoint: `https://user:${SECRET}@example.test/${SECRET}`, authScheme: { tag: "ApiKey" }, apiKey: SECRET,
      capabilities: [], permissions: [{ scope: { tag: "Workspace" }, action: { tag: action }, allowedDomains: "[]" }],
    }]) },
    reducers: {
      reportExtensionRuntimeHealth: async (row: Record<string, unknown>) => { health.push(row); },
      recordToolCallAudit: async (row: Record<string, unknown>) => { audits.push(row); },
      takeSnapshot: async () => { snapshots++; throw new Error(HOSTILE); },
    },
  };
  const factory: McpClientFactory = config => ({ config, connect: async () => {}, disconnect: async () => {},
    getTools: () => [{ name, description: HOSTILE, inputSchema: { type: "object" } }],
    callTool: async () => { executions++; return run(); },
  });
  return { conn, factory, audits, health, executions: () => executions, snapshots: () => snapshots };
}

for (const outcome of ["allowed", "denied", "error"] as const) {
  test(`MCP ${outcome} diagnostics and audit omit private payloads and errors`, async t => {
    const logs = captureConsole(t);
    const name = outcome === "denied" ? "fetch_url_remote" : outcome === "error" ? "update_record" : "get_balance";
    const fixture = mcpFixture(outcome === "denied" ? "HttpOutbound" : outcome === "error" ? "Write" : "Read", name,
      async () => { if (outcome === "error") throw new Error(HOSTILE); return HOSTILE; });
    const executor = await CompositeToolExecutor.create({ conn: fixture.conn, agentId: "worker", currentPageId: 8n,
      staticTools: [], mcpClientFactory: fixture.factory });
    const result = await executor.execute(name, { page_id: 8, url: HOSTILE, token: HOSTILE });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(fixture.executions(), outcome === "denied" ? 0 : 1);
    assert.match(result, /SENTINEL_PRIVATE_MARKER/, "tool-level output remains on the existing result path");
    assert.equal(fixture.audits.length, 1);
    assert.equal(fixture.audits[0].outcome, outcome);
    assert.equal(fixture.audits[0].outcomeDetail, outcome === "denied" ? "permission_denied" : outcome === "error" ? "tool_execution_failed" : "tool_allowed");
    assert.doesNotMatch(inspect(fixture.audits), /SENTINEL_PRIVATE_MARKER/);
    if (outcome === "error") {
      assert.equal(fixture.snapshots(), 2);
      assert.match(logs.text(), /pre_agent_edit_snapshot_failed/);
      assert.match(logs.text(), /post_agent_edit_snapshot_failed/);
    }
    logs.assertPrivate();
    await executor.disconnect();
  });
}

test("MCP handshake failures persist a host code and omit names, endpoint and response", async t => {
  const logs = captureConsole(t);
  const fixture = mcpFixture("Read", "get_balance", async () => HOSTILE);
  const executor = await McpToolExecutor.create(fixture.conn, config => ({ config,
    connect: async () => { throw new Error(HOSTILE); }, disconnect: async () => {}, getTools: () => [], callTool: async () => "unreachable" }));
  assert.equal(executor.getToolDefs().length, 0);
  assert.equal(fixture.health.at(-1)?.detail, "mcp_handshake_failed");
  assert.doesNotMatch(inspect(fixture.health), /SENTINEL_PRIVATE_MARKER/);
  logs.assertPrivate();
});

test("MCP invalid names, collisions and failed health reports cannot inject logs", async t => {
  const logs = captureConsole(t);
  const fixture = mcpFixture("Read", "get_balance", async () => HOSTILE);
  fixture.conn.reducers.reportExtensionRuntimeHealth = async () => { throw new Error(HOSTILE); };
  const executor = await McpToolExecutor.create(fixture.conn, config => ({ config, connect: async () => {}, disconnect: async () => {},
    getTools: () => [HOSTILE, "get_balance", "get_balance"].map(name => ({ name, description: HOSTILE, inputSchema: {} })),
    callTool: async () => HOSTILE }));
  assert.deepEqual(executor.getToolDefs().map(tool => tool.name), ["get_balance"]);
  assert.match(logs.text(), /invalid_tool_name/);
  assert.match(logs.text(), /tool_name_collision/);
  assert.match(logs.text(), /health_report_failed/);
  logs.assertPrivate();
});

test("Orcha preserves private tool traces without logging arguments, output or provider text", async t => {
  const logs = captureConsole(t);
  const conn: ConnLike = { db: { orcha_shared_context: table([{ jobId: 0n, key: HOSTILE, value: HOSTILE }]) }, reducers: {} };
  let turn = 0;
  const provider: InferenceProvider = { chat: async () => ++turn === 1
    ? { content: [{ type: "tool_use", id: "call-1", name: "get_context", input: { key: HOSTILE } }], stopReason: HOSTILE }
    : { content: [{ type: "text", text: HOSTILE }], stopReason: "end_turn" } };
  const result = await callLlm(HOSTILE, conn, 0n, HOSTILE, { provider, model: "stub", maxTokens: 20 });
  assert.match(result.text, /SENTINEL_PRIVATE_MARKER/);
  assert.match(result.toolCalls?.[0]?.input ?? "", /SENTINEL_PRIVATE_MARKER/);
  assert.match(result.toolCalls?.[0]?.output ?? "", /SENTINEL_PRIVATE_MARKER/);
  logs.assertPrivate();
});

test("planner parse diagnostics omit both raw JSON and parse-error excerpts", async t => {
  const logs = captureConsole(t);
  const tasks = await planTasks(HOSTILE, HOSTILE, { model: "stub", provider: { chat: async () => ({
    content: [{ type: "text", text: HOSTILE }], stopReason: "end_turn",
  }) } });
  assert.deepEqual(tasks, []);
  assert.match(logs.text(), /planner_fallback_invalid_json/);
  logs.assertPrivate();
});

for (const streaming of [false, true]) {
  test(`conversation ${streaming ? "streaming" : "nonstreaming"} keeps private content on its message path`, async t => {
    const logs = captureConsole(t);
    const identity = { toHexString: () => "a".repeat(64) };
    const human = { toHexString: () => "b".repeat(64) };
    const messages: any[] = [{ id: 1n, conversationId: 1n, sender: { tag: "User", value: human }, content: HOSTILE,
      status: { tag: "Complete" }, createdAt: { microsSinceUnixEpoch: 1n }, toolCallsJson: undefined }];
    const updates: any[] = [];
    const profile = { aiUserId: 2n, identity, displayName: HOSTILE, providerName: "test", modelName: HOSTILE };
    const config = { id: 2n, identity, createdBy: human, provider: { tag: "OpenAiCompatible" }, endpoint: "https://unused.invalid/v1",
      apiKey: SECRET, model: "stub", maxTokens: 100 };
    const conn: ConnLike = { db: {
      conversation: { id: { find: () => ({ id: 1n, status: { tag: "Active" }, initiatedBy: human }) } },
      conversation_participant: table([{ conversationId: 1n, identity }]),
      conversation_message: table(messages), ai_user_profile: table([profile]), ai_user_config: { id: { find: () => config } },
      conversation_attachment: table([]),
    }, reducers: {
      sendMessage: async (row: any) => { messages.push({ ...row, id: 2n, sender: { tag: "User", value: identity }, createdAt: { microsSinceUnixEpoch: 2n } }); },
      updateMessage: async (row: any) => { updates.push(row); },
    } };
    const resolved = getProviderForAiUser(conn, 2n);
    let turn = 0;
    const response = (): ChatResponse => ++turn === 1
      ? { content: [{ type: "tool_use", id: "call-1", name: HOSTILE, input: { token: HOSTILE } }], stopReason: "tool_use" }
      : { content: [{ type: "text", text: HOSTILE }], stopReason: "end_turn" };
    resolved.provider = { chat: async () => response() };
    if (streaming) resolved.provider.chatStream = async function* () {
      const next = response();
      for (const block of next.content) if (block.type === "tool_use") yield { type: "tool_use_start", block };
      yield { type: "done", response: next };
    };
    await processRecentConversationMessages(conn, identity as Identity, HOSTILE);
    assert.equal(turn, 2);
    assert.equal(updates.at(-1)?.status.tag, "Complete");
    assert.match(updates.at(-1)?.content ?? "", /SENTINEL_PRIVATE_MARKER/);
    assert.match(updates.at(-1)?.toolCallsJson ?? "", /SENTINEL_PRIVATE_MARKER/);
    logs.assertPrivate();
  });
}

test("worker claim/provider/disconnect failures omit environment labels and raw errors", async t => {
  const logs = captureConsole(t);
  const options = { uri: `ws://user:${SECRET}@unused.invalid`, dbName: HOSTILE, agentId: HOSTILE, token: SECRET, label: HOSTILE };
  const ai = new AiUserWorker(options);
  const aiState = ai as unknown as { conn: unknown };
  aiState.conn = { db: { get ai_user_config() { throw new Error(HOSTILE); } }, disconnect() { throw new Error(HOSTILE); } };
  assert.equal(ai.resolveProvider(2n), undefined);
  await ai.stop();
  const database = new DatabaseWorker(options);
  const dbState = database as unknown as { conn: unknown; claimAndExecute(conn: unknown, task: unknown): Promise<void> };
  await dbState.claimAndExecute({ reducers: { claimTask: async () => { throw new Error(HOSTILE); } } }, { id: 9n, taskType: HOSTILE });
  dbState.conn = { disconnect() { throw new Error(HOSTILE); } };
  await database.stop();
  assert.match(logs.text(), /provider_resolution_failed/);
  assert.match(logs.text(), /task_claim_failed/);
  assert.match(logs.text(), /disconnect_failed/);
  logs.assertPrivate();
});

test("subscription failures cannot reflect unknown table names, labels or raw errors", t => {
  const logs = captureConsole(t);
  const conn = { subscriptionBuilder() {
    let fail = (_ctx: unknown, _error: unknown) => {};
    const builder = { onApplied: () => builder, onError: (callback: typeof fail) => { fail = callback; return builder; },
      subscribe: () => { fail({}, new Error(`no such table: \`${HOSTILE}\``)); } };
    return builder;
  } };
  subscribeToAvailableTables(conn, HOSTILE, () => {});
  assert.match(logs.text(), /subscription_failed/);
  logs.assertPrivate();
});

test("global crash handlers log fixed codes without starting a worker in this test", () => {
  // Importing index.ts starts a real connection, so inspect only these two
  // process-handler bodies; runtime diagnostic paths are exercised above.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  for (const event of ["unhandledRejection", "uncaughtException"]) {
    const body = source.match(new RegExp(`process\\.on\\("${event}", \\(\\) => \\{([\\s\\S]*?)\\n\\}\\);`))?.[1];
    assert.ok(body, `${event} must not accept a raw diagnostic argument`);
    assert.doesNotMatch(body, /console\.error\([^\n]*,/);
  }
});
