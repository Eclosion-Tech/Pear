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
  const linkEditorOpenRef = useRef(false);
  linkEditorOpenRef.current = linkEditor != null;

  useEffect(() => {
    if (!view) return;

    const compute = () => {
      if (linkEditorOpenRef.current) return;

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
      if (!selectionBelongsTo(selection, view.dom)) {
        setCoords(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setCoords(null);
        return;
      }
      const placeBelow =
        rect.top < TOOLBAR_ESTIMATED_HEIGHT + TOOLBAR_SELECTION_GAP;

      const marks: Record<string, boolean> = {};
      for (const name of MARK_ORDER) {
        const markType = richTextSchema.marks[name];
        if (markType) marks[name] = markActive(state, markType, from, to);
      }

      setCoords({
        top: placeBelow
          ? rect.bottom + TOOLBAR_SELECTION_GAP
          : rect.top - TOOLBAR_ESTIMATED_HEIGHT - TOOLBAR_SELECTION_GAP,
        left: rect.left + rect.width / 2,
        marks,
      });
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
      {linkEditor && (
        <LinkEditorPopover
          state={linkEditor}
          view={view}
          targets={config.linkTargets ?? []}
          onClose={() => setLinkEditor(null)}
        />
      )}
    </div>,
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

  const rect = selectionRect();
  if (!rect) return null;

  return {
    top: rect.bottom + 8,
    left: rect.left + rect.width / 2,
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

function selectionRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return rect;
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
