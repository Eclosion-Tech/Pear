/**
 * Markdown → BlockNote JSON for legacy `PageContentFormat::BlockNote` pages
 * (the `update_page_content` reducer's content blob). Copy of the pure
 * converter in worker/src/tools.ts — BlockNote is being phased out, so the
 * duplication is scoped to this shrinking legacy path.
 */

let _blockIdCounter = 1;
function blockId(): string {
  return `ai-${(_blockIdCounter++).toString(36)}`;
}

function makeInline(text: string) {
  return [{ type: "text", text, styles: {} }];
}

function defaultProps(extra: Record<string, unknown> = {}) {
  return { textColor: "default", backgroundColor: "default", textAlignment: "left", ...extra };
}

/**
 * Convert a markdown string to a BlockNote JSON array.
 * Supports: headings (#/##/###), bullet lists (- / * / +), numbered lists,
 * horizontal rules (---), and plain paragraphs.
 */
export function markdownToBlockNote(markdown: string | undefined | null): string {
  if (!markdown) return JSON.stringify([]);
  const lines = markdown.split("\n");
  const blocks: unknown[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)/);
    if (headingMatch) {
      blocks.push({
        id: blockId(), type: "heading",
        props: defaultProps({ level: headingMatch[1].length }),
        content: makeInline(headingMatch[2]),
        children: [],
      });
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*+]\s+(.*)/);
    if (bulletMatch) {
      blocks.push({
        id: blockId(), type: "bulletListItem",
        props: defaultProps(),
        content: makeInline(bulletMatch[1]),
        children: [],
      });
      continue;
    }

    const numberedMatch = trimmed.match(/^\d+\.\s+(.*)/);
    if (numberedMatch) {
      blocks.push({
        id: blockId(), type: "numberedListItem",
        props: defaultProps(),
        content: makeInline(numberedMatch[1]),
        children: [],
      });
      continue;
    }

    // Horizontal rule → empty paragraph (BlockNote has no HR type)
    if (/^---+$/.test(trimmed)) {
      blocks.push({ id: blockId(), type: "paragraph", props: defaultProps(), content: [], children: [] });
      continue;
    }

    if (trimmed === "") continue;

    blocks.push({
      id: blockId(), type: "paragraph",
      props: defaultProps(),
      content: makeInline(trimmed),
      children: [],
    });
  }

  return JSON.stringify(blocks);
}
