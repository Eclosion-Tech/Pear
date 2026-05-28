import type { BlockId, BlockNode, BlockTree } from "../types";

export type HeadingEnterAction =
  | {
      kind: "insert-sibling";
      parentId: BlockId;
      afterSiblingId: BlockId;
    }
  | {
      kind: "prepend-section";
      headingId: BlockId;
    };

/**
 * True when a heading behaves as a collapsible section — either explicitly
 * (`section: true` in props) or implicitly because it already owns children.
 * Once a heading has held children it stays a section (the prop is promoted),
 * so an emptied section keeps its toggle — Notion's toggle-heading semantics.
 */
export function isHeadingSection(tree: BlockTree, node: BlockNode): boolean {
  if (parseSectionFlag(node.props)) return true;
  return (tree.byParent.get(node.id) ?? []).length > 0;
}

/**
 * Decide where Enter in a heading title drops the split suffix.
 *
 * - Section heading → suffix becomes the **first child** of the section body.
 * - Flat heading → suffix becomes a **RichText sibling** below the heading.
 *
 * The caller (`HeadingRenderer`) splits the title doc at the caret and seeds
 * the new RichText with the suffix; at-end is the degenerate empty-suffix case.
 */
export function resolveHeadingEnter(
  tree: BlockTree,
  node: BlockNode,
): HeadingEnterAction | null {
  if (node.parentId == null) return null;

  if (isHeadingSection(tree, node)) {
    return { kind: "prepend-section", headingId: node.id };
  }

  return {
    kind: "insert-sibling",
    parentId: node.parentId,
    afterSiblingId: node.id,
  };
}

function parseSectionFlag(propsJson: string): boolean {
  try {
    return (JSON.parse(propsJson) as { section?: unknown }).section === true;
  } catch {
    return false;
  }
}
