/** One-attempt protected inference procedure transport. This module releases a
 * request from the authority server; it never calls a model or credential vault.
 * A missing/invalid response can follow a committed claim and is always unknown.
 * Do not retry a payload claim or route it through a logging/generic SDK client. */
import { createHash } from "node:crypto";
import { canonicalInferencePayload } from "../../../packages/sentinel/src/index.js";

/** Host-owned authority origin/workspace/credential and transport. Never derive
 * these options from mail, model output, fetched content or a tool proposal. */
export interface ProtectedInferenceProcedureOptions {
  readonly baseUrl: string;
  readonly dbName: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}
export type ProtectedInferenceAdmissionArgs = readonly [grantId: string, runId: string,
  mail: readonly [id: string, revision: number, digest: string], eventNonce: string];
export interface ProtectedInferenceDispatch {
  readonly formatVersion: 1;
  readonly admissionId: string;
  readonly processor: Readonly<{ profileId: string; generation: number; revisionId: string; digest: string }>;
  readonly config: Readonly<{ formatVersion: 1; adapter: "anthropic.messages.v1"; endpoint: string;
    model: string; credentialHandle: string; credentialVersion: string }>;
  readonly method: "POST";
  readonly contentType: "application/json";
  readonly anthropicVersion: "2023-06-01";
  readonly payload: string;
  readonly payloadDigest: string;
  readonly operationFingerprint: string;
  readonly inputBytes: number;
  readonly outputTokens: number;
  readonly expiresAtMs: number;
}
const denials = [
  "protected_mail_inference_invalid_request", "protected_mail_inference_inconsistent",
  "protected_mail_inference_owner_required", "protected_mail_inference_broker_required",
  "protected_mail_inference_event_conflict", "protected_mail_inference_consumed",
  "protected_mail_inference_stale", "protected_mail_inference_budget_exceeded",
] as const;
type Denial = typeof denials[number] | "invalid_request";
export type ProtectedInferenceProcedureResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "denied"; readonly reason: Denial }
  | { readonly kind: "unknown"; readonly reason: "procedure_outcome_unknown" };

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const opaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
const safe = (value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const tuple = (value: unknown, size: number): value is unknown[] => Array.isArray(value) && value.length === size;
function boundedText(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.length <= bytes && value.length > 0 && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && Buffer.byteLength(value, "utf8") <= bytes;
}
function exactHttps(value: unknown): value is string {
  if (!boundedText(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password
      && !url.search && !url.hash && !value.includes("?") && !value.includes("#") && url.href === value;
  } catch { return false; }
}
function hashFields(domain: string, fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of [domain, ...fields]) {
    const bytes = Buffer.from(field, "utf8"), size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(size).update(bytes);
  }
  return hash.digest("hex");
}
function decodeDispatch(value: unknown, expectedId: string): ProtectedInferenceDispatch | undefined {
  if (!tuple(value, 13)) return;
  const [version, id, processor, config, method, contentType, anthropicVersion,
    payload, payloadDigest, operationFingerprint, inputBytes, outputTokens, expiresAtMs] = value;
  if (version !== 1 || id !== expectedId || !hex(id) || !tuple(processor, 4) || !tuple(config, 6)
    || method !== "POST" || contentType !== "application/json" || anthropicVersion !== "2023-06-01"
    || typeof payload !== "string" || !hex(payloadDigest) || !hex(operationFingerprint)
    || !safe(inputBytes, 1, MAX_PAYLOAD_BYTES) || !safe(outputTokens, 1, 4096) || !safe(expiresAtMs)) return;
  const [profileId, generation, revisionId, configDigest] = processor;
  const [configVersion, adapter, endpoint, model, credentialHandle, credentialVersion] = config;
  if (!opaque(profileId) || !safe(generation) || !boundedText(revisionId, 256) || !hex(configDigest)
    || configVersion !== 1 || !tuple(adapter, 2) || adapter[0] !== 0 || !tuple(adapter[1], 0)
    || !exactHttps(endpoint) || !boundedText(model, 256) || !opaque(credentialHandle) || !opaque(credentialVersion)) return;
  if (hashFields("pear-mail-processor-config-v1", ["1", "anthropic.messages.v1", endpoint, model, credentialHandle, credentialVersion]) !== configDigest) return;
  if (revisionId !== `mail-processor-revision:${hashFields("pear-mail-processor-revision-v1", [profileId, String(generation), configDigest])}`) return;
  if (Buffer.byteLength(payload, "utf8") !== inputBytes || createHash("sha256").update(payload, "utf8").digest("hex") !== payloadDigest) return;
  // Reconstruct the closed recipe. Canonical comparison rejects added fields,
  // duplicate JSON keys, alternate options and byte-changing normalization.
  const body: unknown = JSON.parse(payload);
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const request = body as Record<string, unknown>;
  if (!tuple(request.messages, 1) || !request.messages[0] || typeof request.messages[0] !== "object" || Array.isArray(request.messages[0])) return;
  const message = request.messages[0] as Record<string, unknown>;
  if (typeof message.content !== "string") return;
  const mail: unknown = JSON.parse(message.content);
  if (canonicalInferencePayload({ adapter: "anthropic.messages.v1", contractVersion: 1,
    instruction: request.system, mail, model, outputTokens }) !== payload) return;
  return Object.freeze({ formatVersion: 1, admissionId: id,
    processor: Object.freeze({ profileId, generation, revisionId, digest: configDigest }),
    config: Object.freeze({ formatVersion: 1, adapter: "anthropic.messages.v1", endpoint, model, credentialHandle, credentialVersion }),
    method, contentType, anthropicVersion, payload, payloadDigest, operationFingerprint, inputBytes, outputTokens, expiresAtMs });
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) throw Error("invalid_response");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !safe(Number(length), 1, MAX_RESPONSE_BYTES))) throw Error("invalid_response");
  if (!response.body) throw Error("invalid_response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let count = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw Error("invalid_response");
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > MAX_RESPONSE_BYTES) throw Error("invalid_response");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function procedure<T>(options: ProtectedInferenceProcedureOptions, name: string,
  args: readonly unknown[], decode: (value: unknown) => T | undefined): Promise<ProtectedInferenceProcedureResult<T>> {
  let target: string, token: string, timeout: number, body: string, fetchImpl: typeof fetch;
  try {
    const url = new URL(options.baseUrl);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.origin !== options.baseUrl || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.protocol !== "https:" && !(url.protocol === "http:" && loopback)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.dbName)
      || !/^[\x21-\x7e]{1,16384}$/.test(options.token)) return { kind: "denied", reason: "invalid_request" };
    timeout = options.timeoutMs ?? 15_000;
    if (!safe(timeout, 1, 60_000)) return { kind: "denied", reason: "invalid_request" };
    target = `${url.origin}/v1/database/${encodeURIComponent(options.dbName)}/call/${name}`;
    token = options.token;
    body = JSON.stringify(args);
    fetchImpl = options.fetchImpl ?? fetch;
  } catch { return { kind: "denied", reason: "invalid_request" }; }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = (async (): Promise<ProtectedInferenceProcedureResult<T>> => {
      const response = await fetchImpl(target, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
        referrerPolicy: "no-referrer", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body, signal: controller.signal });
      const result = await boundedJson(response, controller.signal);
      if (!tuple(result, 2)) throw Error("invalid_response");
      if (result[0] === 1 && typeof result[1] === "string" && (denials as readonly string[]).includes(result[1])) {
        return Object.freeze({ kind: "denied", reason: result[1] as Denial });
      }
      if (result[0] !== 0) throw Error("invalid_response");
      const value = decode(result[1]);
      if (value === undefined) throw Error("invalid_response");
      return Object.freeze({ kind: "ok", value });
    })();
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(Error("procedure_timeout")); }, timeout);
    });
    return await Promise.race([completed, expired]);
  } catch {
    return Object.freeze({ kind: "unknown", reason: "procedure_outcome_unknown" });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

/** Metadata-only admission. An explicit exact retry can recover its ID, but
 * this transport itself never retries an ambiguous attempt. */
export async function admitProtectedMailInference(options: ProtectedInferenceProcedureOptions,
  args: ProtectedInferenceAdmissionArgs): Promise<ProtectedInferenceProcedureResult<Readonly<{ admissionId: string }>>> {
  try {
    if (!tuple(args, 4) || !hex(args[0]) || !opaque(args[1]) || !tuple(args[2], 3)
      || !boundedText(args[2][0], 256) || args[2][1] !== 1 || !hex(args[2][2]) || !hex(args[3])) return { kind: "denied", reason: "invalid_request" };
    return await procedure(options, "admit_protected_mail_inference", args, value =>
      tuple(value, 1) && hex(value[0]) ? Object.freeze({ admissionId: value[0] }) : undefined);
  } catch { return { kind: "denied", reason: "invalid_request" }; }
}

/** A single payload release attempt. Any unknown result must remain consumed
 * or uncertain; never use a transport failure as authority to claim again. */
export async function beginProtectedMailInferenceDispatch(options: ProtectedInferenceProcedureOptions,
  admissionId: string): Promise<ProtectedInferenceProcedureResult<ProtectedInferenceDispatch>> {
  if (!hex(admissionId)) return { kind: "denied", reason: "invalid_request" };
  return procedure(options, "begin_protected_mail_inference_dispatch", [admissionId], value => decodeDispatch(value, admissionId));
}
