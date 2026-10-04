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
import { textBodyAt, useSurfaceTextSelection } from "./selection/useSurfaceTextSelection";

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
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const onTextPointerDown = useSurfaceTextSelection(surfaceRef);

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

  // Margin-origin drags select blocks; text-origin drags stay text selections.
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const orderedIdsRef = useRef<readonly BlockId[]>([]);
  orderedIdsRef.current = flattenDocumentBlocks(tree).map((n) => n.id);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0 || e.pointerType === "touch") return;
      const target = e.target as Element;
      if (target.closest("[data-selection-surface]") !== surfaceRef.current) return;
      // Clicking into editable text resumes editing — drop any block selection.
      if (surfaceRef.current && textBodyAt(target, surfaceRef.current)) {
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
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement && document.activeElement.closest(".ProseMirror")) {
        document.activeElement.blur();
      }
      window.getSelection()?.removeAllRanges();
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
      if (!movedRef.current && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
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
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [controller, getRects]);

  // Keyboard on an active block selection — Escape clears, Backspace/Delete
  // removes every selected block. Window-level so it works while the editor
  // is blurred (selection mode).
  useEffect(() => {
    if (selectedIds.length === 0) return;
    function onKey(e: KeyboardEvent) {
      const root = surfaceRef.current;
      if (!root || (e.target instanceof Element && e.target.closest("input,textarea,select,[contenteditable='true']"))) return;
      if (e.target instanceof Node && !root.contains(e.target) && e.target !== document.body) return;
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
    <div ref={surfaceRef} onPointerDownCapture={onTextPointerDown}
      onPointerDown={onPointerDown} data-selection-surface>
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

/** @deprecated Pear alias — prefer `BlockEditor`. */
export const ComponentTreeRenderer = BlockEditor;
