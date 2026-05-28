import { describe, expect, it } from "vitest";
import {
  flattenDocumentBlocks,
  getBlockSibling,
  getDocumentNextBlock,
  getDocumentPrevBlock,
  isAtDocEnd,
  isAtDocStart,
  resolveNestTarget,
  deepestNestableBlock,
} from "../navigation/blockNavigation";
import { makeTree, node } from "../test/fixtures";

describe("flattenDocumentBlocks", () => {
  it("walks depth-first under the container root", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
      { id: 4, type: "RichText", parent: 1 },
    ]);

    expect(flattenDocumentBlocks(tree).map((n) => Number(n.id))).toEqual([
      2, 3, 4,
    ]);
  });
});

describe("getDocumentPrevBlock / getDocumentNextBlock", () => {
  const tree = makeTree([
    { id: 1, type: "Container", parent: null },
    { id: 2, type: "RichText", parent: 1 },
    { id: 3, type: "BulletListItem", parent: 1 },
    { id: 4, type: "RichText", parent: 3 },
    { id: 5, type: "RichText", parent: 1 },
  ]);

  it("uses document order, not same-parent siblings only", () => {
    const nested = node(tree, 4);
    expect(getDocumentPrevBlock(tree, nested.id)?.id).toBe(3n);
    expect(getDocumentNextBlock(tree, nested.id)?.id).toBe(5n);
  });

  it("walks from heading through section children", () => {
    const sectionTree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
      { id: 4, type: "RichText", parent: 1 },
    ]);

    expect(getDocumentNextBlock(sectionTree, 2n)?.id).toBe(3n);
    expect(getDocumentNextBlock(sectionTree, 3n)?.id).toBe(4n);
    expect(getDocumentPrevBlock(sectionTree, 4n)?.id).toBe(3n);
  });
});

describe("getBlockSibling", () => {
  it("returns adjacent siblings under the same parent", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "RichText", parent: 1 },
      { id: 3, type: "RichText", parent: 1 },
    ]);

    expect(getBlockSibling(tree, 3n, "prev")?.id).toBe(2n);
    expect(getBlockSibling(tree, 2n, "next")?.id).toBe(3n);
  });
});

describe("resolveNestTarget", () => {
  it("nests under previous bullet list item", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "BulletListItem", parent: 1 },
      { id: 3, type: "BulletListItem", parent: 1 },
    ]);

    const target = resolveNestTarget(node(tree, 3), tree);
    expect(target?.id).toBe(2n);
  });

  it("nests under heading when tabbing from sibling below", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 1 },
    ]);

    const target = resolveNestTarget(node(tree, 3), tree);
    expect(target?.id).toBe(2n);
  });

  it("nests under deepest point of previous list stack", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "BulletListItem", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
      { id: 4, type: "BulletListItem", parent: 1 },
    ]);

    expect(deepestNestableBlock(node(tree, 2), tree).id).toBe(3n);
    const target = resolveNestTarget(node(tree, 4), tree);
    expect(target?.id).toBe(3n);
  });
});

describe("isAtDocStart / isAtDocEnd", () => {
  it("detects boundary positions in a single-paragraph doc", () => {
    const docEnd = 7;
    expect(isAtDocStart(docEnd, 1)).toBe(true);
    expect(isAtDocEnd(docEnd, docEnd - 1)).toBe(true);
    expect(isAtDocStart(docEnd, 3)).toBe(false);
  });
});
