"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { useScopedTable } from "@/src/hooks/useScopedTable";
import type { BlockTree } from "@eclosion-tech/pulp";
import type {
  ComponentNode,
  ComponentTypeDefinition,
  ComponentYjsState,
} from "@/src/module_bindings/types";
import { PEAR_REGISTRY_REQUIRED_TYPES } from "@/src/components/component-renderers/pearSlashItems";
import { useRunPendingMigrations } from "@/src/hooks/usePages";

/** Pear substrate tree — structurally compatible with pulp's `BlockTree`. */
export type ComponentTree = BlockTree & {
  root: ComponentNode | null;
  byId: Map<bigint, ComponentNode>;
  byParent: Map<bigint | null, ComponentNode[]>;
  defs: Map<string, ComponentTypeDefinition>;
  yjs: Map<bigint, ComponentYjsState>;
};

export type ComponentTreeNodeCallbacks = {
  onInsert?: (row: ComponentNode) => void;
  /**
   * Fires when a `component_node` row leaves the subscription — i.e. a true
   * hard delete or loss of visibility, NOT a soft delete (which only sets
   * `deletedAt`, keeping the row). Used to purge the node's local IndexedDB
   * doc so removed/inaccessible content doesn't linger in the browser.
   */
  onDelete?: (row: ComponentNode) => void;
  /**
   * Fires on any row update. Used to catch the soft-delete transition
   * (`deletedAt` null → set) — e.g. a reducer-driven content replace — so the
   * removed node's local IndexedDB doc is purged too and can't resurface via a
   * stale local↔server Yjs merge. (`onDelete` only covers hard deletes.)
   */
  onUpdate?: (oldRow: ComponentNode, newRow: ComponentNode) => void;
};

/**
 * Subscribes to `component_node`, `component_type_definition`, and
 * `component_yjs_state`; returns an indexed view scoped to one surface.
 * The node/yjs subscriptions themselves are scoped to the surface
 * server-side (14384) — `component_type_definition` stays full-table (it's
 * the small registry).
 *
 * Pass `nodeCallbacks.onInsert` to run side effects (e.g. insert autofocus)
 * on the **same** `component_node` subscription that feeds the tree — avoids
 * a second `useTable` racing the render snapshot.
 */
export function useComponentTree(
  surfaceId: bigint,
  nodeCallbacks?: ComponentTreeNodeCallbacks,
): ComponentTree {
  // Scoped subscriptions via raw SQL (ticket 14384): the SDK 2.0.3 query
  // builder renders the camelCase accessor (`surfaceId`) instead of the
  // server column (`surface_id`), so typed `.where()` scoping errors out —
  // raw server-name SQL through `useScopedTable` sidesteps that (and falls
  // back to the old full-table subscription if the server rejects the query).
  // The filter deliberately keeps soft-deleted rows: the memo below excludes
  // them, and `nodeCallbacks.onUpdate` needs the deletedAt null→set
  // transition (see the docs on ComponentTreeNodeCallbacks above).
  const { rows: nodes, ready: nodesReady } = useScopedTable<ComponentNode>(
    tables.component_node,
    `SELECT * FROM component_node WHERE surface_id = ${surfaceId}`,
    (row) => row.surfaceId === surfaceId,
    nodeCallbacks,
  );
  const [defRows, defsReady] = useTable(tables.component_type_definition);
  // `component_yjs_state` has no surface column, so scope it with a
  // two-table semijoin through `component_node` — the exact shape the SDK's
  // own query builder emits for semijoins (`SELECT rhs.* FROM lhs JOIN rhs
  // ON … WHERE <lhs filter>`, see SemijoinImpl.toSql in
  // spacetimedb/src/lib/query.ts), which is the join form SpacetimeDB
  // subscriptions support. Join columns are indexed on both sides
  // (component_node.id is the PK; component_yjs_state.component_node_id is
  // the PK). If the server rejects it, useScopedTable's onError fallback
  // degrades to the full-table subscription (today's behavior) with a
  // console warning — no worse than before. The real fix is a `surface_id`
  // column on `component_yjs_state` server-side.
  //
  // Client-side filter is `() => true` on purpose: yjs rows carry no surface
  // column, and filtering against the current node set here would go stale
  // when one transaction inserts a node + its yjs row together (the snapshot
  // for this table would be rebuilt before `nodes` re-renders). The
  // authoritative client-side filter is the `byId.has(...)` check in the
  // memo below, which re-runs whenever either table changes.
  const { rows: yjsRows, ready: yjsReady } = useScopedTable<ComponentYjsState>(
    tables.component_yjs_state,
    `SELECT component_yjs_state.* FROM component_node JOIN component_yjs_state ` +
      `ON component_node.id = component_yjs_state.component_node_id ` +
      `WHERE component_node.surface_id = ${surfaceId}`,
    () => true,
  );

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

/**
 * When Pear-only built-ins are missing from `component_type_definition`,
 * invoke `run_pending_migrations` once. This seeds rows added after the
 * workspace was first provisioned (e.g. document list types). Production
 * upgrades normally run the same reducer from lifecycle after publish.
 */
export function useEnsureBuiltinComponentTypes(
  defs: ReadonlyMap<string, unknown>,
  ready: boolean,
) {
  const runPendingMigrations = useRunPendingMigrations();
  const inflightRef = useRef(false);

  useEffect(() => {
    if (!ready || inflightRef.current) return;

    const missing = PEAR_REGISTRY_REQUIRED_TYPES.filter((t) => !defs.has(t));
    if (missing.length === 0) return;

    inflightRef.current = true;
    runPendingMigrations()
      .catch((err: unknown) => {
        console.warn(
          `[ComponentTree] Missing builtin types (${missing.join(", ")}). ` +
            "Republish Pear module and run run_pending_migrations (local: restart STDB container).",
          err,
        );
      })
      .finally(() => {
        inflightRef.current = false;
      });
  }, [defs, ready, runPendingMigrations]);
}
