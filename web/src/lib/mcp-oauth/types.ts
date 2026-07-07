/**
 * Storage interface for the OAuth authorization server. The CF gateway
 * implements this over Hyperdrive Postgres (workers/api/src/oauth/store.ts);
 * OSS self-host can supply its own store when the endpoints are mounted from
 * Next routes (deferred — see the agent-auth spec, Pear task page 245).
 *
 * Hashing/encryption responsibilities live with the CALLER (routes), not the
 * store: codes and refresh tokens arrive here already sha256'd, worker tokens
 * already encrypted. The store is dumb persistence.
 */

export interface OAuthClientRecord {
  clientId: string;
  clientIdType: "dcr" | "cimd";
  clientName: string | null;
  redirectUris: string[];
  /** CIMD only: epoch ms after which the cached document must be re-fetched. */
  cacheExpiresAtMs?: number | null;
}

export interface OAuthRequestRecord {
  id: string;
  workspaceId: string;
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  state: string | null;
  scope: string;
  codeChallenge: string;
  resource: string;
  status: "pending" | "approved" | "denied" | "redeemed";
  grantId: string | null;
  expiresAtMs: number;
}

export interface OAuthGrantRecord {
  id: string;
  workspaceId: string;
  clientId: string;
  clientName: string | null;
  aiUserId: number;
  aiUserIdentityHex: string;
  workerTokenCiphertext: Uint8Array;
  scope: string;
  revokedAtMs: number | null;
}

export interface OAuthStore {
  // Clients
  getClient(clientId: string): Promise<OAuthClientRecord | null>;
  upsertClient(record: OAuthClientRecord, workspaceId: string | null): Promise<void>;

  // Authorize requests
  createRequest(record: Omit<OAuthRequestRecord, "status" | "grantId">): Promise<void>;
  /** Atomically redeem an approved code (by sha256 hash): flips status
   * approved→redeemed and returns the request+grant, or null if the code is
   * unknown, expired, or already redeemed. */
  redeemCode(codeHash: Uint8Array, nowMs: number): Promise<{
    request: OAuthRequestRecord;
    grant: OAuthGrantRecord;
  } | null>;

  // Grants
  getGrant(grantId: string): Promise<OAuthGrantRecord | null>;

  // Refresh tokens (hashes only)
  insertRefreshToken(args: {
    grantId: string;
    tokenHash: Uint8Array;
    rotatedFromId: string | null;
    expiresAtMs: number;
  }): Promise<void>;
  /** Atomically claim an unused refresh token (single UPDATE, never a
   * cached read — see the Hyperdrive-cache replay incident, 2026-07-07).
   * Returns null when the token is unknown OR already used; callers
   * disambiguate via findRefreshToken and revoke the family on reuse. */
  claimRefreshToken(
    tokenHash: Uint8Array,
    nowMs: number,
  ): Promise<{ id: string; grantId: string; expiresAtMs: number } | null>;
  /** Diagnostic lookup by hash (may be served from a stale cache; never
   * use it to authorize a refresh — that's claimRefreshToken's job). */
  findRefreshToken(tokenHash: Uint8Array): Promise<{
    id: string;
    grantId: string;
    usedAtMs: number | null;
    expiresAtMs: number;
  } | null>;
  revokeRefreshFamily(grantId: string): Promise<void>;
}
