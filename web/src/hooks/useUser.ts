"use client";

import { useTable, useSpacetimeDB, useReducer } from "spacetimedb/react";
import { tables, reducers } from "@/src/module_bindings";

/** All authenticated users in the workspace, deduplicated by email.
 *  The same person can have multiple Identity rows (different sessions/devices).
 *  We keep the most recently seen row per email — but if any of the rows
 *  for that email is an admin we surface admin=true on the deduplicated
 *  entry, since admin status follows the *person*, not the device. */
export function useUsers() {
  const [users, isReady] = useTable(tables.user);
  const authenticated = users.filter((u) => u.isAuthenticated);
  const byEmail = new Map<string, (typeof authenticated)[number]>();
  for (const u of authenticated) {
    const key = u.email || u.identity.toHexString();
    const existing = byEmail.get(key);
    if (!existing) {
      byEmail.set(key, u);
      continue;
    }
    const newer =
      u.lastSeenAt.microsSinceUnixEpoch > existing.lastSeenAt.microsSinceUnixEpoch
        ? u
        : existing;
    // Hoist admin=true onto the chosen row — multi-device admins shouldn't
    // appear as non-admins just because their newest session is from a
    // device that hadn't been promoted (e.g. a brand-new tab connected
    // before client_connected ran the bootstrap path).
    byEmail.set(key, {
      ...newer,
      isAdmin: existing.isAdmin || u.isAdmin,
    });
  }
  return { users: [...byEmail.values()], isReady };
}

/** Imperative `set_user_admin` call. */
export function useSetUserAdmin() {
  return useReducer(reducers.setUserAdmin);
}

/** Admin-created native-login user for self-hosted/dev workspaces. */
export function useCreateLocalUser() {
  return useReducer(reducers.createLocalUser);
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
