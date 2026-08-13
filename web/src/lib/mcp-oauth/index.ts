/**
 * MCP OAuth 2.1 authorization-server core (MCP 2026-07-28 authorization
 * spec; unchanged in substance from 2025-11-25 for this server surface —
 * 2026-07-28 additionally prefers CIMD over DCR, and we serve both) — shared
 * by the pear-cloud api gateway today and mountable from OSS Next routes
 * later. Not yet implemented from 2026-07-28: RFC 9207 `iss` on
 * authorization responses (needs the consent plane to know the issuer).
 * Framework-agnostic, WebCrypto-only. See the agent-auth spec (Pear task
 * page 245) for the architecture.
 */

export {
  ALL_SCOPES,
  DEFAULT_SCOPE,
  SCOPE_DESCRIPTIONS,
  formatScope,
  isKnownScope,
  parseScope,
  scopeForTool,
  toolFilterForScopes,
  type McpOauthScope,
} from "./scopes";
export {
  base64urlEncode,
  isValidCodeVerifier,
  randomToken,
  sha256,
  sha256Base64url,
  verifyPkce,
} from "./pkce";
export {
  jwksFrom,
  publicJwkFrom,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
  type SigningJwk,
  type VerifyOptions,
} from "./jwt";
export {
  authorizationServerMetadata,
  canonicalResource,
  protectedResourceMetadata,
  wwwAuthenticateChallenge,
  type IssuerConfig,
} from "./metadata";
export {
  cimdUrlAllowed,
  fetchCimdDocument,
  isCimdClientId,
  type CimdDocument,
  type CimdFetchResult,
} from "./cimd";
export {
  errorRedirect,
  isLoopbackRedirect,
  redirectUriAllowed,
  validateAuthorizeRequest,
  type AuthorizeParams,
  type AuthorizeValidation,
} from "./validate";
export type {
  OAuthClientRecord,
  OAuthGrantRecord,
  OAuthRequestRecord,
  OAuthStore,
} from "./types";
