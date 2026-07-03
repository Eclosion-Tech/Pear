/**
 * Pear MCP server — stdio transport entrypoint.
 *
 * Spawned directly by MCP hosts (Claude Code, Claude Desktop, Cursor, …).
 * Stateless: tools run over SpacetimeDB's HTTP `/sql` + `/call` endpoints
 * via the shared core in `web/src/lib/mcp` — no WebSocket subscription.
 *
 * Environment variables:
 *   SPACETIMEDB_URI       WebSocket or HTTP URI of SpacetimeDB (default: ws://localhost:3000)
 *   SPACETIMEDB_DB_NAME   Database name                        (default: pear-dev)
 *   PEAR_MCP_TOKEN        AI-user worker token (required — mint with `pnpm mcp:provision`)
 */

// MUST stay the first import — redirects console to stderr before any noisy
// module evaluates (stdout is the protocol channel). See stdio-prelude.ts.
import "./stdio-prelude.js";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createPearMcpServer,
  resolveAiUser,
  HttpStdbTransport,
} from "../../../web/src/lib/mcp/index.js";
import { wsUriToHttpBase } from "../bridge-sql.js";

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

async function main(): Promise<void> {
  const transport = new HttpStdbTransport({
    baseUrl: wsUriToHttpBase(uri),
    dbName,
    token: token!,
    timeoutMs: 15_000,
  });
  // Resolves the AI user AND authenticates the token in one RLS-scoped read.
  const aiUserId = await resolveAiUser(transport);

  const server = createPearMcpServer({ transport, aiUserId });
  await server.connect(new StdioServerTransport());
  console.error(
    `[mcp] pear MCP server ready on stdio (workspace: ${dbName}, ai user: ${aiUserId})`,
  );
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((err: unknown) => {
  console.error("[mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
