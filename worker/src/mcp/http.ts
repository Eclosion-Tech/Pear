/**
 * Pear MCP server — streamable HTTP transport entrypoint.
 *
 * The bearer token IS the AI user's worker token: each distinct token gets its
 * own cached SpacetimeDB backend connection, so tool calls run as (and are
 * RLS-governed by) that AI user. Stateless MCP mode — a fresh Server +
 * transport per request, no session bookkeeping; tools-only servers don't
 * need server→client notifications.
 *
 * Environment variables:
 *   SPACETIMEDB_URI            (default: ws://localhost:3000)
 *   SPACETIMEDB_DB_NAME        (default: pear-dev)
 *   PEAR_MCP_HTTP_HOST         (default: 127.0.0.1)
 *   PEAR_MCP_HTTP_PORT         (default: 3888)
 *   PEAR_MCP_IDLE_TIMEOUT_MS   backend cache eviction (default: 1800000)
 *   PEAR_MCP_ALLOWED_HOSTS     comma-separated Host-header allowlist; overrides
 *                              the localhost default (DNS-rebinding protection)
 */

// Polyfill WebSocket for Node.js < 21. Must come before any spacetimedb import.
import { WebSocket } from "ws";
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;
}

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PearMcpBackend } from "./backend.js";
import { createPearMcpServer } from "./server.js";

const URI = process.env.SPACETIMEDB_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? "pear-dev";
const HOST = process.env.PEAR_MCP_HTTP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PEAR_MCP_HTTP_PORT ?? 3888);
const IDLE_TIMEOUT_MS = Number(process.env.PEAR_MCP_IDLE_TIMEOUT_MS ?? 1_800_000);
const MAX_BACKENDS = 50;

const isLoopback = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
const allowedHosts = process.env.PEAR_MCP_ALLOWED_HOSTS
  ? process.env.PEAR_MCP_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
  : isLoopback
    ? [`localhost:${PORT}`, `127.0.0.1:${PORT}`]
    : [];

// ── Per-token backend cache ───────────────────────────────────────────────────

const backends = new Map<string, Promise<PearMcpBackend>>();

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

async function getBackend(token: string): Promise<PearMcpBackend> {
  const key = tokenKey(token);
  const cached = backends.get(key);
  if (cached) return cached;

  if (backends.size >= MAX_BACKENDS) {
    throw new Error("Too many active connections — try again later.");
  }

  const promise = (async () => {
    const backend = new PearMcpBackend({
      uri: URI,
      dbName: DB_NAME,
      token,
      label: `http:${key.slice(0, 6)}`,
    });
    backend.start();
    await backend.ready();
    backend.lastUsedAt = Date.now();
    return backend;
  })();

  backends.set(key, promise);
  promise.catch(() => backends.delete(key));
  return promise;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, promise] of backends) {
    void promise.then((backend) => {
      if (now - backend.lastUsedAt > IDLE_TIMEOUT_MS) {
        console.log(`[mcp-http] evicting idle backend ${key.slice(0, 6)}…`);
        backends.delete(key);
        void backend.close();
      }
    }).catch(() => backends.delete(key));
  }
}, 60_000).unref();

// ── HTTP server ───────────────────────────────────────────────────────────────

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const httpServer = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    console.error("[mcp-http] request error:", err instanceof Error ? err.message : err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    } else {
      res.end();
    }
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && path === "/healthz") {
    sendJson(res, 200, { ok: true, workspace: DB_NAME, activeBackends: backends.size });
    return;
  }

  if (path !== "/mcp") {
    sendJson(res, 404, { error: "Not found. MCP endpoint is POST /mcp." });
    return;
  }

  if (req.method !== "POST") {
    // Stateless mode: no standalone SSE stream, no sessions to delete.
    res.writeHead(405, { Allow: "POST" });
    res.end();
    return;
  }

  const token = bearerToken(req);
  if (!token) {
    sendJson(res, 401, {
      error: "Missing bearer token. Send the AI user's worker token as `Authorization: Bearer <token>`.",
    });
    return;
  }

  let backend: PearMcpBackend;
  try {
    backend = await getBackend(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 401, { error: `Authentication failed: ${message}` });
    return;
  }
  backend.lastUsedAt = Date.now();

  const server = createPearMcpServer(backend);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    ...(allowedHosts.length > 0
      ? { enableDnsRebindingProtection: true, allowedHosts }
      : {}),
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

httpServer.listen(PORT, HOST, () => {
  console.log(
    `[mcp-http] pear MCP server listening on http://${HOST}:${PORT}/mcp (workspace: ${DB_NAME})`,
  );
});

async function shutdown(): Promise<void> {
  httpServer.close();
  await Promise.allSettled(
    [...backends.values()].map((p) => p.then((b) => b.close()).catch(() => undefined)),
  );
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
