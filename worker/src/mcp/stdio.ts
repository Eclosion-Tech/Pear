/**
 * Pear MCP server — stdio transport entrypoint.
 *
 * Spawned directly by MCP hosts (Claude Code, Claude Desktop, Cursor, …).
 *
 * Environment variables:
 *   SPACETIMEDB_URI       WebSocket URI of SpacetimeDB (default: ws://localhost:3000)
 *   SPACETIMEDB_DB_NAME   Database name                (default: pear-dev)
 *   PEAR_MCP_TOKEN        AI-user worker token (required — mint with `pnpm mcp:provision`)
 */

// MUST stay the first import — redirects console to stderr and polyfills
// WebSocket before any worker module evaluates. See stdio-prelude.ts.
import "./stdio-prelude.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PearMcpBackend } from "./backend.js";
import { createPearMcpServer } from "./server.js";

const uri = process.env.SPACETIMEDB_URI ?? "ws://localhost:3000";
const dbName = process.env.SPACETIMEDB_DB_NAME ?? "pear-dev";
const token = process.env.PEAR_MCP_TOKEN;

if (!token) {
  console.error(
    "[mcp] PEAR_MCP_TOKEN is required — an AI-user worker token. " +
    "Mint one with `pnpm mcp:provision -- --name \"My Client\"`.",
  );
  process.exit(1);
}

const backend = new PearMcpBackend({ uri, dbName, token, label: "stdio" });

async function main(): Promise<void> {
  backend.start();
  await backend.ready();

  const server = createPearMcpServer(backend);
  await server.connect(new StdioServerTransport());
  console.error(`[mcp] pear MCP server ready on stdio (workspace: ${dbName})`);
}

async function shutdown(): Promise<void> {
  await backend.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((err: unknown) => {
  console.error("[mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
