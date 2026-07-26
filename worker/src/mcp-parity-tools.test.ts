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
import {
  executeMcpParityTool,
  getMcpParityToolDefs,
  isMcpParityTool,
} from "./mcp-parity-tools.js";

const EXPECTED = [
  "get_page_components",
  "insert_component",
  "update_component_props",
  "delete_component",
  "set_page_theme",
  "get_page_theme",
  "create_thread",
  "read_thread",
  "list_page_threads",
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

test("parity defs carry a description and an object schema", () => {
  for (const def of getMcpParityToolDefs()) {
    assert.ok(def.description && def.description.length > 0, `${def.name} has no description`);
    assert.equal((def.input_schema as { type?: string }).type, "object", `${def.name} schema`);
  }
});

test("isMcpParityTool only claims the parity set", () => {
  for (const name of EXPECTED) assert.equal(isMcpParityTool(name), true);
  for (const name of ["render_ui", "update_page_content", "tool_bash", "post_to_thread"]) {
    assert.equal(isMcpParityTool(name), false, `${name} should not route through parity`);
  }
});

test("an unconnected AI user gets a readable error, not an exception", async () => {
  // Happens if a turn somehow runs before the AI-user connection registers its
  // transport. A tool result the model can read beats a thrown error it cannot.
  const out = await executeMcpParityTool(undefined, undefined, "insert_component", {});
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.match(String(parsed.error), /no authenticated connection/i);
});

test("an unknown tool name is reported rather than thrown", async () => {
  const out = await executeMcpParityTool("abc", 1n, "not_a_tool", {});
  assert.equal(JSON.parse(out).ok, false);
});
