import { isOperation, isSnapshot } from "./validate.js";
import type { Eligibility, DenialReason, PrivateStorage, Processor, RunScope, SourceRef, SourceRevision } from "./types.js";

const deny = (reason: DenialReason): Eligibility => ({ status: "denied", reason });
const sameScope = (a: RunScope, b: RunScope): boolean =>
  a.workspaceId === b.workspaceId && a.principalId === b.principalId
  && a.runtimeId === b.runtimeId && a.runId === b.runId && a.parentRunId === b.parentRunId;
const sameProcessor = (a: Processor, b: Processor): boolean =>
  a.profileId === b.profileId && a.revision === b.revision && a.endpoint === b.endpoint && a.model === b.model;
const sameStorage = (a: PrivateStorage, b: PrivateStorage): boolean =>
  a.workspaceId === b.workspaceId && a.rootId === b.rootId && a.ownerId === b.ownerId;
const sameRef = (a: SourceRef, b: SourceRef): boolean =>
  a.id === b.id && a.revision === b.revision && a.digest === b.digest;
const refKey = (ref: SourceRef): string => JSON.stringify([ref.id, ref.revision]);

/** Host-provided snapshot is a trusted input, not an authenticated capability.
 * Every eligible operation still needs transactional admission, live ACL/epoch
 * checks and a constrained dispatcher. This function has no side effects. */
export function evaluateEligibility(snapshot: unknown, proposal: unknown): Eligibility {
  if (!isSnapshot(snapshot)) return deny("invalid_snapshot");
  if (!isOperation(proposal)) return deny("invalid_operation");
  const { grant, scope, remaining } = snapshot;
  if (!sameScope(scope, grant.scope) || !sameScope(scope, proposal.scope)) return deny("scope_mismatch");
  if (snapshot.epoch !== grant.epoch || snapshot.epoch !== proposal.epoch) return deny("stale_epoch");
  if (snapshot.nowMs < grant.notBeforeMs || snapshot.nowMs >= grant.expiresAtMs) return deny("grant_not_active");
  if (proposal.connectionId !== grant.connectionId) return deny("connection_mismatch");
  if (grant.destination.workspaceId !== scope.workspaceId || grant.destination.ownerId !== scope.principalId) {
    return deny("destination_denied");
  }
  if (remaining.operations < 1) return deny("budget_exceeded");

  // Resolve all context exposure and parent restrictions. A derived result
  // cannot opt out of its parents by supplying narrower citations or labels.
  const sources = new Map<string, SourceRevision>();
  for (const source of snapshot.sources) {
    const key = refKey(source.ref);
    if (sources.has(key)) return deny("source_conflict");
    sources.set(key, source);
  }
  const resolved = new Map<string, SourceRevision>();
  const visiting = new Set<string>();
  function visit(ref: SourceRef): DenialReason | undefined {
    const key = refKey(ref);
    const source = sources.get(key);
    if (!source || !sameRef(ref, source.ref)) return "source_missing";
    if (source.workspaceId !== scope.workspaceId) return "source_workspace_mismatch";
    if (visiting.has(key)) return "source_cycle";
    if (resolved.has(key)) return;
    visiting.add(key);
    for (const parent of source.parents) {
      const failure = visit(parent);
      if (failure) return failure;
    }
    visiting.delete(key);
    resolved.set(key, source);
  }
  for (const exposure of snapshot.exposures) {
    const failure = visit(exposure);
    if (failure) return deny(failure);
  }

  const within = (value: number, max: number, available: number): boolean => value <= max && value <= available;
  if (proposal.kind === "mail.read") {
    if (proposal.mailbox.host !== grant.mailbox.host || proposal.mailbox.port !== grant.mailbox.port
      || proposal.mailbox.folders.some((folder) => !grant.mailbox.folders.includes(folder))) {
      return deny("destination_denied");
    }
    if (!within(proposal.messages, grant.limits.messages, remaining.messages)
      || !within(proposal.bytes, grant.limits.readBytes, remaining.readBytes)) return deny("budget_exceeded");
  } else {
    if (!resolved.size) return deny("source_required");
    if (proposal.kind !== "content.screen") {
      if (snapshot.screening === "hold") return deny("screening_hold");
      if (snapshot.screening === "unavailable") return deny("screening_unavailable");
    }
    if (proposal.kind === "mail.append") {
      if (!sameStorage(proposal.destination, grant.destination)) return deny("destination_denied");
      if ([...resolved.values()].some((source) => !source.storage.some((sink) => sameStorage(sink, proposal.destination)))) {
        return deny("source_disclosure_denied");
      }
      if (!within(proposal.bytes, grant.limits.appendBytes, remaining.appendBytes)) return deny("budget_exceeded");
    } else {
      const approved = proposal.kind === "content.screen" ? grant.screeningProcessor : grant.summaryProcessor;
      if (!approved || !sameProcessor(proposal.processor, approved)) return deny("destination_denied");
      if ([...resolved.values()].some((source) => !source.processors.some((sink) => sameProcessor(sink, proposal.processor)))) {
        return deny("source_disclosure_denied");
      }
      if (!within(proposal.inputBytes, grant.limits.inputBytes, remaining.inputBytes)) return deny("budget_exceeded");
      if (proposal.kind === "model.infer"
        && !within(proposal.outputTokens, grant.limits.outputTokens, remaining.outputTokens)) return deny("budget_exceeded");
    }
  }
  return { status: "eligible", requiresAdmission: true };
}

/** Stable JSON for a validated operation, suitable as fingerprint input.
 * Data digests must be computed from actual frozen payload bytes by the host;
 * the model cannot vouch for either a digest or its source exposure set. */
export function canonicalOperation(value: unknown): string | undefined {
  if (!isOperation(value)) return undefined;
  function sorted(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sorted);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]));
    }
    return input;
  }
  return JSON.stringify(sorted(value));
}

/** Web Crypto only: usable in browser/edge/Node hosts without node imports.
 * This hashes an operation, not its grant/authority, and does not mint a permit. */
export async function fingerprintOperation(value: unknown): Promise<string> {
  const canonical = canonicalOperation(value);
  if (canonical === undefined) throw new Error("invalid_operation");
  const bytes = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
