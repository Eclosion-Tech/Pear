import { describe, expect, it } from "vitest";
import { resolveHeadingEnter } from "../heading/headingEnter";
import { makeTree, node } from "../test/fixtures";

describe("resolveHeadingEnter", () => {
  it("inserts sibling below when heading has no section", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
    ]);

    expect(resolveHeadingEnter(tree, node(tree, 2))).toEqual({
      kind: "insert-sibling",
      parentId: 1n,
      afterSiblingId: 2n,
    });
  });

  it("appends to section body when children exist", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
      { id: 4, type: "RichText", parent: 2, order: 2 },
    ]);

    expect(resolveHeadingEnter(tree, node(tree, 2))).toEqual({
      kind: "append-section",
      headingId: 2n,
      afterChildId: 3n,
    });
  });

  it("returns null for root-level headings", () => {
    const tree = makeTree([{ id: 2, type: "Heading", parent: null }]);
    expect(resolveHeadingEnter(tree, node(tree, 2))).toBeNull();
  });
});
