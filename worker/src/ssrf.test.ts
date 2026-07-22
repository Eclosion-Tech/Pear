import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp, ssrfSafeFetch } from "./ssrf.js";

test("blocks cloud metadata link-local address", () => {
  assert.equal(isPrivateIp("169.254.169.254"), true);
});

test("blocks loopback and unspecified", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("127.255.255.255"), true);
  assert.equal(isPrivateIp("0.0.0.0"), true);
});

test("blocks RFC1918 private ranges", () => {
  assert.equal(isPrivateIp("10.0.0.5"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("172.31.255.255"), true);
  assert.equal(isPrivateIp("192.168.1.1"), true);
});

test("allows public 172.x outside the private block", () => {
  assert.equal(isPrivateIp("172.15.0.1"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false);
});

test("blocks CGNAT and multicast/reserved", () => {
  assert.equal(isPrivateIp("100.64.0.1"), true);
  assert.equal(isPrivateIp("224.0.0.1"), true);
  assert.equal(isPrivateIp("240.0.0.1"), true);
});

test("allows ordinary public addresses", () => {
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("1.1.1.1"), false);
  assert.equal(isPrivateIp("93.184.216.34"), false); // example.com
});

test("blocks IPv6 loopback, ULA, and link-local", () => {
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("::"), true);
  assert.equal(isPrivateIp("fd00::1"), true);
  assert.equal(isPrivateIp("fc00::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPrivateIp("ff02::1"), true);
});

test("blocks IPv4-mapped IPv6 pointing at a private address", () => {
  assert.equal(isPrivateIp("::ffff:169.254.169.254"), true);
  assert.equal(isPrivateIp("::ffff:10.0.0.1"), true);
});

test("allows a public IPv6 address", () => {
  assert.equal(isPrivateIp("2606:4700:4700::1111"), false); // cloudflare
});

test("treats malformed addresses as unsafe (fail closed)", () => {
  assert.equal(isPrivateIp("not-an-ip"), true);
  assert.equal(isPrivateIp("999.999.999.999"), true);
});

test("strips credentials when a guarded request redirects across origins", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = input.toString();
    seen.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (seen.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://8.8.8.8/final" },
      });
    }
    return new Response("ok", { status: 200 });
  };

  try {
    const response = await ssrfSafeFetch("https://1.1.1.1/start", {
      headers: { Authorization: "Bearer secret" },
    });
    assert.equal(await response.text(), "ok");
    assert.deepEqual(seen, [
      { url: "https://1.1.1.1/start", authorization: "Bearer secret" },
      { url: "https://8.8.8.8/final", authorization: null },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
