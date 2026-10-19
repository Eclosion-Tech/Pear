import { canonicalOperation, fingerprintOperation } from "./policy.js";
import type { Operation } from "./types.js";

// Typed-array instances can shadow byteLength. Use the intrinsic getter so a
// source-owned property cannot pad/truncate the copied view or trigger code.
const byteLengthOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!;

/** A frozen request, not a permit or authenticated token. Only trusted host
 * code may supply this structural interface. Admission still needs fresh host
 * authority and source records. copyPayload() never exposes the held buffer. */
export interface FrozenOperation {
  readonly operation: Operation;
  readonly canonical: string;
  readonly fingerprint: string;
  readonly copyPayload: () => Uint8Array | undefined;
}

export type Preparation =
  | { readonly status: "prepared"; readonly request: FrozenOperation }
  | { readonly status: "denied"; readonly reason:
      "invalid_operation" | "invalid_payload" | "payload_required" | "payload_unexpected"
      | "payload_size_mismatch" | "payload_digest_mismatch" | "preparation_unavailable" };

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Copy the operation and exact outgoing bytes before the first async boundary.
 * Validate actual bytes against the operation, rather than accepting a model's
 * digest/count as evidence. The host must provide the complete serialized wire
 * payload (including prompts/metadata), not only an excerpt from the email.
 * It must bound payload size and construct a fixed envelope whose semantics
 * match the operation. This helper does not inspect provider-specific bodies.
 * No eligibility, authority, budget, credential or transport checks occur here. */
export async function prepareOperation(proposal: unknown, payload?: Uint8Array): Promise<Preparation> {
  try {
    const canonical = canonicalOperation(proposal);
    if (canonical === undefined) return { status: "denied", reason: "invalid_operation" };
    const operation = freeze(JSON.parse(canonical) as Operation);
    let bytes: ArrayBuffer | undefined;
    if (operation.kind === "mail.read") {
      if (payload !== undefined) return { status: "denied", reason: "payload_unexpected" };
    } else {
      if (payload === undefined) return { status: "denied", reason: "payload_required" };
      try {
        if (!(payload instanceof Uint8Array)) return { status: "denied", reason: "invalid_payload" };
        const length: number = byteLengthOf.call(payload);
        const size = operation.kind === "mail.append" ? operation.bytes : operation.inputBytes;
        if (length !== size) return { status: "denied", reason: "payload_size_mismatch" };
        // Bound the view before allocating, bypass source-owned properties and
        // iterators, and retain no mutable caller-owned ArrayBuffer alias.
        bytes = new ArrayBuffer(length);
        new Uint8Array(bytes).set(payload);
      } catch {
        return { status: "denied", reason: "invalid_payload" };
      }
    }
    if (bytes !== undefined && operation.kind !== "mail.read") {
      const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
      if (digest !== operation.payloadDigest) return { status: "denied", reason: "payload_digest_mismatch" };
    }
    const fingerprint = await fingerprintOperation(operation);
    const held = bytes;
    return Object.freeze({ status: "prepared", request: Object.freeze({
      operation, canonical, fingerprint,
      copyPayload: () => held === undefined ? undefined : new Uint8Array(held.slice(0)),
    }) });
  } catch {
    // Never propagate an input/canonicalization/crypto exception to diagnostics.
    return { status: "denied", reason: "preparation_unavailable" };
  }
}
