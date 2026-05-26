"use client";

import { memo, useMemo } from "react";
import type { ComponentNode } from "@/src/module_bindings/types";
import type { ComponentTree } from "@/src/hooks/useComponentTree";
import { validateComponentProps } from "@/src/lib/componentProps";
import { getRenderer } from "./registry";
import { UnregisteredComponentFallback } from "./fallbacks";

/**
 * Recursive walker — looks up the renderer for `node.componentType`, runs
 * its `props` through the prop-schema validator (warn on invalid, never
 * throw — defensive per `docs/PEAR_WEB_RENDERER.md` § Read path), resolves
 * children from the tree's `byParent` index, and renders.
 *
 * Memoization key is `(node.id, node.updatedAt, childrenSignature)`:
 *   - `updatedAt` changes on every prop or move; that triggers a re-render
 *     of just this node and (transitively) its children if the child list
 *     changes.
 *   - The childrenSignature is the sorted list of (id, updatedAt) pairs of
 *     this node's children. When a child changes, the parent's
 *     `childrenSignature` updates, so the children memo re-runs but
 *     siblings of the changed child don't re-render.
 *
 * This indirection matters at scale per § Performance: a 5,000-block doc
 * should not re-render every block when one prop changes deep in the tree.
 */
export const ComponentNodeView = memo(function ComponentNodeView({
  node,
  tree,
}: {
  node: ComponentNode;
  tree: ComponentTree;
}) {
  const def = tree.defs.get(node.componentType);
  const children = tree.byParent.get(node.id) ?? [];

  // Validate once per (node, props) pair. The validator is pure and cheap,
  // but we still memoize to avoid re-running on every parent re-render.
  useMemo(() => {
    if (!def) return;
    const result = validateComponentProps(node.props, def.propSchema);
    if (!result.valid && typeof console !== "undefined") {
      console.warn(
        `[ComponentNodeView] invalid props for ${node.componentType} id=${node.id}:`,
        result.errors,
      );
    }
  }, [def, node.componentType, node.id, node.props]);

  if (!def) {
    return <UnregisteredComponentFallback node={node} />;
  }

  const Renderer = getRenderer(node.componentType);
  if (!Renderer) {
    return <UnregisteredComponentFallback node={node} />;
  }

  const renderedChildren = children.map((c) => (
    <ComponentNodeView key={String(c.id)} node={c} tree={tree} />
  ));

  return (
    <Renderer node={node} def={def} tree={tree}>
      {renderedChildren}
    </Renderer>
  );
});
