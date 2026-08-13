/**
 * Chat/MCP tool parity.
 *
 * The property under test is that the two surfaces expose the *same* tools from
 * the *same* implementation. A parallel implementation would pass any test
 * written against one surface while quietly diverging on the other, so these
 * assert the wiring rather than the behaviour — behaviour is already covered by
 * the MCP tool tests, which is the point.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getConversationTools } from "./tools.js";
import { buildToolRegistry, type McpToolEntry } from "../../web/src/lib/mcp/index.js";
import {
  executeMcpParityTool,
  getMcpParityToolDefs,
  isMcpParityTool,
  resolveAmbientConversation,
} from "./mcp-parity-tools.js";

const EXPECTED = [
  "create_page",
  "query_database",
  "get_page_components",
  "insert_component",
  "update_component_props",
  "delete_component",
  "set_page_theme",
  "get_page_theme",
  "create_thread",
  "read_thread",
  "list_page_threads",
  "search_conversations",
  "read_conversation",
  "add_property",
  "delete_property",
  "get_schema_id",
  "list_properties",
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
  "read_memory",
  "search_memory",
  "post_to_thread",
  "resolve_thread",
  "reopen_thread",
  "remember",
  "list_memory",
  "set_row_properties",
];

test("every parity tool resolves against the shared MCP registry", () => {
  const names = getMcpParityToolDefs().map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED].sort());
});

test("the chat surface exposes them alongside its own tools", () => {
  const chat = new Set(getConversationTools().map((t) => t.name));
  for (const name of EXPECTED) {
    assert.ok(chat.has(name), `chat surface is missing ${name}`);
  }
  // And still has the chat-only ones.
  assert.ok(chat.has("render_ui"));
  assert.ok(chat.has("post_to_thread"));
});

test("every MCP tool is reachable from chat", () => {
  // The actual parity property, stated directly: anything an MCP client can do
  // to a workspace, an AI user in chat can do too. Asserted over the registry
  // rather than a hand-kept list, so a tool added to MCP alone fails here.
  //
  // This caught `remember`, `list_memory` and `set_row_properties` — chat could
  // read its memory and was told to consolidate it, but had no tool to write or
  // list it.
  const chat = new Set(getConversationTools().map((t) => t.name));
  const missing = buildToolRegistry()
    .map((t: McpToolEntry) => t.name)
    .filter((n: string) => !chat.has(n));
  assert.deepEqual(missing, [], `MCP tools unreachable from chat: ${missing.join(", ")}`);
});

test("no tool is defined twice", () => {
  // Migrating a tool means deleting BOTH its switch case and its static def. A
  // missed def leaves the name listed twice — the model then sees two schemas
  // for one tool, and the earlier `new Set(...)` assertions could not see it.
  const names = getConversationTools().map((t) => t.name);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  assert.deepEqual(dupes, [], `duplicate tool definitions: ${dupes.join(", ")}`);
});

test("parity defs carry a description and an object schema", () => {
  for (const def of getMcpParityToolDefs()) {
    assert.ok(def.description && def.description.length > 0, `${def.name} has no description`);
    assert.equal((def.input_schema as { type?: string }).type, "object", `${def.name} schema`);
  }
});

test("isMcpParityTool only claims the parity set", () => {
  for (const name of EXPECTED) assert.equal(isMcpParityTool(name), true);
  // Chat-only tools, which keep their own implementation: `render_ui` and
  // `tool_bash` have no MCP equivalent, `create_row` applies column defaults
  // that `create_page` does not, and `set_property_value` is the chat-side
  // single-cell write.
  for (const name of ["render_ui", "create_row", "tool_bash", "set_property_value"]) {
    assert.equal(isMcpParityTool(name), false, `${name} should not route through parity`);
  }
});

test("an unconnected AI user gets a readable error, not an exception", async () => {
  // Happens if a turn somehow runs before the AI-user connection registers its
  // transport. A tool result the model can read beats a thrown error it cannot.
  const out = await executeMcpParityTool({}, "insert_component", {});
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.match(String(parsed.error), /no authenticated connection/i);
});

test("an unknown tool name is reported rather than thrown", async () => {
  const out = await executeMcpParityTool({ identityHex: "abc", aiUserId: 1n }, "not_a_tool", {});
  assert.equal(JSON.parse(out).ok, false);
});


// ── Drift guard ───────────────────────────────────────────────────────────────

/**
 * Any tool implemented on BOTH surfaces must expose the same *shape*.
 *
 * Descriptions are legitimately per-surface — the MCP registry strips
 * chat-specific phrasing for external clients, and there is a test enforcing
 * that — so this compares property names, types and `required` only.
 *
 * This guard exists because a schema diff on 2026-07-26 found the two copies had
 * silently drifted in ways that cost the chat surface real ability: MCP's
 * `create_page` took `properties` and its `query_database` took `offset`, so an
 * AI user in chat could not page through a database at all. Both were fixed by
 * deleting the duplicate rather than patching it. Until every duplicate is gone,
 * this stops the remaining ones diverging again.
 */
const INTENTIONAL_DIVERGENCE: Record<string, string> = {
  // These three now share ONE implementation with MCP; only the schema differs.
  // Chat knows the conversation it is running in, so `conversation_id` is
  // optional there and required over MCP, and `executeMcpParityTool` fills it
  // from the turn context before delegating. A schema difference over a shared
  // implementation is the thing this map is for; a second implementation is not.
  post_to_thread: "chat defaults conversation_id to the current thread",
  resolve_thread: "chat defaults conversation_id to the current thread",
  reopen_thread: "chat defaults conversation_id to the current thread",
};

type Schema = { properties?: Record<string, { type?: unknown }>; required?: string[] };

/** Names, types and required-ness — the parts a caller can actually trip over. */
function shapeOf(schema: unknown): string {
  const s = (schema ?? {}) as Schema;
  const props = Object.entries(s.properties ?? {})
    .map(([k, v]) => `${k}:${JSON.stringify((v as { type?: unknown }).type)}`)
    .sort()
    .join(",");
  return `props(${props}) required(${[...(s.required ?? [])].sort().join(",")})`;
}

test("tools on both surfaces agree on shape, or are a named exception", () => {
  const chat = new Map(getConversationTools().map((t) => [t.name, t.input_schema]));
  const mcp = new Map(buildToolRegistry().map((t: McpToolEntry) => [t.name, t.inputSchema]));

  const drifted: string[] = [];
  for (const [name, chatSchema] of chat) {
    const mcpSchema = mcp.get(name);
    if (!mcpSchema) continue; // chat-only tool
    if (name in INTENTIONAL_DIVERGENCE) continue;
    const a = shapeOf(chatSchema);
    const b = shapeOf(mcpSchema);
    if (a !== b) drifted.push(`${name}\n    chat: ${a}\n    mcp : ${b}`);
  }

  assert.deepEqual(
    drifted,
    [],
    `Tool schemas drifted between the chat and MCP surfaces. Either fix the ` +
      `divergence — preferably by deleting one implementation and adding the ` +
      `tool to PARITY_TOOL_NAMES — or record it in INTENTIONAL_DIVERGENCE with ` +
      `a reason.\n\n${drifted.join("\n\n")}`,
  );
});

test("every intentional divergence names a tool that really is on both surfaces", () => {
  // Stops the exception list rotting into a place where fixed drift hides.
  const chat = new Set(getConversationTools().map((t) => t.name));
  const mcp = new Set(buildToolRegistry().map((t: McpToolEntry) => t.name));
  for (const name of Object.keys(INTENTIONAL_DIVERGENCE)) {
    assert.ok(chat.has(name) && mcp.has(name), `${name} is no longer on both surfaces`);
  }
});


// ── Ambient conversation ──────────────────────────────────────────────────────

/**
 * The thread trio shares MCP's implementation but keeps chat's schema, so the
 * conversation id is filled from the turn context on the way through. That fill
 * is the last chat-specific behaviour in the parity path — everything else is
 * now literally the same code — so it is pinned directly.
 */

test("the ambient thread id is filled in when the model omits it", () => {
  const out = resolveAmbientConversation("post_to_thread", { content: "hi" }, 42n);
  assert.deepEqual(out, { input: { content: "hi", conversation_id: 42 } });
});

test("an explicit thread id wins over the ambient one", () => {
  // The module still checks participation, so naming another thread cannot
  // reach one the AI is not in — but it must not be silently rewritten either.
  const out = resolveAmbientConversation("post_to_thread", { conversation_id: 7 }, 42n);
  assert.deepEqual(out, { input: { conversation_id: 7 } });
});

test("outside a chat turn, omitting the id is a readable error", () => {
  const out = resolveAmbientConversation("resolve_thread", {}, undefined);
  assert.match(
    (out as { error: string }).error,
    /only available during a chat turn, or with an explicit conversation_id/,
  );
});

test("non-thread tools are passed through untouched", () => {
  const input = { page_id: 1 };
  const out = resolveAmbientConversation("get_page", input, 42n);
  assert.equal((out as { input: unknown }).input, input, "should not copy or add keys");
});

test("the chat schema makes conversation_id optional; MCP keeps it required", () => {
  // The divergence the INTENTIONAL_DIVERGENCE map records, asserted rather than
  // just described — otherwise the override could silently stop applying and
  // the model would start being told the id is mandatory.
  const defs = new Map(getMcpParityToolDefs().map((d) => [d.name, d.input_schema]));
  const mcp = new Map(buildToolRegistry().map((t: McpToolEntry) => [t.name, t.inputSchema]));
  for (const name of ["post_to_thread", "resolve_thread", "reopen_thread"]) {
    const chatReq = (defs.get(name) as { required?: string[] }).required ?? [];
    const mcpReq = ((mcp.get(name) ?? {}) as { required?: string[] }).required ?? [];
    assert.ok(!chatReq.includes("conversation_id"), `${name}: chat should not require it`);
    assert.ok(mcpReq.includes("conversation_id"), `${name}: MCP should require it`);
    // The property itself must survive — an explicit id is still valid.
    const props = (defs.get(name) as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(props.conversation_id, `${name}: chat schema dropped the property`);
  }
});

test("post_to_thread keeps its required content field through the override", () => {
  // Guards the override itself: it rewrites `required`, and a sloppy rewrite
  // would drop the other entries with it.
  const def = getMcpParityToolDefs().find((d) => d.name === "post_to_thread")!;
  assert.deepEqual((def.input_schema as { required?: string[] }).required, ["content"]);
});
