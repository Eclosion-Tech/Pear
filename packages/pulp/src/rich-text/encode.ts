/**
 * Headless encoder for ComponentTree rich text (markdown → Yjs bytes).
 *
 * Doc pages store content as `ComponentNode` rows (assessment #27). The
 * text of a Yjs-backed node (`RichText`, `Heading`, `*ListItem`) lives in a
 * per-node `ComponentYjsState` blob — `Y.encodeStateAsUpdate(ydoc)` of a
 * `y-prosemirror`-shaped `Y.Doc`. Programmatic authors (the pear worker's
 * chat tools, the stateless MCP core) must produce those bytes encoded
 * against pulp's exact ProseMirror schema so they round-trip in the live
 * editor — which is why the encoder lives here, next to `richTextSchema`.
 *
 * No React surface is pulled in; this module is safe for headless runtimes
 * (Node, Cloudflare Workers). The block-level shape is FLAT — a RichText doc
 * is a single paragraph of inline runs; headings / list items are separate
 * `ComponentNode`s, not block nodes inside the doc (see `richTextSchema.ts`).
 */

import * as Y from "yjs";
import { prosemirrorToYDoc } from "y-prosemirror";
import type { Node as PMNode, Mark } from "prosemirror-model";
import { richTextSchema, PROSEMIRROR_FRAGMENT_KEY } from "./richTextSchema";

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
    // Underscore emphasis follows CommonMark's flanking rule: a `_` run
    // cannot open when preceded by a word character, and cannot close when
    // followed by one. Without this, intra-word underscores pair across
    // arbitrary spans and silently eat technical text — `prod_pear_cloud`
    // became "prod" + italic("pear") + "cloud" (ticket 212).
    const underscoreCanOpen = i === 0 || !/[A-Za-z0-9_]/.test(line[i - 1]);

    // Bold: **text** / __text__ (content must not begin or end with a space —
    // `2 ** 3 ** 4` is arithmetic, not emphasis)
    const bold = /^\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/.exec(rest);
    if (bold) {
      flushPlain();
      pushMarked(bold[1], richTextSchema.marks.bold.create());
      i += bold[0].length;
      continue;
    }
    const boldUnderscore = underscoreCanOpen
      ? /^__([^\s_](?:[^_]*[^\s_])?)__(?![A-Za-z0-9_])/.exec(rest)
      : null;
    if (boldUnderscore) {
      flushPlain();
      pushMarked(boldUnderscore[1], richTextSchema.marks.bold.create());
      i += boldUnderscore[0].length;
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
    // Italic: *text* (intra-word `*` is legal markdown) or _text_ (flanking
    // rules above). Content must not begin or end with a space.
    const italicStar = /^\*([^\s*](?:[^*]*[^\s*])?)\*/.exec(rest);
    if (italicStar) {
      flushPlain();
      pushMarked(italicStar[1], richTextSchema.marks.italic.create());
      i += italicStar[0].length;
      continue;
    }
    const italicUnderscore = underscoreCanOpen
      ? /^_([^\s_](?:[^_]*[^\s_])?)_(?![A-Za-z0-9_])/.exec(rest)
      : null;
    if (italicUnderscore) {
      flushPlain();
      pushMarked(italicUnderscore[1], richTextSchema.marks.italic.create());
      i += italicUnderscore[0].length;
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
    | "ChecklistItem"
    | "MarkdownTable";
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
 * numbered items (`1.`), checklist items (`- [ ]` / `- [x]`), GFM tables,
 * and paragraphs.
 * Blank lines are separators. Inline marks are preserved (the caller passes
 * `text` to {@link richTextBlockToYjsBytes}).
 */
export function markdownToComponentBlocks(markdown: string): ComponentBlockSpec[] {
  const blocks: ComponentBlockSpec[] = [];
  const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const table = parseGfmTable(lines, i);
    if (table) {
      blocks.push({
        componentType: "MarkdownTable",
        props: {
          headers: table.headers,
          rows: table.rows,
          alignments: table.alignments,
        },
        text: "",
      });
      i = table.lastLine;
      continue;
    }

    const rawLine = lines[i];
    // Leading indentation is dropped: the batched doc-write reducer is flat
    // (siblings under the root), so a nested markdown item becomes a sibling
    // item rather than a paragraph reading "- child" (the old behaviour —
    // the list marker only matched at column 0). True parent/child nesting
    // on write is a reducer change; see the FileBlock/read_file ticket.
    const line = rawLine.trimEnd().replace(/^[ \t]+/, "");
    if (line === "") continue;

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

function splitGfmRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === "\\" && (body[index + 1] === "|" || body[index + 1] === "\\")) {
      cell += body[index + 1];
      index++;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseGfmTable(
  lines: string[],
  start: number,
): {
  headers: string[];
  rows: string[][];
  alignments: Array<"left" | "center" | "right">;
  lastLine: number;
} | null {
  if (start + 1 >= lines.length) return null;
  const headers = splitGfmRow(lines[start]);
  const delimiters = splitGfmRow(lines[start + 1]);
  if (
    !headers ||
    !delimiters ||
    headers.length === 0 ||
    delimiters.length !== headers.length ||
    !delimiters.every((cell) => /^:?-{3,}:?$/.test(cell))
  ) {
    return null;
  }

  const alignments = delimiters.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center" as const;
    if (cell.endsWith(":")) return "right" as const;
    return "left" as const;
  });
  const rows: string[][] = [];
  let lastLine = start + 1;
  for (let i = start + 2; i < lines.length; i++) {
    if (!lines[i].trim()) break;
    const cells = splitGfmRow(lines[i]);
    if (!cells) break;
    rows.push(headers.map((_, index) => cells[index] ?? ""));
    lastLine = i;
  }
  return { headers, rows, alignments, lastLine };
}

/** Reconstruct a stored MarkdownTable's props as canonical GFM markdown. */
export function markdownTablePropsToMarkdown(raw: unknown): string | undefined {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object") return undefined;
    const props = value as Record<string, unknown>;
    if (!Array.isArray(props.headers) || props.headers.length === 0) return undefined;
    const headers = props.headers.map((cell) => escapeGfmCell(String(cell)));
    const alignments = headers.map((_, index) => {
      const alignment = Array.isArray(props.alignments) ? props.alignments[index] : "left";
      if (alignment === "center") return ":---:";
      if (alignment === "right") return "---:";
      return "---";
    });
    const rows = Array.isArray(props.rows)
      ? props.rows.map((row) =>
          headers.map((_, index) =>
            escapeGfmCell(String(Array.isArray(row) ? row[index] ?? "" : "")),
          ),
        )
      : [];
    return [headers, alignments, ...rows]
      .map((row) => `| ${row.join(" | ")} |`)
      .join("\n");
  } catch {
    return undefined;
  }
}

function escapeGfmCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}
