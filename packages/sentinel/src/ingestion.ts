/** Exact prepared-text storage commitments. No MIME parser, sanitization
 * certification, mailbox evidence, disclosure grant or execution capability. */
import { canonicalConnectorRead, prepareConnectorRead, type ConnectorReadV1 } from "./read.js";

export interface ProtectedMailPreparedMessage {
  readonly folder: string;
  readonly uidValidity: string;
  readonly uid: number;
  readonly direction: "received" | "sent";
  readonly messageDate: string;
  readonly from: string;
  readonly to: string;
  readonly cc: string;
  readonly subject: string;
  readonly body: string;
  readonly note: string;
  readonly sanitizationVersion: string;
}
export type MailIngestionHeldReason = "authentication_material" | "sensitive_content" | "unsupported_content";
export type MailIngestionEntry =
  | { readonly uid: number; readonly kind: "imported"; readonly message: ProtectedMailPreparedMessage }
  | { readonly uid: number; readonly kind: "held"; readonly reason: MailIngestionHeldReason };
export interface MailIngestionPayloadV1 {
  readonly formatVersion: 1;
  readonly kind: "mail.ingestion.batch";
  readonly read: ConnectorReadV1;
  readonly entries: readonly MailIngestionEntry[];
}
export interface FrozenMailIngestion {
  readonly payload: MailIngestionPayloadV1;
  readonly canonical: string;
  readonly payloadBytes: number;
  readonly payloadDigest: string;
  readonly copyPayload: () => Uint8Array;
}
export type MailIngestionPreparation =
  | { readonly status: "prepared"; readonly ingestion: FrozenMailIngestion }
  | { readonly status: "denied"; readonly reason: "invalid_mail_ingestion" | "mail_ingestion_preparation_unavailable" };

const encoder = new TextEncoder(), MAX_BYTES = 2 * 1024 * 1024;
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return;
  const fields = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(fields);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return;
  const copied: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = fields[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return;
    copied[key] = descriptor.value;
  }
  return copied;
}
function scalar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function text(value: unknown, max: number, multiline = false): value is string {
  return typeof value === "string" && value.length <= max && scalar(value)
    && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u).test(value)
    && encoder.encode(value).length <= max;
}
function message(value: unknown): ProtectedMailPreparedMessage | undefined {
  const data = record(value, ["folder", "uidValidity", "uid", "direction", "messageDate", "from", "to", "cc", "subject", "body", "note", "sanitizationVersion"]);
  if (!data || !text(data.folder, 512) || !data.folder || !integer(data.uid, 1, 4294967295)
    || typeof data.uidValidity !== "string" || !/^[1-9][0-9]{0,19}$/.test(data.uidValidity)
    || BigInt(data.uidValidity) > 18446744073709551615n
    || data.direction !== "received" && data.direction !== "sent"
    || !text(data.messageDate, 64) || !text(data.from, 2048) || !text(data.to, 2048) || !text(data.cc, 2048)
    || !text(data.subject, 1024) || !text(data.body, 160000, true) || !text(data.note, 2048, true)
    || typeof data.sanitizationVersion !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(data.sanitizationVersion)) return;
  return Object.freeze({ body: data.body, cc: data.cc, direction: data.direction, folder: data.folder, from: data.from,
    messageDate: data.messageDate, note: data.note, sanitizationVersion: data.sanitizationVersion, subject: data.subject,
    to: data.to, uid: data.uid, uidValidity: data.uidValidity });
}
/** Copy closed own-data entries synchronously, without invoking getters. Held
 * entries have no text fields and never represent absent or incomplete mail. */
export function parseMailIngestionEntries(value: unknown): readonly MailIngestionEntry[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return;
    const fields = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
    const length = fields.length;
    if (!length || !("value" in length) || !integer(length.value, 1, 8)
      || Reflect.ownKeys(fields).length !== length.value + 1) return;
    const entries: MailIngestionEntry[] = [];
    for (let i = 0; i < length.value; i++) {
      const field = fields[String(i)];
      if (!field || !("value" in field) || !field.enumerable) return;
      // Examine kind through its descriptor, never through the original object.
      const source: unknown = field.value;
      if (source === null || typeof source !== "object") return;
      const kind = Object.getOwnPropertyDescriptor(source, "kind");
      if (!kind || !("value" in kind) || !kind.enumerable) return;
      const data = record(source, kind.value === "imported" ? ["uid", "kind", "message"] : ["uid", "kind", "reason"]);
      if (!data || !integer(data.uid, 1, 4294967295) || i > 0 && data.uid !== entries[i - 1].uid + 1) return;
      if (data.kind === "imported") {
        const copied = message(data.message);
        if (!copied || copied.uid !== data.uid) return;
        entries.push(Object.freeze({ kind: "imported", message: copied, uid: data.uid }));
      } else if (data.kind === "held" && (data.reason === "authentication_material" || data.reason === "sensitive_content" || data.reason === "unsupported_content")) {
        entries.push(Object.freeze({ kind: "held", reason: data.reason, uid: data.uid }));
      } else return;
    }
    return Object.freeze(entries);
  } catch { return undefined; }
}
/** Structural serialization only. Full preparation also verifies the embedded
 * read/selection commitments. Neither supplies current storage authority. */
export function canonicalMailIngestionPayload(value: unknown): string | undefined {
  try {
    const data = record(value, ["formatVersion", "kind", "read", "entries"]);
    if (!data || data.formatVersion !== 1 || data.kind !== "mail.ingestion.batch") return;
    const readCanonical = canonicalConnectorRead(data.read), entries = parseMailIngestionEntries(data.entries);
    if (!readCanonical || !entries) return;
    const read = JSON.parse(readCanonical) as ConnectorReadV1, selection = read.selection;
    if (entries.length !== selection.selection.uids.length || entries.some((entry, index) =>
      entry.uid !== selection.selection.uids[index] || entry.kind === "imported" &&
      (entry.message.folder !== selection.mailbox.folder || entry.message.direction !== selection.mailbox.direction
        || entry.message.uidValidity !== selection.selection.uidValidity))) return;
    const canonical = JSON.stringify({ entries, formatVersion: 1, kind: "mail.ingestion.batch", read });
    return encoder.encode(canonical).length <= MAX_BYTES ? canonical : undefined;
  } catch { return undefined; }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
/** Freeze all actual bytes before crypto yields. Preparation is not approval,
 * a sanitizer, a claim of mailbox origin or a permission to import/advance. */
export async function prepareMailIngestion(value: unknown): Promise<MailIngestionPreparation> {
  try {
    const canonical = canonicalMailIngestionPayload(value);
    if (!canonical) return Object.freeze({ status: "denied", reason: "invalid_mail_ingestion" });
    const copied = encoder.encode(canonical), held = new ArrayBuffer(copied.length); new Uint8Array(held).set(copied);
    const payload = freeze(JSON.parse(canonical) as MailIngestionPayloadV1);
    const read = await prepareConnectorRead(payload.read);
    if (read.status !== "prepared") return Object.freeze({ status: "denied", reason: "invalid_mail_ingestion" });
    const digest = await globalThis.crypto.subtle.digest("SHA-256", held);
    const payloadDigest = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    return Object.freeze({ status: "prepared", ingestion: Object.freeze({ payload, canonical, payloadBytes: held.byteLength, payloadDigest,
      copyPayload: () => new Uint8Array(held.slice(0)) }) });
  } catch { return Object.freeze({ status: "denied", reason: "mail_ingestion_preparation_unavailable" }); }
}
