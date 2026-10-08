/** Read-only discovery from an AI-user-scoped subscription cache. No SQL/network fallback. */
import { createHash } from "node:crypto";
import { parseBridgeBackendBinding } from "./bridge-inference.js";
import type { AiUserConfigRow } from "./providers.js";
import type { Billing, ExecutionProfile } from "./routing.js";

export interface DiscoveryConnection { readonly db: object }
interface Table<T> { iter(): Iterable<T> }
interface Device { id: bigint; connected: boolean; revokedAt?: unknown }
interface Capability {
  deviceId: bigint; provider: string; available: boolean; version?: string; modelsJson?: string;
  detectedAt?: { microsSinceUnixEpoch: bigint };
}
interface Grant { deviceId: bigint; aiUserIdentity: { toHexString(): string } }
interface ConfigTable { id: { find(id: bigint): AiUserConfigRow | undefined } }

/** Trusted host observations from an actual auth/billing/adapter probe, not CLI installation. */
export interface BillingObservation {
  readonly profileId: string;
  readonly principalId: string;
  readonly aiUserId: string;
  readonly configurationFingerprint: string;
  readonly billing: Exclude<Billing, "unknown">;
  readonly observedAtMs: number;
}
export interface DiscoveryOptions {
  readonly aiUserId: bigint;
  readonly principalId: string;
  readonly nowMs: number;
  readonly maxObservationAgeMs: number;
  readonly billingObservations?: readonly BillingObservation[];
}
export interface DiscoveryResult {
  readonly profiles: readonly ExecutionProfile[];
  readonly warnings: readonly string[];
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function identity(value: { toHexString(): string } | undefined): string | undefined {
  try { return value?.toHexString(); } catch { return undefined; }
}
function millis(value: Capability["detectedAt"]): number {
  return typeof value?.microsSinceUnixEpoch === "bigint" ? Number(value.microsSinceUnixEpoch) / 1000 : NaN;
}

export function discoverExecutionProfiles(conn: DiscoveryConnection, options: DiscoveryOptions): DiscoveryResult {
  const db = conn.db as Record<string, unknown>;
  const configs = (db.ai_user_config ?? db.aiUserConfig) as ConfigTable | undefined;
  const config = configs?.id?.find(options.aiUserId);
  const warnings: string[] = [];
  if (!config || config.id !== options.aiUserId || identity(config.identity) !== options.principalId
    || !options.principalId || !Number.isFinite(options.nowMs) || options.nowMs < 0
    || !Number.isFinite(options.maxObservationAgeMs) || options.maxObservationAgeMs < 0) {
    return { profiles: [], warnings: ["identity_scoped_config_unavailable"] };
  }
  const profiles: ExecutionProfile[] = [];
  const parsedBinding = parseBridgeBackendBinding(config.inferenceBackendJson);
  const binding = parsedBinding && Number.isSafeInteger(parsedBinding.device_id) && parsedBinding.device_id > 0
    ? parsedBinding : undefined;
  const invalidBinding = Boolean(config.inferenceBackendJson?.trim()) && !binding;
  if (invalidBinding) warnings.push("invalid_active_binding");

  function withBilling(p: ExecutionProfile): ExecutionProfile {
    const observations = (options.billingObservations ?? []).filter(o => o.profileId === p.id
      && o.principalId === options.principalId && o.aiUserId === String(options.aiUserId)
      && o.configurationFingerprint === p.configurationFingerprint);
    if (observations.length !== 1) return p;
    const o = observations[0];
    const age = options.nowMs - o.observedAtMs;
    if (!Number.isFinite(age) || age < 0 || age > options.maxObservationAgeMs) return p;
    if (!["subscription", "local", "metered_api"].includes(o.billing)) return p;
    return { ...p, billing: o.billing, billingVerified: true,
      observedAtMs: Math.min(p.observedAtMs, o.observedAtMs) };
  }

  // Only the active direct config. A dormant API key behind a binding is not a candidate.
  if (!binding && !invalidBinding) {
    const local = config.provider.tag === "Ollama";
    const explicitEndpoint = config.endpoint?.trim();
    let destination = `configured-${config.provider.tag}`;
    let validEndpoint = true;
    if (explicitEndpoint) {
      try {
        const u = new URL(explicitEndpoint);
        if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
          validEndpoint = false;
        } else destination = u.href;
      } catch { validEndpoint = false; }
    }
    if (validEndpoint) {
      // No health timestamp exists for direct configs: do not make reading the cache
      // into a fresh health observation, even when an API key is present.
      profiles.push(withBilling({ id: `configured_${config.id}`,
        configurationFingerprint: fingerprint({ id: String(config.id), provider: config.provider.tag,
          model: config.model, endpoint: explicitEndpoint ?? null,
          authFingerprint: createHash("sha256").update(config.apiKey ?? "").digest("hex") }),
        principalId: options.principalId, aiUserId: String(options.aiUserId),
        backend: local ? "ollama" : "api", capabilities: ["llm"], taskProfiles: ["chat"],
        destination, billing: "unknown", billingVerified: false, grant: "granted",
        availability: "unknown", observedAtMs: NaN }));
    } else warnings.push("invalid_direct_endpoint");
  }

  const grants = (db.bridge_device_grant ?? db.bridgeDeviceGrant) as Table<Grant> | undefined;
  const devices = (db.bridge_device_summary ?? db.bridgeDeviceSummary) as Table<Device> | undefined;
  const capabilities = (db.bridge_device_capability ?? db.bridgeDeviceCapability) as Table<Capability> | undefined;
  if (!grants || !devices || !capabilities) {
    warnings.push("bridge_discovery_tables_unavailable");
    return { profiles, warnings };
  }
  const granted = new Set([...grants.iter()].filter(g => identity(g.aiUserIdentity) === options.principalId)
    .map(g => String(g.deviceId)));
  const visibleDevices = new Map([...devices.iter()].filter(d => d.revokedAt == null && granted.has(String(d.id)))
    .map(d => [String(d.id), d]));
  const rows = [...capabilities.iter()].filter(c => visibleDevices.has(String(c.deviceId)));
  const counts = new Map<string, number>();
  for (const c of rows) {
    const key = `${c.deviceId}:${c.provider}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const c of rows) {
    if (counts.get(`${c.deviceId}:${c.provider}`) !== 1) {
      warnings.push("duplicate_provider_report"); continue;
    }
    if (!["claude-code", "claude-review", "codex", "ollama"].includes(c.provider)) continue;
    const device = visibleDevices.get(String(c.deviceId))!;
    const active = binding?.device_id === Number(c.deviceId) && binding.provider === c.provider;
    const harness = active && binding.mode === "harness";
    const review = c.provider === "claude-review";
    const observedAtMs = millis(c.detectedAt);
    profiles.push(withBilling({ id: `bridge_${c.deviceId}_${c.provider}`,
      configurationFingerprint: fingerprint({ device: String(c.deviceId), provider: c.provider,
        version: c.version ?? null, modelsJson: c.modelsJson ?? null,
        detectedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
        activeConfigModel: active ? config.model : null,
        // Exact active binding (incl. cwd/model/permission changes) invalidates billing attestations.
        binding: active ? binding : null }),
      principalId: options.principalId, aiUserId: String(options.aiUserId),
      backend: c.provider === "claude-review" ? "claude-code" : c.provider as ExecutionProfile["backend"],
      capabilities: harness ? [] : review ? ["review"] : ["llm"],
      taskProfiles: harness ? [] : review ? ["packet-review"] : ["chat"],
      destination: `bridge-${c.deviceId}-${c.provider}`,
      billing: "unknown", billingVerified: false, grant: "granted", observedAtMs,
      // An inference capability report does not prove harness/ACP readiness.
      availability: !device.connected || !c.available ? "offline" : harness ? "unknown" : "available" }));
    if (harness) warnings.push("harness_readiness_unverified");
  }
  return { profiles, warnings: [...new Set(warnings)] };
}
