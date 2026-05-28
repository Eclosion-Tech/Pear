import type { EditorView } from "prosemirror-view";
import { Selection } from "prosemirror-state";
import * as Y from "yjs";
import { prosemirrorToYDoc } from "y-prosemirror";
import type { SurfaceFocusValue } from "./focus/SurfaceFocusCoordinator";
import { knownSiblingIdsForParent } from "./focus/insertFocusHelpers";
import { resolveNestTarget, getDocumentPrevBlock } from "./navigation/blockNavigation";
import type { SlashMenuItem } from "./SlashMenu";
import type { BlockNode, BlockTree, PulpMutations } from "./types";
import { yDocToPlainText } from "./rich-text/yjsToHtml";
import {
  PROSEMIRROR_FRAGMENT_KEY,
  richTextSchema,
} from "./rich-text/richTextSchema";

/**
 * Append plain text onto a `RichText` block — live editor when mounted,
 * otherwise rewrite the stored Y.Doc (plain-text merge only).
 * Returns the doc position where the inserted text begins (for caret
 * placement). Used when a non-Yjs block (Heading) backspaces into prev.
 */
export function mergePlainTextIntoRichText(
  prevId: BlockNode["id"],
  text: string,
  tree: BlockTree,
  focus: SurfaceFocusValue,
  saveYjsState: (args: { componentId: BlockNode["id"]; data: Uint8Array }) => void,
): number | null {
  if (!text) return null;

  const prevView = focus.getEditor(prevId);
  if (prevView) {
    const mergePoint = prevView.state.doc.content.size - 1;
    const tr = prevView.state.tr.insertText(text, mergePoint);
    tr.setSelection(Selection.near(tr.doc.resolve(mergePoint)));
    prevView.dispatch(tr);
    prevView.focus();
    return mergePoint;
  }

  const yjs = tree.yjs.get(prevId);
  let existing = "";
  if (yjs?.data && yjs.data.byteLength > 0) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, yjs.data);
    existing = yDocToPlainText(doc);
  }
  const mergePoint = existing.length;
  saveYjsState({
    componentId: prevId,
    data: Y.encodeStateAsUpdate(plainTextToYDoc(existing + text)),
  });
  return mergePoint;
}

/** Document list block types (distinct from data-bound substrate `List`). */
export const DOCUMENT_LIST_ITEM_TYPES = new Set([
  "BulletListItem",
  "NumberedListItem",
  "ChecklistItem",
]);

export function isDocumentListItemType(componentType: string): boolean {
  return DOCUMENT_LIST_ITEM_TYPES.has(componentType);
}

/**
 * Exit an empty document list item back to plain `RichText` — BlockNote /
 * Notion semantics for Enter on an empty list row.
 */
export function exitEmptyListItemToRichText(
  node: BlockNode,
  tree: BlockTree,
  mutations: Pick<PulpMutations, "insertBlock" | "deleteBlock">,
  focus: SurfaceFocusValue,
): boolean {
  if (node.parentId == null) return false;
  if (!isDocumentListItemType(node.componentType)) return false;

  const parentSiblings = tree.byParent.get(node.parentId) ?? [];
  const myIdx = parentSiblings.findIndex((s) => s.id === node.id);
  const predecessor = myIdx > 0 ? parentSiblings[myIdx - 1]?.id : undefined;

  focus.armForInsert(node.parentId, predecessor, {
    focusAt: "start",
    knownSiblingIds: knownSiblingIdsForParent(tree, node.parentId),
  });
  mutations.insertBlock({
    parentId: node.parentId,
    componentType: "RichText",
    propsJson: "{}",
    afterSiblingId: predecessor,
  });
  mutations.deleteBlock({ componentId: node.id });
  return true;
}

/**
 * Nest this block (BlockNote Tab) — under previous sibling's deepest nest
 * point, or backward in document order for multi-level list indent.
 */
export function nestBlockUnderPreviousSibling(
  node: BlockNode,
  tree: BlockTree,
  mutations: Pick<PulpMutations, "moveBlock">,
  focus: SurfaceFocusValue,
): boolean {
  if (node.parentId == null) return false;

  const target = resolveNestTarget(node, tree);
  if (!target) return false;

  const targetChildren = tree.byParent.get(target.id) ?? [];
  const lastChild = targetChildren[targetChildren.length - 1];
  const afterSiblingId =
    lastChild && lastChild.id !== node.id ? lastChild.id : undefined;

  if (node.parentId === target.id && afterSiblingId == null) return false;

  mutations.moveBlock({
    componentId: node.id,
    newParentId: target.id,
    afterSiblingId,
  });
  focus.requestFocus(node.id, "start");
  return true;
}

/**
 * Unnest this block — move it to the grandparent, immediately after its
 * current parent (BlockNote Shift+Tab / list outdent).
 */
export function unnestBlock(
  node: BlockNode,
  tree: BlockTree,
  mutations: Pick<PulpMutations, "moveBlock">,
  focus: SurfaceFocusValue,
): boolean {
  if (node.parentId == null) return false;

  const parent = tree.byId.get(node.parentId);
  if (!parent || parent.parentId == null) return false;

  mutations.moveBlock({
    componentId: node.id,
    newParentId: parent.parentId,
    afterSiblingId: parent.id,
  });
  focus.requestFocus(node.id, "start");
  return true;
}

export function canNestBlock(node: BlockNode, tree: BlockTree): boolean {
  if (node.parentId == null) return false;
  return resolveNestTarget(node, tree) != null;
}

export function canUnnestBlock(node: BlockNode, tree: BlockTree): boolean {
  if (node.parentId == null) return false;
  const parent = tree.byId.get(node.parentId);
  return Boolean(parent?.parentId != null);
}

/**
 * Backspace on an empty block — delete and focus the previous block in
 * document order (parent list item when nested, not unnest-to-root).
 */
export function deleteEmptyBlockAndFocusDocumentPrev(
  node: BlockNode,
  tree: BlockTree,
  focus: SurfaceFocusValue,
  deleteBlock: PulpMutations["deleteBlock"],
): boolean {
  if (node.parentId == null) return false;

  const docPrev = getDocumentPrevBlock(tree, node.id);
  if (docPrev) {
    focus.requestFocus(docPrev.id, "end");
    deleteBlock({ componentId: node.id });
    return true;
  }

  const parentSiblings = tree.byParent.get(node.parentId) ?? [];
  if (parentSiblings.length <= 1) return false;

  const myIdx = parentSiblings.findIndex((s) => s.id === node.id);
  const neighbour =
    myIdx > 0 ? parentSiblings[myIdx - 1] : parentSiblings[myIdx + 1];
  if (neighbour) focus.requestFocus(neighbour.id, "end");
  deleteBlock({ componentId: node.id });
  return true;
}

/**
 * Backspace at doc start with content — merge into the document-order
 * previous Yjs block (includes parent list item when this is a nested row).
 */
export function mergeBlockIntoDocumentPrev(
  node: BlockNode,
  view: EditorView,
  tree: BlockTree,
  focus: SurfaceFocusValue,
  saveYjsState: PulpMutations["saveYjsState"],
  onRemoveSelf: () => void,
): boolean {
  const prev = getDocumentPrevBlock(tree, node.id);
  if (!prev) return false;

  const prevDef = tree.defs.get(prev.componentType);
  if (!prevDef?.hasYjsState) {
    focus.requestFocus(prev.id, "end");
    onRemoveSelf();
    return true;
  }

  const prevView = focus.getEditor(prev.id);
  if (prevView) {
    const prevDocSize = prevView.state.doc.content.size;
    const mergePoint = prevDocSize - 1;
    const myDocSize = view.state.doc.content.size;
    const sliceToMerge = view.state.doc.slice(1, myDocSize - 1, true);

    const tr = prevView.state.tr.replace(mergePoint, mergePoint, sliceToMerge);
    tr.setSelection(Selection.near(tr.doc.resolve(mergePoint)));
    prevView.dispatch(tr);
    prevView.focus();
    onRemoveSelf();
    return true;
  }

  const text = view.state.doc.textContent;
  if (!text) return false;

  const mergePoint = mergePlainTextIntoRichText(
    prev.id,
    text,
    tree,
    focus,
    saveYjsState,
  );
  if (mergePoint == null) return false;
  focus.requestFocus(prev.id, "end");
  onRemoveSelf();
  return true;
}

/** Clone a block as a new sibling immediately below. Shallow — children are not copied. */
export function duplicateBlock(
  node: BlockNode,
  tree: BlockTree,
  mutations: PulpMutations,
  focus: SurfaceFocusValue,
): void {
  if (node.parentId == null) return;

  const def = tree.defs.get(node.componentType);
  let initialDoc: Y.Doc | undefined;

  if (def?.hasYjsState) {
    const view = focus.getEditor(node.id);
    if (view) {
      initialDoc = prosemirrorToYDoc(view.state.doc, PROSEMIRROR_FRAGMENT_KEY);
    } else {
      const yjs = tree.yjs.get(node.id);
      if (yjs?.data && yjs.data.byteLength > 0) {
        initialDoc = new Y.Doc();
        Y.applyUpdate(initialDoc, yjs.data);
      }
    }
  }

  focus.armForInsert(node.parentId, node.id, {
    ...(initialDoc ? { initialDoc } : {}),
    focusAt: "start",
    knownSiblingIds: knownSiblingIdsForParent(tree, node.parentId),
  });
  mutations.insertBlock({
    parentId: node.parentId,
    componentType: node.componentType,
    propsJson: node.props,
    afterSiblingId: node.id,
  });
}

/**
 * Replace this block with another component type (Notion-style "Turn into…").
 * Content is carried over when the conversion is straightforward (text ↔ heading).
 */
export function turnIntoBlock(
  node: BlockNode,
  tree: BlockTree,
  item: SlashMenuItem,
  mutations: PulpMutations,
  focus: SurfaceFocusValue,
): void {
  if (node.parentId == null) return;

  if (
    node.componentType === "Heading" &&
    item.componentType === "Heading" &&
    typeof item.defaultProps.level === "number"
  ) {
    const current = safeParseProps(node.props);
    mutations.updateBlockProps({
      componentId: node.id,
      propsJson: JSON.stringify({
        ...current,
        level: item.defaultProps.level,
      }),
    });
    return;
  }

  if (
    node.componentType === item.componentType &&
    item.componentType !== "Heading"
  ) {
    return;
  }

  const carryText = extractCarryText(node, tree, focus);
  const props = buildTurnIntoProps(item, node, carryText);
  const targetDef = tree.defs.get(item.componentType);
  const initialDoc =
    targetDef?.hasYjsState && carryText
      ? plainTextToYDoc(carryText)
      : undefined;

  const parentSiblings = tree.byParent.get(node.parentId) ?? [];
  const myIdx = parentSiblings.findIndex((s) => s.id === node.id);
  const predecessor = myIdx > 0 ? parentSiblings[myIdx - 1]?.id : undefined;

  focus.armForInsert(node.parentId, predecessor, {
    ...(initialDoc ? { initialDoc } : {}),
    focusAt: "start",
    knownSiblingIds: knownSiblingIdsForParent(tree, node.parentId),
  });
  mutations.insertBlock({
    parentId: node.parentId,
    componentType: item.componentType,
    propsJson: JSON.stringify(props),
    afterSiblingId: predecessor,
  });

  mutations.deleteBlock({ componentId: node.id });
}

function extractCarryText(
  node: BlockNode,
  tree: BlockTree,
  focus: SurfaceFocusValue,
): string {
  if (node.componentType === "Heading") {
    const props = safeParseProps(node.props);
    return typeof props.text === "string" ? props.text : "";
  }

  const def = tree.defs.get(node.componentType);
  if (def?.hasYjsState) {
    const view = focus.getEditor(node.id);
    if (view) return view.state.doc.textContent;
    const yjs = tree.yjs.get(node.id);
    if (yjs?.data && yjs.data.byteLength > 0) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, yjs.data);
      return yDocToPlainText(doc);
    }
  }
  return "";
}

function buildTurnIntoProps(
  item: SlashMenuItem,
  node: BlockNode,
  carryText: string,
): Record<string, unknown> {
  if (item.componentType === "Heading") {
    return {
      ...item.defaultProps,
      text: carryText || (item.defaultProps.text ?? ""),
    };
  }
  if (item.componentType === "RichText") {
    return { ...item.defaultProps };
  }
  if (isDocumentListItemType(item.componentType)) {
    return { ...item.defaultProps };
  }
  if (node.componentType === item.componentType) {
    return safeParseProps(node.props);
  }
  return { ...item.defaultProps };
}

function plainTextToYDoc(text: string): Y.Doc {
  const para = richTextSchema.node(
    "paragraph",
    null,
    text ? richTextSchema.text(text) : undefined,
  );
  const pmDoc = richTextSchema.node("doc", null, [para]);
  return prosemirrorToYDoc(pmDoc, PROSEMIRROR_FRAGMENT_KEY);
}

function safeParseProps(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
