"use client";

import { useEffect, useMemo, useRef } from "react";
import type { BlockTree } from "@eclosion-tech/pulp";
import type { PageRow } from "@/src/hooks/usePages";

type SyncArgs = {
  surfaceId: bigint;
  tree: BlockTree & { loading: boolean };
  childPages: PageRow[];
  insertPageLink: (args: {
    parentId: bigint;
    propsJson: string;
    afterSiblingId?: bigint;
  }) => void;
  deletePageLink: (componentId: bigint) => void;
};

/** Collect `pageId` values from live `PageLink` nodes on this surface. */
export function pageLinkIdsInTree(tree: BlockTree): Set<string> {
  const ids = new Set<string>();
  for (const node of tree.byId.values()) {
    if (node.componentType !== "PageLink") continue;
    const pageId = parsePageLinkPageId(node.props);
    if (pageId) ids.add(pageId);
  }
  return ids;
}

function parsePageLinkPageId(propsJson: string): string | null {
  try {
    const props = JSON.parse(propsJson) as { pageId?: string };
    const id = props.pageId?.trim();
    return id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Mirror PearEditor's child-page sync: auto-insert `PageLink` rows for each
 * child page missing from the tree, and remove stale links when a child is
 * deleted or reparented away.
 */
export function useSyncChildPageLinks({
  surfaceId,
  tree,
  childPages,
  insertPageLink,
  deletePageLink,
}: SyncArgs): void {
  const autoInsertedRef = useRef(new Set<string>());
  const prevChildIdsRef = useRef<Set<string> | null>(null);

  const childIdsKey = useMemo(
    () =>
      childPages
        .map((p) => String(p.id))
        .sort()
        .join(","),
    [childPages],
  );

  // Auto-insert PageLink components for child pages not yet represented.
  useEffect(() => {
    if (tree.loading || !tree.root || childPages.length === 0) return;
    if (!tree.defs.has("PageLink")) return;

    const handle = requestAnimationFrame(() => {
      const inTree = pageLinkIdsInTree(tree);
      const toInsert = childPages
        .filter((p) => {
          const id = String(p.id);
          return !inTree.has(id) && !autoInsertedRef.current.has(id);
        })
        .sort((a, b) => {
          const ao = Number(a.sortOrder);
          const bo = Number(b.sortOrder);
          return ao !== bo ? ao - bo : Number(a.id - b.id);
        });

      if (toInsert.length === 0) return;

      const siblings = tree.byParent.get(tree.root!.id) ?? [];
      const afterSiblingId = siblings[siblings.length - 1]?.id;

      // Reducer inserts after the anchor in reverse when the anchor is unchanged.
      for (const page of [...toInsert].reverse()) {
        const id = String(page.id);
        insertPageLink({
          parentId: tree.root!.id,
          propsJson: JSON.stringify({
            pageId: id,
            pageTitle: page.title || "Untitled",
          }),
          afterSiblingId,
        });
        autoInsertedRef.current.add(id);
      }
    });

    return () => cancelAnimationFrame(handle);
  }, [tree, childIdsKey, childPages, insertPageLink]);

  // Remove PageLink rows when their child page leaves this parent.
  useEffect(() => {
    if (tree.loading) return;

    const currentIds = new Set(childPages.map((p) => String(p.id)));
    const prev = prevChildIdsRef.current;

    if (prev === null) {
      prevChildIdsRef.current = currentIds;
      return;
    }

    const removedIds = new Set([...prev].filter((id) => !currentIds.has(id)));
    prevChildIdsRef.current = currentIds;

    if (removedIds.size === 0) return;

    const handle = requestAnimationFrame(() => {
      for (const node of tree.byId.values()) {
        if (node.componentType !== "PageLink") continue;
        const pageId = parsePageLinkPageId(node.props);
        if (pageId && removedIds.has(pageId)) {
          deletePageLink(node.id);
          autoInsertedRef.current.delete(pageId);
        }
      }
    });

    return () => cancelAnimationFrame(handle);
  }, [tree, childIdsKey, childPages, deletePageLink]);

  // Reset tracking when navigating to a different page surface.
  useEffect(() => {
    autoInsertedRef.current = new Set();
    prevChildIdsRef.current = null;
  }, [surfaceId]);
}
