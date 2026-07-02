import { test } from "node:test";
import assert from "node:assert/strict";

import { callLlm } from "./llm.js";
import type { ConnLike } from "./tools.js";
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
