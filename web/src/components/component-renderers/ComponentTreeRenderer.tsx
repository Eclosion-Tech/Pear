"use client";

import { useEffect, useRef } from "react";
import { useComponentTree } from "@/src/hooks/useComponentTree";
import { ComponentNodeView } from "./ComponentNodeView";
import { EmptyTreeFallback, SkeletonDoc } from "./fallbacks";
import { assertRegistryAgainstDefs } from "./registry";
import { registerBuiltinRenderers } from "./built-in";

// Module-level side effect: register the v1 built-in renderers once on
// first import. Idempotent — see `built-in/index.ts`. Doing this at module
// load (rather than in a useEffect) means the registry is populated before
// the first `<ComponentNodeView>` runs its `getRenderer` lookup.
registerBuiltinRenderers();

/**
 * Top-level renderer for a `ComponentNode` tree on a given surface.
 *
 * Mounted by `DocPage` when `page.contentFormat?.tag === "ComponentTree"`.
 * The `BlockNote` branch keeps using the existing `<PearEditor>` per
 * `docs/PEAR_WEB_RENDERER.md` § Dual-format coexistence.
 *
 * Sprint 1 read-only path. Sprints 2–4 layer editing, block chrome, and
 * Pear-specific block ports inside this component.
 *
 * **Loading-state policy.** `useComponentTree`'s `loading` flag is derived
 * from `useTable`'s `isReady`, which (per the SpacetimeDB react bindings)
 * can flip back to `false` on transient connection blips, on
 * resubscription, or briefly during the first paint after a parent
 * navigation. Replacing the entire tree with `<SkeletonDoc>` on every
 * flicker would tear down every live `RichText` editor (losing focus,
 * IndexedDB handles, pending saves). Instead we track an "ever ready"
 * latch and only show the skeleton on first-ever load. Once we've rendered
 * a real tree, transient unready states render the *last known good* tree
 * — the worst case is stale data for one render cycle.
 */
export function ComponentTreeRenderer({ surfaceId }: { surfaceId: bigint }) {
  const tree = useComponentTree(surfaceId);
  const everReadyRef = useRef(false);
  if (!tree.loading) everReadyRef.current = true;

  useEffect(() => {
    if (tree.loading) return;
    assertRegistryAgainstDefs(tree.defs);
  }, [tree.defs, tree.loading]);

  // First-ever load: show skeleton. Anything else: show the tree (possibly
  // briefly stale if the underlying subscriptions are reconnecting).
  if (tree.loading && !everReadyRef.current) {
    return <SkeletonDoc />;
  }

  if (!tree.root) {
    return <EmptyTreeFallback />;
  }

  return <ComponentNodeView node={tree.root} tree={tree} />;
}
