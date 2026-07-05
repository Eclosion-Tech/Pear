/**
 * Authorize-request validation (OAuth 2.1 + MCP spec constraints).
 *
 * Error-channel rule (OAuth 2.1 §4.1.2.1): anything wrong with client_id or
 * redirect_uri means we MUST NOT redirect — render the error. Only after the
 * redirect_uri is validated against the registered set may errors flow back
 * via `redirect_uri?error=...`.
 */

import { canonicalResource } from "./metadata";
import { parseScope, type McpOauthScope } from "./scopes";

export interface AuthorizeParams {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  state?: string | null;
  scope?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  resource?: string | null;
}

export type AuthorizeValidation =
  | {
      ok: true;
      clientId: string;
      redirectUri: string;
      state: string | null;
      scopes: McpOauthScope[];
      codeChallenge: string;
      resource: string;
    }
  | { ok: false; redirectable: false; error: string; description: string }
  | { ok: false; redirectable: true; redirectUri: string; state: string | null; error: string; description: string };

/** localhost (loopback) or HTTPS only, exact string match against registered. */
export function redirectUriAllowed(uri: string, registered: readonly string[]): boolean {
  if (!registered.includes(uri)) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    const host = url.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  }
  return false;
}

export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function validateAuthorizeRequest(
  params: AuthorizeParams,
  registeredRedirectUris: readonly string[],
  issuer: string,
): AuthorizeValidation {
  const clientId = params.client_id?.trim();
  const redirectUri = params.redirect_uri?.trim();
  const state = params.state ?? null;

  // Pre-redirect-validation failures: never redirect.
  if (!clientId) {
    return { ok: false, redirectable: false, error: "invalid_request", description: "client_id is required" };
  }
  if (!redirectUri) {
    return { ok: false, redirectable: false, error: "invalid_request", description: "redirect_uri is required" };
  }
  if (!redirectUriAllowed(redirectUri, registeredRedirectUris)) {
    return {
      ok: false,
      redirectable: false,
      error: "invalid_request",
      description: "redirect_uri is not registered for this client (exact match, https or loopback only)",
    };
  }

  // From here the redirect_uri is trusted — errors go back to the client.
  const fail = (error: string, description: string): AuthorizeValidation => ({
    ok: false,
    redirectable: true,
    redirectUri,
    state,
    error,
    description,
  });

  if (params.response_type !== "code") {
    return fail("unsupported_response_type", "only response_type=code is supported");
  }
  if (!params.code_challenge) {
    return fail("invalid_request", "code_challenge is required (PKCE)");
  }
  if (params.code_challenge_method !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }
  // RFC 8707: the client MUST name the resource; it must be OUR mcp endpoint.
  const expected = canonicalResource(issuer);
  const resource = (params.resource ?? "").replace(/\/$/, "");
  if (resource !== expected) {
    return fail("invalid_target", `resource must be ${expected}`);
  }
  const { scopes, unknown } = parseScope(params.scope);
  if (unknown.length > 0) {
    return fail("invalid_scope", `unknown scope(s): ${unknown.join(", ")}`);
  }

  return {
    ok: true,
    clientId,
    redirectUri,
    state,
    scopes,
    codeChallenge: params.code_challenge,
    resource: expected,
  };
}

/** Build a redirect-back error URL (post-validation errors only). */
export function errorRedirect(redirectUri: string, error: string, description: string, state: string | null): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}
