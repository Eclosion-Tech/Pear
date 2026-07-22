import assert from "node:assert/strict";
import test from "node:test";

import {
  McpToolExecutor,
  type McpClientFactory,
} from "./mcp-tool-executor.js";
import { CompositeToolExecutor } from "./composite-tool-executor.js";
import type { McpServerConfig, McpToolDef } from "./mcp-client.js";
import type { ConnLike } from "./tools.js";

type RuntimeRow = {
  installedExtensionId: bigint;
  serverId: bigint;
  name: string;
  endpoint: string;
  authScheme: { tag: string };
  apiKey?: string;
  capabilities: string[];
  permissions: Array<{
    scope: { tag: "Workspace" };
    action: { tag: "Read" };
    allowedDomains?: string;
  }>;
};

function fakeConn(rows: RuntimeRow[]) {
  const health: Array<Record<string, unknown>> = [];
  const conn: ConnLike = {
    db: {
      ai_extension_runtime: {
        iter: () => rows[Symbol.iterator](),
      },
    },
    reducers: {
      reportExtensionRuntimeHealth: async (args: Record<string, unknown>) => {
        health.push(args);
      },
    },
  };
  return { conn, health };
}

function runtimeRow(overrides: Partial<RuntimeRow> = {}): RuntimeRow {
  return {
    installedExtensionId: 41n,
    serverId: 7n,
    name: "syntropy-finance",
    endpoint: "https://finance.example.test/mcp",
    authScheme: { tag: "ApiKey" },
    apiKey: "secret",
    capabilities: ["trial-balance"],
    permissions: [
      {
        scope: { tag: "Workspace" },
        action: { tag: "Read" },
      },
    ],
    ...overrides,
  };
}

function clientFactory(
  tools: McpToolDef[],
  calls: Array<{ config: McpServerConfig; name: string; input: Record<string, unknown> }>,
): McpClientFactory {
  return (config) => ({
    config,
    connect: async () => undefined,
    disconnect: async () => undefined,
    getTools: () => tools,
    callTool: async (name, input) => {
      calls.push({ config, name, input });
      return JSON.stringify({ ok: true, server: config.name, name, input });
    },
  });
}

test("discovers publisher-visible MCP tools, preserves extension ownership, and reports health", async () => {
  const { conn, health } = fakeConn([runtimeRow()]);
  const calls: Array<{
    config: McpServerConfig;
    name: string;
    input: Record<string, unknown>;
  }> = [];
  const executor = await McpToolExecutor.create(
    conn,
    clientFactory(
      [
        {
          name: "get_trial_balance",
          description: "Read the current trial balance",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      calls,
    ),
  );

  assert.equal(executor.hasTool("get_trial_balance"), true);
  assert.equal(executor.installedExtensionIdForTool("get_trial_balance"), 41n);
  assert.deepEqual(executor.getToolDefs().map((tool) => tool.name), ["get_trial_balance"]);
  assert.deepEqual(executor.getPermissionRows(), [
    {
      installedExtensionId: 41n,
      scope: { tag: "Workspace" },
      action: { tag: "Read" },
      allowedDomains: undefined,
    },
  ]);

  const result = await executor.executeTool("get_trial_balance", { period: "2026-07" });
  assert.equal(JSON.parse(result).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.apiKey, "secret");
  assert.deepEqual(
    health.map((entry) => [
      (entry.status as { tag: string }).tag,
      entry.toolCount,
    ]),
    [
      ["Connecting", 0],
      ["Connected", 1],
    ],
  );
});

test("a failed MCP handshake exposes no tools and reports the failure", async () => {
  const { conn, health } = fakeConn([runtimeRow()]);
  const executor = await McpToolExecutor.create(conn, (config) => ({
    config,
    connect: async () => {
      throw new Error("HTTP 401");
    },
    disconnect: async () => undefined,
    getTools: () => [],
    callTool: async () => "unreachable",
  }));

  assert.equal(executor.getToolDefs().length, 0);
  assert.equal((health.at(-1)?.status as { tag: string }).tag, "Error");
  assert.match(String(health.at(-1)?.detail), /401/);
});

test("the composite runtime sends MCP definitions to the model path and routes calls", async () => {
  const { conn } = fakeConn([runtimeRow()]);
  conn.reducers.recordToolCallAudit = async () => undefined;
  const calls: Array<{
    config: McpServerConfig;
    name: string;
    input: Record<string, unknown>;
  }> = [];
  const executor = await CompositeToolExecutor.create({
    conn,
    agentId: "sterling",
    staticTools: [],
    mcpClientFactory: clientFactory(
      [
        {
          name: "get_trial_balance",
          description: "Read the current trial balance",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      calls,
    ),
  });

  assert.deepEqual(executor.getToolDefs().map((tool) => tool.name), ["get_trial_balance"]);
  const result = await executor.execute("get_trial_balance", { period: "2026-07" });
  assert.equal(JSON.parse(result).ok, true);
  assert.equal(calls.length, 1);
  await executor.disconnect();
});

test("the composite runtime reads secrets and writes audit through the publisher connection", async () => {
  const { conn: agentConn } = fakeConn([]);
  const { conn: publisherConn, health } = fakeConn([runtimeRow()]);
  const audits: Array<Record<string, unknown>> = [];
  publisherConn.reducers.recordToolCallAudit = async (args: Record<string, unknown>) => {
    audits.push(args);
  };
  agentConn.reducers.recordToolCallAudit = async () => {
    throw new Error("AI-user connection must not write MCP audit rows");
  };

  const calls: Array<{
    config: McpServerConfig;
    name: string;
    input: Record<string, unknown>;
  }> = [];
  const executor = await CompositeToolExecutor.create({
    conn: agentConn,
    mcpRuntimeConn: publisherConn,
    conversationId: 12n,
    agentId: "sterling",
    staticTools: [],
    mcpClientFactory: clientFactory(
      [{ name: "get_trial_balance", description: "Read", inputSchema: { type: "object" } }],
      calls,
    ),
  });

  assert.deepEqual(executor.getToolDefs().map((tool) => tool.name), ["get_trial_balance"]);
  assert.equal(JSON.parse(await executor.execute("get_trial_balance", {})).ok, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(health.at(-1)?.toolCount, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].installedExtensionId, 41n);
  await executor.disconnect();
});

test("the composite runtime denies an MCP call without its extension permission", async () => {
  const { conn } = fakeConn([runtimeRow({ permissions: [] })]);
  conn.reducers.recordToolCallAudit = async () => undefined;
  const calls: Array<{
    config: McpServerConfig;
    name: string;
    input: Record<string, unknown>;
  }> = [];
  const executor = await CompositeToolExecutor.create({
    conn,
    agentId: "sterling",
    staticTools: [],
    mcpClientFactory: clientFactory(
      [{ name: "get_trial_balance", description: "Read", inputSchema: { type: "object" } }],
      calls,
    ),
  });

  const result = JSON.parse(await executor.execute("get_trial_balance", {}));
  assert.equal(result.ok, false);
  assert.match(result.error, /No "Read" permission/);
  assert.equal(calls.length, 0);
  await executor.disconnect();
});
