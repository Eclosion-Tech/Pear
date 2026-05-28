import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { isAtDocEnd, isAtDocStart } from "../navigation/blockNavigation";

export type EditorSurfaceMode =
  | { kind: "body"; textDensity?: "default" | "listItem" }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 };

export type RichTextKeymapHandlers = {
  onSplit?: (view: EditorView) => boolean;
  onDeleteSelf?: () => void;
  onMergeWithPrev?: (view: EditorView) => boolean;
  onNavigatePrev?: () => boolean;
  onNavigateNext?: () => boolean;
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
  handlers: RichTextKeymapHandlers,
): boolean {
  if (!state.selection.empty) return false;
  const docEnd = state.doc.content.size;
  if (!isAtDocStart(docEnd, state.selection.head)) return false;
  return handlers.onNavigatePrev?.() ?? false;
}

export function handleRichTextArrowDown(
  state: EditorState,
  handlers: RichTextKeymapHandlers,
): boolean {
  if (!state.selection.empty) return false;
  const docEnd = state.doc.content.size;
  if (!isAtDocEnd(docEnd, state.selection.head)) return false;
  return handlers.onNavigateNext?.() ?? false;
}

export function handleRichTextTab(handlers: RichTextKeymapHandlers): boolean {
  if (!handlers.onIndent) return false;
  return handlers.onIndent();
}

export function handleRichTextShiftTab(handlers: RichTextKeymapHandlers): boolean {
  if (!handlers.onOutdent) return false;
  return handlers.onOutdent();
}

/** True when inline mark keyboard shortcuts should be suppressed. */
export function inlineMarksDisabled(surfaceMode: EditorSurfaceMode): boolean {
  return surfaceMode.kind === "heading";
}
