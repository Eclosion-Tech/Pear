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
