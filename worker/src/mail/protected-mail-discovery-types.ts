import type { LookupFunction } from "node:net";
import type { ConnectorDiscoveryV1, MailDiscoveryObservation } from "../../../packages/sentinel/src/index.js";

/** Host credential-service declaration. The complete canonical plan binds the
 * mode, cursor, observation head and limits. An echo is not a vault attestation. */
export interface ProtectedMailDiscoveryBinding {
  readonly discoveryId: string;
  readonly manifestDigest: string;
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
export interface ProtectedMailDiscoveryCredential {
  readonly binding: ProtectedMailDiscoveryBinding;
  readonly password: string;
}
export const protectedMailDiscoveryReasons = [
  "protocol_failure", "authentication_failed", "uid_validity_mismatch", "uid_next_rollback",
  "read_only_required", "limit_reached", "transport_closed", "tls_failure", "aborted",
  "deadline_exceeded", "discovery_expired",
] as const;
export type ProtectedMailDiscoveryReason = typeof protectedMailDiscoveryReasons[number];
export class ProtectedMailDiscoveryError extends Error {
  readonly reason: ProtectedMailDiscoveryReason;
  constructor(reason: ProtectedMailDiscoveryReason) {
    const fixed = (protectedMailDiscoveryReasons as readonly unknown[]).includes(reason) ? reason : "protocol_failure";
    super(fixed); this.reason = fixed; this.name = "ProtectedMailDiscoveryError"; Object.freeze(this);
  }
}
/** Internal seam; the sole host orchestrator first consumes a fresh claim. A
 * copied plan is not a reusable operation capability. */
export interface ProtectedMailDiscoverySessionOptions {
  readonly plan: ConnectorDiscoveryV1;
  readonly password: string;
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly ca?: string;
  readonly lookup?: LookupFunction;
}
export type ProtectedMailDiscoverySessionResult = MailDiscoveryObservation;
export type ProtectedMailDiscoveryOutcome = "Failed" | "Unknown" | "CancelledBeforeDispatch";
export interface ProtectedMailDiscoveryReport {
  readonly kind: "recorded" | "unknown";
  readonly eventNonce: string;
  readonly outcome: ProtectedMailDiscoveryOutcome;
}
