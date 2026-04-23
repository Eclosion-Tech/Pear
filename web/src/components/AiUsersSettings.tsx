"use client";

import { useCallback, useState } from "react";
import { useTable, useSpacetimeDB } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  useAiUserProfiles,
  useDisableAiUserMemory,
  useProvisionAiUserMemory,
} from "@/src/hooks/useAiUsers";

/**
 * Workspace settings: per–AI-user options. Currently supports enabling a hidden
 * Doc subtree used for long-lived persona / memory (see `provision_ai_user_memory`).
 */
export function AiUsersSettings() {
  const { isActive } = useSpacetimeDB();
  const { profiles } = useAiUserProfiles();
  const [memories] = useTable(tables.ai_user_memory);
  const provisionMemory = useProvisionAiUserMemory();
  const disableMemory = useDisableAiUserMemory();
  const [busyId, setBusyId] = useState<bigint | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const memoryRowFor = (aiUserId: bigint) =>
    memories.find((m) => m.aiUserId === aiUserId);

  const onToggleMemory = useCallback(
    async (aiUserId: bigint, enable: boolean) => {
      setErr(null);
      setBusyId(aiUserId);
      try {
        if (enable) {
          await provisionMemory({ aiUserId });
        } else {
          const ok = window.confirm(
            "Turn off private memory for this AI user? Hidden memory pages will be soft-deleted (moved to trash). You can enable again later to start a fresh subtree.",
          );
          if (!ok) return;
          await disableMemory({ aiUserId });
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [provisionMemory, disableMemory],
  );

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-4">
        AI users
      </h2>

      {!isActive ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Connect to the workspace to manage AI users.
        </p>
      ) : profiles.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No AI users in this workspace yet.
        </p>
      ) : (
        <ul className="space-y-6">
          {profiles.map((p) => {
            const hasMemory = memoryRowFor(p.aiUserId) !== undefined;
            const busy = busyId === p.aiUserId;
            return (
              <li
                key={p.aiUserId.toString()}
                className="py-3 border-b border-neutral-200 dark:border-neutral-800 last:border-0"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-medium text-neutral-900 dark:text-white">
                      {p.displayName}
                    </div>
                    <div className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
                      {p.providerName} · {p.modelName}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                      Private memory pages
                    </div>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 max-w-md">
                      Hidden Doc subtree injected into this assistant&apos;s system context for
                      persona, notes, and long-term memory. Only creators and admins can change
                      this.
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={hasMemory}
                    disabled={busy}
                    onClick={() => void onToggleMemory(p.aiUserId, !hasMemory)}
                    className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-green-500 dark:focus-visible:ring-offset-neutral-900 disabled:opacity-50 ${
                      hasMemory
                        ? "bg-green-600 border-green-600"
                        : "bg-neutral-200 border-neutral-300 dark:bg-neutral-700 dark:border-neutral-600"
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow transition-transform mt-px ${
                        hasMemory ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {err ? (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">
          {err}
        </p>
      ) : null}
    </section>
  );
}
