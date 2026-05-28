import * as Y from "yjs";

/**
 * Render a `Y.Doc` holding a ProseMirror-shaped `Y.XmlFragment` to a static
 * HTML string. Used by:
 *
 * 1. Sprint 1 read-only `<RichText>` renderer — no prosemirror mount, just
 *    paint the current text.
 * 2. Sprint 2 viewport-aware mounting (`docs/PEAR_WEB_RENDERER.md` §
 *    Performance) — off-screen RichText blocks render through this path
 *    instead of mounting a full `y-prosemirror` view.
 *
 * The XmlFragment shape matches what `y-prosemirror` writes: a sequence of
 * block-level nodes (`paragraph`, `heading_*`, etc.) containing inline text
 * with mark attributes. v1's mark vocabulary is bold / italic / underline /
 * strikethrough / inline code / link — anything else is rendered without
 * its mark, with a single console warning per unknown mark per session.
 *
 * This is intentionally a hand-rolled small walker, not a `prosemirror-model`
 * + `DOMSerializer` round-trip — sprint 1 must work without pulling in any
 * ProseMirror dependency, and the read-only path stays cheap for the
 * many-block-off-screen case in sprint 2.
 */

/** Yjs key the prosemirror plugin uses by default. */
const FRAGMENT_KEY = "prosemirror";

/**
 * Render the doc's primary prosemirror fragment to an HTML string. Returns
 * an empty string when the fragment is absent or empty — callers should
 * render a placeholder (or nothing) at the caller layer.
 */
export function yDocToHtml(doc: Y.Doc): string {
  const frag = doc.get(FRAGMENT_KEY, Y.XmlFragment) as Y.XmlFragment;
  return renderFragment(frag);
}

/** Plain text extraction for Turn into… and similar block conversions. */
export function yDocToPlainText(doc: Y.Doc): string {
  const frag = doc.get(FRAGMENT_KEY, Y.XmlFragment) as Y.XmlFragment;
  const blocks: string[] = [];
  for (const child of frag.toArray()) {
    if (child instanceof Y.XmlElement) {
      blocks.push(plainTextFromNode(child));
    } else if (child instanceof Y.XmlText) {
      blocks.push(plainTextFromXmlText(child));
    }
  }
  return blocks.filter((b) => b.length > 0).join("\n");
}

function plainTextFromNode(el: Y.XmlElement): string {
  let out = "";
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) out += plainTextFromXmlText(child);
    else if (child instanceof Y.XmlElement) out += plainTextFromNode(child);
  }
  return out;
}

function plainTextFromXmlText(node: Y.XmlText): string {
  const deltas = node.toDelta() as Array<{ insert: string }>;
  return deltas
    .filter((d) => typeof d.insert === "string")
    .map((d) => d.insert)
    .join("");
}

function renderFragment(frag: Y.XmlFragment): string {
  let out = "";
  for (const child of frag.toArray()) {
    out += renderNode(child);
  }
  return out;
}

function renderNode(node: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (node instanceof Y.XmlText) {
    return renderXmlText(node);
  }
  if (node instanceof Y.XmlElement) {
    return renderXmlElement(node);
  }
  // XmlHook isn't used by y-prosemirror's default schema; render as empty.
  return "";
}

function renderXmlElement(el: Y.XmlElement): string {
  const tag = el.nodeName;
  const children = el.toArray().map(renderNode).join("");

  switch (tag) {
    case "paragraph": {
      const align = el.getAttribute("textAlign");
      const style =
        align === "center" || align === "right"
          ? ` style="text-align:${escapeAttr(align)}"`
          : "";
      return `<p${style}>${children || "<br/>"}</p>`;
    }
    // Heading levels — prosemirror schemas typically emit `heading` with a
    // level attr; some emit heading_1..heading_6. We accept both shapes.
    case "heading": {
      const lvl = clampHeadingLevel(el.getAttribute("level"));
      return `<h${lvl}>${children}</h${lvl}>`;
    }
    case "heading_1":
      return `<h1>${children}</h1>`;
    case "heading_2":
      return `<h2>${children}</h2>`;
    case "heading_3":
      return `<h3>${children}</h3>`;
    case "heading_4":
      return `<h4>${children}</h4>`;
    case "heading_5":
      return `<h5>${children}</h5>`;
    case "heading_6":
      return `<h6>${children}</h6>`;
    case "bullet_list":
    case "bulletList":
      return `<ul>${children}</ul>`;
    case "ordered_list":
    case "orderedList":
      return `<ol>${children}</ol>`;
    case "list_item":
    case "listItem":
      return `<li>${children}</li>`;
    case "blockquote":
      return `<blockquote>${children}</blockquote>`;
    case "code_block":
    case "codeBlock":
      return `<pre><code>${children}</code></pre>`;
    case "hard_break":
    case "hardBreak":
      return "<br/>";
    case "horizontal_rule":
    case "horizontalRule":
      return "<hr/>";
    default: {
      // Unknown block — render contents inside a span so we don't lose
      // text. Log once per session to surface registry/mark schema drift.
      warnOnce(`Unknown block node "${tag}" rendered as <span>.`);
      return `<span>${children}</span>`;
    }
  }
}

/**
 * Render a single `Y.XmlText` (an inline run with marks). The y-prosemirror
 * encoding stores marks as a delta-like attribute map at each "format
 * change" point. We walk the deltas, opening/closing tags per the v1 mark
 * vocabulary declared in `docs/PEAR_WEB_RENDERER.md` § Editor stack.
 */
function renderXmlText(node: Y.XmlText): string {
  const deltas = node.toDelta() as Array<{
    insert: string;
    attributes?: Record<string, unknown>;
  }>;
  let out = "";
  for (const d of deltas) {
    if (typeof d.insert !== "string") continue;
    const marks = d.attributes ?? {};
    const open: string[] = [];
    const close: string[] = [];
    // Order matters for nesting parity — open in this order, close in
    // reverse. Link is the outermost wrapper so semantic anchors are
    // preserved across format runs that share the same href.
    if (marks.link && typeof (marks.link as { href?: string }).href === "string") {
      const href = (marks.link as { href: string }).href;
      open.push(`<a href="${escapeAttr(href)}">`);
      close.unshift("</a>");
    } else if (typeof marks.link === "string") {
      open.push(`<a href="${escapeAttr(marks.link)}">`);
      close.unshift("</a>");
    }
    if (marks.bold) {
      open.push("<strong>");
      close.unshift("</strong>");
    }
    if (marks.italic) {
      open.push("<em>");
      close.unshift("</em>");
    }
    if (marks.underline) {
      open.push("<u>");
      close.unshift("</u>");
    }
    if (marks.strike || marks.strikethrough) {
      open.push("<s>");
      close.unshift("</s>");
    }
    if (marks.code) {
      open.push("<code>");
      close.unshift("</code>");
    }
    const textColor = readColorMark(marks.textColor, "color");
    if (textColor) {
      open.push(`<span style="color:${escapeAttr(textColor)}">`);
      close.unshift("</span>");
    }
    const bgColor = readColorMark(marks.backgroundColor, "backgroundColor");
    if (bgColor) {
      open.push(`<span style="background-color:${escapeAttr(bgColor)}">`);
      close.unshift("</span>");
    }
    out += open.join("") + escapeText(d.insert) + close.join("");
  }
  return out;
}

function readColorMark(
  raw: unknown,
  key: "color" | "backgroundColor",
): string | null {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (raw && typeof raw === "object" && key in raw) {
    const v = (raw as Record<string, unknown>)[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  return null;
}

function clampHeadingLevel(raw: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > 6) return 6;
  return Math.floor(n) as 1 | 2 | 3 | 4 | 5 | 6;
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  if (typeof console !== "undefined") {
    console.warn(`[yDocToHtml] ${message}`);
  }
}
