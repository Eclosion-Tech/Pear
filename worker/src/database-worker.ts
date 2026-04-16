/**
 * DatabaseWorker — encapsulates a single SpacetimeDB connection and all
 * per-database state (in-flight tasks, conversation processing, provider cache).
 *
 * Designed for both single-database (standalone Pear) and multi-database
 * (Pear Cloud) deployments. Each instance manages its own connection lifecycle,
 * Orcha agent registration, task claiming, and conversation handling.
 */

import { DbConnection, type EventContext } from "./module_bindings/index.js";
import { callLlm, planTasks, buildPageContext } from "./llm.js";
import { registerConversationHandlers } from "./conversation.js";
import { clearProviderCache, invalidateProviderCache } from "./providers.js";

const CAPABILITIES = ["orchestrate", "llm"];
const MAX_ORCHESTRATE_DEPTH = 3;

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

export class DatabaseWorker {
  private conn: DbConnection | null = null;
  private inFlight = new Set<bigint>();
  private stopped = false;

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

  start(): void {
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
        this.conn = conn;
        console.log(`[worker:${this.dbName}] Connected — identity: ${identity.toHexString()}`);
        this.registerHandlers(conn);
      })
      .onDisconnect(() => {
        console.log(`[worker:${this.dbName}] Disconnected`);
        this.conn = null;
        clearProviderCache();
      })
      .onConnectError((_ctx: EventContext, err: Error) => {
        console.error(`[worker:${this.dbName}] Connection error:`, err?.message ?? err);
      })
      .build();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearProviderCache();

    if (this.inFlight.size > 0) {
      console.log(`[worker:${this.dbName}] Draining ${this.inFlight.size} in-flight tasks…`);
      const deadline = Date.now() + 30_000;
      while (this.inFlight.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (this.inFlight.size > 0) {
        console.warn(`[worker:${this.dbName}] Timed out waiting for ${this.inFlight.size} tasks`);
      }
    }

    this.conn = null;
    console.log(`[worker:${this.dbName}] Stopped`);
  }

  private registerHandlers(conn: DbConnection): void {
    conn.db.orcha_task.onInsert((_ctx: EventContext, task: TaskRow) => {
      this.checkAndClaim(conn, task);
    });

    conn.db.orcha_task.onUpdate((_ctx: EventContext, _old: TaskRow, task: TaskRow) => {
      this.checkAndClaim(conn, task);

      if (task.status === "done") {
        for (const t of conn.db.orcha_task.iter() as Iterable<TaskRow>) {
          this.checkAndClaim(conn, t);
        }
      }
    });

    // Invalidate provider cache when AI user config changes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configTable = (conn.db as any).ai_user_config;
    if (configTable) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configTable.onUpdate?.((_ctx: any, _old: any, row: any) => {
        invalidateProviderCache(BigInt(row.id));
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      configTable.onDelete?.((_ctx: any, row: any) => {
        invalidateProviderCache(BigInt(row.id));
      });
    }

    registerConversationHandlers(conn);

    conn
      .subscriptionBuilder()
      .onApplied(() => {
        console.log(`[worker:${this.dbName}] Subscription ready`);

        void conn.reducers
          .registerAgent({ agentId: this.agentId, capabilities: CAPABILITIES })
          .then(() =>
            console.log(`[worker:${this.dbName}] Registered — capabilities: ${CAPABILITIES.join(", ")}`)
          )
          .catch((e: unknown) => console.warn(`[worker:${this.dbName}] register_agent:`, e));

        for (const task of conn.db.orcha_task.iter() as Iterable<TaskRow>) {
          this.checkAndClaim(conn, task);
        }
      })
      .subscribeToAllTables();
  }

  private isClaimable(task: TaskRow, conn: DbConnection): boolean {
    if (task.status !== "pending") return false;
    if (this.inFlight.has(task.id)) return false;

    if (task.requiredCapabilities.length > 0) {
      if (!CAPABILITIES.some((c) => task.requiredCapabilities.includes(c))) return false;
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
