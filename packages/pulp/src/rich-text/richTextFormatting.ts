import type { MarkType } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import * as Y from "yjs";
import { prosemirrorToYDoc } from "y-prosemirror";
import { richTextSchema, PROSEMIRROR_FRAGMENT_KEY } from "./richTextSchema";

export function plainTextToYDoc(text: string): Y.Doc {
  const para = richTextSchema.node(
    "paragraph",
    null,
    text ? richTextSchema.text(text) : undefined,
  );
  const pmDoc = richTextSchema.node("doc", null, [para]);
  return prosemirrorToYDoc(pmDoc, PROSEMIRROR_FRAGMENT_KEY);
}

export function normalizeTextAlign(raw: unknown): TextAlign {
  if (raw === "center" || raw === "right") return raw;
  return "left";
}

export function headingPropsJson(
  level: number,
  opts: { textAlign?: TextAlign; collapsed?: boolean } = {},
): string {
  const textAlign = opts.textAlign ?? "left";
  return JSON.stringify({
    level,
    ...(textAlign !== "left" ? { textAlign } : {}),
    ...(opts.collapsed ? { collapsed: true } : {}),
  });
}

export type TextAlign = "left" | "center" | "right";

/** BlockNote-style preset swatches for the selection toolbar. */
export const TEXT_COLOR_SWATCHES = [
  { label: "Default", value: null },
  { label: "Gray", value: "#787774" },
  { label: "Red", value: "#e03e3e" },
  { label: "Orange", value: "#d9730d" },
  { label: "Yellow", value: "#ca9221" },
  { label: "Green", value: "#448361" },
  { label: "Blue", value: "#337ea9" },
  { label: "Purple", value: "#9065b0" },
  { label: "Pink", value: "#c14c8a" },
] as const;

export const BACKGROUND_COLOR_SWATCHES = [
  { label: "Default", value: null },
  { label: "Gray", value: "#f1f1ef" },
  { label: "Red", value: "#fdebec" },
  { label: "Orange", value: "#fbecdd" },
  { label: "Yellow", value: "#fbf3db" },
  { label: "Green", value: "#edf3ec" },
  { label: "Blue", value: "#e7f3f8" },
  { label: "Purple", value: "#f4eef9" },
  { label: "Pink", value: "#faeef5" },
] as const;

export function getSelectionTextAlign(state: EditorState): TextAlign {
  const { from, to } = state.selection;
  let align: TextAlign = "left";

  state.doc.nodesBetween(from, to, (node) => {
    if (node.type.name !== "paragraph") return;
    const raw = node.attrs.textAlign;
    if (raw === "center" || raw === "right") {
      align = raw;
    }
  });

  return align;
}

export function getSelectionMarkColor(
  state: EditorState,
  markType: MarkType,
  attr: "color" | "backgroundColor",
  from: number,
  to: number,
): string | null {
  if (from === to) {
    const stored = markType.isInSet(
      state.storedMarks ?? state.selection.$from.marks(),
    );
    if (!stored) return null;
    const v = stored.attrs[attr];
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  let value: string | null = null;
  let mixed = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type !== markType) continue;
      const v = mark.attrs[attr];
      const next = typeof v === "string" && v.length > 0 ? v : null;
      if (value == null) {
        value = next;
      } else if (value !== next) {
        mixed = true;
        return false;
      }
    }
    return undefined;
  });
  return mixed ? null : value;
}

export function setParagraphTextAlign(view: EditorView, align: TextAlign): void {
  const { state } = view;
  const { from, to } = state.selection;
  let tr = state.tr;
  let changed = false;

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== "paragraph") return;
    const nextAlign = align === "left" ? null : align;
    if (node.attrs.textAlign === nextAlign) return;
    tr = tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      textAlign: nextAlign,
    });
    changed = true;
  });

  if (!changed) {
    const $from = state.selection.$from;
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth);
      if (node.type.name !== "paragraph") continue;
      const pos = $from.before(depth);
      const nextAlign = align === "left" ? null : align;
      if (node.attrs.textAlign !== nextAlign) {
        tr = tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          textAlign: nextAlign,
        });
        changed = true;
      }
      break;
    }
  }

  if (changed) {
    view.dispatch(tr.scrollIntoView());
  }
  view.focus();
}

export function applyColorMark(
  view: EditorView,
  markName: "textColor" | "backgroundColor",
  color: string | null,
): void {
  const markType = richTextSchema.marks[markName];
  if (!markType) return;

  const attr = markName === "textColor" ? "color" : "backgroundColor";
  const { from, to } = view.state.selection;

  if (!color) {
    view.dispatch(view.state.tr.removeMark(from, to, markType).scrollIntoView());
    view.focus();
    return;
  }

  let tr = view.state.tr.removeMark(from, to, markType);
  if (from !== to) {
    tr = tr.addMark(from, to, markType.create({ [attr]: color }));
  } else {
    tr = tr.addStoredMark(markType.create({ [attr]: color }));
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}
