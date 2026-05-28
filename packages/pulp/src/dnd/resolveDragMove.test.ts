import { describe, expect, it } from "vitest";
import { isAncestorOf, resolveDragMove } from "../dnd/resolveDragMove";
import { containerDropId } from "../dnd/containerDropId";
import { makeTree } from "../test/fixtures";

describe("isAncestorOf", () => {
  it("detects direct and indirect ancestry", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
    ]);

    expect(isAncestorOf(tree, 2n, 3n)).toBe(true);
    expect(isAncestorOf(tree, 1n, 3n)).toBe(true);
    expect(isAncestorOf(tree, 3n, 2n)).toBe(false);
  });
});

describe("resolveDragMove", () => {
  const tree = makeTree([
    { id: 1, type: "Container", parent: null },
    { id: 2, type: "RichText", parent: 1, order: 1 },
    { id: 3, type: "RichText", parent: 1, order: 2 },
    { id: 4, type: "RichText", parent: 1, order: 3 },
  ]);

  it("reorders within the same parent", () => {
    const move = resolveDragMove(tree, 4n, "4");
    expect(move).toBeNull();

    const down = resolveDragMove(tree, 2n, "3");
    expect(down).toEqual({
      componentId: 2n,
      newParentId: 1n,
      afterSiblingId: 3n,
    });
  });

  it("drops onto a container at the end", () => {
    const move = resolveDragMove(tree, 2n, containerDropId(1n));
    expect(move).toEqual({
      componentId: 2n,
      newParentId: 1n,
      afterSiblingId: 4n,
    });
  });

  it("rejects nesting into own descendant", () => {
    const nested = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
    ]);

    const move = resolveDragMove(nested, 2n, "3");
    expect(move).toBeNull();
  });

  it("rejects drops into non-container parents", () => {
    const extraDefs = {
      NoChildren: {
        componentType: "NoChildren",
        propSchema: "{}",
        acceptsChildren: false,
      },
    };
    const blocked = makeTree(
      [
        { id: 1, type: "Container", parent: null },
        { id: 2, type: "NoChildren", parent: 1 },
        { id: 3, type: "RichText", parent: 1 },
      ],
      { extraDefs },
    );

    expect(resolveDragMove(blocked, 3n, containerDropId(2n))).toBeNull();
  });
});

describe("resolveDragMove cross-parent", () => {
  it("lands after hovered block when parent changes", () => {
    const tree = makeTree([
      { id: 1, type: "Container", parent: null },
      { id: 2, type: "Heading", parent: 1 },
      { id: 3, type: "RichText", parent: 2 },
      { id: 4, type: "RichText", parent: 1 },
    ]);

    const move = resolveDragMove(tree, 3n, "4");
    expect(move).toEqual({
      componentId: 3n,
      newParentId: 1n,
      afterSiblingId: 4n,
    });
  });
});
