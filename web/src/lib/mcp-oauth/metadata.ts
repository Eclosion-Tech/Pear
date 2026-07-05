/**
 * Discovery-document builders: RFC 9728 Protected Resource Metadata and
 * RFC 8414 Authorization Server Metadata. Pure functions of the workspace
 * issuer — the gateway serves one pair per {slug}.api.pear.pro host.
 */

import { ALL_SCOPES, DEFAULT_SCOPE, formatScope } from "./scopes";

export interface IssuerConfig {
  /** e.g. https://eclosion.api.pear.pro (no trailing slash). */
  issuer: string;
}

/** Canonical RFC 8707 resource identifier for the MCP endpoint. */
export function canonicalResource(issuer: string): string {
  return `${issuer}/mcp`;
}

/** RFC 9728 document for /.well-known/oauth-protected-resource[/mcp]. */
export function protectedResourceMetadata({ issuer }: IssuerConfig): Record<string, unknown> {
  return {
    resource: canonicalResource(issuer),
    authorization_servers: [issuer],
    scopes_supported: [...ALL_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Pear workspace MCP",
  };
}

/** RFC 8414 document for /.well-known/oauth-authorization-server. */
export function authorizationServerMetadata({ issuer }: IssuerConfig): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // MUST be present or MCP clients refuse to proceed (PKCE discovery).
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...ALL_SCOPES],
    client_id_metadata_document_supported: true,
  };
}

/**
 * The WWW-Authenticate challenge for 401s on /mcp. `scope` advertises the
 * DEFAULT grant (memory-only) — spec: clients treat the challenged scope set
 * as authoritative for the current request; scopes_supported lists the rest
 * for step-up.
 */
export function wwwAuthenticateChallenge(issuer: string, error?: string): string {
  const params = [
    `resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
    `scope="${formatScope(DEFAULT_SCOPE)}"`,
  ];
  if (error) params.unshift(`error="${error}"`);
  return `Bearer ${params.join(", ")}`;
}
