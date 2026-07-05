/**
 * PKCE (RFC 7636) — S256 only, per the MCP authorization spec. WebCrypto.
 */

export function base64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

export async function sha256Base64url(input: string): Promise<string> {
  return base64urlEncode(await sha256(input));
}

/** code_verifier charset/length per RFC 7636 §4.1. */
export function isValidCodeVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

/** Constant-time-ish string compare (both sides are non-secret-length b64url). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify S256(code_verifier) === code_challenge. */
export async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  if (!isValidCodeVerifier(codeVerifier)) return false;
  const computed = await sha256Base64url(codeVerifier);
  return timingSafeEqual(computed, codeChallenge);
}

/** Random opaque token (auth codes, refresh tokens): 32 bytes base64url. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}
