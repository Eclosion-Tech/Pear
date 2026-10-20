import { canonicalOperation } from "./policy.js";
import { prepareOperation } from "./prepare.js";
import type { FrozenOperation, Preparation } from "./prepare.js";
import type { ModelInfer, Processor, RunScope } from "./types.js";

/** Versioned non-secret transport metadata. No provider request is sent here.
 * The endpoint is the operation's complete exact processor endpoint. Credential
 * injection, current authority, DNS/TLS and egress remain broker obligations. */
export const MAIL_INFERENCE_TRANSPORT_V1 = Object.freeze({
  adapter: "anthropic.messages.v1" as const,
  method: "POST" as const,
  headers: Object.freeze({ "anthropic-version": "2023-06-01", "content-type": "application/json" }),
});

/** Only these eight stored mail fields enter the provider request. In
 * particular, no folder/UID, note, source IDs or execution metadata is sent. */
export interface MailInferenceMessageV1 {
  readonly body: string;
  readonly cc: string;
  readonly direction: "received" | "sent";
  readonly from: string;
  readonly messageDate: string;
  readonly sanitizationVersion: string;
  readonly subject: string;
  readonly to: string;
}

/** Host-owned fixed recipe input. References, ownership, exact configuration,
 * current approval and complete exposure are checked by the authority store,
 * not by this structural codec. Literal mail remains untrusted source text. */
export interface FixedMailInferenceInputV1 {
  readonly adapter: "anthropic.messages.v1";
  readonly contractVersion: 1;
  readonly instruction: string;
  readonly mail: MailInferenceMessageV1;
  readonly model: string;
  readonly outputTokens: number;
}

export interface MailInferenceBinding {
  readonly scope: RunScope;
  readonly connectionId: string;
  readonly epoch: number;
  readonly processor: Processor;
}

export interface FrozenMailInference extends FrozenOperation {
  readonly operation: ModelInfer;
}

export type InferencePreparation =
  | { readonly status: "prepared"; readonly request: FrozenMailInference }
  | Extract<Preparation, { status: "denied" }>
  | { readonly status: "denied"; readonly reason: "invalid_inference_payload" | "invalid_inference_binding" };

const encoder = new TextEncoder();
/** Predict the server's owner/collection-scoped grant identity from a caller
 * nonce. This identifier conveys no permission and cannot enroll another owner. */
export async function inferenceGrantId(ownerId: string, collectionId: string, nonce: string): Promise<string | undefined> {
  try {
    if (typeof ownerId !== "string" || !/^[a-f0-9]{64}$/.test(ownerId)
      || typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)
      || typeof collectionId !== "string" || !/^[1-9][0-9]{0,19}$/.test(collectionId)
      || BigInt(collectionId) > 18446744073709551615n) return;
    const fields = ["pear-mail-inference-grant-id-v1", ownerId, collectionId, nonce].map(field => encoder.encode(field));
    const bytes = new Uint8Array(fields.reduce((length, field) => length + 8 + field.length, 0));
    const view = new DataView(bytes.buffer);
    let offset = 0;
    for (const field of fields) { view.setBigUint64(offset, BigInt(field.length)); offset += 8; bytes.set(field, offset); offset += field.length; }
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
  } catch { return undefined; }
}
const boundaryWhitespace = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$/u;
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
  const descriptors = Object.getOwnPropertyDescriptors(value), ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return;
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return;
    copy[key] = descriptor.value;
  }
  return copy;
}
function text(value: unknown, bytes: number, multiline: boolean): value is string {
  return typeof value === "string" && value.length <= bytes && scalarString(value) && encoder.encode(value).length <= bytes
    && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u).test(value);
}
function canonicalInput(value: unknown): string | undefined {
  const data = record(value, ["adapter", "contractVersion", "instruction", "mail", "model", "outputTokens"]);
  if (!data || data.adapter !== "anthropic.messages.v1" || data.contractVersion !== 1
    || !text(data.instruction, 16 * 1024, true)
    || !text(data.model, 256, false) || !data.model.length || boundaryWhitespace.test(data.model)
    || typeof data.outputTokens !== "number" || !Number.isInteger(data.outputTokens) || data.outputTokens < 1 || data.outputTokens > 4096) return;
  const mail = record(data.mail, ["body", "cc", "direction", "from", "messageDate", "sanitizationVersion", "subject", "to"]);
  if (!mail || !text(mail.body, 160_000, true) || !text(mail.cc, 2048, false) || !text(mail.from, 2048, false)
    || !text(mail.to, 2048, false) || !text(mail.messageDate, 64, false) || !text(mail.subject, 1024, false)
    || mail.direction !== "received" && mail.direction !== "sent"
    || typeof mail.sanitizationVersion !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(mail.sanitizationVersion)) return;
  // Both levels use ASCII key order. The inner mail JSON is literal user
  // content; escaping it again in the outer request is part of the byte cost.
  const content = JSON.stringify({ body: mail.body, cc: mail.cc, direction: mail.direction, from: mail.from,
    messageDate: mail.messageDate, sanitizationVersion: mail.sanitizationVersion, subject: mail.subject, to: mail.to });
  const canonical = JSON.stringify({ max_tokens: data.outputTokens, messages: [{ content, role: "user" }], model: data.model, system: data.instruction });
  return encoder.encode(canonical).length <= 1024 * 1024 ? canonical : undefined;
}

/** Exact stateless text-only Anthropic Messages JSON. No normalization, extra
 * fields, tools, sessions, cache controls, streams or SDK defaults are added.
 * Fixed structural failures return undefined without content-bearing errors. */
export function canonicalInferencePayload(value: unknown): string | undefined {
  try { return canonicalInput(value); } catch { return undefined; }
}
function scalarTree(value: unknown): boolean {
  if (typeof value === "string") return scalarString(value);
  if (value !== null && typeof value === "object") return Object.values(value).every(scalarTree);
  return true;
}

/** Reconstruct S0 model.infer from actual full provider bytes and a matching
 * bound model. Copies all input before the first await, then delegates held
 * buffer preparation. No registry/authority/source checks or dispatch occur. */
export async function prepareMailInference(binding: unknown, payload: unknown): Promise<InferencePreparation> {
  try {
    const canonical = canonicalInferencePayload(payload);
    if (canonical === undefined) return { status: "denied", reason: "invalid_inference_payload" };
    const wire = JSON.parse(canonical) as { model: string; max_tokens: number };
    const data = record(binding, ["scope", "connectionId", "epoch", "processor"]);
    if (!data) return { status: "denied", reason: "invalid_inference_binding" };
    const proposal = canonicalOperation({ ...data, kind: "model.infer", purpose: "mail.summary", contractVersion: 1,
      inputBytes: 1, outputTokens: wire.max_tokens, payloadDigest: "0".repeat(64) });
    if (proposal === undefined) return { status: "denied", reason: "invalid_inference_binding" };
    const operation = JSON.parse(proposal) as ModelInfer;
    if (!scalarTree(operation) || operation.processor.model !== wire.model) return { status: "denied", reason: "invalid_inference_binding" };
    const bytes = encoder.encode(canonical), hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const payloadDigest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
    const result = await prepareOperation({ ...operation, inputBytes: bytes.length, payloadDigest }, bytes);
    if (result.status === "denied") return result;
    return { status: "prepared", request: result.request as FrozenMailInference };
  } catch { return { status: "denied", reason: "preparation_unavailable" }; }
}
