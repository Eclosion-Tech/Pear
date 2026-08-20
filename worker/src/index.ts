/**
 * Pear LLM Worker — Orcha agent implementation.
 *
 * Uses the DatabaseWorker class to connect to a single SpacetimeDB database
 * and process Orcha tasks + AI conversations. For multi-database deployments
 * (e.g. Pear Cloud), import DatabaseWorker directly and manage multiple
 * instances from a custom entry point.
 *
 * Environment variables:
 *   SPACETIMEDB_URI          WebSocket URI of SpacetimeDB  (default: ws://localhost:3000)
 *   SPACETIMEDB_DB_NAME      Database name                 (default: pear-dev)
 *   SPACETIMEDB_TOKEN        Auth token for owner/admin access (enables per-user API keys)
 *   ANTHROPIC_API_KEY        Fallback Anthropic API key (used when no per-user key is set)
 *   ANTHROPIC_MODEL          Frontier model for llm tasks  (default: claude-haiku-4-5-20251001)
 *   ANTHROPIC_PLANNER_MODEL  Fast model for orchestrate    (default: same as ANTHROPIC_MODEL)
 *   ORCHA_AGENT_ID           Stable agent identity string  (default: pear-llm-worker)
 *   S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY / S3_SECRET_KEY
 *                            Workspace blob storage. Enables chat image
 *                            vision, File attachments and the `read_file`
 *                            tool (page file/image/audio blocks, File cells).
 *                            Unset → those degrade to "not available" notes.
 *   LIFECYCLE_URL + SPACETIMEDB_ADMIN_TOKEN
 *                            (Pear Cloud) resolve the workspace id for bare
 *                            blob object ids via `blob-context`; standalone
 *                            deployments leave them unset.
 */

// Polyfill WebSocket for Node.js < 21. Must come before any spacetimedb import.
import { WebSocket } from "ws";
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;
}

import { DatabaseWorker } from "./database-worker.js";

const AGENT_ID = process.env.ORCHA_AGENT_ID ?? "pear-llm-worker";
const SPACETIMEDB_URI = process.env.SPACETIMEDB_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? "pear-dev";
const TOKEN = process.env.SPACETIMEDB_TOKEN;

console.log(`[worker] Pear LLM worker starting — agent: ${AGENT_ID}`);
console.log(`[worker] Connecting to ${SPACETIMEDB_URI} / ${DB_NAME}`);
if (TOKEN) {
  console.log("[worker] Authenticated connection (admin token provided)");
}

const worker = new DatabaseWorker({
  uri: SPACETIMEDB_URI,
  dbName: DB_NAME,
  agentId: AGENT_ID,
  token: TOKEN,
});

worker.start();

process.on("SIGINT", () => { console.log("[worker] Shutting down"); void worker.stop().then(() => process.exit(0)); });
process.on("SIGTERM", () => { console.log("[worker] Shutting down"); void worker.stop().then(() => process.exit(0)); });
process.on("unhandledRejection", (reason) => {
  console.error("[worker] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[worker] Uncaught exception:", err);
  process.exit(1);
});
