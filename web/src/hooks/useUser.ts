"use client";

import { useTable, useSpacetimeDB } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";

/** All authenticated users in the workspace, deduplicated by email.
 *  The same person can have multiple Identity rows (different sessions/devices).
 *  We keep the most recently seen row per email. */
export function useUsers() {
  const [users, isReady] = useTable(tables.user);
  const authenticated = users.filter((u) => u.isAuthenticated);
  const byEmail = new Map<string, (typeof authenticated)[number]>();
  for (const u of authenticated) {
    const key = u.email || u.identity.toHexString();
    const existing = byEmail.get(key);
    if (!existing || u.lastSeenAt.microsSinceUnixEpoch > existing.lastSeenAt.microsSinceUnixEpoch) {
      byEmail.set(key, u);
    }
  }
  return { users: [...byEmail.values()], isReady };
}

export type UserRow = ReturnType<typeof useUsers>["users"][number];

/** Returns the current user's row from the User table, plus derived display helpers. */
export function useCurrentUser() {
  const { identity } = useSpacetimeDB();
  const [users, isReady] = useTable(tables.user);

  const user = identity
    ? users.find((u) => u.identity.isEqual(identity))
    : undefined;

  const displayName =
    user?.name || user?.email || (identity ? identity.toHexString().slice(0, 8) : "");

  const initials = (() => {
    if (user?.name) {
      const parts = user.name.trim().split(/\s+/);
      return parts.length >= 2
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : parts[0].slice(0, 2).toUpperCase();
    }
    if (user?.email) return user.email[0].toUpperCase();
    return "?";
  })();

  return { user, displayName, initials, isReady };
}
