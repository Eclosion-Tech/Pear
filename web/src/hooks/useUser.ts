"use client";

import { useTable, useSpacetimeDB } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";

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
