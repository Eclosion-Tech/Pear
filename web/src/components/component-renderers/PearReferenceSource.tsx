"use client";

import { useCallback, useMemo } from "react";
import type { PulpMutations, ReferenceAdapter, ReferenceSourceProps } from "@eclosion-tech/pulp";
import { useComponentTree } from "@/src/hooks/useComponentTree";
import { useCreateAttachment, useDeleteComponent, useInsertComponent, useMoveComponent,
  useRestoreComponent, useSaveComponentYjsState, useUpdateComponentProps } from "@/src/hooks/usePages";
import { AudioAttachmentContext } from "@/src/components/AudioAttachmentContext";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { usePageAccess } from "@/src/hooks/usePageAccess";
import { blockReferenceHref, parseBlockReferenceLink } from "@/src/lib/blockReferenceLink";

function PearReferenceSource({ target, children }: ReferenceSourceProps) {
  const { idbNamespace } = useWorkspace();
  const purge = useCallback((id: bigint) => {
    if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase(`pear:${idbNamespace}:component:${id}`);
  }, [idbNamespace]);
  const tree = useComponentTree(target.surfaceId, {
    onDelete: (row) => purge(row.id),
    onUpdate: (before, after) => { if (before.deletedAt == null && after.deletedAt != null) purge(after.id); },
  });
  const insertBlock = useInsertComponent();
  const deleteBlock = useDeleteComponent();
  const restoreBlock = useRestoreComponent();
  const moveBlock = useMoveComponent();
  const updateBlockProps = useUpdateComponentProps();
  const saveYjsState = useSaveComponentYjsState();
  const mutations = useMemo<PulpMutations>(() => ({
    insertBlock: (args) => insertBlock({ ...args, afterSiblingId: args.afterSiblingId }),
    moveBlock: (args) => moveBlock({ ...args, afterSiblingId: args.afterSiblingId }),
    deleteBlock, restoreBlock, updateBlockProps, saveYjsState }),
  [insertBlock, deleteBlock, restoreBlock, moveBlock, updateBlockProps, saveYjsState]);
  const { pages, ready, permission } = usePageAccess(target.surfaceId);
  const sourcePage = pages.find((page) => page.id === target.surfaceId);
  const sourceTree = useMemo(() => ({ ...tree, loading: tree.loading || !ready,
    root: sourcePage ? tree.root : null,
    byId: sourcePage ? tree.byId : new Map(),
  }), [tree, ready, sourcePage]);
  const createAttachment = useCreateAttachment();
  const attachments = useMemo(() => ({ pageId: target.surfaceId, createAttachment }), [target.surfaceId, createAttachment]);
  // The containing page's comment callback creates threads on that page.
  // Source comments remain available via Open source.
  const config = useMemo(() => ({ onCommentBlock: undefined }), []);
  return <AudioAttachmentContext.Provider value={attachments}>
    {children({ tree: sourceTree, mutations, label: sourcePage?.title || "Untitled", readOnly: permission !== "Write", config })}
  </AudioAttachmentContext.Provider>;
}

export const pearReferences: ReferenceAdapter = {
  Source: PearReferenceSource,
  href: blockReferenceHref,
  parseLink: (value) => parseBlockReferenceLink(value, window.location.origin),
};
