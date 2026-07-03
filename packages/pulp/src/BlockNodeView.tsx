"use client";

import { memo, useMemo } from "react";
import type { BlockNode, BlockTree } from "./types";
import { usePulpOptional } from "./context/PulpProvider";
import { getRenderer } from "./registry";
import { UnregisteredComponentFallback } from "./fallbacks";
import { BlockChrome } from "./BlockChrome";

export const BlockNodeView = memo(function BlockNodeView({
  node,
  tree,
}: {
  node: BlockNode;
  tree: BlockTree;
}) {
  const pulp = usePulpOptional();
  const def = tree.defs.get(node.componentType);
  const children = tree.byParent.get(node.id) ?? [];

  useMemo(() => {
    if (!def || !pulp?.config.validateProps) return;
    const result = pulp.config.validateProps(node.props, def.propSchema);
    if (!result.valid && typeof console !== "undefined") {
      console.warn(
        `[pulp/BlockNodeView] invalid props for ${node.componentType} id=${node.id}:`,
        result.errors,
      );
    }
  }, [def, node.componentType, node.id, node.props, pulp?.config.validateProps]);

  if (!def) {
    return <UnregisteredComponentFallback node={node} />;
  }

  const Renderer = getRenderer(node.componentType);
  if (!Renderer) {
    return <UnregisteredComponentFallback node={node} />;
  }

  const renderedChildren = children.map((c) => (
    <BlockNodeView key={String(c.id)} node={c} tree={tree} />
  ));

  const rendered = (
    <Renderer node={node} def={def} tree={tree}>
      {renderedChildren}
    </Renderer>
  );
  // Root never gets chrome; read-only mode gets no chrome anywhere (no drag
  // grip, insert +, or block menu) — the surface is structurally immutable.
  if (node.parentId == null || pulp?.config.readOnly) return rendered;

  const gutterMode =
    def.acceptsChildren && children.length > 0 ? "header" : "side";

  return (
    <BlockChrome node={node} gutterMode={gutterMode}>
      {rendered}
    </BlockChrome>
  );
});

/** @deprecated Pear alias — prefer `BlockNodeView`. */
export const ComponentNodeView = BlockNodeView;
