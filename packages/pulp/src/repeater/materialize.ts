/**
 * Materialization — turning `(rows × template)` into virtual nodes.
 *
 * Ported from `spikes/repeater-bench/src/materialize.ts`, which benchmarked
 * this against a naive rebuild-everything strategy. The result decided D3:
 * incremental from day one, no naive-first stepping stone. The gap is
 * structural, not incidental — naive gives every node fresh identity on every
 * delivery, which defeats `memo()` everywhere downstream:
 *
 * - steady-state single-row update, N=2000: incremental is within 1.17× of
 *   best-case bespoke React; naive is 12× worse
 * - naive blows a 16 ms frame at N≈8k; incremental costs 1.8 ms at N=10k
 *
 * So "materialization strategy" and "render cost" are one decision, not two:
 * preserved `VirtualNode` identity is the entire performance story, which is
 * why this lives next to the render memoization that consumes it (D1) rather
 * than in the host.
 *
 * Two deliberate differences from the spike:
 *
 * 1. **No re-sorting.** The spike sorted siblings by `order` because it had no
 *    query layer. Here the resolver has already applied the `dataSource` sort
 *    (D5), so re-ordering would fight it. Grouping preserves encounter order,
 *    which also drops the shared O(N log N) index cost to O(N).
 * 2. **Template forests.** A repeater's template is *all* of its stored
 *    children, not a single root, so each row instantiates a list.
 */

import type { BlockId, BlockNode } from "../types";
import type { RepeaterRow } from "./dataSource";
import { findRecursionSlot, resolveProps, type TemplateNode } from "./template";
import { virtualId } from "./virtualId";

/**
 * A materialized node. Structurally a `BlockNode`, so existing renderers work
 * unchanged, plus the row scope events close over (D6) and nested children —
 * nesting is what lets the render path memoize on the node alone instead of
 * taking a per-delivery `byParent` index as a prop.
 */
export type VirtualNode = BlockNode & {
  id: BlockId;
  children: VirtualNode[];
  /** Source row — what row-scoped events (`navigate({{row.id}})`) resolve against. */
  rowId: BlockId;
  /** Stored template position this was instantiated from. */
  templateId: BlockId;
};

/**
 * Group rows by parent, preserving resolver order within each bucket.
 *
 * Two rules keep result sets from vanishing, both load-bearing:
 *
 * - **A flat template ignores parentage entirely.** Rows almost always carry a
 *   `parentId` (every child page of a project has one), so bucketing by it
 *   would file every row under a parent that is not itself a row, leaving no
 *   roots and rendering nothing.
 * - **A row whose parent is outside the result set is a root.** This is the
 *   normal case for a scoped subtree: a sidebar rooted at page X returns X's
 *   children, whose `parentId` is X — which the query deliberately excluded.
 *
 * Without these, the two headline M2/M3 surfaces both render empty.
 */
function buildByParent(
  rows: ReadonlyArray<RepeaterRow>,
  nested: boolean,
): Map<BlockId | null, RepeaterRow[]> {
  const byParent = new Map<BlockId | null, RepeaterRow[]>();
  const present = nested ? new Set<BlockId>(rows.map((r) => r.id)) : null;

  for (const r of rows) {
    const parent = r.parentId ?? null;
    const key = present !== null && parent !== null && present.has(parent) ? parent : null;
    const arr = byParent.get(key);
    if (arr) arr.push(r);
    else byParent.set(key, [r]);
  }
  return byParent;
}

type Ctx = {
  repeaterId: BlockId;
  surfaceId: BlockId;
  template: TemplateNode[];
  /** Slot of the recursion point, or null for a flat template. */
  recursionSlot: number | null;
};

/**
 * Instantiate the template forest for one row, splicing `repeatedChildren`
 * into the recursion point.
 *
 * `order` mirrors sibling position for renderers that read it, but ordering is
 * carried by array position — virtual nodes nest, so nothing re-sorts them by
 * this field the way `byParent` buckets are sorted.
 */
function instantiate(
  ctx: Ctx,
  row: RepeaterRow,
  parentId: BlockId | null,
  repeatedChildren: VirtualNode[],
): VirtualNode[] {
  const build = (t: TemplateNode, pid: BlockId | null, idx: number): VirtualNode => {
    const id = virtualId(ctx.repeaterId, row.id, t.slot);
    const children = t.children.map((c, i) => build(c, id, i));
    if (t.repeatChildren) children.push(...repeatedChildren);
    return {
      id,
      surfaceId: ctx.surfaceId,
      parentId: pid,
      componentType: t.componentType,
      props: resolveProps(t, row),
      order: idx,
      rowId: row.id,
      templateId: t.sourceId,
      children,
    };
  };
  return ctx.template.map((t, i) => build(t, parentId, i));
}

/**
 * Virtual id of the node that nested rows hang off — the recursion point
 * instantiated for this row. Null for flat templates, where nested rows cannot
 * arise.
 */
function recursionParentId(ctx: Ctx, rowId: BlockId): BlockId | null {
  return ctx.recursionSlot === null
    ? null
    : virtualId(ctx.repeaterId, rowId, ctx.recursionSlot);
}

/**
 * Bottom-up memo keyed on row object identity: a row's subtree is reused
 * verbatim iff the row object and every child subtree are unchanged.
 *
 * Relies on the resolver's delivery contract — unchanged rows keep identity
 * (see `QueryResolver`). A resolver that copies rows on every delivery would
 * silently degrade this to naive.
 */
export class IncrementalMaterializer {
  private cache = new Map<BlockId, { row: RepeaterRow; childNodes: VirtualNode[]; nodes: VirtualNode[] }>();

  constructor(
    private repeaterId: BlockId,
    private surfaceId: BlockId,
    private template: TemplateNode[],
  ) {}

  /**
   * Recompute for a delivery. Returns the root virtual nodes, reusing every
   * subtree whose row and descendants are unchanged.
   */
  update(rows: ReadonlyArray<RepeaterRow>): VirtualNode[] {
    const ctx: Ctx = {
      repeaterId: this.repeaterId,
      surfaceId: this.surfaceId,
      template: this.template,
      recursionSlot: findRecursionSlot(this.template),
    };
    const byParent = buildByParent(rows, ctx.recursionSlot !== null);
    const nextCache = new Map<BlockId, { row: RepeaterRow; childNodes: VirtualNode[]; nodes: VirtualNode[] }>();
    // Cycles cannot occur in stored parentage, but a malformed resolver could
    // emit one; without this guard that becomes an infinite recursion.
    const active = new Set<BlockId>();

    const walk = (row: RepeaterRow, parentId: BlockId | null): VirtualNode[] => {
      if (active.has(row.id)) {
        if (typeof console !== "undefined") {
          console.warn(
            `[pulp/repeater] cycle in resolver rows at id=${row.id}; truncating.`,
          );
        }
        return [];
      }
      active.add(row.id);

      // Nested rows hang off this row's recursion-point node, not off the row.
      const childParent = recursionParentId(ctx, row.id);
      const childNodes: VirtualNode[] = [];
      for (const k of byParent.get(row.id) ?? []) {
        childNodes.push(...walk(k, childParent));
      }

      active.delete(row.id);

      const cached = this.cache.get(row.id);
      const reusable =
        cached !== undefined &&
        cached.row === row &&
        cached.childNodes.length === childNodes.length &&
        childNodes.every((n, i) => n === cached.childNodes[i]);

      if (reusable) {
        nextCache.set(row.id, cached);
        return cached.nodes;
      }

      const nodes = instantiate(ctx, row, parentId, childNodes);
      nextCache.set(row.id, { row, childNodes, nodes });
      return nodes;
    };

    const roots: VirtualNode[] = [];
    for (const r of byParent.get(null) ?? []) roots.push(...walk(r, null));
    this.cache = nextCache;
    return roots;
  }
}

/**
 * Rebuild-everything strategy. Kept as the equivalence oracle for the
 * incremental path's tests — it is not a shipping code path (D3 rejected it on
 * the benchmark evidence above).
 */
export function materializeNaive(
  repeaterId: BlockId,
  surfaceId: BlockId,
  template: TemplateNode[],
  rows: ReadonlyArray<RepeaterRow>,
): VirtualNode[] {
  const ctx: Ctx = {
    repeaterId,
    surfaceId,
    template,
    recursionSlot: findRecursionSlot(template),
  };
  const byParent = buildByParent(rows, ctx.recursionSlot !== null);
  const active = new Set<BlockId>();

  const walk = (row: RepeaterRow, parentId: BlockId | null): VirtualNode[] => {
    if (active.has(row.id)) return [];
    active.add(row.id);
    const childParent = recursionParentId(ctx, row.id);
    const childNodes: VirtualNode[] = [];
    for (const k of byParent.get(row.id) ?? []) {
      childNodes.push(...walk(k, childParent));
    }
    active.delete(row.id);
    return instantiate(ctx, row, parentId, childNodes);
  };

  const roots: VirtualNode[] = [];
  for (const r of byParent.get(null) ?? []) roots.push(...walk(r, null));
  return roots;
}
