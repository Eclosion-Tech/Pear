"use client";

import { useReducer, useTable } from "spacetimedb/react";
import { reducers, tables } from "@/src/module_bindings";

/**
 * Workspace-wide policy settings, as opposed to `useUserPreferences` which is
 * per-person. Writes are admin-only, enforced by the reducer.
 */
export function useWorkspaceSettings() {
  return useTable(tables.workspace_setting);
}

/** Read one setting's raw JSON value, or undefined when unset. */
export function useWorkspaceSetting(key: string): string | undefined {
  const [settings] = useTable(tables.workspace_setting);
  return settings.find((s) => s.key === key)?.valueJson;
}

export function useSetWorkspaceSetting() {
  return useReducer(reducers.setWorkspaceSetting);
}
