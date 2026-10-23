import type { LookupFunction } from "node:net";
import type { ConnectorSparseReadV1 } from "../../../packages/sentinel/src/index.js";

/** Host credential-service declaration. The exact canonical plan binds every
 * observation/cursor/target/limit field. An echo is not vault attestation. */
export interface ProtectedMailSparseReadBinding {
  readonly readId: string;
  readonly planDigest: string;
  readonly canonical: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly connectionId: string;
  readonly connectionEpoch: string;
  readonly snapshotDigest: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly folder: string;
  readonly direction: "received" | "sent";
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
}
export interface ProtectedMailSparseReadCredential {
  readonly binding: ProtectedMailSparseReadBinding;
  readonly password: string;
}
export const protectedMailSparseReadImapReasons = Object.freeze([
  "tls_failure", "protocol_failure", "authentication_failed", "uid_validity_mismatch", "uid_next_rollback",
  "read_only_required", "missing_uid", "uid_mismatch", "limit_reached", "incomplete_read",
  "transport_closed", "aborted", "deadline_exceeded", "read_expired",
] as const);
export type ProtectedMailSparseReadImapReason = typeof protectedMailSparseReadImapReasons[number];
export class ProtectedMailSparseReadImapError extends Error {
  readonly reason: ProtectedMailSparseReadImapReason;
  constructor(reason: ProtectedMailSparseReadImapReason) {
    const fixed = (protectedMailSparseReadImapReasons as readonly unknown[]).includes(reason) ? reason : "protocol_failure";
    super(fixed); this.reason = fixed; this.name = "ProtectedMailSparseReadImapError"; Object.freeze(this);
  }
}
/** Internal seam. The host orchestrator must first consume a fresh c7 claim;
 * a copied plan is neither an execution permit nor a raw-content sink. */
export interface ProtectedMailSparseReadSessionOptions {
  readonly plan: ConnectorSparseReadV1;
  readonly password: string;
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly ca?: string;
  readonly lookup?: LookupFunction;
}
/** INTERNAL metadata for protocol conformance. The executor's public result
 * must never contain these UID, byte-count or body-derived digest fields. */
export interface ProtectedMailSparseReadMessageMetadata {
  readonly uid: number;
  readonly bytes: number;
  readonly digest: string;
}
export interface ProtectedMailSparseReadSessionResult {
  readonly messages: readonly ProtectedMailSparseReadMessageMetadata[];
  readonly bodyBytes: number;
}
