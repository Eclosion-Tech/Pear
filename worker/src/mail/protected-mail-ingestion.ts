/** One bounded attempt to commit an independently owner-approved prepared-text
 * batch. Host authority configuration must never come from email/model output.
 * This is not an IMAP client, sanitizer, scheduler or production activation. */
import { createHash } from "node:crypto";
import { parseMailIngestionEntries, type MailIngestionEntry } from "../../../packages/sentinel/src/index.js";
import type { ProtectedInferenceProcedureOptions } from "./protected-inference-claim.js";

export type ProtectedMailIngestionOptions = ProtectedInferenceProcedureOptions;
const denials = [
  "protected_mail_ingestion_invalid_request", "protected_mail_ingestion_inconsistent",
  "protected_mail_ingestion_owner_required", "protected_mail_ingestion_service_required",
  "protected_mail_ingestion_event_conflict", "protected_mail_ingestion_stale",
  "protected_mail_ingestion_limit_exceeded",
] as const;
export interface ProtectedMailIngestionReceipt {
  readonly readId: string;
  readonly selectionId: string;
  readonly cursorId: string;
  readonly cursorGeneration: string;
  readonly uidValidity: string;
  readonly lastUid: number;
  readonly importedMessages: number;
  readonly heldMessages: number;
  readonly envelopeBytes: number;
  readonly receiptDigest: string;
}
export type ProtectedMailIngestionResult =
  | { readonly kind: "ok"; readonly value: ProtectedMailIngestionReceipt }
  | { readonly kind: "denied"; readonly reason: typeof denials[number] | "invalid_request" }
  | { readonly kind: "unknown"; readonly reason: "procedure_outcome_unknown" };
const MAX_BYTES = 2 * 1024 * 1024, MAX_RESPONSE = 4096;
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const safe = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const tuple = (v: unknown, size: number): v is unknown[] => Array.isArray(v) && v.length === size;
const invalid = (): ProtectedMailIngestionResult => Object.freeze({ kind: "denied", reason: "invalid_request" });

/** Positional HTTP JSON for the pinned module. No raw MIME, policy, destination
 * override, caller-selected source ID, body callback or arbitrary held text. */
function encode(entries: readonly MailIngestionEntry[]): unknown[] {
  return entries.map(entry => entry.kind === "imported"
    ? [0, [entry.message.folder, entry.message.uidValidity, entry.uid, [entry.message.direction === "received" ? 0 : 1, []],
      entry.message.messageDate, entry.message.from, entry.message.to, entry.message.cc, entry.message.subject,
      entry.message.body, entry.message.note, entry.message.sanitizationVersion]]
    : [1, [entry.uid, [["authentication_material", "sensitive_content", "unsupported_content"].indexOf(entry.reason), []]]]);
}
function readIdentity(selectionId: string): string {
  const hash = createHash("sha256");
  for (const field of ["pear-mail-read-grant-v1", selectionId]) {
    const bytes = Buffer.from(field), length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}
function decode(value: unknown, readId: string, entries: readonly MailIngestionEntry[]): ProtectedMailIngestionReceipt | undefined {
  if (!tuple(value, 10)) return;
  const [id, selectionId, cursorId, generation, validity, lastUid, imported, held, bytes, digest] = value;
  if (id !== readId || !hex(selectionId) || readIdentity(selectionId) !== readId
    || typeof cursorId !== "string" || !/^mail-connector-cursor:[a-f0-9]{64}$/.test(cursorId)
    // Pinned HTTP JSON uses numeric u64. Never round an unsafe generation.
    || !safe(generation, 2) || typeof validity !== "string" || !/^[1-9][0-9]{0,9}$/.test(validity)
    || !safe(Number(validity), 1, 4294967295) || String(Number(validity)) !== validity
    || entries.some(entry => entry.kind === "imported" && entry.message.uidValidity !== validity)
    || lastUid !== entries[entries.length - 1].uid
    || !safe(imported, 0, 8) || !safe(held, 0, 8) || imported + held !== entries.length
    || imported !== entries.filter(entry => entry.kind === "imported").length
    || !safe(bytes, 1, MAX_BYTES) || !hex(digest)) return;
  return Object.freeze({ readId, selectionId, cursorId, cursorGeneration: String(generation), uidValidity: validity,
    lastUid, importedMessages: imported, heldMessages: held, envelopeBytes: bytes, receiptDigest: digest });
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
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** A lost reply may follow atomic storage/cursor/read completion. Never resend
 * automatically. An explicit identical retry can recover metadata only. */
export async function acceptProtectedMailIngestion(options: ProtectedMailIngestionOptions,
  readId: string, eventNonce: string, entries: unknown): Promise<ProtectedMailIngestionResult> {
  const copied = parseMailIngestionEntries(entries);
  if (!hex(readId) || !hex(eventNonce) || !copied) return invalid();
  let target: string, token: string, body: string, timeout: number, fetchImpl: typeof fetch;
  try {
    const url = new URL(options.baseUrl);
    if (url.origin !== options.baseUrl || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.dbName) || !/^[\x21-\x7e]{1,16384}$/.test(options.token)) return invalid();
    timeout = options.timeoutMs ?? 15000;
    if (!safe(timeout, 1, 60000)) return invalid();
    target = `${url.origin}/v1/database/${encodeURIComponent(options.dbName)}/call/accept_protected_mail_ingestion`;
    token = options.token; body = JSON.stringify([readId, eventNonce, encode(copied)]); fetchImpl = options.fetchImpl ?? fetch;
    if (Buffer.byteLength(body, "utf8") > MAX_BYTES) return invalid();
  } catch { return invalid(); }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = (async (): Promise<ProtectedMailIngestionResult> => {
      const response = await fetchImpl(target, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body, signal: controller.signal });
      const result = await boundedJson(response, controller.signal);
      if (!tuple(result, 2)) throw Error("invalid_response");
      if (result[0] === 1 && typeof result[1] === "string" && (denials as readonly string[]).includes(result[1])) {
        return Object.freeze({ kind: "denied", reason: result[1] as typeof denials[number] });
      }
      if (result[0] !== 0) throw Error("invalid_response");
      const value = decode(result[1], readId, copied);
      if (!value) throw Error("invalid_response");
      return Object.freeze({ kind: "ok", value });
    })();
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("procedure_timeout")); }, timeout); });
    return await Promise.race([completed, expired]);
  } catch { return Object.freeze({ kind: "unknown", reason: "procedure_outcome_unknown" }); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
