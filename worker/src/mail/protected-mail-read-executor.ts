/** Dormant host library. No runner, tool, route or credential adapter invokes
 * this module. A caller supplies only a read ID to a host-configured closure;
 * a parsed/copied plan never supplies execution authority. */
import { randomBytes } from "node:crypto";
import type { LookupFunction } from "node:net";
import { beginProtectedMailReadDispatch, type ProtectedMailReadDispatch, type ProtectedMailReadDispatchResult,
  type ProtectedMailReadProcedureOptions } from "./protected-mail-read-dispatch.js";
import { finishProtectedMailReadDispatch } from "./protected-mail-read-report.js";
import { runProtectedMailImapSession, runProtectedMailImapIngestionSession } from "./protected-mail-imap-session.js";
import type { ProtectedMailIngestionCustody } from "./protected-mail-ingestion-custody.js";
import { ProtectedMailImapError, type ProtectedMailImapReason, type ProtectedMailReadBinding,
  type ProtectedMailReadCredential, type ProtectedMailReadMessageMetadata, type ProtectedMailReadOutcome,
  type ProtectedMailReadReport } from "./protected-mail-read-types.js";

export interface ProtectedMailReadExecutorOptions {
  readonly authority: ProtectedMailReadProcedureOptions;
  readonly resolveCredential: (binding: ProtectedMailReadBinding, signal: AbortSignal) => Promise<ProtectedMailReadCredential | undefined>;
  readonly timeoutMs?: number;
  /** Host trust/network policy, never mail/model-controlled TLS options. */
  readonly ca?: string;
  readonly lookup?: LookupFunction;
}
type ClaimDenial = Extract<ProtectedMailReadDispatchResult, { kind: "denied" }>["reason"];
type StopReason = ProtectedMailImapReason | "credential_unavailable" | "credential_binding_mismatch" | "executor_failure";
export type ProtectedMailReadExecutionResult =
  | { readonly kind: "denied"; readonly reason: ClaimDenial | "aborted" }
  | { readonly kind: "unknown"; readonly reason: "claim_outcome_unknown" }
  | { readonly kind: "stopped"; readonly readId: string; readonly reason: StopReason; readonly report: ProtectedMailReadReport }
  | { readonly kind: "completed"; readonly readId: string; readonly planDigest: string; readonly uidValidity: string;
    readonly messages: readonly ProtectedMailReadMessageMetadata[]; readonly bodyBytes: number; readonly report: ProtectedMailReadReport };
/** Private composition result; not exposed by the public read executor. */
export type ProtectedMailIngestionReadResult = Exclude<ProtectedMailReadExecutionResult, { kind: "completed" }>
  | { readonly kind: "captured"; readonly claim: ProtectedMailReadDispatch; readonly custody: ProtectedMailIngestionCustody };

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
function bindingOf(claim: ProtectedMailReadDispatch): ProtectedMailReadBinding {
  const p = claim.plan, s = p.selection;
  return Object.freeze({ readId: claim.readId, planDigest: claim.planDigest, selectionId: s.selectionId,
    workspaceId: s.workspaceId, ownerId: s.ownerId, connectionId: s.connection.id, connectionEpoch: s.connection.epoch,
    snapshotDigest: s.connection.snapshotDigest, host: s.mailbox.host, port: s.mailbox.port, username: s.mailbox.username,
    folder: s.mailbox.folder, direction: s.mailbox.direction, uidValidity: s.selection.uidValidity,
    uids: Object.freeze([...s.selection.uids]), notBeforeMs: s.notBeforeMs, expiresAtMs: s.expiresAtMs });
}
function exactCredential(value: unknown, binding: ProtectedMailReadBinding): string {
  try {
    const row = dataObject(value, ["binding", "password"]);
    if (!row || !passwordValid(row.password)) throw new Stop("credential_binding_mismatch");
    const supplied = dataObject(row.binding, Object.keys(binding));
    if (!supplied) throw new Stop("credential_binding_mismatch");
    for (const key of Object.keys(binding) as Array<keyof ProtectedMailReadBinding>) {
      if (key !== "uids") { if (supplied[key] !== binding[key]) throw new Stop("credential_binding_mismatch"); continue; }
      const uids = supplied.uids;
      if (!Array.isArray(uids) || Object.getPrototypeOf(uids) !== Array.prototype) throw new Stop("credential_binding_mismatch");
      const descriptors = Object.getOwnPropertyDescriptors(uids) as unknown as PropertyDescriptorMap;
      if (descriptors.length?.value !== binding.uids.length || Reflect.ownKeys(descriptors).length !== binding.uids.length + 1) throw new Stop("credential_binding_mismatch");
      for (let i = 0; i < binding.uids.length; i++) {
        const d = descriptors[String(i)];
        if (!d || !("value" in d) || !d.enumerable || d.value !== binding.uids[i]) throw new Stop("credential_binding_mismatch");
      }
    }
    return row.password;
  } catch { throw new Stop("credential_binding_mismatch"); }
}
function signalReason(signal: AbortSignal): "aborted" | "deadline_exceeded" | "read_expired" {
  return signal.reason === "deadline_exceeded" ? "deadline_exceeded" : signal.reason === "read_expired" ? "read_expired" : "aborted";
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
function createExecutor(options: ProtectedMailReadExecutorOptions, capture: false): (readId: string, signal?: AbortSignal) => Promise<ProtectedMailReadExecutionResult>;
function createExecutor(options: ProtectedMailReadExecutorOptions, capture: true): (readId: string, signal?: AbortSignal) => Promise<ProtectedMailIngestionReadResult>;
function createExecutor(options: ProtectedMailReadExecutorOptions, capture: boolean):
  (readId: string, signal?: AbortSignal) => Promise<ProtectedMailReadExecutionResult | ProtectedMailIngestionReadResult> {
  let authority: ProtectedMailReadProcedureOptions, resolveCredential: ProtectedMailReadExecutorOptions["resolveCredential"],
    timeout: number, ca: string | undefined, lookup: LookupFunction | undefined;
  try {
    timeout = options.timeoutMs ?? 20_000; ca = options.ca; lookup = options.lookup; resolveCredential = options.resolveCredential;
    if (!safe(timeout, 60_000) || typeof resolveCredential !== "function" || ca !== undefined && (typeof ca !== "string" || ca.length > 65536)
      || lookup !== undefined && typeof lookup !== "function") throw Error("invalid_configuration");
    const o = options.authority;
    authority = Object.freeze({ baseUrl: o.baseUrl, dbName: o.dbName, token: o.token, fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs });
    const url = new URL(authority.baseUrl);
    if (url.origin !== authority.baseUrl || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(authority.dbName) || !/^[\x21-\x7e]{1,16384}$/.test(authority.token)
      || authority.timeoutMs !== undefined && !safe(authority.timeoutMs, 60000)) throw Error("invalid_configuration");
  } catch { return async () => Object.freeze({ kind: "denied", reason: "invalid_request" }); }

  return async (readId, signal) => {
    if (!hex(readId) || signal !== undefined && !(signal instanceof AbortSignal)) return Object.freeze({ kind: "denied", reason: "invalid_request" });
    if (signal?.aborted) return Object.freeze({ kind: "denied", reason: "aborted" });
    const controller = new AbortController(), deadlineAtMs = Date.now() + timeout;
    const abort = () => controller.abort("aborted"); signal?.addEventListener("abort", abort, { once: true });
    let timer = setTimeout(() => controller.abort("deadline_exceeded"), timeout);
    let phase: "claim" | "credential" | "session" = "claim";
    let claim: ProtectedMailReadDispatch | undefined, session: Awaited<ReturnType<typeof runProtectedMailImapSession>> | undefined;
    let custody: ProtectedMailIngestionCustody | undefined;
    let reason: StopReason | undefined;
    try {
      const fetchImpl = authority.fetchImpl ?? fetch;
      const claimAuthority = { ...authority, timeoutMs: Math.min(authority.timeoutMs ?? 15000, timeout),
        fetchImpl: ((input, init) => fetchImpl(input, { ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal })) as typeof fetch };
      const admission = await bounded(beginProtectedMailReadDispatch(claimAuthority, readId), controller.signal);
      if (admission.kind === "denied") return admission;
      if (admission.kind === "unknown") return Object.freeze({ kind: "unknown", reason: "claim_outcome_unknown" });
      claim = admission.value; phase = "credential";
      const binding = bindingOf(claim);
      if (Date.now() < binding.notBeforeMs || Date.now() >= binding.expiresAtMs) throw new Stop("read_expired");
      if (controller.signal.aborted) throw new Stop(signalReason(controller.signal));
      if (capture && Date.now() >= deadlineAtMs) throw new Stop("deadline_exceeded");
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(Date.now() >= binding.expiresAtMs ? "read_expired" : "deadline_exceeded"),
        Math.max(1, Math.min(deadlineAtMs, binding.expiresAtMs) - Date.now()));
      let resolved: unknown;
      try { resolved = await bounded(Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Stop(signalReason(controller.signal));
        if (capture && (Date.now() >= deadlineAtMs || Date.now() >= binding.expiresAtMs)) throw new Stop("deadline_exceeded");
        return resolveCredential(binding, controller.signal);
      }), controller.signal); }
      catch (error) { if (error instanceof Stop) throw error; throw new Stop("credential_unavailable"); }
      if (resolved === undefined) throw new Stop("credential_unavailable");
      const password = exactCredential(resolved, binding);
      if (Date.now() < binding.notBeforeMs || Date.now() >= binding.expiresAtMs) throw new Stop("read_expired");
      if (controller.signal.aborted || Date.now() >= deadlineAtMs) throw new Stop(controller.signal.aborted ? signalReason(controller.signal) : "deadline_exceeded");
      phase = "session";
      const sessionOptions = { plan: claim.plan, password, signal: controller.signal, deadlineAtMs, ca, lookup };
      if (capture) {
        const pending = runProtectedMailImapIngestionSession(sessionOptions);
        let adopted = false;
        try {
          const result = await bounded(pending, controller.signal);
          session = result.session; custody = result.custody; adopted = true;
        } finally {
          // Even a losing late completion cannot retain an undisclosed batch.
          if (!adopted) void pending.then(result => result.custody.discard(), () => {});
        }
      } else session = await bounded(runProtectedMailImapSession(sessionOptions), controller.signal);
    } catch (error) {
      if (!claim) return Object.freeze({ kind: "unknown", reason: "claim_outcome_unknown" });
      reason = error instanceof Stop || error instanceof ProtectedMailImapError ? error.reason : "executor_failure";
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort("aborted");
    }
    if (capture && session && custody) return Object.freeze({ kind: "captured", claim: claim!, custody });
    // Choose once, before reporting. A lost reporting reply never substitutes
    // another outcome, starts a second session, or refunds the reservation.
    const outcome: ProtectedMailReadOutcome = session ? "ReadReported" : phase === "session"
      && ["transport_closed", "tls_failure", "aborted", "deadline_exceeded", "read_expired", "executor_failure"].includes(reason ?? "executor_failure") ? "Unknown" : "Failed";
    const eventNonce = randomBytes(32).toString("hex");
    const report = await finishProtectedMailReadDispatch({ ...authority, timeoutMs: Math.min(authority.timeoutMs ?? 5000, 5000) }, readId, outcome, eventNonce);
    if (!session) return Object.freeze({ kind: "stopped", readId, reason: reason ?? "executor_failure", report });
    return Object.freeze({ kind: "completed", readId, planDigest: claim!.planDigest, uidValidity: claim!.plan.selection.selection.uidValidity,
      messages: session.messages, bodyBytes: session.bodyBytes, report });
  };
}

export function createProtectedMailReadExecutor(options: ProtectedMailReadExecutorOptions):
  (readId: string, signal?: AbortSignal) => Promise<ProtectedMailReadExecutionResult> {
  return createExecutor(options, false);
}

/** Fixed private continuation, no caller-selected collection/report option.
 * Only the dormant ingestion composition consumes this function. */
export function createProtectedMailIngestionRead(options: ProtectedMailReadExecutorOptions):
  (readId: string, signal?: AbortSignal) => Promise<ProtectedMailIngestionReadResult> {
  return createExecutor(options, true);
}
