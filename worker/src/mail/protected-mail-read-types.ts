import type { LookupFunction } from "node:net";
import type { ConnectorReadV1 } from "../../../packages/sentinel/src/index.js";

/** Host credential-service association. Echoing this structure is a trusted
 * resolver declaration, not proof that a vault or current configuration was
 * checked. No production credential adapter is installed by this module. */
export interface ProtectedMailReadBinding {
  readonly readId: string;
  readonly planDigest: string;
  readonly selectionId: string;
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
  readonly uidValidity: string;
  readonly uids: readonly number[];
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
}
export interface ProtectedMailReadCredential {
  readonly binding: ProtectedMailReadBinding;
  readonly password: string;
}
/** Private identifiers; digests do not anonymize message contents. */
export interface ProtectedMailReadMessageMetadata {
  readonly uid: number;
  readonly bytes: number;
  readonly digest: string;
}
export const protectedMailImapReasons = [
  "tls_failure", "protocol_failure", "authentication_failed", "uid_validity_mismatch",
  "read_only_required", "missing_uid", "uid_mismatch", "limit_reached", "incomplete_read",
  "transport_closed", "aborted", "deadline_exceeded", "read_expired",
] as const;
export type ProtectedMailImapReason = typeof protectedMailImapReasons[number];
export class ProtectedMailImapError extends Error {
  readonly reason: ProtectedMailImapReason;
  constructor(reason: ProtectedMailImapReason) {
    const fixed = (protectedMailImapReasons as readonly unknown[]).includes(reason) ? reason : "protocol_failure";
    super(fixed);
    this.reason = fixed;
    this.name = "ProtectedMailImapError";
    Object.freeze(this);
  }
}
/** Internal protocol seam. This is not a public plan execution capability.
 * The orchestrator consumes a fresh authority claim before invoking it. */
export interface ProtectedMailImapSessionOptions {
  readonly plan: ConnectorReadV1;
  readonly password: string;
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly ca?: string;
  readonly lookup?: LookupFunction;
}
export interface ProtectedMailImapSessionResult {
  readonly messages: readonly ProtectedMailReadMessageMetadata[];
  readonly bodyBytes: number;
}
export type ProtectedMailReadOutcome = "ReadReported" | "Failed" | "Unknown" | "CancelledBeforeDispatch";
export interface ProtectedMailReadReport {
  readonly kind: "recorded" | "unknown";
  readonly eventNonce: string;
  readonly outcome: ProtectedMailReadOutcome;
}
