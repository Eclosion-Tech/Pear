import { describe, expect, it } from "vitest";
import { blockNoteInlineToYDoc } from "./blockNoteInline";
import {
  convertBlockNoteDocument,
  isBlockNoteListBlock,
  type BlockNoteBlock,
} from "./blockNoteToComponentTree";
import { yDocToHtml, yDocToPlainText } from "../rich-text/yjsToHtml";

function bnBlock(
  partial: Partial<BlockNoteBlock> & Pick<BlockNoteBlock, "id" | "type">,
): BlockNoteBlock {
  return {
    props: {},
    content: [],
    children: [],
    ...partial,
  };
}

function textContent(text: string) {
  return [{ type: "text" as const, text, styles: {} }];
}

function parentIndex(
  nodes: ReturnType<typeof convertBlockNoteDocument>,
): Map<string, string | null> {
  return new Map(nodes.map((n) => [n.sourceBlockId, n.parentSourceBlockId]));
}

describe("blockNoteInlineToYDoc", () => {
  it("preserves inline marks and alignment", () => {
    const doc = blockNoteInlineToYDoc(
      [
        { type: "text", text: "plain ", styles: {} },
        { type: "text", text: "bold", styles: { bold: true } },
      ],
      "center",
    );
    expect(yDocToPlainText(doc)).toBe("plain bold");
    expect(yDocToHtml(doc)).toContain("<strong>");
    expect(yDocToHtml(doc)).toContain("text-align:center");
  });

  it("maps BlockNote named colors to hex marks", () => {
    const doc = blockNoteInlineToYDoc([
      { type: "text", text: "red", styles: { textColor: "red" } },
    ]);
    expect(yDocToHtml(doc)).toContain("#e03e3e");
  });
});

describe("convertBlockNoteDocument — document lists (DF-007)", () => {
  it("maps flat bullet items to siblings under the page root", () => {
    const blocks: BlockNoteBlock[] = [
      bnBlock({ id: "a", type: "bulletListItem", content: textContent("one") }),
      bnBlock({ id: "b", type: "bulletListItem", content: textContent("two") }),
    ];
    const out = convertBlockNoteDocument(blocks);
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.componentType)).toEqual([
      "BulletListItem",
      "BulletListItem",
    ]);
    expect(out.every((n) => n.parentSourceBlockId === null)).toBe(true);
    expect(out[0].siblingIndex).toBe(0);
    expect(out[1].siblingIndex).toBe(1);
  });

  it("nests BlockNote children under the parent list item", () => {
    const blocks: BlockNoteBlock[] = [
      bnBlock({
        id: "parent",
        type: "bulletListItem",
        content: textContent("parent"),
        children: [
          bnBlock({
            id: "child",
            type: "bulletListItem",
            content: textContent("nested"),
          }),
        ],
      }),
    ];
    const out = convertBlockNoteDocument(blocks);
    expect(out).toHaveLength(2);
    const parents = parentIndex(out);
    expect(parents.get("child")).toBe("parent");
    expect(out.find((n) => n.sourceBlockId === "child")?.componentType).toBe(
      "BulletListItem",
    );
  });

  it("preserves three-level nesting and mixed list types", () => {
    const blocks: BlockNoteBlock[] = [
      bnBlock({
        id: "1",
        type: "numberedListItem",
        content: textContent("first"),
        children: [
          bnBlock({
            id: "1a",
            type: "bulletListItem",
            content: textContent("bullet"),
            children: [
              bnBlock({
                id: "1a1",
                type: "checkListItem",
                content: textContent("todo"),
                props: { checked: true },
              }),
            ],
          }),
        ],
      }),
      bnBlock({ id: "2", type: "numberedListItem", content: textContent("second") }),
    ];
    const out = convertBlockNoteDocument(blocks);
    expect(out.map((n) => n.sourceBlockId)).toEqual(["1", "1a", "1a1", "2"]);
    expect(out.find((n) => n.sourceBlockId === "1a1")).toMatchObject({
      componentType: "ChecklistItem",
      props: { checked: true },
      parentSourceBlockId: "1a",
    });
    expect(out.find((n) => n.sourceBlockId === "2")?.parentSourceBlockId).toBe(
      null,
    );
  });

  it("stores list text in yjsUpdate, not as nested RichText children", () => {
    const blocks: BlockNoteBlock[] = [
      bnBlock({
        id: "li",
        type: "bulletListItem",
        content: textContent("item text"),
        children: [
          bnBlock({
            id: "nested",
            type: "bulletListItem",
            content: textContent("nested"),
          }),
        ],
      }),
    ];
    const out = convertBlockNoteDocument(blocks);
    const parent = out.find((n) => n.sourceBlockId === "li")!;
    expect(parent.yjsUpdate).not.toBeNull();
    expect(yDocToPlainText(blockNoteInlineToYDoc(textContent("item text")))).toBe(
      "item text",
    );
    expect(
      out.some(
        (n) =>
          n.parentSourceBlockId === "li" && n.componentType === "RichText",
      ),
    ).toBe(false);
  });

  it("converts nested paragraphs under a list item", () => {
    const blocks: BlockNoteBlock[] = [
      bnBlock({
        id: "li",
        type: "bulletListItem",
        content: textContent("title"),
        children: [
          bnBlock({
            id: "p",
            type: "paragraph",
            content: textContent("body under item"),
          }),
        ],
      }),
    ];
    const out = convertBlockNoteDocument(blocks);
    expect(out.find((n) => n.sourceBlockId === "p")).toMatchObject({
      componentType: "RichText",
      parentSourceBlockId: "li",
    });
  });

  it("keeps numbered siblings in document order for renderer-derived indices", () => {
    const blocks: BlockNoteBlock[] = [
      bnBlock({ id: "n1", type: "numberedListItem", content: textContent("a") }),
      bnBlock({ id: "n2", type: "numberedListItem", content: textContent("b") }),
      bnBlock({ id: "n3", type: "numberedListItem", content: textContent("c") }),
    ];
    const out = convertBlockNoteDocument(blocks);
    expect(out.map((n) => n.siblingIndex)).toEqual([0, 1, 2]);
    expect(out.every((n) => n.componentType === "NumberedListItem")).toBe(true);
  });

  it("identifies BlockNote list block types", () => {
    expect(isBlockNoteListBlock("bulletListItem")).toBe(true);
    expect(isBlockNoteListBlock("paragraph")).toBe(false);
  });
});

describe("convertBlockNoteDocument — mixed documents", () => {
  it("interleaves list items with paragraphs at the root", () => {
    const blocks: BlockNoteBlock[] = [
      bnBlock({ id: "p1", type: "paragraph", content: textContent("intro") }),
      bnBlock({ id: "li", type: "bulletListItem", content: textContent("item") }),
      bnBlock({ id: "p2", type: "paragraph", content: textContent("outro") }),
    ];
    const out = convertBlockNoteDocument(blocks);
    expect(out.map((n) => n.componentType)).toEqual([
      "RichText",
      "BulletListItem",
      "RichText",
    ]);
  });
});
