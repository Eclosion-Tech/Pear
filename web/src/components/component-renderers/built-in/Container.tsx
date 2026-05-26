"use client";

import { useMemo } from "react";
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

  // Gap / padding pulled from props but clamped — Tailwind only ships a
  // bounded set of spacing utilities. We use inline styles to avoid the
  // JIT-vs-runtime class generation question.
  const style: React.CSSProperties = {};
  if (typeof props.gap === "number") style.gap = `${props.gap * 0.25}rem`;
  if (typeof props.padding === "number")
    style.padding = `${props.padding * 0.25}rem`;
  if (typeof props.backgroundColor === "string") {
    style.backgroundColor = props.backgroundColor;
  }

  return (
    <div className={`${layoutClass} ${directionClass}`} style={style}>
      {children}
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
