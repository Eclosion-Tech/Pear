"use client";

import { useMemo } from "react";
import { useTable, useReducer, useSpacetimeDB } from "spacetimedb/react";
import { tables, reducers } from "@/src/module_bindings";

// All derivations in this file are wrapped in useMemo keyed on the raw
// useTable snapshot, which is referentially stable between row events
// (useSyncExternalStore caches it). Unmemoized `.filter()` here returns a
// fresh array identity every render, which silently defeats every
// downstream useMemo/effect dep in consumers (ticket 14378).

/** All non-deleted pages, live-synced. */
export function usePages() {
  const [pages, isReady] = useTable(tables.page);
  const active = useMemo(
    () => pages.filter((p) => p.deletedAt == null),
    [pages],
  );
  return { pages: active, isReady };
}

/** Sidebar, quick switcher, etc.: omit `is_hidden` infrastructure pages (e.g. AI memory roots). */
export function filterNavVisiblePages<T extends { isHidden: boolean }>(pages: T[]): T[] {
  return pages.filter((p) => !p.isHidden);
}

/** Child pages of a given parent (the "rows" of a database). */
export function useChildPages(parentId: bigint) {
  const { pages, isReady } = usePages();
  const children = useMemo(
    () => pages.filter((p) => p.parentId === parentId),
    [pages, parentId],
  );
  return { children, isReady };
}

/** Root-level pages (no parent). */
export function useRootPages() {
  const { pages, isReady } = usePages();
  const roots = useMemo(
    () => pages.filter((p) => p.parentId == null),
    [pages],
  );
  return { roots, isReady };
}

const NO_ANCESTORS: Array<{ id: bigint; title: string }> = [];

/** Ancestors of a page from root to immediate parent (for breadcrumbs). */
export function usePageAncestors(pageId: bigint) {
  const { pages } = usePages();
  return useMemo(() => {
    const byId = new Map(pages.map((p) => [p.id, p]));
    const page = byId.get(pageId);
    if (!page) return NO_ANCESTORS;
    const ancestors: Array<{ id: bigint; title: string }> = [];
    let parentId = page.parentId;
    while (parentId != null) {
      const parent = byId.get(parentId);
      if (!parent) break;
      ancestors.unshift({ id: parent.id, title: parent.title || "Untitled" });
      parentId = parent.parentId;
    }
    return ancestors;
  }, [pages, pageId]);
}

export function useMovePage() {
  return useReducer(reducers.movePage);
}

export function useCreatePage() {
  return useReducer(reducers.createPage);
}

/**
 * Alias for `create_component_tree_page`. New **Doc** pages created via
 * `create_page` already seed a ComponentTree — use this only when you need
 * the explicit reducer (e.g. legacy call sites).
 */
export function useCreateComponentTreePage() {
  return useReducer(reducers.createComponentTreePage);
}

/**
 * `insert_component(parent_id, component_type, props_json, after_sibling_id)`
 * — inserts a new live ComponentNode under `parent_id`. Used by the empty-
 * tree affordance in `<ComponentTreeRenderer>`, the BlockChrome `+` button,
 * Enter-at-end-of-RichText, and (sprint 3b) the slash menu.
 */
export function useInsertComponent() {
  return useReducer(reducers.insertComponent);
}

/**
 * `move_component(component_id, new_parent_id, after_sibling_id)` — moves
 * a live node within or between Container parents. Used by the drag-and-
 * drop (`@dnd-kit/sortable`) flow in `<ComponentTreeRenderer>` and the
 * block grip handle.
 */
export function useMoveComponent() {
  return useReducer(reducers.moveComponent);
}

/**
 * `delete_component(component_id)` — soft-deletes a live node (sets
 * `deleted_at`, clamps any pending children to the parent). Used by the
 * BlockChrome trash button and Backspace-at-start-of-empty-RichText.
 * The root component is rejected server-side per `PEAR_COMPONENT_NODE_
 * SCHEMA.md` § Integrity model — delete the whole page instead.
 */
export function useDeleteComponent() {
  return useReducer(reducers.deleteComponent);
}

/**
 * `restore_component(component_id)` — soft-undelete a previously deleted
 * node. Used by the surface undo coordinator when reversing `deleteBlock`.
 */
export function useRestoreComponent() {
  return useReducer(reducers.restoreComponent);
}

/** Idempotent post-publish hook — seeds new built-in component types. */
export function useRunPendingMigrations() {
  return useReducer(reducers.runPendingMigrations);
}

/**
 * `update_component_props(component_id, props_json)` — replaces the
 * stringified JSON props on a live node. Used by inline-editable
 * renderers (Heading text edits, Container layout switches) and the
 * sprint 3b slash menu's "Turn into…" flow.
 */
export function useUpdateComponentProps() {
  return useReducer(reducers.updateComponentProps);
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

/** Soft-delete a page AND its descendants — page-level delete affordances
 * use this so a tree behaves like a tree (single-row deletes stay single). */
export function useDeletePageSubtree() {
  return useReducer(reducers.deletePageSubtree);
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
  return useMemo(
    () =>
      snapshots
        .filter((s) => s.pageId === pageId)
        .sort((a, b) =>
          Number(
            b.snapshotAt.microsSinceUnixEpoch -
              a.snapshotAt.microsSinceUnixEpoch,
          ),
        ),
    [snapshots, pageId],
  );
}

/** Permanently delete every trashed page the caller can write. */
export function useEmptyTrash() {
  return useReducer(reducers.emptyTrash);
}

export function usePurgePage() {
  return useReducer(reducers.purgePage);
}

/** Soft-deleted pages (in trash). */
export function useDeletedPages() {
  const [pages, isReady] = useTable(tables.page);
  const deleted = useMemo(
    () => pages.filter((p) => p.deletedAt != null),
    [pages],
  );
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

/**
 * Per-`RichText`-component Yjs state save. Mirrors `useSaveYjsState`'s
 * shape but targets `save_component_yjs_state(componentId, data)` — see
 * `docs/PEAR_WEB_RENDERER.md` § Editor stack — Save cycle.
 */
export function useSaveComponentYjsState() {
  return useReducer(reducers.saveComponentYjsState);
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
  return useMemo(
    () => attachments.filter((a) => a.pageId === pageId),
    [attachments, pageId],
  );
}

export function useCreateAttachment() {
  return useReducer(reducers.createAttachment);
}

export function useDeleteAttachment() {
  return useReducer(reducers.deleteAttachment);
}

// Row type inferred from table query builder
export type PageRow = ReturnType<typeof usePages>["pages"][number];
