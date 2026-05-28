import * as Y from "yjs";
import { DOMParser as PMDOMParser } from "prosemirror-model";
import { prosemirrorToYDoc } from "y-prosemirror";
import { richTextSchema, PROSEMIRROR_FRAGMENT_KEY } from "./richTextSchema";
import { plainTextToYDoc } from "./richTextFormatting";
import { matchMarkdownShortcut, type MarkdownShortcut } from "./markdownInputRules";

/**
 * Split a clipboard payload into block descriptors so a multi-paragraph /
 * markdown / HTML paste becomes multiple blocks (Notion / BlockNote) rather
 * than landing in one. Each descriptor carries a Y.Doc seed for the new block.
 *
 *   - **HTML** (when present): top-level block elements map to types —
 *     `<h1..3>` → Heading, `<li>` → Bullet/Numbered list item, else RichText —
 *     and PM `DOMParser` preserves inline marks (bold / links / …).
 *   - **Plain text**: split on newlines; each line's leading markdown token
 *     (`- `, `# `, `[] `, …) maps to a type via the same shortcut table.
 *
 * `availableTypes` gates the mapping — unregistered targets fall back to
 * RichText. Returns [] when there's nothing meaningful to paste.
 */
export type PastedBlock = {
  componentType: string;
  props: Record<string, unknown>;
  doc: Y.Doc;
};

export type ParseClipboardOpts = {
  shortcuts: MarkdownShortcut[];
  availableTypes: Set<string>;
};

export function parseClipboardToBlocks(
  data: { text: string; html?: string },
  opts: ParseClipboardOpts,
): PastedBlock[] {
  const fromHtml = data.html?.trim() ? parseHtml(data.html, opts) : [];
  if (fromHtml.length > 0) return fromHtml;
  return parsePlainText(data.text, opts);
}

function parsePlainText(text: string, opts: ParseClipboardOpts): PastedBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: PastedBlock[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") continue;
    blocks.push(blockFromTextLine(line, opts));
  }
  return blocks;
}

function blockFromTextLine(line: string, opts: ParseClipboardOpts): PastedBlock {
  const m = /^(\S+)\s+(.*)$/.exec(line);
  if (m) {
    const item = matchMarkdownShortcut(m[1], opts.shortcuts);
    if (item && opts.availableTypes.has(item.componentType)) {
      return {
        componentType: item.componentType,
        props: { ...item.defaultProps },
        doc: plainTextToYDoc(m[2]),
      };
    }
  }
  return { componentType: "RichText", props: {}, doc: plainTextToYDoc(line) };
}

function parseHtml(html: string, opts: ParseClipboardOpts): PastedBlock[] {
  if (typeof DOMParser === "undefined") return [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return [];
  }

  const elements = collectBlockElements(doc.body);
  const blocks: PastedBlock[] = [];
  for (const el of elements) {
    const block = blockFromElement(el, opts);
    if (block) blocks.push(block);
  }
  return blocks;
}

const BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "BLOCKQUOTE",
  "DIV",
]);

/** Flatten the body into a list of leaf block elements (lists → their items). */
function collectBlockElements(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toUpperCase();
      if (tag === "UL" || tag === "OL") {
        walk(child);
      } else if (BLOCK_TAGS.has(tag)) {
        out.push(child as HTMLElement);
      }
    }
  };
  walk(root);
  return out;
}

function blockFromElement(
  el: HTMLElement,
  opts: ParseClipboardOpts,
): PastedBlock | null {
  if (el.textContent?.trim() === "" && el.querySelector("br") == null) {
    return null;
  }
  const { componentType, props } = typeForElement(el, opts.availableTypes);
  return { componentType, props, doc: inlineDocFromElement(el) };
}

function typeForElement(
  el: HTMLElement,
  available: Set<string>,
): { componentType: string; props: Record<string, unknown> } {
  const tag = el.tagName.toUpperCase();
  const headingMatch = /^H([1-6])$/.exec(tag);
  if (headingMatch && available.has("Heading")) {
    const level = Math.min(3, Number(headingMatch[1]));
    return { componentType: "Heading", props: { level } };
  }
  if (tag === "LI") {
    const ordered = el.closest("ol") != null;
    const type = ordered ? "NumberedListItem" : "BulletListItem";
    if (available.has(type)) return { componentType: type, props: {} };
  }
  return { componentType: "RichText", props: {} };
}

/** Parse an element's inline content into a Y.Doc (marks preserved). */
function inlineDocFromElement(el: HTMLElement): Y.Doc {
  try {
    const pmDoc = PMDOMParser.fromSchema(richTextSchema).parse(el);
    return prosemirrorToYDoc(pmDoc, PROSEMIRROR_FRAGMENT_KEY);
  } catch {
    return plainTextToYDoc(el.textContent ?? "");
  }
}
