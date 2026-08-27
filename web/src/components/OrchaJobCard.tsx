"use client";

import { useMemo, useState } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  useOrchaTasksForJob,
  useWorkerLiveness,
  type OrchaJobRow,
  type OrchaTaskRow,
} from "@/src/hooks/useOrcha";

/**
 * Expandable card for one Orcha job: status, its tasks, each task's result or
 * error, and — for LLM tasks — the tool-call trace the worker persisted to the
 * job's shared context under `trace:task:<id>`. Shared by the chat thread
 * (delegated subagents) and the automations history (scheduled/manual runs), so
 * "did the job actually run, and what did it do?" has one answer everywhere.
 */
export function OrchaJobCard({
  job,
  defaultExpanded = job.status === "executing",
}: {
  job: OrchaJobRow;
  defaultExpanded?: boolean;
}) {
  const tasks = useOrchaTasksForJob(job.id);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const traces = useTaskTraces(job.id);
  const liveness = useWorkerLiveness();

  const sortedTasks = useMemo(
    () => tasks.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [tasks],
  );
  const claimed = sortedTasks.some((t) => t.status !== "pending");
  const waitingForWorker = job.status === "executing" && !claimed;

  return (
    <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-start gap-2 p-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-800 dark:text-neutral-200 line-clamp-2 leading-snug">
            {job.prompt}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <OrchaStatusBadge status={job.status} />
            <span className="text-xs text-neutral-400">
              Job #{String(job.id)} · {sortedTasks.length} task{sortedTasks.length !== 1 ? "s" : ""}
            </span>
            {job.pageId !== undefined && job.pageId !== null && (
              <span className="text-xs text-neutral-400">page {String(job.pageId)}</span>
            )}
          </div>
        </div>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 mt-1 text-neutral-400 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && waitingForWorker && (
        <p className="border-t border-neutral-200 dark:border-neutral-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30">
          {liveness.status === "alive"
            ? "Queued — no worker has claimed this job's tasks yet."
            : liveness.status === "stale"
              ? `Queued, but the workspace worker hasn't sent a heartbeat since ${new Date(liveness.lastHeartbeatMs ?? 0).toLocaleTimeString()} — it is likely down, so this job won't run until it's back.`
              : "Queued — no worker heartbeat has been seen for this workspace, so nothing is picking up this job."}
        </p>
      )}

      {expanded && sortedTasks.length > 0 && (
        <div className="border-t border-neutral-200 dark:border-neutral-800 divide-y divide-neutral-100 dark:divide-neutral-800/60">
          {sortedTasks.map((task) => (
            <TaskRow key={String(task.id)} task={task} trace={traces.get(task.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, trace }: { task: OrchaTaskRow; trace?: StoredToolCall[] }) {
  return (
    <div className="px-3 py-2.5 flex items-start gap-2">
      <OrchaStatusBadge status={task.status} />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-neutral-700 dark:text-neutral-300 leading-relaxed whitespace-pre-wrap">
          {task.description}
        </p>
        <p className="mt-0.5 text-[10px] text-neutral-400">
          {task.taskType}
          {task.assignedTo ? ` · ${task.assignedTo}` : ""}
          {task.claimedAt
            ? ` · claimed ${new Date(Number(task.claimedAt.microsSinceUnixEpoch / 1000n)).toLocaleString()}`
            : ""}
        </p>
        {task.result && task.status === "done" && (
          <ExpandableText
            text={task.result}
            className="text-xs text-neutral-500 dark:text-neutral-400 mt-1.5 leading-relaxed"
          />
        )}
        {task.result && task.status === "failed" && (
          <ExpandableText
            text={task.result}
            className="text-xs text-red-500 mt-1.5 leading-relaxed"
          />
        )}
        {trace && trace.length > 0 && <ToolTrace calls={trace} />}
      </div>
    </div>
  );
}

/** Task results are often long (a whole day plan); show a clamp with a toggle. */
function ExpandableText({ text, className }: { text: string; className: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 400 || text.split("\n").length > 4;
  return (
    <div>
      <p className={`${className} whitespace-pre-wrap ${open || !long ? "" : "line-clamp-4"}`}>
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-[11px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          {open ? "Show less" : "Show full result"}
        </button>
      )}
    </div>
  );
}

function ToolTrace({ calls }: { calls: StoredToolCall[] }) {
  const [open, setOpen] = useState(false);
  const errors = calls.filter((c) => c.status === "error").length;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
      >
        {open ? "▾" : "▸"} {calls.length} tool call{calls.length !== 1 ? "s" : ""}
        {errors > 0 ? ` · ${errors} error${errors !== 1 ? "s" : ""}` : ""}
      </button>
      {open && (
        <ol className="mt-1 space-y-1.5 border-l-2 border-neutral-200 pl-2 dark:border-neutral-700">
          {calls.map((call, i) => (
            <li key={`${call.id}-${i}`} className="text-[11px]">
              <div className="flex items-center gap-1.5">
                <span
                  className={`font-mono ${
                    call.status === "error"
                      ? "text-red-600 dark:text-red-400"
                      : "text-neutral-700 dark:text-neutral-300"
                  }`}
                >
                  {call.name}
                </span>
                {call.affected?.pageId !== undefined && (
                  <span className="text-neutral-400">page {call.affected.pageId}</span>
                )}
              </div>
              <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-100 px-1.5 py-1 text-[10px] text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
                {call.input}
              </pre>
              {call.output && (
                <pre
                  className={`mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded px-1.5 py-1 text-[10px] ${
                    call.status === "error"
                      ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                      : "bg-neutral-50 text-neutral-500 dark:bg-neutral-900/60 dark:text-neutral-400"
                  }`}
                >
                  {call.output}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function OrchaStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    executing: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
    pending: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
    claimed: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
    complete: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
    done: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  };
  return (
    <span
      className={`text-xs font-medium px-1.5 py-0.5 rounded shrink-0 ${
        colors[status] ?? colors.pending
      }`}
    >
      {status}
    </span>
  );
}

// ── Tool trace (mirrors worker/src/tool-call-record.ts StoredToolCall) ────────

export interface StoredToolCall {
  type: "tool_use";
  id: string;
  name: string;
  input: string;
  status: "executing" | "done" | "error";
  output?: string;
  isError?: boolean;
  affected?: { pageId?: number; createdNodeIds?: number[]; jobId?: number };
}

/** Shared-context key the worker writes a task's trace under. */
export const TRACE_KEY_PREFIX = "trace:task:";

export function parseToolTrace(raw: string): StoredToolCall[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is StoredToolCall =>
        typeof c === "object" && c !== null && typeof (c as { name?: unknown }).name === "string",
    );
  } catch {
    return [];
  }
}

/** Map of task id → parsed trace for one job, from `orcha_shared_context`. */
function useTaskTraces(jobId: bigint): Map<bigint, StoredToolCall[]> {
  const [rows] = useTable(tables.orcha_shared_context);
  return useMemo(() => {
    const out = new Map<bigint, StoredToolCall[]>();
    for (const row of rows) {
      if (row.jobId !== jobId || !row.key.startsWith(TRACE_KEY_PREFIX)) continue;
      const taskId = row.key.slice(TRACE_KEY_PREFIX.length);
      if (!/^\d+$/.test(taskId)) continue;
      out.set(BigInt(taskId), parseToolTrace(row.value));
    }
    return out;
  }, [rows, jobId]);
}
