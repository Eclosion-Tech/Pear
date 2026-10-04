import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h, useState, useSyncExternalStore } from "react";
import { PageComposition, type CompositionLayout } from "../composition/PageComposition";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { BlockEditor } from "../BlockEditor";
import { BlockChromeHeaderControls } from "../BlockChrome";
import { ContainerDropZone } from "../dnd/ContainerDropZone";
import { PulpProvider } from "../context/PulpProvider";
import { SurfaceFocusCoordinator, SurfaceFocusProvider, useSurfaceFocus } from "../focus/SurfaceFocusProvider";
import { SurfaceUndoCoordinator, SurfaceUndoProvider, useSurfaceUndo } from "../undo/SurfaceUndoProvider";
import { useSurfaceSelection } from "../selection/SurfaceSelectionProvider";
import { useBlockOccurrence } from "./BlockOccurrence";
import { registerRenderer } from "../registry";
import { registerCoreBlocks } from "../registerCoreBlocks";
import { RichTextRenderer } from "../rich-text/RichText";
import { plainTextToYDoc } from "../rich-text/richTextFormatting";
import { yDocToPlainText } from "../rich-text/yjsToHtml";
import { makeTree, type FlatBlockSpec } from "../test/fixtures";
import type { BlockTree, PulpConfig, PulpMutations } from "../types";
import { parseReferenceProps, referenceProps, referenceTree, type ReferenceSourceProps } from "./types";

vi.mock("y-indexeddb", () => ({ IndexeddbPersistence: class { destroy() {} } }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("IntersectionObserver", class {
  constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe() { this.callback([{ isIntersecting: true }]); }
  disconnect() {}
});
let root: Root | undefined;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; });

function page(surface: number, blocks: FlatBlockSpec[]) {
  const tree = makeTree([{ id: surface * 10, type: "Container", parent: null }, ...blocks], {
    surfaceId: surface, extraDefs: { Reference: { componentType: "Reference", propSchema: "{}", acceptsChildren: false } },
  });
  for (const type of ["Heading", "BulletListItem", "NumberedListItem"]) {
    if (!blocks.some(block => block.type === type)) tree.defs.delete(type);
  }
  for (const node of tree.byId.values()) if (node.componentType === "RichText" || node.componentType === "Heading") {
    const doc = plainTextToYDoc(`Text ${node.id}`);
    tree.yjs.set(node.id, { componentNodeId: node.id, data: Y.encodeStateAsUpdate(doc) }); doc.destroy();
  }
  return tree;
}
const ref = (id: number, parent: number, surfaceId: number, blockId?: number): FlatBlockSpec => ({
  id, parent, type: "Reference", props: referenceProps({ surfaceId: BigInt(surfaceId), blockId: blockId == null ? undefined : BigInt(blockId) }),
});

async function fixture(trees: BlockTree[], readOnly = false, composition = false) {
  registerCoreBlocks();
  const listeners = new Set<() => void>();
  const store = new Map(trees.map((tree) => [tree.root!.surfaceId, tree]));
  const subscriptions = new Map<bigint, number>();
  const scopes = new Map<string, { focus: ReturnType<typeof useSurfaceFocus>; undo: SurfaceUndoCoordinator;
    selection: ReturnType<typeof useSurfaceSelection> }>();
  const changes: Array<{ operation: string; id: bigint }> = [];
  const publish = (id: bigint, tree: BlockTree) => { store.set(id, tree); listeners.forEach((fn) => fn()); };
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  const mutations = new Map<bigint, PulpMutations>();
  for (const [surfaceId] of store) mutations.set(surfaceId, {
    insertBlock: vi.fn(), moveBlock: vi.fn(), restoreBlock: vi.fn(),
    updateBlockProps: ({ componentId, propsJson }) => {
      const tree = store.get(surfaceId)!;
      const byId = new Map(tree.byId);
      byId.set(componentId, { ...byId.get(componentId)!, props: propsJson });
      const byParent = new Map([...tree.byParent].map(([id, nodes]) => [id, nodes.map((n) => byId.get(n.id)!)]));
      publish(surfaceId, { ...tree, byId, byParent });
    },
    deleteBlock: ({ componentId }) => {
      changes.push({ operation: "delete", id: componentId });
      const tree = store.get(surfaceId)!;
      const byId = new Map(tree.byId); byId.delete(componentId);
      const byParent = new Map([...tree.byParent].map(([id, nodes]) => [id, nodes.filter((n) => n.id !== componentId)]));
      publish(surfaceId, { ...tree, byId, byParent });
    },
    saveYjsState: ({ componentId, data }) => {
      changes.push({ operation: "save", id: componentId });
      const tree = store.get(surfaceId)!;
      const yjs = new Map(tree.yjs);
      yjs.set(componentId, { componentNodeId: componentId, data });
      publish(surfaceId, { ...tree, yjs });
    },
  });
  function Source({ target, children }: ReferenceSourceProps) {
    const tree = useSyncExternalStore(subscribe, () => store.get(target.surfaceId)!);
    subscriptions.set(target.surfaceId, (subscriptions.get(target.surfaceId) ?? 0) + 1);
    return children({ tree, mutations: mutations.get(target.surfaceId)!, readOnly, label: `Page ${target.surfaceId}` });
  }
  registerRenderer("Container", ({ node, tree, children }) => h(ContainerDropZone, {
    containerId: node.id, tree, acceptsChildren: true, children,
    header: h(BlockChromeHeaderControls),
  }));
  registerRenderer("RichText", (props) => {
    const { prefix } = useBlockOccurrence();
    const focus = useSurfaceFocus();
    const { coordinator: undo } = useSurfaceUndo();
    const selection = useSurfaceSelection();
    scopes.set(prefix, { focus, undo, selection });
    return h(RichTextRenderer, props);
  });
  const config: PulpConfig = { idbPrefix: "reference-test", references: { Source,
    parseLink: (value) => parseReferenceProps(value), href: (target) => `/source/${target.surfaceId}#${target.blockId ?? ""}` } };
  const focus = new SurfaceFocusCoordinator(), undo = new SurfaceUndoCoordinator();
  const outerMutations = undo.wrapMutations(mutations.get(1n)!, () => store.get(1n)!);
  function App() {
    const tree = useSyncExternalStore(subscribe, () => store.get(1n)!);
    const [layout, setLayout] = useState<CompositionLayout>("structured");
    const editor = h(PulpProvider, { tree, config, mutations: outerMutations,
      children: h(SurfaceFocusProvider, { coordinator: focus,
        children: h(SurfaceUndoProvider, { coordinator: undo, children: h(BlockEditor) }) }) });
    return composition ? h(PageComposition, { layout, onLayoutChange: setLayout, pageLabel: "Composition", children: editor }) : editor;
  }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(() => root!.render(h(App)));
  return { scopes, store, changes, subscriptions, publish, mutations, undo };
}

describe("editable reference containers", () => {
  it("preserves mounted editors, source sync, selection and undo across page layouts", async () => {
    const { scopes } = await fixture([page(1, [ref(11, 10, 2), ref(12, 10, 2)]),
      page(2, [{ id: 21, parent: 20, type: "RichText" }])], false, true);
    const view = scopes.get("ref-11-")!.focus.getEditor(21n)!;
    await act(() => { view.focus(); view.dispatch(view.state.tr.insertText("Draft ", 1)); });
    const selection = view.state.selection.toJSON();
    const continuous = [...document.querySelectorAll("button")].find(button => button.textContent === "Continuous")!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await act(() => { continuous.dispatchEvent(down); continuous.click(); });
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.dom);
    expect(scopes.get("ref-11-")!.focus.getEditor(21n)).toBe(view);
    expect(view.state.selection.toJSON()).toEqual(selection);
    expect(scopes.get("ref-12-")!.focus.getEditor(21n)!.state.doc.textContent).toBe("Draft Text 21");
    await act(() => view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })));
    expect(view.state.doc.textContent).toBe("Text 21");
    expect(scopes.get("ref-12-")!.focus.getEditor(21n)!.state.doc.textContent).toBe("Text 21");
    const structured = [...document.querySelectorAll("button")].find(button => button.textContent === "Structured")!;
    await act(() => structured.click());
    expect(scopes.get("ref-11-")!.focus.getEditor(21n)).toBe(view);
    expect(document.querySelector("[data-composition-layout]")?.getAttribute("data-composition-layout")).toBe("structured");
  });

  it("shows the actual nested source path and clears source context when that source disappears", async () => {
    const source = page(3, [{ id: 31, parent: 30, type: "RichText" }]);
    const { scopes, publish } = await fixture([page(1, [ref(11, 10, 2)]), page(2, [ref(21, 20, 3)]), source], false, true);
    await act(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Continuous")!.click());
    const view = scopes.get("ref-11-ref-21-")!.focus.getEditor(31n)!;
    await act(() => view.focus());
    await act(() => document.querySelector<HTMLButtonElement>("[aria-label='Source details: Page 3']")!.click());
    const popover = document.querySelector("[aria-label='Block source']")!;
    expect(popover.textContent).toContain("Composition › Page 2 › Page 3");
    expect(popover.querySelector("a")?.getAttribute("href")).toBe("/source/3#31");
    expect(popover.textContent).toContain("Edits update the original");
    await act(async () => {
      publish(3n, { ...source, root: null, byId: new Map(), byParent: new Map() });
    });
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(document.querySelector("[aria-label='Block source']")).toBeNull();
    expect(document.querySelector(".pulp-composition-context")?.textContent).not.toContain("Page 3");
    expect(document.querySelector("[role='status']")?.textContent).toContain("Source unavailable");
  });

  it("provides honest source context for read-only references in continuous view", async () => {
    await fixture([page(1, [ref(11, 10, 2)]), page(2, [{ id: 21, parent: 20, type: "Heading" }])], true, true);
    await act(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Continuous")!.click());
    const source = document.querySelector<HTMLElement>("[data-source-readonly='true']")!;
    expect(source.tabIndex).toBe(0);
    await act(() => source.focus());
    await act(() => document.querySelector<HTMLButtonElement>("[aria-label='Source details: Page 2']")!.click());
    expect(document.querySelector(".pulp-composition-context")?.textContent).toContain("ViewingPage 2· read only");
    expect(document.querySelector("[aria-label='Block source']")?.textContent).toContain("cannot edit it");
    expect(source.querySelector(".ProseMirror")).toBeNull();
    await act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector("[aria-label='Block source']")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Source details: Page 2");
  });

  it("renders source gutters with independent occurrence IDs, and removes only the inclusion", async () => {
    const { changes, store } = await fixture([page(1, [ref(11, 10, 2), ref(12, 10, 2)]),
      page(2, [{ id: 21, parent: 20, type: "RichText" }])]);
    expect(document.querySelector("#ref-11-block-21 .ProseMirror")?.textContent).toBe("Text 21");
    expect(document.querySelector("#ref-12-block-21 .ProseMirror")?.textContent).toBe("Text 21");
    expect(document.querySelectorAll("[id='block-21']")).toHaveLength(0);
    const grip = document.querySelector<HTMLButtonElement>("#block-11 button[aria-haspopup='menu']")!;
    await act(() => grip.click());
    const remove = [...document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find((el) => el.textContent === "Delete")!;
    await act(() => remove.click());
    expect(changes).toEqual([{ operation: "delete", id: 11n }]);
    expect(store.get(2n)!.byId.has(21n)).toBe(true);
    expect(document.querySelector("#ref-12-block-21")).not.toBeNull();
  });

  it("edits the source and updates a second inclusion, with undo routed to the active occurrence", async () => {
    const { scopes, store, undo } = await fixture([page(1, [ref(11, 10, 2), ref(12, 10, 2), { id: 13, parent: 10, type: "RichText" }]),
      page(2, [{ id: 21, parent: 20, type: "RichText" }])]);
    const first = scopes.get("ref-11-")!.focus.getEditor(21n)!;
    const second = scopes.get("ref-12-")!.focus.getEditor(21n)!;
    const outerUndo = vi.spyOn(undo, "undo");
    await act(() => first.dispatch(first.state.tr.insertText("Edited ", 1)));
    expect(second.state.doc.textContent).toBe("Edited Text 21");
    // Use the editor's normal unload flush to verify persistence separately
    // from immediate synchronization between mounted occurrences.
    await act(() => window.dispatchEvent(new Event("beforeunload")));
    const doc = new Y.Doc(); Y.applyUpdate(doc, store.get(2n)!.yjs.get(21n)!.data);
    expect(yDocToPlainText(doc)).toBe("Edited Text 21"); doc.destroy();
    await act(async () => { first.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    expect(outerUndo).not.toHaveBeenCalled();
    expect(first.state.doc.textContent).toBe("Text 21");
    expect(second.state.doc.textContent).toBe("Text 21");
  });

  it("keeps Enter inside a reference to one text block", async () => {
    const { scopes, mutations } = await fixture([page(1, [ref(11, 10, 2, 21)]),
      page(2, [{ id: 21, parent: 20, type: "RichText" }, { id: 22, parent: 20, type: "RichText" }])]);
    const view = scopes.get("ref-11-")!.focus.getEditor(21n)!;
    await act(() => view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(view.state.doc.childCount).toBe(2);
    expect(mutations.get(2n)!.insertBlock).not.toHaveBeenCalled();
    expect(document.querySelector("[data-source-block='22']")).toBeNull();
  });

  it("stops direct and indirect reference cycles without blocking reuse in sibling branches", async () => {
    await fixture([page(1, [ref(11, 10, 1), ref(12, 10, 2), ref(13, 10, 2)]), page(2, [ref(21, 20, 1)])]);
    expect([...document.querySelectorAll("[role='status']")].filter((el) => el.textContent?.includes("Circular reference"))).toHaveLength(3);
    expect(document.querySelectorAll("[data-reference-block]")).toHaveLength(5);
  });

  it("does not load a third reference level until explicitly expanded", async () => {
    const { subscriptions } = await fixture([page(1, [ref(11, 10, 2)]), page(2, [ref(21, 20, 3)]),
      page(3, [ref(31, 30, 4)]), page(4, [{ id: 41, parent: 40, type: "RichText" }])]);
    expect(subscriptions.has(4n)).toBe(false);
    await act(() => document.querySelector<HTMLButtonElement>("button[aria-label='Expand reference']")!.click());
    expect(subscriptions.has(4n)).toBe(true);
    expect(document.querySelector("[data-source-block='41'] .ProseMirror")?.textContent).toBe("Text 41");
  });

  it("shows a missing source after deletion and recovers when restored", async () => {
    const source = page(2, [{ id: 21, parent: 20, type: "RichText" }]);
    const { publish } = await fixture([page(1, [ref(11, 10, 2, 21)]), source]);
    await act(() => publish(2n, { ...source, byId: new Map() }));
    expect(document.querySelector("[role='status']")?.textContent).toContain("Source unavailable");
    expect(document.querySelector(".ProseMirror")).toBeNull();
    await act(() => publish(2n, source));
    expect(document.querySelector(".ProseMirror")?.textContent).toBe("Text 21");
  });

  it("renders readable sources without editing controls when source write access is absent", async () => {
    await fixture([page(1, [ref(11, 10, 2)]), page(2, [{ id: 21, parent: 20, type: "RichText" }])], true);
    const content = document.querySelector("[data-reference-content]")!;
    expect(content.textContent).toContain("Text 21");
    expect(content.querySelector(".ProseMirror")).toBeNull();
    expect(content.querySelector("[data-block-chrome]")).toBeNull();
    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    await act(() => content.querySelector("p")!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });

  it("selects source text independently of the containing surface", async () => {
    const { scopes } = await fixture([page(1, [ref(11, 10, 2), { id: 13, parent: 10, type: "RichText" }]),
      page(2, [{ id: 21, parent: 20, type: "RichText" }, { id: 22, parent: 20, type: "RichText" }])]);
    const outer = scopes.get("")!;
    await act(() => outer.selection.controller.selectMany([11n]));
    const source = scopes.get("ref-11-")!;
    const view = source.focus.getEditor(21n)!;
    await act(() => view.dom.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, cancelable: true })));
    expect(outer.selection.controller.getSnapshot()).toEqual([]);
    await act(() => view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true })));
    expect(source.selection.text.clipboard()?.text).toBe("Text 21\nText 22");
    expect(outer.selection.text.getSnapshot()).toBeNull();
  });
});

describe("reference targets", () => {
  it("preserves large IDs and rejects malformed persisted props", () => {
    expect(parseReferenceProps(referenceProps({ surfaceId: 18446744073709551615n, blockId: 9007199254740993n })))
      .toEqual({ surfaceId: 18446744073709551615n, blockId: 9007199254740993n });
    for (const value of ['{}', '{"surfaceId":2}', '{"surfaceId":"0"}', '{"surfaceId":"1","blockId":"x"}', 'null']) {
      expect(parseReferenceProps(value)).toBeNull();
    }
  });
  it("includes only the target subtree and rejects a source from a different page", () => {
    const tree = page(2, [{ id: 21, parent: 20, type: "Heading" }, { id: 22, parent: 21, type: "RichText" },
      { id: 23, parent: 20, type: "RichText" }]);
    const slice = referenceTree(tree, { surfaceId: 2n, blockId: 21n });
    expect([...slice.byId.keys()]).toEqual([21n, 22n]);
    expect(slice.root?.parentId).toBe(20n);
    expect(slice.byParent.has(20n)).toBe(false);
    expect(referenceTree(tree, { surfaceId: 3n, blockId: 21n }).root).toBeNull();
  });
});
