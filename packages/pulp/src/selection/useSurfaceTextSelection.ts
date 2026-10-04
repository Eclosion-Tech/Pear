"use client";

import { useEffect, useRef, type RefObject, type PointerEvent as ReactPointerEvent } from "react";
import { TextSelection } from "prosemirror-state";
import { usePulp } from "../context/PulpProvider";
import { useSurfaceUndo } from "../undo/SurfaceUndoProvider";
import { richTextSchema } from "../rich-text/richTextSchema";
import { useSurfaceSelection } from "./SurfaceSelectionProvider";
import type { SurfaceTextSelection, TextPoint } from "./SurfaceTextSelection";
import type { BlockId } from "../types";

export function textBodyOrder(root: HTMLElement): BlockId[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-text-block]")).filter((el) =>
    el.closest("[data-selection-surface]") === root,
  ).map((el) => BigInt(el.dataset.textBlock!));
}

/** Text-column whitespace counts as text; buttons and the outer margin do not. */
export function textBodyAt(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest("button,input,textarea,select,[role='button'],[data-block-gutter]")) return null;
  const body = target.closest<HTMLElement>("[data-text-block]");
  return body?.closest("[data-selection-surface]") === root ? body : null;
}

export function textPointAt(
  text: SurfaceTextSelection, root: HTMLElement, x: number, y: number,
): TextPoint | null {
  let nearest: { id: BlockId; distance: number } | null = null;
  for (const id of textBodyOrder(root)) {
    const view = text.getEditor(id);
    if (!view) continue;
    const rect = view.dom.getBoundingClientRect();
    const dy = Math.max(rect.top - y, y - rect.bottom, 0);
    const dx = Math.max(rect.left - x, x - rect.right, 0);
    const distance = dy * dy + dx * dx;
    if (!nearest || distance < nearest.distance) nearest = { id, distance };
  }
  if (!nearest) return null;
  const view = text.getEditor(nearest.id)!;
  const rect = view.dom.getBoundingClientRect();
  const pos = view.posAtCoords({ left: Math.max(rect.left + 1, Math.min(x, rect.right - 1)),
    top: Math.max(rect.top + 1, Math.min(y, rect.bottom - 1)) })?.pos;
  return { id: nearest.id, pos: Math.max(1, Math.min(pos ?? 1, view.state.doc.content.size - 1)) };
}

export function useSurfaceTextSelection(rootRef: RefObject<HTMLDivElement | null>) {
  const { text, controller } = useSurfaceSelection();
  const pulp = usePulp();
  const { coordinator: undo } = useSurfaceUndo();
  const latest = useRef(pulp);
  latest.current = pulp;
  const drag = useRef<{ anchor: TextPoint; crossed: boolean; pointerId: number } | null>(null);

  const onPointerDown = (event: ReactPointerEvent) => {
    const root = rootRef.current;
    if (!root || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("[data-selection-surface]") !== root) {
      controller.clear(); text.clear(); drag.current = null; return;
    }
    // Finger scrolling and native touch-selection handles belong to the browser.
    if (event.pointerType === "touch") {
      text.clear();
      controller.clear();
      drag.current = null;
      return;
    }
    const body = textBodyAt(event.target, root);
    const previous = text.getSnapshot();
    if (!body) { text.clear(); drag.current = null; return; }
    controller.clear();
    const id = BigInt(body.dataset.textBlock!);
    const view = text.getEditor(id);
    if (!view) return;
    const point = textPointAt(text, root, event.clientX, event.clientY);
    if (!point) return;
    if (event.shiftKey) {
      const anchor = previous?.anchor ?? focusedPoint(text, root, "anchor");
      if (anchor) {
        event.preventDefault();
        text.set(anchor, point, textBodyOrder(root));
        drag.current = { anchor, crossed: true, pointerId: event.pointerId };
        return;
      }
    }
    text.clear();
    drag.current = { anchor: point, crossed: false, pointerId: event.pointerId };
    // Padding around paragraphs is part of the text column too.
    if (!(event.target as Element).closest(".ProseMirror")) {
      event.preventDefault();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, point.pos)));
      view.focus();
    }
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const inSurface = (target: EventTarget | null) => target instanceof Element &&
      target.closest("[data-selection-surface]") === root;
    const inTextEditor = (target: EventTarget | null) => inSurface(target) &&
      target instanceof Element && !!target.closest(".ProseMirror");
    const consume = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
    const replace = (content: Parameters<typeof text.replace>[0]) =>
      text.replace(content, latest.current.tree, latest.current, undo);

    const move = (event: PointerEvent) => {
      const gesture = drag.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const point = textPointAt(text, root, event.clientX, event.clientY);
      if (!point) return;
      if (point.id !== gesture.anchor.id) gesture.crossed = true;
      if (!gesture.crossed) return; // Native word/line selection within one editor.
      event.preventDefault();
      text.set(gesture.anchor, point, textBodyOrder(root));
    };
    const up = (event: PointerEvent) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      text.restoreDOM();
    };
    const outside = (event: PointerEvent) => {
      if (inSurface(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[data-text-selection-toolbar]")) return;
      drag.current = null;
      text.clear();
      controller.clear();
    };
    const copy = (event: ClipboardEvent) => {
      if (!inTextEditor(event.target) || !text.getSnapshot()) return;
      consume(event);
      const data = text.clipboard();
      if (!data || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", data.text);
      event.clipboardData.setData("text/html", data.html);
      if (event.type === "cut") replace("");
    };
    const paste = (event: ClipboardEvent) => {
      if (!inTextEditor(event.target) || !text.getSnapshot()) return;
      consume(event);
      if (!event.clipboardData) return;
      const slice = text.pasteSlice(event.clipboardData.getData("text/plain"), event.clipboardData.getData("text/html"));
      if (slice) replace(slice);
    };
    const beforeInput = (event: InputEvent) => {
      if (!inTextEditor(event.target) || !text.getSnapshot()) return;
      consume(event);
      if (event.inputType.startsWith("delete")) replace("");
      else if (event.inputType === "insertText" || event.inputType === "insertReplacementText") replace(event.data ?? "");
      else if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
        const slice = text.pasteSlice("\n", "");
        if (slice) replace(slice);
      }
    };
    const composition = (event: CompositionEvent) => {
      if (inTextEditor(event.target) && text.getSnapshot()) replace("");
    };
    const key = (event: KeyboardEvent) => {
      if (!inTextEditor(event.target) || event.isComposing) return;
      const range = text.getSnapshot();
      const order = textBodyOrder(root);
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "a") {
        consume(event);
        controller.clear();
        text.selectAll(order);
        return;
      }
      if (event.shiftKey && /^Arrow(Left|Right|Up|Down)$/.test(event.key)) {
        const head = range?.head ?? focusedPoint(text, root, "head");
        const anchor = range?.anchor ?? focusedPoint(text, root, "anchor");
        if (head && anchor) {
          const next = extendPoint(text, order, head, event.key);
          if (next && (range || next.id !== head.id)) {
            consume(event);
            controller.clear();
            text.set(anchor, next, order);
            return;
          }
        }
      }
      if (!range) return;
      const markName = mod ? ({ b: "bold", i: "italic", u: "underline", "`": "code",
        ...(event.shiftKey ? { s: "strike", S: "strike" } : {}) } as Record<string, string>)[event.key] : undefined;
      if (markName) {
        consume(event);
        text.format(richTextSchema.marks[markName], undo);
      } else if (event.key === "Backspace" || event.key === "Delete") {
        consume(event); replace("");
      } else if (event.key === "Enter") {
        consume(event);
        const slice = text.pasteSlice("\n", "");
        if (slice) replace(slice);
      } else if (event.key === "Escape" || (!event.shiftKey && event.key.startsWith("Arrow"))) {
        consume(event);
        text.collapse(event.key === "ArrowLeft" || event.key === "ArrowUp" ? "start" : "end");
      } else if (event.key === "Tab" || (mod && event.key.toLowerCase() === "k")) {
        // These are block-local commands; never apply them to an incidental
        // single-editor selection while a surface text range is active.
        consume(event);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    document.addEventListener("pointerdown", outside, true);
    root.addEventListener("copy", copy, true);
    root.addEventListener("cut", copy, true);
    root.addEventListener("paste", paste, true);
    root.addEventListener("beforeinput", beforeInput, true);
    root.addEventListener("compositionstart", composition, true);
    root.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.removeEventListener("pointerdown", outside, true);
      root.removeEventListener("copy", copy, true);
      root.removeEventListener("cut", copy, true);
      root.removeEventListener("paste", paste, true);
      root.removeEventListener("beforeinput", beforeInput, true);
      root.removeEventListener("compositionstart", composition, true);
      root.removeEventListener("keydown", key, true);
    };
  }, [rootRef, text, controller, undo]);

  useEffect(() => {
    if (rootRef.current) text.reconcile(textBodyOrder(rootRef.current));
  }, [pulp.tree, text, rootRef]);

  return onPointerDown;
}

function focusedPoint(text: SurfaceTextSelection, root: HTMLElement, side: "anchor" | "head"): TextPoint | null {
  for (const id of textBodyOrder(root)) {
    const view = text.getEditor(id);
    if (view?.hasFocus()) return { id, pos: view.state.selection[side] };
  }
  return null;
}

function extendPoint(text: SurfaceTextSelection, order: BlockId[], point: TextPoint, key: string): TextPoint | null {
  const view = text.getEditor(point.id);
  if (!view) return null;
  const backward = key === "ArrowLeft" || key === "ArrowUp";
  const step = backward ? -1 : 1;
  const vertical = key === "ArrowUp" || key === "ArrowDown";
  let x: number | undefined;
  if (vertical) {
    const rect = view.coordsAtPos(point.pos);
    x = rect.left;
    const y = (rect.top + rect.bottom) / 2 + step * (rect.bottom - rect.top);
    const bounds = view.dom.getBoundingClientRect();
    if (y > bounds.top && y < bounds.bottom) {
      const found = view.posAtCoords({ left: x, top: y });
      if (found) return { id: point.id, pos: found.pos };
    }
  } else if (backward ? point.pos > 1 : point.pos < view.state.doc.content.size - 1) {
    let pos = point.pos + step;
    // Keep UTF-16 surrogate pairs together when extending over emoji.
    const adjacent = view.state.doc.textBetween(backward ? Math.max(1, point.pos - 2) : point.pos,
      backward ? point.pos : Math.min(view.state.doc.content.size - 1, point.pos + 2));
    if (/^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(adjacent)) pos += step;
    pos = Math.max(1, Math.min(pos, view.state.doc.content.size - 1));
    return { id: point.id, pos: TextSelection.near(view.state.doc.resolve(pos), step).head };
  }
  const nextId = order[order.indexOf(point.id) + step];
  const next = nextId != null ? text.getEditor(nextId) : undefined;
  if (!next) return null;
  let pos = backward ? next.state.doc.content.size - 1 : 1;
  if (vertical && x != null) {
    const rect = next.coordsAtPos(pos);
    pos = next.posAtCoords({ left: x, top: (rect.top + rect.bottom) / 2 })?.pos ?? pos;
  }
  return { id: nextId, pos };
}
