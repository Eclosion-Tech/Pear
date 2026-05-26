"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  usePulp,
  useSurfaceFocus,
  getBlockSibling,
  knownSiblingIdsForParent,
  mergePlainTextIntoRichText,
  type BlockRendererProps,
} from "@eclosion-tech/pulp";

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

// Block-editor spacing — symmetric vertical rhythm so `<BlockChrome>`
// gutter icons center on the text line. Document-style `mt-*` on headings
// (meant for flowing article layout) skews gutter centering upward because
// the chrome box includes empty margin above the glyphs.
const SIZE_CLASS: Record<number, string> = {
  1: "text-4xl font-bold leading-tight my-2",
  2: "text-3xl font-bold leading-tight my-2",
  3: "text-2xl font-semibold leading-tight my-2",
  4: "text-xl font-semibold leading-tight my-2",
  5: "text-lg font-medium leading-tight my-2",
  6: "text-base font-medium leading-tight my-2",
};

const SAVE_DEBOUNCE_MS = 400;

export function HeadingRenderer({ node, tree }: BlockRendererProps) {
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

  const { insertBlock, deleteBlock, updateBlockProps, saveYjsState } = usePulp();
  const focus = useSurfaceFocus();

  // Initial mount: stamp the DOM with the prop's text, register this
  // heading with the surface focus coordinator so Backspace-into-
  // previous can imperatively land here, and claim autofocus if the
  // coordinator armed us (slash menu / Enter from an earlier sibling).
  // Subsequent prop changes are handled by the effect below.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    lastKnownTextRef.current = text;
    const focusSelf = (placement: "start" | "end" = "end") => {
      el.focus();
      if (placement === "start") placeCursorAtStart(el);
      else placeCursorAtEnd(el);
      focus.ackFocus(node.id);
    };
    const unregister = focus.registerFocusable(node.id, focusSelf);
    const claim = focus.claimFocus(node.id);
    if (claim) {
      focusSelf(claim);
      focus.ackFocus(node.id);
    } else {
      const retryDelaysMs = [0, 16, 50, 100, 200, 400];
      const timeouts = retryDelaysMs.map((delayMs) =>
        window.setTimeout(() => {
          const retry = focus.claimFocus(node.id);
          if (!retry) return;
          focusSelf(retry);
          focus.ackFocus(node.id);
        }, delayMs),
      );
      return () => {
        for (const id of timeouts) window.clearTimeout(id);
        unregister();
      };
    }
    return () => {
      unregister();
    };
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
    updateBlockProps({
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

  // Block-level keymap inside a heading:
  //   • Enter — drop out into a new RichText sibling below, matching
  //     Notion/BlockNote. Without preventDefault a contentEditable=
  //     plaintext-only would insert a literal `\n` and stretch the
  //     heading vertically. The new RichText grabs focus via the
  //     surface autofocus coordinator.
  //   • Backspace at caret-start on a non-empty heading — merge the
  //     heading text into the previous sibling (RichText or Heading),
  //     then delete this block. Matches Notion's "un-heading" gesture.
  //   • Backspace on empty heading at caret-start — delete this block
  //     and move focus to the previous sibling (caret at end), same
  //     contract as RichText's `onDeleteSelf`. Without this the user
  //     has to click out and Backspace from the next block — common
  //     when accidentally inserting a Heading via the slash menu.
  const onKeyDown = (e: React.KeyboardEvent<HTMLHeadingElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (node.parentId == null) return;
      e.preventDefault();
      // Persist the heading text first so we don't lose any unsaved
      // keystrokes when focus moves away.
      onBlur();
      focus.armForInsert(node.parentId, node.id, {
        knownSiblingIds: knownSiblingIdsForParent(tree, node.parentId),
      });
      insertBlock({
        parentId: node.parentId,
        componentType: "RichText",
        propsJson: "{}",
        afterSiblingId: node.id,
      });
      return;
    }
    if (e.key === "Backspace") {
      if (node.parentId == null) return;
      const el = ref.current;
      if (!el || !isCaretAtStart(el)) return;
      const sel = window.getSelection();
      if (!sel?.isCollapsed) return;

      const siblings = tree.byParent.get(node.parentId) ?? [];
      // Server forbids deleting the only child of a Container (root-
      // collapse prevention, see `delete_component` in components.rs).
      if (siblings.length <= 1) return;

      const myIdx = siblings.findIndex((s) => s.id === node.id);
      const prev = myIdx > 0 ? siblings[myIdx - 1] : undefined;
      const headingText = el.textContent ?? "";

      if (headingText.length === 0) {
        e.preventDefault();
        const neighbour =
          prev ?? (myIdx + 1 < siblings.length ? siblings[myIdx + 1] : undefined);
        if (neighbour) focus.requestFocus(neighbour.id, "end");
        if (saveTimerRef.current != null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        deleteBlock({ componentId: node.id });
        return;
      }

      if (!prev) return;

      e.preventDefault();
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      if (prev.componentType === "RichText") {
        const merged = mergePlainTextIntoRichText(
          prev.id,
          headingText,
          tree,
          focus,
          saveYjsState,
        );
        if (merged != null) {
          deleteBlock({ componentId: node.id });
          if (!focus.getEditor(prev.id)) {
            focus.requestFocus(prev.id, "end");
          }
          return;
        }
      }

      if (prev.componentType === "Heading") {
        const prevProps = safeParse(prev.props);
        const prevText =
          typeof prevProps.text === "string" ? prevProps.text : "";
        updateBlockProps({
          componentId: prev.id,
          propsJson: JSON.stringify({
            level: clampLevel(prevProps.level),
            text: prevText + headingText,
          }),
        });
        deleteBlock({ componentId: node.id });
        focus.requestFocus(prev.id, "end");
        return;
      }

      // Non-text previous block — fall back to focus-only (same as
      // RichText merge when prev isn't text-backed).
      focus.requestFocus(prev.id, "end");
    }
    if (e.key === "ArrowUp") {
      const el = ref.current;
      if (!el || !isCaretAtStart(el)) return;
      const prev = getBlockSibling(tree, node.id, "prev");
      if (!prev) return;
      e.preventDefault();
      onBlur();
      focus.requestFocus(prev.id, "end");
      return;
    }
    if (e.key === "ArrowDown") {
      const el = ref.current;
      if (!el || !isCaretAtEnd(el)) return;
      const next = getBlockSibling(tree, node.id, "next");
      if (!next) return;
      e.preventDefault();
      onBlur();
      focus.requestFocus(next.id, "start");
    }
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

function placeCursorAtStart(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

function isCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return false;
  const probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length === 0;
}

function isCaretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return false;
  const probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setStart(range.startContainer, range.startOffset);
  return probe.toString().length === 0;
}
