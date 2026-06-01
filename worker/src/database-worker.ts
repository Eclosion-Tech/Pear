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
import { callLlm, planTasks, buildPageContext } from "./llm.js";
import { AiUserWorker } from "./ai-user-worker.js";
import { handleAiPrimitiveTask } from "./ai-primitive-task.js";
import { StructuralSensorsScheduler } from "./structural-sensors.js";
import { subscribeToAvailableTables } from "./subscriptions.js";

const SANDBOX_BACKEND = process.env.PEAR_SANDBOX_BACKEND ?? "";
const TOOL_BASH_ENABLED = SANDBOX_BACKEND !== "";

const CAPABILITIES = [
  "orchestrate",
  "llm",
  "ai_primitive",
  ...(TOOL_BASH_ENABLED ? ["tool-bash"] : []),
];
const MAX_ORCHESTRATE_DEPTH = 3;

function parseIntervalEnv(key: string): number | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

type JobRow = {
  id: bigint;
  pageId?: bigint;
  prompt: string;
  status: string;
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

  private sensors: StructuralSensorsScheduler | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  /** Debounce for AI-user discovery so a burst of row events coalesces. */
  private aiUserReconcileTimer: ReturnType<typeof setTimeout> | null = null;

  readonly uri: string;
  readonly dbName: string;
  readonly agentId: string;
  private token: string | undefined;

  constructor(opts: DatabaseWorkerOptions) {
    this.uri = opts.uri;
    this.dbName = opts.dbName;
    this.agentId = opts.agentId;
    this.token = opts.token;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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

    // AI-user discovery: (re)spawn per-AI-user workers when a `worker_token`
    // appears, is rotated, or is cleared. Uses `as any` for the table accessor
    // because the AI-user tables are not part of the strongly-typed Orcha set
    // this worker was built around.
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

      for (const task of conn.db.orcha_task.iter() as Iterable<TaskRow>) {
        this.checkAndClaim(conn, task);
      }

      // Spawn AI-user workers for any rows that already carry a worker_token.
      this.scheduleAiUserReconcile(conn);
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

      switch (task.taskType) {
        case "orchestrate":
          result = await this.handleOrchestrate(conn, task);
          break;
        case "ai_primitive":
          result = await handleAiPrimitiveTask(conn, task.description, task.jobId);
          break;
        case "tool-bash":
          // Phase D placeholder. The actual sandbox handler (Docker /
          // Firecracker per-workspace, scoped FS, allowed_domains
          // enforcement) is still pending infra work. We accept the
          // capability so plans can be written against it, but refuse
          // execution unless an explicit backend has been wired.
          if (!TOOL_BASH_ENABLED) {
            throw new Error(
              "tool-bash sandbox backend not configured (set PEAR_SANDBOX_BACKEND)",
            );
          }
          throw new Error(
            `tool-bash backend "${SANDBOX_BACKEND}" recognised but not implemented yet`,
          );
        case "llm":
        default:
          result = await callLlm(task.description, conn, task.jobId);
          break;
      }

      await conn.reducers.submitResult({ agentId: this.agentId, taskId: task.id, result });
      console.log(`[worker:${this.dbName}] Completed task ${task.id} (${task.taskType})`);

      this.recordUsage(conn, task, startMs);
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

    const taskSpecs = await planTasks(task.description, pageContext);

    if (atMaxDepth) {
      for (const spec of taskSpecs) {
        if (spec.task_type === "orchestrate") {
          spec.task_type = "llm";
          spec.required_capabilities = ["llm"];
        }
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

  private recordUsage(conn: DbConnection, task: TaskRow, startMs: number): void {
    const wallClockMs = Date.now() - startMs;
    conn.reducers
      .recordUsageEvent({
        taskId: task.id,
        taskType: task.taskType,
        agentId: this.agentId,
        aiUserId: undefined,
        tokensIn: BigInt(0),
        tokensOut: BigInt(0),
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
