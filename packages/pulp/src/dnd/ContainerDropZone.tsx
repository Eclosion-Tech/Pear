"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { ReactNode } from "react";
import type { BlockId, BlockTree } from "../types";
import { containerDropId } from "./containerDropId";

/**
 * Wraps a Container's children in a sortable list plus a droppable zone so
 * blocks can be dragged in from other containers (sprint 3c.3).
 */
export function ContainerDropZone({
  containerId,
  tree,
  acceptsChildren,
  className,
  style,
  children,
  header,
  footer,
}: {
  containerId: BlockId;
  tree: BlockTree;
  acceptsChildren: boolean;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
  /** Optional chrome rendered inside the droppable (e.g. a type label). */
  header?: ReactNode;
  /** Rendered inside the droppable (e.g. empty-state "+ Add text block"). */
  footer?: ReactNode;
}) {
  const childOrder = (tree.byParent.get(containerId) ?? []).map((c) =>
    c.id.toString(),
  );

  const { setNodeRef, isOver, active } = useDroppable({
    id: containerDropId(containerId),
    disabled: !acceptsChildren,
    data: { type: "container", containerId },
  });

  const showDropHint =
    acceptsChildren &&
    isOver &&
    active != null &&
    active.id.toString() !== containerDropId(containerId);

  return (
    <div
      ref={setNodeRef}
      className={`${className ?? ""}${
        showDropHint
          ? " ring-2 ring-blue-400/60 ring-inset rounded-md transition-shadow"
          : ""
      }`}
      style={style}
    >
      {header}
      <SortableContext items={childOrder} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
      {footer}
    </div>
  );
}
