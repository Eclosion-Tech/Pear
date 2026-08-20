/**
 * Pear MCP server — streamable HTTP transport entrypoint (OSS self-host).
 *
 * Serves both protocol eras from one endpoint via the SDK's
 * `createMcpHandler`: 2026-07-28 stateless requests (per-request `_meta`
 * envelope, `server/discover`) and legacy `initialize`-handshake revisions
 * through the stateless fallback.
 *
 * The bearer token IS the AI user's worker token. Stateless: every tool call
 * runs over SpacetimeDB's HTTP `/sql` + `/call` endpoints with the caller's
 * token (shared core in `web/src/lib/mcp`), so there is no per-token
 * connection to hold — only a small token→aiUserId resolution cache to save
 * one SQL round-trip per request.
 *
 * Environment variables:
 *   SPACETIMEDB_URI            (default: ws://localhost:3000)
 *   SPACETIMEDB_DB_NAME        (default: pear-dev)
 *   PEAR_MCP_HTTP_HOST         (default: 127.0.0.1)
 *   PEAR_MCP_HTTP_PORT         (default: 3888)
 *   PEAR_MCP_ALLOWED_HOSTS     comma-separated Host-header allowlist; overrides
 *                              the localhost default (DNS-rebinding protection)
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createPearMcpServer,
  resolveAiUser,
  McpAuthError,
  HttpStdbTransport,
} from "../../../web/src/lib/mcp/index.js";
import { wsUriToHttpBase } from "../bridge-sql.js";
import { workspaceFileReaderFor } from "../workspace-files.js";

const URI = process.env.SPACETIMEDB_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? "pear-dev";
const HOST = process.env.PEAR_MCP_HTTP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PEAR_MCP_HTTP_PORT ?? 3888);
const STDB_BASE = wsUriToHttpBase(URI);

const isLoopback = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
const allowedHosts = process.env.PEAR_MCP_ALLOWED_HOSTS
  ? process.env.PEAR_MCP_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
  : isLoopback
    ? [`localhost:${PORT}`, `127.0.0.1:${PORT}`]
    : [];

// ── Token → AI user cache (avoids one /sql round-trip per request) ────────────

const AI_USER_TTL_MS = 10 * 60_000;
const aiUserCache = new Map<string, { aiUserId: bigint; expiresAt: number }>();

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

async function resolveCached(
  transport: HttpStdbTransport,
  token: string,
): Promise<bigint> {
  const key = tokenKey(token);
  const hit = aiUserCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.aiUserId;
  const aiUserId = await resolveAiUser(transport);
  aiUserCache.set(key, { aiUserId, expiresAt: Date.now() + AI_USER_TTL_MS });
  if (aiUserCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of aiUserCache) if (v.expiresAt <= now) aiUserCache.delete(k);
  }
  return aiUserId;
}

// ── MCP handler ───────────────────────────────────────────────────────────────

/** Per-request state handed from `handle` to the factory via `req.auth`. */
interface PearMcpAuthExtra extends Record<string, unknown> {
  transport: HttpStdbTransport;
  aiUserId: bigint;
}

const mcpHandler = createMcpHandler(({ authInfo }) => {
  const extra = authInfo?.extra as PearMcpAuthExtra;
  return createPearMcpServer({
    transport: extra.transport,
    aiUserId: extra.aiUserId,
    files: workspaceFileReaderFor(DB_NAME),
  });
});
const nodeMcpHandler = toNodeHandler(mcpHandler);

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
    sendJson(res, 200, { ok: true, workspace: DB_NAME });
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

  // DNS-rebinding protection. The v2 handler validates no Host header (that
  // was the v1 transport's enableDnsRebindingProtection), so the allowlist
  // is enforced here, in front of it.
  if (allowedHosts.length > 0 && !allowedHosts.includes(req.headers.host ?? "")) {
    sendJson(res, 403, { error: "Forbidden: Host header is not in the allowlist" });
    return;
  }

  const token = bearerToken(req);
  if (!token) {
    sendJson(res, 401, {
      error: "Missing bearer token. Send the AI user's worker token as `Authorization: Bearer <token>`.",
    });
    return;
  }

  const transport = new HttpStdbTransport({
    baseUrl: STDB_BASE,
    dbName: DB_NAME,
    token,
    timeoutMs: 15_000,
  });

  let aiUserId: bigint;
  try {
    aiUserId = await resolveCached(transport, token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      err instanceof McpAuthError || /401|403|unauthorized/i.test(message) ? 401 : 502;
    sendJson(res, status, { error: `Authentication failed: ${message}` });
    return;
  }

  // toNodeHandler forwards req.auth as the handler's pass-through authInfo;
  // extra carries what the module-level factory needs for this request.
  (req as IncomingMessage & { auth?: AuthInfo }).auth = {
    token,
    clientId: `ai-user:${aiUserId}`,
    scopes: [],
    extra: { transport, aiUserId } satisfies PearMcpAuthExtra,
  };
  await nodeMcpHandler(req, res);
}

httpServer.listen(PORT, HOST, () => {
  console.log(
    `[mcp-http] pear MCP server listening on http://${HOST}:${PORT}/mcp (workspace: ${DB_NAME}, stateless)`,
  );
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
