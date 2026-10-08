/** Explicit HTTP adapters for hosted Jev and self-hosted Nimble. No default URLs/keys. */
import type { AdvisorOptions, SystemOneRequest } from "./routing.js";

export interface SystemOneHttpConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly consent: AdvisorOptions["consent"];
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  /** Finite attempt budget for this adapter instance, including failed HTTP requests. */
  readonly maxCalls: number;
  /** Only self-hosted loopback HTTP, e.g. an operator-created SSH tunnel. */
  readonly allowInsecureLoopback?: boolean;
  readonly fetchImpl?: typeof fetch;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error("System One response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > limit) throw new Error("System One response too large");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("System One response too large");
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    // Also closes an oversized/malformed stream; no unbounded response.text().
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function createHttpAdvisor(config: SystemOneHttpConfig, hosted: boolean, apiKey?: string): AdvisorOptions {
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); } catch { throw new Error("Invalid System One endpoint"); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("System One endpoint must not contain credentials, query or fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:"
    && !(endpoint.protocol === "http:" && !hosted && loopback && config.allowInsecureLoopback === true)) {
    throw new Error("System One requires HTTPS or explicitly approved self-hosted loopback HTTP");
  }
  if (!config.model.trim() || config.model.length > 256
    || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60_000
    || !Number.isInteger(config.maxRequestBytes) || config.maxRequestBytes < 1 || config.maxRequestBytes > 1_048_576
    || !Number.isInteger(config.maxResponseBytes) || config.maxResponseBytes < 1 || config.maxResponseBytes > 1_048_576
    || !Number.isInteger(config.maxCalls) || config.maxCalls < 0 || config.maxCalls > 100_000) {
    throw new Error("Invalid System One model or bounds");
  }
  if (hosted && (!apiKey?.trim() || /[\r\n]/.test(apiKey))) throw new Error("Explicit Jev API key required");
  const destination = endpoint.href;
  const model = config.model;
  const maxRequestBytes = config.maxRequestBytes;
  const maxResponseBytes = config.maxResponseBytes;
  const consent = Object.freeze({ ...config.consent,
    allowedDestinations: Object.freeze([...config.consent.allowedDestinations]) });
  const doFetch = config.fetchImpl ?? fetch;
  let remainingCalls = config.maxCalls;
  return {
    destination, hosted, consent, timeoutMs: config.timeoutMs, maxRequestBytes,
    client: {
      async decide(request: SystemOneRequest, signal: AbortSignal): Promise<unknown> {
        // Direct use of the adapter cannot skip these destination/spending checks.
        if (!consent.enabled || !consent.allowedDestinations.includes(destination)
          || (hosted && !consent.allowHostedSpend)) throw new Error("System One request not approved");
        signal.throwIfAborted();
        const body = JSON.stringify({ model, state: request.state, questions: request.questions });
        if (Buffer.byteLength(body, "utf8") > maxRequestBytes) throw new Error("System One request too large");
        if (remainingCalls === 0) throw new Error("System One request budget exhausted");
        remainingCalls--;
        let response: Response;
        try {
          response = await doFetch(destination, {
            method: "POST", redirect: "error", signal,
            headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
            body,
          });
        } catch { throw new Error("System One transport failed"); }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          // Never include upstream body/headers/URL; they can echo credentials.
          throw new Error(`System One HTTP ${response.status}`);
        }
        return boundedJson(response, maxResponseBytes);
      },
    },
  };
}

export function createJevAdvisor(config: SystemOneHttpConfig & { readonly apiKey: string }): AdvisorOptions {
  return createHttpAdvisor(config, true, config.apiKey);
}
export function createNimbleAdvisor(config: SystemOneHttpConfig): AdvisorOptions {
  return createHttpAdvisor(config, false);
}
