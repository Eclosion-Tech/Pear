"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
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
import type { ComponentNode, Conversation } from "@/src/module_bindings/types";
import { BlockThreadGutter } from "@/src/components/BlockThreadGutter";
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
import { useCreateConversation } from "@/src/hooks/useConversations";
import { useSpacetimeDB } from "spacetimedb/react";
import { registerPearBuiltinRenderers } from "./built-in";
import { PEAR_SLASH_ITEMS, slashItemsForDefs } from "./pearSlashItems";
import { useQueryResolver } from "@/src/lib/repeater/queryResolver";

registerCoreBlocks();
registerPearBuiltinRenderers();

/**
 * Jump-to-change highlight (#32): when the page is opened via a chat tool-call
 * deep link carrying `?node=<id>`, scroll that block into view and briefly flash
 * it. Pulp's `BlockChrome` already renders each block with `id="block-<id>"`, so
 * no editor changes are needed. Retries while the tree (and its IndexedDB Yjs
 * state) finishes loading.
 */
function useHighlightNodeFromUrl(surfaceId: bigint): void {
  const searchParams = useSearchParams();
  const nodeParam = searchParams.get("node");

  useEffect(() => {
    if (!nodeParam) return;
    let cancelled = false;
    let attempts = 0;

    const tryHighlight = () => {
      if (cancelled) return;
      const el = document.getElementById(`block-${nodeParam}`);
      if (!el) {
        if (attempts++ < 20) window.setTimeout(tryHighlight, 150);
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const prevTransition = el.style.transition;
      const prevBg = el.style.backgroundColor;
      el.style.transition = "background-color 0.25s ease";
      el.style.backgroundColor = "rgba(139, 92, 246, 0.18)"; // violet flash
      window.setTimeout(() => {
        if (cancelled) return;
        el.style.backgroundColor = prevBg;
        window.setTimeout(() => {
          if (!cancelled) el.style.transition = prevTransition;
        }, 300);
      }, 1500);
    };

    const raf = requestAnimationFrame(tryHighlight);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [nodeParam, surfaceId]);
}

/**
 * Pear's ComponentTree page surface — wires SpacetimeDB subscriptions
 * and reducers into `@eclosion-tech/pulp`'s storage-agnostic editor.
 */
export function ComponentTreeRenderer({
  surfaceId,
  onOpenThread,
}: {
  surfaceId: bigint;
  onOpenThread?: (conversationId: bigint) => void;
}) {
  const { idbNamespace } = useWorkspace();
  const { identity, getConnection } = useSpacetimeDB();
  const createConversation = useCreateConversation();
  // Cleanup for the click-time conversation onInsert listener armed by
  // handleCommentBlock. Deliberately NOT a `conversation` table subscription:
  // holding one here re-rendered the whole editor ~3.3×/s whenever any AI turn
  // streamed anywhere in the workspace (streaming flushes bump
  // conversation.updatedAt). The row itself arrives through BlockThreadGutter's
  // subscription, which is mounted exactly when `onOpenThread` is provided.
  const pendingThreadCleanupRef = useRef<(() => void) | null>(null);
  useHighlightNodeFromUrl(surfaceId);
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
  // Positioning container for block-anchored thread markers (gutter overlay).
  const editorContainerRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(
    () => () => {
      pendingThreadCleanupRef.current?.();
      pendingThreadCleanupRef.current = null;
    },
    [],
  );

  const handleCommentBlock = useCallback(
    (nodeId: bigint) => {
      if (!identity) return;
      const meHex = identity.toHexString();
      const conn = getConnection();
      // Re-arming replaces any listener from a previous, unresolved click.
      pendingThreadCleanupRef.current?.();
      pendingThreadCleanupRef.current = null;

      let cleanup: (() => void) | null = null;
      if (onOpenThread && conn) {
        const conversationTable = (conn.db as any).conversation;
        const existingIds = new Set(
          Array.from(conversationTable?.iter?.() ?? []).map((c: any) => String(c.id)),
        );
        const onInsert = (_ctx: unknown, row: Conversation) => {
          if (
            existingIds.has(String(row.id)) ||
            row.initiatedBy.toHexString() !== meHex ||
            row.pageId !== surfaceIdRef.current ||
            row.kind.tag !== "ContextThread" ||
            row.blockAnchor !== nodeId
          ) {
            return;
          }
          cleanup?.();
          onOpenThread(row.id);
        };
        cleanup = () => {
          conversationTable?.removeOnInsert?.(onInsert);
          if (pendingThreadCleanupRef.current === cleanup) {
            pendingThreadCleanupRef.current = null;
          }
        };
        conversationTable?.onInsert?.(onInsert);
        pendingThreadCleanupRef.current = cleanup;
      }
      void createConversation({
        pageId: surfaceId,
        participantIdentities: [identity],
        blockAnchor: nodeId,
      }).catch((error) => {
        cleanup?.();
        console.error("[PearComponentTreeRenderer] Failed to create block thread", error);
      });
    },
    [createConversation, getConnection, identity, onOpenThread, surfaceId],
  );

  // Supplies rows to `Repeater` nodes (custom-view runtime, ADR D1). Stable
  // identity, so including it here does not churn the config memo.
  const queryResolver = useQueryResolver();

  // linkTargets is pinned to a content key rather than the `pages` array
  // identity: the page table ticks on every block save (touch_page), and
  // letting that rebuild linkTargets churned the config — and with it every
  // PulpProvider consumer — once per save anywhere in the workspace.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const linkTargetsKey = useMemo(
    () =>
      pages
        .map((p) => `${p.id}|${p.title}|${p.parentId ?? ""}|${p.isHidden ? 1 : 0}`)
        .join("\n"),
    [pages],
  );
  const linkTargets = useMemo(() => {
    const allPages = pagesRef.current;
    const byId = new Map(allPages.map((page) => [page.id, page]));
    return filterNavVisiblePages(allPages).map((page) => ({
      id: String(page.id),
      label: page.title || "Untitled",
      href: `/workspace/${page.id}`,
      subtitle: buildBreadcrumb(page, byId),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on page content, not array identity
  }, [linkTargetsKey]);

  const config = useMemo(
    () => ({
      idbPrefix: `pear:${idbNamespace}`,
      validateProps: validateComponentProps,
      slashItems: slashItemsForDefs(PEAR_SLASH_ITEMS, tree.defs),
      linkTargets,
      onCommentBlock: handleCommentBlock,
      queryResolver,
    }),
    [idbNamespace, linkTargets, tree.defs, handleCommentBlock, queryResolver],
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
            <div ref={editorContainerRef} className="relative">
              <BlockEditor />
              {onOpenThread && (
                <BlockThreadGutter
                  containerRef={editorContainerRef}
                  pageId={surfaceId}
                  onOpenThread={onOpenThread}
                  onCreateThread={handleCommentBlock}
                />
              )}
            </div>
          </SurfaceUndoProvider>
        </SurfaceFocusProvider>
      </PulpProvider>
    </AudioAttachmentContext.Provider>
  );
}

function buildBreadcrumb(page: PageRow, byId: Map<bigint, PageRow>): string {
  const parts: string[] = [];
  let cur = page;
  while (cur.parentId != null) {
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    parts.unshift(parent.title || "Untitled");
    cur = parent;
  }
  return parts.join(" / ");
}
