import type { BlockId, BlockNode, BlockTree } from "../types";

export type HeadingEnterAction =
  | {
      kind: "insert-sibling";
      parentId: BlockId;
      afterSiblingId: BlockId;
    }
  | {
      kind: "append-section";
      headingId: BlockId;
      afterChildId?: BlockId;
    };

/**
 * Decide what Enter does in a heading title editor.
 *
 * - No section children yet → new RichText sibling below the heading.
 * - Section exists → append RichText at end of nested section body.
 */
export function resolveHeadingEnter(
  tree: BlockTree,
  node: BlockNode,
): HeadingEnterAction | null {
  if (node.parentId == null) return null;

  const sectionChildren = tree.byParent.get(node.id) ?? [];

  if (sectionChildren.length > 0) {
    const lastChild = sectionChildren[sectionChildren.length - 1];
    return {
      kind: "append-section",
      headingId: node.id,
      afterChildId: lastChild?.id,
    };
  }

  return {
    kind: "insert-sibling",
    parentId: node.parentId,
    afterSiblingId: node.id,
  };
}
