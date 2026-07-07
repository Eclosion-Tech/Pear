import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  wwwAuthenticateChallenge,
} from "./metadata";
import { randomToken, sha256Base64url, verifyPkce } from "./pkce";
import { jwksFrom, signAccessToken, verifyAccessToken, type SigningJwk } from "./jwt";
import { cimdUrlAllowed, fetchCimdDocument } from "./cimd";
import { parseScope, scopeForTool, toolFilterForScopes } from "./scopes";
import { redirectUriAllowed, validateAuthorizeRequest } from "./validate";

const ISSUER = "https://eclosion.api.pear.pro";

async function testJwk(): Promise<SigningJwk> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as SigningJwk;
  jwk.kid = "test-key";
  return jwk;
}

describe("pkce", () => {
  it("verifies RFC 7636 appendix B vector", async () => {
    // verifier/challenge pair from RFC 7636 §B
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await sha256Base64url(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(await verifyPkce(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
  });

  it("rejects wrong verifier and malformed verifiers", async () => {
    const challenge = await sha256Base64url("a".repeat(43));
    expect(await verifyPkce("b".repeat(43), challenge)).toBe(false);
    expect(await verifyPkce("too-short", challenge)).toBe(false);
    expect(await verifyPkce("bad!chars".padEnd(43, "a"), challenge)).toBe(false);
  });

  it("random tokens are unique and base64url", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("jwt", () => {
  const claims = (jwk: SigningJwk) => ({
    iss: ISSUER,
    aud: `${ISSUER}/mcp`,
    sub: "grant-1",
    client_id: "https://client.example/meta.json",
    scope: "memory",
    jti: "j1",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  it("round-trips a valid token", async () => {
    const jwk = await testJwk();
    const token = await signAccessToken(jwk, claims(jwk));
    const verified = await verifyAccessToken(jwk, token, {
      issuer: ISSUER,
      audience: `${ISSUER}/mcp`,
    });
    expect(verified?.sub).toBe("grant-1");
    expect(verified?.scope).toBe("memory");
  });

  it("rejects wrong audience, wrong issuer, expiry, tampering, and foreign keys", async () => {
    const jwk = await testJwk();
    const token = await signAccessToken(jwk, claims(jwk));

    expect(
      await verifyAccessToken(jwk, token, { issuer: ISSUER, audience: "https://other.api.pear.pro/mcp" }),
    ).toBeNull();
    expect(
      await verifyAccessToken(jwk, token, { issuer: "https://other.api.pear.pro", audience: `${ISSUER}/mcp` }),
    ).toBeNull();

    const expired = await signAccessToken(jwk, { ...claims(jwk), exp: Math.floor(Date.now() / 1000) - 3600 });
    expect(await verifyAccessToken(jwk, expired, { issuer: ISSUER, audience: `${ISSUER}/mcp` })).toBeNull();

    const [h, c, s] = token.split(".");
    const tamperedClaims = `${c.slice(0, -2)}AA`;
    expect(
      await verifyAccessToken(jwk, `${h}.${tamperedClaims}.${s}`, { issuer: ISSUER, audience: `${ISSUER}/mcp` }),
    ).toBeNull();

    const otherJwk = await testJwk();
    expect(await verifyAccessToken(otherJwk, token, { issuer: ISSUER, audience: `${ISSUER}/mcp` })).toBeNull();

    expect(await verifyAccessToken(jwk, "not-a-jwt", { issuer: ISSUER, audience: `${ISSUER}/mcp` })).toBeNull();
  });

  it("jwks contains no private material", async () => {
    const jwk = await testJwk();
    const jwks = jwksFrom(jwk);
    expect(jwks.keys).toHaveLength(1);
    expect((jwks.keys[0] as { d?: string }).d).toBeUndefined();
    expect(jwks.keys[0].kid).toBe("test-key");
  });
});

describe("cimd", () => {
  it("SSRF gate rejects local and non-https targets", () => {
    expect(cimdUrlAllowed("https://app.example.com/client.json").ok).toBe(true);
    for (const bad of [
      "http://app.example.com/client.json",
      "https://localhost/client.json",
      "https://127.0.0.1/client.json",
      "https://[::1]/client.json",
      "https://internal.local/client.json",
      "https://svc.internal/client.json",
      "https://app.example.com:8443/client.json",
      "https://user:pw@app.example.com/client.json",
      "https://app.example.com/", // no path component
      "not-a-url",
    ]) {
      expect(cimdUrlAllowed(bad).ok, bad).toBe(false);
    }
  });

  it("validates document rules via injected fetch", async () => {
    const url = "https://app.example.com/client.json";
    const doc = {
      client_id: url,
      client_name: "Example",
      redirect_uris: ["http://localhost:3000/callback"],
    };
    const respond = (body: unknown, init?: ResponseInit) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json", "cache-control": "max-age=600" },
          ...init,
        }),
      );

    const ok = await fetchCimdDocument(url, () => respond(doc));
    expect(ok.ok).toBe(true);
    expect(ok.document?.client_name).toBe("Example");
    expect(ok.cacheSecs).toBe(600);

    const mismatched = await fetchCimdDocument(url, () =>
      respond({ ...doc, client_id: "https://evil.example.com/client.json" }),
    );
    expect(mismatched.ok).toBe(false);

    const noRedirects = await fetchCimdDocument(url, () => respond({ ...doc, redirect_uris: [] }));
    expect(noRedirects.ok).toBe(false);

    const notJson = await fetchCimdDocument(url, () =>
      Promise.resolve(new Response("hi", { headers: { "content-type": "text/html" } })),
    );
    expect(notJson.ok).toBe(false);
  });

  it("rejects a redirecting metadata URL (workerd fetch has no redirect:'error')", async () => {
    // Response() refuses 3xx statuses, so fake the shape that
    // fetch(…, {redirect:"manual"}) actually returns at the edge.
    const redirecting = {
      status: 302,
      ok: false,
      headers: new Headers({ location: "https://internal.example" }),
      text: () => Promise.resolve(""),
    } as unknown as Response;
    const res = await fetchCimdDocument("https://app.example.com/client.json", () =>
      Promise.resolve(redirecting),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("redirect");
  });
});

describe("scopes", () => {
  it("defaults omitted scope to memory-only", () => {
    expect(parseScope(undefined)).toEqual({ scopes: ["memory"], unknown: [] });
    expect(parseScope("")).toEqual({ scopes: ["memory"], unknown: [] });
  });

  it("reports unknown scopes", () => {
    expect(parseScope("memory admin:everything").unknown).toEqual(["admin:everything"]);
  });

  it("filters tools by scope", () => {
    const memoryOnly = toolFilterForScopes(["memory"]);
    expect(memoryOnly("remember")).toBe(true);
    expect(memoryOnly("search_memory")).toBe(true);
    expect(memoryOnly("get_page")).toBe(false);
    expect(memoryOnly("delete_page")).toBe(false);

    const readWrite = toolFilterForScopes(["pages:read", "pages:write"]);
    expect(readWrite("get_page")).toBe(true);
    expect(readWrite("create_page")).toBe(true);
    expect(readWrite("remember")).toBe(false);

    expect(scopeForTool("update_page_content")).toBe("pages:write");
    expect(scopeForTool("list_memory")).toBe("memory");
  });
});

describe("authorize validation", () => {
  const registered = ["http://localhost:3000/callback", "https://app.example.com/cb"];
  const base = {
    response_type: "code",
    client_id: "client-1",
    redirect_uri: "http://localhost:3000/callback",
    scope: "memory",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    resource: `${ISSUER}/mcp`,
    state: "xyz",
  };

  it("accepts a valid request", () => {
    const v = validateAuthorizeRequest(base, registered, ISSUER);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.scopes).toEqual(["memory"]);
      expect(v.resource).toBe(`${ISSUER}/mcp`);
    }
  });

  it("never redirects on unregistered redirect_uri", () => {
    const v = validateAuthorizeRequest(
      { ...base, redirect_uri: "https://evil.example.com/cb" },
      registered,
      ISSUER,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.redirectable).toBe(false);
  });

  it("redirects back for post-validation failures", () => {
    for (const bad of [
      { ...base, code_challenge_method: "plain" },
      { ...base, code_challenge: undefined as unknown as string },
      { ...base, resource: "https://other.api.pear.pro/mcp" },
      { ...base, scope: "memory not-a-scope" },
      { ...base, response_type: "token" },
    ]) {
      const v = validateAuthorizeRequest(bad, registered, ISSUER);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.redirectable).toBe(true);
    }
  });

  it("redirect URI rules: https exact match, loopback ignores port", () => {
    expect(redirectUriAllowed("http://localhost:3000/callback", registered)).toBe(true);
    expect(redirectUriAllowed("http://localhost:3000/callback/", registered)).toBe(false);
    expect(redirectUriAllowed("https://app.example.com/cb", registered)).toBe(true);
    expect(redirectUriAllowed("http://app.example.com/cb", ["http://app.example.com/cb"])).toBe(false);
    // RFC 8252 §7.3: native clients bind an ephemeral loopback port per run —
    // Claude Code registers portless http://localhost/callback via CIMD.
    expect(redirectUriAllowed("http://localhost:3118/callback", ["http://localhost/callback"])).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:49152/callback", ["http://127.0.0.1/callback"])).toBe(true);
    expect(redirectUriAllowed("http://localhost:3118/callback", ["http://127.0.0.1/callback"])).toBe(false);
    expect(redirectUriAllowed("http://localhost:3118/other", ["http://localhost/callback"])).toBe(false);
    // https never gets the port leniency
    expect(redirectUriAllowed("https://app.example.com:8443/cb", ["https://app.example.com/cb"])).toBe(false);
  });
});

describe("metadata", () => {
  it("builds spec-complete documents", () => {
    const as = authorizationServerMetadata({ issuer: ISSUER });
    expect(as.issuer).toBe(ISSUER);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.token_endpoint).toBe(`${ISSUER}/oauth/token`);

    const prm = protectedResourceMetadata({ issuer: ISSUER });
    expect(prm.resource).toBe(`${ISSUER}/mcp`);
    expect(prm.authorization_servers).toEqual([ISSUER]);

    const challenge = wwwAuthenticateChallenge(ISSUER, "invalid_token");
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain('scope="memory"');
  });
});
