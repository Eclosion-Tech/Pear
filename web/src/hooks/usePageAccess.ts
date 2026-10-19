"use client";

import { useSpacetimeDB } from "spacetimedb/react";
import { tables } from "../module_bindings";
import type {
  ModuleInstallMeta,
  Page,
  PageAccessRule,
  User,
} from "../module_bindings/types";
import { useScopedTable } from "./useScopedTable";
import { effectivePagePermission, pageAccessScope } from "../lib/pageAccess";

/** Page ACLs authorize both the settings editor and the component's action. */
export function usePageAccess(surfaceId: bigint) {
  const { identity } = useSpacetimeDB();
  // SDK 2.0.3 useTable row callbacks capture the initial readiness flag.
  // commit_trellis_panel also touches page.updated_at, so the first save
  // could turn a loaded page's permission snapshot back into "not ready".
  // useScopedTable refreshes event listeners when readiness changes and
  // keeps observing the actual rows, including revoked/restored ACL grants.
  const { rows: pages, ready: pagesReady } = useScopedTable<Page>(
    tables.page,
    "SELECT * FROM page",
    (page) => page.deletedAt == null,
  );
  const { rows: rules, ready: rulesReady } = useScopedTable<PageAccessRule>(
    tables.page_access_rule,
    "SELECT * FROM page_access_rule",
    () => true,
  );
  const { rows: users, ready: usersReady } = useScopedTable<User>(
    tables.user,
    "SELECT * FROM user",
    () => true,
  );
  const { rows: install, ready: installReady } = useScopedTable<ModuleInstallMeta>(
    tables.module_install_meta,
    "SELECT * FROM module_install_meta",
    () => true,
  );
  const principal = identity?.toHexString() ?? "anonymous";
  const privileged =
    install[0]?.publisherIdentity.toHexString() === principal ||
    users.some(
      (user) =>
        user.identity.toHexString() === principal &&
        user.isAuthenticated &&
        user.isAdmin,
    );
  const ready = pagesReady && rulesReady && usersReady && installReady;
  const permission =
    ready &&
    principal !== "anonymous" &&
    pages.some((page) => page.id === surfaceId)
      ? effectivePagePermission(
          pageAccessScope(surfaceId, pages, rules),
          principal,
          privileged,
        )
      : null;
  return { principal, pages, ready, permission, canEdit: permission === "Write" };
}
