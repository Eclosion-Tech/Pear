import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_CATALOG, utilityModelFor } from "./model-catalog.js";

test("each known-provider family has exactly one fast tier", () => {
  for (const provider of ["Anthropic", "OpenAi"] as const) {
    const fast = MODEL_CATALOG[provider].filter((m) => m.tier === "fast");
    assert.equal(fast.length, 1, `${provider} should have one fast model`);
  }
});

test("utilityModelFor returns the provider's fast model regardless of primary", () => {
  assert.equal(
    utilityModelFor("Anthropic", "claude-opus-4-8"),
    "claude-haiku-4-5-20251001",
  );
  assert.equal(utilityModelFor("OpenAi", "gpt-4.1"), "gpt-4.1-nano");
});

test("utilityModelFor falls back to the primary model for unknown families", () => {
  assert.equal(utilityModelFor("Ollama", "llama3.1"), "llama3.1");
  assert.equal(
    utilityModelFor("OpenAiCompatible", "my-local-model"),
    "my-local-model",
  );
});

test("a user already on the fast tier keeps that model", () => {
  assert.equal(
    utilityModelFor("Anthropic", "claude-haiku-4-5-20251001"),
    "claude-haiku-4-5-20251001",
  );
});
