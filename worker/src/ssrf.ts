/**
 * SSRF guard for built-in web tools (`fetch_url`).
 *
 * The conversation flow's `fetch_url` runs the plain `executeTool` path, which
 * never went through `PermissionChecker` — so an AI user (or prompt injection
 * via fetched/searched content) could hit cloud metadata (169.254.169.254),
 * loopback, or internal services (assessment #2). This module closes that:
 *
 *   1. Only http(s) schemes are allowed (no file:, ftp:, gopher:, data:…).
 *   2. Every hostname is DNS-resolved *before* connecting and every resolved
 *      address is checked against private/loopback/link-local/reserved ranges.
 *      This catches a public hostname that *resolves* to a private IP — the
 *      string-heuristic `isPrivateHost` in `permission-checker.ts` cannot.
 *   3. Redirects are followed manually, re-validating the host of every hop, so
 *      a public URL cannot redirect into the internal network.
 *
 * Residual risk: DNS rebinding between our resolve and the socket's own resolve
 * (TOCTOU). Closing it fully needs connect-time IP pinning (a custom dispatcher
 * lookup); this resolve-then-validate approach blocks the realistic attacks
 * (literal private IPs, hostnames pointing at metadata, redirects to internal)
 * without a new dependency.
 */

import { lookup as dnsLookup } from "node:dns/promises";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * True if `ip` is a private, loopback, link-local, CGNAT, or reserved address
 * that outbound tool fetches must never reach. Conservative: a malformed or
 * unrecognized address is treated as unsafe.
 */
export function isPrivateIp(ip: string): boolean {
  let addr = ip.toLowerCase().trim();

  // Unwrap IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) to its IPv4 form.
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) addr = mapped[1];

  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
    const parts = addr.split(".").map((p) => Number(p));
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // 10/8 private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
    if (a === 192 && b === 168) return true; // 192.168/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 special-use
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
    if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
    return false;
  }

  // IPv6
  if (addr === "::" || addr === "::1") return true; // unspecified + loopback
  if (addr.startsWith("fe80")) return true; // link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // fc00::/7 ULA
  if (addr.startsWith("ff")) return true; // multicast
  // Anything else that still looks like IPv6 we can't classify → treat as unsafe.
  if (addr.includes(":")) return false;

  // Not an IP literal we recognize.
  return true;
}

/** Parse a URL and reject non-http(s) schemes. Throws on rejection. */
function parseHttpUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Blocked non-http(s) URL scheme: ${u.protocol}`);
  }
  return u;
}

/** Resolve `hostname` and throw if any resolved address is private/internal. */
async function assertPublicHost(hostname: string): Promise<void> {
  // Strip brackets from IPv6 literals like [::1].
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");

  // A literal IP can be checked without a DNS round-trip.
  if (isIpLiteral(host)) {
    if (isPrivateIp(host)) {
      throw new Error(`Blocked request to private/internal address (${host})`);
    }
    return;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch {
    throw new Error(`DNS resolution failed for ${host}`);
  }
  if (addresses.length === 0) {
    throw new Error(`DNS resolution returned no addresses for ${host}`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(
        `Blocked request to private/internal address (${host} → ${address})`,
      );
    }
  }
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/**
 * SSRF-safe replacement for `fetch`. Validates the scheme and resolved host of
 * the initial URL and of every redirect hop before connecting, following up to
 * `MAX_REDIRECTS` redirects manually. Returns the final non-redirect `Response`.
 */
export async function ssrfSafeFetch(
  initialUrl: string,
  init: Omit<RequestInit, "redirect" | "signal"> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = initialUrl;
    let requestInit: Omit<RequestInit, "redirect" | "signal"> = { ...init };
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = parseHttpUrl(url);
      await assertPublicHost(parsed.hostname);

      const res = await fetch(url, {
        ...requestInit,
        signal: controller.signal,
        redirect: "manual",
      });

      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        const location = res.headers.get("location");
        if (!location) return res;
        // Resolve relative redirects against the current URL. Credentials are
        // never forwarded across origins; this matters for MCP API keys passed
        // in Authorization headers. Match Fetch semantics for 301/302/303 by
        // switching non-GET/HEAD requests to GET and dropping the body.
        const next = new URL(location, url);
        if (next.origin !== parsed.origin) {
          const headers = new Headers(requestInit.headers);
          headers.delete("authorization");
          headers.delete("cookie");
          headers.delete("proxy-authorization");
          requestInit = { ...requestInit, headers };
        }
        const method = requestInit.method?.toUpperCase();
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && method !== undefined && method !== "GET" && method !== "HEAD")
        ) {
          const headers = new Headers(requestInit.headers);
          headers.delete("content-length");
          headers.delete("content-type");
          requestInit = { ...requestInit, method: "GET", body: undefined, headers };
        }
        url = next.toString();
        continue;
      }
      return res;
    }
    throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
  } finally {
    clearTimeout(timeout);
  }
}
