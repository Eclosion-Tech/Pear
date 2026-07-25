/**
 * Equivalence + identity-preservation suite for the repeater materializer.
 *
 * Two things are under test, and they fail in different ways:
 *
 * 1. **Equivalence** — incremental must produce structurally identical output
 *    to the naive oracle. A divergence here is wrong content on screen.
 * 2. **Identity preservation** — unchanged subtrees must come back as the
 *    *same object*. A regression here is invisible to equivalence tests and
 *    silently costs the 12× render gap D3 was decided on, so it is asserted
 *    explicitly with `toBe`.
 */

import { describe, expect, test } from "vitest";
import type { BlockNode, BlockTree, BlockTypeDefinition } from "../types";
import type { RepeaterRow } from "./dataSource";
import { IncrementalMaterializer, materializeNaive, type VirtualNode } from "./materialize";
import { buildTemplate, findRecursionSlot } from "./template";
import { isVirtualId, virtualId } from "./virtualId";

const SURFACE = 1n;
const REPEATER = 100n;

function node(
  id: bigint,
  parentId: bigint | null,
  componentType: string,
  props: Record<string, unknown>,
  order = 0,
): BlockNode {
  return {
    id,
    surfaceId: SURFACE,
    parentId,
    componentType,
    props: JSON.stringify(props),
    order,
  };
}

/** Minimal tree containing just a repeater and its stored template children. */
function treeOf(nodes: BlockNode[]): BlockTree {
  const byId = new Map<bigint, BlockNode>();
  const byParent = new Map<bigint | null, BlockNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    const key = n.parentId ?? null;
    const arr = byParent.get(key);
    if (arr) arr.push(n);
    else byParent.set(key, [n]);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => Number(a.order) - Number(b.order));
  }
  return {
    root: byId.get(REPEATER) ?? null,
    byId,
    byParent,
    defs: new Map<string, BlockTypeDefinition>(),
    yjs: new Map(),
    loading: false,
  };
}

/** Flat card template: Card > [Heading, Button]. */
const flatTree = treeOf([
  node(REPEATER, null, "Repeater", {}),
  node(200n, REPEATER, "Card", { pageId: "{{row.id}}" }, 0),
  node(201n, 200n, "Heading", { text: "{{row.emoji}} {{row.title}}" }, 0),
  node(202n, 200n, "Button", { label: "Open", target: "{{row.id}}" }, 1),
]);

/** Sidebar template: Item > Container(repeatChildren). */
const recursiveTree = treeOf([
  node(REPEATER, null, "Repeater", {}),
  node(300n, REPEATER, "PageLink", { title: "{{row.title}}", pageId: "{{row.id}}" }, 0),
  node(301n, 300n, "Container", { repeatChildren: true, indent: 1 }, 0),
]);

function row(id: bigint, extra: Record<string, unknown> = {}): RepeaterRow {
  return { id, title: `Page ${id}`, emoji: "📄", ...extra };
}

function flatten(nodes: VirtualNode[]): VirtualNode[] {
  const out: VirtualNode[] = [];
  const walk = (n: VirtualNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** Structural view, ignoring object identity. */
function shape(nodes: VirtualNode[]): unknown {
  return nodes.map((n) => ({
    id: String(n.id),
    parentId: n.parentId === null ? null : String(n.parentId),
    componentType: n.componentType,
    props: n.props,
    rowId: String(n.rowId),
    children: shape(n.children),
  }));
}

describe("template extraction", () => {
  test("reads the repeater's stored children as a template forest", () => {
    const t = buildTemplate(flatTree, REPEATER);
    expect(t).toHaveLength(1);
    expect(t[0].componentType).toBe("Card");
    expect(t[0].children.map((c) => c.componentType)).toEqual(["Heading", "Button"]);
  });

  test("slots are pre-order and unique", () => {
    const t = buildTemplate(flatTree, REPEATER);
    const slots: number[] = [];
    const walk = (n: (typeof t)[number]) => {
      slots.push(n.slot);
      n.children.forEach(walk);
    };
    t.forEach(walk);
    expect(slots).toEqual([0, 1, 2]);
  });

  test("finds the recursion point, and reports null for flat templates", () => {
    expect(findRecursionSlot(buildTemplate(recursiveTree, REPEATER))).toBe(1);
    expect(findRecursionSlot(buildTemplate(flatTree, REPEATER))).toBeNull();
  });

  test("an empty repeater yields an empty template rather than throwing", () => {
    expect(buildTemplate(treeOf([node(REPEATER, null, "Repeater", {})]), REPEATER)).toEqual([]);
  });
});

describe("prop resolution", () => {
  test("substitutes {{row.*}} and strips the repeatChildren marker", () => {
    const t = buildTemplate(recursiveTree, REPEATER);
    const out = materializeNaive(REPEATER, SURFACE, t, [row(7n)]);
    const link = out[0];
    expect(JSON.parse(link.props)).toEqual({ title: "Page 7", pageId: "7" });
    const container = link.children[0];
    expect(JSON.parse(container.props)).toEqual({ indent: 1 });
  });

  test("a whole-value placeholder preserves the row value's type", () => {
    const tree = treeOf([
      node(REPEATER, null, "Repeater", {}),
      node(200n, REPEATER, "Card", { count: "{{row.count}}", label: "n={{row.count}}" }),
    ]);
    const out = materializeNaive(REPEATER, SURFACE, buildTemplate(tree, REPEATER), [
      { id: 1n, count: 42 },
    ]);
    const props = JSON.parse(out[0].props);
    expect(props.count).toBe(42);
    expect(props.label).toBe("n=42");
  });

  test("missing fields resolve to null / empty rather than the literal placeholder", () => {
    const tree = treeOf([
      node(REPEATER, null, "Repeater", {}),
      node(200n, REPEATER, "Card", { a: "{{row.nope}}", b: "x{{row.nope}}y" }),
    ]);
    const out = materializeNaive(REPEATER, SURFACE, buildTemplate(tree, REPEATER), [{ id: 1n }]);
    expect(JSON.parse(out[0].props)).toEqual({ a: null, b: "xy" });
  });
});

describe("virtual ids", () => {
  test("are stable for the same tuple and flagged as virtual", () => {
    const a = virtualId(REPEATER, 5n, 3);
    expect(virtualId(REPEATER, 5n, 3)).toBe(a);
    expect(isVirtualId(a)).toBe(true);
  });

  test("are disjoint from the u64 row-id domain", () => {
    expect(isVirtualId(0n)).toBe(false);
    expect(isVirtualId((1n << 64n) - 1n)).toBe(false);
  });

  test("two repeaters over the same row do not collide (the spike scheme's gap)", () => {
    expect(virtualId(100n, 5n, 0)).not.toBe(virtualId(101n, 5n, 0));
  });

  test("templates larger than 255 slots are addressable (the other spike gap)", () => {
    const ids = new Set<bigint>();
    for (let slot = 0; slot < 1000; slot++) ids.add(virtualId(REPEATER, 5n, slot));
    expect(ids.size).toBe(1000);
  });
});

describe("incremental vs naive equivalence", () => {
  const cases: Array<[string, BlockTree, RepeaterRow[]]> = [
    ["flat", flatTree, [row(1n), row(2n), row(3n)]],
    [
      "recursive",
      recursiveTree,
      [row(1n), row(2n, { parentId: 1n }), row(3n, { parentId: 1n }), row(4n, { parentId: 2n })],
    ],
    ["empty rows", flatTree, []],
  ];

  for (const [name, tree, rows] of cases) {
    test(`${name}: incremental output matches the naive oracle`, () => {
      const template = buildTemplate(tree, REPEATER);
      const inc = new IncrementalMaterializer(REPEATER, SURFACE, template).update(rows);
      const naive = materializeNaive(REPEATER, SURFACE, template, rows);
      expect(shape(inc)).toEqual(shape(naive));
    });
  }

  test("stays equivalent across a sequence of deliveries", () => {
    const template = buildTemplate(recursiveTree, REPEATER);
    const m = new IncrementalMaterializer(REPEATER, SURFACE, template);

    const deliveries: RepeaterRow[][] = [
      [row(1n), row(2n, { parentId: 1n })],
      [row(1n), row(2n, { parentId: 1n }), row(3n, { parentId: 1n })],
      [row(1n), row(3n, { parentId: 1n })],
      [row(1n)],
      [],
    ];

    for (const rows of deliveries) {
      expect(shape(m.update(rows))).toEqual(shape(materializeNaive(REPEATER, SURFACE, template, rows)));
    }
  });

  test("nested rows parent onto the recursion point, not the row id", () => {
    const template = buildTemplate(recursiveTree, REPEATER);
    const out = materializeNaive(REPEATER, SURFACE, template, [
      row(1n),
      row(2n, { parentId: 1n }),
    ]);
    const container = out[0].children[0];
    const nested = container.children[0];
    expect(nested.parentId).toBe(container.id);
    expect(isVirtualId(nested.parentId as bigint)).toBe(true);
  });
});

describe("identity preservation (the 12x that D3 turns on)", () => {
  test("an identical delivery reuses every node object", () => {
    const template = buildTemplate(flatTree, REPEATER);
    const m = new IncrementalMaterializer(REPEATER, SURFACE, template);
    const rows = [row(1n), row(2n), row(3n)];

    const first = m.update(rows);
    const second = m.update(rows.slice()); // new array, same row objects
    expect(second).toHaveLength(first.length);
    second.forEach((n, i) => expect(n).toBe(first[i]));
  });

  test("a single changed row rebuilds only that row's subtree", () => {
    const template = buildTemplate(flatTree, REPEATER);
    const m = new IncrementalMaterializer(REPEATER, SURFACE, template);
    const rows = [row(1n), row(2n), row(3n)];
    const first = m.update(rows);

    const changed = [rows[0], { ...rows[1], title: "renamed" }, rows[2]];
    const second = m.update(changed);

    expect(second[0]).toBe(first[0]);
    expect(second[2]).toBe(first[2]);
    expect(second[1]).not.toBe(first[1]);
    expect(JSON.parse(second[1].children[0].props).text).toContain("renamed");
  });

  test("a changed child invalidates its ancestors but not its uncles", () => {
    const template = buildTemplate(recursiveTree, REPEATER);
    const m = new IncrementalMaterializer(REPEATER, SURFACE, template);
    const parent = row(1n);
    const uncle = row(9n);
    const child = row(2n, { parentId: 1n });
    const first = m.update([parent, uncle, child]);

    const second = m.update([parent, uncle, { ...child, title: "renamed" }]);

    // Uncle is untouched; the parent rebuilds because its subtree changed.
    const uncleIdx = first.findIndex((n) => n.rowId === 9n);
    expect(second[uncleIdx]).toBe(first[uncleIdx]);
    const parentIdx = first.findIndex((n) => n.rowId === 1n);
    expect(second[parentIdx]).not.toBe(first[parentIdx]);
  });

  test("reordering rows preserves node identity (keyed reorder, not remount)", () => {
    const template = buildTemplate(flatTree, REPEATER);
    const m = new IncrementalMaterializer(REPEATER, SURFACE, template);
    const a = row(1n);
    const b = row(2n);
    const first = m.update([a, b]);
    const second = m.update([b, a]);

    expect(second[0]).toBe(first[1]);
    expect(second[1]).toBe(first[0]);
  });
});

describe("rooting rules", () => {
  test("a flat template ignores parentId — every row renders", () => {
    // The M4 shape: children of a project page all carry parentId = the
    // project. Bucketing by parentage here would leave zero roots.
    const template = buildTemplate(flatTree, REPEATER);
    const rows = [row(1n, { parentId: 68n }), row(2n, { parentId: 68n })];
    expect(materializeNaive(REPEATER, SURFACE, template, rows)).toHaveLength(2);
  });

  test("a row whose parent is outside the result set is a root", () => {
    // The M3 shape: a sidebar scoped to page 68 returns 68's descendants, and
    // the top level points at 68 — which the query itself excluded.
    const template = buildTemplate(recursiveTree, REPEATER);
    const rows = [row(1n, { parentId: 68n }), row(2n, { parentId: 1n })];
    const out = materializeNaive(REPEATER, SURFACE, template, rows);
    expect(out).toHaveLength(1);
    expect(out[0].rowId).toBe(1n);
    expect(out[0].children[0].children[0].rowId).toBe(2n);
  });

  test("nesting still applies when the parent IS in the result set", () => {
    const template = buildTemplate(recursiveTree, REPEATER);
    const out = materializeNaive(REPEATER, SURFACE, template, [row(1n), row(2n, { parentId: 1n })]);
    expect(out).toHaveLength(1);
    expect(flatten(out).filter((n) => n.componentType === "PageLink")).toHaveLength(2);
  });
});

describe("robustness", () => {
  test("a cycle reachable from a root truncates instead of hanging", () => {
    // Duplicate ids are how a malformed resolver produces a cycle that the
    // root walk actually reaches: 1 → 2 → 3 → 2.
    const template = buildTemplate(recursiveTree, REPEATER);
    const rows: RepeaterRow[] = [
      { id: 1n, parentId: null, title: "a" },
      { id: 2n, parentId: 1n, title: "b" },
      { id: 3n, parentId: 2n, title: "c" },
      { id: 2n, parentId: 3n, title: "b-again" },
    ];
    const out = materializeNaive(REPEATER, SURFACE, template, rows);
    expect(flatten(out).length).toBeGreaterThan(0);
    expect(flatten(out).length).toBeLessThan(100);
  });

  test("the incremental path survives the same cycle", () => {
    const template = buildTemplate(recursiveTree, REPEATER);
    const rows: RepeaterRow[] = [
      { id: 1n, parentId: null, title: "a" },
      { id: 2n, parentId: 1n, title: "b" },
      { id: 3n, parentId: 2n, title: "c" },
      { id: 2n, parentId: 3n, title: "b-again" },
    ];
    const m = new IncrementalMaterializer(REPEATER, SURFACE, template);
    expect(() => m.update(rows)).not.toThrow();
    expect(() => m.update(rows)).not.toThrow();
  });
});
