"use client";

import { useEffect, useMemo, useState } from "react";
import { useReducer } from "spacetimedb/react";
import { reducers } from "@/src/module_bindings";
import type { BridgeApproval } from "@/src/module_bindings/types";

type ApprovalOption = {
  optionId: string;
  name: string;
  kind: string;
};

type ApprovalDiff = {
  path: string;
  oldText?: string;
  newText?: string;
};

// The daemon treats an unrecognized option id as a fail-closed denial. This
// sentinel preserves a deny path if corrupted JSON leaves no readable reject
// option; it can never broaden access.
const SAFE_DENY_OPTION_ID = "__pear_safe_deny__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptions(raw: string): { options: ApprovalOption[]; malformed: boolean } {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return { options: [], malformed: true };

    let malformed = value.length === 0;
    const options: ApprovalOption[] = [];
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.optionId !== "string" || !entry.optionId.trim()) {
        malformed = true;
        continue;
      }
      const name = typeof entry.name === "string" && entry.name.trim()
        ? entry.name
        : "Approval option";
      const kind = typeof entry.kind === "string" && entry.kind.trim()
        ? entry.kind
        : "unknown";
      if (name === "Approval option" || kind === "unknown") malformed = true;
      options.push({ optionId: entry.optionId, name, kind });
    }
    return { options, malformed };
  } catch {
    return { options: [], malformed: true };
  }
}

function parseDiffs(raw: string | undefined): { diffs: ApprovalDiff[]; malformed: boolean } | null {
  if (raw === undefined) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return { diffs: [], malformed: true };

    let malformed = value.length === 0;
    const diffs: ApprovalDiff[] = [];
    for (const entry of value) {
      if (!isRecord(entry)) {
        malformed = true;
        continue;
      }
      const path = typeof entry.path === "string" && entry.path.trim()
        ? entry.path
        : "Untitled file";
      const oldText = typeof entry.oldText === "string" ? entry.oldText : undefined;
      const newText = typeof entry.newText === "string" ? entry.newText : undefined;
      if (
        path === "Untitled file" ||
        (entry.oldText != null && oldText === undefined) ||
        (entry.newText != null && newText === undefined)
      ) {
        malformed = true;
      }
      diffs.push({ path, oldText, newText });
    }
    return { diffs, malformed };
  } catch {
    // The server caps large payloads, so a truncated preview can legitimately
    // stop being valid JSON. Keep the approval actionable when that happens.
    return { diffs: [], malformed: true };
  }
}

function optionClasses(kind: string): string {
  if (kind === "allow_always") {
    return "bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:hover:bg-emerald-900/60";
  }
  if (kind.startsWith("allow_")) {
    return "bg-emerald-600 text-white hover:bg-emerald-700";
  }
  if (kind === "reject_always") {
    return "bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-950/50 dark:text-red-300 dark:hover:bg-red-900/60";
  }
  return "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700";
}

function waitingAge(createdAtMicros: bigint, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - Number(createdAtMicros / 1000n)) / 1000));
  if (elapsedSeconds < 15) return "waiting now";
  if (elapsedSeconds < 60) return "waiting less than a minute";
  const minutes = Math.floor(elapsedSeconds / 60);
  return `waiting about ${minutes}m`;
}

function DiffPreview({ payload }: { payload: { diffs: ApprovalDiff[]; malformed: boolean } }) {
  if (payload.diffs.length === 0) {
    return (
      <p className="mt-2 rounded bg-neutral-100 px-2 py-1.5 text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
        Diff preview unavailable. You can still deny this request.
      </p>
    );
  }

  return (
    <div className="mt-2 max-h-64 space-y-2 overflow-y-auto rounded border border-neutral-200 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-950/50">
      {payload.diffs.map((diff, index) => (
        <div key={`${diff.path}:${index}`} className="min-w-0">
          <p className="truncate font-mono text-[11px] font-medium text-neutral-700 dark:text-neutral-300" title={diff.path}>
            {diff.path}
          </p>
          <div className="mt-1 grid min-w-0 gap-1.5">
            <div className="min-w-0 rounded bg-red-50/80 p-1.5 dark:bg-red-950/20">
              <span className="text-[10px] font-medium uppercase tracking-wide text-red-600 dark:text-red-400">Before</span>
              <pre className="mt-0.5 max-h-28 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-neutral-700 dark:text-neutral-300">
                {diff.oldText ?? "Not provided"}
              </pre>
            </div>
            <div className="min-w-0 rounded bg-emerald-50/80 p-1.5 dark:bg-emerald-950/20">
              <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">After</span>
              <pre className="mt-0.5 max-h-28 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-neutral-700 dark:text-neutral-300">
                {diff.newText ?? "Not provided"}
              </pre>
            </div>
          </div>
        </div>
      ))}
      {payload.malformed && (
        <p className="text-[10px] text-neutral-500 dark:text-neutral-400">
          Some diff details could not be displayed.
        </p>
      )}
    </div>
  );
}

export function BridgeApprovalCard({ approval }: { approval: BridgeApproval }) {
  const resolveApproval = useReducer(reducers.resolveBridgeApproval);
  const [busyOptionId, setBusyOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const parsedOptions = useMemo(() => parseOptions(approval.optionsJson), [approval.optionsJson]);
  const parsedDiffs = useMemo(() => parseDiffs(approval.diffsJson), [approval.diffsJson]);
  const status = approval.status.tag;
  const pending = status === "Pending";
  const allowAlwaysOffered = parsedOptions.options.some((option) => option.kind === "allow_always");
  const hasRejectOption = parsedOptions.options.some((option) => option.kind.startsWith("reject_"));

  useEffect(() => {
    if (!pending) return;
    const interval = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, [pending]);

  const decide = async (optionId: string) => {
    setBusyOptionId(optionId);
    setError(null);
    try {
      await resolveApproval({ approvalId: approval.id, optionId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not answer this approval request.");
    } finally {
      setBusyOptionId(null);
    }
  };

  const selectedOption = parsedOptions.options.find(
    (option) => option.optionId === approval.decidedOptionId,
  );
  const selectedLabel = approval.decidedOptionId === SAFE_DENY_OPTION_ID
    ? "Denied"
    : selectedOption?.name ?? approval.decidedOptionId ?? "Answered";
  // Unexpected but valid JSON can also omit a reject option. Keep an explicit
  // fail-closed path in that case instead of forcing the owner to wait for the
  // daemon timeout.
  const fallbackDeny = !hasRejectOption;

  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2.5 dark:border-neutral-800 dark:bg-neutral-900/40">
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 ${pending ? "text-amber-500" : status === "Decided" ? "text-green-500" : "text-neutral-400"}`}>
          {pending ? "⏸" : status === "Decided" ? "✓" : "⌛"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">
              {approval.title?.trim() || "Tool permission request"}
            </span>
            <span className="rounded bg-neutral-200 px-1 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
              {approval.kind?.trim() || "tool call"}
            </span>
            <span className={`rounded px-1 text-[10px] ${pending ? "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" : "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"}`}>
              {pending ? "needs approval" : status === "Decided" ? "answered" : status === "Expired" ? "timed out" : status}
            </span>
          </div>

          {pending && (
            <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
              The agent is paused for your decision · {waitingAge(approval.createdAt.microsSinceUnixEpoch, now)}
            </p>
          )}
          {status === "Decided" && (
            <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
              Chosen option: <span className="font-medium">{selectedLabel}</span>
            </p>
          )}
          {status === "Expired" && (
            <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
              This request timed out and can no longer be answered.
            </p>
          )}

          {parsedDiffs && <DiffPreview payload={parsedDiffs} />}

          {allowAlwaysOffered && (
            <p className="mt-2 text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              Session-scoped: an “always” approval applies only for the rest of this agent session, not forever.
            </p>
          )}

          {pending && (
            <>
              {parsedOptions.malformed && (
                <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                  Some approval choice details could not be read. Only safe, actionable choices are shown.
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {parsedOptions.options.map((option, index) => (
                  <button
                    key={`${option.optionId}:${index}`}
                    type="button"
                    disabled={busyOptionId !== null}
                    onClick={() => void decide(option.optionId)}
                    className={`rounded px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${optionClasses(option.kind)}`}
                  >
                    {busyOptionId === option.optionId ? "…" : option.name}
                  </button>
                ))}
                {fallbackDeny && (
                  <button
                    type="button"
                    disabled={busyOptionId !== null}
                    onClick={() => void decide(SAFE_DENY_OPTION_ID)}
                    className={`rounded px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${optionClasses("reject_once")}`}
                  >
                    {busyOptionId === SAFE_DENY_OPTION_ID ? "…" : "Deny"}
                  </button>
                )}
              </div>
              {error && (
                <p role="alert" className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
