import { describe, expect, it } from "vitest";
import type { BlockTree } from "@eclosion-tech/pulp";
import type { PageRow } from "@/src/hooks/usePages";
import {
  childPagesNeedingLink,
  claimChildPageLink,
  pageLinkIdsInTree,
  releaseChildPageLinkClaim,
} from "./useSyncChildPageLinks";

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

function child(id: bigint, sortOrder: number): PageRow {
  return { id, sortOrder, title: `Page ${id}` } as unknown as PageRow;
}

describe("childPagesNeedingLink", () => {
  const SURFACE = 1n;
  const none = new Set<string>();

  it("returns unlinked children in sidebar order", () => {
    const pages = [child(12n, 3000), child(10n, 2000), child(11n, 1000)];

    expect(
      childPagesNeedingLink(SURFACE, new Set(["10"]), pages, none).map((p) => p.id),
    ).toEqual([11n, 12n]);
  });

  it("skips children this client already auto-inserted", () => {
    expect(
      childPagesNeedingLink(SURFACE, none, [child(10n, 1000)], new Set(["10"])),
    ).toEqual([]);
  });

  // "New page" slash flow: the page row arrives before the placeholder
  // PageLink's pageId does, so the tree has no link for the child yet.
  it("skips a child a placeholder PageLink has claimed", () => {
    const pages = [child(10n, 1000), child(11n, 2000)];
    const placeholderOnly = pageLinkIdsInTree(
      makeTree([
        { id: 2n, type: "PageLink", props: '{"pageId":"","pageTitle":"Untitled","createSubpage":true}' },
      ]),
    );

    claimChildPageLink(SURFACE, 11n);
    try {
      expect(
        childPagesNeedingLink(SURFACE, placeholderOnly, pages, none).map((p) => p.id),
      ).toEqual([10n]);
      // The claim is scoped to the surface the placeholder lives on.
      expect(
        childPagesNeedingLink(2n, placeholderOnly, pages, none).map((p) => p.id),
      ).toEqual([10n, 11n]);
    } finally {
      releaseChildPageLinkClaim(SURFACE, 11n);
    }

    expect(
      childPagesNeedingLink(SURFACE, placeholderOnly, pages, none).map((p) => p.id),
    ).toEqual([10n, 11n]);
  });
});
