"use client";

import { useState, type ReactNode } from "react";
import { useInsertComponent } from "@/src/hooks/usePages";
import type { ComponentNode } from "@/src/module_bindings/types";

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
 */
export function BlockChrome({
  node,
  children,
}: {
  node: ComponentNode;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const insertComponent = useInsertComponent();

  return (
    <div
      className="group relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`absolute -left-12 top-0 flex items-start gap-0.5 pt-1
                    transition-opacity duration-100
                    ${hovered ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        <button
          type="button"
          onClick={() => {
            // BlockChrome is only rendered for non-root nodes (the walker
            // skips it when `parentId == null`), so `node.parentId` is
            // always defined here. Guard defensively against a future
            // walker change and no-op if somehow null.
            if (node.parentId == null) return;
            insertComponent({
              parentId: node.parentId,
              componentType: "RichText",
              propsJson: "{}",
              afterSiblingId: node.id,
            });
          }}
          title="Insert a RichText block below. Sprint 3 will add the slash menu."
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
          type="button"
          title="Drag to reorder (sprint 3)"
          aria-label="Drag handle"
          // No onClick / drag wiring yet. Cursor + visual feedback only.
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
    </div>
  );
}
