import { test } from "node:test";
import assert from "node:assert/strict";
import {
  catalogFamilyFor,
  MODEL_CATALOG,
  modelForTier,
  resolveRouting,
  utilityModelFor,
} from "./model-catalog.js";

test("catalogFamilyFor derives aggregator families from the endpoint", () => {
  assert.equal(catalogFamilyFor("Anthropic"), "Anthropic");
  assert.equal(catalogFamilyFor("OpenAiCompatible"), "OpenAiCompatible");
  assert.equal(
    catalogFamilyFor("OpenAiCompatible", "https://openrouter.ai/api/v1"),
    "OpenRouter",
  );
  assert.equal(
    catalogFamilyFor("OpenAiCompatible", "https://api.meta.ai/v1"),
    "Meta",
  );
  // Only OpenAI-compatible configs are endpoint-disambiguated.
  assert.equal(catalogFamilyFor("Ollama", "https://openrouter.ai/api/v1"), "Ollama");
});

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
  assert.equal(utilityModelFor("OpenAi", "gpt-5.5"), "gpt-5.6-nano");
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

test("modelForTier maps each tier to the right model", () => {
  assert.equal(modelForTier("Anthropic", "frontier"), "claude-fable-5");
  assert.equal(modelForTier("Anthropic", "flagship"), "claude-opus-4-8");
  assert.equal(modelForTier("Anthropic", "balanced"), "claude-sonnet-4-6");
  assert.equal(modelForTier("Anthropic", "fast"), "claude-haiku-4-5-20251001");
  assert.equal(modelForTier("OpenAi", "frontier"), "gpt-5.6");
  // Endpoint-derived families route tiers to vendor-prefixed slugs.
  assert.equal(modelForTier("OpenRouter", "frontier"), "anthropic/claude-fable-5");
  assert.equal(modelForTier("OpenRouter", "fast"), "anthropic/claude-haiku-4.5");
  assert.equal(modelForTier("Meta", "flagship"), "muse-spark-1.1");
  // Unknown family → undefined (caller keeps the configured model).
  assert.equal(modelForTier("Ollama", "flagship"), undefined);
});

test("OpenRouter catalog offers the current GLM 5.3 models", () => {
  const ids = MODEL_CATALOG.OpenRouter.map((model) => model.id);
  assert.ok(ids.includes("z-ai/glm-5.3"));
  assert.ok(ids.includes("z-ai/glm-5.3-flash"));
  assert.ok(!ids.includes("z-ai/glm-5.2"));
});

test("resolveRouting: human override wins over the agent's tier", () => {
  const r = resolveRouting(
    { providerTag: "Anthropic", model: "claude-opus-4-8" },
    { modelOverride: "claude-haiku-4-5-20251001", tier: "frontier" },
  );
  assert.equal(r.model, "claude-haiku-4-5-20251001");
});

test("resolveRouting: agent tier maps to a concrete model", () => {
  const r = resolveRouting(
    { providerTag: "Anthropic", model: "claude-opus-4-8" },
    { tier: "fast" },
  );
  assert.equal(r.model, "claude-haiku-4-5-20251001");
});

test("resolveRouting: effort kept when the resolved model supports it", () => {
  const r = resolveRouting(
    { providerTag: "Anthropic", model: "claude-opus-4-8" },
    { effort: "high" },
  );
  assert.equal(r.model, "claude-opus-4-8");
  assert.equal(r.effort, "high");
});

test("resolveRouting: effort dropped when the resolved model can't take it", () => {
  // Routing to the fast tier (Haiku) drops a requested effort — Haiku has none.
  const r = resolveRouting(
    { providerTag: "Anthropic", model: "claude-opus-4-8" },
    { tier: "fast", effort: "high" },
  );
  assert.equal(r.model, "claude-haiku-4-5-20251001");
  assert.equal(r.effort, undefined);
});

test("resolveRouting: an invalid effort level is dropped", () => {
  const r = resolveRouting(
    { providerTag: "Anthropic", model: "claude-opus-4-8" },
    { effort: "ultra" },
  );
  assert.equal(r.effort, undefined);
});

test("resolveRouting: custom-family tier choice keeps the configured model", () => {
  const r = resolveRouting(
    { providerTag: "Ollama", model: "llama3.1" },
    { tier: "flagship", effort: "high" },
  );
  assert.equal(r.model, "llama3.1");
  assert.equal(r.effort, undefined); // unknown model → no effort knob
});
