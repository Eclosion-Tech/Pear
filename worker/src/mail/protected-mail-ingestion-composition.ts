/** Dormant trusted contiguous composition. No tool/runner/route imports this.
 * The configured review hook sees prepared text, never raw MIME or credentials.
 * Hook success is not approval: existing exact owner c4 state gates acceptance. */
import { randomBytes } from "node:crypto";
import { prepareMailIngestion, type MailIngestionPayloadV1 } from "../../../packages/sentinel/src/index.js";
import { createProtectedMailIngestionRead, type ProtectedMailIngestionReadResult,
  type ProtectedMailReadExecutorOptions } from "./protected-mail-read-executor.js";
import { acceptProtectedMailIngestion, type ProtectedMailIngestionReceipt } from "./protected-mail-ingestion.js";
import { finishProtectedMailReadDispatch } from "./protected-mail-read-report.js";
import { ProtectedMailPreparationError } from "./protected-mail-ingestion-custody.js";
import type { ProtectedMailReadReport } from "./protected-mail-read-types.js";

export interface ProtectedMailPreparedIngestionReview {
  readonly readId: string;
  readonly payload: MailIngestionPayloadV1;
  readonly canonical: string;
  readonly payloadDigest: string;
  readonly payloadBytes: number;
}
export interface ProtectedMailIngestionCompositionOptions extends ProtectedMailReadExecutorOptions {
  /** Trusted host fixture only. Must observe cancellation before its own owner
   * request. The composition cannot retract an external approval already sent. */
  readonly reviewPrepared: (review: ProtectedMailPreparedIngestionReview, signal: AbortSignal) => Promise<void>;
}
type PreReadResult = Exclude<ProtectedMailIngestionReadResult, { kind: "captured" }>;
type PreparationStop = "mime_failure" | "mime_limit" | "mime_timeout" | "aborted" | "read_expired" | "review_failed" | "preparation_failed";
export type ProtectedMailIngestionCompositionResult = PreReadResult
  | { readonly kind: "stopped"; readonly readId: string; readonly reason: PreparationStop; readonly report: ProtectedMailReadReport }
  | { readonly kind: "completed"; readonly readId: string; readonly receipt: ProtectedMailIngestionReceipt }
  | { readonly kind: "accept_denied"; readonly readId: string; readonly eventNonce: string; readonly reason: string }
  | { readonly kind: "accept_unknown"; readonly readId: string; readonly eventNonce: string };

function own(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields), result: Record<string, unknown> = {};
  if (keys.some(key => typeof key !== "string" || !required.includes(key) && !optional.includes(key))) return;
  for (const key of required) if (!Object.hasOwn(fields, key)) return;
  for (const key of keys as string[]) {
    const field = fields[key]; if (!("value" in field) || !field.enumerable) return;
    result[key] = field.value;
  }
  return result;
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new ProtectedMailPreparationError("aborted"));
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

/** Invocation accepts only an exact read ID and cancellation, never data,
 * source IDs, a raw callback, parser options or a suppress-report flag. */
export function createProtectedMailIngestionComposition(options: ProtectedMailIngestionCompositionOptions):
  (readId: string, signal?: AbortSignal) => Promise<ProtectedMailIngestionCompositionResult> {
  let host: ProtectedMailReadExecutorOptions, reviewPrepared: ProtectedMailIngestionCompositionOptions["reviewPrepared"], timeout: number;
  try {
    const row = own(options, ["authority", "resolveCredential", "reviewPrepared"], ["timeoutMs", "ca", "lookup"]);
    const authority = row && own(row.authority, ["baseUrl", "dbName", "token"], ["fetchImpl", "timeoutMs"]);
    if (!row || !authority || typeof row.reviewPrepared !== "function" || typeof row.resolveCredential !== "function") throw Error();
    timeout = row.timeoutMs === undefined ? 20000 : row.timeoutMs as number;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) throw Error();
    reviewPrepared = row.reviewPrepared as typeof reviewPrepared;
    host = Object.freeze({ authority: Object.freeze(authority) as unknown as ProtectedMailReadExecutorOptions["authority"],
      resolveCredential: row.resolveCredential as ProtectedMailReadExecutorOptions["resolveCredential"], timeoutMs: timeout,
      ...(row.ca === undefined ? {} : { ca: row.ca as string }), ...(row.lookup === undefined ? {} : { lookup: row.lookup as NonNullable<ProtectedMailReadExecutorOptions["lookup"]> }) });
  } catch { return async () => Object.freeze({ kind: "denied", reason: "invalid_request" }); }
  const read = createProtectedMailIngestionRead(host);
  return async (readId, signal) => {
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Object.freeze({ kind: "denied", reason: "invalid_request" });
    if (signal?.aborted) return Object.freeze({ kind: "denied", reason: "aborted" });
    const controller = new AbortController(), deadlineAtMs = Date.now() + timeout;
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
    let timer = setTimeout(abort, timeout), captured: Extract<ProtectedMailIngestionReadResult, { kind: "captured" }> | undefined;
    let deadline = deadlineAtMs, attempted = false, eventNonce: string | undefined, reason: PreparationStop = "preparation_failed";
    const guard = () => { if (controller.signal.aborted) throw new ProtectedMailPreparationError("aborted");
      if (Date.now() >= deadline) throw new ProtectedMailPreparationError("read_expired"); };
    try {
      const result = await read(readId, controller.signal);
      if (result.kind !== "captured") return result;
      captured = result;
      deadline = Math.min(deadlineAtMs, result.claim.plan.selection.expiresAtMs);
      clearTimeout(timer); timer = setTimeout(abort, Math.max(1, deadline - Date.now())); guard();
      const entries = await result.custody.prepare(controller.signal, deadline); guard();
      // Custody has zeroed retained raw buffers and terminated every parser
      // before this exact prepared-text review object can leave the module.
      const prepared = await prepareMailIngestion({ formatVersion: 1, kind: "mail.ingestion.batch", read: result.claim.plan, entries }); guard();
      if (prepared.status !== "prepared") throw Error();
      const frozen = prepared.ingestion;
      const review = Object.freeze({ readId, payload: frozen.payload, canonical: frozen.canonical,
        payloadDigest: frozen.payloadDigest, payloadBytes: frozen.payloadBytes });
      reason = "review_failed";
      await bounded(Promise.resolve().then(() => { guard(); return reviewPrepared(review, controller.signal); }), controller.signal); guard();
      eventNonce = randomBytes(32).toString("hex"); guard();
      const fetchImpl = host.authority.fetchImpl ?? fetch;
      const accepted = await bounded(acceptProtectedMailIngestion({ ...host.authority,
        fetchImpl: ((input, init) => {
          // Entry copying/serialization can consume time while timers are
          // delayed. Check at the actual send boundary, then choose once.
          guard(); attempted = true;
          return fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
        }) as typeof fetch },
      readId, eventNonce, frozen.payload.entries), controller.signal);
      // The fixed helper can reject validation or a send-boundary guard before
      // any request. Only that no-send case may declare a terminal failure.
      if (!attempted) { guard(); throw Error(); }
      if (accepted.kind === "ok") return Object.freeze({ kind: "completed", readId, receipt: accepted.value });
      if (accepted.kind === "denied") return Object.freeze({ kind: "accept_denied", readId, eventNonce, reason: accepted.reason });
      return Object.freeze({ kind: "accept_unknown", readId, eventNonce });
    } catch (error) {
      // Any send may already have committed. Neither denial nor lost reply
      // permits a competing finish, another accept or a replacement nonce.
      if (attempted) return Object.freeze({ kind: "accept_unknown", readId, eventNonce: eventNonce! });
      if (!captured) return Object.freeze({ kind: "unknown", reason: "claim_outcome_unknown" });
      if (error instanceof ProtectedMailPreparationError) reason = error.reason;
      const report = await finishProtectedMailReadDispatch({ ...host.authority, timeoutMs: Math.min(host.authority.timeoutMs ?? 5000, 5000) },
        readId, "Failed", randomBytes(32).toString("hex"));
      return Object.freeze({ kind: "stopped", readId, reason, report });
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); captured?.custody.discard();
    }
  };
}
