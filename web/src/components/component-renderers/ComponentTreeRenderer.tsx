"use client";

import { useEffect } from "react";
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
 */
export function ComponentTreeRenderer({ surfaceId }: { surfaceId: bigint }) {
  const tree = useComponentTree(surfaceId);

  // Surface registry drift (table → code, code → table) once per session
  // per type. See registry.ts § assertRegistryAgainstDefs.
  useEffect(() => {
    if (tree.loading) return;
    assertRegistryAgainstDefs(tree.defs);
  }, [tree.defs, tree.loading]);

  if (tree.loading) {
    return <SkeletonDoc />;
  }

  if (!tree.root) {
    return <EmptyTreeFallback />;
  }

  return <ComponentNodeView node={tree.root} tree={tree} />;
}
