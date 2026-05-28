import type { Node as PMNode, Mark } from "prosemirror-model";
import * as Y from "yjs";
import { prosemirrorToYDoc } from "y-prosemirror";
import {
  normalizeTextAlign,
  type TextAlign,
} from "../rich-text/richTextFormatting";
import { richTextSchema, PROSEMIRROR_FRAGMENT_KEY } from "../rich-text/richTextSchema";

/** BlockNote inline `content` array element (text run or link). */
export type BlockNoteInlineNode =
  | {
      type: "text";
      text: string;
      styles?: BlockNoteInlineStyles;
    }
  | {
      type: "link";
      href: string;
      content?: BlockNoteInlineNode[];
    };

export type BlockNoteInlineStyles = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  textColor?: string;
  backgroundColor?: string;
};

/** BlockNote named swatches → Pear toolbar hex (see `TEXT_COLOR_SWATCHES`). */
const BLOCKNOTE_TEXT_COLOR: Record<string, string> = {
  gray: "#787774",
  brown: "#9f6b53",
  red: "#e03e3e",
  orange: "#d9730d",
  yellow: "#ca9221",
  green: "#448361",
  blue: "#337ea9",
  purple: "#9065b0",
  pink: "#c14c8a",
};

const BLOCKNOTE_BACKGROUND_COLOR: Record<string, string> = {
  gray: "#f1f1ef",
  brown: "#f4eeee",
  red: "#fdebec",
  orange: "#fbecdd",
  yellow: "#fbf3db",
  green: "#edf3ec",
  blue: "#e7f3f8",
  purple: "#f4eef9",
  pink: "#faeef5",
};

/**
 * Build a Y.Doc for a Yjs-backed block from BlockNote inline `content` and
 * optional block-level `textAlignment`.
 */
export function blockNoteInlineToYDoc(
  inline: BlockNoteInlineNode[] | undefined | null,
  textAlignment?: unknown,
): Y.Doc {
  const align = normalizeTextAlign(textAlignment);
  const paraAttrs =
    align !== "left" ? { textAlign: align as TextAlign } : null;
  const inlineNodes = blockNoteInlineToPmInline(inline ?? []);
  const para = richTextSchema.node(
    "paragraph",
    paraAttrs,
    inlineNodes.length > 0 ? inlineNodes : undefined,
  );
  const pmDoc = richTextSchema.node("doc", null, [para]);
  return prosemirrorToYDoc(pmDoc, PROSEMIRROR_FRAGMENT_KEY);
}

export function blockNoteInlineToYjsUpdate(
  inline: BlockNoteInlineNode[] | undefined | null,
  textAlignment?: unknown,
): Uint8Array {
  const doc = blockNoteInlineToYDoc(inline, textAlignment);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function blockNoteInlineToPmInline(inline: BlockNoteInlineNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const node of inline) {
    if (node.type === "link") {
      const marks = [richTextSchema.marks.link.create({ href: node.href })];
      appendTextNodes(out, node.content ?? [], marks);
      continue;
    }
    if (node.type === "text" && node.text.length > 0) {
      appendTextNodes(out, [node], stylesToMarks(node.styles));
    }
  }
  return out;
}

function appendTextNodes(
  out: PMNode[],
  nodes: BlockNoteInlineNode[],
  extraMarks: Mark[],
): void {
  for (const node of nodes) {
    if (node.type !== "text" || node.text.length === 0) continue;
    const marks = [...extraMarks, ...stylesToMarks(node.styles)];
    out.push(richTextSchema.text(node.text, marks));
  }
}

function stylesToMarks(styles: BlockNoteInlineStyles | undefined): Mark[] {
  if (!styles) return [];
  const marks: Mark[] = [];
  if (styles.bold) marks.push(richTextSchema.marks.bold.create());
  if (styles.italic) marks.push(richTextSchema.marks.italic.create());
  if (styles.underline) marks.push(richTextSchema.marks.underline.create());
  if (styles.strike) marks.push(richTextSchema.marks.strike.create());
  if (styles.code) marks.push(richTextSchema.marks.code.create());

  const textColor = resolveColor(styles.textColor, BLOCKNOTE_TEXT_COLOR);
  if (textColor) {
    marks.push(richTextSchema.marks.textColor.create({ color: textColor }));
  }

  const backgroundColor = resolveColor(
    styles.backgroundColor,
    BLOCKNOTE_BACKGROUND_COLOR,
  );
  if (backgroundColor) {
    marks.push(
      richTextSchema.marks.backgroundColor.create({
        backgroundColor,
      }),
    );
  }

  return marks;
}

function resolveColor(
  raw: string | undefined,
  table: Record<string, string>,
): string | null {
  if (!raw || raw === "default") return null;
  if (raw.startsWith("#")) return raw;
  return table[raw] ?? null;
}
