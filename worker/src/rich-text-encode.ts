/**
 * Worker-side encoder for ComponentTree rich text.
 *
 * Doc pages now store content as `ComponentNode` rows (assessment #27). The
 * text of a Yjs-backed node (`RichText`, `Heading`, `*ListItem`) lives in a
 * per-node `ComponentYjsState` blob — `Y.encodeStateAsUpdate(ydoc)` of a
 * `y-prosemirror`-shaped `Y.Doc`. To author content the worker must produce
 * those bytes, encoded against pulp's exact ProseMirror schema so the bytes
 * round-trip in the live editor.
 *
 * We reuse pulp's `richTextSchema` + `PROSEMIRROR_FRAGMENT_KEY` (imported via
 * headless deep paths so we don't pull pulp's React surface) and the same
 * `prosemirrorToYDoc` y-prosemirror uses. The block-level shape is FLAT — a
 * RichText doc is a single paragraph of inline runs; headings / list items are
 * separate `ComponentNode`s, not block nodes inside the doc (see
 * `richTextSchema.ts`).
 */

import * as Y from "yjs";
import { prosemirrorToYDoc } from "y-prosemirror";
import type { Node as PMNode, Mark } from "prosemirror-model";
import {
  richTextSchema,
  PROSEMIRROR_FRAGMENT_KEY,
} from "@eclosion-tech/pulp/rich-text/richTextSchema";

// ── Inline markdown → ProseMirror inline nodes ─────────────────────────────────

/**
 * Parse a single line of inline markdown into ProseMirror inline nodes,
 * applying the v1 mark vocabulary: bold (`**`), italic (`*`/`_`), inline code
 * (`` ` ``), and links (`[text](url)`). Non-nested — the common case for
 * model-authored prose. Unmatched markers are emitted as literal text.
 */
export function parseInlineMarkdown(line: string): PMNode[] {
  const nodes: PMNode[] = [];
  let i = 0;
  let plain = "";

  const flushPlain = () => {
    if (plain) {
      nodes.push(richTextSchema.text(plain));
      plain = "";
    }
  };
  const pushMarked = (text: string, mark: Mark) => {
    if (text) nodes.push(richTextSchema.text(text, [mark]));
  };

  while (i < line.length) {
    const rest = line.slice(i);

    // Link: [text](url)
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flushPlain();
      pushMarked(link[1], richTextSchema.marks.link.create({ href: link[2] }));
      i += link[0].length;
      continue;
    }
    // Bold: **text**
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    if (bold) {
      flushPlain();
      pushMarked(bold[1], richTextSchema.marks.bold.create());
      i += bold[0].length;
      continue;
    }
    // Inline code: `text`
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flushPlain();
      pushMarked(code[1], richTextSchema.marks.code.create());
      i += code[0].length;
      continue;
    }
    // Italic: *text* or _text_ (single delimiter, not part of **)
    const italic = /^(\*([^*]+)\*|_([^_]+)_)/.exec(rest);
    if (italic) {
      flushPlain();
      pushMarked(
        italic[2] ?? italic[3] ?? "",
        richTextSchema.marks.italic.create(),
      );
      i += italic[0].length;
      continue;
    }

    plain += line[i];
    i += 1;
  }
  flushPlain();
  return nodes;
}

/** Build a single-paragraph ProseMirror doc for one block's inline text. */
function blockParagraphDoc(text: string, plainOnly: boolean): PMNode {
  // Soft line breaks within a block → hard_break nodes.
  const lines = text.split("\n");
  const inline: PMNode[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) inline.push(richTextSchema.node("hard_break"));
    const parsed = plainOnly
      ? line
        ? [richTextSchema.text(line)]
        : []
      : parseInlineMarkdown(line);
    inline.push(...parsed);
  });
  const paragraph = richTextSchema.node("paragraph", { textAlign: null }, inline);
  return richTextSchema.node("doc", null, [paragraph]);
}

/**
 * Encode one block's text as the Yjs state bytes for a Yjs-backed
 * `ComponentNode` (`RichText`, `Heading`, `*ListItem`). The bytes are the
 * `data` argument to the `save_component_yjs_state` reducer.
 *
 * @param text       Inline text for this block. `\n` becomes a soft break.
 * @param plainOnly  Skip inline-markdown parsing and treat `text` literally.
 */
export function richTextBlockToYjsBytes(text: string, plainOnly = false): Uint8Array {
  const pmDoc = blockParagraphDoc(text, plainOnly);
  const ydoc = prosemirrorToYDoc(pmDoc, PROSEMIRROR_FRAGMENT_KEY);
  try {
    return Y.encodeStateAsUpdate(ydoc);
  } finally {
    ydoc.destroy();
  }
}

// ── Markdown document → component block specs ──────────────────────────────────

/** A component-tree block the orchestration layer will create + fill. */
export interface ComponentBlockSpec {
  /** Registered `ComponentTypeDefinition.component_type`. */
  componentType:
    | "RichText"
    | "Heading"
    | "BulletListItem"
    | "NumberedListItem"
    | "ChecklistItem";
  /** Structural props (JSON-serialized by the caller). `{}` for RichText. */
  props: Record<string, unknown>;
  /** Inline text for the block's Yjs state (empty string allowed). */
  text: string;
}

/**
 * Split a markdown document into an ordered list of component block specs.
 * Each becomes one Yjs-backed `ComponentNode` sibling under the page root.
 *
 * Recognizes: ATX headings (`#`..`######`), bullet items (`-`/`*`/`+`),
 * numbered items (`1.`), checklist items (`- [ ]` / `- [x]`), and paragraphs.
 * Blank lines are separators. Inline marks are preserved (the caller passes
 * `text` to {@link richTextBlockToYjsBytes}).
 */
export function markdownToComponentBlocks(markdown: string): ComponentBlockSpec[] {
  const blocks: ComponentBlockSpec[] = [];
  const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") continue;

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        componentType: "Heading",
        props: { level: heading[1].length },
        text: heading[2].trim(),
      });
      continue;
    }

    const checklist = /^[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (checklist) {
      blocks.push({
        componentType: "ChecklistItem",
        props: { checked: checklist[1].toLowerCase() === "x" },
        text: checklist[2].trim(),
      });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({
        componentType: "BulletListItem",
        props: {},
        text: bullet[1].trim(),
      });
      continue;
    }

    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push({
        componentType: "NumberedListItem",
        props: {},
        text: numbered[1].trim(),
      });
      continue;
    }

    blocks.push({ componentType: "RichText", props: {}, text: line.trim() });
  }

  return blocks;
}
