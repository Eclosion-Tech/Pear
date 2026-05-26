"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  type ReactNode,
} from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import type { ComponentNode } from "@/src/module_bindings/types";

/**
 * Surface-scoped autofocus coordinator for `ComponentNode` inserts.
 *
 * **The problem.** When a user gesture inserts a new ComponentNode
 * (Enter at end of a RichText, chrome `+`, slash-menu selection), we
 * want the resulting block to take focus so they can keep typing
 * without clicking. But the dispatch site only knows what it's *about
 * to insert* — the new row's id is assigned server-side and arrives
 * via the subscription delta on a later React tick. We can't focus
 * before the editor mounts.
 *
 * **The shape.** Provider exposes two operations:
 *
 *   - `armForInsert(parentId, afterSiblingId)`: call immediately
 *     before dispatching an `insert_component`. Records that the next
 *     `component_node` insert under `parentId` is the one to focus.
 *   - `claimFocus(nodeId)`: called by a renderer on mount. Returns
 *     `true` once if the node is the armed focus target, then clears
 *     the target so subsequent renders (StrictMode double-render,
 *     re-mounts after viewport-mode flips) don't re-claim and steal
 *     focus from wherever the user has moved it.
 *
 * **Timing.** The arming → matching → claim chain is:
 *
 *   1. Dispatch site calls `armForInsert(parentId, afterSiblingId)`.
 *      `pendingRef` is set synchronously.
 *   2. Reducer dispatched (`insert_component(...)`).
 *   3. Server creates the row; SDK delivers the insert event.
 *   4. `useTable`'s `onInsert` callback fires here, *before* the
 *      React store change that triggers a re-render. If the inserted
 *      row matches the pending arm, `focusTargetRef` is set.
 *   5. React re-renders. The new ComponentNodeView mounts.
 *   6. The new renderer's mount effect calls `claimFocus(node.id)`.
 *      Returns `true`, focus runs, `focusTargetRef` cleared.
 *
 * Step 4 happening *before* step 5 is the whole point — it means
 * `focusTargetRef` is populated by the time the child reads it. The
 * SpacetimeDB react bindings invoke per-row callbacks before the
 * batched store change.
 *
 * **Match predicate.** We only check `parent_id` + `surface_id`. With
 * concurrent inserts under the same parent (e.g. a remote user typing
 * Enter while you also type Enter), the most recent local arm wins
 * the next-arriving row regardless of who authored it. That's a known
 * race — acceptable at sprint 3b because the local user pressed Enter
 * *milliseconds* before the dispatch and is the most likely author of
 * the next insert. Sprint 3c's cross-block undo coordinator can
 * tighten this by tagging armed inserts with a client-side correlation
 * token.
 *
 * **Cancellation.** A new `armForInsert` call replaces any pending
 * arm; only the most recent gesture is active. If no insert arrives
 * (server rejected the reducer), the arm stays set until the next
 * `armForInsert` or an unrelated insert clears it — harmless because
 * `claimFocus` is single-shot.
 */
type SurfaceFocusValue = {
  armForInsert: (parentId: bigint, afterSiblingId?: bigint) => void;
  claimFocus: (nodeId: bigint) => boolean;
};

const SurfaceFocusContext = createContext<SurfaceFocusValue | null>(null);

export function SurfaceFocusProvider({
  surfaceId,
  children,
}: {
  surfaceId: bigint;
  children: ReactNode;
}) {
  // The pending arm and resolved focus target live in refs so that
  // updating them doesn't churn React renders for unrelated subtrees.
  const pendingRef = useRef<{
    parentId: bigint;
    afterSiblingId?: bigint;
  } | null>(null);
  const focusTargetRef = useRef<bigint | null>(null);

  // surfaceId may be a different value on subsequent renders if the
  // user navigates between pages without unmounting the provider; the
  // ref keeps the onInsert closure in sync without re-subscribing.
  const surfaceIdRef = useRef(surfaceId);
  surfaceIdRef.current = surfaceId;

  // Subscribe to component_node inserts with a stable callback. The
  // empty-deps useCallback keeps the same function identity across
  // renders so `useTable` doesn't re-subscribe and lose insert events.
  const onInsert = useCallback((row: ComponentNode) => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (row.surfaceId !== surfaceIdRef.current) return;
    if (row.deletedAt != null) return;
    if (row.parentId !== pending.parentId) return;
    focusTargetRef.current = row.id;
    pendingRef.current = null;
  }, []);

  // Independent subscription from `useComponentTree`'s. SpacetimeDB
  // handles this as two simultaneous subscribers to the same query;
  // negligible overhead and keeps the autofocus machinery decoupled
  // from the tree shape.
  useTable(tables.component_node, { onInsert });

  const value = useRef<SurfaceFocusValue>({
    armForInsert: (parentId, afterSiblingId) => {
      pendingRef.current = { parentId, afterSiblingId };
    },
    claimFocus: (nodeId) => {
      if (focusTargetRef.current === nodeId) {
        focusTargetRef.current = null;
        return true;
      }
      return false;
    },
  });

  return (
    <SurfaceFocusContext.Provider value={value.current}>
      {children}
    </SurfaceFocusContext.Provider>
  );
}

/**
 * Consumer hook. Returns a no-op shape when invoked outside of a
 * `<SurfaceFocusProvider>` so renderers don't have to guard every call
 * site — they can safely `armForInsert` and `claimFocus` even when
 * mounted in a context that doesn't care about autofocus.
 */
export function useSurfaceFocus(): SurfaceFocusValue {
  const ctx = useContext(SurfaceFocusContext);
  if (ctx) return ctx;
  return NOOP_FOCUS;
}

const NOOP_FOCUS: SurfaceFocusValue = {
  armForInsert: () => {},
  claimFocus: () => false,
};
