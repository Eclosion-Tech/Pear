"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
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
 *
 * Pass `nodeCallbacks.onInsert` to run side effects (e.g. insert autofocus)
 * on the **same** `component_node` subscription that feeds the tree — avoids
 * a second `useTable` racing the render snapshot.
 */
export function useComponentTree(
  surfaceId: bigint,
  nodeCallbacks?: ComponentTreeNodeCallbacks,
): ComponentTree {
  // Keep this unfiltered until the SpacetimeDB query builder honors generated
  // column source names. In SDK 2.0.3, filtering on `surfaceId` emits invalid
  // SQL against `surfaceId` instead of the server column `surface_id`.
  const [nodes, nodesReady] = useTable(tables.component_node, nodeCallbacks);
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
