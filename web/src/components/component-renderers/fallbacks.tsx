"use client";

import { memo } from "react";
import type { ComponentNode } from "@/src/module_bindings/types";

/**
 * Rendered when the walker encounters a `componentType` that has no
 * `ComponentTypeDefinition` row (workspace is missing the type seed) or
 * has no code-side renderer (registry drift). See
 * `docs/PEAR_WEB_RENDERER.md` § Registry — Coupled invariant.
 *
 * The renderer is intentionally visible — a silent fallback to nothing
 * would let component-type bugs ship unnoticed. This matches the substrate's
 * defensive integrity stance.
 */
export const UnregisteredComponentFallback = memo(function UnregisteredComponentFallback({
  node,
}: {
  node: ComponentNode;
}) {
  return (
    <div className="my-2 rounded-md border border-dashed border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs">
      <div className="font-mono text-amber-700 dark:text-amber-300">
        Unregistered component
      </div>
      <div className="mt-1 text-amber-900 dark:text-amber-100">
        <code className="font-mono">{node.componentType}</code>
        <span className="mx-2 text-amber-400 dark:text-amber-600">·</span>
        <span className="font-mono">id={String(node.id)}</span>
      </div>
    </div>
  );
});

/**
 * Rendered while `useComponentTree` is hydrating its three subscriptions.
 * Partial hydration without a skeleton can flash a misleading
 * "<EmptyTreeFallback>" before child rows arrive.
 */
export const SkeletonDoc = memo(function SkeletonDoc() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-8 w-3/5 rounded bg-neutral-200 dark:bg-neutral-800" />
      <div className="h-4 w-full rounded bg-neutral-100 dark:bg-neutral-900" />
      <div className="h-4 w-11/12 rounded bg-neutral-100 dark:bg-neutral-900" />
      <div className="h-4 w-4/5 rounded bg-neutral-100 dark:bg-neutral-900" />
    </div>
  );
});

/**
 * Rendered when the surface has no root component node. Shouldn't normally
 * happen — `create_component_tree_page` always seeds a root Container —
 * but defence-in-depth: a workspace that survived a partial migration or a
 * harness bug could end up here.
 */
export const EmptyTreeFallback = memo(function EmptyTreeFallback() {
  return (
    <div className="my-8 rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
      This page has no content yet.
    </div>
  );
});
