import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildOrchaSystemPrompt,
  callLlm,
  rollbackCreatedPages,
} from "./llm.js";
import { getPearTools, type ConnLike } from "./tools.js";
import type { InferenceProvider, ChatResponse } from "./providers.js";

// ── Stubs ───────────────────────────────────────────────────────────────────────

/** A provider that answers every call with one text block and end_turn, so
 * callLlm returns after a single turn (no tools executed). */
function stubProvider(text: string): InferenceProvider {
  return {
    async chat(): Promise<ChatResponse> {
      return {
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      };
    },
  } as unknown as InferenceProvider;
}

/** Minimal conn: getPearTools only iterates orcha_shared_context here (no
 * ai_user in context, so no memory/grant lookups run). */
const conn = {
  db: { orcha_shared_context: { iter: () => [][Symbol.iterator]() } },
} as unknown as ConnLike;

function run(text: string) {
  return callLlm("write the content into the page", conn, 0n, "", {
    provider: stubProvider(text),
    model: "stub",
    maxTokens: 100,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────────

test("executor reply starting with TASK_FAILED: marks the result failed", async () => {
  const res = await run("TASK_FAILED: the target page could not be resolved");
  assert.equal(res.failed, true);
  assert.match(res.text, /TASK_FAILED:/);
});

test("TASK_FAILED detection is case-insensitive and tolerates leading whitespace", async () => {
  const res = await run("  task_failed: missing a required input");
  assert.equal(res.failed, true);
});

test("a normal completion is not marked failed", async () => {
  const res = await run("Done. Wrote the content into page 5.");
  assert.ok(!res.failed);
  assert.match(res.text, /Done\./);
});

test("TASK_FAILED only counts at the start of the reply, not mid-text", async () => {
  const res = await run("Completed. Note: earlier I nearly hit TASK_FAILED: but recovered.");
  assert.ok(!res.failed);
});

test("Orcha system prompts use the clock for that job invocation", () => {
  const first = buildOrchaSystemPrompt(new Date("2026-08-29T16:00:00.000Z"));
  const second = buildOrchaSystemPrompt(new Date("2026-08-31T12:30:00.000Z"));
  assert.match(first, /Date: 2026-08-29 \(UTC\)/);
  assert.match(second, /Date: 2026-08-31 \(UTC\)/);
  assert.match(second, /Current time \(UTC\): 2026-08-31T12:30:00\.000Z/);
  assert.doesNotMatch(second, /Date: 2026-08-29 \(UTC\)/);
});

test("Orcha receives Pear page tools without recursive delegation controls", () => {
  const toolNames = getPearTools(conn, 0n).map((tool) => tool.name);
  const names = new Set(toolNames);
  for (const name of [
    "get_page",
    "query_database",
    "list_properties",
    "update_page_content",
    "get_page_components",
    "update_block_content",
    "edit_page_content",
    "create_thread",
  ]) {
    assert.ok(names.has(name), `Orcha tool surface is missing ${name}`);
  }
  assert.equal(names.has("delegate"), false);
  assert.equal(names.has("check_job"), false);
  assert.equal(names.has("set_effort"), false);
  assert.equal(names.size, toolNames.length, "Orcha tool names must be unique");
});

test("failed-task cleanup trashes only created pages in reverse order", async () => {
  const calls: number[] = [];
  const trace: Array<import("./tool-call-record.js").StoredToolCall> = [];
  const rollback = await rollbackCreatedPages(
    {
      async execute(name, input) {
        assert.equal(name, "delete_page");
        calls.push(Number(input.page_id));
        return JSON.stringify({ ok: true, page_id: Number(input.page_id) });
      },
    },
    [10, 11, 11, 12],
    trace,
  );

  assert.deepEqual(calls, [12, 11, 10]);
  assert.deepEqual(rollback.deletedPageIds, [12, 11, 10]);
  assert.deepEqual(rollback.failures, []);
  assert.deepEqual(trace.map((call) => call.name), ["delete_page", "delete_page", "delete_page"]);
  assert.ok(trace.every((call) => call.status === "done"));
});

test("failed-task cleanup reports a page it could not trash", async () => {
  const trace: Array<import("./tool-call-record.js").StoredToolCall> = [];
  const rollback = await rollbackCreatedPages(
    {
      async execute(_name, input) {
        const pageId = Number(input.page_id);
        return pageId === 20
          ? JSON.stringify({ ok: false, page_id: pageId, error: "permission denied" })
          : JSON.stringify({ ok: true, page_id: pageId });
      },
    },
    [20, 21],
    trace,
  );

  assert.deepEqual(rollback.deletedPageIds, [21]);
  assert.deepEqual(rollback.failures, [{ pageId: 20, error: "permission denied" }]);
  assert.equal(trace[1]?.status, "error");
});

// ── Tool trace ───────────────────────────────────────────────────────────────────

/** A provider that calls `get_context` once, then ends the turn. */
function toolThenDoneProvider(): InferenceProvider {
  let turn = 0;
  return {
    async chat(): Promise<ChatResponse> {
      turn++;
      const usage = {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      if (turn === 1) {
        return {
          content: [
            { type: "tool_use", id: "tu_1", name: "get_context", input: { key: "missing" } },
          ],
          stopReason: "tool_use",
          usage,
        };
      }
      return { content: [{ type: "text", text: "All done." }], stopReason: "end_turn", usage };
    },
  } as unknown as InferenceProvider;
}

test("every tool call is recorded in the result's trace", async () => {
  const res = await callLlm("look something up", conn, 0n, "", {
    provider: toolThenDoneProvider(),
    model: "stub",
    maxTokens: 100,
  });
  assert.equal(res.text, "All done.");
  assert.equal(res.toolCalls.length, 1);
  const [call] = res.toolCalls;
  assert.equal(call.type, "tool_use");
  assert.equal(call.id, "tu_1");
  assert.equal(call.name, "get_context");
  assert.equal(call.input, JSON.stringify({ key: "missing" }));
  // get_context on an unknown key answers `{ ok: false, error }` → error status.
  assert.equal(call.status, "error");
  assert.equal(call.isError, true);
  assert.match(call.output ?? "", /No context value/);
});

test("a text-only reply yields an empty trace", async () => {
  const res = await run("nothing to do");
  assert.deepEqual(res.toolCalls, []);
});

test("serializeToolTrace drops the tail past the cap and says how many", async () => {
  const { serializeToolTrace, TRACE_MAX_CALLS } = await import("./llm.js");
  const calls = Array.from({ length: TRACE_MAX_CALLS + 5 }, (_, i) => ({
    type: "tool_use" as const,
    id: `tu_${i}`,
    name: "get_context",
    input: "{}",
    status: "done" as const,
  }));
  const parsed = JSON.parse(serializeToolTrace(calls)) as Array<{ id: string; output?: string }>;
  assert.equal(parsed.length, TRACE_MAX_CALLS + 1);
  assert.equal(parsed[TRACE_MAX_CALLS].id, "trace-truncated");
  assert.match(parsed[TRACE_MAX_CALLS].output ?? "", /5 more tool calls/);
});
