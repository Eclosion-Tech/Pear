"use client";

import { useMemo } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import type {
  ComponentNode,
  ComponentTypeDefinition,
  ComponentYjsState,
} from "@/src/module_bindings/types";

/**
 * The shape returned by `useComponentTree`. See `docs/PEAR_WEB_RENDERER.md` §
 * Read path — `useComponentTree(surfaceId)` for the design contract.
 *
 * - `root` is the single component node with `parent_id = None` for this
 *   surface, per the substrate's single-root-per-surface invariant
 *   (`docs/PEAR_COMPONENT_NODE_SCHEMA.md` § Integrity model).
 * - `byId` maps every live (non-deleted) node id to its row.
 * - `byParent` maps a parent id (or `null` for the root) to its children,
 *   pre-sorted by `order` ascending. Soft-deleted nodes are excluded.
 * - `defs` is the registry side — every `ComponentTypeDefinition` row keyed
 *   on its `componentType` string. Includes types not used on this surface;
 *   the set is small so we don't filter.
 * - `yjs` maps the component node id to its `ComponentYjsState` row, if any.
 *   Only `RichText` and other `has_yjs_state` types have entries; the
 *   renderer is responsible for treating "missing" as "empty doc".
 * - `loading` is true until the three subscriptions have hydrated. Renderers
 *   should show a skeleton while loading; partial hydration can show a
 *   misleading "empty tree" otherwise.
 */
export type ComponentTree = {
  root: ComponentNode | null;
  byId: Map<bigint, ComponentNode>;
  byParent: Map<bigint | null, ComponentNode[]>;
  defs: Map<string, ComponentTypeDefinition>;
  yjs: Map<bigint, ComponentYjsState>;
  loading: boolean;
};

/**
 * Subscribes to `component_node`, `component_type_definition`, and
 * `component_yjs_state`; returns an indexed view scoped to one surface.
 *
 * Subscription rules (per ADR § Read path):
 *   - A row UPDATE on one ComponentNode only re-renders the React component
 *     for that node (via memoization keyed on `node.id`/`updatedAt`) and
 *     (if parent_id or order changed) the parent's child-list memo.
 *   - A new ComponentNode INSERT re-renders the parent's child-list memo.
 *   - ComponentYjsState UPDATEs flow to per-RichText editors directly via
 *     `Y.applyUpdate(doc, bytes, "remote")` in sprint 2; sprint 1 just
 *     re-runs the Y → HTML pass on the static renderer.
 *
 * `surfaceId` is `Page.id` at v1. Future: DatabaseView, CustomView surfaces
 * will use the same hook with their own surface id space.
 */
export function useComponentTree(surfaceId: bigint): ComponentTree {
  const [nodes, nodesReady] = useTable(tables.component_node);
  const [defRows, defsReady] = useTable(tables.component_type_definition);
  const [yjsRows, yjsReady] = useTable(tables.component_yjs_state);

  const loading = !nodesReady || !defsReady || !yjsReady;

  return useMemo(() => {
    // Filter to live nodes on this surface. Soft-deleted leaves are excluded
    // from the render walk per `docs/PEAR_COMPONENT_NODE_SCHEMA.md` §
    // Integrity model (leaf-only soft delete).
    const live: ComponentNode[] = [];
    for (const n of nodes) {
      if (n.surfaceId !== surfaceId) continue;
      if (n.deletedAt != null) continue;
      live.push(n);
    }

    const byId = new Map<bigint, ComponentNode>();
    for (const n of live) byId.set(n.id, n);

    // Bucket children by parent. The root has parent_id = null; we key the
    // map with `null` for the root bucket so callers can do
    // `byParent.get(null) ?? []` for a uniform child-fetch idiom.
    const byParent = new Map<bigint | null, ComponentNode[]>();
    for (const n of live) {
      const key = n.parentId ?? null;
      const arr = byParent.get(key);
      if (arr) arr.push(n);
      else byParent.set(key, [n]);
    }
    for (const arr of byParent.values()) {
      arr.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    }

    const rootBucket = byParent.get(null);
    // Single-root invariant: pick the first (and only) root. If the substrate
    // ever yields zero or multiple roots for a surface, render falls through
    // to <EmptyTreeFallback> (zero) or picks the lowest-id root (multiple)
    // with a console warning. The reducers prevent both cases server-side.
    const root: ComponentNode | null =
      rootBucket && rootBucket.length > 0 ? rootBucket[0] : null;

    if (rootBucket && rootBucket.length > 1 && typeof console !== "undefined") {
      console.warn(
        `[useComponentTree] surface ${surfaceId} has ${rootBucket.length} roots; expected 1. Rendering id=${root?.id}.`,
      );
    }

    const defs = new Map<string, ComponentTypeDefinition>();
    for (const d of defRows) defs.set(d.componentType, d);

    const yjs = new Map<bigint, ComponentYjsState>();
    for (const r of yjsRows) {
      // Only carry yjs state for nodes on this surface; saves a tiny amount
      // of memo churn when other surfaces' Yjs state changes.
      if (byId.has(r.componentNodeId)) yjs.set(r.componentNodeId, r);
    }

    return { root, byId, byParent, defs, yjs, loading };
  }, [nodes, defRows, yjsRows, surfaceId, loading]);
}
