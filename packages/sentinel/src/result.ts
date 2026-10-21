import type { SourceRef } from "./types.js";

/** A bounded broker declaration, not proof of provider execution or token
 * accuracy. Its literal body remains untrusted content after acceptance. */
export interface InferenceResultDeclarationV1 {
  readonly formatVersion: 1;
  readonly adapter: "anthropic.messages.v1";
  readonly model: string;
  readonly stopReason: "end_turn";
  readonly outputTokens: number;
  readonly body: string;
}

/** Host-resolved immutable admission inputs. Structural validation cannot
 * prove their completeness, policy, ownership or result-storage authority. */
export interface InferenceResultBinding {
  readonly admissionId: string;
  readonly model: string;
  readonly reservedOutputTokens: number;
  readonly parents: readonly SourceRef[];
}

export interface InferenceResultPayloadV1 extends InferenceResultDeclarationV1 {
  readonly admissionId: string;
  readonly kind: "mail.inference.result";
  readonly parents: readonly SourceRef[];
  readonly sanitizationVersion: "sentinel-result-v1";
}

/** Frozen evidence bytes only. This has no S0 operation or execution permit. */
export interface FrozenInferenceResult {
  readonly envelope: InferenceResultPayloadV1;
  readonly canonical: string;
  readonly envelopeBytes: number;
  readonly envelopeDigest: string;
  readonly copyPayload: () => Uint8Array;
}
export type InferenceResultPreparation =
  | { readonly status: "prepared"; readonly result: FrozenInferenceResult }
  | { readonly status: "denied"; readonly reason: "invalid_result_payload" | "invalid_result_binding" | "result_preparation_unavailable" };

const encoder = new TextEncoder();
const idBoundary = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
function scalar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
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
function text(value: unknown, bytes: number, multiline: boolean): value is string {
  return typeof value === "string" && value.length <= bytes && scalar(value) && encoder.encode(value).length <= bytes
    && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u).test(value);
}
function model(value: unknown): value is string {
  return text(value, 256, false) && value.length > 0 && !idBoundary.test(value) && !value.startsWith("\ufeff") && !value.endsWith("\ufeff");
}
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function refs(value: unknown): SourceRef[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return;
  const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
  const length: unknown = descriptors.length?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > 255 || Reflect.ownKeys(descriptors).length !== length + 1) return;
  const parents: { ref: SourceRef; bytes: Uint8Array }[] = [], seen = new Set<string>();
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return;
    const data = record(descriptor.value, ["id", "revision", "digest"]);
    if (!data || !text(data.id, 256, false) || !data.id.length || idBoundary.test(data.id)
      || typeof data.revision !== "string" || !/^[1-9][0-9]{0,19}$/.test(data.revision)
      || data.revision.length === 20 && data.revision > "18446744073709551615"
      || typeof data.digest !== "string" || !/^[a-f0-9]{64}$/.test(data.digest)) return;
    const key = JSON.stringify([data.id, data.revision]); if (seen.has(key)) return; seen.add(key);
    parents.push({ ref: { digest: data.digest, id: data.id, revision: data.revision }, bytes: encoder.encode(data.id) });
  }
  parents.sort((a, b) => compareBytes(a.bytes, b.bytes) || a.ref.revision.length - b.ref.revision.length
    || (a.ref.revision < b.ref.revision ? -1 : a.ref.revision > b.ref.revision ? 1 : 0)
    || (a.ref.digest < b.ref.digest ? -1 : a.ref.digest > b.ref.digest ? 1 : 0));
  return parents.map(({ ref }) => ref);
}
function declaration(value: unknown): InferenceResultDeclarationV1 | undefined {
  const data = record(value, ["formatVersion", "adapter", "model", "stopReason", "outputTokens", "body"]);
  if (!data || data.formatVersion !== 1 || data.adapter !== "anthropic.messages.v1" || data.stopReason !== "end_turn"
    || !model(data.model) || !Number.isInteger(data.outputTokens) || typeof data.outputTokens !== "number" || data.outputTokens < 1 || data.outputTokens > 4096
    || !text(data.body, 65536, true) || data.body.length === 0) return;
  return { formatVersion: 1, adapter: "anthropic.messages.v1", model: data.model, stopReason: "end_turn", outputTokens: data.outputTokens, body: data.body };
}
/** Fresh immutable structural declaration. This does not authenticate a
 * provider response, reserved token cap or permission to store the body. */
export function parseInferenceResultDeclaration(value: unknown): InferenceResultDeclarationV1 | undefined {
  try { const result = declaration(value); return result === undefined ? undefined : Object.freeze(result); }
  catch { return undefined; }
}
function envelope(value: unknown): InferenceResultPayloadV1 | undefined {
  const data = record(value, ["admissionId", "adapter", "body", "formatVersion", "kind", "model", "outputTokens", "parents", "sanitizationVersion", "stopReason"]);
  if (!data || typeof data.admissionId !== "string" || !/^[a-f0-9]{64}$/.test(data.admissionId)
    || data.kind !== "mail.inference.result" || data.sanitizationVersion !== "sentinel-result-v1") return;
  const literal = declaration({ formatVersion: data.formatVersion, adapter: data.adapter, model: data.model, stopReason: data.stopReason, outputTokens: data.outputTokens, body: data.body });
  const parents = refs(data.parents); if (!literal || !parents) return;
  // Recursive ASCII-key ordering is the cross-language byte contract.
  return { adapter: literal.adapter, admissionId: data.admissionId, body: literal.body, formatVersion: 1, kind: "mail.inference.result",
    model: literal.model, outputTokens: literal.outputTokens, parents, sanitizationVersion: "sentinel-result-v1", stopReason: "end_turn" };
}

/** Exact canonical evidence envelope, including its complete host-owned input
 * closure. No whitespace/Unicode normalization or body parsing occurs. The
 * fixed tag versions this contract; it does not certify safe HTML or redaction. */
export function canonicalInferenceResultPayload(value: unknown): string | undefined {
  try {
    const result = envelope(value); if (!result) return;
    const canonical = JSON.stringify(result);
    return encoder.encode(canonical).length <= 262144 ? canonical : undefined;
  } catch { return undefined; }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

/** Bind the closed declaration to host-resolved admission metadata, then copy
 * all input before crypto yields. Storage authorization/current ancestry and
 * the owner-specific byte ceiling are enforced separately by the server. */
export async function prepareInferenceResult(binding: unknown, proposed: unknown): Promise<InferenceResultPreparation> {
  try {
    const data = record(binding, ["admissionId", "model", "reservedOutputTokens", "parents"]), literal = parseInferenceResultDeclaration(proposed);
    if (!literal) return { status: "denied", reason: "invalid_result_payload" };
    if (!data || !model(data.model) || literal.model !== data.model || typeof data.reservedOutputTokens !== "number"
      || !Number.isInteger(data.reservedOutputTokens) || data.reservedOutputTokens < 1 || data.reservedOutputTokens > 4096
      || literal.outputTokens > data.reservedOutputTokens) return { status: "denied", reason: "invalid_result_binding" };
    const canonical = canonicalInferenceResultPayload({ ...literal, admissionId: data.admissionId, kind: "mail.inference.result",
      parents: data.parents, sanitizationVersion: "sentinel-result-v1" });
    if (canonical === undefined) return { status: "denied", reason: "invalid_result_binding" };
    const copied = encoder.encode(canonical), held = new ArrayBuffer(copied.length); new Uint8Array(held).set(copied);
    const result = freeze(JSON.parse(canonical) as InferenceResultPayloadV1);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", held);
    const envelopeDigest = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    return Object.freeze({ status: "prepared", result: Object.freeze({ envelope: result, canonical, envelopeBytes: held.byteLength, envelopeDigest,
      copyPayload: () => new Uint8Array(held.slice(0)) }) });
  } catch { return { status: "denied", reason: "result_preparation_unavailable" }; }
}
