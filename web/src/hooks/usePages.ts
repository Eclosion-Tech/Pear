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

/** Ancestors of a page from root to immediate parent (for breadcrumbs). */
export function usePageAncestors(pageId: bigint) {
  const { pages } = usePages();
  const page = pages.find((p) => p.id === pageId);
  if (!page) return [];
  const ancestors: Array<{ id: bigint; title: string }> = [];
  let parentId = page.parentId;
  while (parentId != null) {
    const parent = pages.find((p) => p.id === parentId);
    if (!parent) break;
    ancestors.unshift({ id: parent.id, title: parent.title || "Untitled" });
    parentId = parent.parentId;
  }
  return ancestors;
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

export function useUpdatePageIcon() {
  return useReducer(reducers.updatePageIcon);
}

export function useSetPageEmbedding() {
  return useReducer(reducers.setPageEmbedding);
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
    .sort((a, b) => Number(b.snapshotAt.microsSinceUnixEpoch - a.snapshotAt.microsSinceUnixEpoch));
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

export function useSaveYjsState() {
  return useReducer(reducers.saveYjsState);
}

export function useCreateView() {
  return useReducer(reducers.createView);
}

export function useConnection() {
  return useSpacetimeDB();
}

/** Attachments for a page (files in S3/MinIO, metadata in SpacetimeDB). */
export function usePageAttachments(pageId: bigint) {
  const [attachments] = useTable(tables.attachment);
  return attachments.filter((a) => a.pageId === pageId);
}

export function useCreateAttachment() {
  return useReducer(reducers.createAttachment);
}

export function useDeleteAttachment() {
  return useReducer(reducers.deleteAttachment);
}

// Row type inferred from table query builder
export type PageRow = ReturnType<typeof usePages>["pages"][number];
