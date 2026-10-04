import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { BlockEditor } from "../BlockEditor";
import { PulpProvider } from "../context/PulpProvider";
import { registerRenderer, type BlockRendererProps } from "../registry";
import { makeTree, createMockMutations } from "../test/fixtures";
import { richTextSchema as schema } from "../rich-text/richTextSchema";
import { useSurfaceSelection, type SurfaceSelectionValue } from "./SurfaceSelectionProvider";
import { textSelectionPlugin } from "./textSelectionPlugin";

let root: Root | undefined;
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; document.body.innerHTML = ""; });

async function fixture() {
  const views = new Map<bigint, EditorView>();
  let selection: SurfaceSelectionValue;
  const content = ["Alpha bravo", "Middle words", "Charlie delta"];
  const tree = makeTree([{ id: 1, type: "Container", parent: null },
    ...[2, 3, 4].map((id) => ({ id, type: "RichText", parent: 1 }))]);
  for (const type of ["Heading", "BulletListItem", "NumberedListItem"]) tree.defs.delete(type);
  function Text({ node }: BlockRendererProps) {
    selection = useSurfaceSelection();
    const text = selection.text;
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const value = content[Number(node.id) - 2];
      const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text(value))]);
      const view = new EditorView(ref.current!, {
        state: EditorState.create({ schema, doc, plugins: [textSelectionPlugin(node.id, text)] }),
        dispatchTransaction(this: EditorView, tr) { this.updateState(this.state.apply(tr)); text.onTransaction(node.id, tr); },
        handleScrollToSelection: () => true,
      });
      const y = 20 + (Number(node.id) - 2) * 40;
      vi.spyOn(view.dom, "getBoundingClientRect").mockReturnValue(new DOMRect(100, y, 300, 20));
      vi.spyOn(view, "posAtCoords").mockImplementation(({ left }) => ({ pos: Math.min(value.length + 1, Math.max(1, Math.round((left - 100) / 10) + 1)), inside: 0 }));
      vi.spyOn(view, "coordsAtPos").mockImplementation((pos) => ({ left: 100 + (pos - 1) * 10, right: 100 + (pos - 1) * 10, top: y, bottom: y + 20 }));
      const unregister = text.register(node.id, view);
      views.set(node.id, view);
      return () => { unregister(); views.delete(node.id); view.destroy(); };
    }, [node.id, text]);
    return createElement("div", { "data-text-block": String(node.id), ref });
  }
  registerRenderer("Container", ({ children }) => createElement("div", null, children));
  registerRenderer("RichText", Text);
  const mount = document.body.appendChild(document.createElement("div"));
  root = createRoot(mount);
  const mutations = createMockMutations();
  await act(() => root!.render(createElement(PulpProvider, {
    tree, config: { idbPrefix: "selection-test" }, mutations, children: createElement(BlockEditor),
  })));
  for (const id of [2n, 3n, 4n]) {
    const wrapper = mount.querySelector<HTMLElement>(`#block-${id}`)!;
    vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 20 + (Number(id) - 2) * 40, 300, 20));
  }
  const surface = mount.querySelector<HTMLElement>("[data-selection-surface]")!;
  const drag = async (target: Element, ax: number, ay: number, hx: number, hy: number) => {
    await pointer(target, "pointerdown", ax, ay);
    await pointer(window, "pointermove", hx, hy);
    await pointer(window, "pointerup", hx, hy);
  };
  return { views, getSelection: () => selection!, surface, drag, mutations };
}

async function pointer(target: EventTarget, type: string, x: number, y: number) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
      pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }));
  });
}

describe("selection gesture origin", () => {
  it.each([false, true])("keeps partial text selected across blocks on release (backward=%s)", async (backwards) => {
    const { views, drag, getSelection } = await fixture();
    const view = views.get(backwards ? 4n : 2n)!;
    await act(() => view.focus());
    await drag(view.dom, backwards ? 140 : 120, backwards ? 110 : 30, backwards ? 120 : 140, backwards ? 30 : 110);
    expect(getSelection().selectedIds).toEqual([]);
    expect(getSelection().text.clipboard()?.text).toBe("pha bravo\nMiddle words\nChar");
    expect(document.querySelectorAll("[data-text-selected]")).toHaveLength(3);
    const data = new DataTransfer();
    const copy = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data });
    await act(() => view.dom.dispatchEvent(copy));
    expect(copy.defaultPrevented).toBe(true);
    expect(data.getData("text/plain")).toBe("pha bravo\nMiddle words\nChar");
  });

  it("keeps a text-origin drag in text mode when the pointer leaves the text column", async () => {
    const { views, drag, getSelection } = await fixture();
    await drag(views.get(2n)!.dom, 120, 30, 50, 110);
    expect(getSelection().selectedIds).toEqual([]);
    expect(getSelection().text.clipboard()?.text).toBe("pha bravo\nMiddle words\n");
  });

  it("selects whole blocks when dragging from the margin into text", async () => {
    const { views, surface, drag, getSelection, mutations } = await fixture();
    await act(() => views.get(2n)!.focus());
    await drag(surface, 70, 10, 200, 75);
    expect(getSelection().selectedIds).toEqual([2n, 3n]);
    expect(getSelection().textRange).toBeNull();
    expect(document.querySelectorAll("[data-text-selected]")).toHaveLength(0);
    await act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
    expect(mutations.calls.deleteBlock).toEqual([{ componentId: 2n }, { componentId: 3n }]);
  });

  it("treats padding inside the text body as text, and tiny margin movement as a click", async () => {
    const { views, surface, drag, getSelection } = await fixture();
    await drag(views.get(2n)!.dom.parentElement!, 120, 30, 140, 110);
    expect(getSelection().textRange).not.toBeNull();
    expect(getSelection().selectedIds).toEqual([]);
    await drag(surface, 70, 10, 71, 11);
    expect(getSelection().selectedIds).toEqual([]);
    expect(getSelection().textRange).toBeNull();
  });

  it("does not intercept typing or clipboard events in unrelated inputs", async () => {
    const { views, drag, getSelection } = await fixture();
    await drag(views.get(2n)!.dom, 120, 30, 140, 110);
    const input = document.body.appendChild(document.createElement("textarea"));
    const event = new InputEvent("beforeinput", { data: "X", inputType: "insertText", bubbles: true, cancelable: true });
    await act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(views.get(2n)!.state.doc.textContent).toBe("Alpha bravo");
    await pointer(input, "pointerdown", 0, 0);
    expect(getSelection().textRange).toBeNull();
  });

  it("selects all text bodies with the platform shortcut, then collapses to a caret", async () => {
    const { views, drag, getSelection } = await fixture();
    const first = views.get(2n)!;
    await act(() => first.focus());
    await drag(first.dom, 120, 30, 140, 110);
    const all = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true });
    await act(() => first.dom.dispatchEvent(all));
    expect(all.defaultPrevented).toBe(true);
    expect(getSelection().text.clipboard()?.text).toBe("Alpha bravo\nMiddle words\nCharlie delta");
    await act(() => first.dom.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight", bubbles: true, cancelable: true,
    })));
    expect(getSelection().textRange).toBeNull();
    const last = views.get(4n)!;
    expect(last.hasFocus()).toBe(true);
    expect(last.state.selection.head).toBe(last.state.doc.content.size - 1);
  });

  it("leaves embedded form controls alone even while a text range is active", async () => {
    const { views, drag, surface, getSelection } = await fixture();
    await drag(views.get(2n)!.dom, 120, 30, 140, 110);
    const input = surface.appendChild(document.createElement("textarea"));
    const key = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    const typing = new InputEvent("beforeinput", { data: "X", inputType: "insertText", bubbles: true, cancelable: true });
    await act(() => { input.dispatchEvent(key); input.dispatchEvent(typing); });
    expect(key.defaultPrevented).toBe(false);
    expect(typing.defaultPrevented).toBe(false);
    expect(getSelection().text.clipboard()?.text).toBe("pha bravo\nMiddle words\nChar");
    expect(views.get(2n)!.state.doc.textContent).toBe("Alpha bravo");
  });

  it("preserves native touch scrolling instead of starting text or block drags", async () => {
    const { views, surface, getSelection } = await fixture();
    for (const target of [views.get(2n)!.dom, surface]) {
      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true,
        pointerType: "touch", pointerId: 1, button: 0, buttons: 1, clientX: 120, clientY: 30 });
      await act(() => target.dispatchEvent(down));
      await pointer(window, "pointermove", 140, 110);
      await pointer(window, "pointerup", 140, 110);
      expect(down.defaultPrevented).toBe(false);
      expect(getSelection().selectedIds).toEqual([]);
      expect(getSelection().textRange).toBeNull();
    }
  });
});
