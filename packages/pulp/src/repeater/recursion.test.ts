/**
 * End-to-end recursion through the render path, using the exact template shape
 * the M3 sidebar ships.
 *
 * The materializer suite already covers nesting at the data level. This exists
 * because a report of "nested pages render flat" is ambiguous between two very
 * different failures — structurally flattened (recursion point not detected, or
 * children not spliced) versus structurally correct but visually un-indented.
 * Asserting on rendered DOM nesting separates them.
 */

import { describe, expect, test } from "vitest";
import { createElement, type ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PulpProvider } from "../context/PulpProvider";
import { registerRenderer } from "../registry";
import { BlockNodeView } from "../BlockNodeView";
import type {
  BlockNode,
  BlockTree,
  BlockTypeDefinition,
  PulpMutations,
} from "../types";
import type { QueryResolver, RepeaterRow } from "./dataSource";
import { RepeaterRenderer } from "./RepeaterRenderer";
import { REPEAT_CHILDREN_PROP, buildTemplate, findRecursionSlot } from "./template";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SURFACE = 1n;
const ROOT_ID = 1n;
const REPEATER_ID = 2n;
const ITEM_ID = 3n;
const LINK_ID = 4n;
const RECURSE_ID = 5n;

function Passthrough({ children }: { children: ReactNode }) {
  return createElement("div", { "data-container": "" }, children);
}
function Link({ node }: { node: BlockNode }) {
  const p = JSON.parse(node.props) as { pageTitle?: string };
  return createElement("span", { "data-link": "" }, p.pageTitle ?? "");
}

registerRenderer("Repeater", RepeaterRenderer);
registerRenderer("Container", Passthrough as never);
registerRenderer("PageLink", Link as never);

function def(componentType: string, acceptsChildren: boolean): BlockTypeDefinition {
  return { componentType, propSchema: "{}", acceptsChildren };
}
const DEFS = new Map<string, BlockTypeDefinition>([
  ["Repeater", def("Repeater", true)],
  ["Container", def("Container", true)],
  ["PageLink", def("PageLink", false)],
]);

function node(
  id: bigint,
  parentId: bigint | null,
  componentType: string,
  props: Record<string, unknown>,
  order = 0,
): BlockNode {
  return { id, surfaceId: SURFACE, parentId, componentType, props: JSON.stringify(props), order };
}

/** Mirrors `RepeaterSidebarTree.STORED_NODES` exactly. */
const STORED: BlockNode[] = [
  node(ROOT_ID, null, "Container", { layout: "stack" }),
  node(REPEATER_ID, ROOT_ID, "Repeater", {
    dataSource: {
      v: 1,
      entity: { kind: "pages", parentId: null, includeDescendants: true },
      sort: [{ property: "sortOrder", dir: "asc" }],
    },
  }),
  node(ITEM_ID, REPEATER_ID, "Container", { layout: "stack" }),
  node(LINK_ID, ITEM_ID, "PageLink", { pageId: "{{row.id}}", pageTitle: "{{row.title}}" }),
  node(RECURSE_ID, ITEM_ID, "Container", { [REPEAT_CHILDREN_PROP]: true, layout: "stack" }, 1),
];

function tree(): BlockTree {
  const byId = new Map<bigint, BlockNode>();
  const byParent = new Map<bigint | null, BlockNode[]>();
  for (const n of STORED) {
    byId.set(n.id, n);
    const key = n.parentId ?? null;
    const arr = byParent.get(key);
    if (arr) arr.push(n);
    else byParent.set(key, [n]);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => Number(a.order) - Number(b.order));
  return { root: byId.get(ROOT_ID) ?? null, byId, byParent, defs: DEFS, yjs: new Map(), loading: false };
}

const NOOP: PulpMutations = {
  insertBlock: () => {},
  deleteBlock: () => {},
  moveBlock: () => {},
  updateBlockProps: () => {},
  saveYjsState: () => {},
};

/** parent → child → grandchild, plus an unrelated root. */
const ROWS: RepeaterRow[] = [
  { id: 1n, parentId: null, title: "parent", sortOrder: 0 },
  { id: 2n, parentId: 1n, title: "child", sortOrder: 1 },
  { id: 3n, parentId: 2n, title: "grandchild", sortOrder: 2 },
  { id: 9n, parentId: null, title: "sibling-root", sortOrder: 3 },
];

function renderWith(rows: RepeaterRow[]): { container: HTMLDivElement; root: Root } {
  const resolver: QueryResolver = {
    subscribe(_ds, onRows) {
      onRows(rows);
      return () => {};
    },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const t = tree();
  act(() => {
    root.render(
      createElement(
        PulpProvider,
        {
          tree: t,
          config: { idbPrefix: "", readOnly: true, queryResolver: resolver },
          mutations: NOOP,
        },
        createElement(BlockNodeView, { node: t.root as BlockNode, tree: t }),
      ),
    );
  });
  return { container, root };
}

describe("the shipped sidebar template", () => {
  test("detects its recursion point", () => {
    expect(findRecursionSlot(buildTemplate(tree(), REPEATER_ID))).not.toBeNull();
  });

  test("renders every row exactly once", () => {
    const { container, root } = renderWith(ROWS);
    const titles = Array.from(container.querySelectorAll("[data-link]")).map((e) => e.textContent);
    expect(titles.sort()).toEqual(["child", "grandchild", "parent", "sibling-root"]);
    act(() => root.unmount());
    container.remove();
  });

  test("nests descendants in the DOM rather than flattening them", () => {
    const { container, root } = renderWith(ROWS);

    const linkFor = (title: string) =>
      Array.from(container.querySelectorAll("[data-link]")).find((e) => e.textContent === title);

    const parent = linkFor("parent");
    const child = linkFor("child");
    const grandchild = linkFor("grandchild");
    const siblingRoot = linkFor("sibling-root");
    expect(parent && child && grandchild && siblingRoot).toBeTruthy();

    // The parent's item wrapper must contain the child's link; a flattened
    // tree would put them in disjoint subtrees.
    const parentItem = parent!.closest("[data-container]")!;
    expect(parentItem.contains(child!)).toBe(true);
    expect(parentItem.contains(grandchild!)).toBe(true);

    // Depth strictly increases down the chain.
    const depth = (el: Element) => {
      let d = 0;
      let cur: Element | null = el;
      while (cur && cur !== container) {
        if (cur.hasAttribute("data-container")) d++;
        cur = cur.parentElement;
      }
      return d;
    };
    expect(depth(child!)).toBeGreaterThan(depth(parent!));
    expect(depth(grandchild!)).toBeGreaterThan(depth(child!));

    // An unrelated root must NOT be nested under the parent.
    expect(parentItem.contains(siblingRoot!)).toBe(false);

    act(() => root.unmount());
    container.remove();
  });
});
