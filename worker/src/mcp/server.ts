/**
 * MCP server core — wires the tool registry onto an MCP `Server` instance.
 *
 * Transport-agnostic: stdio.ts and http.ts create the transport and connect
 * it. One server instance serves one PearMcpBackend (one AI-user identity).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { PearMcpBackend } from "./backend.js";
import { buildToolRegistry, type McpToolEntry } from "./tool-registry.js";

export const SERVER_INFO = { name: "pear", version: "0.1.0" };

export function createPearMcpServer(backend: PearMcpBackend): Server {
  const registry = buildToolRegistry();
  const byName = new Map<string, McpToolEntry>(registry.map((t) => [t.name, t]));

  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: registry.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = byName.get(name);
    if (!entry) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }
    backend.lastUsedAt = Date.now();
    let result: string;
    try {
      result = await entry.handler(
        backend.getConn(),
        (args ?? {}) as Record<string, unknown>,
        backend.getToolContext(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
        isError: true,
      };
    }
    // Executor results are JSON strings with an `ok` field; surface failures
    // as MCP tool errors so clients treat them accordingly.
    let isError = false;
    try {
      const parsed = JSON.parse(result) as { ok?: boolean };
      isError = parsed.ok === false;
    } catch {
      // Non-JSON result (e.g. web_search text) — treat as success.
    }
    return { content: [{ type: "text", text: result }], isError };
  });

  return server;
}
