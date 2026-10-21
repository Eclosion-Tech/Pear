/** One bounded report attempt. Local observations never become a caller-visible
 * fallback when authority completion is denied, malformed or unknown. */
import { parseMailDiscoveryObservation } from "../../../packages/sentinel/src/index.js";
import type { ProtectedMailDiscoveryProcedureOptions } from "./protected-mail-discovery-dispatch.js";
import type { ProtectedMailDiscoveryOutcome, ProtectedMailDiscoveryReport } from "./protected-mail-discovery-types.js";

const denials = ["protected_mail_discovery_invalid_request", "protected_mail_discovery_inconsistent",
  "protected_mail_discovery_owner_required", "protected_mail_discovery_service_required",
  "protected_mail_discovery_event_conflict", "protected_mail_discovery_stale",
  "protected_mail_discovery_consumed", "protected_mail_discovery_limit_exceeded"] as const;
const outcomes: readonly ProtectedMailDiscoveryOutcome[] = ["Failed", "Unknown", "CancelledBeforeDispatch"];
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const safe = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const tuple = (v: unknown, size: number): v is unknown[] => Array.isArray(v) && v.length === size;
export interface ProtectedMailDiscoveryReceipt {
  readonly discoveryId: string;
  readonly observationDigest: string;
  readonly headId: string;
  readonly headGeneration: string;
}
export type ProtectedMailDiscoveryCompletionResult =
  | { readonly kind: "ok"; readonly value: ProtectedMailDiscoveryReceipt }
  | { readonly kind: "denied"; readonly reason: typeof denials[number] | "invalid_request" }
  | { readonly kind: "unknown"; readonly reason: "procedure_outcome_unknown" };

function host(options: ProtectedMailDiscoveryProcedureOptions, method: "complete_protected_mail_discovery" | "finish_protected_mail_discovery_dispatch"):
  { target: string; token: string; timeout: number; fetchImpl: typeof fetch } | undefined {
  try {
    const url = new URL(options.baseUrl);
    if (url.origin !== options.baseUrl || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.dbName) || !/^[\x21-\x7e]{1,16384}$/.test(options.token)) return;
    if (options.timeoutMs !== undefined && !safe(options.timeoutMs, 1, 60000)) return;
    return { target: `${url.origin}/v1/database/${encodeURIComponent(options.dbName)}/call/${method}`,
      token: options.token, timeout: Math.min(options.timeoutMs ?? 5000, 5000), fetchImpl: options.fetchImpl ?? fetch };
  } catch { return undefined; }
}
async function boundedBody(response: Response, signal: AbortSignal, json: boolean): Promise<unknown> {
  if (response.status !== 200 || json && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) {
    void response.body?.cancel().catch(() => {}); throw Error("invalid_response");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !safe(Number(length), 0, 4096))) {
    void response.body?.cancel().catch(() => {}); throw Error("invalid_response");
  }
  if (!response.body) { if (json) throw Error("invalid_response"); return; }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw Error("report_timeout");
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > 4096) throw Error("invalid_response");
      if (json) chunks.push(next.value);
    }
    if (!json) return;
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Copies the strict declaration and host configuration before awaiting. Its
 * only successful return is the authenticated authority's metadata receipt. */
export async function completeProtectedMailDiscovery(options: ProtectedMailDiscoveryProcedureOptions,
  discoveryId: string, eventNonce: string, observation: unknown): Promise<ProtectedMailDiscoveryCompletionResult> {
  const copied = parseMailDiscoveryObservation(observation);
  if (!hex(discoveryId) || !hex(eventNonce) || !copied) return Object.freeze({ kind: "denied", reason: "invalid_request" });
  const configured = host(options, "complete_protected_mail_discovery");
  if (!configured) return Object.freeze({ kind: "denied", reason: "invalid_request" });
  const body = JSON.stringify([discoveryId, eventNonce, [copied.uidValidity, copied.uidNext, copied.presentUids]]);
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = (async (): Promise<ProtectedMailDiscoveryCompletionResult> => {
      const response = await configured.fetchImpl(configured.target, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${configured.token}`, "Content-Type": "application/json" }, body, signal: controller.signal });
      const value = await boundedBody(response, controller.signal, true);
      if (!tuple(value, 2)) throw Error("invalid_response");
      if (value[0] === 1 && typeof value[1] === "string" && (denials as readonly string[]).includes(value[1]))
        return Object.freeze({ kind: "denied", reason: value[1] as typeof denials[number] });
      if (value[0] !== 0 || !tuple(value[1], 4)) throw Error("invalid_response");
      const [id, digest, head, generation] = value[1];
      if (id !== discoveryId || !hex(digest) || typeof head !== "string" || !/^mail-discovery-head:[a-f0-9]{64}$/.test(head)
        || !safe(generation, 1, Number.MAX_SAFE_INTEGER)) throw Error("invalid_response");
      return Object.freeze({ kind: "ok", value: Object.freeze({ discoveryId, observationDigest: digest, headId: head, headGeneration: String(generation) }) });
    })();
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("report_timeout")); }, configured.timeout); });
    return await Promise.race([completed, expired]);
  } catch { return Object.freeze({ kind: "unknown", reason: "procedure_outcome_unknown" }); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}

/** A safety declaration has no observation payload. Losing its reply preserves
 * the chosen outcome/nonce and never changes outcome, retries or refunds. */
export async function finishProtectedMailDiscoveryDispatch(options: ProtectedMailDiscoveryProcedureOptions,
  discoveryId: string, outcome: ProtectedMailDiscoveryOutcome, eventNonce: string): Promise<ProtectedMailDiscoveryReport> {
  if (!hex(discoveryId) || !hex(eventNonce) || !outcomes.includes(outcome)) return Object.freeze({ kind: "unknown", eventNonce: "", outcome: "Unknown" });
  const result = (kind: "recorded" | "unknown"): ProtectedMailDiscoveryReport => Object.freeze({ kind, eventNonce, outcome });
  const configured = host(options, "finish_protected_mail_discovery_dispatch");
  if (!configured) return result("unknown");
  const body = JSON.stringify([discoveryId, [outcomes.indexOf(outcome), []], eventNonce]);
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = (async (): Promise<ProtectedMailDiscoveryReport> => {
      const response = await configured.fetchImpl(configured.target, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${configured.token}`, "Content-Type": "application/json" }, body, signal: controller.signal });
      await boundedBody(response, controller.signal, false); return result("recorded");
    })();
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("report_timeout")); }, configured.timeout); });
    return await Promise.race([completed, expired]);
  } catch { return result("unknown"); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
