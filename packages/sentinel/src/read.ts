import { canonicalConnectorSelection } from "./connector.js";
import type { ConnectorSelectionV1 } from "./connector.js";

/** A fixed declaration of a future IMAP read, not executable commands, mailbox
 * evidence, credential access or permission to import/acknowledge content. */
export interface ConnectorReadV1 {
  readonly formatVersion: 1;
  readonly kind: "mail.connector.read";
  readonly limits: { readonly maxMessageBytes: number; readonly maxTotalBytes: number };
  readonly profile: "imap.uid-body-peek.v1";
  readonly readId: string;
  readonly reservation: { readonly bodyBytes: number; readonly messageSlots: number; readonly operations: 1 };
  readonly selection: ConnectorSelectionV1;
  readonly selectionDigest: string;
}
export interface FrozenConnectorRead {
  readonly manifest: ConnectorReadV1;
  readonly canonical: string;
  readonly planBytes: number;
  readonly planDigest: string;
  readonly copyPayload: () => Uint8Array;
}
export type ConnectorReadPreparation =
  | { readonly status: "prepared"; readonly read: FrozenConnectorRead }
  | { readonly status: "denied"; readonly reason: "invalid_connector_read" | "connector_read_preparation_unavailable" };

const encoder = new TextEncoder();
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return;
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return;
  const result: Record<string, unknown> = {};
  for (const key of keys) { const descriptor = descriptors[key]; if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return; result[key] = descriptor.value; }
  return result;
}
function manifest(value: unknown): ConnectorReadV1 | undefined {
  const data = record(value, ["formatVersion", "kind", "limits", "profile", "readId", "reservation", "selection", "selectionDigest"]);
  if (!data || data.formatVersion !== 1 || data.kind !== "mail.connector.read" || data.profile !== "imap.uid-body-peek.v1" || !hex(data.readId) || !hex(data.selectionDigest)) return;
  const selectionCanonical = canonicalConnectorSelection(data.selection); if (!selectionCanonical) return;
  const selection = JSON.parse(selectionCanonical) as ConnectorSelectionV1;
  if (selection.selection.mode !== "stored_batch") return;
  const limits = record(data.limits, ["maxMessageBytes", "maxTotalBytes"]), reservation = record(data.reservation, ["bodyBytes", "messageSlots", "operations"]);
  if (!limits || !integer(limits.maxMessageBytes, 1, 524288) || !integer(limits.maxTotalBytes, 1, 2097152)
    || limits.maxMessageBytes > limits.maxTotalBytes || limits.maxTotalBytes > selection.selection.uids.length * limits.maxMessageBytes
    || !reservation || reservation.operations !== 1 || reservation.messageSlots !== selection.selection.uids.length || reservation.bodyBytes !== limits.maxTotalBytes) return;
  return { formatVersion: 1, kind: "mail.connector.read", limits: { maxMessageBytes: limits.maxMessageBytes, maxTotalBytes: limits.maxTotalBytes },
    profile: "imap.uid-body-peek.v1", readId: data.readId, reservation: { bodyBytes: limits.maxTotalBytes, messageSlots: selection.selection.uids.length, operations: 1 },
    selection, selectionDigest: data.selectionDigest };
}
/** Closed structural serialization only. Use full preparation to verify the
 * embedded selection digest and derived read identity. Neither authenticates
 * current owner, connector, clock, cursor or permission to release the plan. */
export function canonicalConnectorRead(value: unknown): string | undefined {
  try { const result = manifest(value); if (!result) return; const canonical = JSON.stringify(result); return encoder.encode(canonical).length <= 12288 ? canonical : undefined; }
  catch { return undefined; }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function identityBytes(selectionId: string): ArrayBuffer {
  const fields = ["pear-mail-read-grant-v1", selectionId].map(field => encoder.encode(field));
  const held = new ArrayBuffer(fields.reduce((sum, field) => sum + 8 + field.length, 0)), bytes = new Uint8Array(held), view = new DataView(held);
  let offset = 0;
  for (const field of fields) { view.setBigUint64(offset, BigInt(field.length)); offset += 8; bytes.set(field, offset); offset += field.length; }
  return held;
}
const hexadecimal = (value: ArrayBuffer) => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("");
/** Freeze exact bytes before crypto yields, then verify both nested bindings.
 * Raw-MIME literal caps are reservations, not measurements of actual network
 * bytes, S1 records, sanitization, storage or successful message retrieval. */
export async function prepareConnectorRead(value: unknown): Promise<ConnectorReadPreparation> {
  try {
    const canonical = canonicalConnectorRead(value); if (!canonical) return { status: "denied", reason: "invalid_connector_read" };
    const copied = encoder.encode(canonical), held = new ArrayBuffer(copied.length); new Uint8Array(held).set(copied);
    const frozen = freeze(JSON.parse(canonical) as ConnectorReadV1);
    const selectionBytes = encoder.encode(JSON.stringify(frozen.selection)), selectionHeld = new ArrayBuffer(selectionBytes.length); new Uint8Array(selectionHeld).set(selectionBytes);
    const idHeld = identityBytes(frozen.selection.selectionId);
    const [selectionDigest, readId, planDigest] = await Promise.all([selectionHeld, idHeld, held].map(bytes => globalThis.crypto.subtle.digest("SHA-256", bytes).then(hexadecimal)));
    if (selectionDigest !== frozen.selectionDigest || readId !== frozen.readId) return { status: "denied", reason: "invalid_connector_read" };
    return Object.freeze({ status: "prepared", read: Object.freeze({ manifest: frozen, canonical, planBytes: held.byteLength, planDigest, copyPayload: () => new Uint8Array(held.slice(0)) }) });
  } catch { return { status: "denied", reason: "connector_read_preparation_unavailable" }; }
}
