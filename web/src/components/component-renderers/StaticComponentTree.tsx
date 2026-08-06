"use client";

import { useMemo } from "react";
import { useTable } from "spacetimedb/react";
import {
  BlockView,
  registerCoreBlocks,
  type BlockTypeDefinition,
} from "@eclosion-tech/pulp";
import { tables } from "@/src/module_bindings";
import { registerPearBuiltinRenderers } from "./built-in";
import { parseComponentTreeBlob } from "@/src/lib/componentTreeBlob";
import { GeneratedUiInteractionProvider } from "./GeneratedUiInteractionContext";

// The renderer registry is a module-level singleton; both calls are
// idempotent. Registering here (not only in PearComponentTreeRenderer) lets a
// component tree render in surfaces where the page editor is never mounted —
// e.g. the chat panel.
registerCoreBlocks();
registerPearBuiltinRenderers();

/**
 * Read-only renderer for a `component_tree_v1` blob delivered inline (today:
 * generative chat UI on an assistant message). Parses the blob into a pulp
 * `BlockTree` and renders it with `<BlockView>` — no persistence, no editor
 * chrome, leaf editors static. `component_type_definition` supplies `defs`
 * (renderers rely on `acceptsChildren` / `propSchema`).
 *
 * The tree itself remains structurally read-only. A narrow interaction context
 * lets generated Input/Button leaves invoke an allowlisted Manual automation;
 * the server remains authoritative for identity, policy, ACLs, and audit rows.
 */
export function StaticComponentTree({
  json,
  messageId,
}: {
  json: string;
  messageId: bigint;
}) {
  const [defRows] = useTable(tables.component_type_definition);

  const defs = useMemo(() => {
    const m = new Map<string, BlockTypeDefinition>();
    for (const d of defRows) m.set(d.componentType, d);
    return m;
  }, [defRows]);

  const parsed = useMemo(
    () => parseComponentTreeBlob(json, defs),
    [json, defs],
  );

  if (!parsed.ok) {
    return (
      <div className="my-2 rounded-md border border-dashed border-neutral-300 px-3 py-2 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
        Couldn&rsquo;t render the generated interface.
      </div>
    );
  }

  return (
    <GeneratedUiInteractionProvider messageId={messageId}>
      <div className="pear-static-component-tree my-2">
        <BlockView tree={parsed.tree} />
      </div>
    </GeneratedUiInteractionProvider>
  );
}
