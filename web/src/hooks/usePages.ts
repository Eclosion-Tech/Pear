"use client";

import { useTable, useReducer, useSpacetimeDB } from "spacetimedb/react";
import { tables, reducers } from "@/src/module_bindings";

/** All non-deleted pages, live-synced. */
export function usePages() {
  const [pages, isReady] = useTable(tables.page);
  const active = pages.filter((p) => p.deletedAt == null);
  return { pages: active, isReady };
}

/** Child pages of a given parent (the "rows" of a database). */
export function useChildPages(parentId: bigint) {
  const { pages, isReady } = usePages();
  const children = pages.filter((p) => p.parentId === parentId);
  return { children, isReady };
}

/** Root-level pages (no parent). */
export function useRootPages() {
  const { pages, isReady } = usePages();
  const roots = pages.filter((p) => p.parentId == null);
  return { roots, isReady };
}

export function useCreatePage() {
  return useReducer(reducers.createPage);
}

export function useUpdatePageTitle() {
  return useReducer(reducers.updatePageTitle);
}

export function useUpdatePageContent() {
  return useReducer(reducers.updatePageContent);
}

export function useDeletePage() {
  return useReducer(reducers.deletePage);
}

export function useCreateDatabaseSchema() {
  return useReducer(reducers.createDatabaseSchema);
}

export function useAddProperty() {
  return useReducer(reducers.addProperty);
}

export function useSetPropertyValue() {
  return useReducer(reducers.setPropertyValue);
}

export function useApplyYjsUpdate() {
  return useReducer(reducers.applyYjsUpdate);
}

export function useCreateView() {
  return useReducer(reducers.createView);
}

export function useConnection() {
  return useSpacetimeDB();
}

// Row type inferred from table query builder
export type PageRow = ReturnType<typeof usePages>["pages"][number];
