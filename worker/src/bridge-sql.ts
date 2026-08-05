/**
 * HTTP `/sql` fallback reader for the Pear Bridge wait loop.
 *
 * Why this exists
 * ---------------
 * `tool_bash` enqueues a `bridge_command`, then waits to see that row + its
 * `bridge_command_result` appear on the AI-user connection. In production the
 * AI-user connection reliably receives `conversation_message` incrementals but
 * NOT `bridge_command` incrementals: the worker never even sees its own
 * just-enqueued command row, so the wait loop reports "unconfirmed" and the AI
 * never gets the result.
 *
 * The distinguishing fact: `bridge_command` carries THREE OR-unioned
 * `client_visibility_filter`s (`requested_by`, `device_identity`,
 * `owner_identity`), whereas `bridge_command_result` / `conversation_message`
 * each have one. The device daemon (filtering on `device_identity`) DOES get
 * new-command incrementals — commands execute and reach `Completed` — so the
 * delta is being dropped specifically for the AI-user `requested_by` view of
 * the multi-filter table. Rather than chase the exact STDB incremental-RLS
 * quirk, we sidestep subscriptions entirely for this one read: poll STDB's HTTP
 * `/sql` endpoint with the SAME AI-user token. RLS still scopes `requested_by =
 * :sender` to this AI user, and each poll is a full re-evaluation of committed
 * state, so it is immune to whatever incremental path is failing.
 *
 * The client is registered per AI user (keyed by identity hex) by the
 * `AiUserWorker` on connect; `tool_bash` looks it up via `aiIdentityHex`. When
 * absent (older build, Orcha admin connection, tests), `tool_bash` falls back
 * to the subscription cache as before.
 */

/** A `bridge_command` row, shaped to match the subscription-cache rows in tools.ts. */
export interface BridgeCommandSqlRow {
  id: string;
  deviceId: string;
  command: string;
  conversationId: string;
  status: { tag: string };
  /** Enqueue-correlation token; null on legacy rows / older modules. */
  nonce: string | null;
}

/** A `bridge_command_chunk` row: one streaming delta for an in-flight command. */
export interface BridgeChunkSqlRow {
  seq: number;
  content: string;
}

/** A `bridge_device_capability` row: one inference provider a device serves. */
export interface BridgeCapabilitySqlRow {
  deviceId: string;
  provider: string;
  available: boolean;
  version: string | null;
  /** JSON array of model names, when the provider enumerates them (ollama). */
  modelsJson: string | null;
}

/** A `bridge_command_result` row, shaped to match the subscription-cache rows. */
export interface BridgeResultSqlRow {
  commandId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  rejectionReason: string | null;
  durationMs: bigint;
}

export interface BridgeSqlClient {
  /** All `bridge_command` rows for one device visible to this AI user (RLS-scoped). */
  commandsForDevice(deviceId: bigint): Promise<BridgeCommandSqlRow[]>;
  /** The `bridge_command_result` for one command id, or undefined if none yet. */
  resultForCommand(commandId: string | bigint): Promise<BridgeResultSqlRow | undefined>;
  /**
   * The inference providers one device reports (`bridge_device_capability`;
   * public, no RLS). Optional so hand-rolled test fakes / older registrations
   * that only implement the two command reads keep working.
   */
  capabilitiesForDevice?(deviceId: bigint): Promise<BridgeCapabilitySqlRow[]>;
  /**
   * Streaming chunks for one in-flight command (`bridge_command_chunk`,
   * RLS-scoped to this AI user), sorted by seq. Optional like capabilities.
   */
  chunksForCommand?(commandId: string | bigint): Promise<BridgeChunkSqlRow[]>;
}

// BridgeCommandStatus variant order in server/.../bridge/mod.rs. STDB's HTTP
// `/sql` encodes a sum type as `[variantIndex, payload]`, so we map the index
// back to the tag the wait loop compares against.
const STATUS_TAGS = [
  "Pending",
  "AwaitingConfirmation",
  "Running",
  "Completed",
  "Failed",
  "Rejected",
  "TimedOut",
] as const;

/** Decode STDB `/sql`'s enum encoding (`[idx,[]]` | `"Tag"` | `{tag}`) to a tag string. */
function decodeStatusTag(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.length >= 1 && typeof raw[0] === "number") {
    return STATUS_TAGS[raw[0]] ?? "Pending";
  }
  if (raw && typeof raw === "object" && "tag" in (raw as Record<string, unknown>)) {
    const t = (raw as { tag?: unknown }).tag;
    if (typeof t === "string") return t;
  }
  return "Pending";
}

/**
 * Decode STDB `/sql`'s `Option<T>` wire shapes to the inner value or undefined:
 *   `[0, v]` / `{some:v}` → Some(v);  `[1,[]]` / `{none:[]}` / null → None.
 * (Mirrors web/.../dispatcher.ts `decodeOptionSome`.)
 */
function decodeOptionSome(raw: unknown): unknown {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    if (raw.length >= 2 && raw[0] === 0) return raw[1];
    return undefined;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if ("some" in obj) return obj.some;
    if ("none" in obj) return undefined;
  }
  return raw; // bare value — treat as Some
}

function toBigIntOr0(raw: unknown): bigint {
  const v = decodeOptionSome(raw);
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return BigInt(0);
}

function toNumberOrNull(raw: unknown): number | null {
  const v = decodeOptionSome(raw);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function toStringOrNull(raw: unknown): string | null {
  const v = decodeOptionSome(raw);
  return typeof v === "string" ? v : null;
}

/** ws→http / wss→https, trimming any `/v1/database/...` path the URI may carry. */
export function wsUriToHttpBase(uri: string): string {
  let base = uri.trim();
  const marker = base.indexOf("/v1/database/");
  if (marker !== -1) base = base.slice(0, marker);
  base = base.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  return base.replace(/\/+$/, "");
}

export interface BridgeSqlClientOptions {
  uri: string;
  dbName: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Create an HTTP `/sql`-backed bridge reader for one AI user's identity/token. */
export function createBridgeSqlClient(opts: BridgeSqlClientOptions): BridgeSqlClient {
  const base = wsUriToHttpBase(opts.uri);
  const db = encodeURIComponent(opts.dbName);
  const url = `${base}/v1/database/${db}/sql`;
  const doFetch = opts.fetchImpl ?? ((u: string, init: RequestInit) => fetch(u, init));
  const timeoutMs = opts.timeoutMs ?? 8_000;

  async function sql(query: string): Promise<Record<string, unknown>[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Authorization: `Bearer ${opts.token}`,
        },
        body: query,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(`bridge /sql failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as Array<{
      schema?: { elements?: Array<{ name?: { some?: string } }> };
      rows?: unknown[][];
    }>;
    if (!Array.isArray(data) || data.length === 0) return [];
    const result = data[0];
    const columns = result.schema?.elements?.map((el) => el.name?.some ?? "") ?? [];
    return (result.rows ?? []).map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
      return obj;
    });
  }

  return {
    async commandsForDevice(deviceId: bigint): Promise<BridgeCommandSqlRow[]> {
      // `nonce` is an appended column; against an older module the SELECT
      // errors, so retry with the legacy column list rather than failing the
      // whole wait loop.
      let rows: Record<string, unknown>[];
      try {
        rows = await sql(
          `SELECT id, device_id, conversation_id, command, status, nonce FROM bridge_command WHERE device_id = ${deviceId.toString()}`,
        );
      } catch {
        rows = await sql(
          `SELECT id, device_id, conversation_id, command, status FROM bridge_command WHERE device_id = ${deviceId.toString()}`,
        );
      }
      return rows.map((r) => ({
        id: String(toBigIntOr0(r.id)),
        deviceId: String(toBigIntOr0(r.device_id)),
        command: typeof r.command === "string" ? r.command : String(decodeOptionSome(r.command) ?? ""),
        conversationId: String(toBigIntOr0(r.conversation_id)),
        status: { tag: decodeStatusTag(r.status) },
        nonce: toStringOrNull(r.nonce),
      }));
    },
    async chunksForCommand(commandId: string | bigint): Promise<BridgeChunkSqlRow[]> {
      let rows: Record<string, unknown>[];
      try {
        rows = await sql(
          `SELECT seq, content FROM bridge_command_chunk WHERE command_id = ${commandId.toString()}`,
        );
      } catch {
        // Older module without the table — no streaming, caller falls back to
        // waiting for the final result.
        return [];
      }
      return rows
        .map((r) => ({
          seq: Number(toBigIntOr0(r.seq)),
          content:
            typeof r.content === "string" ? r.content : String(decodeOptionSome(r.content) ?? ""),
        }))
        .sort((a, b) => a.seq - b.seq);
    },
    async capabilitiesForDevice(deviceId: bigint): Promise<BridgeCapabilitySqlRow[]> {
      let rows: Record<string, unknown>[];
      try {
        rows = await sql(
          `SELECT device_id, provider, available, version, models_json FROM bridge_device_capability WHERE device_id = ${deviceId.toString()}`,
        );
      } catch {
        // Older module without the table — report "no capability data", the
        // caller treats that as unknown rather than unavailable.
        return [];
      }
      return rows.map((r) => ({
        deviceId: String(toBigIntOr0(r.device_id)),
        provider: typeof r.provider === "string" ? r.provider : String(decodeOptionSome(r.provider) ?? ""),
        available: r.available === true || decodeOptionSome(r.available) === true,
        version: toStringOrNull(r.version),
        modelsJson: toStringOrNull(r.models_json),
      }));
    },
    async resultForCommand(commandId: string | bigint): Promise<BridgeResultSqlRow | undefined> {
      const rows = await sql(
        `SELECT command_id, exit_code, stdout, stderr, rejection_reason, duration_ms FROM bridge_command_result WHERE command_id = ${commandId.toString()}`,
      );
      const r = rows[0];
      if (!r) return undefined;
      return {
        commandId: String(toBigIntOr0(r.command_id)),
        exitCode: toNumberOrNull(r.exit_code),
        stdout: typeof r.stdout === "string" ? r.stdout : String(decodeOptionSome(r.stdout) ?? ""),
        stderr: typeof r.stderr === "string" ? r.stderr : String(decodeOptionSome(r.stderr) ?? ""),
        rejectionReason: toStringOrNull(r.rejection_reason),
        durationMs: toBigIntOr0(r.duration_ms),
      };
    },
  };
}

// ── Per-AI-user registry ──────────────────────────────────────────────────────

const registry = new Map<string, BridgeSqlClient>();

/** Normalise an identity hex for use as a registry key (lowercase, no 0x). */
function key(identityHex: string): string {
  return identityHex.replace(/^0x/i, "").toLowerCase();
}

export function registerBridgeSql(identityHex: string, client: BridgeSqlClient): void {
  registry.set(key(identityHex), client);
}

export function unregisterBridgeSql(identityHex: string): void {
  registry.delete(key(identityHex));
}

export function getBridgeSql(identityHex: string | undefined): BridgeSqlClient | undefined {
  if (!identityHex) return undefined;
  return registry.get(key(identityHex));
}
