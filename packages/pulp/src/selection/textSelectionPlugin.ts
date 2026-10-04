import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { BlockId } from "../types";
import type { SurfaceTextSelection } from "./SurfaceTextSelection";

/** Visual character ranges independent of the browser's single editing host. */
export function textSelectionPlugin(id: BlockId, selection: SurfaceTextSelection | undefined): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const range = selection?.rangeIn(id, state.doc.content.size - 1);
        if (!range || range.from === range.to) return null;
        return DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, {
          "data-text-selected": "true",
          style: "background-color: Highlight; color: HighlightText;",
        })]);
      },
      attributes: (): Record<string, string> => selection?.getSnapshot() ? { style: "caret-color: transparent" } : {},
    },
    view(view) {
      const unsubscribe = selection?.subscribe(() => {
        view.dispatch(view.state.tr.setMeta("surface-text-selection", true));
      });
      return { destroy: () => unsubscribe?.() };
    },
  });
}
