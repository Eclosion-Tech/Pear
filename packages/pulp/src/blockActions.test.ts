import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
  canNestBlock,
  canUnnestBlock,
  deleteEmptyBlockAndFocusDocumentPrev,
  mergeBlockIntoDocumentPrev,
  nestBlockUnderPreviousSibling,
  turnIntoBlock,
  unnestBlock,
} from "./blockActions";
import { plainTextToYDoc } from "./rich-text/richTextFormatting";
import { richTextSchema } from "./rich-text/richTextSchema";
import { yDocToPlainText } from "./rich-text/yjsToHtml";
import {
  createMockFocus,
  createMockMutations,
  makeTree,
  mockEditorView,
  node,
} from "./test/fixtures";

describe("canNestBlock / canUnnestBlock", () => {
  it("allows nest when a previous sibling accepts children", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 1 },
    ]);
    expect(canNestBlock(node(tree, 3), tree)).toBe(true);
    expect(canUnnestBlock(node(tree, 3), tree)).toBe(false);
  });

  it("allows unnest for nested list rows", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "BulletListItem", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
    ]);
    expect(canUnnestBlock(node(tree, 3), tree)).toBe(true);
  });
});

describe("nestBlockUnderPreviousSibling", () => {
  it("moves block under previous heading", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 1 },
    ]);
    const focus = createMockFocus();
    const mutations = createMockMutations();

    const ok = nestBlockUnderPreviousSibling(
      node(tree, 3),
      tree,
      mutations,
      focus,
    );

    expect(ok).toBe(true);
    expect(mutations.calls.moveBlock[0]).toEqual({
      componentId: 3n,
      newParentId: 2n,
      afterSiblingId: undefined,
    });
    expect(focus.calls.requestFocus[0]).toEqual([3n, "start"]);
  });
});

describe("unnestBlock", () => {
  it("moves nested row to grandparent after parent", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "BulletListItem", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
    ]);
    const focus = createMockFocus();
    const mutations = createMockMutations();

    unnestBlock(node(tree, 3), tree, mutations, focus);

    expect(mutations.calls.moveBlock[0]).toEqual({
      componentId: 3n,
      newParentId: 1n,
      afterSiblingId: 2n,
    });
  });
});

describe("deleteEmptyBlockAndFocusDocumentPrev", () => {
  it("focuses document-order previous block, not same-parent only", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "BulletListItem", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
    ]);
    const focus = createMockFocus();
    const deleteBlock = vi.fn();

    deleteEmptyBlockAndFocusDocumentPrev(
      node(tree, 3),
      tree,
      focus,
      deleteBlock,
    );

    expect(focus.calls.requestFocus[0]).toEqual([2n, "end"]);
    expect(deleteBlock).toHaveBeenCalledWith({ componentId: 3n });
  });
});

describe("turnIntoBlock", () => {
  it("updates heading level in place without re-inserting", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1, props: '{"level":1,"textAlign":"center"}' },
    ]);
    const focus = createMockFocus();
    const mutations = createMockMutations();

    turnIntoBlock(
      node(tree, 2),
      tree,
      {
        id: "h2",
        section: "Text",
        label: "Heading 2",
        componentType: "Heading",
        defaultProps: { level: 2 },
        searchTokens: [],
      },
      mutations,
      focus,
    );

    expect(mutations.calls.updateBlockProps[0]?.propsJson).toBe(
      '{"level":2,"textAlign":"center"}',
    );
    expect(mutations.calls.insertBlock).toHaveLength(0);
    expect(mutations.calls.deleteBlock).toHaveLength(0);
  });

  it("carries Yjs text when turning RichText into Heading", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "RichText", parent: 1 },
    ]);
    tree.yjs.set(2n, {
      componentNodeId: 2n,
      data: Y.encodeStateAsUpdate(plainTextToYDoc("Hello")),
    });

    const focus = createMockFocus();
    const mutations = createMockMutations();

    turnIntoBlock(
      node(tree, 2),
      tree,
      {
        id: "h1",
        section: "Text",
        label: "Heading 1",
        componentType: "Heading",
        defaultProps: { level: 1 },
        searchTokens: [],
      },
      mutations,
      focus,
    );

    expect(mutations.calls.insertBlock[0]?.componentType).toBe("Heading");
    expect(mutations.calls.insertBlock[0]?.propsJson).toBe('{"level":1}');
    expect(mutations.calls.deleteBlock[0]?.componentId).toBe(2n);

    const initialDoc = focus.calls.armForInsert[0]?.opts?.initialDoc;
    expect(initialDoc).toBeDefined();
    expect(yDocToPlainText(initialDoc!)).toBe("Hello");
  });

  it("carries live editor text from mounted view", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "RichText", parent: 1 },
    ]);
    const doc = richTextSchema.node("doc", null, [
      richTextSchema.node("paragraph", null, [richTextSchema.text("Live")]),
    ]);
    const state = EditorState.create({ schema: richTextSchema, doc });
    const view = mockEditorView(state);

    const focus = createMockFocus(new Map([[2n, view]]));
    const mutations = createMockMutations();

    turnIntoBlock(
      node(tree, 2),
      tree,
      {
        id: "h1",
        section: "Text",
        label: "Heading 1",
        componentType: "Heading",
        defaultProps: { level: 1 },
        searchTokens: [],
      },
      mutations,
      focus,
    );

    const initialDoc = focus.calls.armForInsert[0]?.opts?.initialDoc;
    expect(yDocToPlainText(initialDoc!)).toBe("Live");
  });
});

describe("mergeBlockIntoDocumentPrev", () => {
  it("merges live editor content into previous Yjs block", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "RichText", parent: 1 },
      { id: 3, type: "RichText", parent: 1 },
    ]);

    const host = document.createElement("div");
    const prevDoc = richTextSchema.node("doc", null, [
      richTextSchema.node("paragraph", null, [richTextSchema.text("Prev")]),
    ]);
    const myDoc = richTextSchema.node("doc", null, [
      richTextSchema.node("paragraph", null, [richTextSchema.text("Next")]),
    ]);
    const prevView = new EditorView(host, {
      state: EditorState.create({ schema: richTextSchema, doc: prevDoc }),
    });
    const myView = new EditorView(document.createElement("div"), {
      state: EditorState.create({ schema: richTextSchema, doc: myDoc }),
    });

    const focus = createMockFocus(
      new Map([
        [2n, prevView],
        [3n, myView],
      ]),
    );
    const saveYjsState = vi.fn();
    const onRemoveSelf = vi.fn();

    const ok = mergeBlockIntoDocumentPrev(
      node(tree, 3),
      myView,
      tree,
      focus,
      saveYjsState,
      onRemoveSelf,
    );

    expect(ok).toBe(true);
    expect(prevView.state.doc.textContent).toBe("PrevNext");
    expect(onRemoveSelf).toHaveBeenCalledOnce();

    prevView.destroy();
    myView.destroy();
  });
});
