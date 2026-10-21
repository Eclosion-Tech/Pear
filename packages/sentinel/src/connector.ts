/** Exact body-free metadata for a reviewed connector selection. This does not
 * authorize an IMAP command, release credentials, authenticate a mailbox, or
 * prove that the referenced records were imported under read authority. */
export interface ConnectorSelectionV1 {
  readonly formatVersion: 1;
  readonly kind: "mail.connector.selection";
  readonly selectionId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly connection: { readonly id: string; readonly epoch: string; readonly snapshotDigest: string };
  readonly connector: { readonly identity: string; readonly runtimeId: string; readonly runId: string };
  readonly mailbox: { readonly host: string; readonly port: number; readonly username: string; readonly folder: string; readonly direction: "received" | "sent" };
  readonly selection: {
    readonly mode: "new_only" | "stored_batch";
    readonly uidValidity: string;
    readonly expectedCursorGeneration: string;
    readonly previousCursorDigest: string;
    readonly fromUid: number;
    readonly throughUid: number;
    readonly uids: readonly number[];
    readonly maxAcknowledgedBytes: number;
  };
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
}

/** Frozen commitment bytes, not an operation, grant or execution permit. */
export interface FrozenConnectorSelection {
  readonly manifest: ConnectorSelectionV1;
  readonly canonical: string;
  readonly manifestBytes: number;
  readonly manifestDigest: string;
  readonly copyPayload: () => Uint8Array;
}
export type ConnectorSelectionPreparation =
  | { readonly status: "prepared"; readonly selection: FrozenConnectorSelection }
  | { readonly status: "denied"; readonly reason: "invalid_connector_selection" | "connector_preparation_unavailable" };

const encoder = new TextEncoder();
const hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function decimal(value: unknown, maximum: string, zero = false): value is string {
  return typeof value === "string" && (zero && value === "0" || /^[1-9][0-9]*$/.test(value))
    && (value.length < maximum.length || value.length === maximum.length && value <= maximum);
}
function scalar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && scalar(value)
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && encoder.encode(value).length <= maximum;
}
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
function uidArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return;
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value), length: unknown = descriptors.length?.value;
  if (!integer(length, 0, 8) || Reflect.ownKeys(descriptors).length !== length + 1) return;
  const result: number[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !integer(descriptor.value, 1, 4294967295)) return;
    result.push(descriptor.value);
  }
  return result;
}
function manifest(value: unknown): ConnectorSelectionV1 | undefined {
  const data = record(value, ["formatVersion", "kind", "selectionId", "workspaceId", "ownerId", "connection", "connector", "mailbox", "selection", "notBeforeMs", "expiresAtMs"]);
  if (!data || data.formatVersion !== 1 || data.kind !== "mail.connector.selection" || !hex(data.selectionId) || !hex(data.workspaceId) || !hex(data.ownerId)
    || !integer(data.notBeforeMs, 0, Number.MAX_SAFE_INTEGER) || !integer(data.expiresAtMs, 1, Number.MAX_SAFE_INTEGER)
    || data.expiresAtMs < data.notBeforeMs) return;
  const connection = record(data.connection, ["id", "epoch", "snapshotDigest"]), connector = record(data.connector, ["identity", "runtimeId", "runId"]);
  if (!connection || !decimal(connection.id, "18446744073709551615") || !decimal(connection.epoch, "18446744073709551615") || !hex(connection.snapshotDigest)
    || !connector || !hex(connector.identity) || typeof connector.runtimeId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(connector.runtimeId)
    || typeof connector.runId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(connector.runId)) return;
  const mailbox = record(data.mailbox, ["host", "port", "username", "folder", "direction"]);
  if (!mailbox || !text(mailbox.host, 253) || /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000/@?#]/u.test(mailbox.host) || !integer(mailbox.port, 1, 65535)
    || !text(mailbox.username, 320) || !text(mailbox.folder, 512)
    || mailbox.direction !== "received" && mailbox.direction !== "sent") return;
  const selection = record(data.selection, ["mode", "uidValidity", "expectedCursorGeneration", "previousCursorDigest", "fromUid", "throughUid", "uids", "maxAcknowledgedBytes"]);
  if (!selection || !decimal(selection.uidValidity, "4294967295") || !integer(selection.fromUid, 0, 4294967295)
    || !integer(selection.throughUid, 0, 4294967295)) return;
  const uids = uidArray(selection.uids); if (!uids) return;
  if (selection.mode === "new_only") {
    // A nonzero u32 UIDNEXT is encoded as throughUid + 1, not supplied as a
    // second independent field. No bootstrap may imply UIDNEXT=2^32.
    if (selection.expectedCursorGeneration !== "0" || selection.previousCursorDigest !== "" || selection.fromUid !== 0
      || selection.throughUid === 4294967295 || uids.length !== 0 || selection.maxAcknowledgedBytes !== 0) return;
  } else if (selection.mode === "stored_batch") {
    if (!decimal(selection.expectedCursorGeneration, "18446744073709551615") || !hex(selection.previousCursorDigest)
      || !integer(selection.maxAcknowledgedBytes, 1, 2097152) || uids.length < 1 || selection.fromUid < 1
      || selection.throughUid - selection.fromUid + 1 !== uids.length || uids.some((uid, index) => uid !== (selection.fromUid as number) + index)) return;
  } else return;
  // Recursive ASCII-key order is the byte contract. No value is normalized.
  return { connection: { epoch: connection.epoch, id: connection.id, snapshotDigest: connection.snapshotDigest },
    connector: { identity: connector.identity, runId: connector.runId, runtimeId: connector.runtimeId }, expiresAtMs: data.expiresAtMs,
    formatVersion: 1, kind: "mail.connector.selection", mailbox: { direction: mailbox.direction, folder: mailbox.folder, host: mailbox.host, port: mailbox.port, username: mailbox.username },
    notBeforeMs: data.notBeforeMs, ownerId: data.ownerId, selection: { expectedCursorGeneration: selection.expectedCursorGeneration as string,
      fromUid: selection.fromUid, maxAcknowledgedBytes: selection.maxAcknowledgedBytes as number, mode: selection.mode,
      previousCursorDigest: selection.previousCursorDigest as string, throughUid: selection.throughUid, uidValidity: selection.uidValidity, uids }, selectionId: data.selectionId, workspaceId: data.workspaceId };
}
/** Validate and serialize the complete closed, body-free selection metadata.
 * Current owner/config/cursor/TTL authority is checked by the server, not here. */
export function canonicalConnectorSelection(value: unknown): string | undefined {
  try { const result = manifest(value); if (!result) return; const canonical = JSON.stringify(result); return encoder.encode(canonical).length <= 8192 ? canonical : undefined; }
  catch { return undefined; }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
/** Copy all values and exact UTF-8 bytes before the first await. Returned
 * copies cannot alter the held metadata commitment. No S0 op is constructed. */
export async function prepareConnectorSelection(value: unknown): Promise<ConnectorSelectionPreparation> {
  try {
    const canonical = canonicalConnectorSelection(value); if (canonical === undefined) return { status: "denied", reason: "invalid_connector_selection" };
    const copied = encoder.encode(canonical), held = new ArrayBuffer(copied.length); new Uint8Array(held).set(copied);
    const frozen = freeze(JSON.parse(canonical) as ConnectorSelectionV1), digest = await globalThis.crypto.subtle.digest("SHA-256", held);
    const manifestDigest = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    return Object.freeze({ status: "prepared", selection: Object.freeze({ manifest: frozen, canonical, manifestBytes: held.byteLength, manifestDigest,
      copyPayload: () => new Uint8Array(held.slice(0)) }) });
  } catch { return { status: "denied", reason: "connector_preparation_unavailable" }; }
}
