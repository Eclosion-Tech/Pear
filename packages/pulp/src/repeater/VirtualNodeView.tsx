"use client";

import { memo } from "react";
import type { BlockTree } from "../types";
import { getRenderer } from "../registry";
import { UnregisteredComponentFallback } from "../fallbacks";
import type { VirtualNode } from "./materialize";

/**
 * Render path for materialized nodes.
 *
 * Deliberately **not** `BlockNodeView`, for two reasons:
 *
 * 1. `BlockNodeView` resolves children through `tree.byParent`. Virtual nodes
 *    are not in the tree — they nest on the node itself — so there is nothing
 *    to look up.
 * 2. More importantly, `tree` changes identity on every subscription delivery
 *    in the host, which defeats `memo()` for every node beneath it. That is the
 *    rebuild-per-delivery pattern the ADR measures the repeater *against*
 *    (3.6× on the recursive sidebar shape). Memoizing on the node alone is what
 *    turns preserved materializer identity into skipped React work — the two
 *    halves of D3's 12× are the materializer and this component.
 *
 * `tree` is still a prop, but the Repeater passes a **stable proxy** whose
 * identity never changes, so it never contributes to a memo miss. Consequence,
 * stated plainly: a virtual subtree that does not re-materialize will not see
 * `defs` changes. That is acceptable because type definitions change only on
 * migration, and virtual nodes carry pre-resolved props with no Yjs state.
 *
 * Chrome is never rendered here — virtual subtrees are structurally read-only
 * (D2): no drag handles into or out of them, no slash inserts, no turn-into, no
 * selection for structural ops.
 */
export const VirtualNodeView = memo(function VirtualNodeView({
  node,
  tree,
}: {
  node: VirtualNode;
  tree: BlockTree;
}) {
  const def = tree.defs.get(node.componentType);
  if (!def) return <UnregisteredComponentFallback node={node} />;

  const Renderer = getRenderer(node.componentType);
  if (!Renderer) return <UnregisteredComponentFallback node={node} />;

  const children =
    node.children.length > 0
      ? node.children.map((c) => (
          <VirtualNodeView key={String(c.id)} node={c} tree={tree} />
        ))
      : null;

  return (
    <Renderer node={node} def={def} tree={tree}>
      {children}
    </Renderer>
  );
});
