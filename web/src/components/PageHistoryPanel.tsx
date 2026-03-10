"use client";

import { usePageSnapshots, useTakeSnapshot, useRestorePageToSnapshot } from "@/src/hooks/usePages";
interface PageHistoryPanelProps {
  pageId: bigint;
  onClose: () => void;
  onRestore?: () => void;
}

const SNAPSHOT_TYPE_LABELS: Record<string, string> = {
  Manual: "Saved version",
  Periodic: "Auto-saved",
  PreAgentEdit: "Before AI edit",
  PostAgentEdit: "After AI edit",
};

function actorLabel(createdBy: { tag: string; value?: string }): string {
  if (createdBy.tag === "Human") return "You";
  if (createdBy.tag === "Agent" && createdBy.value) return createdBy.value;
  return "Unknown";
}

function formatTime(ts: bigint | number | { microsSinceUnixEpoch: bigint }): string {
  const raw = typeof ts === "object" ? ts.microsSinceUnixEpoch : ts;
  const ms = Number(raw) / 1000;
  const d = new Date(ms);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PageHistoryPanel({ pageId, onClose, onRestore }: PageHistoryPanelProps) {
  const snapshots = usePageSnapshots(pageId);
  const takeSnapshot = useTakeSnapshot();
  const restoreToSnapshot = useRestorePageToSnapshot();

  async function handleSaveVersion() {
    await takeSnapshot({
      pageId,
      snapshotType: { tag: "Manual" },
    });
  }

  async function handleRestore(snapshotId: bigint) {
    await restoreToSnapshot({ pageId, snapshotId });
    onRestore?.();
    onClose();
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-neutral-900 border-l border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">History</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSaveVersion}
            className="text-xs px-2 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors"
          >
            Save version
          </button>
          <button
            onClick={onClose}
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 text-lg leading-none"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {snapshots.length === 0 ? (
          <p className="px-4 py-6 text-sm text-neutral-400 dark:text-neutral-500 italic">
            No versions yet. Click &quot;Save version&quot; to create one.
          </p>
        ) : (
          <ul className="space-y-0">
            {snapshots.map((snap, i) => (
              <li key={String(snap.id)}>
                <button
                  onClick={() => handleRestore(snap.id)}
                  className="w-full text-left px-4 py-2.5 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors group"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-neutral-900 dark:text-white truncate">
                      {snap.title || "Untitled"}
                    </span>
                    <span className="text-xs text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      Restore
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    <span>{SNAPSHOT_TYPE_LABELS[snap.snapshotType.tag] ?? snap.snapshotType.tag}</span>
                    <span>·</span>
                    <span>{actorLabel(snap.createdBy)}</span>
                    <span>·</span>
                    <span>{formatTime(snap.snapshotAt)}</span>
                  </div>
                </button>
                {i < snapshots.length - 1 && (
                  <div className="mx-4 border-b border-neutral-100 dark:border-neutral-800" />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
