"use client";

import { useEffect, useState } from "react";
import { usePearWorkspaceSlug } from "@/src/lib/blobUpload";

/**
 * Workspace storage usage: used vs quota, read from the deployment's blob
 * API (`GET /api/workspaces/:slug/blobs`). Renders nothing when the
 * endpoint isn't available (e.g. a deployment without blob accounting).
 */

type Usage = { usedBytes: number; quotaBytes: number };

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function StorageUsagePanel() {
  const slug = usePearWorkspaceSlug();
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/workspaces/${encodeURIComponent(slug)}/blobs?limit=1`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as Partial<Usage>;
        if (cancelled) return;
        if (typeof data.usedBytes === "number" && typeof data.quotaBytes === "number") {
          setUsage({ usedBytes: data.usedBytes, quotaBytes: data.quotaBytes });
        }
      } catch {
        // No blob accounting on this deployment — stay hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!usage || usage.quotaBytes <= 0) return null;

  const pct = Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100);
  const nearFull = pct >= 90;

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-white mb-2">Storage</h2>
      <div className="rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-3 py-2.5">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-sm text-neutral-700 dark:text-neutral-300">
            {formatBytes(usage.usedBytes)} used
          </span>
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            of {formatBytes(usage.quotaBytes)}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              nearFull ? "bg-red-500" : "bg-blue-500"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {nearFull && (
          <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
            Storage almost full — new file uploads and imported attachments will be skipped once
            the quota is reached.
          </p>
        )}
      </div>
    </section>
  );
}
