import { Selection } from "prosemirror-state";
import * as Y from "yjs";
import { prosemirrorToYDoc } from "y-prosemirror";
import type { SurfaceFocusValue } from "./focus/SurfaceFocusCoordinator";
import { knownSiblingIdsForParent } from "./focus/insertFocusHelpers";
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
  const initialDoc =
    item.componentType === "RichText" && carryText
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

  if (parentSiblings.length > 1) {
    mutations.deleteBlock({ componentId: node.id });
  }
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
  if (node.componentType === "RichText") {
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
