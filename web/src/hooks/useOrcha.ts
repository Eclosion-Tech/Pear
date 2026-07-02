"use client";

import { useTable, useReducer } from "spacetimedb/react";
import { tables, reducers } from "@/src/module_bindings";

export function useOrchaJobs() {
  const [jobs, isReady] = useTable(tables.orcha_job);
  return { jobs, isReady };
}

/** Jobs linked to a specific Pear page, newest first. */
export function useOrchaJobsForPage(pageId: bigint) {
  const { jobs, isReady } = useOrchaJobs();
  const pageJobs = jobs
    .filter((j) => j.pageId === pageId)
    .sort(
      (a, b) =>
        Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch)
    );
  return { jobs: pageJobs, isReady };
}

export function useOrchaTasks() {
  const [tasks] = useTable(tables.orcha_task);
  return tasks;
}

export function useOrchaTasksForJob(jobId: bigint) {
  const tasks = useOrchaTasks();
  return tasks.filter((t) => t.jobId === jobId);
}

export function useOrchaAgents() {
  const [agents] = useTable(tables.orcha_agent);
  return agents;
}

/** Worker heartbeats older than this read as stale (worker likely down). The
 * worker pings every 30s, so ~3 missed beats. */
const WORKER_STALE_MS = 90_000;

/**
 * Liveness of the workspace's orcha worker, from the freshest `last_heartbeat_at`
 * across registered agents. `alive` = a heartbeat within WORKER_STALE_MS;
 * `unknown` = no agent/heartbeat seen yet (older workers, or none connected).
 */
export function useWorkerLiveness(): {
  status: "alive" | "stale" | "unknown";
  lastHeartbeatMs: number | null;
} {
  const agents = useOrchaAgents();
  let latest = 0;
  for (const a of agents) {
    const hb = a.lastHeartbeatAt?.microsSinceUnixEpoch;
    if (hb !== undefined && hb !== null) {
      const ms = Number(hb / 1000n);
      if (ms > latest) latest = ms;
    }
  }
  if (latest === 0) return { status: "unknown", lastHeartbeatMs: null };
  const alive = Date.now() - latest < WORKER_STALE_MS;
  return { status: alive ? "alive" : "stale", lastHeartbeatMs: latest };
}

export function useCreateJob() {
  return useReducer(reducers.createJob);
}

export function useClaimTask() {
  return useReducer(reducers.claimTask);
}

export function useSubmitResult() {
  return useReducer(reducers.submitResult);
}

export function useFailTask() {
  return useReducer(reducers.failTask);
}

export function useRegisterAgent() {
  return useReducer(reducers.registerAgent);
}

export function useSetSharedContext() {
  return useReducer(reducers.setSharedContext);
}

export function useAddTasksToJob() {
  return useReducer(reducers.addTasksToJob);
}

export type OrchaJobRow = ReturnType<typeof useOrchaJobs>["jobs"][number];
export type OrchaTaskRow = ReturnType<typeof useOrchaTasks>[number];
export type OrchaAgentRow = ReturnType<typeof useOrchaAgents>[number];
