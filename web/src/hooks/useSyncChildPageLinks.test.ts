import { describe, expect, it } from "vitest";
import type { BlockTree } from "@eclosion-tech/pulp";
import { pageLinkIdsInTree } from "./useSyncChildPageLinks";

function makeTree(
  nodes: Array<{ id: bigint; type: string; props: string }>,
): BlockTree {
  const byId = new Map(
    nodes.map((n) => [
      n.id,
      {
        id: n.id,
        surfaceId: 1n,
        parentId: 1n,
        componentType: n.type,
        props: n.props,
        order: 0n,
      },
    ]),
  );
  return {
    root: null,
    byId,
    byParent: new Map(),
    defs: new Map(),
    yjs: new Map(),
    loading: false,
  };
}

describe("pageLinkIdsInTree", () => {
  it("collects pageId from PageLink props", () => {
    const tree = makeTree([
      { id: 2n, type: "PageLink", props: '{"pageId":"99","pageTitle":"Child"}' },
      { id: 3n, type: "RichText", props: "{}" },
      { id: 4n, type: "PageLink", props: '{"pageId":"100","pageTitle":"Other"}' },
    ]);

    expect(pageLinkIdsInTree(tree)).toEqual(new Set(["99", "100"]));
  });

  it("ignores PageLink rows with empty pageId", () => {
    const tree = makeTree([
      { id: 2n, type: "PageLink", props: '{"pageId":"","pageTitle":"Untitled"}' },
    ]);

    expect(pageLinkIdsInTree(tree)).toEqual(new Set());
  });
});
