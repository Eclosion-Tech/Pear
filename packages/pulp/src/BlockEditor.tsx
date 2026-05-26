"use client";

import { useCallback, useEffect, useRef } from "react";
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

/**
 * Top-level block tree editor shell. Consumes tree + mutations from
 * `<PulpProvider>` — the host app wires storage (Pear: SpacetimeDB).
 */
export function BlockEditor() {
  const { tree, moveBlock } = usePulp();
  const everReadyRef = useRef(false);
  if (!tree.loading) everReadyRef.current = true;

  useEffect(() => {
    if (tree.loading) return;
    assertRegistryAgainstDefs(tree.defs);
  }, [tree.defs, tree.loading]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  useBlockLinkScroll(tree);

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

  if (tree.loading && !everReadyRef.current) {
    return <SkeletonDoc />;
  }

  if (!tree.root) {
    return <EmptyTreeFallback />;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <BlockNodeView node={tree.root} tree={tree} />
    </DndContext>
  );
}

/** @deprecated Pear alias — prefer `BlockEditor`. */
export const ComponentTreeRenderer = BlockEditor;
