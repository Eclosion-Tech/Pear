/**
 * Per-provider model families and the "utility tier" selector.
 *
 * An AI user is configured with a single primary `model`, but a provider API
 * key generally unlocks the *whole* family — so once we know the provider we
 * know which cheaper sibling to use for auxiliary work (intent verification,
 * planning, summaries) without any extra credentials or config. This catalog is
 * the worker's single source of truth; mirror it in web for the model picker.
 *
 * Keep the IDs current here — model names drift (new Haiku, OpenAI renames).
 */

import type { ProviderTag } from "./providers.js";

export type ModelTier = "flagship" | "balanced" | "fast";

export interface CatalogModel {
  id: string;
  tier: ModelTier;
  label: string;
}

export const MODEL_CATALOG: Record<ProviderTag, CatalogModel[]> = {
  Anthropic: [
    { id: "claude-opus-4-8", tier: "flagship", label: "Claude Opus 4.8" },
    { id: "claude-sonnet-4-6", tier: "balanced", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-5-20251001", tier: "fast", label: "Claude Haiku 4.5" },
  ],
  OpenAi: [
    { id: "gpt-4.1", tier: "flagship", label: "GPT-4.1" },
    { id: "gpt-4.1-mini", tier: "balanced", label: "GPT-4.1 mini" },
    { id: "gpt-4.1-nano", tier: "fast", label: "GPT-4.1 nano" },
  ],
  // Custom / local providers run arbitrary models with no known family, so we
  // can't name a cheaper sibling — callers fall back to the configured model.
  Ollama: [],
  OpenAiCompatible: [],
};

/**
 * The cheapest capable model for utility/auxiliary work on this provider — the
 * `fast` tier of the family the AI user's key already unlocks. Falls back to
 * `primaryModel` when the provider family is unknown (custom endpoints), so a
 * call never targets a model the key can't reach.
 */
export function utilityModelFor(
  provider: ProviderTag,
  primaryModel: string,
): string {
  const fast = MODEL_CATALOG[provider]?.find((m) => m.tier === "fast");
  return fast?.id ?? primaryModel;
}
