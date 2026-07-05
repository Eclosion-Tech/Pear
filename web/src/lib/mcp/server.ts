/**
 * MCP server core — binds the tool registry onto an SDK `Server` instance.
 *
 * Transport-agnostic: hosts create the transport and connect it —
 *   • worker stdio  → StdioServerTransport
 *   • worker http   → StreamableHTTPServerTransport (Node req/res)
 *   • CF gateway    → WebStandardStreamableHTTPServerTransport (Request/Response)
 * One server instance serves one McpContext (one AI-user token).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpContext, McpToolEntry } from "./types";
import { buildToolRegistry } from "./tools";

export const SERVER_INFO = { name: "pear", version: "0.2.0" };

export interface CreatePearMcpServerOptions {
  /**
   * Capability boundary for OAuth-authenticated clients: tools failing the
   * predicate are hidden from tools/list and rejected in tools/call with an
   * error naming the missing scope (see mcp-oauth/scopes.ts). Omitted =
   * full registry (worker-token callers).
   */
  toolFilter?: (name: string) => boolean;
  /** Human-readable hint appended to filtered-tool rejections. */
  missingScopeHint?: (name: string) => string | undefined;
}

export function createPearMcpServer(
  ctx: McpContext,
  options: CreatePearMcpServerOptions = {},
): Server {
  const registry = buildToolRegistry().filter(
    (t) => !options.toolFilter || options.toolFilter(t.name),
  );
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
      const hint = options.missingScopeHint?.(name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: hint ?? `Unknown tool: ${name}`,
            }),
          },
        ],
        isError: true,
      };
    }
    let result: string;
    try {
      result = await entry.execute(ctx, (args ?? {}) as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
        isError: true,
      };
    }
    // Tool results are JSON strings with an `ok` field; surface failures as
    // MCP tool errors so clients treat them accordingly.
    let isError = false;
    try {
      const parsed = JSON.parse(result) as { ok?: boolean };
      isError = parsed.ok === false;
    } catch {
      // Non-JSON result — treat as success.
    }
    return { content: [{ type: "text", text: result }], isError };
  });

  return server;
}
