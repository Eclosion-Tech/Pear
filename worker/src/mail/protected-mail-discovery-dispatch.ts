/** One attempt to release an owner-authorized discovery-plan declaration. This calls
 * only the authority service. It never connects to IMAP or a credential vault.
 * A lost reply may follow committed consumption; never automatically retry. */
import { prepareConnectorDiscovery, type ConnectorDiscoveryV1 } from "../../../packages/sentinel/src/index.js";
import type { ProtectedInferenceProcedureOptions } from "./protected-inference-claim.js";

export type ProtectedMailDiscoveryProcedureOptions = ProtectedInferenceProcedureOptions;
const denials = [
  "protected_mail_discovery_invalid_request", "protected_mail_discovery_inconsistent",
  "protected_mail_discovery_owner_required", "protected_mail_discovery_service_required",
  "protected_mail_discovery_event_conflict", "protected_mail_discovery_stale",
  "protected_mail_discovery_consumed", "protected_mail_discovery_limit_exceeded",
] as const;
export interface ProtectedMailDiscoveryDispatch {
  readonly discoveryId: string;
  readonly manifestDigest: string;
  readonly manifestBytes: number;
  readonly canonical: string;
  readonly plan: ConnectorDiscoveryV1;
}
export type ProtectedMailDiscoveryDispatchResult =
  | { readonly kind: "ok"; readonly value: ProtectedMailDiscoveryDispatch }
  | { readonly kind: "denied"; readonly reason: typeof denials[number] | "invalid_request" }
  | { readonly kind: "unknown"; readonly reason: "procedure_outcome_unknown" };

const MAX_RESPONSE = 16 * 1024, MAX_PLAN = 8 * 1024;
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const safe = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const tuple = (value: unknown, size: number): value is unknown[] => Array.isArray(value) && value.length === size;
const invalid = (): ProtectedMailDiscoveryDispatchResult => Object.freeze({ kind: "denied", reason: "invalid_request" });

async function decode(value: unknown, expectedId: string): Promise<ProtectedMailDiscoveryDispatch | undefined> {
  if (!tuple(value, 4)) return;
  const [discoveryId, manifestDigest, manifestBytes, canonical] = value;
  if (discoveryId !== expectedId || !hex(manifestDigest) || !safe(manifestBytes, 1, MAX_PLAN)
    || typeof canonical !== "string" || canonical.length > MAX_PLAN || Buffer.byteLength(canonical, "utf8") !== manifestBytes) return;
  const prepared = await prepareConnectorDiscovery(JSON.parse(canonical));
  if (prepared.status !== "prepared" || prepared.discovery.canonical !== canonical || prepared.discovery.manifest.discoveryId !== expectedId
    || prepared.discovery.manifestDigest !== manifestDigest || prepared.discovery.manifestBytes !== manifestBytes) return;
  // This verifies the complete declared plan, never future message bytes,
  // actual IMAP behavior, physical isolation, or a credential's permissions.
  return Object.freeze({ discoveryId, manifestDigest, manifestBytes, canonical, plan: prepared.discovery.manifest });
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) throw Error("invalid_response");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !safe(Number(length), 1, MAX_RESPONSE))) throw Error("invalid_response");
  if (!response.body) throw Error("invalid_response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw Error("invalid_response");
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE) throw Error("invalid_response");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Host-owned authority URL, workspace and credential must never come from mail
 * or a model proposal. Snapshot them before awaiting. Explicit retries also
 * cannot recover a released plan: the server must return consumed instead. */
export async function beginProtectedMailDiscoveryDispatch(options: ProtectedMailDiscoveryProcedureOptions,
  discoveryId: string): Promise<ProtectedMailDiscoveryDispatchResult> {
  if (!hex(discoveryId)) return invalid();
  let target: string, token: string, timeout: number, fetchImpl: typeof fetch;
  try {
    const url = new URL(options.baseUrl);
    if (url.origin !== options.baseUrl || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.dbName) || !/^[\x21-\x7e]{1,16384}$/.test(options.token)) return invalid();
    timeout = options.timeoutMs ?? 15_000;
    if (!safe(timeout, 1, 60_000)) return invalid();
    target = `${url.origin}/v1/database/${encodeURIComponent(options.dbName)}/call/begin_protected_mail_discovery_dispatch`;
    token = options.token; fetchImpl = options.fetchImpl ?? fetch;
  } catch { return invalid(); }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = (async (): Promise<ProtectedMailDiscoveryDispatchResult> => {
      const response = await fetchImpl(target, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify([discoveryId]), signal: controller.signal });
      const result = await boundedJson(response, controller.signal);
      if (!tuple(result, 2)) throw Error("invalid_response");
      if (result[0] === 1 && typeof result[1] === "string" && (denials as readonly string[]).includes(result[1])) {
        return Object.freeze({ kind: "denied", reason: result[1] as typeof denials[number] });
      }
      if (result[0] !== 0) throw Error("invalid_response");
      const value = await decode(result[1], discoveryId);
      if (!value) throw Error("invalid_response");
      return Object.freeze({ kind: "ok", value });
    })();
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("procedure_timeout")); }, timeout); });
    return await Promise.race([completed, expired]);
  } catch { return Object.freeze({ kind: "unknown", reason: "procedure_outcome_unknown" }); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
