import type { FC, ReactNode } from "react";
import type { BlockNode, BlockTree, BlockTypeDefinition } from "./types";

/**
 * Props every block renderer accepts.
 *
 * The walker (`<BlockNodeView>`) resolves children and passes them in.
 * Renderers consume `children` when `def.acceptsChildren` is true.
 */
export type BlockRendererProps = {
  node: BlockNode;
  def: BlockTypeDefinition;
  tree: BlockTree;
  children: ReactNode;
};

/** @deprecated Alias for Pear migration — prefer `BlockRendererProps`. */
export type ComponentRendererProps = BlockRendererProps;

export type BlockRenderer = FC<BlockRendererProps>;

/** @deprecated Alias for Pear migration — prefer `BlockRenderer`. */
export type ComponentRenderer = BlockRenderer;

const registry = new Map<string, BlockRenderer>();

export function registerRenderer(
  componentType: string,
  renderer: BlockRenderer,
): void {
  registry.set(componentType, renderer);
}

export function getRenderer(
  componentType: string,
): BlockRenderer | undefined {
  return registry.get(componentType);
}

export function getRegisteredTypes(): string[] {
  return Array.from(registry.keys());
}

export function assertRegistryAgainstDefs(
  defs: Map<string, BlockTypeDefinition>,
): void {
  if (typeof console === "undefined") return;
  const reported = warnedTypes;
  for (const t of defs.keys()) {
    if (!registry.has(t) && !reported.has(`missing-renderer:${t}`)) {
      reported.add(`missing-renderer:${t}`);
      console.warn(
        `[pulp/registry] no renderer for "${t}" — falling back to <UnregisteredComponentFallback>.`,
      );
    }
  }
  for (const t of registry.keys()) {
    if (!defs.has(t) && !reported.has(`missing-def:${t}`)) {
      reported.add(`missing-def:${t}`);
      console.warn(
        `[pulp/registry] renderer for "${t}" has no type definition row.`,
      );
    }
  }
}

const warnedTypes = new Set<string>();
