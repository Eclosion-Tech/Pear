"use client";

import { useMemo } from "react";
import { useTable, useReducer } from "spacetimedb/react";
import { tables, reducers } from "@/src/module_bindings";

// ── Table hooks ───────────────────────────────────────────────────────────────

export function useApiEndpoints() {
  const [endpoints, isReady] = useTable(tables.api_endpoint);
  return { endpoints, isReady };
}

export function useApiFieldMappings() {
  const [mappings, isReady] = useTable(tables.api_field_mapping);
  return { mappings, isReady };
}

export function useApiFieldMappingsForEndpoint(endpointId: bigint) {
  const { mappings } = useApiFieldMappings();
  return mappings
    .filter((m) => m.endpointId === endpointId)
    .sort((a, b) => a.fieldOrder - b.fieldOrder);
}

/**
 * All API keys the current identity is allowed to see.
 *
 * Visibility note: `api_endpoint_key` is RLS'd to `created_by = :sender`
 * server-side, so this returns only keys the *current operator* minted.
 * That's intentional — labels / created_at / last_used_at are operator
 * metadata, not workspace-shared metadata. Other workspace members get an
 * empty array even for the same endpoint, and that's the right behaviour.
 *
 * Module owners (lifecycle / worker / per-workspace service identity)
 * bypass RLS and would see every row, but those identities never call this
 * hook — the React UI only ever runs as the human operator.
 */
export function useApiEndpointKeys() {
  const [keys, isReady] = useTable(tables.api_endpoint_key);
  return { keys, isReady };
}

export function useApiEndpointKeysForEndpoint(endpointId: bigint) {
  const { keys, isReady } = useApiEndpointKeys();
  // Sort newest-first so freshly minted keys land at the top of the list,
  // which is what the operator looks for right after `Generate`.
  return useMemo(
    () => ({
      keys: keys
        .filter((k) => k.endpointId === endpointId)
        .sort((a, b) =>
          a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch
            ? 1
            : -1
        ),
      isReady,
    }),
    [keys, endpointId, isReady]
  );
}

// ── Reducer hooks ─────────────────────────────────────────────────────────────

export function useCreateApiEndpoint() {
  return useReducer(reducers.createApiEndpoint);
}

export function useUpdateApiEndpoint() {
  return useReducer(reducers.updateApiEndpoint);
}

export function useDeleteApiEndpoint() {
  return useReducer(reducers.deleteApiEndpoint);
}

export function useCreateApiFieldMapping() {
  return useReducer(reducers.createApiFieldMapping);
}

export function useUpdateApiFieldMapping() {
  return useReducer(reducers.updateApiFieldMapping);
}

export function useDeleteApiFieldMapping() {
  return useReducer(reducers.deleteApiFieldMapping);
}

export function useCreateApiEndpointKey() {
  return useReducer(reducers.createApiEndpointKey);
}

export function useRevokeApiEndpointKey() {
  return useReducer(reducers.revokeApiEndpointKey);
}

// ── Derived types ─────────────────────────────────────────────────────────────

export type ApiEndpointRow = ReturnType<
  typeof useApiEndpoints
>["endpoints"][number];

export type ApiFieldMappingRow = ReturnType<
  typeof useApiFieldMappings
>["mappings"][number];
