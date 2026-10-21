/** One-attempt acknowledgment of an owner-selected, already-stored mail window.
 * This helper neither reads IMAP nor imports content. Authority configuration
 * belongs to the host and must never come from a message or model proposal. */
import type { ProtectedInferenceProcedureOptions } from "./protected-inference-claim.js";

export type ProtectedConnectorProcedureOptions = ProtectedInferenceProcedureOptions;
const denials = [
  "protected_mail_connector_invalid_request", "protected_mail_connector_inconsistent",
  "protected_mail_connector_owner_required", "protected_mail_connector_service_required",
  "protected_mail_connector_event_conflict", "protected_mail_connector_stale",
  "protected_mail_connector_source_required", "protected_mail_connector_limit_exceeded",
] as const;
export interface ProtectedConnectorAcknowledgment {
  readonly selectionId: string;
  readonly cursorId: string;
  readonly cursorGeneration: string;
  readonly uidValidity: string;
  readonly lastUid: number;
  readonly acknowledgedMessages: number;
  readonly acknowledgedBytes: number;
  readonly receiptDigest: string;
}
export type ProtectedConnectorAckResult =
  | { readonly kind: "ok"; readonly value: ProtectedConnectorAcknowledgment }
  | { readonly kind: "denied"; readonly reason: typeof denials[number] | "invalid_request" }
  | { readonly kind: "unknown"; readonly reason: "procedure_outcome_unknown" };

const MAX_RESPONSE = 4096, MAX_UID = 0xffff_ffff, MAX_BYTES = 2 * 1024 * 1024;
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const safe = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const tuple = (v: unknown, size: number): v is unknown[] => Array.isArray(v) && v.length === size;
const invalid = (): ProtectedConnectorAckResult => Object.freeze({ kind: "denied", reason: "invalid_request" });

/** Copy only data properties before any await. No authority/configuration/body
 * fields or getters are accepted alongside the three source-reference fields. */
function copySources(value: unknown): ReadonlyArray<readonly [string, number, string]> | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return;
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap, length = descriptors.length;
    if (!length || !("value" in length) || !safe(length.value, 0, 8)
      || Reflect.ownKeys(descriptors).length !== length.value + 1) return;
    const result: Array<readonly [string, number, string]> = [];
    for (let i = 0; i < length.value; i++) {
      const entry = descriptors[String(i)];
      if (!entry || !("value" in entry)) return;
      const source: unknown = entry.value;
      if (!source || typeof source !== "object" || Array.isArray(source)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(source))) return;
      const fields = Object.getOwnPropertyDescriptors(source);
      if (Reflect.ownKeys(fields).length !== 3 || !["id", "revision", "digest"].every(key =>
        fields[key] && "value" in fields[key] && fields[key].enumerable)) return;
      const id: unknown = fields.id.value, revision: unknown = fields.revision.value, digest: unknown = fields.digest.value;
      if (typeof id !== "string" || id.length > 256 || !/^mail-source:[1-9][0-9]{0,19}:[a-f0-9]{64}$/.test(id)
        || revision !== "1" || !hex(digest)) return;
      result.push(Object.freeze([id, 1, digest] as const));
    }
    return Object.freeze(result);
  } catch { return; }
}
function decode(value: unknown, selectionId: string, count: number): ProtectedConnectorAcknowledgment | undefined {
  if (!tuple(value, 8)) return;
  const [id, cursorId, generation, validity, lastUid, messages, bytes, digest] = value;
  if (id !== selectionId || typeof cursorId !== "string" || !/^mail-connector-cursor:[a-f0-9]{64}$/.test(cursorId)
    // Pinned HTTP JSON represents u64 as numbers. Reject unsafe generations;
    // the SDK's bigint representation remains available for full-u64 reads.
    || !safe(generation, 1) || typeof validity !== "string" || !/^[1-9][0-9]{0,9}$/.test(validity)
    || !safe(Number(validity), 1, MAX_UID) || String(Number(validity)) !== validity
    || !safe(lastUid, 0, MAX_UID) || !safe(messages, 0, 8) || messages !== count
    || !safe(bytes, messages === 0 ? 0 : 1, MAX_BYTES) || messages === 0 && bytes !== 0 || !hex(digest)) return;
  // These are authenticated authority metadata, not independent verification
  // of private stored bodies, the receipt commitment or mailbox execution.
  return Object.freeze({ selectionId, cursorId, cursorGeneration: String(generation), uidValidity: validity,
    lastUid, acknowledgedMessages: messages, acknowledgedBytes: bytes, receiptDigest: digest });
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

/** A lost reply may follow a committed ACK. No automatic resend occurs. An
 * explicit exact retry can recover the same metadata without advancing again. */
export async function acknowledgeProtectedMailConnectorSelection(options: ProtectedConnectorProcedureOptions,
  selectionId: string, eventNonce: string, sources: unknown): Promise<ProtectedConnectorAckResult> {
  const copied = copySources(sources);
  if (!hex(selectionId) || !hex(eventNonce) || !copied) return invalid();
  let target: string, token: string, body: string, timeout: number, fetchImpl: typeof fetch;
  try {
    const url = new URL(options.baseUrl);
    if (url.origin !== options.baseUrl || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.dbName) || !/^[\x21-\x7e]{1,16384}$/.test(options.token)) return invalid();
    timeout = options.timeoutMs ?? 15_000;
    if (!safe(timeout, 1, 60_000)) return invalid();
    target = `${url.origin}/v1/database/${encodeURIComponent(options.dbName)}/call/acknowledge_protected_mail_connector_selection`;
    token = options.token; body = JSON.stringify([selectionId, eventNonce, copied]); fetchImpl = options.fetchImpl ?? fetch;
  } catch { return invalid(); }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = (async (): Promise<ProtectedConnectorAckResult> => {
      const response = await fetchImpl(target, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body, signal: controller.signal });
      const result = await boundedJson(response, controller.signal);
      if (!tuple(result, 2)) throw Error("invalid_response");
      if (result[0] === 1 && typeof result[1] === "string" && (denials as readonly string[]).includes(result[1])) {
        return Object.freeze({ kind: "denied", reason: result[1] as typeof denials[number] });
      }
      if (result[0] !== 0) throw Error("invalid_response");
      const value = decode(result[1], selectionId, copied.length);
      if (!value) throw Error("invalid_response");
      return Object.freeze({ kind: "ok", value });
    })();
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("procedure_timeout")); }, timeout); });
    return await Promise.race([completed, expired]);
  } catch { return Object.freeze({ kind: "unknown", reason: "procedure_outcome_unknown" }); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
