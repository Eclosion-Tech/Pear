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
import { useComponentTree } from "@/src/hooks/useComponentTree";
import {
  useDeleteComponent,
  useInsertComponent,
  useMoveComponent,
  useRestoreComponent,
  useSaveComponentYjsState,
  useUpdateComponentProps,
} from "@/src/hooks/usePages";
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

  const tree = useComponentTree(surfaceId, { onInsert: onNodeInsert }) as BlockTree;
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

  const config = useMemo(
    () => ({
      idbPrefix: `pear:${idbNamespace}`,
      validateProps: validateComponentProps,
      slashItems: slashItemsForDefs(PEAR_SLASH_ITEMS, tree.defs),
    }),
    [idbNamespace, tree.defs],
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
