/**
 * ES256 JWT sign/verify for gateway-issued access tokens. WebCrypto only —
 * runs identically in workerd and Node ≥ 19 (vitest).
 *
 * ES256 was chosen over HS256 so the public key is publishable at
 * /.well-known/jwks.json: later phases (auth.md identity assertions) and
 * other services can verify gateway tokens without a shared secret. WebCrypto
 * ECDSA emits IEEE P1363 (r||s) signatures — exactly the JWS ES256 wire
 * format, no DER conversion needed.
 */

import { base64urlEncode } from "./pkce";

export interface AccessTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface SigningJwk extends JsonWebKey {
  kid?: string;
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function encodeSegment(obj: unknown): string {
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

/** Public JWK = private JWK minus the private scalar. */
export function publicJwkFrom(privateJwk: SigningJwk): SigningJwk {
  const { d: _d, ...pub } = privateJwk as SigningJwk & { d?: string };
  return { ...pub, key_ops: undefined, use: "sig", alg: "ES256" };
}

/** RFC 7517 key-set document for /.well-known/jwks.json. */
export function jwksFrom(privateJwk: SigningJwk): { keys: SigningJwk[] } {
  return { keys: [publicJwkFrom(privateJwk)] };
}

async function importKey(jwk: SigningJwk, usage: "sign" | "verify"): Promise<CryptoKey> {
  const { kid: _kid, key_ops: _ops, ...material } = jwk;
  return crypto.subtle.importKey(
    "jwk",
    material as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    [usage],
  );
}

export async function signAccessToken(
  privateJwk: SigningJwk,
  claims: AccessTokenClaims,
): Promise<string> {
  const header = { alg: "ES256", typ: "at+jwt", kid: privateJwk.kid };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const key = await importKey(privateJwk, "sign");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(signature))}`;
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  /** Clock skew allowance in seconds (default 60). */
  skewSecs?: number;
}

/**
 * Verify signature + iss/aud/exp. Returns the claims, or null for anything
 * invalid — callers treat null as "not one of our tokens" (the /mcp dual-auth
 * path then falls back to the legacy raw-worker-token interpretation).
 */
export async function verifyAccessToken(
  jwk: SigningJwk,
  token: string,
  opts: VerifyOptions,
): Promise<AccessTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, sigB64] = parts;

  let header: { alg?: string };
  let claims: AccessTokenClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerB64)));
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(claimsB64)));
  } catch {
    return null;
  }
  if (header.alg !== "ES256") return null;

  let valid: boolean;
  try {
    const key = await importKey(publicJwkFrom(jwk), "verify");
    // TS lib quirk: Uint8Array<ArrayBufferLike> vs BufferSource under the web
    // + node type mix this repo compiles with; the runtime value is fine.
    valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64urlDecode(sigB64) as unknown as BufferSource,
      new TextEncoder().encode(`${headerB64}.${claimsB64}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  const skew = opts.skewSecs ?? 60;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== opts.issuer) return null;
  if (claims.aud !== opts.audience) return null;
  if (typeof claims.exp !== "number" || claims.exp + skew < now) return null;
  return claims;
}
