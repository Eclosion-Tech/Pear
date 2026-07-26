/**
 * Tool parity between the chat surface and MCP.
 *
 * Everything an MCP client can do to a workspace, an AI user in chat should be
 * able to do too — `PEAR_EXPRESSIVE_SURFACES.md` § 16 is explicit that the AI is
 * a UI author that "rearranges and restyles on request", and that is the chat
 * AI, not an external client. Page authoring, theming and thread management all
 * shipped on the MCP registry first, which left Kira unable to do any of it.
 *
 * ## One implementation, two surfaces
 *
 * These are NOT reimplemented against `conn.reducers`. The worker registers an
 * `HttpStdbTransport` per AI user — using the same uri/dbName/token the bridge
 * `/sql` reader already uses, so RLS stays scoped to that AI user — and the chat
 * tool executor delegates straight to `buildToolRegistry()`.
 *
 * A parallel implementation would drift: two versions of "insert a component"
 * or "resolve a thread" eventually disagree about validation or error text, and
 * the divergence shows up as an agent behaving differently depending on whether
 * it is in chat or over MCP. That is a bug nobody can reproduce.
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  HttpStdbTransport,
  buildToolRegistry,
  type McpToolEntry,
} from "../../web/src/lib/mcp/index.js";
import { wsUriToHttpBase } from "./bridge-sql.js";

/**
 * Tools the chat surface takes verbatim from the MCP registry.
 *
 * Deliberately a list rather than "everything": memory tools already exist on
 * the chat surface with chat-specific descriptions, and page CRUD is already
 * there too. This names only what was missing.
 */
const PARITY_TOOL_NAMES = new Set([
  // Page UI authoring (M2/M4 — the reason a repeater can exist on a page)
  "get_page_components",
  "insert_component",
  "update_component_props",
  "delete_component",
  // Theming (style_v1 S2)
  "set_page_theme",
  "get_page_theme",
  // Threads the chat surface could not reach: it could reply and resolve, but
  // not start, read, or find one.
  "create_thread",
  "read_thread",
  "list_page_threads",
]);

/**
 * identity hex → transport, mirroring the bridge `/sql` registry.
 *
 * The AI user's numeric id is NOT stored here: the worker resolves it per turn
 * from `ai_user_config`, and `ToolCallContext` already carries it, so taking it
 * at call time avoids a second source of truth that could go stale across a
 * reconnect.
 */
const transports = new Map<string, HttpStdbTransport>();

export function registerMcpTransport(
  identityHex: string,
  opts: { uri: string; dbName: string; token: string },
): void {
  transports.set(
    identityHex,
    new HttpStdbTransport({
      baseUrl: wsUriToHttpBase(opts.uri),
      dbName: opts.dbName,
      token: opts.token,
    }),
  );
}

export function unregisterMcpTransport(identityHex: string): void {
  transports.delete(identityHex);
}

let registry: Map<string, McpToolEntry> | null = null;
function toolsByName(): Map<string, McpToolEntry> {
  if (!registry) {
    registry = new Map(buildToolRegistry().map((t: McpToolEntry) => [t.name, t]));
  }
  return registry;
}

/** Anthropic tool defs for the parity set, converted from the MCP entries. */
export function getMcpParityToolDefs(): Anthropic.Messages.Tool[] {
  const out: Anthropic.Messages.Tool[] = [];
  for (const entry of toolsByName().values()) {
    if (!PARITY_TOOL_NAMES.has(entry.name)) continue;
    out.push({
      name: entry.name,
      description: entry.description,
      input_schema: entry.inputSchema as Anthropic.Messages.Tool["input_schema"],
    });
  }
  return out;
}

export function isMcpParityTool(name: string): boolean {
  return PARITY_TOOL_NAMES.has(name);
}

/**
 * Execute a parity tool through the shared MCP implementation.
 *
 * Returns a JSON error string rather than throwing when no transport is
 * registered — that only happens if the AI-user connection has not finished
 * connecting, and a tool result the model can read beats an exception it cannot.
 */
export async function executeMcpParityTool(
  identityHex: string | undefined,
  aiUserId: bigint | undefined,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  const entry = toolsByName().get(toolName);
  if (!entry) {
    return JSON.stringify({ ok: false, error: `Unknown tool ${toolName}` });
  }
  const transport = identityHex ? transports.get(identityHex) : undefined;
  if (!transport || aiUserId === undefined) {
    return JSON.stringify({
      ok: false,
      error:
        `${toolName} is unavailable: no authenticated connection for this AI user yet. ` +
        "Retry in a moment.",
    });
  }
  try {
    return await entry.execute({ transport, aiUserId }, input);
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
