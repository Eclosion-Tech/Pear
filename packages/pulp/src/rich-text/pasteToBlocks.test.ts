import { describe, expect, it } from "vitest";
import { parseClipboardToBlocks } from "./pasteToBlocks";
import { buildMarkdownShortcuts } from "./markdownInputRules";
import { yDocToPlainText, yDocToHtml } from "./yjsToHtml";
import type { SlashMenuItem } from "../SlashMenu";

const ITEMS: SlashMenuItem[] = [
  { id: "t", label: "Text", description: "", componentType: "RichText", defaultProps: {}, searchTokens: [] },
  { id: "h1", label: "H1", description: "", componentType: "Heading", defaultProps: { level: 1 }, searchTokens: [] },
  { id: "h2", label: "H2", description: "", componentType: "Heading", defaultProps: { level: 2 }, searchTokens: [] },
  { id: "h3", label: "H3", description: "", componentType: "Heading", defaultProps: { level: 3 }, searchTokens: [] },
  { id: "b", label: "Bullet", description: "", componentType: "BulletListItem", defaultProps: {}, searchTokens: [] },
];

const OPTS = {
  shortcuts: buildMarkdownShortcuts(ITEMS),
  availableTypes: new Set([
    "RichText",
    "Heading",
    "BulletListItem",
    "NumberedListItem",
  ]),
};

describe("parseClipboardToBlocks — plain text", () => {
  it("splits multiple paragraphs into RichText blocks", () => {
    const blocks = parseClipboardToBlocks({ text: "one\ntwo\nthree" }, OPTS);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.componentType)).toEqual([
      "RichText",
      "RichText",
      "RichText",
    ]);
    expect(blocks.map((b) => yDocToPlainText(b.doc))).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("maps markdown line prefixes to block types and strips the prefix", () => {
    const blocks = parseClipboardToBlocks(
      { text: "# Title\n- first\n- second\nbody" },
      OPTS,
    );
    expect(blocks.map((b) => b.componentType)).toEqual([
      "Heading",
      "BulletListItem",
      "BulletListItem",
      "RichText",
    ]);
    expect(blocks[0].props.level).toBe(1);
    expect(yDocToPlainText(blocks[0].doc)).toBe("Title");
    expect(yDocToPlainText(blocks[1].doc)).toBe("first");
  });

  it("skips blank lines", () => {
    const blocks = parseClipboardToBlocks({ text: "a\n\n\nb" }, OPTS);
    expect(blocks.map((b) => yDocToPlainText(b.doc))).toEqual(["a", "b"]);
  });
});

describe("parseClipboardToBlocks — HTML", () => {
  it("maps headings and paragraphs, preserving inline marks", () => {
    const html = "<h2>Heading</h2><p>plain <strong>bold</strong></p>";
    const blocks = parseClipboardToBlocks({ text: "Heading\nplain bold", html }, OPTS);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].componentType).toBe("Heading");
    expect(blocks[0].props.level).toBe(2);
    expect(blocks[1].componentType).toBe("RichText");
    expect(yDocToHtml(blocks[1].doc)).toContain("<strong>");
  });

  it("maps list items to list-item blocks", () => {
    const html = "<ul><li>one</li><li>two</li></ul>";
    const blocks = parseClipboardToBlocks({ text: "one\ntwo", html }, OPTS);
    expect(blocks.map((b) => b.componentType)).toEqual([
      "BulletListItem",
      "BulletListItem",
    ]);
  });
});
