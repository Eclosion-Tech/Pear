/** One attempt to release an owner-authorized read-plan declaration. This calls
 * only the authority service. It never connects to IMAP or a credential vault.
 * A lost reply may follow committed consumption; never automatically retry. */
import { prepareConnectorSparseRead, type ConnectorSparseReadV1 } from "../../../packages/sentinel/src/index.js";
import type { ProtectedInferenceProcedureOptions } from "./protected-inference-claim.js";
import { sparseReadAuthority } from "./protected-mail-sparse-read-types.js";

export type ProtectedMailSparseReadProcedureOptions = ProtectedInferenceProcedureOptions;
const denials = [
  "protected_mail_sparse_read_invalid_request", "protected_mail_sparse_read_inconsistent",
  "protected_mail_sparse_read_owner_required", "protected_mail_sparse_read_service_required",
  "protected_mail_sparse_read_event_conflict", "protected_mail_sparse_read_stale",
  "protected_mail_sparse_read_consumed", "protected_mail_sparse_read_limit_exceeded",
] as const;
export interface ProtectedMailSparseReadDispatch {
  readonly readId: string;
  readonly planDigest: string;
  readonly planBytes: number;
  readonly canonical: string;
  readonly plan: ConnectorSparseReadV1;
}
export type ProtectedMailSparseReadDispatchResult =
  | { readonly kind: "ok"; readonly value: ProtectedMailSparseReadDispatch }
  | { readonly kind: "denied"; readonly reason: typeof denials[number] | "invalid_request" }
  | { readonly kind: "unknown"; readonly reason: "procedure_outcome_unknown" };

const MAX_RESPONSE = 16 * 1024, MAX_PLAN = 8192;
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const safe = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const tuple = (value: unknown, size: number): value is unknown[] => Array.isArray(value) && value.length === size;
const invalid = (): ProtectedMailSparseReadDispatchResult => Object.freeze({ kind: "denied", reason: "invalid_request" });

async function decode(value: unknown, expectedId: string): Promise<ProtectedMailSparseReadDispatch | undefined> {
  if (!tuple(value, 4)) return;
  const [readId, planDigest, planBytes, canonical] = value;
  if (readId !== expectedId || !hex(planDigest) || !safe(planBytes, 1, MAX_PLAN)
    || typeof canonical !== "string" || canonical.length > MAX_PLAN || Buffer.byteLength(canonical, "utf8") !== planBytes) return;
  const prepared = await prepareConnectorSparseRead(JSON.parse(canonical));
  if (prepared.status !== "prepared" || prepared.read.canonical !== canonical || prepared.read.manifest.readId !== expectedId
    || prepared.read.planDigest !== planDigest || prepared.read.planBytes !== planBytes) return;
  // This verifies the complete declared plan, never future message bytes,
  // actual IMAP behavior, physical isolation, or a credential's permissions.
  return Object.freeze({ readId, planDigest, planBytes, canonical, plan: prepared.read.manifest });
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (response.status !== 200 || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")
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
export async function beginProtectedMailSparseReadDispatch(options: ProtectedMailSparseReadProcedureOptions,
  readId: string): Promise<ProtectedMailSparseReadDispatchResult> {
  if (!hex(readId)) return invalid();
  const configured = sparseReadAuthority(options, false); if (!configured) return invalid();
  const { target, token, timeout, fetchImpl } = configured;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = (async (): Promise<ProtectedMailSparseReadDispatchResult> => {
      const response = await fetchImpl(target, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify([readId]), signal: controller.signal });
      const result = await boundedJson(response, controller.signal);
      if (!tuple(result, 2)) throw Error("invalid_response");
      if (result[0] === 1 && typeof result[1] === "string" && (denials as readonly string[]).includes(result[1])) {
        return Object.freeze({ kind: "denied", reason: result[1] as typeof denials[number] });
      }
      if (result[0] !== 0) throw Error("invalid_response");
      const value = await decode(result[1], readId);
      if (!value) throw Error("invalid_response");
      return Object.freeze({ kind: "ok", value });
    })();
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("procedure_timeout")); }, timeout); });
    return await Promise.race([completed, expired]);
  } catch { return Object.freeze({ kind: "unknown", reason: "procedure_outcome_unknown" }); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
