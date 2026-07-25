"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import type { ComponentTypeDefinition } from "@/src/module_bindings/types";
import {
  BlockView,
  REPEAT_CHILDREN_PROP,
  type BlockNode,
  type BlockTree,
  type QueryResolver,
  type RepeaterRow,
} from "@eclosion-tech/pulp";
import { usePagesQueryResolver } from "@/src/lib/repeater/pagesResolver";
import { measureDelivery, recordMount } from "@/src/lib/repeater/paintMetrics";

/**
 * M3 — the sidebar page tree rendered through the repeater runtime.
 *
 * This is the ADR's dogfood surface, and it is a **measurement harness, not a
 * replacement**. It exists to produce delivery-to-paint numbers for the
 * back-out bar on a real, recursive, daily-use shape. The bespoke sidebar
 * remains the default and the only fully-featured one.
 *
 * Known and intended gaps versus the bespoke sidebar, all forced by the ADR
 * rather than by effort: drag-to-reorder and any structural operation are
 * impossible on virtual nodes (D2), and inline rename, multi-select, and the
 * context menu all require prop write-back, which is deferred to M5 (D6).
 * Navigation works, because that is exactly what D6 says v1 interactivity is.
 *
 * The whole surface is one stored tree of five nodes, held in memory and never
 * persisted — the shape a stored custom view will have once M4 lands, which is
 * the point of dogfooding it here rather than in a synthetic bench.
 */

const ROOT_ID = 1n;
const REPEATER_ID = 2n;
const ITEM_ID = 3n;
const LINK_ID = 4n;
const RECURSE_ID = 5n;

function node(
  id: bigint,
  parentId: bigint | null,
  componentType: string,
  props: Record<string, unknown>,
  order = 0,
): BlockNode {
  return {
    id,
    surfaceId: ROOT_ID,
    parentId,
    componentType,
    props: JSON.stringify(props),
    order,
  };
}

/**
 * Container > Repeater > [ Container > (PageLink, Container·recurse) ].
 *
 * The item wrapper exists because `PageLink` has `accepts_children = false`;
 * nested pages hang off the sibling container marked as the recursion point.
 */
const STORED_NODES: BlockNode[] = [
  node(ROOT_ID, null, "Container", { layout: "stack" }),
  node(REPEATER_ID, ROOT_ID, "Repeater", {
    dataSource: {
      v: 1,
      entity: { kind: "pages", parentId: null, includeDescendants: true },
      sort: [{ property: "sortOrder", dir: "asc" }],
    },
  }),
  node(ITEM_ID, REPEATER_ID, "Container", { layout: "stack" }),
  node(LINK_ID, ITEM_ID, "PageLink", {
    pageId: "{{row.id}}",
    pageTitle: "{{row.title}}",
  }),
  node(RECURSE_ID, ITEM_ID, "Container", {
    [REPEAT_CHILDREN_PROP]: true,
    layout: "stack",
    // style_v1 — nested rows indent because the *template* says so, not
    // because the shared Container renderer hardcodes it. This is the case
    // that motivated the style vocabulary ADR.
    style: { indent: "md" },
  }, 1),
];

function buildStoredTree(defs: Map<string, ComponentTypeDefinition>, loading: boolean): BlockTree {
  const byId = new Map<bigint, BlockNode>();
  const byParent = new Map<bigint | null, BlockNode[]>();
  for (const n of STORED_NODES) {
    byId.set(n.id, n);
    const key = n.parentId ?? null;
    const arr = byParent.get(key);
    if (arr) arr.push(n);
    else byParent.set(key, [n]);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => Number(a.order) - Number(b.order));
  }
  return {
    root: byId.get(ROOT_ID) ?? null,
    byId,
    byParent,
    defs: defs as unknown as BlockTree["defs"],
    yjs: new Map(),
    loading,
  };
}

export function RepeaterSidebarTree() {
  const [defRows, defsReady] = useTable(tables.component_type_definition);
  const baseResolver = usePagesQueryResolver();

  useEffect(() => {
    // Counted so the "no remount storms" clause of the bar is observable
    // rather than inferred from feel.
    recordMount("repeater-sidebar");
  }, []);

  const defs = useMemo(() => {
    const m = new Map<string, ComponentTypeDefinition>();
    for (const d of defRows) m.set(d.componentType, d);
    return m;
  }, [defRows]);

  // Wrap the resolver so each delivery is timed through to the frame that
  // paints it. The rAF scheduled immediately after `onRows` lands on the next
  // painted frame, which is the number a user actually experiences.
  const resolverRef = useRef(baseResolver);
  resolverRef.current = baseResolver;
  const measuredResolver = useMemo<QueryResolver>(
    () => ({
      subscribe(config, onRows) {
        return resolverRef.current.subscribe(config, (rows: ReadonlyArray<RepeaterRow>) => {
          const commit = measureDelivery("repeater-sidebar");
          onRows(rows);
          commit();
        });
      },
    }),
    [],
  );

  const tree = useMemo(() => buildStoredTree(defs, !defsReady), [defs, defsReady]);

  const config = useMemo(
    () => ({ idbPrefix: "", queryResolver: measuredResolver }),
    [measuredResolver],
  );

  if (!defsReady) {
    return (
      <div className="px-2 py-1 text-xs text-neutral-400 dark:text-neutral-500">Loading…</div>
    );
  }

  return (
    <div data-repeater-sidebar="">
      <div className="mb-2 rounded border border-dashed border-amber-300 dark:border-amber-700 px-2 py-1 text-[10px] leading-tight text-amber-700 dark:text-amber-300">
        Repeater sidebar (M3 benchmark) — navigate only. Drag, rename, and
        multi-select need M5.
      </div>
      <BlockView tree={tree} config={config} />
    </div>
  );
}
