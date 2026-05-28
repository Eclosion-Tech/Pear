import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

export type EditorSurfaceMode =
  | { kind: "body"; textDensity?: "default" | "listItem" }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 };

export type RichTextKeymapHandlers = {
  onSplit?: (view: EditorView) => boolean;
  onDeleteSelf?: () => void;
  onMergeWithPrev?: (view: EditorView) => boolean;
  /** ArrowUp at visual doc start — caller focuses the previous block. `goalX` is the caret's screen x for column preservation. */
  onNavigatePrev?: (goalX?: number) => boolean;
  /** ArrowDown at visual doc end — caller focuses the next block. */
  onNavigateNext?: (goalX?: number) => boolean;
  onIndent?: () => boolean;
  onOutdent?: () => boolean;
};

/** Enter — structural split / heading exit. Returns true when claimed. */
export function handleRichTextEnter(
  state: EditorState,
  view: EditorView | null,
  handlers: RichTextKeymapHandlers,
): boolean {
  if (!state.selection.empty) return false;
  if (!view || !handlers.onSplit) return false;
  return handlers.onSplit(view);
}

/** Backspace at doc start — delete empty block or merge with previous. */
export function handleRichTextBackspace(
  state: EditorState,
  view: EditorView | null,
  handlers: RichTextKeymapHandlers,
): boolean {
  if (!state.selection.empty) return false;
  const atStart = state.selection.$head.pos === 1;
  if (!atStart || !view) return false;

  const isEmpty = state.doc.textContent.length === 0;
  if (isEmpty) {
    if (!handlers.onDeleteSelf) return false;
    handlers.onDeleteSelf();
    return true;
  }

  if (!handlers.onMergeWithPrev) return false;
  return handlers.onMergeWithPrev(view);
}

export function handleRichTextArrowUp(
  state: EditorState,
  view: EditorView | null,
  handlers: RichTextKeymapHandlers,
): boolean {
  if (!state.selection.empty) return false;
  if (!atVisualDocStart(state, view)) return false;
  return handlers.onNavigatePrev?.(caretX(view)) ?? false;
}

export function handleRichTextArrowDown(
  state: EditorState,
  view: EditorView | null,
  handlers: RichTextKeymapHandlers,
): boolean {
  if (!state.selection.empty) return false;
  if (!atVisualDocEnd(state, view)) return false;
  return handlers.onNavigateNext?.(caretX(view)) ?? false;
}

/**
 * True when the caret is on the **first visual line of the first block** —
 * the point where ArrowUp should cross to the previous block (not move within
 * a wrapped/multi-paragraph doc). Uses `view.endOfTextblock` for visual-line
 * detection, falling back to doc-start position when no live view is available
 * (unit tests / static).
 */
function atVisualDocStart(state: EditorState, view: EditorView | null): boolean {
  if (state.selection.$head.index(0) !== 0) return false;
  if (view && typeof view.endOfTextblock === "function") {
    try {
      return view.endOfTextblock("up", state);
    } catch {
      /* fall through to position heuristic */
    }
  }
  return state.selection.head <= 1;
}

/** True when the caret is on the last visual line of the last block. */
function atVisualDocEnd(state: EditorState, view: EditorView | null): boolean {
  if (state.selection.$head.index(0) !== state.doc.childCount - 1) return false;
  if (view && typeof view.endOfTextblock === "function") {
    try {
      return view.endOfTextblock("down", state);
    } catch {
      /* fall through */
    }
  }
  return state.selection.head >= state.doc.content.size - 1;
}

/** Caret's screen-x for goal-column preservation; undefined without layout. */
function caretX(view: EditorView | null): number | undefined {
  if (!view || typeof view.coordsAtPos !== "function") return undefined;
  try {
    return view.coordsAtPos(view.state.selection.head).left;
  } catch {
    return undefined;
  }
}

/** Tab — block-level nest. Always consumes the key when wired (any caret position). */
export function handleRichTextTab(handlers: RichTextKeymapHandlers): boolean {
  if (!handlers.onIndent) return false;
  handlers.onIndent();
  return true;
}

/** Shift+Tab — block-level unnest. Always consumes the key when wired. */
export function handleRichTextShiftTab(handlers: RichTextKeymapHandlers): boolean {
  if (!handlers.onOutdent) return false;
  handlers.onOutdent();
  return true;
}

/** True when inline mark keyboard shortcuts should be suppressed. */
export function inlineMarksDisabled(surfaceMode: EditorSurfaceMode): boolean {
  return surfaceMode.kind === "heading";
}
