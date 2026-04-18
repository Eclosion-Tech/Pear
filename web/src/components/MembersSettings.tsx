"use client";

import { useState } from "react";
import { useCurrentUser, useUsers, useSetUserAdmin } from "@/src/hooks/useUser";
import { useIdentityDriftRecovery } from "@/src/hooks/useIdentityDriftRecovery";

/**
 * Workspace members + admin role management.
 *
 * Admin model: any authenticated user can read and write workspace content
 * (Pages have no per-row ownership check). Admins additionally inherit
 * management rights over shared infrastructure rows that DO have a
 * `created_by` field — `api_endpoint`, `api_field_mapping`,
 * `api_endpoint_key`. The first user to authenticate on a fresh database
 * is auto-promoted; after that, only existing admins can promote/demote.
 *
 * The server enforces a "can't demote the last admin" rule, so the worst
 * case here is the action fails with a clear error message; the UI still
 * surfaces a confirm() before demotion to keep the foot-gun visible.
 */
export function MembersSettings() {
  const { users, isReady } = useUsers();
  const { user: currentUser } = useCurrentUser();
  const setUserAdmin = useSetUserAdmin();
  const checkDrift = useIdentityDriftRecovery();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentUserIsAdmin = currentUser?.isAdmin ?? false;
  // Sort: admins first, then by name/email so the page is deterministic.
  const sorted = [...users].sort((a, b) => {
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
    return (a.name || a.email).localeCompare(b.name || b.email);
  });

  async function handleToggleAdmin(
    targetIdentity: ReturnType<typeof useUsers>["users"][number]["identity"],
    targetLabel: string,
    nextIsAdmin: boolean
  ) {
    const verb = nextIsAdmin ? "promote" : "demote";
    if (!nextIsAdmin) {
      // Demotion is the only direction with a foot-gun (you can demote
      // yourself if there's >1 admin), so always confirm.
      const ok = window.confirm(
        `Demote ${targetLabel}? They'll lose admin rights and can't manage other users' API endpoints.`
      );
      if (!ok) return;
    }

    setBusy(targetIdentity.toHexString());
    setError(null);
    try {
      await setUserAdmin({ targetIdentity, isAdmin: nextIsAdmin });
    } catch (err) {
      if (checkDrift(err, `${verb} a workspace admin`)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-1">
        Members
      </h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-500 mb-4">
        Workspace admins inherit management rights over shared infrastructure
        like custom API endpoints and API keys.{" "}
        {!currentUserIsAdmin && (
          <span className="text-neutral-600 dark:text-neutral-400">
            Only admins can promote or demote other members.
          </span>
        )}
      </p>

      {!isReady ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          Loading members…
        </p>
      ) : sorted.length === 0 ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          No authenticated members yet.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
          {sorted.map((u) => {
            const isSelf = currentUser?.identity?.isEqual(u.identity) ?? false;
            const targetLabel = u.name || u.email || u.identity.toHexString().slice(0, 8);
            const idHex = u.identity.toHexString();
            const isBusy = busy === idHex;

            return (
              <li
                key={idHex}
                className="flex items-center gap-3 px-4 py-3 bg-white dark:bg-neutral-900"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">
                      {targetLabel}
                    </span>
                    {isSelf && (
                      <span className="text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-500">
                        you
                      </span>
                    )}
                    {u.isAdmin && (
                      <span className="text-[10px] uppercase tracking-wide font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded px-1.5 py-0.5">
                        Admin
                      </span>
                    )}
                  </div>
                  {u.email && u.email !== targetLabel && (
                    <p className="text-xs text-neutral-500 dark:text-neutral-500 truncate">
                      {u.email}
                    </p>
                  )}
                </div>

                {currentUserIsAdmin && (
                  <button
                    onClick={() =>
                      handleToggleAdmin(u.identity, targetLabel, !u.isAdmin)
                    }
                    disabled={isBusy}
                    className="shrink-0 px-2.5 py-1 text-xs rounded border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isBusy ? "…" : u.isAdmin ? "Demote" : "Promote to admin"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </section>
  );
}
