/** Opt-in, bounded observer for finalized Orcha plans. Never edits the graph or executes advice. */
import { createHash } from "node:crypto";
import type { TaskSpec } from "./llm.js";
import { discoverExecutionProfiles, type BillingObservation, type DiscoveryConnection } from "./routing-discovery.js";
import { recommendRoute, type AdvisorOptions, type ExecutionProfile, type RoutingAdvice,
  type RoutingPolicy, type RoutingTask } from "./routing.js";

export interface OrchaAdvisoryContext {
  readonly jobId: string;
  readonly orchestrateTaskId: string;
  readonly aiUserId: bigint;
  readonly principalId: string;
  readonly connection: DiscoveryConnection;
  readonly nowMs: number;
}
export interface OrchaAdvisoryPreparation {
  readonly jobId: string;
  readonly orchestrateTaskId: string;
  readonly planFingerprint: string;
  readonly specIndex: number;
  readonly principalId: string;
  readonly aiUserId: string;
  readonly description: string;
  readonly requiredCapabilities: readonly string[];
  /** Discovered references/fingerprints only. Never contains config credentials. */
  readonly profiles: readonly ExecutionProfile[];
}
export interface OrchaAdvisoryConfig {
  /** Explicitly approved context, not automatically copied from full page context. */
  readonly summary: string;
  readonly artifacts: RoutingTask["artifacts"];
  readonly taskProfile: string;
  readonly requiredCapabilities: readonly string[];
  readonly pinnedProfileId?: string;
  readonly policy: Omit<RoutingPolicy, "nowMs">;
  readonly advisor: AdvisorOptions;
  readonly billingObservations?: readonly BillingObservation[];
}
export interface OrchaAdviceReport {
  readonly jobId: string;
  readonly orchestrateTaskId: string;
  /** Index identifies an advisory plan entry, NOT a durable new Orcha task ID. */
  readonly specIndex: number;
  readonly planFingerprint: string;
  readonly discoveryWarnings: readonly string[];
  readonly advice: RoutingAdvice;
}
export interface OrchaAdvisoryHook {
  /** Trusted host callback. Undefined means this task/context is not approved. */
  prepare(context: OrchaAdvisoryPreparation): OrchaAdvisoryConfig | undefined;
  /** Host must store/display only on an authorized surface; no public-table default. */
  onAdvice(report: OrchaAdviceReport): void | Promise<void>;
  /** Bounds entries examined per plan, not an account-wide spending budget. Default 1. */
  readonly maxTasksPerPlan?: number;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export async function observeOrchaPlan(context: OrchaAdvisoryContext, specs: readonly TaskSpec[],
  hook?: OrchaAdvisoryHook): Promise<readonly OrchaAdviceReport[]> {
  if (!hook) return [];
  const limit = hook.maxTasksPerPlan ?? 1;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error("Invalid Orcha advisory limit");
  const snapshot = freeze(specs.map(s => ({ description: s.description, task_type: s.task_type,
    depends_on: [...s.depends_on], required_capabilities: [...s.required_capabilities] })));
  const planFingerprint = hash(snapshot);
  const preview = discoverExecutionProfiles(context.connection, {
    principalId: context.principalId, aiUserId: context.aiUserId, nowMs: context.nowMs,
    maxObservationAgeMs: 0, // No billing observations applied to this preview.
  });
  const reports: OrchaAdviceReport[] = [];
  for (let specIndex = 0; specIndex < Math.min(limit, snapshot.length); specIndex++) {
    const spec = snapshot[specIndex];
    const prepared = hook.prepare(freeze({ jobId: context.jobId, orchestrateTaskId: context.orchestrateTaskId,
      planFingerprint, specIndex, principalId: context.principalId, aiUserId: String(context.aiUserId),
      description: spec.description, requiredCapabilities: [...spec.required_capabilities],
      profiles: preview.profiles.map(p => ({ ...p, capabilities: [...p.capabilities], taskProfiles: [...p.taskProfiles] })) }));
    if (!prepared) continue;
    const discovery = discoverExecutionProfiles(context.connection, {
      principalId: context.principalId, aiUserId: context.aiUserId, nowMs: context.nowMs,
      maxObservationAgeMs: prepared.policy.maxObservationAgeMs, billingObservations: prepared.billingObservations,
    });
    const task: RoutingTask = { id: `plan-${context.orchestrateTaskId}-${specIndex}`,
      principalId: context.principalId, aiUserId: String(context.aiUserId), summary: prepared.summary,
      artifacts: prepared.artifacts, taskProfile: prepared.taskProfile,
      requiredCapabilities: prepared.requiredCapabilities, pinnedProfileId: prepared.pinnedProfileId,
      contextFingerprint: hash({ planFingerprint, specIndex, summary: prepared.summary, artifacts: prepared.artifacts }) };
    const advice = await recommendRoute(task, { ...prepared.policy, nowMs: context.nowMs }, discovery.profiles, prepared.advisor);
    const report = freeze({ jobId: context.jobId, orchestrateTaskId: context.orchestrateTaskId,
      specIndex, planFingerprint, discoveryWarnings: [...discovery.warnings], advice });
    reports.push(report);
    // A sink failure must not reject the plan, retry inference or block execution.
    try { void Promise.resolve(hook.onAdvice(report)).catch(() => {}); } catch { /* diagnostic sink only */ }
  }
  return reports;
}
