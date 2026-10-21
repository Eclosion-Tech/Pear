/** Dormant host library. No runner, tool, route or credential adapter invokes
 * this module. A caller supplies only a discovery ID to a host-configured closure;
 * a parsed/copied plan never supplies execution authority. */
import { randomBytes } from "node:crypto";
import type { LookupFunction } from "node:net";
import { beginProtectedMailDiscoveryDispatch, type ProtectedMailDiscoveryDispatch, type ProtectedMailDiscoveryDispatchResult,
  type ProtectedMailDiscoveryProcedureOptions } from "./protected-mail-discovery-dispatch.js";
import { completeProtectedMailDiscovery, finishProtectedMailDiscoveryDispatch, type ProtectedMailDiscoveryCompletionResult,
  type ProtectedMailDiscoveryReceipt } from "./protected-mail-discovery-report.js";
import { runProtectedMailDiscoverySession } from "./protected-mail-discovery-session.js";
import { ProtectedMailDiscoveryError, type ProtectedMailDiscoveryReason, type ProtectedMailDiscoveryBinding,
  type ProtectedMailDiscoveryCredential, type ProtectedMailDiscoveryOutcome,
  type ProtectedMailDiscoveryReport } from "./protected-mail-discovery-types.js";

export interface ProtectedMailDiscoveryExecutorOptions {
  readonly authority: ProtectedMailDiscoveryProcedureOptions;
  readonly resolveCredential: (binding: ProtectedMailDiscoveryBinding, signal: AbortSignal) => Promise<ProtectedMailDiscoveryCredential | undefined>;
  readonly timeoutMs?: number;
  /** Host trust/network policy, never mail/model-controlled TLS options. */
  readonly ca?: string;
  readonly lookup?: LookupFunction;
}
type ClaimDenial = Extract<ProtectedMailDiscoveryDispatchResult, { kind: "denied" }>["reason"];
type StopReason = ProtectedMailDiscoveryReason | "credential_unavailable" | "credential_binding_mismatch" | "executor_failure";
export type ProtectedMailDiscoveryExecutionResult =
  | { readonly kind: "denied"; readonly reason: ClaimDenial | "aborted" }
  | { readonly kind: "unknown"; readonly reason: "claim_outcome_unknown" }
  | { readonly kind: "stopped"; readonly discoveryId: string; readonly reason: StopReason; readonly report: ProtectedMailDiscoveryReport }
  | { readonly kind: "completed"; readonly discoveryId: string; readonly manifestDigest: string;
    readonly eventNonce: string; readonly receipt: ProtectedMailDiscoveryReceipt }
  | { readonly kind: "unconfirmed"; readonly discoveryId: string; readonly eventNonce: string;
    readonly report: Exclude<ProtectedMailDiscoveryCompletionResult, { kind: "ok" }> };

const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const safe = (v: unknown, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= max;
class Stop extends Error { constructor(readonly reason: StopReason) { super(reason); } }

function dataObject(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) return;
  const copied: Record<string, unknown> = {};
  for (const key of keys) {
    const item = descriptors[key]; if (!item || !("value" in item) || !item.enumerable) return;
    copied[key] = item.value;
  }
  return copied;
}
function passwordValid(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return Buffer.byteLength(value, "utf8") <= 4096;
}
function bindingOf(claim: ProtectedMailDiscoveryDispatch): ProtectedMailDiscoveryBinding {
  const p = claim.plan;
  return Object.freeze({ discoveryId: claim.discoveryId, manifestDigest: claim.manifestDigest, canonical: claim.canonical,
    workspaceId: p.workspaceId, ownerId: p.ownerId, connectionId: p.connection.id, connectionEpoch: p.connection.epoch,
    snapshotDigest: p.connection.snapshotDigest, host: p.mailbox.host, port: p.mailbox.port, username: p.mailbox.username,
    folder: p.mailbox.folder, direction: p.mailbox.direction, notBeforeMs: p.notBeforeMs, expiresAtMs: p.expiresAtMs });
}
function exactCredential(value: unknown, binding: ProtectedMailDiscoveryBinding): string {
  try {
    const row = dataObject(value, ["binding", "password"]);
    if (!row || !passwordValid(row.password)) throw new Stop("credential_binding_mismatch");
    const supplied = dataObject(row.binding, Object.keys(binding));
    if (!supplied || Object.keys(binding).some(key => supplied[key] !== binding[key as keyof ProtectedMailDiscoveryBinding]))
      throw new Stop("credential_binding_mismatch");
    return row.password;
  } catch { throw new Stop("credential_binding_mismatch"); }
}
function signalReason(signal: AbortSignal): "aborted" | "deadline_exceeded" | "discovery_expired" {
  return signal.reason === "deadline_exceeded" ? "deadline_exceeded" : signal.reason === "discovery_expired" ? "discovery_expired" : "aborted";
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Stop(signalReason(signal)));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    return await Promise.race([work, cancelled]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

/** Configuration is copied once. A resolver must check the exact frozen
 * credential/version association and current host authority before returning;
 * its echo is a TCB declaration, not a vault attestation. No fallback exists. */
export function createProtectedMailDiscoveryExecutor(options: ProtectedMailDiscoveryExecutorOptions):
  (discoveryId: string, signal?: AbortSignal) => Promise<ProtectedMailDiscoveryExecutionResult> {
  let authority: ProtectedMailDiscoveryProcedureOptions, resolveCredential: ProtectedMailDiscoveryExecutorOptions["resolveCredential"],
    timeout: number, ca: string | undefined, lookup: LookupFunction | undefined;
  try {
    timeout = options.timeoutMs ?? 20_000; ca = options.ca; lookup = options.lookup; resolveCredential = options.resolveCredential;
    if (!safe(timeout, 60_000) || typeof resolveCredential !== "function" || ca !== undefined && (typeof ca !== "string" || Buffer.byteLength(ca, "utf8") > 65536)
      || lookup !== undefined && typeof lookup !== "function") throw Error("invalid_configuration");
    const o = options.authority;
    authority = Object.freeze({ baseUrl: o.baseUrl, dbName: o.dbName, token: o.token, fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs });
    const url = new URL(authority.baseUrl);
    if (url.origin !== authority.baseUrl || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(authority.dbName) || !/^[\x21-\x7e]{1,16384}$/.test(authority.token)
      || authority.timeoutMs !== undefined && !safe(authority.timeoutMs, 60000)) throw Error("invalid_configuration");
  } catch { return async () => Object.freeze({ kind: "denied", reason: "invalid_request" }); }

  return async (discoveryId, signal) => {
    if (!hex(discoveryId) || signal !== undefined && !(signal instanceof AbortSignal)) return Object.freeze({ kind: "denied", reason: "invalid_request" });
    if (signal?.aborted) return Object.freeze({ kind: "denied", reason: "aborted" });
    const controller = new AbortController(), deadlineAtMs = Date.now() + timeout;
    const abort = () => controller.abort("aborted"); signal?.addEventListener("abort", abort, { once: true });
    let timer = setTimeout(() => controller.abort("deadline_exceeded"), timeout);
    let phase: "claim" | "credential" | "session" = "claim";
    let claim: ProtectedMailDiscoveryDispatch | undefined, session: Awaited<ReturnType<typeof runProtectedMailDiscoverySession>> | undefined;
    let reason: StopReason | undefined;
    try {
      const fetchImpl = authority.fetchImpl ?? fetch;
      const claimAuthority = { ...authority, timeoutMs: Math.min(authority.timeoutMs ?? 15000, timeout),
        fetchImpl: ((input, init) => fetchImpl(input, { ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal })) as typeof fetch };
      const admission = await bounded(beginProtectedMailDiscoveryDispatch(claimAuthority, discoveryId), controller.signal);
      if (admission.kind === "denied") return admission;
      if (admission.kind === "unknown") return Object.freeze({ kind: "unknown", reason: "claim_outcome_unknown" });
      claim = admission.value; phase = "credential";
      const binding = bindingOf(claim);
      if (Date.now() < binding.notBeforeMs || Date.now() >= binding.expiresAtMs) throw new Stop("discovery_expired");
      if (Date.now() >= deadlineAtMs) throw new Stop("deadline_exceeded");
      if (controller.signal.aborted) throw new Stop(signalReason(controller.signal));
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(Date.now() >= binding.expiresAtMs ? "discovery_expired" : "deadline_exceeded"),
        Math.max(1, Math.min(deadlineAtMs, binding.expiresAtMs) - Date.now()));
      let resolved: unknown;
      try { resolved = await bounded(Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Stop(signalReason(controller.signal));
        const now = Date.now();
        if (now < binding.notBeforeMs || now >= binding.expiresAtMs) throw new Stop("discovery_expired");
        if (now >= deadlineAtMs) throw new Stop("deadline_exceeded");
        return resolveCredential(binding, controller.signal);
      }), controller.signal); }
      catch (error) { if (error instanceof Stop) throw error; throw new Stop("credential_unavailable"); }
      if (resolved === undefined) throw new Stop("credential_unavailable");
      const password = exactCredential(resolved, binding);
      if (Date.now() < binding.notBeforeMs || Date.now() >= binding.expiresAtMs) throw new Stop("discovery_expired");
      if (controller.signal.aborted || Date.now() >= deadlineAtMs) throw new Stop(controller.signal.aborted ? signalReason(controller.signal) : "deadline_exceeded");
      phase = "session";
      session = await bounded(runProtectedMailDiscoverySession({ plan: claim.plan, password, signal: controller.signal,
        deadlineAtMs, ca, lookup }), controller.signal);
    } catch (error) {
      if (!claim) return Object.freeze({ kind: "unknown", reason: "claim_outcome_unknown" });
      reason = error instanceof Stop || error instanceof ProtectedMailDiscoveryError ? error.reason : "executor_failure";
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort("aborted");
    }
    // Choose one report before sending. A lost completion never exposes the
    // local observation, switches outcome, refunds, or opens another session.
    const eventNonce = randomBytes(32).toString("hex");
    const reportAuthority = { ...authority, timeoutMs: Math.min(authority.timeoutMs ?? 5000, 5000) };
    if (session) {
      const report = await completeProtectedMailDiscovery(reportAuthority, discoveryId, eventNonce, session);
      if (report.kind !== "ok") return Object.freeze({ kind: "unconfirmed", discoveryId, eventNonce, report });
      return Object.freeze({ kind: "completed", discoveryId, manifestDigest: claim!.manifestDigest, eventNonce, receipt: report.value });
    }
    const outcome: ProtectedMailDiscoveryOutcome = phase === "session"
      && ["transport_closed", "tls_failure", "aborted", "deadline_exceeded", "discovery_expired", "executor_failure"].includes(reason ?? "executor_failure") ? "Unknown" : "Failed";
    const report = await finishProtectedMailDiscoveryDispatch(reportAuthority, discoveryId, outcome, eventNonce);
    return Object.freeze({ kind: "stopped", discoveryId, reason: reason ?? "executor_failure", report });
  };
}
