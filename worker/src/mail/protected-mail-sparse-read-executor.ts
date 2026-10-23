/** Dormant host closure. No runner, tool, route or production credential adapter
 * invokes it. A copied plan is never an execution permit. Public results contain
 * only opaque identifiers and fixed report metadata, including after success. */
import { randomBytes } from "node:crypto";
import type { LookupFunction } from "node:net";
import { beginProtectedMailSparseReadDispatch, type ProtectedMailSparseReadDispatch, type ProtectedMailSparseReadDispatchResult,
  type ProtectedMailSparseReadProcedureOptions } from "./protected-mail-sparse-read-dispatch.js";
import { finishProtectedMailSparseReadDispatch } from "./protected-mail-sparse-read-report.js";
import { sparseReadAuthority, type ProtectedMailSparseReadOutcome, type ProtectedMailSparseReadReport } from "./protected-mail-sparse-read-types.js";
import { runProtectedMailSparseReadSession } from "./protected-mail-sparse-read-session.js";
import { ProtectedMailSparseReadImapError, protectedMailSparseReadImapReasons, type ProtectedMailSparseReadImapReason,
  type ProtectedMailSparseReadBinding, type ProtectedMailSparseReadCredential } from "./protected-mail-sparse-read-executor-types.js";

export interface ProtectedMailSparseReadExecutorOptions {
  readonly authority: ProtectedMailSparseReadProcedureOptions;
  readonly resolveCredential: (binding: ProtectedMailSparseReadBinding, signal: AbortSignal) => Promise<ProtectedMailSparseReadCredential | undefined>;
  readonly timeoutMs?: number;
  /** Host trust/network policy, never message-controlled TLS configuration. */
  readonly ca?: string;
  readonly lookup?: LookupFunction;
}
type ClaimDenial = Extract<ProtectedMailSparseReadDispatchResult, { kind: "denied" }>["reason"];
type StopReason = ProtectedMailSparseReadImapReason | "credential_unavailable" | "credential_binding_mismatch" | "executor_failure";
export type ProtectedMailSparseReadExecutionResult =
  | { readonly kind: "denied"; readonly reason: ClaimDenial | "aborted" }
  | { readonly kind: "unknown"; readonly reason: "claim_outcome_unknown" }
  | { readonly kind: "stopped"; readonly readId: string; readonly reason: StopReason; readonly report: ProtectedMailSparseReadReport }
  | { readonly kind: "completed"; readonly readId: string; readonly planDigest: string; readonly report: ProtectedMailSparseReadReport };

const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const safe = (v: unknown, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= max;
class Stop extends Error { constructor(readonly reason: StopReason) { super(reason); Object.freeze(this); } }
function dataObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
  const descriptors = Object.getOwnPropertyDescriptors(value), allowed = [...required, ...optional];
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !allowed.includes(key)) || required.some(key => !descriptors[key])) return;
  const copied: Record<string, unknown> = {};
  for (const key of Object.keys(descriptors)) {
    const field = descriptors[key]; if (!("value" in field) || !field.enumerable) return;
    copied[key] = field.value;
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
function bindingOf(claim: ProtectedMailSparseReadDispatch): ProtectedMailSparseReadBinding {
  const p = claim.plan;
  return Object.freeze({ readId: claim.readId, planDigest: claim.planDigest, canonical: claim.canonical,
    workspaceId: p.workspaceId, ownerId: p.ownerId, connectionId: p.connection.id, connectionEpoch: p.connection.epoch,
    snapshotDigest: p.connection.snapshotDigest, host: p.mailbox.host, port: p.mailbox.port, username: p.mailbox.username,
    folder: p.mailbox.folder, direction: p.mailbox.direction, notBeforeMs: p.notBeforeMs, expiresAtMs: p.expiresAtMs });
}
function exactCredential(value: unknown, binding: ProtectedMailSparseReadBinding): string {
  try {
    const row = dataObject(value, ["binding", "password"]);
    if (!row || !passwordValid(row.password)) throw new Stop("credential_binding_mismatch");
    const supplied = dataObject(row.binding, Object.keys(binding));
    if (!supplied || Object.keys(binding).some(key => supplied[key] !== binding[key as keyof ProtectedMailSparseReadBinding]))
      throw new Stop("credential_binding_mismatch");
    return row.password;
  } catch { throw new Stop("credential_binding_mismatch"); }
}
function signalReason(signal: AbortSignal): "aborted" | "deadline_exceeded" | "read_expired" {
  return signal.reason === "deadline_exceeded" ? "deadline_exceeded" : signal.reason === "read_expired" ? "read_expired" : "aborted";
}
function guardedReason(error: unknown, privateOnly = false): StopReason | undefined {
  try {
    if (error instanceof Stop || !privateOnly && error instanceof ProtectedMailSparseReadImapError) {
      const reason = error.reason;
      if ([...protectedMailSparseReadImapReasons, "credential_unavailable", "credential_binding_mismatch", "executor_failure"].includes(reason)) return reason;
    }
  } catch { /* Hostile error objects never supply diagnostics or reasons. */ }
  return undefined;
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Stop(signalReason(signal)));
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
    return await Promise.race([work, cancelled]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}
function guard(signal: AbortSignal, deadlineAtMs: number, interval: { readonly notBeforeMs: number; readonly expiresAtMs: number }): void {
  if (signal.aborted) throw new Stop(signalReason(signal));
  const now = Date.now();
  if (now < interval.notBeforeMs || now >= interval.expiresAtMs) throw new Stop("read_expired");
  if (now >= deadlineAtMs) throw new Stop("deadline_exceeded");
}

/** Copies closed host configuration once. A future production resolver must
 * independently validate current credential/version/authority immediately before
 * secret release. Its echo alone certifies none of those checks. No fallback. */
export function createProtectedMailSparseReadExecutor(options: ProtectedMailSparseReadExecutorOptions):
  (readId: string, signal?: AbortSignal) => Promise<ProtectedMailSparseReadExecutionResult> {
  let authority: ProtectedMailSparseReadProcedureOptions, resolveCredential: ProtectedMailSparseReadExecutorOptions["resolveCredential"],
    timeout: number, ca: string | undefined, lookup: LookupFunction | undefined;
  try {
    const copied = dataObject(options, ["authority", "resolveCredential"], ["timeoutMs", "ca", "lookup"]);
    if (!copied) throw Error("invalid_configuration");
    const host = dataObject(copied.authority, ["baseUrl", "dbName", "token"], ["fetchImpl", "timeoutMs"]);
    if (!host) throw Error("invalid_configuration");
    authority = Object.freeze(host) as unknown as ProtectedMailSparseReadProcedureOptions;
    if (!sparseReadAuthority(authority, false)) throw Error("invalid_configuration");
    const requested = copied.timeoutMs ?? 20_000;
    if (!safe(requested, 60_000) || typeof copied.resolveCredential !== "function"
      || copied.ca !== undefined && (typeof copied.ca !== "string" || Buffer.byteLength(copied.ca, "utf8") > 65536)
      || copied.lookup !== undefined && typeof copied.lookup !== "function") throw Error("invalid_configuration");
    timeout = requested; ca = copied.ca as string | undefined; lookup = copied.lookup as LookupFunction | undefined;
    resolveCredential = copied.resolveCredential as ProtectedMailSparseReadExecutorOptions["resolveCredential"];
  } catch { return async () => Object.freeze({ kind: "denied", reason: "invalid_request" }); }

  return async (readId, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort("aborted");
    try {
      if (!hex(readId) || signal !== undefined && !(signal instanceof AbortSignal)) return Object.freeze({ kind: "denied", reason: "invalid_request" });
      if (signal?.aborted) return Object.freeze({ kind: "denied", reason: "aborted" });
      signal?.addEventListener("abort", abort, { once: true });
    } catch { return Object.freeze({ kind: "denied", reason: "invalid_request" }); }
    const deadlineAtMs = Date.now() + timeout;
    let timer = setTimeout(() => controller.abort("deadline_exceeded"), timeout);
    let phase: "claim" | "credential" | "session" = "claim", claim: ProtectedMailSparseReadDispatch | undefined;
    let succeeded = false, reason: StopReason | undefined;
    try {
      const fetchImpl = authority.fetchImpl ?? fetch;
      const claimAuthority = { ...authority, timeoutMs: Math.min(authority.timeoutMs ?? 15000, timeout),
        fetchImpl: ((input, init) => fetchImpl(input, { ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal })) as typeof fetch };
      const admission = await bounded(beginProtectedMailSparseReadDispatch(claimAuthority, readId), controller.signal);
      if (admission.kind === "denied") return admission;
      if (admission.kind === "unknown") return Object.freeze({ kind: "unknown", reason: "claim_outcome_unknown" });
      // This guard precedes attaching the returned claim. A late reply leaves
      // consumption unknown locally and cannot resolve a secret or send a report.
      guard(controller.signal, deadlineAtMs, admission.value.plan);
      claim = admission.value; phase = "credential";
      guard(controller.signal, deadlineAtMs, claim.plan);
      const binding = bindingOf(claim);
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(Date.now() >= binding.expiresAtMs ? "read_expired" : "deadline_exceeded"),
        Math.max(1, Math.min(deadlineAtMs, binding.expiresAtMs) - Date.now()));
      let resolved: unknown;
      try {
        resolved = await bounded(Promise.resolve().then(() => {
          guard(controller.signal, deadlineAtMs, binding);
          return resolveCredential(binding, controller.signal);
        }), controller.signal);
      } catch (error) { throw new Stop(guardedReason(error, true) ?? "credential_unavailable"); }
      guard(controller.signal, deadlineAtMs, binding);
      if (resolved === undefined) throw new Stop("credential_unavailable");
      const password = exactCredential(resolved, binding);
      guard(controller.signal, deadlineAtMs, binding);
      phase = "session";
      // Body-derived metadata stays internal even on successful completion.
      await bounded(runProtectedMailSparseReadSession({ plan: claim.plan, password, signal: controller.signal, deadlineAtMs, ca, lookup }), controller.signal);
      succeeded = true;
    } catch (error) {
      if (!claim) return Object.freeze({ kind: "unknown", reason: "claim_outcome_unknown" });
      reason = guardedReason(error) ?? "executor_failure";
    } finally {
      clearTimeout(timer); try { signal?.removeEventListener("abort", abort); } catch { /* No raw caller error. */ }
      controller.abort("aborted");
    }
    // Choose exactly once, then make one separately bounded safety report.
    const outcome: ProtectedMailSparseReadOutcome = succeeded ? "ReadReported" : phase === "session"
      && ["tls_failure", "transport_closed", "aborted", "deadline_exceeded", "read_expired", "executor_failure"].includes(reason ?? "executor_failure") ? "Unknown" : "Failed";
    const eventNonce = randomBytes(32).toString("hex");
    const report = await finishProtectedMailSparseReadDispatch({ ...authority, timeoutMs: Math.min(authority.timeoutMs ?? 5000, 5000) }, readId, outcome, eventNonce);
    return succeeded ? Object.freeze({ kind: "completed", readId, planDigest: claim!.planDigest, report })
      : Object.freeze({ kind: "stopped", readId, reason: reason ?? "executor_failure", report });
  };
}
