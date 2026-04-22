"use client";

import { useState } from "react";
import { useTable, useReducer } from "spacetimedb/react";
import { tables, reducers } from "@/src/module_bindings";

/**
 * Phase A diff review surface.
 *
 * The worker brackets every mutating tool call with `PreAgentEdit` and
 * `PostAgentEdit` snapshots (see `composite-tool-executor.ts`). This panel
 * lists those bracket pairs for a single page, newest first, with controls
 * to roll back to the pre-snapshot ("Reject") or dismiss the pair ("Accept").
 *
 * v1 shows only Accept / Reject; "Accept some" (per-block) and "Edit" land
 * once we have a block-level diff visualisation.
 */
export function PendingChangesPanel({ pageId }: { pageId: bigint }) {
  const [snapshots] = useTable(tables.page_snapshot);
  const restore = useReducer(reducers.restorePageToSnapshot);
  const [promoting, setPromoting] = useState<bigint | null>(null);

  const pageSnaps = snapshots
    .filter((s) => s.pageId === pageId)
    .filter(
      (s) =>
        s.snapshotType.tag === "PreAgentEdit" ||
        s.snapshotType.tag === "PostAgentEdit",
    )
    .sort(
      (a, b) =>
        Number(
          b.snapshotAt.microsSinceUnixEpoch - a.snapshotAt.microsSinceUnixEpoch,
        ),
    );

  // Walk newest→oldest pairing each Post with the immediately-prior Pre on
  // the same page. Snapshots outside a pair (e.g. the worker died between
  // bracket halves) are surfaced as "incomplete" so they don't disappear.
  const pairs: Array<{
    post: (typeof pageSnaps)[number];
    pre?: (typeof pageSnaps)[number];
  }> = [];
  for (let i = 0; i < pageSnaps.length; i++) {
    const s = pageSnaps[i];
    if (s.snapshotType.tag !== "PostAgentEdit") continue;
    const pre = pageSnaps
      .slice(i + 1)
      .find((c) => c.snapshotType.tag === "PreAgentEdit");
    pairs.push({ post: s, pre });
  }

  if (pairs.length === 0) {
    return (
      <p className="text-xs text-neutral-400 italic px-3 py-4">
        No pending agent edits.
      </p>
    );
  }

  return (
    <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {pairs.slice(0, 20).map(({ post, pre }) => {
        const note = post.title || pre?.title || `Edit at ${post.id}`;
        const ageMs =
          Date.now() -
          Number(post.snapshotAt.microsSinceUnixEpoch / 1000n);
        const ageStr = formatAge(ageMs);
        return (
          <div
            key={String(post.id)}
            className="px-3 py-2 flex items-start gap-2"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-violet-500 mt-1.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-neutral-700 dark:text-neutral-300 truncate">
                {note}
              </p>
              <p className="text-[10px] text-neutral-400 mt-0.5">
                {ageStr} · {pre ? "PreAgentEdit → PostAgentEdit" : "Post-only"}
              </p>
            </div>
            <button
              className="text-[10px] px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-900/60"
              title="Accept this change (no-op; just clears it from the pending list once we have a dismissed flag)"
            >
              Accept
            </button>
            <button
              onClick={() => setPromoting(post.id)}
              className="text-[10px] px-2 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-900/60"
              title="Promote a correction here into a durable instruction page"
            >
              📌
            </button>
            {pre && (
              <button
                onClick={() => {
                  if (
                    !window.confirm(
                      "Reject this agent edit and restore the pre-edit snapshot?",
                    )
                  )
                    return;
                  void restore({ pageId, snapshotId: pre.id });
                }}
                className="text-[10px] px-2 py-0.5 rounded bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 hover:bg-rose-200 dark:hover:bg-rose-900/60"
                title="Restore to PreAgentEdit snapshot"
              >
                Reject
              </button>
            )}
          </div>
        );
      })}
      {promoting !== null && (
        <PromoteToInstructionDialog
          parentPageId={pageId}
          onClose={() => setPromoting(null)}
        />
      )}
    </div>
  );
}

function PromoteToInstructionDialog({
  parentPageId,
  onClose,
}: {
  parentPageId: bigint;
  onClose: () => void;
}) {
  const promote = useReducer(reducers.promoteToInstruction);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[90vw] rounded-lg bg-white dark:bg-neutral-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200 mb-2">
          Promote correction to instruction
        </h2>
        <p className="text-xs text-neutral-500 mb-3">
          Creates a child page under this page with{" "}
          <span className="font-mono">📌</span> so harness instruction
          discovery picks it up.
        </p>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Instruction title"
          className="w-full mb-2 px-2 py-1 text-sm border border-neutral-200 dark:border-neutral-700 rounded bg-white dark:bg-neutral-800"
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Describe the correction so the AI applies it next time…"
          rows={6}
          className="w-full mb-3 px-2 py-1 text-sm border border-neutral-200 dark:border-neutral-700 rounded bg-white dark:bg-neutral-800 font-mono"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1 rounded text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            Cancel
          </button>
          <button
            disabled={!title.trim() || submitting}
            onClick={async () => {
              setSubmitting(true);
              try {
                await promote({
                  parentPageId,
                  title: title.trim(),
                  content,
                });
                onClose();
              } catch (err) {
                console.warn("promoteToInstruction failed", err);
                setSubmitting(false);
              }
            }}
            className="text-xs px-3 py-1 rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create instruction"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
