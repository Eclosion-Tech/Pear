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
