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
  // Migrated from the worker's own catalogue after a schema diff showed the two
  // copies had drifted apart in ways that cost the chat surface real ability:
  // the MCP `create_page` accepts `properties` (set row columns in one call) and
  // `query_database` accepts `offset` (page through results) — neither of which
  // the worker's copy had, so an AI user in chat literally could not page a
  // database. Deleting the duplicate is the fix; patching it would have kept two
  // copies to keep in step.
  "create_page",
  "query_database",
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
  // Cross-session recall (ticket 323). The implementation itself verifies
  // that the calling AI is still an active participant before returning any
  // search result or transcript.
  "search_conversations",
  "read_conversation",
  // Page and property CRUD, memory reads. These had a full second
  // implementation in `tools.ts` reading through the subscribed `conn.db`.
  // Migrating them is not only de-duplication: the worker's copies verified
  // their own writes with `waitFor(() => conn.db…)`, i.e. they confirmed a
  // fire-and-forget reducer landed by polling the subscription — the exact
  // path known to drop AI-user incrementals under multi-filter RLS (the
  // reason `bridge-sql.ts` exists, and ticket 14372). The MCP copies read
  // back over HTTP instead, which is the path that actually reports the
  // truth.
  //
  // Write authorization is NOT weakened by this: `requireChatWriteGrant` runs
  // in `executeTool` BEFORE parity dispatch, so the chat page-ACL still gates
  // every one of these. And the transport carries the AI user's own token
  // (`ai-user-worker.ts` registers it from the same connection), so RLS scope
  // is identical to what the subscription had.
  "add_property",
  "delete_property",
  "get_schema_id",
  "list_properties",
  // Non-destructive column edits. Without these the only way either surface
  // could fix a mistyped or misnamed column was delete + re-add, which drops
  // every value in it.
  "rename_property",
  "update_property_config",
  "update_property_type",
  "update_page_content",
  "update_page_title",
  "search_pages",
  "list_child_pages",
  "get_page",
  "delete_page",
  "restore_page",
  "move_page",
  // Both surfaces scope these to the caller's own memory subtree with the same
  // check and the same error text.
  "read_memory",
  "search_memory",
  // `remember` and `list_memory` had NO chat equivalent, which left the chat
  // surface holding `mark_memory_consolidated` — "call this at the END of a
  // memory-consolidation pass" — with no way to write a memory or enumerate the
  // subtree it was being asked to consolidate. Reading was possible, so the gap
  // read as "memory is broken" rather than "a tool is missing".
  "remember",
  "list_memory",
  // Batch row write with per-column type coercion. Chat keeps its own
  // `set_property_value`/`set_property_values` (single-cell and explicitly
  // typed); this adds the whole-row path MCP already had.
  "set_row_properties",
  // Share the implementation but NOT the schema — see AMBIENT_CONVERSATION_TOOLS.
  "post_to_thread",
  "resolve_thread",
  "reopen_thread",
]);

/**
 * Tools whose chat schema differs from their MCP schema.
 *
 * Chat runs inside a conversation; MCP does not. So `conversation_id` is
 * required over MCP but optional in chat, where it defaults to the thread the
 * turn is running in. That is a genuine difference in what the caller must
 * supply — but it is a difference in the *schema*, not the *behaviour*, so it
 * does not justify a second implementation. The id is filled in from the turn
 * context here and the shared implementation runs unchanged.
 *
 * An explicit id is still allowed: the module checks participation, so this
 * cannot reach a thread the AI is not in.
 */
const AMBIENT_CONVERSATION_TOOLS = new Set([
  "post_to_thread",
  "resolve_thread",
  "reopen_thread",
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

/**
 * Drop `conversation_id` from `required` and say what happens when it is
 * omitted. The property itself stays — an explicit id is still valid.
 */
function toChatSchema(schema: unknown): Anthropic.Messages.Tool["input_schema"] {
  const s = (schema ?? {}) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    ...s,
    properties: {
      ...s.properties,
      conversation_id: {
        type: "number",
        description:
          "Defaults to the thread this turn is running in. Pass an id only to act on a different thread.",
      },
    },
    required: (s.required ?? []).filter((r) => r !== "conversation_id"),
  } as Anthropic.Messages.Tool["input_schema"];
}

/** Anthropic tool defs for the parity set, converted from the MCP entries. */
export function getMcpParityToolDefs(): Anthropic.Messages.Tool[] {
  const out: Anthropic.Messages.Tool[] = [];
  for (const entry of toolsByName().values()) {
    if (!PARITY_TOOL_NAMES.has(entry.name)) continue;
    out.push({
      name: entry.name,
      description: entry.description,
      input_schema: AMBIENT_CONVERSATION_TOOLS.has(entry.name)
        ? toChatSchema(entry.inputSchema)
        : (entry.inputSchema as Anthropic.Messages.Tool["input_schema"]),
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
/**
 * Fill `conversation_id` from the turn context for the ambient thread tools.
 *
 * Exported for testing: this is the one piece of chat-specific behaviour left in
 * the parity path, so it is worth pinning independently of a live transport.
 * An explicit id always wins over the ambient one.
 */
export function resolveAmbientConversation(
  toolName: string,
  input: Record<string, unknown>,
  conversationId: bigint | undefined,
): { input: Record<string, unknown> } | { error: string } {
  if (!AMBIENT_CONVERSATION_TOOLS.has(toolName)) return { input };
  if (input.conversation_id != null) return { input };
  if (conversationId === undefined) {
    return {
      error: `${toolName} is only available during a chat turn, or with an explicit conversation_id.`,
    };
  }
  return { input: { ...input, conversation_id: Number(conversationId) } };
}

export interface ParityCallContext {
  /** The AI user's identity, used to look up its registered transport. */
  identityHex?: string;
  aiUserId?: bigint;
  /** The thread this turn is running in, if any. */
  conversationId?: bigint;
}

export async function executeMcpParityTool(
  ctx: ParityCallContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  const entry = toolsByName().get(toolName);
  if (!entry) {
    return JSON.stringify({ ok: false, error: `Unknown tool ${toolName}` });
  }
  const transport = ctx.identityHex ? transports.get(ctx.identityHex) : undefined;
  if (!transport || ctx.aiUserId === undefined) {
    return JSON.stringify({
      ok: false,
      error:
        `${toolName} is unavailable: no authenticated connection for this AI user yet. ` +
        "Retry in a moment.",
    });
  }

  const resolved = resolveAmbientConversation(toolName, input, ctx.conversationId);
  if ("error" in resolved) return JSON.stringify({ ok: false, error: resolved.error });
  const args = resolved.input;

  try {
    return await entry.execute(
      {
        transport,
        aiUserId: ctx.aiUserId,
        conversationId: ctx.conversationId,
      },
      args,
    );
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
