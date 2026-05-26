"use client";

import { Children, useMemo } from "react";
import { useInsertComponent } from "@/src/hooks/usePages";
import type { ComponentRendererProps } from "../registry";

/**
 * Built-in `Container` component. Layout primitive — flex / grid / stack
 * modes with optional direction, gap, padding, background colour.
 *
 * Prop schema (`prop_schemas::CONTAINER` in components.rs):
 *   { layout: "flex" | "grid" | "stack" (required),
 *     direction?: "row" | "column",
 *     gap?: number,                       // tailwind gap value
 *     padding?: number,                   // tailwind padding value
 *     backgroundColor?: string }          // arbitrary CSS color
 *
 * Stack is the doc-flow default; the page root seeded by
 * `create_component_tree_page` uses { layout: "stack" }. We treat invalid
 * or missing layout as stack for the same defence-in-depth reason renderers
 * never throw on malformed props.
 */
type ContainerProps = {
  layout?: "flex" | "grid" | "stack";
  direction?: "row" | "column";
  gap?: number;
  padding?: number;
  backgroundColor?: string;
};

export function ContainerRenderer({ node, children }: ComponentRendererProps) {
  const props = useMemo<ContainerProps>(() => safeParse(node.props), [node.props]);
  const insertComponent = useInsertComponent();

  const layout = props.layout ?? "stack";
  const direction = props.direction ?? (layout === "stack" ? "column" : "row");

  const layoutClass =
    layout === "grid"
      ? "grid"
      : layout === "flex" || layout === "stack"
        ? "flex"
        : "flex";

  const directionClass =
    layout === "grid"
      ? ""
      : direction === "row"
        ? "flex-row"
        : "flex-col";

  const style: React.CSSProperties = {};
  if (typeof props.gap === "number") style.gap = `${props.gap * 0.25}rem`;
  if (typeof props.padding === "number")
    style.padding = `${props.padding * 0.25}rem`;
  if (typeof props.backgroundColor === "string") {
    style.backgroundColor = props.backgroundColor;
  }

  // Sprint-2 "add a block" affordance for the empty-tree case. A fresh
  // ComponentTree page lands with just an empty root Container and no
  // children — the user needs *something* to click. Sprint 3 generalizes
  // this into the slash menu / drag handles / Enter-to-insert flow at
  // every block boundary; here we only render it when the container has
  // zero rendered children, so it doesn't intrude once content exists.
  const isEmpty = Children.count(children) === 0;

  return (
    <div className={`${layoutClass} ${directionClass}`} style={style}>
      {children}
      {isEmpty && (
        <button
          type="button"
          onClick={() => {
            insertComponent({
              parentId: node.id,
              componentType: "RichText",
              propsJson: "{}",
              afterSiblingId: undefined,
            });
          }}
          className="my-2 self-start rounded-md border border-dashed
                     border-neutral-300 dark:border-neutral-700
                     px-3 py-1.5 text-xs text-neutral-500 dark:text-neutral-400
                     hover:border-neutral-400 dark:hover:border-neutral-600
                     hover:text-neutral-700 dark:hover:text-neutral-300
                     transition-colors"
          title="Insert a RichText block. Sprint 3 will add the slash menu."
        >
          + Add text block
        </button>
      )}
    </div>
  );
}

function safeParse(s: string): ContainerProps {
  try {
    return JSON.parse(s) as ContainerProps;
  } catch {
    return { layout: "stack" };
  }
}
