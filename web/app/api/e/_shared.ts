/**
 * Wiring for the default Pear Next.js custom-API handler. Reads
 * `PEAR_STDB_*` env vars, validates the request's Bearer key, and self-
 * disables when an external gateway is configured via
 * `NEXT_PUBLIC_PEAR_API_URL_TEMPLATE`.
 *
 * All HTTP-method routes ([slug]/route.ts, [slug]/[id]/route.ts,
 * [slug]/_schema/route.ts) defer to `serveEndpointRequest()` here.
 */

import {
  ApiEndpointError,
  type AuthResult,
  EndpointConfigCache,
  HttpStdbTransport,
  dispatchApiEndpointRequest,
  isCustomTemplate,
  resolveEndpointUrl,
  type StdbTransport,
} from "@/src/lib/api-endpoint";

const SHARED_CACHE = new EndpointConfigCache({ maxEntries: 256, ttlMs: 60_000 });

let cachedTransport: StdbTransport | null = null;

function getConfiguredDbName(): string {
  return process.env.PEAR_STDB_DB_NAME?.trim() || "pear";
}

function getTransport(): StdbTransport {
  if (cachedTransport) return cachedTransport;
  const baseUrl = process.env.PEAR_STDB_URL?.trim() || "http://localhost:3000";
  const dbName = getConfiguredDbName();
  const token = process.env.PEAR_STDB_TOKEN?.trim();
  if (!token) {
    throw new ApiEndpointError(
      503,
      "stdb_not_configured",
      "PEAR_STDB_TOKEN is not set. Set it in your environment so the API handler can authenticate to SpacetimeDB.",
    );
  }
  cachedTransport = new HttpStdbTransport({ baseUrl, dbName, token });
  return cachedTransport;
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ApiKeyRow {
  id: string | number;
  endpoint_id: string | number;
  allowed_methods: unknown;
  expires_at: unknown;
}

async function authenticateRequest(
  request: Request,
  endpointSlug: string,
  method: string,
  transport: StdbTransport,
): Promise<AuthResult> {
  const header = request.headers.get("authorization");
  if (header && /^bearer\s+/i.test(header)) {
    const raw = header.replace(/^bearer\s+/i, "").trim();
    if (!raw) {
      throw new ApiEndpointError(401, "auth_invalid", "Bearer token is empty");
    }
    const hash = await sha256Hex(raw);
    const safeHash = hash.replace(/'/g, "''");
    const safeSlug = endpointSlug.replace(/'/g, "''");

    // Query the public `api_endpoint_key_lookup` view — a narrow projection
    // of the private `api_endpoint_key` table — so non-owner identities can
    // validate Bearer tokens. The default Next.js handler uses the database
    // owner token and could read the private table directly, but we go
    // through the view in both runtimes for a single auth code path.
    const rows = await transport.sql<ApiKeyRow>(
      `SELECT k.id, k.endpoint_id, k.allowed_methods, k.expires_at
         FROM api_endpoint_key_lookup k
         JOIN api_endpoint e ON e.id = k.endpoint_id
        WHERE e.slug = '${safeSlug}'
          AND k.key_hash = '${safeHash}'
        LIMIT 1`,
    );
    if (rows.length === 0) {
      throw new ApiEndpointError(401, "auth_invalid", "Invalid API key");
    }
    const key = rows[0];

    // Expiry check (Option<Timestamp> SATS shape: `{some: <us>}` or `{none:[]}`).
    if (
      key.expires_at &&
      typeof key.expires_at === "object" &&
      "some" in (key.expires_at as object)
    ) {
      const some = (key.expires_at as { some: number | string }).some;
      const expiresMs =
        typeof some === "string" ? Number(some) / 1000 : Number(some) / 1000;
      if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
        throw new ApiEndpointError(401, "auth_invalid", "API key has expired");
      }
    }

    if (!keyAllowsMethod(key.allowed_methods, method)) {
      throw new ApiEndpointError(
        403,
        "method_not_allowed_for_key",
        `API key does not permit ${method} requests`,
      );
    }

    return { kind: "api-key", keyId: Number(key.id) };
  }

  // No bearer header. Fall back to "open" — the dispatcher will reject the
  // request when `endpoint.requireAuth` is true. Self-hosted Pear can later
  // wire its OIDC session here to elevate to `kind: "session"`.
  return { kind: "open" };
}

function keyAllowsMethod(allowed: unknown, method: string): boolean {
  if (!Array.isArray(allowed)) return false;
  const want = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  return allowed.some((m) => {
    if (typeof m === "string") return m === want;
    if (typeof m === "object" && m !== null) {
      return Object.keys(m as object)[0] === want;
    }
    return false;
  });
}

interface ServeOptions {
  request: Request;
  slug: string;
  trailing?: string;
}

/**
 * Entry point shared by every method/route file. Returns either the
 * dispatcher's `Response` or a 410-with-`Location` redirect when an
 * external gateway has taken over via `NEXT_PUBLIC_PEAR_API_URL_TEMPLATE`.
 */
export async function serveEndpointRequest(opts: ServeOptions): Promise<Response> {
  const { request, slug, trailing } = opts;
  const url = new URL(request.url);
  const template = process.env.NEXT_PUBLIC_PEAR_API_URL_TEMPLATE?.trim();
  if (isCustomTemplate(template)) {
    const target = resolveEndpointUrl({
      template,
      workspaceSlug: "",
      endpointSlug: slug,
      origin: url.origin,
    });
    return new Response(null, {
      status: 410,
      headers: {
        Location: target,
        "Cache-Control": "no-store",
      },
    });
  }

  let transport: StdbTransport;
  try {
    transport = getTransport();
  } catch (e) {
    return errorJson(e);
  }

  let auth: AuthResult;
  try {
    auth = await authenticateRequest(request, slug, request.method, transport);
  } catch (e) {
    return errorJson(e);
  }

  const body = await readJsonBody(request);
  const callerIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip") ||
    undefined;

  return dispatchApiEndpointRequest({
    url,
    method: request.method,
    body,
    endpointSlug: slug,
    trailing,
    transport,
    auth,
    cache: SHARED_CACHE,
    // This handler owns one process-wide transport configured by PEAR_STDB_*.
    // Supplying an explicit namespace opts it into the dispatcher's cache;
    // multi-tenant hosts must use a distinct stable identity per database.
    cacheNamespace: `self-hosted-db:${getConfiguredDbName()}`,
    callerIp: callerIp ?? undefined,
    baseUrl: `${url.origin}/api/e/${encodeURIComponent(slug)}`,
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") return undefined;
  const text = await request.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiEndpointError(
      400,
      "invalid_body",
      "Request body must be valid JSON",
    );
  }
}

function errorJson(err: unknown): Response {
  if (err instanceof ApiEndpointError) {
    return new Response(
      JSON.stringify({
        error: { code: err.code, message: err.message, details: err.details },
      }),
      {
        status: err.status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Response(
    JSON.stringify({ error: { code: "internal_error", message } }),
    {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    },
  );
}
