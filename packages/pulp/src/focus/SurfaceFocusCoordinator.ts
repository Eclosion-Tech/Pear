import { Selection, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import * as Y from "yjs";
import type { BlockId, BlockInsertEvent, BlockNode, BlockTree } from "../types";
import {
  idsMatch,
  parentIdsMatch,
  siblingsForParent,
} from "./insertFocusHelpers";
import { focusDebug, idStr } from "./focusDebug";

export type FocusPlacement = "start" | "end";

export type ArmForInsertOpts = {
  initialDoc?: Y.Doc;
  /** Where the caret lands in the new block. Default `start`. */
  focusAt?: FocusPlacement;
  /**
   * Sibling ids under `parentId` at arm time. Used by `syncTree` to spot
   * the newly inserted row when the insert callback races React mount.
   */
  knownSiblingIds?: readonly BlockId[];
};

/** One block in a batch insert (paste). Resolved FIFO as rows arrive. */
export type BatchInsertEntry = {
  parentId: BlockId;
  afterSiblingId?: BlockId;
  initialDoc?: Y.Doc;
  /** Only one entry (the last block in document order) should claim focus. */
  shouldFocus?: boolean;
  focusAt?: FocusPlacement;
  knownSiblingIds?: readonly BlockId[];
};

export type SurfaceFocusValue = {
  armForInsert: (
    parentId: BlockId,
    afterSiblingId?: BlockId,
    opts?: ArmForInsertOpts,
  ) => void;
  /**
   * Arm a batch of inserts (multi-block paste). Entries resolve FIFO in the
   * order their rows arrive via `handleNodeInsert` — the caller inserts in the
   * matching order. Each entry's `initialDoc` is stashed + persisted against
   * the resolved row id; only the `shouldFocus` entry grabs focus. Isolated
   * from the single-insert path.
   */
  armForInsertBatch: (entries: BatchInsertEntry[]) => void;
  /** True while an `armForInsert` is waiting for the new row to mount. */
  isAwaitingInsert: () => boolean;
  /** True while this block split and the new sibling has not yet taken focus. */
  isHandoffSource: (nodeId: BlockId) => boolean;
  /** Read pending autofocus intent without consuming it (safe across remounts). */
  claimFocus: (nodeId: BlockId) => FocusPlacement | null;
  /** Drop autofocus intent after the editor successfully claimed focus. */
  ackFocus: (nodeId: BlockId) => void;
  /**
   * When a block mounts, resolve a pending insert if this node is the new
   * sibling and return caret placement. Falls back to an armed placement.
   */
  matchPendingInsert: (
    nodeId: BlockId,
    tree: BlockTree,
    saveYjsState?: SaveYjsFn,
  ) => FocusPlacement | null;
  registerFocusable: (nodeId: BlockId, focusFn: FocusFn) => () => void;
  requestFocus: (
    nodeId: BlockId,
    placement?: FocusPlacement,
    goalX?: number,
  ) => void;
  registerEditor: (nodeId: BlockId, view: EditorView) => () => void;
  getEditor: (nodeId: BlockId) => EditorView | undefined;
  consumeInitialDoc: (nodeId: BlockId) => Y.Doc | undefined;
  /** Read+clear a pending goal-column x for cross-block arrow navigation. */
  consumeGoalX: (nodeId: BlockId) => number | undefined;
};

type FocusFn = (placement?: FocusPlacement) => void;

type SaveYjsFn = (componentId: BlockId, data: Uint8Array) => void;

type PendingInsert = {
  parentId: BlockId;
  afterSiblingId?: BlockId;
  initialDoc?: Y.Doc;
  focusAt?: FocusPlacement;
  knownSiblingIds: Set<BlockId>;
};

/**
 * Imperative surface-scoped autofocus coordinator. Storage-agnostic —
 * the host app calls `handleNodeInsert` from its insert subscription
 * (Pear: SpacetimeDB `useTable` `onInsert`) so focus targets are set
 * before React re-renders the new block. When the subscription callback
 * races mount, `syncTree` resolves the same pending insert from the
 * updated `BlockTree`.
 */
function idKey(id: BlockId): string {
  return id.toString();
}

type BatchEntry = {
  parentId: BlockId;
  afterSiblingId?: BlockId;
  initialDoc?: Y.Doc;
  shouldFocus: boolean;
  focusAt: FocusPlacement;
  knownSiblingIds: Set<BlockId>;
};

export class SurfaceFocusCoordinator {
  private pendingRef: PendingInsert | null = null;
  /** FIFO batch-insert queue (paste). Resolved as rows arrive; separate from `pendingRef`. */
  private pendingBatch: BatchEntry[] = [];
  private batchResolvedIds = new Set<string>();

  /** String keys — avoids bigint map-key mismatches across substrate rows. */
  private focusPlacementRef = new Map<string, FocusPlacement>();
  private pendingInitialDocsRef = new Map<string, Y.Doc>();
  /** Goal-column screen-x per node, set by arrow nav, consumed at focus apply. */
  private pendingGoalXRef = new Map<string, number>();
  private editorsRef = new Map<string, EditorView>();
  private focusablesRef = new Map<string, FocusFn>();
  /** RichText that initiated the insert — blurred once the new block focuses. */
  private insertSourceId: BlockId | null = null;
  /** Survives until ack — re-arms focus across Strict Mode remounts. */
  private insertHandoff: {
    targetId: BlockId;
    placement: FocusPlacement;
    sourceId: BlockId | null;
  } | null = null;

  /** Called by the host when a new block row arrives from storage. */
  handleNodeInsert(
    row: BlockInsertEvent,
    surfaceId: BlockId,
    saveYjsState?: SaveYjsFn,
  ): void {
    if (this.tryResolveBatch(row, surfaceId, saveYjsState)) return;

    const pending = this.pendingRef;
    if (!pending) {
      focusDebug("handleNodeInsert: skip (no pending arm)", {
        rowId: idStr(row.id),
      });
      return;
    }
    if (row.surfaceId !== surfaceId) {
      focusDebug("handleNodeInsert: skip (surface mismatch)", {
        rowId: idStr(row.id),
        rowSurface: idStr(row.surfaceId),
        wantSurface: idStr(surfaceId),
      });
      return;
    }
    if (row.deletedAt != null) {
      focusDebug("handleNodeInsert: skip (row deleted)", {
        rowId: idStr(row.id),
      });
      return;
    }
    if (!parentIdsMatch(row.parentId, pending.parentId)) {
      focusDebug("handleNodeInsert: skip (parent mismatch)", {
        rowId: idStr(row.id),
        rowParent: idStr(row.parentId ?? null),
        wantParent: idStr(pending.parentId),
      });
      return;
    }
    if (pending.knownSiblingIds.has(row.id)) {
      focusDebug("handleNodeInsert: skip (known sibling)", {
        rowId: idStr(row.id),
      });
      return;
    }
    focusDebug("handleNodeInsert: resolve", {
      rowId: idStr(row.id),
      afterSibling: idStr(pending.afterSiblingId ?? null),
    });
    this.resolvePendingInsert(row.id, pending, saveYjsState);
  }

  /**
   * Reconcile a pending `armForInsert` against the latest tree snapshot.
   * Call from a host layout/effect whenever `BlockTree` updates.
   */
  syncTree(tree: BlockTree, saveYjsState?: SaveYjsFn): void {
    this.syncBatch(tree, saveYjsState);

    const pending = this.pendingRef;
    if (!pending) return;

    const candidate = pendingInsertCandidate(pending, tree);
    if (candidate == null) {
      focusDebug("syncTree: no candidate yet", {
        parentId: idStr(pending.parentId),
        afterSibling: idStr(pending.afterSiblingId ?? null),
        ...describePendingInsertFailure(pending, tree),
      });
      return;
    }

    focusDebug("syncTree: resolve", {
      candidateId: idStr(candidate.id),
      afterSibling: idStr(pending.afterSiblingId ?? null),
    });
    this.resolvePendingInsert(candidate.id, pending, saveYjsState);
  }

  /** Resolve the batch head against an arriving insert row (primary path). */
  private tryResolveBatch(
    row: BlockInsertEvent,
    surfaceId: BlockId,
    saveYjsState?: SaveYjsFn,
  ): boolean {
    if (this.pendingBatch.length === 0) return false;
    if (row.surfaceId !== surfaceId || row.deletedAt != null) return false;
    const head = this.pendingBatch[0];
    if (!parentIdsMatch(row.parentId, head.parentId)) return false;
    if (head.knownSiblingIds.has(row.id)) return false;
    if (this.batchResolvedIds.has(idKey(row.id))) return false;

    this.pendingBatch.shift();
    this.batchResolvedIds.add(idKey(row.id));
    this.resolveBatchEntry(head, row.id, saveYjsState);
    if (this.pendingBatch.length === 0) this.batchResolvedIds.clear();
    return true;
  }

  /**
   * Fallback for batch resolution when an insert-row callback races React —
   * only acts when exactly one unresolved candidate exists under the parent
   * (unambiguous), otherwise waits for the per-row `handleNodeInsert`.
   */
  private syncBatch(tree: BlockTree, saveYjsState?: SaveYjsFn): void {
    while (this.pendingBatch.length > 0) {
      const head = this.pendingBatch[0];
      const candidates = siblingsForParent(tree, head.parentId).filter(
        (s) =>
          !head.knownSiblingIds.has(s.id) &&
          !this.batchResolvedIds.has(idKey(s.id)),
      );
      if (candidates.length !== 1) break;
      const only = candidates[0];
      this.pendingBatch.shift();
      this.batchResolvedIds.add(idKey(only.id));
      this.resolveBatchEntry(head, only.id, saveYjsState);
    }
    if (this.pendingBatch.length === 0) this.batchResolvedIds.clear();
  }

  private resolveBatchEntry(
    entry: BatchEntry,
    newId: BlockId,
    saveYjsState?: SaveYjsFn,
  ): void {
    if (entry.initialDoc) {
      this.pendingInitialDocsRef.set(idKey(newId), entry.initialDoc);
      if (saveYjsState) {
        try {
          saveYjsState(newId, Y.encodeStateAsUpdate(entry.initialDoc));
        } catch (err) {
          if (typeof console !== "undefined") {
            console.warn(
              `[pulp/SurfaceFocus] failed to persist batch doc for ${newId}:`,
              err,
            );
          }
        }
      }
    }
    if (entry.shouldFocus) {
      this.insertHandoff = {
        targetId: newId,
        placement: entry.focusAt,
        sourceId: null,
      };
      this.focusTarget(newId, entry.focusAt);
    }
  }

  private matchPendingInsertForNode(
    nodeId: BlockId,
    tree: BlockTree,
    saveYjsState?: SaveYjsFn,
  ): FocusPlacement | null {
    const armed = this.focusPlacementRef.get(idKey(nodeId));
    const pending = this.pendingRef;

    if (pending) {
      const candidate = pendingInsertCandidate(pending, tree);
      if (candidate != null && idsMatch(candidate.id, nodeId)) {
        const placement = pending.focusAt ?? "start";
        focusDebug("matchPendingInsert: resolve on mount", {
          nodeId: idStr(nodeId),
          placement,
        });
        this.resolvePendingInsert(nodeId, pending, saveYjsState);
        return placement;
      }
      if (candidate != null) {
        focusDebug("matchPendingInsert: pending but wrong node", {
          nodeId: idStr(nodeId),
          candidateId: idStr(candidate.id),
        });
      }
    }

    if (armed) {
      focusDebug("matchPendingInsert: armed placement", {
        nodeId: idStr(nodeId),
        placement: armed,
      });
    }
    return armed ?? null;
  }

  private resolvePendingInsert(
    newId: BlockId,
    pending: PendingInsert,
    saveYjsState?: SaveYjsFn,
  ): void {
    this.insertSourceId = pending.afterSiblingId ?? null;
    if (pending.initialDoc) {
      this.pendingInitialDocsRef.set(idKey(newId), pending.initialDoc);
      if (saveYjsState) {
        try {
          saveYjsState(newId, Y.encodeStateAsUpdate(pending.initialDoc));
        } catch (err) {
          if (typeof console !== "undefined") {
            console.warn(
              `[pulp/SurfaceFocus] failed to persist initial doc for ${newId}:`,
              err,
            );
          }
        }
      }
    }
    this.pendingRef = null;
    const placement = pending.focusAt ?? "start";
    this.insertHandoff = {
      targetId: newId,
      placement,
      sourceId: this.insertSourceId,
    };
    focusDebug("resolvePendingInsert", {
      newId: idStr(newId),
      sourceId: idStr(this.insertSourceId),
      placement,
      hasInitialDoc: pending.initialDoc != null,
    });
    this.focusTarget(newId, placement);
  }

  /** Armed map entry or insert handoff (for remounts before ack). */
  private placementForInsertTarget(nodeId: BlockId): FocusPlacement | null {
    const key = idKey(nodeId);
    const armed = this.focusPlacementRef.get(key);
    if (armed) return armed;
    const handoff = this.insertHandoff;
    if (handoff && idsMatch(handoff.targetId, nodeId)) return handoff.placement;
    return null;
  }

  private ensurePlacementArmed(nodeId: BlockId, placement: FocusPlacement): void {
    this.focusPlacementRef.set(idKey(nodeId), placement);
  }

  /** Arm focus on a node — invokes immediately if already mounted. */
  private focusTarget(nodeId: BlockId, placement: FocusPlacement = "end"): void {
    this.focusPlacementRef.set(idKey(nodeId), placement);
    this.tryApplyFocus(nodeId);
  }

  private tryApplyFocus(nodeId: BlockId): void {
    const key = idKey(nodeId);
    const placement = this.focusPlacementRef.get(key);
    if (!placement) return;
    const fn = this.focusablesRef.get(key);
    if (!fn) {
      focusDebug("tryApplyFocus: no focusable yet", {
        nodeId: idStr(nodeId),
        placement,
        hasEditor: this.editorsRef.has(key),
      });
      return;
    }
    focusDebug("tryApplyFocus: invoke", { nodeId: idStr(nodeId), placement });
    try {
      fn(placement);
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn(
          `[pulp/SurfaceFocus] tryApplyFocus(${nodeId}) threw:`,
          err,
        );
      }
    }
  }

  private completeInsertFocus(nodeId: BlockId): void {
    const key = idKey(nodeId);
    const targetView = this.editorsRef.get(key);
    focusDebug("completeInsertFocus", {
      nodeId: idStr(nodeId),
      sourceId: idStr(this.insertSourceId),
      targetHasFocus: targetView ? editorHasFocus(targetView) : false,
    });
    this.focusPlacementRef.delete(key);
    this.insertHandoff = null;
    const sourceId = this.insertSourceId;
    if (sourceId != null) {
      // Only blur the source once the target editor actually holds focus.
      if (targetView && editorHasFocus(targetView)) {
        this.editorsRef.get(idKey(sourceId))?.dom.blur();
      }
      this.insertSourceId = null;
    }
  }

  getApi(): SurfaceFocusValue {
    return {
      armForInsert: (parentId, afterSiblingId, opts) => {
        this.pendingRef = {
          parentId,
          afterSiblingId,
          initialDoc: opts?.initialDoc,
          focusAt: opts?.focusAt,
          knownSiblingIds: new Set(opts?.knownSiblingIds ?? []),
        };
        focusDebug("armForInsert", {
          parentId: idStr(parentId),
          afterSibling: idStr(afterSiblingId ?? null),
          focusAt: opts?.focusAt ?? "start",
          knownSiblingCount: opts?.knownSiblingIds?.length ?? 0,
          hasInitialDoc: opts?.initialDoc != null,
        });
      },
      armForInsertBatch: (entries) => {
        this.pendingBatch = entries.map((e) => ({
          parentId: e.parentId,
          afterSiblingId: e.afterSiblingId,
          initialDoc: e.initialDoc,
          shouldFocus: e.shouldFocus ?? false,
          focusAt: e.focusAt ?? "end",
          knownSiblingIds: new Set(e.knownSiblingIds ?? []),
        }));
        this.batchResolvedIds.clear();
        focusDebug("armForInsertBatch", { count: entries.length });
      },
      isAwaitingInsert: () => this.pendingRef != null,
      isHandoffSource: (nodeId) =>
        this.insertSourceId != null && idsMatch(this.insertSourceId, nodeId),
      claimFocus: (nodeId) => {
        const placement = this.placementForInsertTarget(nodeId);
        if (placement) this.ensurePlacementArmed(nodeId, placement);
        return placement;
      },
      ackFocus: (nodeId) => {
        this.completeInsertFocus(nodeId);
      },
      matchPendingInsert: (nodeId, tree, saveYjsState) =>
        this.matchPendingInsertForNode(nodeId, tree, saveYjsState),
      registerFocusable: (nodeId, focusFn) => {
        const key = idKey(nodeId);
        focusDebug("registerFocusable", {
          nodeId: idStr(nodeId),
          armed: this.focusPlacementRef.get(key) ?? null,
        });
        this.focusablesRef.set(key, focusFn);
        this.tryApplyFocus(nodeId);
        return () => {
          if (this.focusablesRef.get(key) === focusFn) {
            this.focusablesRef.delete(key);
          }
        };
      },
      requestFocus: (nodeId, placement = "end", goalX) => {
        focusDebug("requestFocus", { nodeId: idStr(nodeId), placement });
        if (goalX != null) {
          this.pendingGoalXRef.set(idKey(nodeId), goalX);
        }
        this.focusTarget(nodeId, placement);
      },
      registerEditor: (nodeId, view) => {
        const key = idKey(nodeId);
        this.editorsRef.set(key, view);
        const placement = this.placementForInsertTarget(nodeId);
        focusDebug("registerEditor", {
          nodeId: idStr(nodeId),
          armed: placement ?? null,
          hasFocusable: this.focusablesRef.has(key),
          hasHandoff:
            this.insertHandoff != null &&
            idsMatch(this.insertHandoff.targetId, nodeId),
        });
        if (placement) {
          this.ensurePlacementArmed(nodeId, placement);
          const apply = () => {
            if (this.editorsRef.get(key) !== view) return;
            if (!this.placementForInsertTarget(nodeId)) return;
            applyEditorFocus(view, placement);
            focusDebug("registerEditor: applyEditorFocus", {
              nodeId: idStr(nodeId),
              hasFocus: editorHasFocus(view),
              activeElement:
                typeof document !== "undefined"
                  ? document.activeElement?.tagName ?? "none"
                  : "n/a",
            });
          };
          // Double rAF: after parent registerFocusable + Strict Mode remount.
          if (typeof requestAnimationFrame !== "undefined") {
            requestAnimationFrame(() => requestAnimationFrame(apply));
          } else {
            apply();
          }
        }
        return () => {
          if (this.editorsRef.get(key) === view) {
            this.editorsRef.delete(key);
          }
        };
      },
      getEditor: (nodeId) => this.editorsRef.get(idKey(nodeId)),
      consumeGoalX: (nodeId) => {
        const key = idKey(nodeId);
        const x = this.pendingGoalXRef.get(key);
        if (x != null) this.pendingGoalXRef.delete(key);
        return x;
      },
      consumeInitialDoc: (nodeId) => {
        const key = idKey(nodeId);
        const doc = this.pendingInitialDocsRef.get(key);
        if (doc) {
          focusDebug("consumeInitialDoc: hit", { nodeId: idStr(nodeId) });
          this.pendingInitialDocsRef.delete(key);
        }
        return doc;
      },
    };
  }
}

function pendingInsertCandidate(
  pending: PendingInsert,
  tree: BlockTree,
): BlockNode | null {
  const siblings = siblingsForParent(tree, pending.parentId);
  if (siblings.length === 0) return null;

  let insertIndex = 0;
  if (pending.afterSiblingId != null) {
    const afterIdx = siblings.findIndex((s) =>
      idsMatch(s.id, pending.afterSiblingId!),
    );
    if (afterIdx < 0) return null;
    insertIndex = afterIdx + 1;
  }

  if (insertIndex >= siblings.length) return null;

  const candidate = siblings[insertIndex];
  if (pending.knownSiblingIds.has(candidate.id)) return null;
  return candidate;
}

function describePendingInsertFailure(
  pending: PendingInsert,
  tree: BlockTree,
): Record<string, unknown> {
  const siblings = siblingsForParent(tree, pending.parentId);
  const siblingIds = siblings.map((s) => idStr(s.id));
  if (siblings.length === 0) {
    return { reason: "no-siblings", siblingIds };
  }

  let insertIndex = 0;
  if (pending.afterSiblingId != null) {
    const afterIdx = siblings.findIndex((s) =>
      idsMatch(s.id, pending.afterSiblingId!),
    );
    if (afterIdx < 0) {
      return {
        reason: "after-sibling-not-found",
        siblingIds,
        afterSibling: idStr(pending.afterSiblingId),
      };
    }
    insertIndex = afterIdx + 1;
  }

  if (insertIndex >= siblings.length) {
    return {
      reason: "insert-index-past-end",
      siblingIds,
      insertIndex,
      afterSibling: idStr(pending.afterSiblingId ?? null),
    };
  }

  const candidate = siblings[insertIndex];
  if (pending.knownSiblingIds.has(candidate.id)) {
    return {
      reason: "candidate-is-known-sibling",
      siblingIds,
      insertIndex,
      candidateId: idStr(candidate.id),
    };
  }

  return { reason: "unknown", siblingIds };
}

/**
 * Focus a live ProseMirror view and place the caret. When `goalX` is given
 * (cross-block arrow navigation) the caret lands on the entry line nearest
 * that screen-x — preserving the horizontal column. Defensive: any failure of
 * the layout-dependent coords APIs falls back to the plain start/end caret.
 */
export function applyEditorFocus(
  view: EditorView,
  placement: FocusPlacement,
  goalX?: number,
): void {
  view.dom.focus({ preventScroll: false });
  view.focus();
  const sel =
    placement === "start"
      ? Selection.atStart(view.state.doc)
      : Selection.atEnd(view.state.doc);
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());

  if (goalX != null && typeof view.posAtCoords === "function") {
    try {
      const lineCoords = view.coordsAtPos(view.state.selection.head);
      const found = view.posAtCoords({
        left: goalX,
        top: (lineCoords.top + lineCoords.bottom) / 2,
      });
      if (found) {
        const $pos = view.state.doc.resolve(found.pos);
        view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)));
      }
    } catch {
      /* keep the start/end caret */
    }
  }

  view.dom.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Lenient focus check — `hasFocus()` can lag one frame after `focus()`. */
export function editorHasFocus(view: EditorView): boolean {
  if (view.hasFocus()) return true;
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return active === view.dom || view.dom.contains(active);
}

export const NOOP_SURFACE_FOCUS: SurfaceFocusValue = {
  armForInsert: () => {},
  armForInsertBatch: () => {},
  isAwaitingInsert: () => false,
  isHandoffSource: () => false,
  claimFocus: () => null,
  ackFocus: () => {},
  matchPendingInsert: () => null,
  registerFocusable: () => () => {},
  requestFocus: () => {},
  registerEditor: () => () => {},
  getEditor: () => undefined,
  consumeInitialDoc: () => undefined,
  consumeGoalX: () => undefined,
};
