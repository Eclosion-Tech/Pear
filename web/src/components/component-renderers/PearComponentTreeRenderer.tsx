"use client";

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import {
  BlockEditor,
  PulpProvider,
  SurfaceFocusCoordinator,
  SurfaceFocusProvider,
  SurfaceUndoCoordinator,
  SurfaceUndoProvider,
  registerCoreBlocks,
  validateComponentProps,
  type BlockInsertEvent,
  type BlockTree,
} from "@eclosion-tech/pulp";
import type { ComponentNode } from "@/src/module_bindings/types";
import {
  useComponentTree,
  useEnsureBuiltinComponentTypes,
} from "@/src/hooks/useComponentTree";
import {
  filterNavVisiblePages,
  useChildPages,
  useDeleteComponent,
  useInsertComponent,
  useMoveComponent,
  usePages,
  useRestoreComponent,
  useSaveComponentYjsState,
  useUpdateComponentProps,
  type PageRow,
} from "@/src/hooks/usePages";
import { useSyncChildPageLinks } from "@/src/hooks/useSyncChildPageLinks";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { AudioAttachmentContext } from "@/src/components/AudioAttachmentContext";
import { useCreateAttachment } from "@/src/hooks/usePages";
import { registerPearBuiltinRenderers } from "./built-in";
import { PEAR_SLASH_ITEMS, slashItemsForDefs } from "./pearSlashItems";

registerCoreBlocks();
registerPearBuiltinRenderers();

/**
 * Pear's ComponentTree page surface — wires SpacetimeDB subscriptions
 * and reducers into `@eclosion-tech/pulp`'s storage-agnostic editor.
 */
export function ComponentTreeRenderer({ surfaceId }: { surfaceId: bigint }) {
  const { idbNamespace } = useWorkspace();
  const insertComponent = useInsertComponent();
  const deleteComponent = useDeleteComponent();
  const restoreComponent = useRestoreComponent();
  const moveComponent = useMoveComponent();
  const updateComponentProps = useUpdateComponentProps();
  const saveComponentYjsState = useSaveComponentYjsState();
  const createAttachment = useCreateAttachment();
  const { pages } = usePages();
  const { children: childPages } = useChildPages(surfaceId);

  const focusCoordinatorRef = useRef<SurfaceFocusCoordinator | null>(null);
  if (focusCoordinatorRef.current == null) {
    focusCoordinatorRef.current = new SurfaceFocusCoordinator();
  }
  const focusCoordinator = focusCoordinatorRef.current;

  const undoCoordinatorRef = useRef<SurfaceUndoCoordinator | null>(null);
  if (undoCoordinatorRef.current == null) {
    undoCoordinatorRef.current = new SurfaceUndoCoordinator();
  }
  const undoCoordinator = undoCoordinatorRef.current;

  const saveYjsRef = useRef(saveComponentYjsState);
  saveYjsRef.current = saveComponentYjsState;
  const surfaceIdRef = useRef(surfaceId);
  surfaceIdRef.current = surfaceId;

  const onNodeInsert = useCallback(
    (row: ComponentNode) => {
      const event: BlockInsertEvent = {
        id: row.id,
        surfaceId: row.surfaceId,
        parentId: row.parentId,
        deletedAt: row.deletedAt,
      };
      focusCoordinator.handleNodeInsert(event, surfaceIdRef.current, (id, data) => {
        saveYjsRef.current({ componentId: id, data });
      });
      undoCoordinator.handleNodeInsert(row.id);
    },
    [focusCoordinator, undoCoordinator],
  );

  // Purge a node's per-component IndexedDB doc so removed content can't linger
  // locally or resurface via a stale local↔server Yjs merge. Keyed exactly as
  // pulp's RichTextEditor persistence: `pear:{idbNamespace}:component:{id}`.
  // Best-effort and idempotent. Restore is unaffected: the server keeps the
  // node's authoritative `component_yjs_state`, so a re-shown block rehydrates
  // from the server blob (RichText.tsx applies it with origin="remote").
  const purgeComponentIdb = useCallback(
    (componentId: bigint) => {
      if (typeof indexedDB === "undefined") return;
      try {
        indexedDB.deleteDatabase(`pear:${idbNamespace}:component:${componentId}`);
      } catch {
        // local cleanup is best-effort; ignore failures
      }
    },
    [idbNamespace],
  );

  // Hard delete / lost visibility: the row left the subscription entirely.
  const onNodeDelete = useCallback(
    (row: ComponentNode) => purgeComponentIdb(row.id),
    [purgeComponentIdb],
  );

  // Soft delete: the row stays but gains `deletedAt` (e.g. the worker's
  // reducer-driven content replace soft-deletes the old blocks). Purge on the
  // null → set transition only.
  const onNodeUpdate = useCallback(
    (oldRow: ComponentNode, newRow: ComponentNode) => {
      if (oldRow.deletedAt == null && newRow.deletedAt != null) {
        purgeComponentIdb(newRow.id);
      }
    },
    [purgeComponentIdb],
  );

  const tree = useComponentTree(surfaceId, {
    onInsert: onNodeInsert,
    onDelete: onNodeDelete,
    onUpdate: onNodeUpdate,
  }) as BlockTree & {
    loading: boolean;
  };
  useEnsureBuiltinComponentTypes(tree.defs, !tree.loading);
  const treeRef = useRef(tree);
  treeRef.current = tree;

  useLayoutEffect(() => {
    focusCoordinator.syncTree(tree, (id, data) => {
      saveYjsRef.current({ componentId: id, data });
    });
  }, [tree, focusCoordinator]);

  const rawMutations = useMemo(
    () => ({
      insertBlock: ({
        parentId,
        componentType,
        propsJson,
        afterSiblingId,
      }: {
        parentId: bigint;
        componentType: string;
        propsJson: string;
        afterSiblingId?: bigint;
      }) => {
        if (!treeRef.current.defs.has(componentType)) {
          console.warn(
            `[ComponentTree] cannot insert "${componentType}" — not registered in this workspace. ` +
              "Publish Pear module ≥0.11.3 and run migrations.",
          );
          return;
        }
        insertComponent({
          parentId,
          componentType,
          propsJson,
          afterSiblingId,
        });
      },
      deleteBlock: ({ componentId }: { componentId: bigint }) =>
        deleteComponent({ componentId }),
      restoreBlock: ({ componentId }: { componentId: bigint }) =>
        restoreComponent({ componentId }),
      moveBlock: ({
        componentId,
        newParentId,
        afterSiblingId,
      }: {
        componentId: bigint;
        newParentId: bigint;
        afterSiblingId?: bigint;
      }) =>
        moveComponent({ componentId, newParentId, afterSiblingId }),
      updateBlockProps: ({
        componentId,
        propsJson,
      }: {
        componentId: bigint;
        propsJson: string;
      }) => updateComponentProps({ componentId, propsJson }),
      saveYjsState: ({
        componentId,
        data,
      }: {
        componentId: bigint;
        data: Uint8Array;
      }) => saveComponentYjsState({ componentId, data }),
    }),
    [
      insertComponent,
      deleteComponent,
      restoreComponent,
      moveComponent,
      updateComponentProps,
      saveComponentYjsState,
    ],
  );

  const mutations = useMemo(
    () =>
      undoCoordinator.wrapMutations(rawMutations, () => treeRef.current),
    [rawMutations, undoCoordinator],
  );

  const insertPageLink = useCallback(
    (args: {
      parentId: bigint;
      propsJson: string;
      afterSiblingId?: bigint;
    }) => {
      insertComponent({
        parentId: args.parentId,
        componentType: "PageLink",
        propsJson: args.propsJson,
        afterSiblingId: args.afterSiblingId,
      });
    },
    [insertComponent],
  );

  const deletePageLink = useCallback(
    (componentId: bigint) => {
      deleteComponent({ componentId });
    },
    [deleteComponent],
  );

  useSyncChildPageLinks({
    surfaceId,
    tree,
    childPages,
    insertPageLink,
    deletePageLink,
  });

  const config = useMemo(
    () => ({
      idbPrefix: `pear:${idbNamespace}`,
      validateProps: validateComponentProps,
      slashItems: slashItemsForDefs(PEAR_SLASH_ITEMS, tree.defs),
      linkTargets: filterNavVisiblePages(pages).map((page) => ({
        id: String(page.id),
        label: page.title || "Untitled",
        href: `/workspace/${page.id}`,
        subtitle: buildBreadcrumb(page, pages),
      })),
    }),
    [idbNamespace, pages, tree.defs],
  );

  const attachmentCtx = useMemo(
    () => ({ pageId: surfaceId, createAttachment }),
    [surfaceId, createAttachment],
  );

  return (
    <AudioAttachmentContext.Provider value={attachmentCtx}>
      <PulpProvider tree={tree} config={config} mutations={mutations}>
        <SurfaceFocusProvider coordinator={focusCoordinator}>
          <SurfaceUndoProvider coordinator={undoCoordinator}>
            <BlockEditor />
          </SurfaceUndoProvider>
        </SurfaceFocusProvider>
      </PulpProvider>
    </AudioAttachmentContext.Provider>
  );
}

function buildBreadcrumb(page: PageRow, allPages: PageRow[]): string {
  const parts: string[] = [];
  let cur = page;
  while (cur.parentId != null) {
    const parent = allPages.find((p) => p.id === cur.parentId);
    if (!parent) break;
    parts.unshift(parent.title || "Untitled");
    cur = parent;
  }
  return parts.join(" / ");
}
