"use client";

import { useEffect, useMemo } from "react";
import { PulpProvider } from "./context/PulpProvider";
import { BlockNodeView } from "./BlockNodeView";
import { EmptyTreeFallback, SkeletonDoc } from "./fallbacks";
import { assertRegistryAgainstDefs } from "./registry";
import type { BlockTree, PulpConfig, PulpMutations } from "./types";

/**
 * Ephemeral, read-only block-tree renderer — the counterpart to
 * `<BlockEditor>` for surfaces that are never edited: generative chat UI,
 * published / view-only pages, custom-view previews.
 *
 * Unlike `<BlockEditor>` (which reads its tree from a host-mounted
 * `<PulpProvider>` and is fully editable), `<BlockView>` takes an in-memory
 * `BlockTree` directly and mounts its own provider with no-op mutations and
 * `config.readOnly = true`. That means:
 *   - no persistence (no IndexedDB, no SpacetimeDB) — the tree is whatever you
 *     hand in;
 *   - no editor chrome (drag / insert / block menu) — see `BlockNodeView`;
 *   - leaf editors render their static HTML body, never mounting ProseMirror.
 *
 * Mutations are never invoked in this mode; the no-op bag exists only because
 * `usePulp()` (called by some renderers) requires a provider.
 */
export function BlockView({
  tree,
  config,
}: {
  tree: BlockTree;
  /** Optional overrides (e.g. `linkTargets`); `readOnly` is always forced on. */
  config?: Partial<PulpConfig>;
}) {
  useEffect(() => {
    if (tree.loading) return;
    assertRegistryAgainstDefs(tree.defs);
  }, [tree.defs, tree.loading]);

  const mergedConfig: PulpConfig = useMemo(
    () => ({
      idbPrefix: "",
      ...config,
      readOnly: true,
    }),
    [config],
  );

  if (tree.loading) return <SkeletonDoc />;
  if (!tree.root) return <EmptyTreeFallback />;

  return (
    <PulpProvider tree={tree} config={mergedConfig} mutations={NOOP_MUTATIONS}>
      <BlockNodeView node={tree.root} tree={tree} />
    </PulpProvider>
  );
}

/** All-no-op mutation bag — read-only surfaces never mutate. */
const NOOP_MUTATIONS: PulpMutations = {
  insertBlock: () => {},
  deleteBlock: () => {},
  moveBlock: () => {},
  updateBlockProps: () => {},
  saveYjsState: () => {},
  restoreBlock: () => {},
};
