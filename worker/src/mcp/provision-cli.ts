/**
 * Provision an AI user for the Pear MCP server and print its worker token.
 *
 * Mirrors the self-hosted web flow (AiUsersSettings.tsx): mint an anonymous
 * SpacetimeDB identity, create_ai_user, set_ai_user_worker_token, and
 * provision_ai_user_memory — all on the operator's connection, since those
 * reducers are creator/admin-gated. The web UI never re-displays a worker
 * token after creation, so this CLI is the primary way to obtain one.
 *
 * Usage:
 *   PEAR_ADMIN_TOKEN=<your token> pnpm --filter @pear/worker mcp:provision -- --name "Claude Code"
 *
 * Environment variables:
 *   SPACETIMEDB_URI       (default: ws://localhost:3000)
 *   SPACETIMEDB_DB_NAME   (default: pear-dev)
 *   PEAR_ADMIN_TOKEN      Operator's SpacetimeDB token (required). Grab it from
 *                         the web app's localStorage (`pear:token:<workspace>`)
 *                         or use the module publisher's token.
 *
 * Flags:
 *   --name <display name>   Display name for the AI user (required)
 *   --no-memory              Skip provisioning the private memory subtree
 */

// Polyfill WebSocket for Node.js < 21. Must come before any spacetimedb import.
import { WebSocket } from "ws";
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;
}

import { Identity } from "spacetimedb";
import { DbConnection, type EventContext } from "../module_bindings/index.js";
import { subscribeToAvailableTables } from "../subscriptions.js";

// Keep stdout reserved for the token (pipeable); the spacetimedb SDK and
// worker helpers log via console.log/info/debug at runtime.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const URI = process.env.SPACETIMEDB_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? "pear-dev";
const ADMIN_TOKEN = process.env.PEAR_ADMIN_TOKEN;

function parseArgs(): { name: string; memory: boolean } {
  const argv = process.argv.slice(2);
  let name = "";
  let memory = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") name = argv[++i] ?? "";
    else if (argv[i] === "--no-memory") memory = false;
  }
  if (!name.trim()) {
    console.error('Usage: pnpm mcp:provision -- --name "Claude Code" [--no-memory]');
    process.exit(1);
  }
  return { name: name.trim(), memory };
}

function toHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

async function mintIdentity(): Promise<{ identity: string; token: string }> {
  const res = await fetch(`${toHttpUrl(URI)}/v1/identity`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to mint SpacetimeDB identity (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<{ identity: string; token: string }>;
}

async function waitFor<T>(check: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for row to appear.");
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function main(): Promise<void> {
  if (!ADMIN_TOKEN) {
    console.error(
      "PEAR_ADMIN_TOKEN is required — your own SpacetimeDB token for this workspace.\n" +
      "In the web app, run `localStorage.getItem('pear:token:<workspace>')` in the console,\n" +
      "or use the token the worker uses as SPACETIMEDB_TOKEN.",
    );
    process.exit(1);
  }
  const { name, memory } = parseArgs();

  console.error(`Minting identity for "${name}" via ${toHttpUrl(URI)}/v1/identity …`);
  const minted = await mintIdentity();
  const aiUserIdentity = Identity.fromString(minted.identity);

  console.error(`Connecting to ${URI}/${DB_NAME} as operator …`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection timed out.")), 20_000);

    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB_NAME)
      .withToken(ADMIN_TOKEN)
      .onConnect((conn, operatorIdentity) => {
        subscribeToAvailableTables(conn, "[mcp-provision]", () => {
          void (async () => {
            try {
              console.error("Creating AI user …");
              await conn.reducers.createAiUser({
                aiUserIdentity,
                createdByIdentity: operatorIdentity,
                displayName: name,
                provider: { tag: "Anthropic" },
                // Placeholder — this AI user never runs inference in Pear;
                // the external MCP client is the model.
                model: "external-mcp-client",
                endpoint: undefined,
                apiKey: undefined,
                systemPrompt: undefined,
                maxTokens: undefined,
                avatarUrl: undefined,
              });

              type ProfileRow = { aiUserId: bigint; identity: Identity };
              const profile = await waitFor(() =>
                [...(conn.db.ai_user_profile.iter() as Iterable<ProfileRow>)].find(
                  (p) => p.identity.toHexString() === aiUserIdentity.toHexString(),
                ),
              );
              console.error(`AI user created — id=${profile.aiUserId}`);

              await conn.reducers.setAiUserWorkerToken({
                aiUserIdentity,
                workerToken: minted.token,
              });

              if (memory) {
                console.error("Provisioning private memory subtree …");
                await conn.reducers.provisionAiUserMemory({ aiUserId: profile.aiUserId });
                type MemRow = { aiUserId: bigint };
                await waitFor(() =>
                  [...(conn.db.ai_user_memory.iter() as Iterable<MemRow>)].find(
                    (m) => m.aiUserId === profile.aiUserId,
                  ),
                );
                console.error("Memory provisioned.");
              }

              clearTimeout(timeout);
              printResult(name, profile.aiUserId, minted.token);
              conn.disconnect();
              resolve();
            } catch (err) {
              clearTimeout(timeout);
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          })();
        });
      })
      .onConnectError((_ctx: EventContext, err: Error) => {
        clearTimeout(timeout);
        reject(new Error(`Connection failed: ${err?.message ?? err}`));
      })
      .build();
  });
}

function printResult(name: string, aiUserId: bigint, token: string): void {
  // The token goes to stdout so it can be piped; everything else to stderr.
  console.error(`\n✓ AI user "${name}" (id=${aiUserId}) is ready for MCP.\n`);
  console.error("Worker token (treat like a password — full authority as this AI user):\n");
  process.stdout.write(`${token}\n`);
  console.error(`
── Claude Code (stdio) ─────────────────────────────────────────────
claude mcp add pear \\
  --env SPACETIMEDB_URI=${URI} \\
  --env SPACETIMEDB_DB_NAME=${DB_NAME} \\
  --env PEAR_MCP_TOKEN=${token.slice(0, 12)}… \\
  -- pnpm --filter @pear/worker mcp:stdio

── .mcp.json / Claude Desktop / Cursor (stdio) ─────────────────────
{
  "mcpServers": {
    "pear": {
      "command": "pnpm",
      "args": ["--filter", "@pear/worker", "mcp:stdio"],
      "env": {
        "SPACETIMEDB_URI": "${URI}",
        "SPACETIMEDB_DB_NAME": "${DB_NAME}",
        "PEAR_MCP_TOKEN": "<token printed above>"
      }
    }
  }
}

── HTTP mode ───────────────────────────────────────────────────────
Start the server:  pnpm mcp
claude mcp add --transport http pear http://localhost:3888/mcp \\
  --header "Authorization: Bearer <token printed above>"
`);
}

main().catch((err: unknown) => {
  console.error("Provisioning failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
