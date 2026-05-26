import type { BlockId, BlockNode, BlockTree } from "../types";

/** Snapshot sibling ids for `armForInsert({ knownSiblingIds })`. */
export function knownSiblingIdsForParent(
  tree: BlockTree,
  parentId: BlockId,
): BlockId[] {
  return siblingsForParent(tree, parentId).map((s) => s.id);
}

/** Resolve children under `parentId`, tolerating bigint map-key quirks. */
export function siblingsForParent(
  tree: BlockTree,
  parentId: BlockId,
): BlockNode[] {
  const direct = tree.byParent.get(parentId);
  if (direct) return direct;

  const want = parentId.toString();
  for (const [key, arr] of tree.byParent) {
    if (key != null && key.toString() === want) return arr;
  }
  return [];
}

export function parentIdsMatch(
  a: BlockId | null | undefined,
  b: BlockId | null | undefined,
): boolean {
  if (a == null || b == null) return a === b;
  return a.toString() === b.toString();
}

export function idsMatch(a: BlockId, b: BlockId): boolean {
  return a.toString() === b.toString();
}
