"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  useInsertComponent,
  useUpdateComponentProps,
} from "@/src/hooks/usePages";
import { useSurfaceFocus } from "@/src/hooks/useSurfaceFocus";
import type { ComponentRendererProps } from "../registry";

/**
 * Built-in `Heading` component — inline-editable contenteditable.
 *
 * Prop schema (`prop_schemas::HEADING` in components.rs):
 *   { level: integer 1..6 (required),
 *     text: string (required) }
 *
 * Heading is not Yjs-backed at v1 — the title text lives on
 * `ComponentNode.props.text` and edits go through `update_component_props`
 * directly (no per-character collab). This matches the substrate's
 * `has_yjs_state: false` for Heading; co-editing headings can be promoted
 * later by flipping that flag and migrating the text into a Y.Doc.
 *
 * **Editing model — why contenteditable, not `<input>`.** A plain input
 * would single-line clamp the heading and force a fixed font-size scale.
 * `contentEditable="plaintext-only"` keeps the styled `<h1>`/`<h2>`/...
 * shell intact and lets the text inherit the size class, while still
 * blocking inline formatting (no bold/italic/links inside a heading at
 * v1 — matches Notion/BlockNote). React can't reconcile contenteditable
 * children without trashing the user's cursor on every keystroke, so we
 * render the initial text via `dangerouslySetInnerHTML` on mount and
 * then *only* mutate the DOM imperatively when a remote update arrives.
 * The "external update detected" check compares the latest server-known
 * text against the DOM's current value before overwriting, to avoid
 * stomping mid-keystroke.
 *
 * **Save cadence.** 400 ms debounce per keystroke; immediate flush on
 * blur. Same shape as `RichTextEditor`'s save cycle but with a shorter
 * interval because headings are usually short and committed quickly.
 *
 * **Autofocus.** Slash-menu "Heading N" lands here via the surface
 * autofocus coordinator (`useSurfaceFocus.claimFocus`). On mount we
 * check the claim and focus the contenteditable + place the cursor at
 * the end. Identical contract to `<RichTextEditor>`.
 */
type HeadingProps = {
  level?: number;
  text?: string;
};

const SIZE_CLASS: Record<number, string> = {
  1: "text-4xl font-bold mt-8 mb-3",
  2: "text-3xl font-bold mt-6 mb-2",
  3: "text-2xl font-semibold mt-5 mb-2",
  4: "text-xl font-semibold mt-4 mb-2",
  5: "text-lg font-medium mt-3 mb-1",
  6: "text-base font-medium mt-3 mb-1",
};

const SAVE_DEBOUNCE_MS = 400;

export function HeadingRenderer({ node }: ComponentRendererProps) {
  const props = useMemo<HeadingProps>(() => safeParse(node.props), [node.props]);
  const level = clampLevel(props.level);
  const text = props.text ?? "";

  const ref = useRef<HTMLHeadingElement | null>(null);
  // The last text we either successfully saved or accepted from a remote
  // update. Used to (1) decide whether the latest prop change is a
  // remote update we need to mirror into the DOM, and (2) skip redundant
  // saves when the user types-then-undoes back to the same string.
  const lastKnownTextRef = useRef<string>(text);
  const saveTimerRef = useRef<number | null>(null);

  const updateProps = useUpdateComponentProps();
  const insertComponent = useInsertComponent();
  const focus = useSurfaceFocus();

  // Initial mount: stamp the DOM with the prop's text and claim
  // autofocus if the surface coordinator armed us. Subsequent prop
  // changes are handled by the effect below.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    lastKnownTextRef.current = text;
    if (focus.claimFocus(node.id)) {
      el.focus();
      placeCursorAtEnd(el);
    }
    // We deliberately omit `text` and `focus` from the dep array — this
    // effect should run *exactly once per mount*. External prop updates
    // are handled by the `lastKnownTextRef` check in the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remote-update mirror — when `text` changes from outside (the
  // subscription delivered an update from another tab / user / AI),
  // imperatively sync the DOM. Skip if it matches what's already there
  // (typical case: we just saved and the row update is echoing back).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (text === lastKnownTextRef.current) return;
    // Don't stomp the user mid-keystroke — the DOM's value is the source
    // of truth for as long as a save is pending. Compare against the DOM
    // directly, not against lastKnownTextRef.
    if (el.textContent === text) {
      lastKnownTextRef.current = text;
      return;
    }
    el.textContent = text;
    lastKnownTextRef.current = text;
  }, [text]);

  const flushSave = (latest: string) => {
    if (latest === lastKnownTextRef.current) return;
    lastKnownTextRef.current = latest;
    updateProps({
      componentId: node.id,
      propsJson: JSON.stringify({ level, text: latest }),
    });
  };

  const onInput = () => {
    const latest = ref.current?.textContent ?? "";
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      flushSave(latest);
      saveTimerRef.current = null;
    }, SAVE_DEBOUNCE_MS);
  };

  const onBlur = () => {
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const latest = ref.current?.textContent ?? "";
    flushSave(latest);
  };

  // Block-level Enter inside a heading drops out into a new RichText
  // sibling below — matches Notion/BlockNote behaviour. Without this,
  // a newline inside contenteditable=plaintext-only would insert a
  // literal `\n` and stretch the heading vertically. The new RichText
  // grabs focus via the surface autofocus coordinator.
  const onKeyDown = (e: React.KeyboardEvent<HTMLHeadingElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (node.parentId == null) return;
    e.preventDefault();
    // Persist the heading text first so we don't lose any unsaved
    // keystrokes when focus moves away.
    onBlur();
    focus.armForInsert(node.parentId, node.id);
    insertComponent({
      parentId: node.parentId,
      componentType: "RichText",
      propsJson: "{}",
      afterSiblingId: node.id,
    });
  };

  const cls = `${SIZE_CLASS[level]} text-neutral-900 dark:text-neutral-100
               outline-none [&:empty]:before:content-[attr(data-placeholder)]
               [&:empty]:before:text-neutral-400
               dark:[&:empty]:before:text-neutral-600
               [&:empty]:before:italic`;

  const commonProps = {
    ref,
    contentEditable: true as const,
    suppressContentEditableWarning: true,
    "data-placeholder": `Heading ${level}`,
    onInput,
    onBlur,
    onKeyDown,
    className: cls,
  };

  switch (level) {
    case 1:
      return <h1 {...commonProps} />;
    case 2:
      return <h2 {...commonProps} />;
    case 3:
      return <h3 {...commonProps} />;
    case 4:
      return <h4 {...commonProps} />;
    case 5:
      return <h5 {...commonProps} />;
    case 6:
      return <h6 {...commonProps} />;
  }
}

function clampLevel(raw: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > 6) return 6;
  return Math.floor(n) as 1 | 2 | 3 | 4 | 5 | 6;
}

function safeParse(s: string): HeadingProps {
  try {
    return JSON.parse(s) as HeadingProps;
  } catch {
    return {};
  }
}

function placeCursorAtEnd(el: HTMLElement) {
  // Move the caret to the end of the contenteditable's text — same UX
  // contract as `<RichTextEditor>`'s autofocus claim: dropped in via
  // slash menu / chrome `+` arrives ready to keep typing.
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}
