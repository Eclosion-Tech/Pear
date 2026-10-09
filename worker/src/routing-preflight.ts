/** Explicit prompt-free Bridge probe. No SQL/admin fallback, classifier or execution routing. */
import { randomUUID } from "node:crypto";
import type { OrchaAdvisoryHook } from "./orcha-routing.js";
import { discoverExecutionProfiles, type BillingObservation, type DiscoveryConnection } from "./routing-discovery.js";

/** Explicitly installed by a host; never constructed in existing entry points. */
export function createBridgeBillingObserver(config: { maxProfiles: number; timeoutMs: number }):
  NonNullable<OrchaAdvisoryHook["observeBilling"]> {
  const { maxProfiles, timeoutMs } = config;
  if (!Number.isInteger(maxProfiles) || maxProfiles < 1 || maxProfiles > 2
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid Bridge observation budget");
  return { timeoutMs, async collect(context, prepared, signal) {
    const conn = context.connection as PreflightConnection;
    if (typeof conn.reducers?.enqueueBridgeInference !== "function"
      || signal.aborted || !prepared.advisor.consent.enabled
      || !prepared.policy.allowedBilling.includes("subscription")) return [];
    const deadline = Date.now() + timeoutMs;
    const profiles = discoverExecutionProfiles(conn, { principalId: context.principalId,
      aiUserId: context.aiUserId, nowMs: Date.now(), maxObservationAgeMs: prepared.policy.maxObservationAgeMs }).profiles
      .filter(p => prepared.policy.approvedProfileIds.includes(p.id)
        && (!prepared.pinnedProfileId || prepared.pinnedProfileId === p.id)
        && prepared.policy.allowedWorkerDestinations.includes(p.destination)
        && p.taskProfiles.includes(prepared.taskProfile)
        && prepared.requiredCapabilities.every(c => p.capabilities.includes(c)))
      .filter(p => /^bridge_[1-9][0-9]*_(claude-code|codex)$/.test(p.id)).slice(0, maxProfiles);
    const observations: BillingObservation[] = [];
    for (const profile of profiles) {
      const remaining = deadline - Date.now();
      if (signal.aborted || remaining < 1) break;
      const result = await probeBridgeRoutingProfile(conn, { principalId: context.principalId,
        aiUserId: context.aiUserId, profileId: profile.id, approved: true,
        timeoutMs: Math.min(30_000, remaining), signal });
      if (result.status === "observed") observations.push(result.observation);
    }
    return observations;
  } };
}

export interface PreflightConnection extends DiscoveryConnection {
  reducers: { enqueueBridgeInference(args: {
    deviceId: bigint; provider: string; model: string; payloadJson: string;
    conversationId: bigint; jobId: undefined; taskId: undefined; nonce: string;
  }): Promise<void> | void };
}
export interface RoutingPreflightOptions {
  principalId: string;
  aiUserId: bigint;
  profileId: string;
  /** Explicit approval for these local read-only checks, not classifier consent. */
  approved: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}
export type RoutingPreflightResult = {
  status: "observed";
  commandId: string;
  observation: BillingObservation;
  /** Honest evidence labels, not an invoice audit, quota meter or harness readiness. */
  evidence: { auth: "subscription_login"; extraUsage: "operator_attested_disabled"; readiness: "auth_preflight_only" };
} | { status: "unavailable"; reason: string };
interface ResultRow {
  commandId: bigint; requestedBy: { toHexString(): string };
  completedAt: { microsSinceUnixEpoch: bigint };
  exitCode?: number; rejectionReason?: string; stdout: string;
}
interface Table<T> { iter(): Iterable<T> }
const MAX_AGE_MS = 30_000;
function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}
export async function probeBridgeRoutingProfile(conn: PreflightConnection,
  input: RoutingPreflightOptions): Promise<RoutingPreflightResult> {
  const options = Object.freeze({ ...input });
  const fail = (reason: string): RoutingPreflightResult => ({ status: "unavailable", reason });
  if (!options.approved) return fail("not_approved");
  if (!/^[a-f0-9]{64}$/.test(options.principalId) || options.aiUserId <= 0n
    || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_AGE_MS) return fail("invalid_options");
  if (options.signal?.aborted) return fail("cancelled");
  const startedAt = Date.now();
  const discover = () => discoverExecutionProfiles(conn, { principalId: options.principalId,
    aiUserId: options.aiUserId, nowMs: Date.now(), maxObservationAgeMs: MAX_AGE_MS });
  const profile = discover().profiles.find(p => p.id === options.profileId);
  const match = /^bridge_([1-9][0-9]*)_(claude-code|codex)$/.exec(options.profileId);
  if (!profile || !match || profile.grant !== "granted" || profile.availability !== "available"
    || !profile.taskProfiles.includes("chat") || !profile.capabilities.includes("llm")
    || !profile.configurationFingerprint) return fail("profile_unavailable");
  const deviceId = BigInt(match[1]), provider = match[2];
  const configurationFingerprint = profile.configurationFingerprint;
  const db = conn.db as Record<string, unknown>;
  const caps = (db.bridge_device_capability ?? db.bridgeDeviceCapability) as Table<{deviceId: bigint; provider: string; version?: string}> | undefined;
  const version = caps && [...caps.iter()].find(c => c.deviceId === deviceId && c.provider === provider)?.version;
  const results = (db.bridge_command_result ?? db.bridgeCommandResult) as Table<ResultRow> | undefined;
  if (!version || !results) return fail("probe_transport_unavailable");
  const nonce = randomUUID();
  const payload = { operation: "subscription-preflight-v1", provider, profile_id: profile.id,
    configuration_fingerprint: configurationFingerprint, ai_user_id: String(options.aiUserId),
    principal_id: options.principalId, request_nonce: nonce, expected_cli_version: version };
  const deadline = startedAt + options.timeoutMs;
  let stopped = false;
  const cancelled = () => stopped || options.signal?.aborted || Date.now() >= deadline;
  // One finite wait budget covers enqueue and polling. Timeout does not cancel
  // a queued read-only probe, and never causes a re-enqueue or inference retry.
  const work = async (): Promise<RoutingPreflightResult> => {
    try {
      await conn.reducers.enqueueBridgeInference({ deviceId, provider, model: "",
        payloadJson: JSON.stringify(payload), conversationId: 0n, jobId: undefined, taskId: undefined, nonce });
      while (!cancelled()) {
        for (const row of results.iter()) {
          if (row.requestedBy?.toHexString() !== options.principalId || row.stdout.length > 16_384) continue;
          let envelope: Record<string, unknown> | undefined, evidence: Record<string, unknown> | undefined;
          try {
            envelope = record(JSON.parse(row.stdout));
            evidence = typeof envelope?.output === "string" ? record(JSON.parse(envelope.output)) : undefined;
          } catch { continue; }
          if (evidence?.request_nonce !== nonce) continue;
          if (envelope?.ok === false) return fail("preflight_refused");
          // A result is only evidence when it carries the daemon's actual
          // command/device/principal context, not merely caller-supplied labels.
          const completed = typeof row.completedAt?.microsSinceUnixEpoch === "bigint"
            ? Number(row.completedAt.microsSinceUnixEpoch) / 1000 : NaN;
          if (row.exitCode !== 0 || row.rejectionReason || envelope?.ok !== true
            || envelope.provider !== "routing-preflight" || envelope.usage != null || envelope.tool_calls != null
            || evidence.schema !== "bridge-subscription-evidence-v1" || evidence.no_inference !== true
            || evidence.command_id !== String(row.commandId) || evidence.device_id !== String(deviceId)
            || typeof evidence.session_id !== "string" || !/^[1-9][0-9]*$/.test(evidence.session_id)
            || evidence.principal_id !== options.principalId || evidence.ai_user_id !== String(options.aiUserId)
            || evidence.profile_id !== profile.id || evidence.configuration_fingerprint !== configurationFingerprint
            || evidence.provider !== provider || evidence.cli_version !== version || evidence.task_profile !== "chat"
            || evidence.auth_policy !== "subscription-only" || evidence.auth !== "subscription_login"
            || evidence.extra_usage !== "operator_attested_disabled" || evidence.readiness !== "auth_preflight_only"
            || !Number.isFinite(completed) || completed < startedAt - 5000 || completed > Date.now() + 5000) return fail("invalid_evidence");
          const current = discover().profiles.find(p => p.id === profile.id);
          if (!current || current.configurationFingerprint !== configurationFingerprint
            || current.grant !== "granted" || current.availability !== "available") return fail("profile_changed");
          if (cancelled()) return fail(options.signal?.aborted ? "cancelled" : "timeout");
          return { status: "observed", commandId: String(row.commandId),
            observation: { profileId: profile.id, principalId: options.principalId, aiUserId: String(options.aiUserId),
              configurationFingerprint, billing: "subscription", observedAtMs: startedAt,
              nativeChatReadiness: "auth_preflight_only" },
            evidence: { auth: "subscription_login", extraUsage: "operator_attested_disabled", readiness: "auth_preflight_only" } };
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return fail(options.signal?.aborted ? "cancelled" : "timeout");
    } catch { return fail("probe_unavailable"); } // Never forward raw rows, callback errors or auth output.
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([work(), new Promise<RoutingPreflightResult>(resolve => {
      timer = setTimeout(() => { stopped = true; resolve(fail("timeout")); }, Math.max(0, deadline - Date.now()));
      onAbort = () => { stopped = true; resolve(fail("cancelled")); };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    })]);
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
}
