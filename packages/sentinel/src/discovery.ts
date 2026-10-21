/** Frozen metadata commitments only. This codec authenticates no owner, current
 * authority, mailbox observation, credential or permission to read/skip mail. */
export interface ConnectorDiscoveryV1 {
  readonly formatVersion: 1;
  readonly kind: "mail.connector.discovery";
  readonly profile: "imap.uid-discovery.v1";
  readonly discoveryId: string;
  readonly eventNonce: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly connection: { readonly id: string; readonly epoch: string; readonly snapshotDigest: string };
  readonly connector: { readonly identity: string; readonly runtimeId: string; readonly runId: string };
  readonly mailbox: { readonly host: string; readonly port: number; readonly username: string; readonly folder: string; readonly direction: "received" | "sent" };
  readonly cursor: null | { readonly id: string; readonly generation: string; readonly digest: string; readonly uidValidity: string; readonly lastUid: number };
  readonly head: null | { readonly id: string; readonly generation: string; readonly digest: string; readonly observationId: string; readonly uidValidity: string; readonly uidNext: number };
  readonly window: { readonly mode: "bootstrap" | "next_window"; readonly maxSlots: number; readonly fromUid: number | null; readonly maxThroughUid: number | null };
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
  readonly reservation: { readonly operations: 1; readonly numericSlots: number; readonly controlBytes: 65536 };
}
export interface MailDiscoveryObservation {
  readonly uidValidity: string;
  readonly uidNext: number;
  readonly presentUids: readonly number[];
}
export interface FrozenConnectorDiscovery {
  readonly manifest: ConnectorDiscoveryV1;
  readonly canonical: string;
  readonly manifestBytes: number;
  readonly manifestDigest: string;
  readonly copyPayload: () => Uint8Array;
}
export type ConnectorDiscoveryPreparation =
  | { readonly status: "prepared"; readonly discovery: FrozenConnectorDiscovery }
  | { readonly status: "denied"; readonly reason: "invalid_connector_discovery" | "discovery_preparation_unavailable" };

const encoder = new TextEncoder(), MAX_UID = 4294967295, MAX_U64 = "18446744073709551615";
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
function decimal(value: unknown, max: string): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value)
    && (value.length < max.length || value.length === max.length && value <= max);
}
function scalar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && scalar(value)
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && encoder.encode(value).length <= max;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return;
  const fields = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(fields);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return;
  const copied: Record<string, unknown> = {};
  for (const key of keys) {
    const field = fields[key];
    if (!field || !("value" in field) || !field.enumerable) return;
    copied[key] = field.value;
  }
  return copied;
}
function uidArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return;
  const fields = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  const length = fields.length;
  if (!length || !("value" in length) || !integer(length.value, 0, 8) || Reflect.ownKeys(fields).length !== length.value + 1) return;
  const copied: number[] = [];
  for (let i = 0; i < length.value; i++) {
    const field = fields[String(i)];
    if (!field || !("value" in field) || !field.enumerable || !integer(field.value, 1, MAX_UID)
      || i > 0 && field.value <= copied[i - 1]) return;
    copied.push(field.value);
  }
  return copied;
}
/** Closed declaration only. It is not evidence that SEARCH completed, and it
 * supplies no caller-chosen range or absence list. Bind it at the authority. */
export function parseMailDiscoveryObservation(value: unknown): MailDiscoveryObservation | undefined {
  try {
    const data = record(value, ["uidValidity", "uidNext", "presentUids"]);
    if (!data || !decimal(data.uidValidity, String(MAX_UID)) || !integer(data.uidNext, 1, MAX_UID)) return;
    const uids = uidArray(data.presentUids);
    if (!uids || uids.some(uid => uid >= (data.uidNext as number))) return;
    return Object.freeze({ uidValidity: data.uidValidity, uidNext: data.uidNext, presentUids: Object.freeze(uids) });
  } catch { return undefined; }
}
function manifest(value: unknown): ConnectorDiscoveryV1 | undefined {
  const data = record(value, ["formatVersion", "kind", "profile", "discoveryId", "eventNonce", "workspaceId", "ownerId", "connection", "connector", "mailbox", "cursor", "head", "window", "notBeforeMs", "expiresAtMs", "reservation"]);
  if (!data || data.formatVersion !== 1 || data.kind !== "mail.connector.discovery" || data.profile !== "imap.uid-discovery.v1"
    || !hex(data.discoveryId) || !hex(data.eventNonce) || !hex(data.workspaceId) || !hex(data.ownerId)
    || !integer(data.notBeforeMs, 0, Number.MAX_SAFE_INTEGER) || !integer(data.expiresAtMs, 1, Number.MAX_SAFE_INTEGER)
    || data.expiresAtMs <= data.notBeforeMs || data.expiresAtMs - data.notBeforeMs > 3600000) return;
  const connection = record(data.connection, ["id", "epoch", "snapshotDigest"]), connector = record(data.connector, ["identity", "runtimeId", "runId"]);
  if (!connection || !decimal(connection.id, MAX_U64) || !decimal(connection.epoch, MAX_U64) || !hex(connection.snapshotDigest)
    || !connector || !hex(connector.identity) || typeof connector.runtimeId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(connector.runtimeId)
    || typeof connector.runId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(connector.runId)) return;
  const mailbox = record(data.mailbox, ["host", "port", "username", "folder", "direction"]);
  if (!mailbox || !text(mailbox.host, 253) || /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000/@?#]/u.test(mailbox.host)
    || !integer(mailbox.port, 1, 65535) || !text(mailbox.username, 320) || !text(mailbox.folder, 512)
    || mailbox.direction !== "received" && mailbox.direction !== "sent") return;
  let cursor: ConnectorDiscoveryV1["cursor"] = null;
  if (data.cursor !== null) {
    const row = record(data.cursor, ["id", "generation", "digest", "uidValidity", "lastUid"]);
    if (!row || typeof row.id !== "string" || !/^mail-connector-cursor:[a-f0-9]{64}$/.test(row.id)
      || !decimal(row.generation, MAX_U64) || !hex(row.digest) || !decimal(row.uidValidity, String(MAX_UID)) || !integer(row.lastUid, 0, MAX_UID - 1)) return;
    cursor = { digest: row.digest, generation: row.generation, id: row.id, lastUid: row.lastUid, uidValidity: row.uidValidity };
  }
  let head: ConnectorDiscoveryV1["head"] = null;
  if (data.head !== null) {
    const row = record(data.head, ["id", "generation", "digest", "observationId", "uidValidity", "uidNext"]);
    if (!row || typeof row.id !== "string" || !/^mail-discovery-head:[a-f0-9]{64}$/.test(row.id)
      || !decimal(row.generation, MAX_U64) || !hex(row.digest) || !hex(row.observationId)
      || !decimal(row.uidValidity, String(MAX_UID)) || !integer(row.uidNext, 1, MAX_UID)
      || cursor && row.uidValidity !== cursor.uidValidity) return;
    head = { digest: row.digest, generation: row.generation, id: row.id, observationId: row.observationId, uidNext: row.uidNext, uidValidity: row.uidValidity };
  }
  const window = record(data.window, ["mode", "maxSlots", "fromUid", "maxThroughUid"]), reservation = record(data.reservation, ["operations", "numericSlots", "controlBytes"]);
  if (!window || !reservation || reservation.operations !== 1 || reservation.controlBytes !== 65536 || reservation.numericSlots !== window.maxSlots) return;
  if (window.mode === "bootstrap") {
    if (cursor !== null || window.maxSlots !== 0 || window.fromUid !== null || window.maxThroughUid !== null) return;
  } else if (window.mode === "next_window") {
    if (!cursor || !integer(window.maxSlots, 1, 8) || window.fromUid !== cursor.lastUid + 1
      || window.maxThroughUid !== Math.min(cursor.lastUid + window.maxSlots, MAX_UID)) return;
  } else return;
  // Construct every level in recursive ASCII-key order; no value normalization.
  return { connection: { epoch: connection.epoch, id: connection.id, snapshotDigest: connection.snapshotDigest },
    connector: { identity: connector.identity, runId: connector.runId, runtimeId: connector.runtimeId }, cursor, discoveryId: data.discoveryId,
    eventNonce: data.eventNonce, expiresAtMs: data.expiresAtMs, formatVersion: 1, head, kind: "mail.connector.discovery",
    mailbox: { direction: mailbox.direction, folder: mailbox.folder, host: mailbox.host, port: mailbox.port, username: mailbox.username },
    notBeforeMs: data.notBeforeMs, ownerId: data.ownerId, profile: "imap.uid-discovery.v1",
    reservation: { controlBytes: 65536, numericSlots: window.maxSlots as number, operations: 1 },
    window: { fromUid: window.fromUid as number | null, maxSlots: window.maxSlots as number, maxThroughUid: window.maxThroughUid as number | null, mode: window.mode },
    workspaceId: data.workspaceId };
}
export function canonicalConnectorDiscovery(value: unknown): string | undefined {
  try { const copied = manifest(value); if (!copied) return; const canonical = JSON.stringify(copied); return encoder.encode(canonical).length <= 8192 ? canonical : undefined; }
  catch { return undefined; }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
/** All plan values and actual bytes are privately copied before crypto yields.
 * A prepared commitment never supplies dispatch, credential or cursor authority. */
export async function prepareConnectorDiscovery(value: unknown): Promise<ConnectorDiscoveryPreparation> {
  try {
    const canonical = canonicalConnectorDiscovery(value);
    if (!canonical) return Object.freeze({ status: "denied", reason: "invalid_connector_discovery" });
    const copied = encoder.encode(canonical), held = new ArrayBuffer(copied.length); new Uint8Array(held).set(copied);
    const frozen = freeze(JSON.parse(canonical) as ConnectorDiscoveryV1);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", held);
    const manifestDigest = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    return Object.freeze({ status: "prepared", discovery: Object.freeze({ manifest: frozen, canonical, manifestBytes: held.byteLength, manifestDigest,
      copyPayload: () => new Uint8Array(held.slice(0)) }) });
  } catch { return Object.freeze({ status: "denied", reason: "discovery_preparation_unavailable" }); }
}
