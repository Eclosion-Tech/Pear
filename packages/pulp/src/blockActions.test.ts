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
  unlistToRichText,
  unnestBlock,
} from "./blockActions";
import { plainTextToYDoc } from "./rich-text/richTextFormatting";
import { richTextSchema } from "./rich-text/richTextSchema";
import { yDocToHtml, yDocToPlainText } from "./rich-text/yjsToHtml";
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

  it("nests sibling below heading after existing section body", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
      { id: 4, type: "RichText", parent: 1 },
    ]);
    const focus = createMockFocus();
    const mutations = createMockMutations();

    nestBlockUnderPreviousSibling(node(tree, 4), tree, mutations, focus);

    expect(mutations.calls.moveBlock[0]).toEqual({
      componentId: 4n,
      newParentId: 2n,
      afterSiblingId: 3n,
    });
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
    const mutations = createMockMutations();

    deleteEmptyBlockAndFocusDocumentPrev(
      node(tree, 3),
      tree,
      focus,
      mutations,
    );

    expect(focus.calls.requestFocus[0]).toEqual([2n, "end"]);
    expect(mutations.calls.deleteBlock[0]).toEqual({ componentId: 3n });
  });

  it("reparents section children before deleting an empty heading", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
      { id: 4, type: "RichText", parent: 1 },
    ]);
    const focus = createMockFocus();
    const mutations = createMockMutations();

    deleteEmptyBlockAndFocusDocumentPrev(
      node(tree, 2),
      tree,
      focus,
      mutations,
    );

    expect(mutations.calls.moveBlock[0]).toEqual({
      componentId: 3n,
      newParentId: 1n,
      afterSiblingId: 2n,
    });
    expect(mutations.calls.deleteBlock[0]).toEqual({ componentId: 2n });
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

  it("preserves inline formatting (bold) across a turn-into", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "RichText", parent: 1 },
    ]);
    const doc = richTextSchema.node("doc", null, [
      richTextSchema.node("paragraph", null, [
        richTextSchema.text("Bold", [richTextSchema.marks.bold.create()]),
      ]),
    ]);
    const view = mockEditorView(
      EditorState.create({ schema: richTextSchema, doc }),
    );

    const focus = createMockFocus(new Map([[2n, view]]));
    const mutations = createMockMutations();

    turnIntoBlock(
      node(tree, 2),
      tree,
      {
        id: "h1",
        section: "Text",
        label: "Heading 1",
        description: "",
        componentType: "Heading",
        defaultProps: { level: 1 },
        searchTokens: [],
      },
      mutations,
      focus,
    );

    const initialDoc = focus.calls.armForInsert[0]?.opts?.initialDoc;
    expect(initialDoc).toBeDefined();
    expect(yDocToHtml(initialDoc!)).toContain("<strong>");
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
      { saveYjsState, moveBlock: vi.fn() },
      onRemoveSelf,
    );

    expect(ok).toBe(true);
    expect(prevView.state.doc.textContent).toBe("PrevNext");
    expect(onRemoveSelf).toHaveBeenCalledOnce();

    prevView.destroy();
    myView.destroy();
  });
});

describe("unlistToRichText", () => {
  it("replaces an empty list item with a RichText in the same slot", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "RichText", parent: 1 },
      { id: 3, type: "BulletListItem", parent: 1 },
    ]);
    const focus = createMockFocus();
    const mutations = createMockMutations();

    const ok = unlistToRichText(node(tree, 3), tree, mutations, focus);

    expect(ok).toBe(true);
    expect(mutations.calls.insertBlock[0]).toMatchObject({
      parentId: 1n,
      componentType: "RichText",
      afterSiblingId: 2n,
    });
    expect(mutations.calls.deleteBlock[0]).toEqual({ componentId: 3n });
    // Empty list item → nothing to carry.
    expect(focus.calls.armForInsert[0]?.opts?.initialDoc).toBeUndefined();
  });

  it("carries the list item's content (with marks) when un-listing", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "BulletListItem", parent: 1 },
    ]);
    const doc = richTextSchema.node("doc", null, [
      richTextSchema.node("paragraph", null, [
        richTextSchema.text("Item", [richTextSchema.marks.italic.create()]),
      ]),
    ]);
    const view = mockEditorView(
      EditorState.create({ schema: richTextSchema, doc }),
    );
    const focus = createMockFocus(new Map([[2n, view]]));
    const mutations = createMockMutations();

    unlistToRichText(node(tree, 2), tree, mutations, focus);

    const initialDoc = focus.calls.armForInsert[0]?.opts?.initialDoc;
    expect(yDocToPlainText(initialDoc!)).toBe("Item");
    expect(yDocToHtml(initialDoc!)).toContain("<em>");
  });

  it("returns false for a non-list block", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "RichText", parent: 1 },
    ]);
    const focus = createMockFocus();
    const mutations = createMockMutations();

    expect(unlistToRichText(node(tree, 2), tree, mutations, focus)).toBe(false);
    expect(mutations.calls.insertBlock).toHaveLength(0);
  });

  it("reparents nested rows before un-listing a list item", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "BulletListItem", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
      { id: 4, type: "RichText", parent: 2 },
    ]);
    const focus = createMockFocus();
    const mutations = createMockMutations();

    unlistToRichText(node(tree, 2), tree, mutations, focus);

    expect(mutations.calls.moveBlock).toEqual([
      { componentId: 3n, newParentId: 1n, afterSiblingId: 2n },
      { componentId: 4n, newParentId: 1n, afterSiblingId: 3n },
    ]);
    expect(mutations.calls.insertBlock[0]?.componentType).toBe("RichText");
    expect(mutations.calls.deleteBlock[0]).toEqual({ componentId: 2n });
  });
});
