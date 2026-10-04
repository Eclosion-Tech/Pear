import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import * as Y from "yjs";
import { prosemirrorToYDoc, ySyncPlugin } from "y-prosemirror";
import { SurfaceTextSelection } from "./SurfaceTextSelection";
import { textSelectionPlugin } from "./textSelectionPlugin";
import { richTextSchema as schema } from "../rich-text/richTextSchema";
import { SurfaceUndoCoordinator } from "../undo/SurfaceUndoCoordinator";
import { textUndoManager, textUndoPlugin } from "../undo/textUndo";
import { makeTree } from "../test/fixtures";
import type { PulpMutations } from "../types";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((fn) => fn()); document.body.innerHTML = ""; });

function fixture() {
  const text = new SurfaceTextSelection();
  const undo = new SurfaceUndoCoordinator();
  const tree = makeTree([{ id: 1, type: "Container", parent: null },
    ...[2, 3, 4, 5].map((id) => ({ id, type: "RichText", parent: 1 }))]);
  const removed = new Set<bigint>();
  const base: PulpMutations = { insertBlock: vi.fn(), moveBlock: vi.fn(), updateBlockProps: vi.fn(), saveYjsState: vi.fn(),
    deleteBlock: ({ componentId }) => { removed.add(componentId); },
    restoreBlock: ({ componentId }) => { removed.delete(componentId); } };
  const mutations = undo.wrapMutations(base, () => tree);
  const views = new Map<bigint, EditorView>();
  const docs = new Map<bigint, Y.Doc>();
  ["Alpha bravo", "Middle words", "Charlie delta", "Untouched"].forEach((value, index) => {
    const id = BigInt(index + 2);
    const doc = prosemirrorToYDoc(schema.node("doc", null, [schema.node("paragraph", null, schema.text(value))]));
    const fragment = doc.getXmlFragment("prosemirror");
    const manager = textUndoManager(doc);
    const view = new EditorView(document.body.appendChild(document.createElement("div")), {
      state: EditorState.create({ schema, plugins: [ySyncPlugin(fragment), textUndoPlugin(manager), textSelectionPlugin(id, text)] }),
      dispatchTransaction(this: EditorView, tr) { this.updateState(this.state.apply(tr)); text.onTransaction(id, tr); },
      handleScrollToSelection: () => true,
    });
    const unregister = text.register(id, view);
    const unregisterUndo = undo.registerYjsUndoManager(id, manager);
    cleanup.push(() => { unregisterUndo(); unregister(); if (!view.isDestroyed) view.destroy(); doc.destroy(); });
    views.set(id, view); docs.set(id, doc);
  });
  const select = (backwards = false) => {
    const a = { id: 2n, pos: 7 }, b = { id: 4n, pos: 8 };
    text.set(backwards ? b : a, backwards ? a : b, [2n, 3n, 4n, 5n]);
  };
  return { text, undo, tree, removed, mutations, views, docs, select };
}

describe("surface text ranges", () => {
  it.each([false, true])("copies exact partial endpoints and paragraph breaks (backward=%s)", (backwards) => {
    const { text, select, views } = fixture();
    const view = views.get(3n)!;
    view.dispatch(view.state.tr.addMark(1, 7, schema.marks.italic.create()));
    select(backwards);
    expect(text.clipboard()?.text).toBe("bravo\nMiddle words\nCharlie");
    expect(text.clipboard()?.html).toBe("<p>bravo</p><p><em>Middle</em> words</p><p>Charlie</p>");
    expect(Array.from(document.querySelectorAll("[data-text-selected]")).map((node) => node.textContent).join("|")).toBe("bravo|Middle| words|Charlie");
  });

  it.each([false, true])("replaces a range and undoes/redoes the whole edit together (backward=%s)", async (backwards) => {
    const { text, select, views, tree, mutations, undo, removed } = fixture();
    select(backwards);
    expect(text.replace("NEW", tree, mutations, undo)).toBe(true);
    expect(views.get(2n)!.state.doc.textContent).toBe("Alpha NEW delta");
    expect(removed).toEqual(new Set([3n, 4n]));
    expect(views.get(5n)!.state.doc.textContent).toBe("Untouched");
    await undo.undo();
    expect(views.get(2n)!.state.doc.textContent).toBe("Alpha bravo");
    expect(removed.size).toBe(0);
    expect(undo.canUndo()).toBe(false);
    await undo.redo();
    expect(views.get(2n)!.state.doc.textContent).toBe("Alpha NEW delta");
    expect(removed).toEqual(new Set([3n, 4n]));
  });

  it("formats only selected text, with one undo distinct from previous typing", async () => {
    const { text, select, views, undo } = fixture();
    const first = views.get(2n)!;
    first.dispatch(first.state.tr.insertText("!", 12));
    select();
    text.format(schema.marks.bold, undo);
    expect(first.state.doc.rangeHasMark(1, 6, schema.marks.bold)).toBe(false);
    expect(first.state.doc.rangeHasMark(7, 12, schema.marks.bold)).toBe(true);
    expect(views.get(4n)!.state.doc.rangeHasMark(9, 14, schema.marks.bold)).toBe(false);
    await undo.undo();
    for (const view of views.values()) expect(view.state.doc.rangeHasMark(0, view.state.doc.content.size, schema.marks.bold)).toBe(false);
    expect(first.state.doc.textContent).toBe("Alpha bravo!");
    await undo.undo();
    expect(first.state.doc.textContent).toBe("Alpha bravo");
  });

  it("preserves nested/non-text structure while deleting selected text", () => {
    const { text, select, views, tree, mutations, undo, removed } = fixture();
    tree.byParent.set(3n, [tree.byId.get(5n)!]);
    select();
    text.replace("", tree, mutations, undo);
    expect(removed.size).toBe(0);
    expect(views.get(2n)!.state.doc.textContent).toBe("Alpha ");
    expect(views.get(3n)!.state.doc.textContent).toBe("");
    expect(views.get(4n)!.state.doc.textContent).toBe(" delta");
  });

  it("keeps marked suffixes when joining the final paragraph", () => {
    const { text, select, views, tree, mutations, undo } = fixture();
    const last = views.get(4n)!;
    last.dispatch(last.state.tr.addMark(9, 14, schema.marks.italic.create()));
    select();
    text.replace("", tree, mutations, undo);
    const first = views.get(2n)!;
    expect(first.state.doc.textContent).toBe("Alpha  delta");
    expect(first.state.doc.rangeHasMark(8, 13, schema.marks.italic)).toBe(true);
  });

  it("can undo and redo formatting after an editor is virtualized out of view", async () => {
    const { text, select, views, docs, undo, mutations } = fixture();
    select();
    text.format(schema.marks.bold, undo);
    text.clear();
    views.get(3n)!.destroy();
    await undo.undo();
    const manager = textUndoManager(docs.get(3n)!);
    expect(manager.canRedo()).toBe(true);
    expect(mutations.saveYjsState).toHaveBeenCalledWith(expect.objectContaining({ componentId: 3n }));
    await undo.redo();
    expect(manager.canUndo()).toBe(true);
    const content = docs.get(3n)!.getXmlFragment("prosemirror").toString();
    expect(content).toContain("bold");
  });

  it("pastes rich text and multiple paragraphs into the exact range", () => {
    const { text, select, views, tree, mutations, undo } = fixture();
    select();
    const slice = text.pasteSlice("", "<p><strong>New</strong></p><p>line</p>")!;
    text.replace(slice, tree, mutations, undo);
    expect(views.get(2n)!.state.doc.textBetween(0, views.get(2n)!.state.doc.content.size, "\n")).toBe("Alpha New\nline delta");
    expect(views.get(2n)!.state.doc.rangeHasMark(7, 10, schema.marks.bold)).toBe(true);
  });

  it("tracks selected characters when Yjs inserts text before an endpoint", () => {
    const { text, select, docs } = fixture();
    select();
    const doc = docs.get(2n)!;
    const paragraph = doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
    doc.transact(() => (paragraph.get(0) as Y.XmlText).insert(0, "Remote "), "remote");
    expect(text.clipboard()?.text).toBe("bravo\nMiddle words\nCharlie");
  });

  it("waits for all selected editors instead of truncating a virtualized range", () => {
    const { text, tree, mutations, undo, removed } = fixture();
    text.set({ id: 2n, pos: 7 }, { id: 4n, pos: 8 }, [2n, 99n, 4n]);
    expect(text.clipboard()).toBeNull();
    expect(text.replace("", tree, mutations, undo)).toBe(false);
    expect(removed.size).toBe(0);
  });

  it("clears stale ranges after a selected body disappears or moves", () => {
    const { text, select } = fixture();
    select();
    text.reconcile([2n, 4n, 3n, 5n]);
    expect(text.getSnapshot()).toBeNull();
  });

  it("finishes Select All when the last off-screen editor mounts", () => {
    const { text, views } = fixture();
    text.selectAll([2n, 3n, 4n, 99n]);
    expect(text.getSnapshot()?.ids).toEqual([2n, 3n, 4n, 99n]);
    expect(text.clipboard()).toBeNull();
    const unregister = text.register(99n, views.get(5n)!);
    cleanup.push(unregister);
    expect(text.clipboard()?.text).toBe("Alpha bravo\nMiddle words\nCharlie delta\nUntouched");
  });
});
