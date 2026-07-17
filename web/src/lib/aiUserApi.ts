"use client";

/**
 * AI user management client. Two code paths:
 *
 *   1. Host-delegated (embed Pear in a parent app)
 *      Set `NEXT_PUBLIC_PEAR_AI_USER_API_BASE` to a base URL template. A
 *      typical parent app proxies to a backend that can mint SpacetimeDB
 *      identities, invoke reducers on behalf of users, and optionally
 *      persist credentials. The `{slug}` placeholder is substituted at
 *      call time from the current URL (see `currentWorkspaceSlug`).
 *
 *      A literal value (no `{slug}`) is allowed when the host knows
 *      ahead of time which workspace the bundle will run under.
 *
 *   2. Self-hosted Pear (single-tenant, direct)
 *      The web client mints a fresh SpacetimeDB Identity itself (via
 *      `POST /v1/identity`, no auth required) and calls the reducer
 *      directly using the user's own connection.
 *
 * Mirrors the host-delegation pattern already used for logout
 * (`NEXT_PUBLIC_PEAR_HOST_LOGOUT_URL`).
 */

import type { Identity } from "spacetimedb";

const HOST_BASE_TEMPLATE =
  process.env.NEXT_PUBLIC_PEAR_AI_USER_API_BASE?.trim() ?? "";

export function isAiUserHostDelegated(): boolean {
  return HOST_BASE_TEMPLATE.length > 0;
}

/**
 * Read the host workspace slug from the current URL when the path matches
 * `/workspace/<slug>/...`. The embedding application defines this route;
 * `{slug}` in `NEXT_PUBLIC_PEAR_AI_USER_API_BASE` is replaced with it.
 * Returns null when the slug cannot be determined.
 */
function currentWorkspaceSlug(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(/^\/workspace\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function resolveHostBase(): string {
  if (!HOST_BASE_TEMPLATE) return "";
  if (!HOST_BASE_TEMPLATE.includes("{slug}")) return HOST_BASE_TEMPLATE;
  const slug = currentWorkspaceSlug();
  if (!slug) {
    throw new Error(
      "AI user host base contains {slug} but no workspace slug found in URL"
    );
  }
  return HOST_BASE_TEMPLATE.replace(/\{slug\}/g, encodeURIComponent(slug));
}

function hostUrl(path = ""): string {
  return `${resolveHostBase().replace(/\/$/, "")}${path}`;
}

// ── Shared types ────────────────────────────────────────────────────────────

export type ProviderTag = "Anthropic" | "OpenAi" | "Ollama" | "OpenAiCompatible";

/**
 * UI-level provider presets. A preset maps to a SpacetimeDB `InferenceProvider`
 * tag plus defaults; OpenRouter is a preset over `OpenAiCompatible` with a
 * pinned endpoint (the worker's OpenAI-compatible client handles it as-is).
 */
export type ProviderPresetKey =
  | "Anthropic"
  | "OpenAi"
  | "OpenRouter"
  | "Meta"
  | "Ollama"
  | "OpenAiCompatible";

export interface ProviderPreset {
  key: ProviderPresetKey;
  /** Reducer enum tag this preset stores. */
  tag: ProviderTag;
  label: string;
  defaultModel: string;
  defaultEndpoint: string;
  /** The preset defines the endpoint; hide the endpoint input. */
  endpointLocked?: boolean;
}

/** Provider picker metadata shared by the AI-user create/edit forms. */
export const PROVIDER_OPTIONS: ProviderPreset[] = [
  { key: "Anthropic", tag: "Anthropic", label: "Anthropic", defaultModel: "claude-haiku-4-5-20251001", defaultEndpoint: "" },
  { key: "OpenAi", tag: "OpenAi", label: "OpenAI", defaultModel: "gpt-4.1-mini", defaultEndpoint: "" },
  {
    key: "OpenRouter",
    tag: "OpenAiCompatible",
    label: "OpenRouter",
    defaultModel: "anthropic/claude-haiku-4.5",
    defaultEndpoint: "https://openrouter.ai/api/v1",
    endpointLocked: true,
  },
  {
    key: "Meta",
    tag: "OpenAiCompatible",
    label: "Meta",
    defaultModel: "muse-spark-1.1",
    defaultEndpoint: "https://api.meta.ai/v1",
    endpointLocked: true,
  },
  { key: "Ollama", tag: "Ollama", label: "Ollama", defaultModel: "llama3.1", defaultEndpoint: "http://localhost:11434/v1" },
  { key: "OpenAiCompatible", tag: "OpenAiCompatible", label: "OpenAI-compatible", defaultModel: "gpt-4.1-mini", defaultEndpoint: "" },
];

export function providerDefaults(preset: ProviderPresetKey): ProviderPreset {
  return PROVIDER_OPTIONS.find((p) => p.key === preset) ?? PROVIDER_OPTIONS[0];
}

/** Presets that require an explicit endpoint URL from the operator. */
export function providerNeedsEndpoint(preset: ProviderPresetKey): boolean {
  const p = providerDefaults(preset);
  return (p.tag === "Ollama" || p.tag === "OpenAiCompatible") && !p.endpointLocked;
}

/**
 * Marker model set by MCP OAuth onboarding (and `mcp:provision`): this AI user
 * is operated by an external MCP client that brings its own model — no worker
 * inference config applies. See lifecycle `mcp_oauth.rs`.
 */
export const EXTERNAL_MCP_MODEL = "external-mcp-client";

export function isExternalMcpProfile(p: { modelName: string }): boolean {
  return p.modelName === EXTERNAL_MCP_MODEL;
}

// ── Model catalog (UI mirror of worker/src/model-catalog.ts) ────────────────
// A provider key generally unlocks the whole family, so we can offer tiered
// quick-picks and tell the operator which cheap sibling the worker uses for
// utility tasks. This is the picker subset (id/tier/label); the worker catalog
// is the source of truth (and also carries per-model effort capability). Keep
// the IDs and tiers in sync. `TIERS` is ordered cheapest → most capable and is
// append-only — `frontier` sits above `flagship` (Fable 5 / GPT-5.5).

export const TIERS = ["fast", "balanced", "flagship", "frontier"] as const;
export type ModelTier = (typeof TIERS)[number];
export interface CatalogModel {
  id: string;
  tier: ModelTier;
  label: string;
}

export const MODEL_CATALOG: Record<ProviderPresetKey, CatalogModel[]> = {
  Anthropic: [
    { id: "claude-fable-5", tier: "frontier", label: "Fable 5" },
    { id: "claude-opus-4-8", tier: "flagship", label: "Opus 4.8" },
    { id: "claude-sonnet-4-6", tier: "balanced", label: "Sonnet 4.6" },
    { id: "claude-haiku-4-5-20251001", tier: "fast", label: "Haiku 4.5" },
  ],
  OpenAi: [
    { id: "gpt-5.6", tier: "frontier", label: "GPT-5.6" },
    { id: "gpt-5.5", tier: "flagship", label: "GPT-5.5" },
    { id: "gpt-5.6-mini", tier: "balanced", label: "GPT-5.6 mini" },
    { id: "gpt-5.6-nano", tier: "fast", label: "GPT-5.6 nano" },
  ],
  // OpenRouter slugs are vendor-prefixed; one key unlocks models across
  // vendors, so the quick-picks span families. Curated suggestions — the
  // model field accepts any slug. Keep in sync with worker/src/model-catalog.ts.
  OpenRouter: [
    { id: "anthropic/claude-fable-5", tier: "frontier", label: "Fable 5" },
    { id: "openai/gpt-5.6", tier: "frontier", label: "GPT-5.6" },
    { id: "google/gemini-3-pro", tier: "frontier", label: "Gemini 3 Pro" },
    { id: "x-ai/grok-4.5", tier: "frontier", label: "Grok 4.5" },
    { id: "anthropic/claude-opus-4.8", tier: "flagship", label: "Opus 4.8" },
    { id: "openai/gpt-5.5", tier: "flagship", label: "GPT-5.5" },
    { id: "z-ai/glm-5.2", tier: "flagship", label: "GLM 5.2" },
    { id: "moonshotai/kimi-k3", tier: "flagship", label: "Kimi K3" },
    { id: "anthropic/claude-sonnet-4.6", tier: "balanced", label: "Sonnet 4.6" },
    { id: "deepseek/deepseek-chat-v3.1", tier: "balanced", label: "DeepSeek V3.1" },
    { id: "anthropic/claude-haiku-4.5", tier: "fast", label: "Haiku 4.5" },
    { id: "google/gemini-3-flash", tier: "fast", label: "Gemini 3 Flash" },
  ],
  // Meta Model API (api.meta.ai) — Muse Spark family. NOTE: the dashboard
  // documents the Responses API (/v1/responses); if chat completions isn't
  // also exposed, the worker's OpenAI-compatible client can't reach it yet.
  Meta: [{ id: "muse-spark-1.1", tier: "flagship", label: "Muse Spark 1.1" }],
  Ollama: [],
  OpenAiCompatible: [],
};

export function providerModels(preset: ProviderPresetKey): CatalogModel[] {
  return MODEL_CATALOG[preset] ?? [];
}

/**
 * Map an AI user's display provider name (from its public profile) to a UI
 * preset. "OpenRouter" is written by the server when an OpenAI-compatible
 * config points at openrouter.ai.
 */
export const PRESET_BY_PROVIDER_NAME: Record<string, ProviderPresetKey> = {
  Anthropic: "Anthropic",
  OpenAI: "OpenAi",
  OpenRouter: "OpenRouter",
  Meta: "Meta",
  Ollama: "Ollama",
  "OpenAI Compatible": "OpenAiCompatible",
};

/** Fast sibling the worker uses for utility tasks; primary model if unknown family. */
export function utilityModelFor(preset: ProviderPresetKey, primaryModel: string): string {
  const fast = MODEL_CATALOG[preset]?.find((m) => m.tier === "fast");
  return fast?.id ?? primaryModel;
}

export interface AiUserCreateRequest {
  displayName: string;
  provider: ProviderTag;
  model: string;
  endpoint?: string;
  apiKey?: string;
  systemPrompt?: string;
  maxTokens?: number;
  avatarUrl?: string;
}

export interface AiUserProfilePatch {
  displayName?: string;
  avatarUrl?: string | null;
}

export interface AiUserConfigPatch {
  provider?: ProviderTag;
  model?: string;
  endpoint?: string | null;
  systemPrompt?: string | null;
  maxTokens?: number;
}

// ── Host-delegated calls (pear-cloud) ───────────────────────────────────────

/**
 * Make an authenticated request against the host AI user API.
 * The host app (pear-cloud) is expected to terminate the session cookie
 * and forward to lifecycle. No bearer token is set here — same-origin
 * cookies handle auth.
 */
async function hostFetch(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(hostUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AI user API ${path || "/"} failed (${res.status}): ${text}`);
  }
  return res;
}

export async function hostCreateAiUser(req: AiUserCreateRequest): Promise<{ aiUserId: number }> {
  const res = await hostFetch("", { method: "POST", body: JSON.stringify(req) });
  return res.json();
}

export async function hostPatchProfile(
  aiUserId: bigint,
  patch: AiUserProfilePatch
): Promise<void> {
  await hostFetch(`/${aiUserId}/profile`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function hostPatchConfig(
  aiUserId: bigint,
  patch: AiUserConfigPatch
): Promise<void> {
  await hostFetch(`/${aiUserId}/config`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function hostPatchAiUserSystemPrompt(
  aiUserId: bigint,
  systemPrompt: string | null
): Promise<void> {
  await hostFetch(`/${aiUserId}/system-prompt`, {
    method: "PATCH",
    body: JSON.stringify({ systemPrompt }),
  });
}

export async function hostUpsertApiKey(aiUserId: bigint, apiKey: string): Promise<void> {
  await hostFetch(`/${aiUserId}/api-key`, {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
}

export async function hostClearApiKey(aiUserId: bigint): Promise<void> {
  await hostFetch(`/${aiUserId}/api-key`, { method: "DELETE" });
}

export async function hostDeleteAiUser(aiUserId: bigint): Promise<void> {
  await hostFetch(`/${aiUserId}`, { method: "DELETE" });
}

// ── Self-hosted: mint Identity directly via SpacetimeDB HTTP ────────────────

/**
 * Convert a `ws[s]://host:port` URL into the matching `http[s]://host:port`
 * form for SpacetimeDB's REST surface.
 */
function toHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

export interface MintedIdentity {
  identity: string; // hex
  token: string;
}

/**
 * Mint a fresh anonymous identity + token from SpacetimeDB. No auth required.
 * Used in self-hosted Pear where the web client owns the AI user lifecycle.
 *
 * In pear-cloud this happens server-side inside lifecycle (which also stores
 * the token alongside the workspace), so the host-delegated path never reaches
 * this function.
 */
export async function mintIdentity(spacetimeWsUri: string): Promise<MintedIdentity> {
  const httpBase = toHttpUrl(spacetimeWsUri);
  const res = await fetch(`${httpBase}/v1/identity`, {
    method: "POST",
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Failed to mint SpacetimeDB identity (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * Convenience: hex-decode a SpacetimeDB identity into the {@link Identity}
 * branded type used by the SDK. Lazy-import to keep this module side-effect
 * free for SSR.
 */
export async function identityFromHex(hex: string): Promise<Identity> {
  const sdk = await import("spacetimedb");
  // SDK exposes Identity.fromString in 2.0.x.
  return (sdk.Identity as unknown as { fromString(s: string): Identity }).fromString(hex);
}
