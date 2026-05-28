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

/** Depth-first block order under the surface root (excludes the root Container). */
export function flattenDocumentBlocks(tree: BlockTree): BlockNode[] {
  const out: BlockNode[] = [];
  const walk = (id: BlockId) => {
    const n = tree.byId.get(id);
    if (!n) return;
    out.push(n);
    for (const child of tree.byParent.get(id) ?? []) walk(child.id);
  };
  if (!tree.root) return out;
  for (const child of tree.byParent.get(tree.root.id) ?? []) walk(child.id);
  return out;
}

function isDescendantOf(
  tree: BlockTree,
  ancestorId: BlockId,
  nodeId: BlockId,
): boolean {
  let cur = tree.byId.get(nodeId);
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentId != null ? tree.byId.get(cur.parentId) : undefined;
  }
  return false;
}

/** Deepest block in a subtree suitable for nesting (walks last-child chain). */
export function deepestNestableBlock(
  node: BlockNode,
  tree: BlockTree,
): BlockNode {
  const def = tree.defs.get(node.componentType);
  if (!def?.acceptsChildren) return node;
  const children = tree.byParent.get(node.id) ?? [];
  if (children.length === 0) return node;
  const last = children[children.length - 1]!;
  return deepestNestableBlock(last, tree);
}

function acceptsChildren(tree: BlockTree, node: BlockNode): boolean {
  return tree.defs.get(node.componentType)?.acceptsChildren ?? false;
}

function nestPointUnder(
  candidate: BlockNode,
  node: BlockNode,
  tree: BlockTree,
): BlockNode | null {
  if (!acceptsChildren(tree, candidate)) return null;
  if (isDescendantOf(tree, node.id, candidate.id)) return null;

  const target = deepestNestableBlock(candidate, tree);
  if (target.id === node.id) return null;
  if (isDescendantOf(tree, target.id, node.id)) return null;
  return target;
}

/**
 * BlockNote-style Tab target: previous sibling's deepest nest point, else walk
 * backward in document order (handles multi-level list indent).
 */
export function resolveNestTarget(
  node: BlockNode,
  tree: BlockTree,
): BlockNode | null {
  if (node.parentId == null) return null;

  const prevSibling = getBlockSibling(tree, node.id, "prev");
  if (prevSibling) {
    const target = nestPointUnder(prevSibling, node, tree);
    if (target) return target;
  }

  const ordered = flattenDocumentBlocks(tree);
  const idx = ordered.findIndex((n) => n.id === node.id);
  if (idx <= 0) return null;

  for (let i = idx - 1; i >= 0; i--) {
    const candidate = ordered[i]!;
    if (isDescendantOf(tree, node.id, candidate.id)) continue;

    if (node.parentId === candidate.id) {
      const siblings = tree.byParent.get(candidate.id) ?? [];
      const myIdx = siblings.findIndex((s) => s.id === node.id);
      if (myIdx > 0) {
        const prevSib = siblings[myIdx - 1]!;
        const target = nestPointUnder(prevSib, node, tree);
        if (target) return target;
      }
      continue;
    }

    const target = nestPointUnder(candidate, node, tree);
    if (target) return target;
  }

  return null;
}

/** Next block in depth-first document order under the surface root. */
export function getDocumentNextBlock(
  tree: BlockTree,
  nodeId: BlockId,
): BlockNode | null {
  const ordered = flattenDocumentBlocks(tree);
  const idx = ordered.findIndex((n) => n.id === nodeId);
  if (idx < 0 || idx >= ordered.length - 1) return null;
  return ordered[idx + 1] ?? null;
}

/** Previous block in depth-first document order (BlockNote backspace target). */
export function getDocumentPrevBlock(
  tree: BlockTree,
  nodeId: BlockId,
): BlockNode | null {
  const ordered = flattenDocumentBlocks(tree);
  const idx = ordered.findIndex((n) => n.id === nodeId);
  if (idx <= 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const candidate = ordered[i]!;
    if (isDescendantOf(tree, nodeId, candidate.id)) continue;
    return candidate;
  }
  return null;
}

/** True when a collapsed caret sits at the first editable position in the doc. */
export function isAtDocStart(docEnd: number, head: number): boolean {
  return head <= 1;
}

/** True when a collapsed caret sits at the last editable position in the doc. */
export function isAtDocEnd(docEnd: number, head: number): boolean {
  return head >= docEnd - 1;
}
