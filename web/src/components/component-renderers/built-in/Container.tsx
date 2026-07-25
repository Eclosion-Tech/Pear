"use client";

import { Children, useMemo } from "react";
import {
  BlockChromeHeaderControls,
  ContainerDropZone,
  isVirtualId,
  knownSiblingIdsForParent,
  parseStyleTokens,
  parseTheme,
  usePulp,
  useSurfaceFocus,
  type BlockRendererProps,
} from "@eclosion-tech/pulp";
import { styleClasses } from "@/src/components/component-renderers/style/spaceClasses";
import {
  themeClasses,
  themeStyle,
} from "@/src/components/component-renderers/style/themeStyles";
import { usePearWorkspaceSlug } from "@/src/lib/blobUpload";

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
  /** @deprecated numeric scale — prefer `style.gap` (style_v1). Still honoured. */
  gap?: number;
  /** @deprecated numeric scale — prefer `style.padding` (style_v1). Still honoured. */
  padding?: number;
  /**
   * @deprecated raw CSS value — the one prop that cannot be theme-aware, and
   * the reason the style vocabulary exists. Honoured for existing trees; a
   * later migration rewrites stored values to a `tone` token (ADR D7).
   */
  backgroundColor?: string;
  style?: unknown;
  /**
   * Page Theme (style_v1 S2, ADR D9). Stored on the *root* container, which is
   * why it needs no new `Page` column and why it serializes into
   * `component_tree_v1` — and therefore travels on export and fork — for free.
   */
  theme?: unknown;
};

export function ContainerRenderer({ node, def, tree, children }: BlockRendererProps) {
  const props = useMemo<ContainerProps>(() => safeParse(node.props), [node.props]);
  // style_v1 tokens. Parsed through pulp's allowlist (ADR D5) — unknown keys
  // and values resolve to unset and never reach the DOM.
  const styleTokens = useMemo(() => parseStyleTokens(props.style), [props.style]);
  const tokenClasses = styleClasses(styleTokens);

  // Page Theme rides the root container (D9). Applying it here rather than in a
  // wrapper means CSS's own inheritance carries font and accent to descendants
  // — no second cascade to reason about, which is what keeps the "tokens do not
  // cascade" rule honest while Theme still establishes page-level context.
  const slug = usePearWorkspaceSlug();
  const theme = useMemo(() => parseTheme(props.theme), [props.theme]);
  const themeClassNames = themeClasses(theme);
  const themeInlineStyle = useMemo(() => themeStyle(theme, slug), [theme, slug]);
  const { insertBlock } = usePulp();
  const focus = useSurfaceFocus();
  const acceptsChildren = def.acceptsChildren;

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
  // Page root is an invisible layout shell — nested containers (from the
  // slash menu) get a light chrome outline so structure is visible while
  // editing. Matches the empty-state dashed affordance language.
  const isRoot = node.parentId == null;
  const nestedChrome = isRoot
    ? ""
    : "relative rounded-md border border-dashed border-neutral-200 " +
      // Reserve an inner gutter column so child block chrome (+ / grip)
      // sits inside the dashed border instead of straddling it.
      "dark:border-neutral-700 min-h-[2rem] pl-12 pr-2 " +
      // When children exist, leave room under the absolute header row
      // (container + / grip) so the first child's gutter doesn't overlap.
      (isEmpty ? "py-2" : "pt-7 pb-2") +
      " group/container";

  // A materialized container is structurally read-only (ADR D2): nothing drops
  // into a virtual subtree. `canDropInto` already rejects such a move, but
  // registering the drop target anyway would advertise an affordance that
  // silently does nothing — so skip the zone entirely.
  //
  // `nestedChrome` is dropped too. Its dashed border and `min-h` exist to make
  // an *editable* empty container discoverable; on a derived node there is
  // nothing to drop in, so it renders as an empty placeholder box under every
  // leaf row. A virtual container with no children should occupy no space.
  //
  // Spacing comes from `style` tokens the template sets — not from a hardcoded
  // class here, which would bake one surface's layout policy into every
  // consumer of Container. A materialized container with no tokens occupies no
  // space at all, which is what leaf rows want.
  if (isVirtualId(node.id)) {
    return (
      <div
        className={`${layoutClass} ${directionClass} ${tokenClasses} ${themeClassNames}`}
        style={{ ...style, ...themeInlineStyle }}
      >
        {children}
      </div>
    );
  }

  return (
    <ContainerDropZone
      containerId={node.id}
      tree={tree}
      acceptsChildren={acceptsChildren}
      className={`${layoutClass} ${directionClass} ${nestedChrome} ${tokenClasses} ${themeClassNames}`}
      style={{ ...style, ...themeInlineStyle }}
      header={
        isRoot ? undefined : (
          <div
            className="pointer-events-none absolute left-2 top-1.5 z-[1] flex items-center gap-2
                       opacity-0 transition-opacity duration-100
                       group-hover/container:opacity-100
                       group-focus-within/container:opacity-100"
          >
            <BlockChromeHeaderControls />
            <span
              className="text-[10px] font-mono leading-none
                         text-neutral-400 dark:text-neutral-500"
              aria-hidden
            >
              Container
            </span>
          </div>
        )
      }
      footer={
        isEmpty ? (
          <button
            type="button"
            onClick={() => {
              focus.armForInsert(node.id, undefined, {
                knownSiblingIds: knownSiblingIdsForParent(tree, node.id),
              });
              insertBlock({
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
            title="Insert a RichText block. Try typing / inside one to insert other block types."
          >
            + Add text block
          </button>
        ) : undefined
      }
    >
      {children}
    </ContainerDropZone>
  );
}

function safeParse(s: string): ContainerProps {
  try {
    return JSON.parse(s) as ContainerProps;
  } catch {
    return { layout: "stack" };
  }
}
