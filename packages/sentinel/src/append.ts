import { canonicalOperation } from "./policy.js";
import { prepareOperation } from "./prepare.js";
import type { FrozenOperation, Preparation } from "./prepare.js";
import type { MailAppend, PrivateStorage, RunScope, SourceRef } from "./types.js";

/** Exact local append envelope. The host supplies the complete resolved source
 * closure, including stage. Structural validation cannot prove that closure,
 * authenticate a stored stage, or attest to a model's actual inputs. */
export interface FrozenAppendPayloadV1 {
  readonly body: string;
  readonly contractVersion: 1;
  readonly kind: "mail.summary";
  readonly parents: readonly SourceRef[];
  readonly sanitizationVersion: string;
  readonly stage: SourceRef;
}

export interface MailAppendBinding {
  readonly scope: RunScope;
  readonly connectionId: string;
  readonly epoch: number;
  readonly destination: PrivateStorage;
}

export interface FrozenMailAppend extends FrozenOperation {
  readonly operation: MailAppend;
}

export type AppendPreparation =
  | { readonly status: "prepared"; readonly request: FrozenMailAppend }
  | Extract<Preparation, { status: "denied" }>
  | { readonly status: "denied"; readonly reason: "invalid_append_payload" | "invalid_append_binding" };

const encoder = new TextEncoder();
const u64Max = "18446744073709551615";
// Rust str::trim uses Unicode White_Space, which differs from JS trim at BOM
// and NEXT LINE. Reject boundary whitespace without changing any input bytes.
const boundaryWhitespace = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;

function scalarString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return;
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return;
    copy[key] = descriptor.value;
  }
  return copy;
}

function sourceRef(value: unknown): SourceRef | undefined {
  const data = record(value, ["id", "revision", "digest"]);
  if (!data || typeof data.id !== "string" || data.id.length === 0 || data.id.length > 256 || !scalarString(data.id)
    || encoder.encode(data.id).length > 256 || boundaryWhitespace.test(data.id)
    || /[\u0000-\u001f\u007f-\u009f]/u.test(data.id)
    || typeof data.revision !== "string" || !/^[1-9][0-9]{0,19}$/.test(data.revision)
    || data.revision.length === 20 && data.revision > u64Max
    || typeof data.digest !== "string" || !/^[a-f0-9]{64}$/.test(data.digest)) return;
  // ASCII key order is part of the wire contract, including nested products.
  return { digest: data.digest, id: data.id, revision: data.revision };
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function appendPayload(value: unknown): FrozenAppendPayloadV1 | undefined {
  const data = record(value, ["body", "contractVersion", "kind", "parents", "sanitizationVersion", "stage"]);
  if (!data || data.contractVersion !== 1 || data.kind !== "mail.summary"
    || typeof data.body !== "string" || data.body.length > 160_000 || !scalarString(data.body) || encoder.encode(data.body).length > 160_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(data.body)
    || typeof data.sanitizationVersion !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(data.sanitizationVersion)) return;
  const stage = sourceRef(data.stage);
  if (!stage || !Array.isArray(data.parents) || Object.getPrototypeOf(data.parents) !== Array.prototype) return;
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(data.parents);
  const length: unknown = descriptors.length?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > 256
    || Reflect.ownKeys(descriptors).length !== length + 1) return;
  const seen = new Set<string>();
  const parents: { ref: SourceRef; idBytes: Uint8Array }[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return;
    const ref = sourceRef(descriptor.value);
    if (!ref) return;
    // A repeated (id, revision) is invalid even with the same digest. A changed
    // digest for that identity is a conflict, rather than a second parent.
    const key = JSON.stringify([ref.id, ref.revision]);
    if (seen.has(key)) return;
    seen.add(key);
    parents.push({ ref, idBytes: encoder.encode(ref.id) });
  }
  if (!parents.some(({ ref }) => ref.id === stage.id && ref.revision === stage.revision && ref.digest === stage.digest)) return;
  parents.sort((a, b) => compareBytes(a.idBytes, b.idBytes)
    || a.ref.revision.length - b.ref.revision.length
    || (a.ref.revision < b.ref.revision ? -1 : a.ref.revision > b.ref.revision ? 1 : 0)
    || (a.ref.digest < b.ref.digest ? -1 : a.ref.digest > b.ref.digest ? 1 : 0));
  return {
    body: data.body, contractVersion: 1, kind: "mail.summary", parents: parents.map(({ ref }) => ref),
    sanitizationVersion: data.sanitizationVersion, stage,
  };
}

/** Canonical recursive ASCII-key JSON, preserving exact Unicode scalar text.
 * Parent order is UTF-8 id bytes, numeric u64 revision, then digest. No body,
 * whitespace, line-ending, or Unicode normalization occurs. Undefined is a
 * fixed structural denial; caller-owned accessors are never invoked. */
export function canonicalAppendPayload(value: unknown): string | undefined {
  try {
    const payload = appendPayload(value);
    if (payload === undefined) return;
    const canonical = JSON.stringify(payload);
    return encoder.encode(canonical).length <= 512 * 1024 ? canonical : undefined;
  } catch { return undefined; }
}

function scalarTree(value: unknown): boolean {
  if (typeof value === "string") return scalarString(value);
  if (value !== null && typeof value === "object") return Object.values(value).every(scalarTree);
  return true;
}

/** Construct S0's closed mail.append operation from the full envelope's actual
 * bytes and SHA-256, then use prepareOperation's held-buffer preparation. All
 * caller-owned input is copied before the first await. This is not a grant,
 * admission, stored-stage check, source-policy decision, or dispatch permit. */
export async function prepareMailAppend(binding: unknown, payload: unknown): Promise<AppendPreparation> {
  try {
    const canonical = canonicalAppendPayload(payload);
    if (canonical === undefined) return { status: "denied", reason: "invalid_append_payload" };
    const data = record(binding, ["scope", "connectionId", "epoch", "destination"]);
    if (!data) return { status: "denied", reason: "invalid_append_binding" };
    const proposal = canonicalOperation({ ...data, kind: "mail.append", contractVersion: 1, bytes: 1, payloadDigest: "0".repeat(64) });
    if (proposal === undefined) return { status: "denied", reason: "invalid_append_binding" };
    const operation = JSON.parse(proposal) as MailAppend;
    if (!scalarTree(operation)) return { status: "denied", reason: "invalid_append_binding" };
    const bytes = encoder.encode(canonical);
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const payloadDigest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
    const result = await prepareOperation({ ...operation, bytes: bytes.length, payloadDigest }, bytes);
    if (result.status === "denied") return result;
    return { status: "prepared", request: result.request as FrozenMailAppend };
  } catch { return { status: "denied", reason: "preparation_unavailable" }; }
}
