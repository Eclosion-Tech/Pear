"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useDeletedPages, useRestorePage, usePurgePage, useEmptyTrash } from "@/src/hooks/usePages";

export default function TrashPage() {
  const router = useRouter();
  const { pages } = useDeletedPages();
  const restorePage = useRestorePage();
  const purgePage = usePurgePage();
  const emptyTrash = useEmptyTrash();
  const [optimisticallyRemoved, setOptimisticallyRemoved] = useState<Set<string>>(new Set());

  const displayPages = pages.filter((p) => !optimisticallyRemoved.has(String(p.id)));

  // Clean up optimisticallyRemoved once subscription confirms the page is gone
  useEffect(() => {
    setOptimisticallyRemoved((prev) => {
      const pageIds = new Set(pages.map((p) => String(p.id)));
      const stillPending = [...prev].filter((id) => pageIds.has(id));
      return stillPending.length !== prev.size ? new Set(stillPending) : prev;
    });
  }, [pages]);

  async function handleRestore(pageId: bigint) {
    await restorePage({ pageId });
    router.push(`/workspace/${pageId}`);
  }

  async function handlePurge(pageId: bigint) {
    if (!confirm("Permanently delete this page? This cannot be undone.")) return;
    setOptimisticallyRemoved((prev) => new Set(prev).add(String(pageId)));
    try {
      await purgePage({ pageId });
    } catch {
      setOptimisticallyRemoved((prev) => {
        const next = new Set(prev);
        next.delete(String(pageId));
        return next;
      });
    }
  }

  async function handleEmptyTrash() {
    if (
      !confirm(
        `Permanently delete all ${displayPages.length} page(s) in the trash? This cannot be undone.`,
      )
    )
      return;
    setOptimisticallyRemoved(new Set(displayPages.map((p) => String(p.id))));
    try {
      await emptyTrash();
    } catch {
      setOptimisticallyRemoved(new Set());
    }
  }

  return (
    <div className="h-full flex flex-col p-6 max-w-2xl mx-auto w-full">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-white">
          Trash
        </h1>
        {displayPages.length > 0 && (
          <button
            type="button"
            onClick={() => void handleEmptyTrash()}
            className="px-2.5 py-1 text-xs rounded border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            Empty trash ({displayPages.length})
          </button>
        )}
      </div>
      <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-6">
        Deleted pages are kept for 30 days, then purged automatically. Restore or permanently
        delete them.
      </p>

      {displayPages.length === 0 ? (
        <p className="text-sm text-neutral-400 dark:text-neutral-500 italic">
          Trash is empty
        </p>
      ) : (
        <ul className="space-y-2 flex-1 min-h-0 overflow-y-auto pb-6">
          {displayPages.map((page) => (
            <li
              key={String(page.id)}
              className="flex items-center justify-between gap-4 py-2 px-3 rounded-lg bg-neutral-50 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs shrink-0">
                  {page.pageType.tag === "Database" ? "⊞" : "📄"}
                </span>
                <span className="text-sm truncate">
                  {page.title || "Untitled"}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleRestore(page.id)}
                  className="text-xs px-2 py-1 rounded text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                >
                  Restore
                </button>
                <button
                  onClick={() => handlePurge(page.id)}
                  className="text-xs px-2 py-1 rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                >
                  Delete permanently
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
