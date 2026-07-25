/**
 * `<RepeaterRenderer>` — client-render behaviour.
 *
 * The materializer suite proves node objects are *reused*. This suite proves
 * the other half of D3: that reuse actually translates into skipped React work.
 * Identity preservation with a render path that re-renders anyway would buy
 * nothing, and the failure is invisible — correct pixels, 12× the cost — so it
 * is asserted with render counts rather than inferred.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
  PulpConfig,
  PulpMutations,
} from "../types";
import type { DataSourceConfig, QueryResolver, RepeaterRow } from "./dataSource";
import { RepeaterRenderer } from "./RepeaterRenderer";

// Without this, `act()` does not actually flush and the render-count
// assertions below would pass without measuring anything.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SURFACE = 0n;
const REPEATER = 10n;

/* ------------------------------------------------------------------ */
/* Counting renderers                                                  */
/* ------------------------------------------------------------------ */

const counts = { Card: 0, Label: 0 };

function CountingCard({ children }: { children: ReactNode }) {
  counts.Card++;
  return createElement("div", { "data-card": "" }, children);
}

function CountingLabel({ node }: { node: BlockNode }) {
  counts.Label++;
  const props = JSON.parse(node.props) as { text?: string };
  return createElement("span", { "data-label": "" }, props.text ?? "");
}

registerRenderer("Repeater", RepeaterRenderer);
registerRenderer("Card", CountingCard as never);
registerRenderer("Label", CountingLabel as never);

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function def(componentType: string, acceptsChildren: boolean): BlockTypeDefinition {
  return { componentType, propSchema: "{}", acceptsChildren };
}

const DEFS = new Map<string, BlockTypeDefinition>([
  ["Repeater", def("Repeater", true)],
  ["Card", def("Card", true)],
  ["Label", def("Label", false)],
]);

const DATA_SOURCE: DataSourceConfig = { v: 1, entity: { kind: "pages", parentId: 68n } };

function node(
  id: bigint,
  parentId: bigint | null,
  componentType: string,
  props: Record<string, unknown>,
  order = 0,
): BlockNode {
  return { id, surfaceId: SURFACE, parentId, componentType, props: JSON.stringify(props), order };
}

/** Repeater(dataSource) > Card > Label. */
function buildTree(): BlockTree {
  const nodes = [
    node(REPEATER, null, "Repeater", { dataSource: { v: 1, entity: { kind: "pages", parentId: 68 } } }),
    node(20n, REPEATER, "Card", { pageId: "{{row.id}}" }),
    node(21n, 20n, "Label", { text: "{{row.title}}" }),
  ];
  const byId = new Map<bigint, BlockNode>();
  const byParent = new Map<bigint | null, BlockNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    const key = n.parentId ?? null;
    const arr = byParent.get(key);
    if (arr) arr.push(n);
    else byParent.set(key, [n]);
  }
  return {
    root: byId.get(REPEATER) ?? null,
    byId,
    byParent,
    defs: DEFS,
    yjs: new Map(),
    loading: false,
  };
}

/** Resolver a test drives by hand, so deliveries are explicit. */
function controllableResolver() {
  let push: ((rows: ReadonlyArray<RepeaterRow>) => void) | null = null;
  let subscribes = 0;
  let unsubscribes = 0;
  const resolver: QueryResolver = {
    subscribe(_ds, onRows) {
      subscribes++;
      push = onRows;
      return () => {
        unsubscribes++;
        push = null;
      };
    },
  };
  return {
    resolver,
    deliver: (rows: ReadonlyArray<RepeaterRow>) => act(() => push?.(rows)),
    stats: () => ({ subscribes, unsubscribes }),
  };
}

const NOOP_MUTATIONS: PulpMutations = {
  insertBlock: () => {},
  deleteBlock: () => {},
  moveBlock: () => {},
  updateBlockProps: () => {},
  saveYjsState: () => {},
};

let container: HTMLDivElement;
let root: Root;

function render(tree: BlockTree, config: PulpConfig) {
  act(() => {
    root.render(
      createElement(
        PulpProvider,
        { tree, config, mutations: NOOP_MUTATIONS },
        createElement(BlockNodeView, { node: tree.root as BlockNode, tree }),
      ),
    );
  });
}

beforeEach(() => {
  counts.Card = 0;
  counts.Label = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/* ------------------------------------------------------------------ */

describe("rendering", () => {
  test("materializes one template instance per row", () => {
    const { resolver, deliver } = controllableResolver();
    render(buildTree(), { idbPrefix: "t", readOnly: true, queryResolver: resolver });

    deliver([
      { id: 1n, parentId: 68n, title: "alpha" },
      { id: 2n, parentId: 68n, title: "beta" },
    ]);

    expect(container.querySelectorAll("[data-card]")).toHaveLength(2);
    expect(
      Array.from(container.querySelectorAll("[data-label]")).map((e) => e.textContent),
    ).toEqual(["alpha", "beta"]);
  });

  test("surfaces a notice instead of rendering nothing when no resolver is configured", () => {
    render(buildTree(), { idbPrefix: "t", readOnly: true });
    expect(container.textContent).toContain("no query resolver configured");
  });

  test("surfaces the parse error for an invalid data source", () => {
    const tree = buildTree();
    const bad = { ...(tree.root as BlockNode), props: JSON.stringify({ dataSource: { entity: {} } }) };
    tree.byId.set(REPEATER, bad);
    tree.root = bad;
    const { resolver } = controllableResolver();
    render(tree, { idbPrefix: "t", readOnly: true, queryResolver: resolver });
    expect(container.textContent).toContain("dataSource.v is required");
  });

  test("an empty result set says so", () => {
    const { resolver, deliver } = controllableResolver();
    render(buildTree(), { idbPrefix: "t", readOnly: true, queryResolver: resolver });
    deliver([]);
    expect(container.textContent).toContain("no rows match");
  });
});

describe("memo bail-out (the render half of D3's 12x)", () => {
  test("an identical delivery re-renders nothing", () => {
    const { resolver, deliver } = controllableResolver();
    render(buildTree(), { idbPrefix: "t", readOnly: true, queryResolver: resolver });

    const rows: RepeaterRow[] = [
      { id: 1n, parentId: 68n, title: "alpha" },
      { id: 2n, parentId: 68n, title: "beta" },
    ];
    deliver(rows);
    const after = { ...counts };

    // New array, same row objects — the useTable delivery contract.
    deliver(rows.slice());

    expect(counts.Card).toBe(after.Card);
    expect(counts.Label).toBe(after.Label);
  });

  test("a single changed row re-renders only that row's subtree", () => {
    const { resolver, deliver } = controllableResolver();
    render(buildTree(), { idbPrefix: "t", readOnly: true, queryResolver: resolver });

    const rows: RepeaterRow[] = [
      { id: 1n, parentId: 68n, title: "alpha" },
      { id: 2n, parentId: 68n, title: "beta" },
      { id: 3n, parentId: 68n, title: "gamma" },
    ];
    deliver(rows);
    counts.Card = 0;
    counts.Label = 0;

    deliver([rows[0], { ...rows[1], title: "renamed" }, rows[2]]);

    // Exactly one card and one label — not all three.
    expect(counts.Card).toBe(1);
    expect(counts.Label).toBe(1);
    expect(container.textContent).toContain("renamed");
  });

  test("a host tree re-index does not re-render materialized rows", () => {
    // The host rebuilds `tree` (new object, new maps) on every delivery. If the
    // virtual render path took that as a prop, every row would re-render — the
    // exact pattern the repeater is supposed to beat.
    const { resolver, deliver } = controllableResolver();
    const config: PulpConfig = { idbPrefix: "t", readOnly: true, queryResolver: resolver };
    render(buildTree(), config);
    deliver([
      { id: 1n, parentId: 68n, title: "alpha" },
      { id: 2n, parentId: 68n, title: "beta" },
    ]);
    counts.Card = 0;
    counts.Label = 0;

    render(buildTree(), config); // fresh tree object, identical content

    expect(counts.Card).toBe(0);
    expect(counts.Label).toBe(0);
  });
});

describe("subscription lifecycle", () => {
  test("an equal-but-new dataSource does not churn the subscription", () => {
    const { resolver, deliver, stats } = controllableResolver();
    const tree = buildTree();
    const config: PulpConfig = { idbPrefix: "t", readOnly: true, queryResolver: resolver };
    render(tree, config);
    deliver([{ id: 1n, parentId: 68n, title: "alpha" }]);

    // Re-render with a structurally identical config parsed from fresh JSON.
    render(buildTree(), config);
    render(buildTree(), config);

    expect(stats().subscribes).toBe(1);
    expect(stats().unsubscribes).toBe(0);
  });

  test("a changed dataSource resubscribes", () => {
    const { resolver, stats } = controllableResolver();
    const config: PulpConfig = { idbPrefix: "t", readOnly: true, queryResolver: resolver };
    render(buildTree(), config);

    const tree = buildTree();
    const changed = {
      ...(tree.root as BlockNode),
      props: JSON.stringify({ dataSource: { v: 1, entity: { kind: "pages", parentId: 99 } } }),
    };
    tree.byId.set(REPEATER, changed);
    tree.root = changed;
    render(tree, config);

    expect(stats().subscribes).toBe(2);
    expect(stats().unsubscribes).toBe(1);
  });
});

describe("editor affordances (D2)", () => {
  test("virtual subtrees render without block chrome", () => {
    const { resolver, deliver } = controllableResolver();
    // Editable surface — chrome would appear for stored nodes here.
    render(buildTree(), { idbPrefix: "t", queryResolver: resolver });
    deliver([{ id: 1n, parentId: 68n, title: "alpha" }]);

    const card = container.querySelector("[data-card]");
    expect(card).not.toBeNull();
    // No drag grip / insert affordance anywhere inside the materialized subtree.
    expect(card?.closest("[data-block-chrome]")).toBeNull();
  });
});

export { DATA_SOURCE };
