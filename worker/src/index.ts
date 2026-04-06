/**
 * Pear LLM Worker — Orcha agent implementation.
 *
 * Task type dispatch:
 *
 *   "orchestrate"  — Decomposes the user's prompt into a task graph using a
 *                    cheap/fast model, then calls add_tasks_to_job to write
 *                    the new tasks back into SpacetimeDB. This is always the
 *                    first task in a job — it's how Pear avoids hitting the
 *                    frontier model for every request.
 *
 *   "llm"          — Executes a single LLM call with the task description as
 *                    the prompt. Created by the orchestrate step (or directly
 *                    for simple single-task jobs).
 *
 * Multiple instances can run concurrently — claim_task is atomic on the server
 * side so only one worker wins per task. The inFlight set prevents this
 * instance from double-claiming.
 *
 * Environment variables:
 *   SPACETIMEDB_URI          WebSocket URI of SpacetimeDB  (default: ws://localhost:3000)
 *   SPACETIMEDB_DB_NAME      Database name                 (default: pear-dev)
 *   ANTHROPIC_API_KEY        Required. Anthropic API key.
 *   ANTHROPIC_MODEL          Frontier model for llm tasks  (default: claude-3-5-haiku-latest)
 *   ANTHROPIC_PLANNER_MODEL  Fast model for orchestrate    (default: claude-3-5-haiku-latest)
 *   ORCHA_AGENT_ID           Stable agent identity string  (default: pear-llm-worker)
 */

// Polyfill WebSocket for Node.js < 21. Must come before any spacetimedb import.
import { WebSocket } from "ws";
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;
}

import { DbConnection, type EventContext } from "./module_bindings/index.js";
import { callLlm, planTasks, buildPageContext } from "./llm.js";
import { registerConversationHandlers } from "./conversation.js";

const AGENT_ID = process.env.ORCHA_AGENT_ID ?? "pear-llm-worker";
const SPACETIMEDB_URI = process.env.SPACETIMEDB_URI ?? "ws://localhost:3000";
const DB_NAME = process.env.SPACETIMEDB_DB_NAME ?? "pear-dev";

/** Capabilities this worker can handle. */
const CAPABILITIES = ["orchestrate", "llm"];

/** Task IDs currently being processed — prevents double-claiming. */
const inFlight = new Set<bigint>();

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

function isClaimable(task: TaskRow, conn: DbConnection): boolean {
  if (task.status !== "pending") return false;
  if (inFlight.has(task.id)) return false;

  // Empty required_capabilities → any worker can claim it.
  // Non-empty → must have at least one overlap AND worker must cover all requirements.
  if (task.requiredCapabilities.length > 0) {
    if (!CAPABILITIES.some((c) => task.requiredCapabilities.includes(c))) return false;
    if (!task.requiredCapabilities.every((c) => CAPABILITIES.includes(c))) return false;
  }

  // All upstream dependencies must be in "done" state.
  return task.dependsOn.every((depId) => {
    const dep = conn.db.orcha_task.id.find(depId) as TaskRow | undefined;
    return dep?.status === "done";
  });
}

/** Maximum number of orchestrate tasks allowed in a single job (depth guard). */
const MAX_ORCHESTRATE_DEPTH = 3;

/**
 * Handle an "orchestrate" task: use a fast/cheap model to decompose the
 * user's prompt into a Pear-specific task graph, enriched with real page
 * context fetched from SpacetimeDB. Writes subtasks back via add_tasks_to_job.
 *
 * Subtasks may themselves be "orchestrate" tasks for complex branches,
 * enabling recursive decomposition. A depth guard caps this at
 * MAX_ORCHESTRATE_DEPTH orchestrate tasks per job to prevent infinite loops.
 */
async function handleOrchestrate(conn: DbConnection, task: TaskRow): Promise<string> {
  console.log(`[worker] Orchestrating job ${task.jobId}…`);

  // Count existing orchestrate tasks in this job to enforce depth limit.
  const orchestrateCount = [...(conn.db.orcha_task.iter() as Iterable<TaskRow>)]
    .filter((t) => t.jobId === task.jobId && t.taskType === "orchestrate")
    .length;

  const atMaxDepth = orchestrateCount >= MAX_ORCHESTRATE_DEPTH;
  if (atMaxDepth) {
    console.log(`[worker] Max orchestrate depth reached for job ${task.jobId} — forcing llm tasks`);
  }

  // Pull the job to get the page_id, then fetch live page context.
  const job = conn.db.orcha_job.id.find(task.jobId) as JobRow | undefined;
  const pageContext = await buildPageContext(conn, job?.pageId);

  if (pageContext) {
    console.log(`[worker] Page context: ${pageContext.slice(0, 80)}…`);
  }

  const taskSpecs = await planTasks(task.description, pageContext);

  // If at max depth, force all subtasks to llm regardless of what the planner said.
  if (atMaxDepth) {
    for (const spec of taskSpecs) {
      if (spec.task_type === "orchestrate") {
        spec.task_type = "llm";
        spec.required_capabilities = ["llm"];
      }
    }
  }

  if (taskSpecs.length === 0) {
    // Planner returned nothing — fall back to a single llm task.
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

  // Inject page context into every llm subtask description so workers have
  // the same grounding without needing to re-fetch from SpacetimeDB.
  if (pageContext) {
    for (const spec of taskSpecs) {
      if (spec.task_type === "llm") {
        spec.description = `${spec.description}\n\n---\n${pageContext}`;
      }
      // orchestrate subtasks will re-fetch context themselves via buildPageContext.
    }
  }

  const taskGraphJson = JSON.stringify(taskSpecs);
  await conn.reducers.addTasksToJob({ jobId: task.jobId, taskGraphJson });

  console.log(`[worker] Added ${taskSpecs.length} tasks to job ${task.jobId}`);
  return `Decomposed into ${taskSpecs.length} task${taskSpecs.length !== 1 ? "s" : ""}`;
}

async function claimAndExecute(conn: DbConnection, task: TaskRow): Promise<void> {
  if (inFlight.has(task.id)) return;
  inFlight.add(task.id);

  // Attempt to claim atomically. If another worker got there first, bail.
  try {
    await conn.reducers.claimTask({ agentId: AGENT_ID, taskId: task.id });
    console.log(`[worker] Claimed ${task.taskType} task ${task.id} (caps: [${task.requiredCapabilities.join(",")}])`);
  } catch (err) {
    console.warn(`[worker] Failed to claim task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    inFlight.delete(task.id);
    return;
  }

  try {
    let result: string;

    switch (task.taskType) {
      case "orchestrate":
        result = await handleOrchestrate(conn, task);
        break;

      case "llm":
      default:
        result = await callLlm(task.description, conn, task.jobId);
        break;
    }

    await conn.reducers.submitResult({ agentId: AGENT_ID, taskId: task.id, result });
    console.log(`[worker] Completed task ${task.id} (${task.taskType})`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[worker] Task ${task.id} failed: ${error}`);
    try {
      await conn.reducers.failTask({ agentId: AGENT_ID, taskId: task.id, error });
    } catch (innerErr) {
      console.error("[worker] fail_task also failed:", innerErr);
    }
  } finally {
    inFlight.delete(task.id);
  }
}

function checkAndClaim(conn: DbConnection, task: TaskRow): void {
  if (isClaimable(task, conn)) {
    void claimAndExecute(conn, task);
  }
}

console.log(`[worker] Pear LLM worker starting — agent: ${AGENT_ID}`);
console.log(`[worker] Capabilities: ${CAPABILITIES.join(", ")}`);
console.log(`[worker] Connecting to ${SPACETIMEDB_URI} / ${DB_NAME}`);

DbConnection.builder()
  .withUri(SPACETIMEDB_URI)
  .withDatabaseName(DB_NAME)
  .onConnect((conn, identity) => {
    console.log(`[worker] Connected — identity: ${identity.toHexString()}`);

    // Register handlers before subscribing so the initial snapshot is processed.
    conn.db.orcha_task.onInsert((_ctx: EventContext, task: TaskRow) => {
      checkAndClaim(conn, task);
    });

    // When any task transitions to "done" it might unblock dependents.
    conn.db.orcha_task.onUpdate((_ctx: EventContext, _old: TaskRow, task: TaskRow) => {
      checkAndClaim(conn, task);

      if (task.status === "done") {
        for (const t of conn.db.orcha_task.iter() as Iterable<TaskRow>) {
          checkAndClaim(conn, t);
        }
      }
    });

    registerConversationHandlers(conn);

    conn
      .subscriptionBuilder()
      .onApplied(() => {
        console.log("[worker] Subscription ready");

        void conn.reducers
          .registerAgent({ agentId: AGENT_ID, capabilities: CAPABILITIES })
          .then(() =>
            console.log(`[worker] Registered — capabilities: ${CAPABILITIES.join(", ")}`)
          )
          .catch((e: unknown) => console.warn("[worker] register_agent:", e));

        // Drain any pending tasks that arrived before we connected.
        for (const task of conn.db.orcha_task.iter() as Iterable<TaskRow>) {
          checkAndClaim(conn, task);
        }
      })
      .subscribeToAllTables();
  })
  .onDisconnect(() => {
    console.log("[worker] Disconnected — will attempt reconnect");
  })
  .onConnectError((_ctx: EventContext, err: Error) => {
    console.error("[worker] Connection error:", err?.message ?? err);
  })
  .build();

process.on("SIGINT", () => { console.log("[worker] Shutting down"); process.exit(0); });
process.on("SIGTERM", () => { console.log("[worker] Shutting down"); process.exit(0); });
process.on("unhandledRejection", (reason) => {
  console.error("[worker] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[worker] Uncaught exception:", err);
  process.exit(1);
});
