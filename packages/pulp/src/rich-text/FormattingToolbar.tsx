"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "prosemirror-view";
import type { MarkType } from "prosemirror-model";
import { toggleMark } from "prosemirror-commands";
import { usePulp } from "../context/PulpProvider";
import { richTextSchema } from "./richTextSchema";

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
type LinkEditorState = {
  top: number;
  left: number;
  from: number;
  to: number;
  href: string;
};

const TOOLBAR_ESTIMATED_HEIGHT = 40;
const TOOLBAR_SELECTION_GAP = 8;
const LINK_POPOVER_ESTIMATED_HEIGHT = 300;
const LINK_POPOVER_WIDTH = 320;
const LINK_POPOVER_SELECTION_GAP = 8;
const VIEWPORT_EDGE_PADDING = 8;

export function FormattingToolbar({
  view,
  linkRequest,
}: {
  view: EditorView | null;
  linkRequest?: number;
}) {
  const { config } = usePulp();
  const [coords, setCoords] = useState<
    | {
        top: number;
        left: number;
        marks: Record<string, boolean>;
      }
    | null
  >(null);
  const [linkEditor, setLinkEditor] = useState<LinkEditorState | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const linkEditorRef = useRef<LinkEditorState | null>(null);
  linkEditorRef.current = linkEditor;

  useEffect(() => {
    if (!view) return;

    const compute = () => {
      const state = view.state;
      const { from, to, empty } = state.selection;
      const openLinkEditor = linkEditorRef.current;
      if ((empty && !openLinkEditor) || (!view.hasFocus() && !openLinkEditor)) {
        setCoords(null);
        return;
      }

      const anchorFrom = openLinkEditor?.from ?? from;
      const anchorTo = openLinkEditor?.to ?? to;
      const rect = selectionRect(view, anchorFrom, anchorTo);
      if (!rect) {
        setCoords(null);
        return;
      }
      const placeBelow =
        rect.top < TOOLBAR_ESTIMATED_HEIGHT + TOOLBAR_SELECTION_GAP;

      const marks: Record<string, boolean> = {};
      for (const name of MARK_ORDER) {
        const markType = richTextSchema.marks[name];
        if (markType) marks[name] = markActive(state, markType, anchorFrom, anchorTo);
      }

      setCoords({
        top: placeBelow
          ? rect.bottom + TOOLBAR_SELECTION_GAP
          : rect.top - TOOLBAR_ESTIMATED_HEIGHT - TOOLBAR_SELECTION_GAP,
        left: rect.left + rect.width / 2,
        marks,
      });

      if (openLinkEditor) {
        const position = linkEditorPosition(rect);
        setLinkEditor((prev) =>
          prev
            ? {
                ...prev,
                top: position.top,
                left: position.left,
              }
            : prev,
        );
      }
    };

    // ProseMirror fires its own selection events; piggyback DOM
    // selectionchange to catch native shifts (e.g. arrow keys held).
    // Scroll is included because Pear documents scroll inside app
    // containers, not always through `window`.
    let frame: number | null = null;
    const scheduleCompute = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        compute();
      });
    };
    document.addEventListener("selectionchange", scheduleCompute);
    document.addEventListener("scroll", scheduleCompute, true);
    window.addEventListener("scroll", scheduleCompute, true);
    compute();
    return () => {
      document.removeEventListener("selectionchange", scheduleCompute);
      document.removeEventListener("scroll", scheduleCompute, true);
      window.removeEventListener("scroll", scheduleCompute, true);
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [view]);

  useEffect(() => {
    if (!view || !linkRequest) return;
    const next = buildLinkEditorState(view);
    if (next) setLinkEditor(next);
  }, [linkRequest, view]);

  if (!coords || !view) return null;

  return createPortal(
    <>
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
              if (name === "link") {
                const next = buildLinkEditorState(view);
                if (next) setLinkEditor(next);
                return;
              }
              const markType = richTextSchema.marks[name];
              if (!markType) return;
              toggleMark(markType)(view.state, view.dispatch);
              view.focus();
            }}
          />
        ))}
      </div>
      {linkEditor && (
        <LinkEditorPopover
          state={linkEditor}
          view={view}
          targets={config.linkTargets ?? []}
          onClose={() => setLinkEditor(null)}
        />
      )}
    </>,
    document.body,
  );
}

const MARK_ORDER = ["bold", "italic", "underline", "strike", "code", "link"] as const;
const MARK_LABEL: Record<(typeof MARK_ORDER)[number], string> = {
  bold: "B",
  italic: "I",
  underline: "U",
  strike: "S",
  code: "</>",
  link: "Link",
};
const MARK_SHORTCUT: Record<(typeof MARK_ORDER)[number], string> = {
  bold: "⌘B",
  italic: "⌘I",
  underline: "⌘U",
  strike: "⌘⇧S",
  code: "⌘`",
  link: "⌘K",
};

function applyHrefToRange(
  view: EditorView,
  from: number,
  to: number,
  rawHref: string,
): boolean {
  const markType = richTextSchema.marks.link;
  if (!markType) return false;

  const { state } = view;
  if (from === to) return false;

  const href = normalizeHref(rawHref);
  let tr = state.tr.removeMark(from, to, markType);
  if (href) {
    tr = tr.addMark(from, to, markType.create({ href }));
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

function buildLinkEditorState(view: EditorView): LinkEditorState | null {
  const { state } = view;
  const { from, to, empty } = state.selection;
  if (empty) return null;

  const rect = selectionRect(view, from, to);
  if (!rect) return null;
  const position = linkEditorPosition(rect);

  return {
    top: position.top,
    left: position.left,
    from,
    to,
    href: getLinkHref(state, richTextSchema.marks.link, from, to) ?? "",
  };
}

function LinkEditorPopover({
  state,
  view,
  targets,
  onClose,
}: {
  state: LinkEditorState;
  view: EditorView;
  targets: NonNullable<import("../types").PulpConfig["linkTargets"]>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(state.href);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filteredTargets = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return targets.slice(0, 6);
    return targets
      .filter((target) => {
        return (
          target.label.toLowerCase().includes(q) ||
          target.href.toLowerCase().includes(q) ||
          (target.subtitle ?? "").toLowerCase().includes(q)
        );
      })
      .slice(0, 6);
  }, [targets, value]);

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  function apply(rawHref = value) {
    applyHrefToRange(view, state.from, state.to, rawHref);
    onClose();
  }

  return (
    <div
      style={{ top: state.top, left: state.left, transform: "translateX(-50%)" }}
      className="fixed z-[60] w-[320px] overflow-hidden rounded-md border border-neutral-200 bg-white text-left shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="border-b border-neutral-100 p-2 dark:border-neutral-800">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
              view.focus();
            }
          }}
          placeholder="Paste a URL or search pages..."
          className="w-full rounded border border-neutral-200 bg-transparent px-2 py-1.5 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 dark:border-neutral-700 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
      </div>

      <div className="max-h-56 overflow-y-auto py-1">
        {filteredTargets.map((target) => (
          <button
            key={target.id}
            type="button"
            onClick={() => apply(target.href)}
            className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <span className="truncate text-sm text-neutral-900 dark:text-neutral-100">
              {target.label}
            </span>
            <span className="truncate text-xs text-neutral-400 dark:text-neutral-500">
              {target.subtitle || target.href}
            </span>
          </button>
        ))}
        {filteredTargets.length === 0 && (
          <div className="px-3 py-3 text-xs text-neutral-400 dark:text-neutral-500">
            No matching pages
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-neutral-100 px-2 py-2 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => apply("")}
          className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-red-500 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          Remove
        </button>
        <button
          type="button"
          onClick={() => apply()}
          className="rounded bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

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
                  : label === "</>"
                    ? "font-mono"
                    : ""
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

function getLinkHref(
  state: import("prosemirror-state").EditorState,
  markType: MarkType,
  from: number,
  to: number,
): string | null {
  let href: string | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return undefined;
    const mark = markType.isInSet(node.marks);
    if (!mark) return undefined;
    href = typeof mark.attrs.href === "string" ? mark.attrs.href : "";
    return false;
  });
  return href;
}

function normalizeHref(raw: string): string {
  const href = raw.trim();
  if (!href) return "";
  if (
    href.startsWith("/") ||
    href.startsWith("#") ||
    /^[a-z][a-z0-9+.-]*:/i.test(href)
  ) {
    return href;
  }
  return `https://${href}`;
}

function selectionRect(view: EditorView, from: number, to: number): DOMRect | null {
  const selection = window.getSelection();
  if (
    selection &&
    selection.rangeCount > 0 &&
    selectionBelongsTo(selection, view.dom)
  ) {
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (usableRect(rect)) return rect;
  }
  return editorRangeRect(view, from, to);
}

function editorRangeRect(view: EditorView, from: number, to: number): DOMRect | null {
  try {
    if (from === to) {
      const coords = view.coordsAtPos(from);
      return new DOMRect(
        coords.left,
        coords.top,
        0,
        Math.max(1, coords.bottom - coords.top),
      );
    }

    const start = view.domAtPos(from);
    const end = view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);

    const rects = Array.from(range.getClientRects()).filter(usableRect);
    const rect = rects.length > 0 ? boundingRect(rects) : range.getBoundingClientRect();
    if (usableRect(rect)) return rect;
  } catch {
    // Fall through to coordsAtPos below. ProseMirror can throw here while
    // a remote Yjs update is replacing the same DOM span we are anchoring.
  }

  try {
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    const left = Math.min(start.left, end.left);
    const right = Math.max(start.right, end.right, left + 1);
    const top = Math.min(start.top, end.top);
    const bottom = Math.max(start.bottom, end.bottom, top + 1);
    return new DOMRect(left, top, right - left, bottom - top);
  } catch {
    return null;
  }
}

function boundingRect(rects: DOMRect[]): DOMRect {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  return new DOMRect(left, top, right - left, bottom - top);
}

function usableRect(rect: DOMRect): boolean {
  return rect.width > 0 || rect.height > 0;
}

function linkEditorPosition(rect: DOMRect): { top: number; left: number } {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 768;
  const halfWidth = LINK_POPOVER_WIDTH / 2;
  const minLeft = halfWidth + VIEWPORT_EDGE_PADDING;
  const maxLeft = Math.max(minLeft, viewportWidth - halfWidth - VIEWPORT_EDGE_PADDING);
  const left = clamp(rect.left + rect.width / 2, minLeft, maxLeft);

  let top = rect.bottom + LINK_POPOVER_SELECTION_GAP;
  const wouldOverflow =
    top + LINK_POPOVER_ESTIMATED_HEIGHT > viewportHeight - VIEWPORT_EDGE_PADDING;
  if (
    wouldOverflow &&
    rect.top > LINK_POPOVER_ESTIMATED_HEIGHT + LINK_POPOVER_SELECTION_GAP
  ) {
    top = rect.top - LINK_POPOVER_ESTIMATED_HEIGHT - LINK_POPOVER_SELECTION_GAP;
  }
  return { top: Math.max(VIEWPORT_EDGE_PADDING, top), left };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function selectionBelongsTo(selection: Selection, root: Node): boolean {
  const { anchorNode, focusNode } = selection;
  return (
    anchorNode != null &&
    focusNode != null &&
    root.contains(anchorNode) &&
    root.contains(focusNode)
  );
}
