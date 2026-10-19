/** OFFLINE TEST SUPPORT ONLY.
 * This models admission and dispatch using in-memory state and synthetic sinks.
 * It provides neither durable admission nor process, credential, or network
 * isolation. Scripted model proposals are data; arbitrary code is not sandboxed.
 */
import {
  evaluateEligibility,
  isSnapshot,
  prepareOperation,
  type DenialReason,
  type FrozenOperation,
  type Operation,
  type PolicySnapshot,
  type Preparation,
  type SourceRef,
} from "../../src/index.js";

type PreparationReason = Extract<Preparation, { status: "denied" }>["reason"];
export type TestReason = DenialReason | PreparationReason
  | "test_invocation_consumed" | "test_claim_unknown" | "test_claim_consumed"
  | "test_authority_changed" | "test_sink_outcome_unknown";

export interface TestClaim {
  readonly testOnlyClaimId: string;
}

export interface TestReceipt {
  readonly event: "preparation_denied" | "eligibility_denied" | "claim_denied"
    | "test_claimed" | "dispatch_denied" | "test_dispatched" | "test_completed" | "test_unknown";
  readonly reason?: TestReason;
  readonly claimId?: string;
}

interface Charge {
  operations: number;
  messages: number;
  readBytes: number;
  inputBytes: number;
  outputTokens: number;
  appendBytes: number;
}

function chargeFor(operation: Operation): Charge {
  const charge = { operations: 1, messages: 0, readBytes: 0, inputBytes: 0, outputTokens: 0, appendBytes: 0 };
  switch (operation.kind) {
    case "mail.read": charge.messages = operation.messages; charge.readBytes = operation.bytes; break;
    case "mail.append": charge.appendBytes = operation.bytes; break;
    case "content.screen": charge.inputBytes = operation.inputBytes; break;
    case "model.infer": charge.inputBytes = operation.inputBytes; charge.outputTokens = operation.outputTokens; break;
  }
  return charge;
}

function adjusted(snapshot: PolicySnapshot, charge: Charge, direction: 1 | -1): PolicySnapshot {
  const remaining = { ...snapshot.remaining };
  for (const key of Object.keys(charge) as Array<keyof Charge>) {
    remaining[key] += direction * charge[key];
  }
  return { ...snapshot, remaining };
}

interface ClaimRecord {
  readonly request: FrozenOperation;
  readonly authorityVersion: number;
  readonly charge: Charge;
  readonly parents: readonly SourceRef[];
  state: "claimed" | "dispatched" | "completed" | "unknown" | "cancelled";
}

type Denied = { readonly status: "denied"; readonly reason: TestReason };

/** A deliberately non-durable test double. All administrative methods are for
 * trusted test fixtures and are never exposed through the proposal channel.
 * Synchronous claim/dispatch transitions simulate a serialized transaction;
 * they do not establish database atomicity or recovery across processes. */
export class TestAuthorityStore {
  #snapshot: PolicySnapshot;
  #authorityVersion = 0;
  #sequence = 0;
  #claims = new WeakMap<object, ClaimRecord>();
  #invocations = new Set<string>();

  constructor(snapshot: PolicySnapshot) {
    if (!isSnapshot(snapshot)) throw new Error("test_invalid_snapshot");
    this.#snapshot = structuredClone(snapshot);
  }

  snapshot(): PolicySnapshot { return structuredClone(this.#snapshot); }

  checkedSnapshot(): { readonly snapshot: PolicySnapshot; readonly authorityVersion: number } {
    return { snapshot: this.snapshot(), authorityVersion: this.#authorityVersion };
  }

  /** Test-host mutation, including source policies and grant changes. */
  updateAuthority(update: (snapshot: PolicySnapshot) => PolicySnapshot): void {
    const next = update(this.snapshot());
    if (!isSnapshot(next)) throw new Error("test_invalid_snapshot");
    this.#snapshot = structuredClone(next);
    this.#authorityVersion += 1;
  }

  /** A fake trusted clock. Time changes still require a fresh expiry check. */
  setNow(nowMs: number): void {
    const next = { ...this.#snapshot, nowMs };
    if (!isSnapshot(next)) throw new Error("test_invalid_snapshot");
    this.#snapshot = next;
  }

  /** Only the harness's trusted preparation path supplies request here. A
   * FrozenOperation is not itself authority, nor an authenticated capability. */
  claim(hostEffectId: string, request: FrozenOperation, checkedAuthorityVersion: number): Denied | { status: "claimed"; claim: TestClaim } {
    const operation = request.operation;
    // Host-chosen logical work IDs survive retries and replacement child/run
    // identities in this *in-process* fake ledger. They are never model input.
    const invocation = JSON.stringify([
      operation.scope.workspaceId, operation.connectionId, hostEffectId,
    ]);
    if (this.#invocations.has(invocation)) return { status: "denied", reason: "test_invocation_consumed" };
    // A later permissive snapshot cannot erase the sources that influenced
    // these prepared bytes. Budget debits alone do not change this version.
    if (checkedAuthorityVersion !== this.#authorityVersion) return { status: "denied", reason: "test_authority_changed" };
    // Read live fixture state inside the same synchronous transition as debit.
    const decision = evaluateEligibility(this.#snapshot, operation);
    if (decision.status === "denied") return decision;
    const charge = chargeFor(operation);
    this.#snapshot = adjusted(this.#snapshot, charge, -1);
    this.#invocations.add(invocation);
    const claim = Object.freeze({ testOnlyClaimId: `test-claim-${++this.#sequence}` });
    this.#claims.set(claim, {
      request, authorityVersion: this.#authorityVersion, charge,
      parents: structuredClone(this.#snapshot.exposures), state: "claimed",
    });
    return { status: "claimed", claim };
  }

  beginDispatch(claim: unknown): Denied | {
    status: "dispatchable"; request: FrozenOperation; parents: readonly SourceRef[];
  } {
    const record = this.#record(claim);
    if (!record) return { status: "denied", reason: "test_claim_unknown" };
    if (record.state !== "claimed") return { status: "denied", reason: "test_claim_consumed" };
    if (record.authorityVersion !== this.#authorityVersion) {
      record.state = "cancelled";
      return { status: "denied", reason: "test_authority_changed" };
    }
    // The current claim's budget was already reserved. Restore only its own
    // reservation in the *check*, without refunding stored counters. This avoids
    // rejecting the last allowed operation merely because remaining is now 0.
    const decision = evaluateEligibility(adjusted(this.#snapshot, record.charge, 1), record.request.operation);
    if (decision.status === "denied") {
      record.state = "cancelled";
      return decision;
    }
    // No await separates this fresh check from the synthetic dispatch start.
    record.state = "dispatched";
    return { status: "dispatchable", request: record.request, parents: structuredClone(record.parents) };
  }

  finish(claim: TestClaim, outcome: "completed" | "unknown"): void {
    const record = this.#record(claim);
    if (!record || record.state !== "dispatched") throw new Error("test_invalid_transition");
    record.state = outcome;
  }

  state(claim: unknown): ClaimRecord["state"] | undefined { return this.#record(claim)?.state; }

  #record(claim: unknown): ClaimRecord | undefined {
    return claim !== null && typeof claim === "object" ? this.#claims.get(claim) : undefined;
  }
}

export interface SinkCapture {
  readonly operation: Operation;
  readonly fingerprint: string;
  readonly payload?: Uint8Array;
  readonly parents: readonly SourceRef[];
}

export interface DerivedEvidence {
  readonly parents: readonly SourceRef[];
  readonly copyBytes: () => Uint8Array;
}

/** Private synthetic captures, not ordinary audit/telemetry. No real transport,
 * mailbox, database, provider, classifier or credentials are used here. */
class SyntheticSinks {
  #captures: SinkCapture[] = [];
  #replies = new Map<Operation["kind"], Uint8Array>();
  #failures = new Map<Operation["kind"], unknown>();

  captures(): SinkCapture[] { return structuredClone(this.#captures); }

  replyNext(kind: Operation["kind"], bytes: Uint8Array): void {
    this.#replies.set(kind, new Uint8Array(bytes));
  }

  /** Failure is after capture: the caller cannot know whether the synthetic
   * destination accepted the effect. The raw error must never reach receipts. */
  failAfterCapture(kind: Operation["kind"], error: unknown): void { this.#failures.set(kind, error); }

  async dispatch(request: FrozenOperation, parents: readonly SourceRef[], afterCapture?: () => void | Promise<void>): Promise<DerivedEvidence | undefined> {
    this.#captures.push({
      operation: structuredClone(request.operation), fingerprint: request.fingerprint,
      payload: request.copyPayload(), parents: structuredClone(parents),
    });
    // Bind a scripted result to this dispatch before a test hook yields, so a
    // concurrent request cannot consume the earlier request's result.
    const failed = this.#failures.has(request.operation.kind);
    const failure = this.#failures.get(request.operation.kind);
    this.#failures.delete(request.operation.kind);
    const reply = this.#replies.get(request.operation.kind);
    this.#replies.delete(request.operation.kind);
    await afterCapture?.();
    if (failed) throw failure;
    if (reply === undefined) return undefined;
    const held = new Uint8Array(reply);
    const heldParents = Object.freeze(parents.map((ref) => Object.freeze({ ...ref })));
    return Object.freeze({ parents: heldParents, copyBytes: () => new Uint8Array(held) });
  }
}

export interface TestHooks {
  readonly afterPreparation?: (request: FrozenOperation) => void | Promise<void>;
  readonly afterEligibility?: () => void | Promise<void>;
  readonly afterClaim?: (claim: TestClaim) => void | Promise<void>;
  readonly afterDispatch?: () => void | Promise<void>;
}

export type AttemptResult =
  | { readonly status: "denied"; readonly phase: "preparation" | "eligibility" | "claim" | "dispatch"; readonly reason: TestReason }
  | { readonly status: "completed"; readonly claim: TestClaim; readonly evidence?: DerivedEvidence }
  | { readonly status: "unknown"; readonly claim: TestClaim; readonly reason: "test_sink_outcome_unknown" };

export class ContainmentHarness {
  readonly authority: TestAuthorityStore;
  #sink = new SyntheticSinks();
  readonly sinks = Object.freeze({
    captures: () => this.#sink.captures(),
    replyNext: (kind: Operation["kind"], bytes: Uint8Array) => this.#sink.replyNext(kind, bytes),
    failAfterCapture: (kind: Operation["kind"], error: unknown) => this.#sink.failAfterCapture(kind, error),
  });
  #receipts: TestReceipt[] = [];

  constructor(snapshot: PolicySnapshot) { this.authority = new TestAuthorityStore(snapshot); }
  receipts(): TestReceipt[] { return structuredClone(this.#receipts); }

  async attempt(hostEffectId: string, proposal: unknown, payload?: Uint8Array, hooks: TestHooks = {}): Promise<AttemptResult> {
    // Capture host-observed exposure and policy state before preparation yields.
    const checked = this.authority.checkedSnapshot();
    const prepared = await prepareOperation(proposal, payload);
    if (prepared.status === "denied") {
      this.#receipts.push({ event: "preparation_denied", reason: prepared.reason });
      return { ...prepared, phase: "preparation" };
    }
    await hooks.afterPreparation?.(prepared.request);
    const decision = evaluateEligibility(checked.snapshot, prepared.request.operation);
    if (decision.status === "denied") {
      this.#receipts.push({ event: "eligibility_denied", reason: decision.reason });
      return { ...decision, phase: "eligibility" };
    }
    await hooks.afterEligibility?.();
    const admitted = this.authority.claim(hostEffectId, prepared.request, checked.authorityVersion);
    if (admitted.status === "denied") {
      this.#receipts.push({ event: "claim_denied", reason: admitted.reason });
      return { ...admitted, phase: "claim" };
    }
    this.#receipts.push({ event: "test_claimed", claimId: admitted.claim.testOnlyClaimId });
    await hooks.afterClaim?.(admitted.claim);
    return this.dispatch(admitted.claim, hooks.afterDispatch);
  }

  /** Even the fake dispatcher requires a registered one-use claim. Keeping
   * these objects private from proposal data is an application contract only;
   * this same-process helper does not constrain arbitrary JavaScript code. */
  async dispatch(claim: unknown, afterCapture?: () => void | Promise<void>): Promise<AttemptResult> {
    const started = this.authority.beginDispatch(claim);
    if (started.status === "denied") {
      this.#receipts.push({ event: "dispatch_denied", reason: started.reason });
      return { ...started, phase: "dispatch" };
    }
    const knownClaim = claim as TestClaim;
    this.#receipts.push({ event: "test_dispatched", claimId: knownClaim.testOnlyClaimId });
    try {
      const evidence = await this.#sink.dispatch(started.request, started.parents, afterCapture);
      this.authority.finish(knownClaim, "completed");
      this.#receipts.push({ event: "test_completed", claimId: knownClaim.testOnlyClaimId });
      return { status: "completed", claim: knownClaim, evidence };
    } catch {
      this.authority.finish(knownClaim, "unknown");
      this.#receipts.push({ event: "test_unknown", reason: "test_sink_outcome_unknown", claimId: knownClaim.testOnlyClaimId });
      return { status: "unknown", claim: knownClaim, reason: "test_sink_outcome_unknown" };
    }
  }
}
