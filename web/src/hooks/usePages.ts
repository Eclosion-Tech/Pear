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

export function useMovePage() {
  return useReducer(reducers.movePage);
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

export function useRestorePage() {
  return useReducer(reducers.restorePage);
}

export function useTakeSnapshot() {
  return useReducer(reducers.takeSnapshot);
}

export function useTakeSnapshotWithContent() {
  return useReducer(reducers.takeSnapshotWithContent);
}

export function useRestorePageToSnapshot() {
  return useReducer(reducers.restorePageToSnapshot);
}

/** Snapshots for a page, newest first. */
export function usePageSnapshots(pageId: bigint) {
  const [snapshots] = useTable(tables.page_snapshot);
  const forPage = snapshots
    .filter((s) => s.pageId === pageId)
    .sort((a, b) => Number(b.snapshotAt - a.snapshotAt));
  return forPage;
}

export function usePurgePage() {
  return useReducer(reducers.purgePage);
}

/** Soft-deleted pages (in trash). */
export function useDeletedPages() {
  const [pages, isReady] = useTable(tables.page);
  const deleted = pages.filter((p) => p.deletedAt != null);
  return { pages: deleted, isReady };
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
