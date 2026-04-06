"use client";

import { useEffect, useRef, useState } from "react";
import { useCurrentUser } from "@/src/hooks/useUser";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import {
  resolveWorkspaceDbName,
  resolveWorkspaceWsUri,
} from "@/src/lib/workspaceConnections";
import { LoginGate } from "./LoginGate";

const CONNECTION_TIMEOUT_MS = 12_000;

/**
 * Rendered inside SpacetimeDBProvider. Blocks the app until the user has
 * completed login/register (user.is_authenticated === true).
 *
 * If the connection doesn't establish within CONNECTION_TIMEOUT_MS, an inline
 * workspace switcher is shown so the user can recover without being trapped.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isReady } = useCurrentUser();
  const { workspaces, activeWorkspace, activeId, setActiveId, removeWorkspace } =
    useWorkspace();
  const wasReadyRef = useRef(false);
  const [timedOut, setTimedOut] = useState(false);

  if (isReady) wasReadyRef.current = true;

  useEffect(() => {
    if (wasReadyRef.current) return;
    const t = setTimeout(() => {
      if (!wasReadyRef.current) setTimedOut(true);
    }, CONNECTION_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  if (!wasReadyRef.current) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-white dark:bg-neutral-950 px-6">
        <p className="text-neutral-400 dark:text-neutral-500 text-sm">
          {timedOut ? "Unable to connect to this workspace." : "Connecting…"}
        </p>
        {timedOut && (
          <div className="mt-6 w-full max-w-sm">
            <p className="text-center text-xs text-neutral-500 dark:text-neutral-400 mb-4">
              The server at{" "}
              <code className="bg-neutral-100 dark:bg-neutral-800 px-1 rounded text-[11px]">
                {activeWorkspace
                  ? `${resolveWorkspaceWsUri(activeWorkspace.wsUri)} / ${resolveWorkspaceDbName(activeWorkspace.dbName)}`
                  : "unknown"}
              </code>{" "}
              didn't respond. Switch to another workspace or remove this one.
            </p>

            <ul className="space-y-2">
              {workspaces.map((w) => {
                const isCurrent = w.id === activeId;
                return (
                  <li
                    key={w.id}
                    className={`flex items-center gap-2 px-3 py-2 rounded border text-sm ${
                      isCurrent
                        ? "border-red-400/60 dark:border-red-500/40 bg-red-50/50 dark:bg-red-950/20"
                        : "border-neutral-200 dark:border-neutral-800"
                    }`}
                  >
                    <span className="flex-1 min-w-0 truncate font-medium text-neutral-900 dark:text-white">
                      {w.name}
                      {isCurrent && (
                        <span className="ml-1.5 text-xs font-normal text-red-500 dark:text-red-400">
                          (unreachable)
                        </span>
                      )}
                    </span>

                    {!isCurrent && (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveId(w.id);
                          window.location.reload();
                        }}
                        className="shrink-0 px-2.5 py-1 rounded text-xs font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90"
                      >
                        Switch
                      </button>
                    )}

                    {workspaces.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          if (!confirm(`Remove workspace "${w.name}"?`)) return;
                          removeWorkspace(w.id);
                          if (isCurrent) window.location.reload();
                        }}
                        className="shrink-0 text-xs text-red-600 dark:text-red-400 hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    );
  }

  if (!user?.isAuthenticated) {
    return <LoginGate />;
  }

  return <>{children}</>;
}
