import { DOMParser, DOMSerializer, Fragment, Slice, type MarkType } from "prosemirror-model";
import { TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "y-prosemirror";
import type { RelativePosition } from "yjs";
import type { BlockId, BlockTree, PulpMutations } from "../types";
import type { SurfaceUndoCoordinator } from "../undo/SurfaceUndoCoordinator";

export type TextPoint = { id: BlockId; pos: number };
type TrackedPoint = TextPoint & { relative?: RelativePosition };
export type SurfaceTextRange = {
  anchor: TrackedPoint;
  head: TrackedPoint;
  /** Visible text bodies in document order; includes virtualized bodies. */
  ids: readonly BlockId[];
};
export type TextSegment = { id: BlockId; view: EditorView; from: number; to: number };

/**
 * Character selection across independent ProseMirror documents. Block selection
 * remains a separate model. Each editor paints its portion using decorations;
 * browsers cannot reliably hold native selections across editing hosts.
 */
export class SurfaceTextSelection {
  private range: SurfaceTextRange | null = null;
  private editors = new Map<BlockId, EditorView>();
  private listeners = new Set<() => void>();
  private restoring = false;
  private editing = false;
  private selectAllEnd: BlockId | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): SurfaceTextRange | null => this.range;

  register(id: BlockId, view: EditorView): () => void {
    this.editors.set(id, view);
    if (this.range?.ids.includes(id)) {
      const range = this.range;
      const anchor = range.anchor.id === id ? this.track(range.anchor) : range.anchor;
      const head = this.selectAllEnd === id
        ? this.track({ id, pos: view.state.doc.content.size - 1 })
        : range.head.id === id ? this.track(range.head) : range.head;
      if (this.selectAllEnd === id) this.selectAllEnd = null;
      this.range = { ...range, anchor, head };
      this.emit();
      this.restoreDOM();
    }
    return () => {
      if (this.editors.get(id) === view) this.editors.delete(id);
    };
  }

  getEditor(id: BlockId): EditorView | undefined { return this.editors.get(id); }

  set(anchor: TextPoint, head: TextPoint, order: readonly BlockId[]): void {
    this.selectAllEnd = null;
    const a = order.indexOf(anchor.id), h = order.indexOf(head.id);
    if (a < 0 || h < 0) return;
    if (anchor.id === head.id && anchor.pos === head.pos) {
      this.clear();
      const view = this.editors.get(anchor.id);
      if (view) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor.pos)));
      return;
    }
    this.range = {
      anchor: this.track(anchor), head: this.track(head),
      ids: order.slice(Math.min(a, h), Math.max(a, h) + 1),
    };
    this.emit();
    this.restoreDOM();
  }

  clear(): void {
    this.selectAllEnd = null;
    if (!this.range) return;
    this.range = null;
    this.emit();
  }

  /** Pin every text body, including off-screen editors, before clipboard/edit operations. */
  selectAll(order: readonly BlockId[]): void {
    if (!order.length) return;
    const first = order[0], last = order[order.length - 1];
    const end = this.editors.get(last);
    this.set({ id: first, pos: 1 }, { id: last, pos: end ? end.state.doc.content.size - 1 : 1 }, order);
    if (!end) this.selectAllEnd = last;
  }

  /** Cancel if a selected body was deleted, hidden or reordered remotely. */
  reconcile(order: readonly BlockId[]): void {
    if (!this.range) return;
    const start = order.indexOf(this.range.ids[0]);
    if (start < 0 || this.range.ids.some((id, i) => order[start + i] !== id)) this.clear();
  }

  private track(point: TextPoint): TrackedPoint {
    const view = this.editors.get(point.id);
    const binding = view && ySyncPluginKey.getState(view.state)?.binding;
    return binding ? {
      ...point,
      relative: absolutePositionToRelativePosition(point.pos, binding.type, binding.mapping),
    } : point;
  }

  /** Yjs relative positions keep endpoints attached to text during remote edits. */
  onTransaction(id: BlockId, tr: Transaction): void {
    if (!this.range || this.editing || !tr.docChanged) return;
    const resolve = (point: TrackedPoint): TrackedPoint => {
      if (point.id !== id || !tr.docChanged) return point;
      const view = this.editors.get(id);
      const binding = view && ySyncPluginKey.getState(view.state)?.binding;
      const pos = point.relative && binding
        ? relativePositionToAbsolutePosition(binding.doc, binding.type, point.relative, binding.mapping)
        : tr.mapping.map(point.pos);
      return { ...point, pos: Math.max(1, Math.min(pos ?? point.pos, tr.doc.content.size - 1)) };
    };
    this.range = { ...this.range, anchor: resolve(this.range.anchor), head: resolve(this.range.head) };
    this.emit();
    this.restoreDOM();
  }

  /** Keep native input in the anchor editor; decorations paint the full range. */
  restoreDOM(): void {
    if (this.restoring) return;
    this.restoring = true;
    queueMicrotask(() => {
      this.restoring = false;
      const range = this.range;
      if (!range) return;
      const a = this.editors.get(range.anchor.id);
      if (!a || !a.dom.isConnected) return;
      const pos = Math.min(range.anchor.pos, a.state.doc.content.size - 1);
      if (!a.state.selection.empty || a.state.selection.head !== pos) {
        a.dispatch(a.state.tr.setSelection(TextSelection.create(a.state.doc, pos)));
      }
      const anchor = a.domAtPos(pos);
      const selection = a.dom.ownerDocument.getSelection();
      if (!selection) return;
      if (selection.anchorNode === anchor.node && selection.anchorOffset === anchor.offset &&
          selection.isCollapsed) return;
      selection.collapse(anchor.node, anchor.offset);
    });
  }

  rangeIn(id: BlockId, end: number): { from: number; to: number } | null {
    const range = this.range;
    if (!range?.ids.includes(id)) return null;
    const backwards = range.ids.indexOf(range.anchor.id) > range.ids.indexOf(range.head.id) ||
      (range.anchor.id === range.head.id && range.anchor.pos > range.head.pos);
    const start = backwards ? range.head : range.anchor;
    const finish = backwards ? range.anchor : range.head;
    return { from: id === start.id ? start.pos : 1, to: id === finish.id ? finish.pos : end };
  }

  selectionRect(): DOMRect | null {
    const segments = this.segments();
    if (!segments?.length) return null;
    const first = segments[0], last = segments[segments.length - 1];
    const start = first.view.domAtPos(first.from), end = last.view.domAtPos(last.to);
    const range = first.view.dom.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range.getBoundingClientRect();
  }

  segments(): TextSegment[] | null {
    const range = this.range;
    if (!range) return null;
    const backwards = range.ids.indexOf(range.anchor.id) > range.ids.indexOf(range.head.id) ||
      (range.anchor.id === range.head.id && range.anchor.pos > range.head.pos);
    const start = backwards ? range.head : range.anchor;
    const end = backwards ? range.anchor : range.head;
    const segments: TextSegment[] = [];
    for (const id of range.ids) {
      const view = this.editors.get(id);
      // Never silently operate on only the mounted portion of a selection.
      if (!view) return null;
      segments.push({ id, view, from: id === start.id ? start.pos : 1,
        to: id === end.id ? end.pos : view.state.doc.content.size - 1 });
    }
    return segments;
  }

  clipboard(): { text: string; html: string } | null {
    const segments = this.segments();
    if (!segments?.length) return null;
    const container = segments[0].view.dom.ownerDocument.createElement("div");
    const text: string[] = [];
    for (const { view, from, to } of segments) {
      text.push(view.state.doc.textBetween(from, to, "\n", "\n"));
      const content = view.state.doc.cut(from, to).content;
      container.appendChild(DOMSerializer.fromSchema(view.state.schema).serializeFragment(content));
    }
    return { text: text.join("\n"), html: container.innerHTML };
  }

  hasMark(type: MarkType): boolean {
    return this.segments()?.some(({ view, from, to }) => view.state.doc.rangeHasMark(from, to, type)) ?? false;
  }

  format(type: MarkType, undo: SurfaceUndoCoordinator, attrs?: Record<string, unknown> | null): boolean {
    const segments = this.segments();
    if (!segments) return false;
    const remove = attrs === null || (attrs === undefined && this.hasMark(type));
    undo.transact(() => {
      for (const { view, from, to } of segments) {
        const tr = remove ? view.state.tr.removeMark(from, to, type)
          : view.state.tr.addMark(from, to, type.create(attrs));
        view.dispatch(tr);
      }
    });
    this.restoreDOM();
    return true;
  }

  align(align: string, undo: SurfaceUndoCoordinator): void {
    const segments = this.segments();
    if (!segments) return;
    undo.transact(() => {
      for (const { view, from, to } of segments) {
        const tr = view.state.tr;
        view.state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === "paragraph") tr.setNodeMarkup(pos, undefined, {
            ...node.attrs, textAlign: align === "left" ? null : align,
          });
        });
        view.dispatch(tr);
      }
    });
    this.restoreDOM();
  }

  /**
   * Replace the exact text range. Adjacent leaf siblings join naturally;
   * ranges spanning containers/media only edit text, preserving that structure.
   */
  replace(
    content: string | Slice,
    tree: BlockTree,
    mutations: PulpMutations,
    undo: SurfaceUndoCoordinator,
  ): boolean {
    const segments = this.segments();
    if (!segments?.length) return false;
    const first = segments[0], last = segments[segments.length - 1];
    const firstNode = tree.byId.get(first.id);
    const siblings = firstNode ? tree.byParent.get(firstNode.parentId ?? null) ?? [] : [];
    const index = siblings.findIndex((node) => node.id === first.id);
    const join = segments.every(({ id }, i) => siblings[index + i]?.id === id &&
      !(tree.byParent.get(id)?.length));
    this.editing = true;
    this.clear();
    try {
      undo.transact(() => {
        let tr = first.view.state.tr;
        if (segments.length > 1 && join) {
          // Slice is open at the paragraph edge, joining the final suffix to
          // the first prefix while retaining inline marks and later paragraphs.
          const suffix = last.view.state.doc.slice(last.to, last.view.state.doc.content.size - 1);
          tr.replace(first.from, tr.doc.content.size - 1, suffix);
          for (const segment of segments.slice(1)) mutations.deleteBlock({ componentId: segment.id });
        } else {
          tr.delete(first.from, first.to);
          for (const { view, from, to } of segments.slice(1)) view.dispatch(view.state.tr.delete(from, to));
        }
        tr.setSelection(TextSelection.create(tr.doc, Math.min(first.from, tr.doc.content.size - 1)));
        if (typeof content === "string") {
          if (content) tr.insertText(content);
        } else {
          tr.replaceSelection(content);
        }
        first.view.dispatch(tr.scrollIntoView());
      });
      first.view.focus();
    } finally { this.editing = false; }
    return true;
  }

  pasteSlice(text: string, html: string): Slice | null {
    const view = this.segments()?.[0]?.view;
    if (!view) return null;
    const container = view.dom.ownerDocument.createElement("div");
    if (html) {
      container.innerHTML = html;
      return DOMParser.fromSchema(view.state.schema).parseSlice(container);
    }
    const paragraphs = text.replace(/\r\n?/g, "\n").split("\n").map((line) =>
      view.state.schema.nodes.paragraph.create(null, line ? view.state.schema.text(line) : undefined));
    return new Slice(Fragment.fromArray(paragraphs), 1, 1);
  }

  collapse(end: "start" | "end"): void {
    const segments = this.segments();
    if (!segments?.length) return;
    const segment = end === "start" ? segments[0] : segments[segments.length - 1];
    const pos = end === "start" ? segment.from : segment.to;
    this.clear();
    segment.view.dispatch(segment.view.state.tr.setSelection(TextSelection.create(segment.view.state.doc, pos)));
    segment.view.focus();
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}
