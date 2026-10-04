"use client";

import { createContext, useContext } from "react";
import { usePulpOptional } from "../context/PulpProvider";
import type { BlockNode } from "../types";

/** Source ownership follows each inclusion, independently of document nesting. */
export const BlockSourcePath = createContext<readonly string[]>([]);
export const ContinuousCompositionContext = createContext(false);

export function useBlockSourceAttributes(node: BlockNode) {
  const pulp = usePulpOptional();
  const path = useContext(BlockSourcePath);
  const continuous = useContext(ContinuousCompositionContext);
  if (node.componentType === "Reference") return {};
  const page = pulp?.config.linkTargets?.find((target) => target.id === String(node.surfaceId));
  return {
    // Static source text needs a keyboard entry point when its frame is hidden.
    tabIndex: pulp?.config.readOnly && continuous ? 0 : undefined,
    "data-composition-source": "",
    "data-source-label": path.at(-1) ?? page?.label ?? "This page",
    "data-source-path": JSON.stringify(path),
    "data-source-readonly": pulp?.config.readOnly ? "true" : "false",
    "data-source-href": pulp?.config.references?.href({ surfaceId: node.surfaceId, blockId: node.id }) ?? page?.href,
  };
}
