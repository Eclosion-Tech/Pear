import type { BlockId, BlockNode, BlockTree } from "../types";

/** Previous or next live sibling under the same parent (document order). */
export function getBlockSibling(
  tree: BlockTree,
  nodeId: BlockId,
  direction: "prev" | "next",
): BlockNode | null {
  const node = tree.byId.get(nodeId);
  if (!node || node.parentId == null) return null;
  const siblings = tree.byParent.get(node.parentId) ?? [];
  const idx = siblings.findIndex((s) => s.id === nodeId);
  if (idx < 0) return null;
  if (direction === "prev") {
    return idx > 0 ? (siblings[idx - 1] ?? null) : null;
  }
  return idx < siblings.length - 1 ? (siblings[idx + 1] ?? null) : null;
}

/** True when a collapsed caret sits at the first editable position in the doc. */
export function isAtDocStart(docEnd: number, head: number): boolean {
  return head <= 1;
}

/** True when a collapsed caret sits at the last editable position in the doc. */
export function isAtDocEnd(docEnd: number, head: number): boolean {
  return head >= docEnd - 1;
}
