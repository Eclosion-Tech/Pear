"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useInsertComponent } from "@/src/hooks/usePages";
import { useSurfaceFocus } from "@/src/hooks/useSurfaceFocus";
import type { ComponentNode } from "@/src/module_bindings/types";
import { BlockMenu } from "./BlockMenu";

/**
 * Hover-reveal block chrome — the `+` (insert sibling below) and grip
 * (drag handle, visual-only at sprint 2) that sit in the left gutter of
 * every non-root `ComponentNode`. Patterned after Notion / BlockNote
 * block affordances.
 *
 * - `+` button → calls `insert_component` with the same parent and
 *   `afterSiblingId = this node`, producing a new `RichText` sibling
 *   directly below. Sprint 3 will replace this with a slash menu that
 *   picks the new block type.
 * - Grip is visual at sprint 2 (cursor: grab). Sprint 3 wires it to
 *   `dnd-kit` and the `move_component` reducer per the ADR § Block
 *   chrome — Drag handles.
 *
 * The root container doesn't get chrome — it has nothing to be a sibling
 * of and no peer to drag with. The walker (`ComponentNodeView`) decides
 * which nodes to wrap.
 *
 * **Hover gating.** Chrome visibility is pure CSS (`group-hover`) rather
 * than React state. A naïve approach with `onMouseEnter`/`onMouseLeave`
 * on the wrapper breaks because the chrome lives at `-left-12` — fully
 * outside the wrapper's bounding box. The cursor traverses a hairline
 * gap to reach the chrome and `onMouseLeave` fires before the chrome can
 * grab the pointer.
 *
 * The fix is a transparent **hover extender** — an invisible spacer
 * (`pointer-events-auto`) sibling of the chrome that covers the entire
 * 48-px left gutter. Because the extender is a DOM descendant of the
 * `group` wrapper, hovering anywhere in the gutter keeps `group-hover`
 * true, which keeps the chrome `opacity-100` *and* `pointer-events-auto`
 * — there's no race between visibility and hit-testability.
 *
 * Without the extender we hit a classic chicken-and-egg: the chrome
 * starts `pointer-events-none` (so users can't click invisible buttons
 * in the gutter), but a `hover:pointer-events-auto` fallback on the
 * chrome itself never fires because the chrome is non-hit-testable in
 * the first place. The extender resolves this by being the always-on
 * hit target that triggers `group-hover` before the chrome needs to
 * receive any pointer events of its own.
 */
export function BlockChrome({
  node,
  children,
}: {
  node: ComponentNode;
  children: ReactNode;
}) {
  const insertComponent = useInsertComponent();
  const focus = useSurfaceFocus();

  // Block-actions menu (Notion-style) — opened by clicking (not dragging)
  // the grip button. dnd-kit's PointerSensor activationConstraint of 8 px
  // gives us the click-vs-drag boundary: a click on the grip with <8 px
  // movement releases the pointer without starting a drag, and our normal
  // onClick handler runs to open the menu.
  //
  // We keep a separate ref to the grip button so the menu can position
  // itself relative to it. setActivatorNodeRef from useSortable wraps over
  // this ref to keep both wires intact.
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const gripRef = useRef<HTMLButtonElement | null>(null);

  // `@dnd-kit/sortable` machinery — drives reordering via the grip button.
  // The `id` is stringified because dnd-kit requires `string | number`, not
  // `bigint`. We pair this BlockChrome with a `<SortableContext>` rendered
  // by the parent `Container` (whose `byParent` slice declares the sort
  // order) and a top-level `<DndContext>` in `<ComponentTreeRenderer>`.
  //
  // Listeners attach to `setActivatorNodeRef` — only the grip button can
  // initiate a drag; clicking the block body, the `+`, or the trash does
  // not. `attributes` carry accessibility hints (aria-roledescription,
  // tabindex, etc.) and ride on the activator node.
  //
  // Outside of a SortableContext the hook is essentially inert: `transform`
  // and `transition` stay `null`, so the block renders normally and the
  // listeners no-op. That keeps BlockChrome safe to mount before the wider
  // dnd machinery is in place.
  const sortable = useSortable({ id: node.id.toString() });
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = sortable;

  const wrapperStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };

  return (
    <div ref={setNodeRef} style={wrapperStyle} className="group relative">
      {/* Invisible hover-extender spanning the full 48-px gutter. Its
          only job is to be a hit target that keeps `group-hover` true as
          the cursor enters the chrome area. */}
      <div
        aria-hidden="true"
        className="absolute -left-12 inset-y-0 w-12 pointer-events-auto"
      />
      <div
        className="absolute -left-12 top-0 flex items-start gap-0.5 pt-1
                   opacity-0 pointer-events-none transition-opacity duration-100
                   group-hover:opacity-100 group-hover:pointer-events-auto"
      >
        <button
          type="button"
          onClick={() => {
            // BlockChrome is only rendered for non-root nodes (the walker
            // skips it when `parentId == null`), so `node.parentId` is
            // always defined here. Guard defensively against a future
            // walker change and no-op if somehow null.
            if (node.parentId == null) return;
            focus.armForInsert(node.parentId, node.id);
            insertComponent({
              parentId: node.parentId,
              componentType: "RichText",
              propsJson: "{}",
              afterSiblingId: node.id,
            });
          }}
          title="Insert a RichText block below"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700
                     dark:hover:bg-neutral-800 dark:hover:text-neutral-300
                     transition-colors"
          aria-label="Insert block below"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 3v10M3 8h10"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          ref={(el) => {
            setActivatorNodeRef(el);
            gripRef.current = el;
          }}
          {...attributes}
          {...listeners}
          type="button"
          onClick={() => {
            // Click (no drag) — open the block menu. dnd-kit only suppresses
            // the click if the pointer moved >8 px between down and up, so
            // a quick tap on the grip reliably reaches this handler.
            const el = gripRef.current;
            if (!el) return;
            setMenuRect(el.getBoundingClientRect());
          }}
          title="Drag to reorder, click for block actions"
          aria-label="Block actions / drag handle"
          aria-haspopup="menu"
          aria-expanded={menuRect != null}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700
                     dark:hover:bg-neutral-800 dark:hover:text-neutral-300
                     cursor-grab active:cursor-grabbing
                     transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="6" cy="3" r="1" fill="currentColor" />
            <circle cx="10" cy="3" r="1" fill="currentColor" />
            <circle cx="6" cy="8" r="1" fill="currentColor" />
            <circle cx="10" cy="8" r="1" fill="currentColor" />
            <circle cx="6" cy="13" r="1" fill="currentColor" />
            <circle cx="10" cy="13" r="1" fill="currentColor" />
          </svg>
        </button>
      </div>
      {children}
      {menuRect != null && (
        <BlockMenu
          node={node}
          anchorRect={menuRect}
          onClose={() => setMenuRect(null)}
        />
      )}
    </div>
  );
}
