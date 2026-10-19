import { POLICY_VERSION } from "./types.js";
import type { Operation, PolicySnapshot } from "./types.js";

type Row = Record<string, unknown>;
type Check = (value: unknown) => boolean;

function row(value: unknown, required: Record<string, Check>, optional: Record<string, Check> = {}): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string"
    || !(Object.hasOwn(required, key) || Object.hasOwn(optional, key)))) return false;
  // JSON-like values only: no getters/setters executing during validation.
  if (Object.values(descriptors).some((d) => !("value" in d) || !d.enumerable)) return false;
  const data = value as Row;
  return Object.entries(required).every(([key, check]) => Object.hasOwn(data, key) && check(data[key]))
    && Object.entries(optional).every(([key, check]) => !Object.hasOwn(data, key) || check(data[key]));
}

const text = (value: unknown, limit = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const id: Check = (v) => text(v);
const digest: Check = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive: Check = (v) => integer(v) && (v as number) > 0;
const list = (check: Check, max = 256): Check => (v) => {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return false;
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(v);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max
    || Reflect.ownKeys(v).length !== length + 1) return false;
  // Dense ordinary JSON arrays only. Avoid attacker-supplied iteration methods,
  // sparse entries, accessor indices and extra fields ignored by Array.every.
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !check(descriptor.value)) return false;
  }
  return true;
};
const scope: Check = (v) => row(v, { workspaceId: id, principalId: id, runtimeId: id, runId: id }, { parentRunId: id });
const ref: Check = (v) => row(v, { id, revision: id, digest });
const storage: Check = (v) => row(v, { workspaceId: id, rootId: id, ownerId: id });
const endpoint: Check = (v) => {
  if (!text(v, 2048)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && u.href === v;
  } catch { return false; }
};
const host: Check = (v) => {
  if (!text(v, 253)) return false;
  try {
    const u = new URL(`https://${v}`);
    return !u.username && !u.password && !u.port && u.pathname === "/" && !u.search && !u.hash && u.hostname === v;
  } catch { return false; }
};
const processor: Check = (v) => row(v, { profileId: id, revision: id, endpoint, model: id });
const folders: Check = (v) => list((item) => text(item, 512), 32)(v)
  && (v as unknown[]).length > 0 && new Set(v as string[]).size === (v as string[]).length;
const mailbox: Check = (v) => row(v, { host, port: (p) => positive(p) && (p as number) <= 65535, folders });
const limitFields = { messages: integer, readBytes: integer, inputBytes: integer, outputTokens: integer, appendBytes: integer };
const limits: Check = (v) => row(v, limitFields);
const source: Check = (v) => row(v, {
  ref, workspaceId: id,
  origin: (o) => ["external_mail", "external_web", "workspace", "derived", "unknown"].includes(o as string),
  sanitizationVersion: id, parents: list(ref), processors: list(processor, 32), storage: list(storage, 32),
});
const grant: Check = (v) => row(v, {
  id, policyVersion: (p) => p === POLICY_VERSION, scope, epoch: integer,
  notBeforeMs: integer, expiresAtMs: integer, connectionId: id, mailbox,
  destination: storage, limits,
}, { summaryProcessor: processor, screeningProcessor: processor })
  && (v as { expiresAtMs: number }).expiresAtMs > (v as { notBeforeMs: number }).notBeforeMs;

/** Validation failure must not echo attacker input or throw a content-bearing error. */
export function isSnapshot(value: unknown): value is PolicySnapshot {
  try {
    return row(value, {
      policyVersion: (p) => p === POLICY_VERSION, scope, epoch: integer, nowMs: integer,
      grant, exposures: list(ref), sources: list(source),
      remaining: (v) => row(v, { ...limitFields, operations: integer }),
      screening: (v) => ["not_required", "clean", "hold", "unavailable"].includes(v as string),
    });
  } catch { return false; }
}

export function isOperation(value: unknown): value is Operation {
  try {
    if (value === null || typeof value !== "object") return false;
    // Inspect descriptors before reading kind so accessors are never evaluated.
    const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
    if (!descriptor || !("value" in descriptor)) return false;
    const base = { scope, connectionId: id, epoch: integer, contractVersion: (v: unknown) => v === 1 };
    switch (descriptor.value) {
      case "mail.read": return row(value, {
        ...base, kind: (v) => v === "mail.read", mailbox, messages: positive, bytes: positive,
      });
      case "content.screen": return row(value, {
        ...base, kind: (v) => v === "content.screen", processor, inputBytes: positive, payloadDigest: digest,
      });
      case "model.infer": return row(value, {
        ...base, kind: (v) => v === "model.infer", purpose: (v) => v === "mail.summary",
        processor, inputBytes: positive, outputTokens: positive, payloadDigest: digest,
      });
      case "mail.append": return row(value, {
        ...base, kind: (v) => v === "mail.append", destination: storage, bytes: positive, payloadDigest: digest,
      });
      default: return false;
    }
  } catch { return false; }
}
