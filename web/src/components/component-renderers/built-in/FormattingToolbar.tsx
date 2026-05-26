"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "prosemirror-view";
import type { MarkType } from "prosemirror-model";
import { toggleMark } from "prosemirror-commands";
import { richTextSchema } from "@/src/lib/richTextSchema";

/**
 * Floating bubble menu rendered above the user's selection inside a
 * `<RichTextEditor>`. Surfaces inline mark toggles (bold / italic /
 * underline / strike / code / link).
 *
 * Sprint-2 minimum-viable formatting affordance — the keyboard shortcuts
 * (Cmd-B/I/U/Shift-S/Cmd-`) work without this toolbar, but discovery is
 * miserable without it. Sprint 3's block-chrome / slash-menu work can
 * absorb this component or replace it with a richer surface; for now it's
 * a self-contained portal that listens to the editor view's selection.
 *
 * Positioning strategy: read `window.getSelection().getRangeAt(0)
 * .getBoundingClientRect()` whenever the editor selection changes and
 * place the toolbar centred above it. No external positioning library —
 * `tippy.js` or `@floating-ui/react` are post-v1 escalations if the
 * placement heuristics get hairy.
 */
export function FormattingToolbar({ view }: { view: EditorView | null }) {
  const [coords, setCoords] = useState<
    | {
        top: number;
        left: number;
        marks: Record<string, boolean>;
      }
    | null
  >(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!view) return;

    const compute = () => {
      const state = view.state;
      const { from, to, empty } = state.selection;
      if (empty || !view.hasFocus()) {
        setCoords(null);
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        setCoords(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setCoords(null);
        return;
      }

      const marks: Record<string, boolean> = {};
      for (const name of MARK_ORDER) {
        const markType = richTextSchema.marks[name];
        if (markType) marks[name] = markActive(state, markType, from, to);
      }

      setCoords({
        top: rect.top + window.scrollY - 44,
        left: rect.left + rect.width / 2 + window.scrollX,
        marks,
      });
    };

    // ProseMirror fires its own selection events; piggyback DOM
    // selectionchange to catch native shifts (e.g. arrow keys held).
    const onSelectionChange = () => {
      // Defer to next frame so prosemirror's view has settled.
      requestAnimationFrame(compute);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    compute();
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [view]);

  if (!coords || !view) return null;

  return createPortal(
    <div
      ref={toolbarRef}
      style={{ top: coords.top, left: coords.left, transform: "translateX(-50%)" }}
      className="fixed z-50 flex items-center gap-0.5 rounded-md border
                 border-neutral-200 dark:border-neutral-700
                 bg-white dark:bg-neutral-900 px-1 py-1 shadow-lg"
      // Prevent mousedown from collapsing the prosemirror selection before
      // the toggle command runs. ProseMirror's selection lives in DOM
      // focus + an internal state; clicking the toolbar's host would blur
      // the editor and leave us with no selection to act on.
      onMouseDown={(e) => e.preventDefault()}
    >
      {MARK_ORDER.map((name) => (
        <ToolbarButton
          key={name}
          label={MARK_LABEL[name]}
          shortcut={MARK_SHORTCUT[name]}
          active={coords.marks[name] ?? false}
          onClick={() => {
            const markType = richTextSchema.marks[name];
            if (!markType) return;
            toggleMark(markType)(view.state, view.dispatch);
            view.focus();
          }}
        />
      ))}
    </div>,
    document.body,
  );
}

const MARK_ORDER = ["bold", "italic", "underline", "strike", "code"] as const;
const MARK_LABEL: Record<(typeof MARK_ORDER)[number], string> = {
  bold: "B",
  italic: "I",
  underline: "U",
  strike: "S",
  code: "</>",
};
const MARK_SHORTCUT: Record<(typeof MARK_ORDER)[number], string> = {
  bold: "⌘B",
  italic: "⌘I",
  underline: "⌘U",
  strike: "⌘⇧S",
  code: "⌘`",
};

function ToolbarButton({
  label,
  shortcut,
  active,
  onClick,
}: {
  label: string;
  shortcut: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={shortcut}
      className={`min-w-[28px] rounded px-1.5 py-1 text-xs font-medium
                  transition-colors
                  ${
                    active
                      ? "bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-white"
                      : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  }`}
    >
      <span
        className={
          label === "B"
            ? "font-bold"
            : label === "I"
              ? "italic"
              : label === "U"
                ? "underline"
                : label === "S"
                  ? "line-through"
                  : "font-mono"
        }
      >
        {label}
      </span>
    </button>
  );
}

/**
 * Walks the selected range to determine whether every text node in it has
 * the given mark — that's the "active" state for the toolbar button.
 */
function markActive(
  state: import("prosemirror-state").EditorState,
  markType: MarkType,
  from: number,
  to: number,
): boolean {
  if (from === to) {
    return Boolean(markType.isInSet(state.storedMarks ?? state.selection.$from.marks()));
  }
  let has = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText && markType.isInSet(node.marks)) {
      has = true;
      return false;
    }
    return undefined;
  });
  return has;
}
