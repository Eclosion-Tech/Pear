import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { BlockEditor } from "../BlockEditor";
import { PulpProvider } from "../context/PulpProvider";
import { SurfaceFocusCoordinator } from "../focus/SurfaceFocusCoordinator";
import { SurfaceFocusProvider } from "../focus/SurfaceFocusProvider";
import { SurfaceUndoProvider } from "../undo/SurfaceUndoProvider";
import { SurfaceUndoCoordinator } from "../undo/SurfaceUndoCoordinator";
import { registerCoreBlocks } from "../registerCoreBlocks";
import { registerRenderer } from "../registry";
import { makeTree, createMockMutations } from "../test/fixtures";
import { richTextBlockToYjsBytes } from "./encode";
import { getSlashSession, slashPluginKey } from "./slashMenuPlugin";
import type { SlashMenuItem } from "../SlashMenu";

vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class { destroy() {} },
}));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | undefined;
const popup = () => document.querySelector<HTMLElement>(
  '[role="dialog"][aria-label="Insert block"]',
);
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function mountEditor(extraItems: SlashMenuItem[] = []) {
  registerCoreBlocks();
  registerRenderer("Container", ({ children }) => createElement("div", null, children));
  const coordinates = vi.spyOn(EditorView.prototype, "coordsAtPos")
    .mockReturnValue({ left: 10, right: 10, top: 10, bottom: 30 });
  const tree = makeTree([
    { id: 1, type: "Container", parent: null },
    { id: 2, type: "RichText", parent: 1 },
  ]);
  tree.yjs.set(2n, {
    componentNodeId: 2n,
    data: richTextBlockToYjsBytes("Existing content."),
  });
  const focus = new SurfaceFocusCoordinator();
  const mutations = createMockMutations();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(() => root!.render(createElement(PulpProvider, {
    tree, mutations,
    config: {
      idbPrefix: "slash-surface-regression",
      slashItems: [{
        id: "component", label: "New component", componentType: "TrellisPanel",
        description: "Build from scratch", defaultProps: { kind: "component" },
        searchTokens: ["component"],
      }, ...extraItems],
    },
    children: createElement(SurfaceFocusProvider, {
      coordinator: focus,
      children: createElement(SurfaceUndoProvider, {
        coordinator: new SurfaceUndoCoordinator(), children: createElement(BlockEditor),
      }),
    }),
  })));
  const view = focus.getApi().getEditor(2n)!;
  expect(view).toBeDefined();
  return { view, coordinates, mutations };
}
async function openMenu(view: EditorView) {
  await act(() => {
    view.dispatch(view.state.tr
      .insertText("Existing content.", 1, view.state.doc.content.size - 1)
      .setMeta(slashPluginKey, { type: "close" }));
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    view.focus();
  });
  for (const char of " /component") await act(() => {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, from, to, char, () => view.state.tr.insertText(char, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(char));
  });
  expect(getSlashSession(view.state)?.query).toBe("component");
  expect(popup()).not.toBeNull();
}

it("opens the mounted popup through both input-handler and native DOM-observer dispatch", async () => {
  const { view } = await mountEditor();
  await openMenu(view);
  await act(() => {
    view.dispatch(view.state.tr
      .insertText("Existing content.", 1, view.state.doc.content.size - 1)
      .setMeta(slashPluginKey, { type: "close" }));
    view.focus();
  });
  await act(() => {
    const node = view.dom.querySelector("p")!.firstChild!;
    node.textContent += " /component";
    window.getSelection()!.collapse(node, node.textContent!.length);
    (view as unknown as { domObserver: { flush(): void } }).domObserver.flush();
  });
  expect(view.state.doc.textContent).toBe("Existing content. /component");
  expect(getSlashSession(view.state)?.query).toBe("component");
  expect(popup()).not.toBeNull();
});

it("follows the caret through document and ancestor scrolling and resize, then inserts at that slot", async () => {
  const { view, coordinates, mutations } = await mountEditor();
  await openMenu(view);
  const selection = view.state.selection.from;
  coordinates.mockReturnValue({ left: 50, right: 50, top: 80, bottom: 100 });
  await act(() => document.dispatchEvent(new Event("scroll")));
  expect(getSlashSession(view.state)?.query, "caret scroll retains the command").toBe("component");
  expect(popup()?.style.top).toBe("104px");
  expect(popup()?.style.left).toBe("50px");
  expect(view.state.selection.from).toBe(selection);

  coordinates.mockReturnValue({ left: 60, right: 60, top: 90, bottom: 110 });
  await act(() => view.dom.parentElement!.dispatchEvent(new Event("scroll")));
  expect(popup()?.style.top).toBe("114px");
  coordinates.mockReturnValue({ left: 70, right: 70, top: 100, bottom: 120 });
  await act(() => window.dispatchEvent(new Event("resize")));
  expect(popup()?.style.top).toBe("124px");
  await act(() => popup()!.dispatchEvent(new Event("scroll")));
  expect(getSlashSession(view.state)?.query).toBe("component");

  await act(() => popup()!.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(mutations.calls.insertBlock).toEqual([{
    parentId: 1n, afterSiblingId: 2n,
    componentType: "TrellisPanel", propsJson: '{"kind":"component"}',
  }]);
  expect(view.state.doc.textContent).toBe("Existing content. ");
  expect(popup()).toBeNull();
});

it("still dismisses on Escape, outside pointer input, or an anchor scrolled out of view", async () => {
  const { view, coordinates } = await mountEditor();
  await openMenu(view);
  await act(() => view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(popup()).toBeNull();
  await openMenu(view);
  await act(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(popup()).toBeNull();
  await openMenu(view);
  coordinates.mockReturnValue({ left: 10, right: 10, top: -30, bottom: -10 });
  await act(() => document.dispatchEvent(new Event("scroll")));
  expect(popup()).toBeNull();
  expect(getSlashSession(view.state)).toBeNull();
});

it("opens Browse all as a fresh session after committing an insertion at the same cursor", async () => {
  const choose = vi.fn();
  const { view, mutations } = await mountEditor([{
    id: "browse", label: "Browse all components", description: "Choose a template",
    componentType: "TrellisPanel", defaultProps: {}, searchTokens: ["browse"], choose,
  }]);
  await openMenu(view);
  await act(() => popup()!.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(getSlashSession(view.state)).toBeNull();
  for (const char of " /browse") await act(() => {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", fn =>
      fn(view, from, to, char, () => view.state.tr.insertText(char, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(char));
  });
  expect(getSlashSession(view.state)?.query).toBe("browse");
  await act(() => popup()!.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(choose).toHaveBeenCalledTimes(1);
  expect(getSlashSession(view.state)).toBeNull();
  expect(view.state.doc.textContent).toBe("Existing content.  ");
  expect(mutations.calls.insertBlock).toHaveLength(1);
});
