/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document).
 * The client_id IS an HTTPS URL pointing at a JSON metadata document; we
 * fetch and validate it. The fetch is triggered by an UNTRUSTED input, so the
 * SSRF posture is strict: https only, no userinfo/ports beyond 443, no IP
 * literals or localhost, no cross-origin redirects, bounded size.
 */

export interface CimdDocument {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

const MAX_DOCUMENT_BYTES = 64 * 1024;

export function isCimdClientId(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.pathname.length > 1;
}

/** SSRF gate for the metadata URL itself. */
export function cimdUrlAllowed(clientId: string): { ok: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return { ok: false, reason: "client_id is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "client_id must be https" };
  if (url.username || url.password) return { ok: false, reason: "userinfo not allowed" };
  if (url.port && url.port !== "443") return { ok: false, reason: "non-443 port not allowed" };
  if (url.hash) return { ok: false, reason: "fragment not allowed" };
  if (url.pathname === "/" || url.pathname === "")
    return { ok: false, reason: "client_id must contain a path component" };
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || // IPv4 literal
    host.includes(":") // IPv6 literal
  ) {
    return { ok: false, reason: "IP literals and local hostnames not allowed" };
  }
  return { ok: true };
}

export interface CimdFetchResult {
  ok: boolean;
  document?: CimdDocument;
  /** Seconds the document may be cached, from HTTP cache headers (bounded). */
  cacheSecs?: number;
  error?: string;
}

/** Cache bounds: even "immutable" documents re-fetch within a day. */
const MIN_CACHE_SECS = 60;
const MAX_CACHE_SECS = 24 * 3600;

function cacheSecondsFrom(res: Response): number {
  const cc = res.headers.get("cache-control") ?? "";
  const match = /max-age=(\d+)/.exec(cc);
  const raw = match ? parseInt(match[1], 10) : 3600;
  return Math.min(MAX_CACHE_SECS, Math.max(MIN_CACHE_SECS, raw));
}

export async function fetchCimdDocument(
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CimdFetchResult> {
  const gate = cimdUrlAllowed(clientId);
  if (!gate.ok) return { ok: false, error: gate.reason };

  let res: Response;
  try {
    // redirect: "manual" — workerd's fetch does not implement "error", so we
    // ask for the raw response and reject any 3xx below. A redirecting
    // metadata URL is refused outright, which also closes the
    // redirect-to-internal-host SSRF hole.
    res = await fetchImpl(clientId, {
      redirect: "manual",
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    return { ok: false, error: `metadata fetch failed: ${e instanceof Error ? e.message : e}` };
  }
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, error: "metadata URL must not redirect" };
  }
  if (!res.ok) return { ok: false, error: `metadata fetch returned ${res.status}` };

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return { ok: false, error: "metadata document must be application/json" };
  }

  const text = await res.text();
  if (text.length > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: "metadata document too large" };
  }

  let doc: CimdDocument;
  try {
    doc = JSON.parse(text) as CimdDocument;
  } catch {
    return { ok: false, error: "metadata document is not valid JSON" };
  }

  // client_id in the document MUST exactly match the URL it was fetched from.
  if (doc.client_id !== clientId) {
    return { ok: false, error: "client_id in document does not match its URL" };
  }
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) {
    return { ok: false, error: "metadata document missing redirect_uris" };
  }
  if (typeof doc.client_name !== "string" || !doc.client_name.trim()) {
    return { ok: false, error: "metadata document missing client_name" };
  }

  return { ok: true, document: doc, cacheSecs: cacheSecondsFrom(res) };
}
