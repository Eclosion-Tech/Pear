import { Schema, type DOMOutputSpec } from "prosemirror-model";

/**
 * Pear's v1 web ProseMirror schema for `RichText` component nodes.
 *
 * Per `docs/PEAR_WEB_RENDERER.md` § Editor stack — Mark schema, the v1 mark
 * vocabulary is: bold / italic / underline / strikethrough / inline code /
 * link. The block-level shape is **flat** — a `RichText` doc is a sequence
 * of `paragraph` ProseMirror nodes plus `hard_break` for soft line breaks.
 * Headings, lists, images, etc. live at the `ComponentNode` level as
 * siblings of the `RichText`, not as block nodes inside it.
 *
 * This schema is hand-aligned with the encoding produced by
 * `@eclosion-tech/react-native-yjs-text` v0.1; sharing the schema as an
 * npm package (`@eclosion-tech/yjs-text-schema`) is parent-ADR Open Q #4
 * and deferred — by hand alignment is the v1 contract.
 *
 * Mark order is significant for nesting: link is the outermost wrapper so
 * `<a>` anchors stay contiguous across mark changes; the rest follow the
 * HTML-rendering order used by `lib/yjsToHtml.ts` (`<strong>`, `<em>`,
 * `<u>`, `<s>`, `<code>`).
 */

const emDOM: DOMOutputSpec = ["em", 0];
const strongDOM: DOMOutputSpec = ["strong", 0];
const underlineDOM: DOMOutputSpec = ["u", 0];
const strikeDOM: DOMOutputSpec = ["s", 0];
const codeDOM: DOMOutputSpec = ["code", 0];

export const richTextSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    text: {
      group: "inline",
    },
    hard_break: {
      group: "inline",
      inline: true,
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
  },
  marks: {
    // Order matters — see comment above. ProseMirror applies marks in
    // schema declaration order when rendering, so `link` declared first
    // becomes the outermost tag.
    link: {
      attrs: {
        href: { default: "" },
        title: { default: null as string | null },
      },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom) => ({
            href: (dom as HTMLAnchorElement).getAttribute("href") ?? "",
            title: (dom as HTMLAnchorElement).getAttribute("title"),
          }),
        },
      ],
      toDOM: (mark) => [
        "a",
        {
          href: mark.attrs.href as string,
          title: (mark.attrs.title as string | null) ?? "",
          draggable: "false",
          rel: "noopener noreferrer",
        },
        0,
      ],
    },
    bold: {
      parseDOM: [
        { tag: "strong" },
        { tag: "b" },
        { style: "font-weight=bold" },
        { style: "font-weight=700" },
      ],
      toDOM: () => strongDOM,
    },
    italic: {
      parseDOM: [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }],
      toDOM: () => emDOM,
    },
    underline: {
      parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
      toDOM: () => underlineDOM,
    },
    strike: {
      parseDOM: [
        { tag: "s" },
        { tag: "del" },
        { style: "text-decoration=line-through" },
      ],
      toDOM: () => strikeDOM,
    },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: () => codeDOM,
    },
  },
});

/**
 * Yjs key the prosemirror plugin uses by default. Kept aligned with
 * `lib/yjsToHtml.ts`'s `FRAGMENT_KEY` so both render paths read the same
 * Yjs slot.
 */
export const PROSEMIRROR_FRAGMENT_KEY = "prosemirror";
