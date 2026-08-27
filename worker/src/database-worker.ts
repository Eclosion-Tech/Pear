/**
 * DatabaseWorker — owns the *admin* SpacetimeDB connection for a single
 * database (workspace). Responsibilities:
 *
 *   - Register an Orcha agent, claim and execute orcha tasks.
 *   - Spawn / tear down per-AI-user `AiUserWorker`s for conversation
 *     handling. (Conversation reducers must run as the AI user so the
 *     `MessageSender::User(<ai>)` identity is correct, and so the
 *     `client_visibility_filter` on `ai_user_config` lets us read the
 *     AI user's API key.)
 *
 * Designed for both single-database (standalone Pear) and multi-database
 * (Pear Cloud) deployments. Pear Cloud's manager additionally calls
 * {@link DatabaseWorker.reconcileAiUsers} with tokens fetched from
 * `lifecycle/api/internal/ai-users/<server_ip>`.
 */

import { DbConnection, type EventContext } from "./module_bindings/index.js";
import {
  callLlm,
  planTasks,
  buildPageContext,
  serializeToolTrace,
  traceKeyForTask,
} from "./llm.js";
import type { StoredToolCall } from "./tool-call-record.js";
import { type ResolvedProvider, type TokenUsage } from "./providers.js";
import { resolveRouting, type ModelTier } from "./model-catalog.js";
import { AiUserWorker } from "./ai-user-worker.js";
import { handleAiPrimitiveTask } from "./ai-primitive-task.js";
import { StructuralSensorsScheduler } from "./structural-sensors.js";
import { subscribeToAvailableTables } from "./subscriptions.js";
import { NotionImportJobRunner } from "./notion/import-job-runner.js";
import type { ConnLike, ToolCallContext } from "./tools.js";
import { probeMcpExtensions } from "./mcp-tool-executor.js";

const CAPABILITIES = [
  "orchestrate",
  "llm",
  "ai_primitive",
  "tool-bash",
];
const MAX_ORCHESTRATE_DEPTH = 3;
/** How often the worker pings `heartbeat_agent` so the UI knows it's alive. */
const HEARTBEAT_INTERVAL_MS = 30_000;

function parseIntervalEnv(key: string): number | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

type JobRow = {
  id: bigint;
  userId: string;
  aiUserId?: bigint;
  pageId?: bigint;
  prompt: string;
  status: string;
  tier?: string;
};

type TaskRow = {
  id: bigint;
  jobId: bigint;
  description: string;
  taskType: string;
  status: string;
  dependsOn: bigint[];
  requiredCapabilities: string[];
  assignedTo: string | undefined;
  result: string | undefined;
};

export interface DatabaseWorkerOptions {
  uri: string;
  dbName: string;
  agentId: string;
  token?: string;
  /**
   * When true, this worker does NOT self-discover AI users from its own
   * `ai_user_config` view — an external authority (pear-cloud's manager, via
   * {@link DatabaseWorker.reconcileAiUsers}) is the sole driver of the AI-user
   * worker set. Leaving both drivers on lets them diverge and churn workers
   * (each tears down what the other spawns). Defaults to false (self-hosted/OSS
   * single-process deployments, where self-discovery is the only driver).
   */
  externalAiUserDiscovery?: boolean;
}

/** AI user identity description supplied by the host (lifecycle in pear-cloud). */
export interface AiUserDescriptor {
  /** SpacetimeDB `auto_inc` id, useful for logs and reconciliation keying. */
  aiUserId: bigint;
  /** Display name used in log lines. */
  label?: string;
  /** SpacetimeDB-issued JWT for this AI user's identity. */
  token: string;
}

const RECONNECT_CAP_MS = 30_000;
const RECONNECT_BASE_MS = 1_500;
export class DatabaseWorker {
  private conn: DbConnection | null = null;
  private inFlight = new Set<bigint>();
  private stopped = false;

  /** AI-user-scoped sub-workers, keyed by aiUserId. */
  private aiUserWorkers = new Map<bigint, AiUserWorker>();
  /** Token last used to spawn each worker, so we can detect rotation. */
  private aiUserTokens = new Map<bigint, string>();

  /**
   * Resolve the inference provider for a job attributed to an AI user. The
   * per-AI-user `ai_user_config` (with the API key) is RLS-scoped to the AI
   * user's own connection, so it is never visible on this host connection —
   * resolution must happen on the AI user's own worker. Returns undefined when
   * the job has no AI user or that worker isn't connected yet, so the caller
   * falls back to the default env provider rather than failing the job.
   */
  private resolveProviderForJob(job: JobRow | undefined): ResolvedProvider | undefined {
    if (!job?.aiUserId) return undefined;
    const base = this.aiUserWorkers.get(job.aiUserId)?.resolveProvider(job.aiUserId);
    if (!base) return undefined;
    // Apply the delegating agent's chosen tier (if any) → concrete model within
    // the AI user's provider family. The provider/key/maxTokens are unchanged.
    const tier = typeof job.tier === "string" ? (job.tier as ModelTier) : undefined;
    const routed = resolveRouting(
      { providerTag: base.providerTag, model: base.model },
      { tier },
    );
    return { ...base, model: routed.model };
  }

  /**
   * Resolve the connection + tool context a delegated job's Pear tools must
   * execute on. Human-initiated jobs (no `ai_user_id`) keep
   * running on the admin connection with the default provider. An AI-attributed
   * job runs its tool loop on that AI user's own connection, so writes are
   * governed by its access rules and attributed to it (`created_by`). If the
   * owning worker isn't connected we THROW — the caller fails the task rather
   * than silently escalating to admin authority (which would bypass governance).
   */
  private resolveExecForJob(
    conn: DbConnection,
    job: JobRow | undefined,
    jobId: bigint,
  ): { conn: ConnLike; toolContext: ToolCallContext } {
    if (!job?.aiUserId) {
      return { conn: conn as unknown as ConnLike, toolContext: {} };
    }
    const worker = this.aiUserWorkers.get(job.aiUserId);
    const aiConn = worker?.getConnLike();
    if (!worker || !aiConn) {
      throw new Error(
        `Delegated job ${jobId}: AI user ${job.aiUserId}'s worker is not connected — ` +
          `refusing to execute on admin authority (would bypass its access rules).`,
      );
    }
    return {
      conn: aiConn,
      toolContext: {
        aiUserId: job.aiUserId,
        aiIdentityHex: worker.identity?.toHexString(),
        conversationId: this.findConversationIdForJob(conn, jobId),
        currentPageId: job.pageId,
      },
    };
  }

  private sensors: StructuralSensorsScheduler | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  /** Debounce for AI-user discovery so a burst of row events coalesces. */
  private aiUserReconcileTimer: ReturnType<typeof setTimeout> | null = null;

  /** Periodic liveness ping so the UI can tell this worker is alive. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Coalesces extension changes into one initialize + tools/list health probe. */
  private mcpProbeTimer: ReturnType<typeof setTimeout> | null = null;

  readonly uri: string;
  readonly dbName: string;
  readonly agentId: string;
  private token: string | undefined;
  /** See {@link DatabaseWorkerOptions.externalAiUserDiscovery}. */
  private readonly externalAiUserDiscovery: boolean;

  private notionImportRunner: NotionImportJobRunner | null = null;

  constructor(opts: DatabaseWorkerOptions) {
    this.uri = opts.uri;
    this.dbName = opts.dbName;
    this.agentId = opts.agentId;
    this.token = opts.token;
    this.externalAiUserDiscovery = opts.externalAiUserDiscovery ?? false;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Start (or restart) the periodic liveness ping to `heartbeat_agent`. */
  private startHeartbeat(conn: DbConnection): void {
    this.stopHeartbeat();
    const ping = () => {
      if (this.stopped) return;
      void conn.reducers
        .heartbeatAgent({ agentId: this.agentId })
        .catch((e: unknown) =>
          console.warn(`[worker:${this.dbName}] heartbeat_agent:`, e),
        );
    };
    ping();
    this.heartbeatTimer = setInterval(ping, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearMcpProbeTimer(): void {
    if (this.mcpProbeTimer !== null) {
      clearTimeout(this.mcpProbeTimer);
      this.mcpProbeTimer = null;
    }
  }

  private scheduleMcpProbe(conn: DbConnection): void {
    if (this.stopped) return;
    this.clearMcpProbeTimer();
    this.mcpProbeTimer = setTimeout(() => {
      this.mcpProbeTimer = null;
      void probeMcpExtensions(conn as unknown as ConnLike).catch((err: unknown) => {
        console.warn(
          `[worker:${this.dbName}] MCP health probe failed:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }, 250);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    const exp = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
    );
    const jitter = Math.floor(Math.random() * 400);
    const delay = exp + jitter;
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 12);
    console.log(
      `[worker:${this.dbName}] Will reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.beginConnection();
    }, delay);
  }

  start(): void {
    if (this.stopped) return;
    this.reconnectAttempt = 0;
    this.beginConnection();
  }

  /** Opens (or re-opens) the admin WebSocket. Retries with backoff after disconnect. */
  private beginConnection(): void {
    if (this.stopped) return;

    console.log(`[worker:${this.dbName}] Connecting to ${this.uri} / ${this.dbName}`);

    const builder = DbConnection.builder()
      .withUri(this.uri)
      .withDatabaseName(this.dbName);

    if (this.token) {
      builder.withToken(this.token);
    }

    builder
      .onConnect((conn, identity) => {
        this.reconnectAttempt = 0;
        this.conn = conn;
        console.log(`[worker:${this.dbName}] Connected — identity: ${identity.toHexString()}`);
        this.registerHandlers(conn);
        if (this.token) {
          this.sensors = new StructuralSensorsScheduler(conn, {
            label: this.dbName,
            intervalMs: parseIntervalEnv("STRUCTURAL_SENSORS_INTERVAL_MS"),
            initialDelayMs: parseIntervalEnv("STRUCTURAL_SENSORS_INITIAL_DELAY"),
          });
          this.sensors.start();
        } else {
          console.log(
            `[worker:${this.dbName}] Skipping structural sensors (no admin token)`,
          );
        }
      })
      .onDisconnect(() => {
        console.log(`[worker:${this.dbName}] Disconnected`);
        this.stopHeartbeat();
        this.clearMcpProbeTimer();
        if (this.sensors) {
          this.sensors.stop();
          this.sensors = null;
        }
        this.conn = null;
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      })
      .onConnectError((_ctx: EventContext, err: Error) => {
        console.error(`[worker:${this.dbName}] Connection error:`, err?.message ?? err);
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      })
      .build();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearMcpProbeTimer();
    if (this.aiUserReconcileTimer !== null) {
      clearTimeout(this.aiUserReconcileTimer);
      this.aiUserReconcileTimer = null;
    }

    if (this.sensors) {
      this.sensors.stop();
      this.sensors = null;
    }

    // Tear down all per-AI-user connections first so they stop responding
    // to messages while we drain orcha tasks.
    const aiStops = [...this.aiUserWorkers.values()].map((w) =>
      w.stop().catch((e: unknown) =>
        console.warn(`[worker:${this.dbName}] AI worker stop failed:`, e),
      ),
    );
    this.aiUserWorkers.clear();
    this.aiUserTokens.clear();
    await Promise.all(aiStops);

    if (this.inFlight.size > 0) {
      console.log(
        `[worker:${this.dbName}] Draining ${this.inFlight.size} in-flight tasks…`,
      );
      const deadline = Date.now() + 30_000;
      while (this.inFlight.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (this.inFlight.size > 0) {
        console.warn(
          `[worker:${this.dbName}] Timed out waiting for ${this.inFlight.size} tasks`,
        );
      }
    }

    // Actually close the admin WebSocket. Nulling the ref alone leaves the
    // socket open with its orcha_task / ai_user_config handlers live, so a
    // "stopped" worker keeps reacting to row events.
    try {
      this.conn?.disconnect();
    } catch (e) {
      console.warn(`[worker:${this.dbName}] disconnect failed:`, e);
    }
    this.conn = null;
    console.log(`[worker:${this.dbName}] Stopped`);
  }

  /**
   * Reconcile per-AI-user workers against the authoritative list from the
   * host. Spawns a new {@link AiUserWorker} for any token we haven't seen,
   * tears down workers for AI users no longer in the list, and rotates
   * the connection if a token has changed.
   *
   * Safe to call repeatedly (e.g. on a poll interval).
   */
  async reconcileAiUsers(descriptors: AiUserDescriptor[]): Promise<void> {
    if (this.stopped) return;

    const desired = new Map<bigint, AiUserDescriptor>();
    for (const d of descriptors) desired.set(d.aiUserId, d);

    // Tear down workers no longer wanted, or whose token has rotated (so the
    // next loop respawns them with the new token).
    for (const [aiUserId, worker] of [...this.aiUserWorkers.entries()]) {
      const d = desired.get(aiUserId);
      const rotated = d !== undefined && d.token !== this.aiUserTokens.get(aiUserId);
      if (d === undefined || rotated) {
        console.log(
          `[worker:${this.dbName}] ${rotated ? "Rotating" : "Removing"} AI user worker (id=${aiUserId})`,
        );
        this.aiUserWorkers.delete(aiUserId);
        this.aiUserTokens.delete(aiUserId);
        await worker.stop().catch((e: unknown) =>
          console.warn(`[worker:${this.dbName}] AI worker stop failed:`, e),
        );
      }
    }

    // Spawn workers for new AI users.
    for (const [aiUserId, d] of desired.entries()) {
      if (this.aiUserWorkers.has(aiUserId)) continue;
      console.log(
        `[worker:${this.dbName}] Spawning AI user worker (id=${aiUserId}, label=${d.label ?? "?"})`,
      );
      const w = new AiUserWorker({
        uri: this.uri,
        dbName: this.dbName,
        token: d.token,
        label: d.label ?? `ai-${aiUserId}`,
        getMcpRuntimeConn: () =>
          this.conn ? (this.conn as unknown as ConnLike) : undefined,
      });
      this.aiUserWorkers.set(aiUserId, w);
      this.aiUserTokens.set(aiUserId, d.token);
      w.start();
    }
  }

  /**
   * Build the desired AI-user worker set from `ai_user_config`. Only rows that
   * carry a `worker_token` are spawnable — the token is what lets us connect AS
   * the AI user (so conversation reducers record `MessageSender::User(<ai>)`).
   *
   * This is the self-hosted/OSS discovery path: the admin (module-publisher)
   * connection bypasses the `ai_user_config` RLS filter, so it reads every AI
   * user's token here. pear-cloud's lifecycle can keep calling
   * {@link reconcileAiUsers} directly with tokens fetched out-of-band — both
   * paths funnel into the same reconcile.
   */
  private collectAiUserDescriptors(conn: DbConnection): AiUserDescriptor[] {
    const db = conn.db as unknown as {
      ai_user_config?: { iter(): Iterable<{ id: bigint; workerToken?: string }> };
      ai_user_profile?: { iter(): Iterable<{ aiUserId: bigint; displayName?: string }> };
    };
    const configs = db.ai_user_config;
    if (!configs) return [];

    // Map aiUserId → display name for log labels (iterate rather than rely on
    // the index-accessor name, which differs from the source column name).
    const labels = new Map<bigint, string>();
    for (const p of db.ai_user_profile?.iter() ?? []) {
      if (p.displayName) labels.set(p.aiUserId, p.displayName);
    }

    const descriptors: AiUserDescriptor[] = [];
    for (const cfg of configs.iter()) {
      if (!cfg.workerToken) continue;
      descriptors.push({
        aiUserId: cfg.id,
        token: cfg.workerToken,
        label: labels.get(cfg.id),
      });
    }
    return descriptors;
  }

  /** Debounced re-discovery of AI users from `ai_user_config`. */
  private scheduleAiUserReconcile(conn: DbConnection): void {
    if (this.stopped) return;
    if (this.aiUserReconcileTimer !== null) clearTimeout(this.aiUserReconcileTimer);
    this.aiUserReconcileTimer = setTimeout(() => {
      this.aiUserReconcileTimer = null;
      void this.reconcileAiUsers(this.collectAiUserDescriptors(conn)).catch(
        (e: unknown) =>
          console.warn(`[worker:${this.dbName}] AI-user reconcile failed:`, e),
      );
    }, 250);
  }

  private registerHandlers(conn: DbConnection): void {
    conn.db.orcha_task.onInsert((_ctx: EventContext, task: TaskRow) => {
      this.checkAndClaim(conn, task);
    });

    // Background Notion imports run on this (admin) connection only — the
    // job reducers are publisher-gated. No-op if the module predates the
    // notion_import_job table.
    this.notionImportRunner = new NotionImportJobRunner(this.dbName, this.agentId);
    this.notionImportRunner.attach(conn);

    // AI-user discovery: (re)spawn per-AI-user workers when a `worker_token`
    // appears, is rotated, or is cleared. Uses `as any` for the table accessor
    // because the AI-user tables are not part of the strongly-typed Orcha set
    // this worker was built around.
    //
    // Skipped entirely when an external authority drives reconciliation
    // (pear-cloud's manager). Running both drivers off divergent token sources
    // makes them fight — each tears down the AI-user worker the other just
    // spawned — which churns the connection (and its bridge registration).
    if (!this.externalAiUserDiscovery) {
      const aiCfg = (conn.db as unknown as {
        ai_user_config?: {
          onInsert(cb: () => void): void;
          onUpdate(cb: () => void): void;
          onDelete(cb: () => void): void;
        };
      }).ai_user_config;
      if (aiCfg) {
        aiCfg.onInsert(() => this.scheduleAiUserReconcile(conn));
        aiCfg.onUpdate(() => this.scheduleAiUserReconcile(conn));
        aiCfg.onDelete(() => this.scheduleAiUserReconcile(conn));
      }
    }

    // MCP credentials are exposed only to this module-publisher connection.
    // Probe on runtime-view changes so Settings reflects a real handshake even
    // before an AI user starts its next chat turn.
    const runtimeTable = (conn as unknown as {
      db: {
        ai_extension_runtime?: {
          onInsert(cb: () => void): void;
          onUpdate(cb: () => void): void;
          onDelete(cb: () => void): void;
        };
      };
    }).db.ai_extension_runtime;
    if (runtimeTable) {
      runtimeTable.onInsert(() => this.scheduleMcpProbe(conn));
      runtimeTable.onUpdate(() => this.scheduleMcpProbe(conn));
      runtimeTable.onDelete(() => this.scheduleMcpProbe(conn));
    }

    conn.db.orcha_task.onUpdate(
      (_ctx: EventContext, _old: TaskRow, task: TaskRow) => {
        this.checkAndClaim(conn, task);

        if (task.status === "done") {
          for (const t of conn.db.orcha_task.iter() as Iterable<TaskRow>) {
            this.checkAndClaim(conn, t);
          }
        }
      },
    );

    subscribeToAvailableTables(conn, `[worker:${this.dbName}]`, () => {
      console.log(`[worker:${this.dbName}] Subscription ready`);

      void conn.reducers
        .registerAgent({ agentId: this.agentId, capabilities: CAPABILITIES })
        .then(() =>
          console.log(
            `[worker:${this.dbName}] Registered — capabilities: ${CAPABILITIES.join(", ")}`,
          ),
        )
        .catch((e: unknown) =>
          console.warn(`[worker:${this.dbName}] register_agent:`, e),
        );

      this.startHeartbeat(conn);
      this.scheduleMcpProbe(conn);

      for (const task of conn.db.orcha_task.iter() as Iterable<TaskRow>) {
        this.checkAndClaim(conn, task);
      }

      this.notionImportRunner?.scan(conn);

      // Spawn AI-user workers for any rows that already carry a worker_token.
      // Only when self-discovery is the authority; otherwise the external
      // manager's poll is what populates the AI-user worker set.
      if (!this.externalAiUserDiscovery) {
        this.scheduleAiUserReconcile(conn);
      }
    });
  }

  private isClaimable(task: TaskRow, conn: DbConnection): boolean {
    if (task.status !== "pending") return false;
    if (this.inFlight.has(task.id)) return false;

    if (task.requiredCapabilities.length > 0) {
      // We must satisfy every required capability. (A separate "has at least
      // one" check would be redundant — `every` already implies it.)
      if (!task.requiredCapabilities.every((c) => CAPABILITIES.includes(c))) return false;
    }

    return task.dependsOn.every((depId) => {
      const dep = conn.db.orcha_task.id.find(depId) as TaskRow | undefined;
      return dep?.status === "done";
    });
  }

  /**
   * Union of capabilities across all registered agents (`orcha_agent`). A
   * planner subtask whose `required_capabilities` fall outside this set can
   * never be claimed by anyone, so it would hang `pending` forever and block
   * `check_orcha_job_completion` (assessment #6). We use it to repair such
   * specs before they're inserted.
   */
  private claimableCapabilities(conn: DbConnection): Set<string> {
    const caps = new Set<string>();
    const table = (conn.db as unknown as {
      orcha_agent?: { iter(): Iterable<{ capabilities: string[] }> };
    }).orcha_agent;
    if (table) {
      for (const agent of table.iter()) {
        for (const c of agent.capabilities) caps.add(c);
      }
    }
    // Always include our own — we may read the table before our registration
    // round-trips back.
    for (const c of CAPABILITIES) caps.add(c);
    return caps;
  }

  private checkAndClaim(conn: DbConnection, task: TaskRow): void {
    if (this.stopped) return;
    if (this.isClaimable(task, conn)) {
      void this.claimAndExecute(conn, task);
    }
  }

  private async claimAndExecute(conn: DbConnection, task: TaskRow): Promise<void> {
    if (this.inFlight.has(task.id)) return;
    this.inFlight.add(task.id);

    const startMs = Date.now();

    try {
      await conn.reducers.claimTask({ agentId: this.agentId, taskId: task.id });
      console.log(`[worker:${this.dbName}] Claimed ${task.taskType} task ${task.id}`);
    } catch (err) {
      console.warn(
        `[worker:${this.dbName}] Failed to claim task ${task.id}:`,
        err instanceof Error ? err.message : String(err),
      );
      this.inFlight.delete(task.id);
      return;
    }

    try {
      let result: string;
      let usage: TokenUsage | undefined;

      switch (task.taskType) {
        case "orchestrate":
          result = await this.handleOrchestrate(conn, task);
          break;
        case "ai_primitive":
          result = await handleAiPrimitiveTask(conn, task.description, task.jobId);
          break;
        case "tool-bash":
          result = await this.handleToolBash(conn, task);
          break;
        case "llm":
        default: {
          const llmJob = conn.db.orcha_job.id.find(task.jobId) as JobRow | undefined;
          const llmOverrides = this.resolveProviderForJob(llmJob);
          // Route the tool loop through the AI user's own connection so writes
          // are governed by its access rules and attributed to it — never the
          // admin connection. Throws (→ fail_task) for an
          // AI-attributed job whose worker isn't connected.
          const exec = this.resolveExecForJob(conn, llmJob, task.jobId);
          const llmOut = await callLlm(
            task.description,
            conn,
            task.jobId,
            "",
            llmOverrides,
            exec,
          );
          // Persist the execution trace before the terminal reducer so a
          // finished task (done OR failed) always has its trace on the job.
          await this.persistToolTrace(conn, task, llmOut.toolCalls);
          // A subagent that self-reported it couldn't finish (TASK_FAILED:) must
          // fail the task, not report success — otherwise a blocked subtask shows
          // as done and the job reports full completion for work it didn't do.
          // Throwing routes through the catch, which calls fail_task + records
          // usage (matching every other task-failure path).
          if (llmOut.failed) {
            throw new Error(llmOut.text);
          }
          result = llmOut.text;
          usage = llmOut.usage;
          break;
        }
      }

      await conn.reducers.submitResult({ agentId: this.agentId, taskId: task.id, result });
      console.log(`[worker:${this.dbName}] Completed task ${task.id} (${task.taskType})`);

      this.recordUsage(conn, task, startMs, usage);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[worker:${this.dbName}] Task ${task.id} failed: ${error}`);
      try {
        await conn.reducers.failTask({ agentId: this.agentId, taskId: task.id, error });
      } catch (innerErr) {
        console.error(`[worker:${this.dbName}] fail_task also failed:`, innerErr);
      }

      this.recordUsage(conn, task, startMs);
    } finally {
      this.inFlight.delete(task.id);
    }
  }

  private async handleToolBash(conn: DbConnection, task: TaskRow): Promise<string> {
    // Bridge-backed execution path: enqueue command into BridgeCommand and poll
    // BridgeCommandResult. This replaces the old local sandbox placeholder.
    type BridgeCommandRow = {
      id: bigint;
      deviceId: bigint;
      sessionId: bigint;
      conversationId: bigint;
      requestedBy: unknown;
      command: string;
      cwd?: string;
      status: { tag: string };
      enqueuedAt: unknown;
      nonce?: string;
    };
    type BridgeResultRow = {
      commandId: bigint;
      exitCode?: number;
      stdout: string;
      stderr: string;
      rejectionReason?: string;
      durationMs: bigint;
      completedAt: unknown;
    };

    const payload = task.description?.trim();
    if (!payload) throw new Error("tool-bash task missing JSON payload");

    let parsed: {
      device_id?: number | string;
      command?: string;
      cwd?: string;
      conversation_id?: number | string;
      job_id?: number | string;
      task_id?: number | string;
      timeout_ms?: number;
    };
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      throw new Error(
        `tool-bash task payload must be JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const command = (parsed.command ?? "").toString().trim();
    if (!command) throw new Error("tool-bash payload missing `command`");

    const coerceBigint = (v: unknown): bigint | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === "bigint") return v;
      if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
      if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
      return undefined;
    };

    const deviceId = coerceBigint(parsed.device_id);
    if (deviceId === undefined) {
      throw new Error("tool-bash payload missing/invalid `device_id`");
    }

    const conversationId =
      coerceBigint(parsed.conversation_id) ??
      (task.jobId ? this.findConversationIdForJob(conn, task.jobId) : undefined) ??
      BigInt(0);

    const jobIdArg = coerceBigint(parsed.job_id) ?? task.jobId;
    const taskIdArg = coerceBigint(parsed.task_id) ?? task.id;

    // Client nonce so we read back exactly the command we enqueued, not a
    // concurrent identical one (same deviceId+command) that cross-matches.
    const nonce = crypto.randomUUID();

    await conn.reducers.enqueueBridgeCommand({
      deviceId,
      command,
      cwd: parsed.cwd ? String(parsed.cwd) : undefined,
      conversationId,
      jobId: jobIdArg,
      taskId: taskIdArg,
      nonce,
    });

    const waitFor = async <T>(
      fn: () => T | undefined,
      timeoutMs = 30_000,
      intervalMs = 100,
    ): Promise<T | undefined> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = fn();
        if (found !== undefined) return found;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return undefined;
    };

    const enqueued = await waitFor(
      () =>
        [...(conn.db.bridge_command.iter() as Iterable<BridgeCommandRow>)].find(
          (r) => r.nonce === nonce,
        ),
      10_000,
    );

    if (!enqueued) {
      throw new Error("enqueue_bridge_command succeeded but no BridgeCommand row appeared");
    }

    const timeoutMs = Math.max(1_000, Number(parsed.timeout_ms ?? 120_000));
    const resultRow = await waitFor(
      () =>
        [...(conn.db.bridge_command_result.iter() as Iterable<BridgeResultRow>)].find(
          (r) => String(r.commandId) === String(enqueued.id),
        ),
      timeoutMs,
    );

    if (!resultRow) {
      throw new Error(
        `bridge command ${enqueued.id} timed out waiting for result after ${timeoutMs}ms`,
      );
    }

    const status =
      [...(conn.db.bridge_command.iter() as Iterable<BridgeCommandRow>)].find(
        (r) => String(r.id) === String(enqueued.id),
      )?.status?.tag ?? "Unknown";

    const rejected = Boolean(resultRow.rejectionReason || status === "Rejected");
    const out = {
      ok: !rejected,
      status: rejected ? "rejected" : "completed",
      command_id: Number(enqueued.id),
      exit_code: resultRow.exitCode ?? null,
      stdout: resultRow.stdout ?? "",
      stderr: resultRow.stderr ?? "",
      rejection_reason: resultRow.rejectionReason ?? null,
      duration_ms: Number(resultRow.durationMs ?? BigInt(0)),
    };
    return JSON.stringify(out);
  }

  /** Write a task's tool-call trace to the job's shared context under
   * `trace:task:<id>` (see `traceKeyForTask`). Best-effort: a failure here
   * must not fail the task itself. */
  private async persistToolTrace(
    conn: DbConnection,
    task: TaskRow,
    toolCalls: StoredToolCall[],
  ): Promise<void> {
    if (toolCalls.length === 0) return;
    try {
      await conn.reducers.setSharedContext({
        jobId: task.jobId,
        key: traceKeyForTask(task.id),
        value: serializeToolTrace(toolCalls),
        createdBy: this.agentId,
      });
    } catch (err) {
      console.warn(
        `[worker:${this.dbName}] Failed to persist tool trace for task ${task.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private findConversationIdForJob(conn: DbConnection, jobId: bigint): bigint | undefined {
    type Msg = { conversationId: bigint; jobId?: bigint };
    const row = [...(conn.db.conversation_message.iter() as Iterable<Msg>)].find(
      (m) => m.jobId !== undefined && String(m.jobId) === String(jobId),
    );
    return row?.conversationId;
  }

  private async handleOrchestrate(conn: DbConnection, task: TaskRow): Promise<string> {
    console.log(`[worker:${this.dbName}] Orchestrating job ${task.jobId}…`);

    const orchestrateCount = [...(conn.db.orcha_task.iter() as Iterable<TaskRow>)]
      .filter((t) => t.jobId === task.jobId && t.taskType === "orchestrate")
      .length;

    const atMaxDepth = orchestrateCount >= MAX_ORCHESTRATE_DEPTH;
    if (atMaxDepth) {
      console.log(`[worker:${this.dbName}] Max orchestrate depth reached for job ${task.jobId}`);
    }

    const job = conn.db.orcha_job.id.find(task.jobId) as JobRow | undefined;
    const pageContext = await buildPageContext(conn, job?.pageId);

    if (pageContext) {
      console.log(`[worker:${this.dbName}] Page context: ${pageContext.slice(0, 80)}…`);
    }

    const orchestrateOverrides = this.resolveProviderForJob(job);
    const taskSpecs = await planTasks(task.description, pageContext, orchestrateOverrides);

    if (atMaxDepth) {
      for (const spec of taskSpecs) {
        if (spec.task_type === "orchestrate") {
          spec.task_type = "llm";
          spec.required_capabilities = ["llm"];
        }
      }
    }

    // Repair specs that demand a capability no registered agent has — otherwise
    // they'd hang `pending` forever and the job never completes (#6). Coerce to
    // a plain `llm` task (the universal fallback) and log so the degradation is
    // visible rather than silent.
    const known = this.claimableCapabilities(conn);
    for (const spec of taskSpecs) {
      const missing = spec.required_capabilities.filter((c) => !known.has(c));
      if (missing.length > 0) {
        console.warn(
          `[worker:${this.dbName}] job ${task.jobId}: subtask requires unsatisfiable capabilities [${missing.join(", ")}] — coercing to llm so the job can't hang (#6)`,
        );
        spec.task_type = "llm";
        spec.required_capabilities = ["llm"];
      }
    }

    if (taskSpecs.length === 0) {
      const taskGraphJson = JSON.stringify([
        {
          description: pageContext
            ? `${task.description}\n\n---\n${pageContext}`
            : task.description,
          task_type: "llm",
          depends_on: [],
          required_capabilities: ["llm"],
        },
      ]);
      await conn.reducers.addTasksToJob({ jobId: task.jobId, taskGraphJson });
      return "Decomposed into 1 task";
    }

    if (pageContext) {
      for (const spec of taskSpecs) {
        if (spec.task_type === "llm") {
          spec.description = `${spec.description}\n\n---\n${pageContext}`;
        }
      }
    }

    const taskGraphJson = JSON.stringify(taskSpecs);
    await conn.reducers.addTasksToJob({ jobId: task.jobId, taskGraphJson });

    console.log(`[worker:${this.dbName}] Added ${taskSpecs.length} tasks to job ${task.jobId}`);
    return `Decomposed into ${taskSpecs.length} task${taskSpecs.length !== 1 ? "s" : ""}`;
  }

  private recordUsage(
    conn: DbConnection,
    task: TaskRow,
    startMs: number,
    usage?: TokenUsage,
  ): void {
    const wallClockMs = Date.now() - startMs;
    // Anthropic reports uncached input separately from cache reads; bill the
    // full prompt (uncached + cache read) as tokens_in so the cap reflects
    // real consumption (#3). Zero when the provider returned no usage.
    const tokensIn = usage
      ? BigInt(usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens)
      : BigInt(0);
    const tokensOut = usage ? BigInt(usage.outputTokens) : BigInt(0);
    conn.reducers
      .recordUsageEvent({
        taskId: task.id,
        taskType: task.taskType,
        agentId: this.agentId,
        aiUserId: undefined,
        tokensIn,
        tokensOut,
        wallClockMs: BigInt(wallClockMs),
      })
      .catch((err: unknown) => {
        console.warn(
          `[worker:${this.dbName}] Failed to record usage:`,
          err instanceof Error ? err.message : err,
        );
      });
  }
}
