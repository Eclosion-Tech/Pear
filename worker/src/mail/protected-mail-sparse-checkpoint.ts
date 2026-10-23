/** One-attempt local checkpoint of a reviewed observation and already-stored
 * sources. Host authority options must never come from mail or model output. */
import { createHash } from "node:crypto";
import type { ProtectedInferenceProcedureOptions } from "./protected-inference-claim.js";

export type ProtectedMailSparseCheckpointOptions = ProtectedInferenceProcedureOptions;
const denials = [
  "protected_mail_sparse_checkpoint_invalid_request", "protected_mail_sparse_checkpoint_inconsistent",
  "protected_mail_sparse_checkpoint_owner_required", "protected_mail_sparse_checkpoint_service_required",
  "protected_mail_sparse_checkpoint_event_conflict", "protected_mail_sparse_checkpoint_stale",
  "protected_mail_sparse_checkpoint_source_required", "protected_mail_sparse_checkpoint_limit_exceeded",
] as const;
export interface ProtectedMailSparseCheckpointAcknowledgment {
  readonly checkpointId: string;
  readonly observationId: string;
  readonly cursorId: string;
  readonly cursorGeneration: string;
  readonly uidValidity: string;
  readonly lastUid: number;
  readonly acknowledgedMessages: number;
  readonly observedAbsentMessages: number;
  readonly acknowledgedBytes: number;
  readonly receiptDigest: string;
}
export type ProtectedMailSparseCheckpointAckResult =
  | { readonly kind: "ok"; readonly value: ProtectedMailSparseCheckpointAcknowledgment }
  | { readonly kind: "denied"; readonly reason: typeof denials[number] | "invalid_request" }
  | { readonly kind: "unknown"; readonly reason: "procedure_outcome_unknown" };

const MAX_RESPONSE = 4096, MAX_UID = 0xffff_ffff, MAX_BYTES = 2 * 1024 * 1024;
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const safe = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const tuple = (v: unknown, size: number): v is unknown[] => Array.isArray(v) && v.length === size;
const invalid = (): ProtectedMailSparseCheckpointAckResult => Object.freeze({ kind: "denied", reason: "invalid_request" });
function checkpointIdentity(observationId: string): string {
  const hash = createHash("sha256");
  for (const field of ["pear-mail-sparse-checkpoint-v1", observationId]) {
    const bytes = Buffer.from(field, "utf8"), length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length); hash.update(bytes);
  }
  return hash.digest("hex");
}
function decode(value: unknown, checkpointId: string): ProtectedMailSparseCheckpointAcknowledgment | undefined {
  if (!tuple(value, 10)) return;
  const [id, observationId, cursorId, generation, validity, lastUid, messages, absent, bytes, digest] = value;
  if (id !== checkpointId || !hex(observationId) || checkpointIdentity(observationId) !== checkpointId
    || typeof cursorId !== "string" || !/^mail-connector-cursor:[a-f0-9]{64}$/.test(cursorId)
    // HTTP JSON u64 numbers are deliberately restricted to exact JS integers.
    || !safe(generation, 2) || typeof validity !== "string" || !/^[1-9][0-9]{0,9}$/.test(validity)
    || !safe(Number(validity), 1, MAX_UID) || String(Number(validity)) !== validity
    || !safe(messages, 0, 8) || !safe(absent, 0, 8) || !safe(messages + absent, 1, 8)
    || !safe(lastUid, messages + absent, MAX_UID - 1)
    || !safe(bytes, messages === 0 ? 0 : 1, MAX_BYTES) || messages === 0 && bytes !== 0 || !hex(digest)) return;
  // These are authority metadata, not independent verification of private
  // source contents, receipt commitment or the upstream mailbox observation.
  return Object.freeze({ checkpointId, observationId, cursorId, cursorGeneration: String(generation), uidValidity: validity,
    lastUid, acknowledgedMessages: messages, observedAbsentMessages: absent, acknowledgedBytes: bytes, receiptDigest: digest });
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (!response.ok || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")
    || length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !safe(Number(length), 1, MAX_RESPONSE))) {
    void response.body?.cancel().catch(() => {}); throw Error("invalid_response");
  }
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
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

/** Lost replies remain unknown. Only an explicit identical call may recover
 * completed metadata; this helper never retries or chooses a different nonce. */
export async function acknowledgeProtectedMailSparseCheckpoint(options: ProtectedMailSparseCheckpointOptions,
  checkpointId: string, eventNonce: string): Promise<ProtectedMailSparseCheckpointAckResult> {
  if (!hex(checkpointId) || !hex(eventNonce)) return invalid();
  let target: string, token: string, body: string, timeout: number, fetchImpl: typeof fetch;
  try {
    const url = new URL(options.baseUrl);
    if (url.origin !== options.baseUrl || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.dbName) || !/^[\x21-\x7e]{1,16384}$/.test(options.token)) return invalid();
    timeout = options.timeoutMs ?? 15_000;
    if (!safe(timeout, 1, 60_000)) return invalid();
    target = `${url.origin}/v1/database/${encodeURIComponent(options.dbName)}/call/acknowledge_protected_mail_sparse_checkpoint`;
    token = options.token; body = JSON.stringify([checkpointId, eventNonce]); fetchImpl = options.fetchImpl ?? fetch;
  } catch { return invalid(); }
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = (async (): Promise<ProtectedMailSparseCheckpointAckResult> => {
      const response = await fetchImpl(target, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body, signal: controller.signal });
      const result = await boundedJson(response, controller.signal);
      if (!tuple(result, 2)) throw Error("invalid_response");
      if (result[0] === 1 && typeof result[1] === "string" && (denials as readonly string[]).includes(result[1]))
        return Object.freeze({ kind: "denied", reason: result[1] as typeof denials[number] });
      if (result[0] !== 0) throw Error("invalid_response");
      const value = decode(result[1], checkpointId); if (!value) throw Error("invalid_response");
      return Object.freeze({ kind: "ok", value });
    })();
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("procedure_timeout")); }, timeout); });
    return await Promise.race([completed, expired]);
  } catch { return Object.freeze({ kind: "unknown", reason: "procedure_outcome_unknown" }); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
