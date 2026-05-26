"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  DndContext,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useComponentTree } from "@/src/hooks/useComponentTree";
import { useMoveComponent } from "@/src/hooks/usePages";
import { SurfaceFocusProvider } from "@/src/hooks/useSurfaceFocus";
import { ComponentNodeView } from "./ComponentNodeView";
import { EmptyTreeFallback, SkeletonDoc } from "./fallbacks";
import { assertRegistryAgainstDefs } from "./registry";
import { registerBuiltinRenderers } from "./built-in";

// Module-level side effect: register the v1 built-in renderers once on
// first import. Idempotent — see `built-in/index.ts`. Doing this at module
// load (rather than in a useEffect) means the registry is populated before
// the first `<ComponentNodeView>` runs its `getRenderer` lookup.
registerBuiltinRenderers();

/**
 * Top-level renderer for a `ComponentNode` tree on a given surface.
 *
 * Mounted by `DocPage` when `page.contentFormat?.tag === "ComponentTree"`.
 * The `BlockNote` branch keeps using the existing `<PearEditor>` per
 * `docs/PEAR_WEB_RENDERER.md` § Dual-format coexistence.
 *
 * Sprint 1 read-only path. Sprints 2–4 layer editing, block chrome, and
 * Pear-specific block ports inside this component.
 *
 * **Loading-state policy.** `useComponentTree`'s `loading` flag is derived
 * from `useTable`'s `isReady`, which (per the SpacetimeDB react bindings)
 * can flip back to `false` on transient connection blips, on
 * resubscription, or briefly during the first paint after a parent
 * navigation. Replacing the entire tree with `<SkeletonDoc>` on every
 * flicker would tear down every live `RichText` editor (losing focus,
 * IndexedDB handles, pending saves). Instead we track an "ever ready"
 * latch and only show the skeleton on first-ever load. Once we've rendered
 * a real tree, transient unready states render the *last known good* tree
 * — the worst case is stale data for one render cycle.
 */
export function ComponentTreeRenderer({ surfaceId }: { surfaceId: bigint }) {
  const tree = useComponentTree(surfaceId);
  const moveComponent = useMoveComponent();
  const everReadyRef = useRef(false);
  if (!tree.loading) everReadyRef.current = true;

  useEffect(() => {
    if (tree.loading) return;
    assertRegistryAgainstDefs(tree.defs);
  }, [tree.defs, tree.loading]);

  // dnd-kit sensors. Require an 8-pixel mouse movement before a drag
  // starts — keeps the grip button click-friendly (touches that don't
  // intend to drag don't accidentally start one) and lets the underlying
  // tooltip / focus rings show normally on a quick click.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // Drag-end → `move_component` dispatch.
  //
  // For sprint 3a we only support **same-parent reorder**: the active
  // and over items must share a parent (which is the case when the
  // user drops on a sibling inside the same Container's
  // SortableContext). Cross-parent moves are a sprint-3 follow-up: the
  // dnd-kit drop event would have to flow through a higher-level
  // collision detector that knows about every Container, and the
  // `move_component` call would pass the new parent's id explicitly.
  //
  // After identifying that the move is same-parent we compute the
  // `afterSiblingId` semantically:
  //   - If active is moving *down* (new index > old index), it lands
  //     after `over` — so `afterSiblingId = over.id`.
  //   - If active is moving *up* (new index < old index), it lands
  //     before `over` — so `afterSiblingId = sibling immediately
  //     preceding `over` in the previous ordering`, or `undefined`
  //     when dropping at index 0.
  // This convention matches what `move_component`'s reducer expects
  // per `PEAR_COMPONENT_NODE_SCHEMA.md` § Integrity — sort order /
  // afterSiblingId is the post-move predecessor.
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeId = parseBigInt(active.id);
      const overId = parseBigInt(over.id);
      if (activeId == null || overId == null) return;

      const activeNode = tree.byId.get(activeId);
      const overNode = tree.byId.get(overId);
      if (!activeNode || !overNode) return;
      if (activeNode.parentId == null) return;
      if (activeNode.parentId !== overNode.parentId) {
        // Cross-parent drop — not supported in sprint 3a.
        return;
      }

      const siblings = tree.byParent.get(activeNode.parentId) ?? [];
      const oldIndex = siblings.findIndex((s) => s.id === activeId);
      const overIndex = siblings.findIndex((s) => s.id === overId);
      if (oldIndex < 0 || overIndex < 0) return;
      if (oldIndex === overIndex) return;

      let afterSiblingId: bigint | undefined;
      if (overIndex > oldIndex) {
        // Moving down — land after `over`.
        afterSiblingId = overNode.id;
      } else {
        // Moving up — land before `over`, i.e. after `over`'s predecessor.
        afterSiblingId =
          overIndex === 0 ? undefined : siblings[overIndex - 1]?.id;
      }

      moveComponent({
        componentId: activeId,
        newParentId: activeNode.parentId,
        afterSiblingId,
      });
    },
    [tree, moveComponent],
  );

  if (tree.loading && !everReadyRef.current) {
    return <SkeletonDoc />;
  }

  if (!tree.root) {
    return <EmptyTreeFallback />;
  }

  return (
    <SurfaceFocusProvider surfaceId={surfaceId}>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <ComponentNodeView node={tree.root} tree={tree} />
      </DndContext>
    </SurfaceFocusProvider>
  );
}

/**
 * dnd-kit identifiers are `string | number`; we stringify bigints into them.
 * Parses back, returning `null` on malformed input so the drag handler can
 * short-circuit gracefully.
 */
function parseBigInt(id: string | number): bigint | null {
  try {
    return BigInt(id);
  } catch {
    return null;
  }
}
