"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { usePulp } from "./context/PulpProvider";
import { BlockNodeView } from "./BlockNodeView";
import { EmptyTreeFallback, SkeletonDoc } from "./fallbacks";
import { assertRegistryAgainstDefs } from "./registry";
import { parseBlockSortableId } from "./dnd/containerDropId";
import { resolveDragMove } from "./dnd/resolveDragMove";
import { useBlockLinkScroll } from "./hooks/useBlockLinkScroll";
import { flattenDocumentBlocks } from "./navigation/blockNavigation";
import { deleteBlocks } from "./blockActions";
import {
  SurfaceSelectionProvider,
  useSurfaceSelection,
} from "./selection/SurfaceSelectionProvider";
import { SelectionMarquee } from "./selection/SelectionMarquee";
import {
  rectFromPoints,
  blocksInMarquee,
  type Rect,
} from "./selection/selectionGeometry";
import type { BlockId, BlockTree } from "./types";

/**
 * Top-level block tree editor shell. Consumes tree + mutations from
 * `<PulpProvider>` — the host app wires storage (Pear: SpacetimeDB).
 */
export function BlockEditor() {
  const { tree } = usePulp();
  const everReadyRef = useRef(false);
  if (!tree.loading) everReadyRef.current = true;

  useEffect(() => {
    if (tree.loading) return;
    assertRegistryAgainstDefs(tree.defs);
  }, [tree.defs, tree.loading]);

  useBlockLinkScroll(tree);

  if (tree.loading && !everReadyRef.current) {
    return <SkeletonDoc />;
  }

  if (!tree.root) {
    return <EmptyTreeFallback />;
  }

  return (
    <SurfaceSelectionProvider>
      <BlockSurface tree={tree} />
    </SurfaceSelectionProvider>
  );
}

function BlockSurface({ tree }: { tree: BlockTree }) {
  const { moveBlock, deleteBlock } = usePulp();
  const selection = useSurfaceSelection();
  const { controller, selectedIds, getRects } = selection;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeId = parseBlockSortableId(active.id);
      if (activeId == null) return;
      const move = resolveDragMove(tree, activeId, over.id);
      if (!move) return;
      moveBlock(move);
    },
    [tree, moveBlock],
  );

  // --- Block selection: marquee + cross-block drag + keyboard ---
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const orderedIdsRef = useRef<readonly BlockId[]>([]);
  orderedIdsRef.current = flattenDocumentBlocks(tree).map((n) => n.id);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element;
      // Clicking into editable text resumes editing — drop any block selection.
      if (target.closest(".ProseMirror")) {
        if (selectedIds.length > 0) controller.clear();
        return;
      }
      // Ignore interactive chrome (menus, buttons, drag handles).
      if (
        target.closest(
          "button,a,input,textarea,[role='dialog'],[role='menu'],[data-block-gutter]",
        )
      ) {
        return;
      }
      startRef.current = { x: e.clientX, y: e.clientY };
      movedRef.current = false;
    },
    [controller, selectedIds.length],
  );

  // Window-level move/up so a marquee (or text drag) can extend past the surface.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const start = startRef.current;
      if (!start) return;
      movedRef.current = true;
      const rect = rectFromPoints(start.x, start.y, e.clientX, e.clientY);
      setMarquee(rect);
      controller.selectMany(
        blocksInMarquee(rect, orderedIdsRef.current, getRects()),
      );
    }
    function onUp() {
      if (startRef.current) {
        // Plain click on empty space (no drag) clears the selection.
        if (!movedRef.current) controller.clear();
        startRef.current = null;
        movedRef.current = false;
        setMarquee(null);
        return;
      }
      // Not a marquee — a text drag that may have crossed block boundaries.
      convertCrossBlockTextSelection();
    }
    function convertCrossBlockTextSelection() {
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const a = blockIdOfNode(sel.anchorNode);
      const f = blockIdOfNode(sel.focusNode);
      if (a == null || f == null || a === f) return;
      controller.selectBetween(a, f, orderedIdsRef.current);
      sel.removeAllRanges();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [controller, getRects]);

  // Keyboard on an active block selection — Escape clears, Backspace/Delete
  // removes every selected block. Window-level so it works while the editor
  // is blurred (selection mode).
  useEffect(() => {
    if (selectedIds.length === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        controller.clear();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteBlocks(selectedIds, deleteBlock);
        controller.clear();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds, controller, deleteBlock]);

  return (
    <div onPointerDown={onPointerDown} data-selection-surface>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <BlockNodeView node={tree.root!} tree={tree} />
      </DndContext>
      {marquee != null && <SelectionMarquee rect={marquee} />}
    </div>
  );
}

/** Nearest enclosing block id from a DOM node, via the `block-<id>` chrome wrapper. */
function blockIdOfNode(node: Node | null): BlockId | null {
  const el =
    node instanceof Element ? node : (node?.parentElement ?? null);
  const chrome = el?.closest?.("[data-block-chrome]");
  if (!chrome) return null;
  const match = /^block-(\d+)$/.exec(chrome.id);
  return match ? BigInt(match[1]) : null;
}

/** @deprecated Pear alias — prefer `BlockEditor`. */
export const ComponentTreeRenderer = BlockEditor;
