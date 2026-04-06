"use client";

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
