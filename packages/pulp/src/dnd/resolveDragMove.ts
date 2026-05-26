import type { BlockId, BlockTree } from "../types";
import { parseBlockSortableId, parseContainerDropId } from "./containerDropId";

export type DragMoveArgs = {
  componentId: BlockId;
  newParentId: BlockId;
  afterSiblingId?: BlockId;
};

/** True when `ancestorId` appears on the path from `nodeId` to the root. */
export function isAncestorOf(
  tree: BlockTree,
  ancestorId: BlockId,
  nodeId: BlockId,
): boolean {
  let current = tree.byId.get(nodeId);
  while (current) {
    if (current.id === ancestorId) return true;
    if (current.parentId == null) return false;
    current = tree.byId.get(current.parentId);
  }
  return false;
}

function canDropInto(
  tree: BlockTree,
  movingId: BlockId,
  newParentId: BlockId,
): boolean {
  if (movingId === newParentId) return false;
  const moving = tree.byId.get(movingId);
  const parent = tree.byId.get(newParentId);
  if (!moving || !parent) return false;
  if (moving.parentId == null) return false;
  const def = tree.defs.get(parent.componentType);
  if (def && !def.acceptsChildren) return false;
  // Server rejects moves that nest a node inside its own descendant.
  if (isAncestorOf(tree, movingId, newParentId)) return false;
  return true;
}

/**
 * Translate a dnd-kit `DragEndEvent` pair into `move_component` args.
 * Handles same-parent reorder and cross-container drops (sprint 3c.3).
 */
export function resolveDragMove(
  tree: BlockTree,
  activeId: BlockId,
  overId: string | number,
): DragMoveArgs | null {
  const activeNode = tree.byId.get(activeId);
  if (!activeNode || activeNode.parentId == null) return null;

  const containerTarget = parseContainerDropId(overId);
  if (containerTarget != null) {
    if (!canDropInto(tree, activeId, containerTarget)) return null;
    const siblings = (tree.byParent.get(containerTarget) ?? []).filter(
      (s) => s.id !== activeId,
    );
    const afterSiblingId =
      siblings.length > 0 ? siblings[siblings.length - 1]?.id : undefined;
    return {
      componentId: activeId,
      newParentId: containerTarget,
      afterSiblingId,
    };
  }

  const overBlockId = parseBlockSortableId(overId);
  if (overBlockId == null) return null;
  const overNode = tree.byId.get(overBlockId);
  if (!overNode || overNode.parentId == null) return null;

  const newParentId = overNode.parentId;
  if (!canDropInto(tree, activeId, newParentId)) return null;

  const siblings = tree.byParent.get(newParentId) ?? [];
  const overIndex = siblings.findIndex((s) => s.id === overBlockId);
  if (overIndex < 0) return null;

  const oldIndex =
    activeNode.parentId === newParentId
      ? siblings.findIndex((s) => s.id === activeId)
      : -1;

  if (oldIndex >= 0) {
    if (oldIndex === overIndex) return null;
    let afterSiblingId: BlockId | undefined;
    if (overIndex > oldIndex) {
      afterSiblingId = overNode.id;
    } else {
      afterSiblingId =
        overIndex === 0 ? undefined : siblings[overIndex - 1]?.id;
    }
    return { componentId: activeId, newParentId, afterSiblingId };
  }

  // Cross-parent: land immediately after the block we're hovering.
  return {
    componentId: activeId,
    newParentId,
    afterSiblingId: overNode.id,
  };
}
