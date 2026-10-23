/** Exact body-free sparse-read declarations. Preparation supplies no owner
 * authority, observation authenticity, credential, execution or storage permit. */
export interface ConnectorSparseReadV1 {
  readonly formatVersion: 1;
  readonly kind: "mail.connector.sparse_read";
  readonly readId: string;
  readonly eventNonce: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly connection: { readonly id: string; readonly epoch: string; readonly snapshotDigest: string };
  readonly connector: { readonly identity: string; readonly runtimeId: string; readonly runId: string };
  readonly mailbox: { readonly host: string; readonly port: number; readonly username: string; readonly folder: string; readonly direction: "received" | "sent" };
  readonly cursor: { readonly id: string; readonly generation: string; readonly digest: string; readonly uidValidity: string; readonly lastUid: number };
  readonly observation: { readonly id: string; readonly digest: string; readonly manifestDigest: string; readonly headId: string; readonly headGeneration: string;
    readonly uidValidity: string; readonly uidNext: number; readonly fromUid: number; readonly throughUid: number; readonly presentUids: readonly number[]; readonly absentUids: readonly number[] };
  readonly limits: { readonly maxMessageBytes: number; readonly maxTotalBytes: number };
  readonly profile: "imap.observed-uid-body-peek.v1";
  readonly reservation: { readonly bodyBytes: number; readonly messageSlots: number; readonly operations: 1 };
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
}
export interface FrozenConnectorSparseRead {
  readonly manifest: ConnectorSparseReadV1;
  readonly canonical: string;
  readonly planBytes: number;
  readonly planDigest: string;
  readonly copyPayload: () => Uint8Array;
}
export type ConnectorSparseReadPreparation =
  | { readonly status: "prepared"; readonly read: FrozenConnectorSparseRead }
  | { readonly status: "denied"; readonly reason: "invalid_connector_sparse_read" | "sparse_read_preparation_unavailable" };

const encoder = new TextEncoder(), MAX_UID = 4294967295, MAX_BYTES = 2097152, MAX_U64 = "18446744073709551615";
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
function decimal(v: unknown, max: string): v is string {
  return typeof v === "string" && /^[1-9][0-9]*$/.test(v) && (v.length < max.length || v.length === max.length && v <= max);
}
function scalar(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const next = v.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function text(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max && scalar(v)
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(v) && encoder.encode(v).length <= max;
}
function record(v: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v) || ![null, Object.prototype].includes(Object.getPrototypeOf(v))) return;
  const descriptors = Object.getOwnPropertyDescriptors(v), own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some(k => typeof k !== "string" || !keys.includes(k))) return;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = descriptors[key]; if (!field || !("value" in field) || !field.enumerable) return;
    result[key] = field.value;
  }
  return result;
}
function list(v: unknown): unknown[] | undefined {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return;
  const descriptors = Object.getOwnPropertyDescriptors(v) as unknown as PropertyDescriptorMap, length = descriptors.length;
  if (!length || !("value" in length) || !integer(length.value, 0, 8) || Reflect.ownKeys(descriptors).length !== length.value + 1) return;
  const copied: unknown[] = [];
  for (let i = 0; i < length.value; i++) {
    const field = descriptors[String(i)]; if (!field || !("value" in field) || !field.enumerable) return;
    copied.push(field.value);
  }
  return copied;
}
function uids(v: unknown): number[] | undefined {
  const copied = list(v); if (!copied) return;
  const result: number[] = [];
  for (const value of copied) { if (!integer(value, 1, MAX_UID) || result.length > 0 && value <= result[result.length - 1]) return; result.push(value); }
  return result;
}
function manifest(v: unknown): ConnectorSparseReadV1 | undefined {
  const data = record(v, ["formatVersion", "kind", "readId", "eventNonce", "workspaceId", "ownerId", "connection", "connector", "mailbox", "cursor", "observation", "limits", "profile", "reservation", "notBeforeMs", "expiresAtMs"]);
  if (!data || data.formatVersion !== 1 || data.kind !== "mail.connector.sparse_read" || data.profile !== "imap.observed-uid-body-peek.v1" || !hex(data.readId) || !hex(data.eventNonce)
    || !hex(data.workspaceId) || !hex(data.ownerId) || !integer(data.notBeforeMs, 0, Number.MAX_SAFE_INTEGER)
    || !integer(data.expiresAtMs, 1, Number.MAX_SAFE_INTEGER) || data.expiresAtMs <= data.notBeforeMs || data.expiresAtMs - data.notBeforeMs > 3600000) return;
  const connection = record(data.connection, ["id", "epoch", "snapshotDigest"]), connector = record(data.connector, ["identity", "runtimeId", "runId"]);
  if (!connection || !decimal(connection.id, MAX_U64) || !decimal(connection.epoch, MAX_U64) || !hex(connection.snapshotDigest)
    || !connector || !hex(connector.identity) || typeof connector.runtimeId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(connector.runtimeId)
    || typeof connector.runId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(connector.runId)) return;
  const mailbox = record(data.mailbox, ["host", "port", "username", "folder", "direction"]);
  if (!mailbox || !text(mailbox.host, 253) || /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000/@?#]/u.test(mailbox.host)
    || !integer(mailbox.port, 1, 65535) || !text(mailbox.username, 320) || !text(mailbox.folder, 512)
    || mailbox.direction !== "received" && mailbox.direction !== "sent") return;
  const cursor = record(data.cursor, ["id", "generation", "digest", "uidValidity", "lastUid"]);
  if (!cursor || typeof cursor.id !== "string" || !/^mail-connector-cursor:[a-f0-9]{64}$/.test(cursor.id)
    || !decimal(cursor.generation, MAX_U64) || !hex(cursor.digest) || !decimal(cursor.uidValidity, String(MAX_UID)) || !integer(cursor.lastUid, 0, MAX_UID - 1)) return;
  const observation = record(data.observation, ["id", "digest", "manifestDigest", "headId", "headGeneration", "uidValidity", "uidNext", "fromUid", "throughUid", "presentUids", "absentUids"]);
  if (!observation || !hex(observation.id) || !hex(observation.digest) || !hex(observation.manifestDigest)
    || typeof observation.headId !== "string" || !/^mail-discovery-head:[a-f0-9]{64}$/.test(observation.headId)
    || !decimal(observation.headGeneration, MAX_U64) || observation.uidValidity !== cursor.uidValidity || !integer(observation.uidNext, 1, MAX_UID)
    || observation.fromUid !== cursor.lastUid + 1 || !integer(observation.fromUid, 1, MAX_UID)
    || !integer(observation.throughUid, observation.fromUid, MAX_UID) || observation.throughUid - observation.fromUid + 1 > 8
    || observation.throughUid >= observation.uidNext) return;
  const present = uids(observation.presentUids), absent = uids(observation.absentUids);
  if (!present || present.length === 0 || !absent) return;
  const partition = [...present, ...absent].sort((a, b) => a - b);
  if (partition.length !== observation.throughUid - observation.fromUid + 1 || partition.some((uid, index) => uid !== (observation.fromUid as number) + index)) return;
  const limits = record(data.limits, ["maxMessageBytes", "maxTotalBytes"]), reservation = record(data.reservation, ["bodyBytes", "messageSlots", "operations"]);
  if (!limits || !integer(limits.maxMessageBytes, 1, 524288) || !integer(limits.maxTotalBytes, 1, MAX_BYTES)
    || limits.maxMessageBytes > limits.maxTotalBytes || limits.maxTotalBytes > present.length * limits.maxMessageBytes
    || !reservation || reservation.operations !== 1 || reservation.bodyBytes !== limits.maxTotalBytes || reservation.messageSlots !== present.length) return;
  return { connection: { epoch: connection.epoch, id: connection.id, snapshotDigest: connection.snapshotDigest },
    connector: { identity: connector.identity, runId: connector.runId, runtimeId: connector.runtimeId },
    cursor: { digest: cursor.digest, generation: cursor.generation, id: cursor.id, lastUid: cursor.lastUid, uidValidity: cursor.uidValidity },
    eventNonce: data.eventNonce, expiresAtMs: data.expiresAtMs, formatVersion: 1, kind: "mail.connector.sparse_read",
    limits: { maxMessageBytes: limits.maxMessageBytes, maxTotalBytes: limits.maxTotalBytes },
    mailbox: { direction: mailbox.direction, folder: mailbox.folder, host: mailbox.host, port: mailbox.port, username: mailbox.username }, notBeforeMs: data.notBeforeMs,
    observation: { absentUids: absent, digest: observation.digest, fromUid: observation.fromUid, headGeneration: observation.headGeneration,
      headId: observation.headId, id: observation.id, manifestDigest: observation.manifestDigest, presentUids: present,
      throughUid: observation.throughUid, uidNext: observation.uidNext, uidValidity: observation.uidValidity as string },
    ownerId: data.ownerId, profile: "imap.observed-uid-body-peek.v1", readId: data.readId,
    reservation: { bodyBytes: limits.maxTotalBytes, messageSlots: present.length, operations: 1 }, workspaceId: data.workspaceId };
}
/** Structural byte commitment only. Full preparation also checks the derived
 * observation/read identity; neither supplies current authorization. */
export function canonicalConnectorSparseRead(value: unknown): string | undefined {
  try { const copied = manifest(value); if (!copied) return; const canonical = JSON.stringify(copied); return encoder.encode(canonical).length <= 8192 ? canonical : undefined; }
  catch { return undefined; }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function identityBytes(observationId: string): ArrayBuffer {
  const fields = ["pear-mail-sparse-read-grant-v1", observationId].map(field => encoder.encode(field));
  const held = new ArrayBuffer(fields.reduce((n, bytes) => n + 8 + bytes.length, 0)), view = new DataView(held), bytes = new Uint8Array(held); let offset = 0;
  for (const field of fields) { view.setBigUint64(offset, BigInt(field.length)); offset += 8; bytes.set(field, offset); offset += field.length; } return held;
}
const hexadecimal = (v: ArrayBuffer) => Array.from(new Uint8Array(v), byte => byte.toString(16).padStart(2, "0")).join("");
export async function prepareConnectorSparseRead(value: unknown): Promise<ConnectorSparseReadPreparation> {
  try {
    const canonical = canonicalConnectorSparseRead(value);
    if (!canonical) return Object.freeze({ status: "denied", reason: "invalid_connector_sparse_read" });
    const copied = encoder.encode(canonical), held = new ArrayBuffer(copied.length); new Uint8Array(held).set(copied);
    const frozen = freeze(JSON.parse(canonical) as ConnectorSparseReadV1), idHeld = identityBytes(frozen.observation.id);
    const [planDigest, id] = await Promise.all([held, idHeld].map(bytes => globalThis.crypto.subtle.digest("SHA-256", bytes).then(hexadecimal)));
    if (id !== frozen.readId) return Object.freeze({ status: "denied", reason: "invalid_connector_sparse_read" });
    return Object.freeze({ status: "prepared", read: Object.freeze({ manifest: frozen, canonical, planBytes: held.byteLength, planDigest,
      copyPayload: () => new Uint8Array(held.slice(0)) }) });
  } catch { return Object.freeze({ status: "denied", reason: "sparse_read_preparation_unavailable" }); }
}
