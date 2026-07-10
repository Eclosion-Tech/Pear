/**
 * Round-trip tests for the ComponentTree rich-text encoder (assessment #27).
 *
 * The encoder produces Yjs bytes; we decode them with pulp's own
 * `yDocToPlainText` / `yDocToHtml` (the live read-only render path) and assert
 * the text/marks survive. This proves the worker's bytes are editor-compatible
 * without needing a running SpacetimeDB.
 *
 * Run: pulp vitest (`pnpm --filter @eclosion-tech/pulp test`).
 */

import { test } from "vitest";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { yDocToPlainText, yDocToHtml } from "./yjsToHtml";
import {
  richTextBlockToYjsBytes,
  parseInlineMarkdown,
  markdownToComponentBlocks,
  markdownTablePropsToMarkdown,
} from "./encode";

function decode(bytes: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}

test("plain text round-trips through the editor read path", () => {
  const bytes = richTextBlockToYjsBytes("Hello world", true);
  assert.equal(yDocToPlainText(decode(bytes)), "Hello world");
});

test("plainOnly does not interpret markdown markers", () => {
  const bytes = richTextBlockToYjsBytes("see **not bold** here", true);
  assert.equal(yDocToPlainText(decode(bytes)), "see **not bold** here");
  // No <strong> emitted when plainOnly.
  assert.ok(!yDocToHtml(decode(bytes)).includes("<strong>"));
});

test("soft line breaks become hard_break, text preserved", () => {
  const bytes = richTextBlockToYjsBytes("line one\nline two", true);
  assert.equal(yDocToPlainText(decode(bytes)), "line oneline two");
  assert.ok(yDocToHtml(decode(bytes)).includes("<br/>"));
});

test("bold inline markdown produces a bold mark", () => {
  const html = yDocToHtml(decode(richTextBlockToYjsBytes("a **bold** b")));
  assert.ok(html.includes("<strong>bold</strong>"), html);
  assert.equal(yDocToPlainText(decode(richTextBlockToYjsBytes("a **bold** b"))), "a bold b");
});

test("italic, code, and link marks survive", () => {
  const italic = yDocToHtml(decode(richTextBlockToYjsBytes("an *em* word")));
  assert.ok(italic.includes("<em>em</em>"), italic);

  const code = yDocToHtml(decode(richTextBlockToYjsBytes("call `fn()` now")));
  assert.ok(code.includes("<code>fn()</code>"), code);

  const link = yDocToHtml(
    decode(richTextBlockToYjsBytes("see [docs](https://example.com)")),
  );
  assert.ok(link.includes('href="https://example.com"'), link);
  assert.ok(link.includes(">docs</a>"), link);
});

test("empty text yields an empty paragraph (no crash)", () => {
  const bytes = richTextBlockToYjsBytes("", true);
  assert.equal(yDocToPlainText(decode(bytes)), "");
});

test("parseInlineMarkdown leaves unmatched markers literal", () => {
  const nodes = parseInlineMarkdown("a * lone star");
  const text = nodes.map((n) => n.textContent).join("");
  assert.equal(text, "a * lone star");
});

// ── markdownToComponentBlocks ──────────────────────────────────────────────────

test("headings map to Heading with level", () => {
  const blocks = markdownToComponentBlocks("# Title\n## Sub");
  assert.deepEqual(
    blocks.map((b) => [b.componentType, b.props.level, b.text]),
    [
      ["Heading", 1, "Title"],
      ["Heading", 2, "Sub"],
    ],
  );
});

test("bullets, numbers, and checklists are distinguished", () => {
  const blocks = markdownToComponentBlocks(
    "- a\n1. b\n- [ ] c\n- [x] d",
  );
  assert.deepEqual(
    blocks.map((b) => [b.componentType, b.props.checked ?? null, b.text]),
    [
      ["BulletListItem", null, "a"],
      ["NumberedListItem", null, "b"],
      ["ChecklistItem", false, "c"],
      ["ChecklistItem", true, "d"],
    ],
  );
});

test("blank lines separate paragraphs; prose becomes RichText", () => {
  const blocks = markdownToComponentBlocks("para one\n\npara two");
  assert.deepEqual(
    blocks.map((b) => [b.componentType, b.text]),
    [
      ["RichText", "para one"],
      ["RichText", "para two"],
    ],
  );
});

test("GFM tables become one static MarkdownTable component (#197)", () => {
  const blocks = markdownToComponentBlocks(
    "Before\n\n| Name | Score | Note |\n| :--- | ---: | :---: |\n| Pear | 10 | fast \\| safe |\n| Pulp | 9 | tidy |\n\nAfter",
  );
  assert.deepEqual(blocks.map((block) => block.componentType), [
    "RichText",
    "MarkdownTable",
    "RichText",
  ]);
  assert.deepEqual(blocks[1].props, {
    headers: ["Name", "Score", "Note"],
    rows: [
      ["Pear", "10", "fast | safe"],
      ["Pulp", "9", "tidy"],
    ],
    alignments: ["left", "right", "center"],
  });
  assert.equal(
    markdownTablePropsToMarkdown(blocks[1].props),
    "| Name | Score | Note |\n| --- | ---: | :---: |\n| Pear | 10 | fast \\| safe |\n| Pulp | 9 | tidy |",
  );
});
