"use client";

import { useTable, useReducer } from "spacetimedb/react";
import { tables, reducers } from "@/src/module_bindings";

// ── Table hooks ───────────────────────────────────────────────────────────────

export function useExtensionManifests() {
  const [manifests, isReady] = useTable(tables.extension_manifest);
  return { manifests, isReady };
}

export function useInstalledExtensions() {
  const [installed, isReady] = useTable(tables.installed_extension);
  return { installed, isReady };
}

export function useExtensionRuntimeHealth() {
  const [health, isReady] = useTable(tables.extension_runtime_health);
  return { health, isReady };
}

/** Permission grants on installs owned by the caller (per-caller view). */
export function useMyExtensionPermissions() {
  const [permissions, isReady] = useTable(tables.my_extension_permissions);
  return { permissions, isReady };
}

// ── Reducer hooks ─────────────────────────────────────────────────────────────

export function usePublishExtension() {
  return useReducer(reducers.publishExtension);
}

export function useInstallExtension() {
  return useReducer(reducers.installExtension);
}

export function useConfirmExtensionInstall() {
  return useReducer(reducers.confirmExtensionInstall);
}

export function useCancelExtensionInstall() {
  return useReducer(reducers.cancelExtensionInstall);
}

export function useUninstallExtension() {
  return useReducer(reducers.uninstallExtension);
}

export function useSetExtensionEnabled() {
  return useReducer(reducers.setExtensionEnabled);
}

export function useGrantExtensionPermission() {
  return useReducer(reducers.grantExtensionPermission);
}

export function useRevokeExtensionPermission() {
  return useReducer(reducers.revokeExtensionPermission);
}

export function useSetMcpServerApiKey() {
  return useReducer(reducers.setMcpServerApiKey);
}

export function useUpdateExtension() {
  return useReducer(reducers.updateExtension);
}

export function useSeedBuiltinExtensions() {
  return useReducer(reducers.seedBuiltinExtensions);
}

// ── Derived types ─────────────────────────────────────────────────────────────

export type ExtensionManifestRow = ReturnType<
  typeof useExtensionManifests
>["manifests"][number];

export type InstalledExtensionRow = ReturnType<
  typeof useInstalledExtensions
>["installed"][number];

export type ExtensionRuntimeHealthRow = ReturnType<
  typeof useExtensionRuntimeHealth
>["health"][number];

export type MyExtensionPermissionRow = ReturnType<
  typeof useMyExtensionPermissions
>["permissions"][number];
