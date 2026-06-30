/**
 * Per-provider model families, the capability ladder, and per-model effort
 * support — the worker's single source of truth for model routing.
 *
 * An AI user is configured with a single primary `model`, but a provider API
 * key generally unlocks the *whole* family — so once we know the provider we
 * know which sibling to use for a given tier or for cheap auxiliary work,
 * without any extra credentials or config. This catalog is also surfaced to the
 * agent as its model menu and mirrored in `web/src/lib/aiUserApi.ts` for the
 * human model picker — keep the two in sync.
 *
 * Expansibility: `TIERS` is an ordered, append-only ladder, and effort is a
 * per-model capability (see `EffortSupport`). Adding a new model — including a
 * new top rung like Claude Fable 5 / Mythos — is a data edit here; nothing
 * switches on a fixed tier enum. Keep the IDs current; model names drift.
 */

import type { ProviderTag } from "./providers.js";

/**
 * Capability ladder, cheapest → most capable. **Append-only** — add a rung at
 * the end as the frontier moves; never renumber, and never `switch` exhaustively
 * on these values (so a new rung can't break consumers). `frontier` sits above
 * `flagship` for models like Claude Fable 5 / Mythos that exceed the Opus tier.
 */
export const TIERS = ["fast", "balanced", "flagship", "frontier"] as const;
export type ModelTier = (typeof TIERS)[number];

/** Position on the ladder (higher = more capable). -1 for an unknown tier. */
export function tierRank(tier: ModelTier): number {
  return TIERS.indexOf(tier);
}

/**
 * How a model exposes "effort"/reasoning depth — a per-model capability, not a
 * per-provider one (e.g. GPT-4.1 is not a reasoning model and takes no effort
 * param, and Claude Haiku 4.5 rejects effort). `none` means the model has no
 * effort knob, so the worker must never send one: the agent's intensity choice
 * is a silent no-op there rather than an error.
 */
export type EffortKind = "anthropic_effort" | "openai_reasoning_effort" | "none";

export interface EffortSupport {
  kind: EffortKind;
  /** Valid levels for this model's knob, cheapest → deepest. Omitted when `none`. */
  levels?: readonly string[];
}

export interface CatalogModel {
  id: string;
  tier: ModelTier;
  label: string;
  /** One-line "use this for…" guidance surfaced to the agent's model menu. */
  useFor: string;
  effort: EffortSupport;
}

const ANTHROPIC_EFFORT_FULL: EffortSupport = {
  kind: "anthropic_effort",
  levels: ["low", "medium", "high", "xhigh", "max"],
};
const ANTHROPIC_EFFORT_SONNET: EffortSupport = {
  kind: "anthropic_effort",
  levels: ["low", "medium", "high", "max"], // xhigh is Opus 4.7+ only
};
const OPENAI_REASONING_EFFORT: EffortSupport = {
  kind: "openai_reasoning_effort",
  // GPT-5.x reasoning models accept none|low|medium|high; the 5.4/5.5 frontier
  // tier also accepts `xhigh`, left out here conservatively until confirmed so
  // we never send a level a given model rejects.
  levels: ["none", "low", "medium", "high"],
};
const NO_EFFORT: EffortSupport = { kind: "none" };

export const MODEL_CATALOG: Record<ProviderTag, CatalogModel[]> = {
  Anthropic: [
    {
      id: "claude-fable-5",
      tier: "frontier",
      label: "Claude Fable 5",
      useFor:
        "The hardest, long-horizon reasoning and agentic work. Slowest and most expensive.",
      effort: ANTHROPIC_EFFORT_FULL,
    },
    {
      id: "claude-opus-4-8",
      tier: "flagship",
      label: "Claude Opus 4.8",
      useFor: "Complex reasoning, hard coding, and multi-step work.",
      effort: ANTHROPIC_EFFORT_FULL,
    },
    {
      id: "claude-sonnet-4-6",
      tier: "balanced",
      label: "Claude Sonnet 4.6",
      useFor: "Most everyday tasks — strong quality at lower cost and latency.",
      effort: ANTHROPIC_EFFORT_SONNET,
    },
    {
      id: "claude-haiku-4-5-20251001",
      tier: "fast",
      label: "Claude Haiku 4.5",
      useFor:
        "Simple, well-scoped, latency-sensitive tasks. Cheapest. No effort control.",
      effort: NO_EFFORT, // effort is rejected on Haiku 4.5
    },
  ],
  OpenAi: [
    // GPT-5.x reasoning models (take `reasoning_effort`), via Chat Completions.
    // Codex models (gpt-5.1-codex, gpt-5.3-codex, …) are intentionally absent:
    // they are Responses-API-oriented and OpenAIProvider uses Chat Completions,
    // so they need Responses-API support before they can be listed.
    {
      id: "gpt-5.5",
      tier: "frontier",
      label: "GPT-5.5",
      useFor:
        "OpenAI's newest frontier model — the hardest coding, reasoning, and agentic work.",
      effort: OPENAI_REASONING_EFFORT,
    },
    {
      id: "gpt-5.4",
      tier: "flagship",
      label: "GPT-5.4",
      useFor: "Complex professional work — strong coding, reasoning, and tool use.",
      effort: OPENAI_REASONING_EFFORT,
    },
    {
      id: "gpt-5.4-mini",
      tier: "balanced",
      label: "GPT-5.4 mini",
      useFor: "Most everyday tasks and subagents — responsive at lower cost.",
      effort: OPENAI_REASONING_EFFORT,
    },
    {
      id: "gpt-5.4-nano",
      tier: "fast",
      label: "GPT-5.4 nano",
      useFor: "Simple, latency-sensitive tasks. Cheapest.",
      effort: OPENAI_REASONING_EFFORT,
    },
  ],
  // Custom / local providers run arbitrary models with no known family, so we
  // can't name siblings or assume an effort knob — callers fall back to the
  // configured model and send no effort param.
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

/**
 * Effort capability for a model id, looked up across all provider families.
 * Returns `{ kind: "none" }` for unknown models (custom endpoints, or an id not
 * in the catalog) so callers never send an effort param a model can't take.
 */
export function effortSupportFor(modelId: string): EffortSupport {
  for (const models of Object.values(MODEL_CATALOG)) {
    const match = models.find((m) => m.id === modelId);
    if (match) return match.effort;
  }
  return NO_EFFORT;
}

/**
 * Concrete model id for a requested tier within a provider family: the most
 * capable model at or below the requested tier (so a tier the family doesn't
 * populate degrades to the next one down rather than failing), falling back to
 * the cheapest listed model. `undefined` for families with no catalog entries
 * (Ollama / OpenAI-compatible) — the caller keeps the configured model there.
 */
export function modelForTier(
  provider: ProviderTag,
  tier: ModelTier,
): string | undefined {
  const models = MODEL_CATALOG[provider];
  if (!models?.length) return undefined;
  const want = tierRank(tier);
  const atOrBelow = models
    .filter((m) => tierRank(m.tier) <= want)
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier));
  return (atOrBelow[0] ?? models[0]).id;
}

/** The two dials, plus the human pin. All optional. */
export interface RoutingChoice {
  /** Human override — a specific model id. Wins over the agent's tier choice. */
  modelOverride?: string;
  /** Agent's model choice, by capability tier. */
  tier?: ModelTier;
  /** Agent's intensity choice; applied only if the resolved model supports it. */
  effort?: string;
}

export interface ResolvedRouting {
  model: string;
  /** Native effort level to send, or undefined when unsupported/unset. */
  effort?: string;
}

/**
 * Resolve the two dials against an AI user's base provider/model.
 *
 * Model: the human `modelOverride` wins; otherwise the agent's `tier` is mapped
 * to a concrete model in the provider family; otherwise the configured default.
 * Effort: the agent's `effort` is kept only when the *resolved* model's catalog
 * descriptor supports that exact level — so it's never sent to a model that
 * can't take it (a no-op rather than an error), per the OSS/Ollama constraint.
 */
export function resolveRouting(
  base: { providerTag: ProviderTag; model: string },
  choice: RoutingChoice,
): ResolvedRouting {
  let model = base.model;
  if (choice.modelOverride?.trim()) {
    model = choice.modelOverride.trim();
  } else if (choice.tier && tierRank(choice.tier) >= 0) {
    // Guard tierRank: `tier` may be a raw string from the DB; an unrecognized
    // tier is ignored (keep the default model) rather than mapped to a fallback.
    model = modelForTier(base.providerTag, choice.tier) ?? base.model;
  }

  let effort: string | undefined;
  if (choice.effort) {
    const support = effortSupportFor(model);
    if (support.kind !== "none" && support.levels?.includes(choice.effort)) {
      effort = choice.effort;
    }
  }
  return { model, effort };
}
