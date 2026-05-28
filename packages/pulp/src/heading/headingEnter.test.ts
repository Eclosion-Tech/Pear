import { describe, expect, it } from "vitest";
import { isHeadingSection, resolveHeadingEnter } from "../heading/headingEnter";
import { makeTree, node } from "../test/fixtures";

describe("resolveHeadingEnter", () => {
  it("inserts sibling below a flat heading (no section)", () => {
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

  it("prepends to the section body when children exist", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
      { id: 4, type: "RichText", parent: 2, order: 2 },
    ]);

    expect(resolveHeadingEnter(tree, node(tree, 2))).toEqual({
      kind: "prepend-section",
      headingId: 2n,
    });
  });

  it("prepends to the section body when section flag is set but empty", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1, props: '{"level":1,"section":true}' },
    ]);

    expect(resolveHeadingEnter(tree, node(tree, 2))).toEqual({
      kind: "prepend-section",
      headingId: 2n,
    });
  });

  it("returns null for root-level headings", () => {
    const tree = makeTree([{ id: 2, type: "Heading", parent: null }]);
    expect(resolveHeadingEnter(tree, node(tree, 2))).toBeNull();
  });
});

describe("isHeadingSection", () => {
  it("is true when the section flag is set", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1, props: '{"level":2,"section":true}' },
    ]);
    expect(isHeadingSection(tree, node(tree, 2))).toBe(true);
  });

  it("is true when the heading owns children", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
    ]);
    expect(isHeadingSection(tree, node(tree, 2))).toBe(true);
  });

  it("is false for a flat, childless heading", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
    ]);
    expect(isHeadingSection(tree, node(tree, 2))).toBe(false);
  });
});
