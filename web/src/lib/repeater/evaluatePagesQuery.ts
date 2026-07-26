/**
 * Pure evaluation of a `pages` data source against a page cache.
 *
 * Deliberately separate from the React/SpacetimeDB glue in `pagesResolver.ts`:
 * this half is the query semantics (D5's typed predicates, sorting, scoping)
 * and has no runtime dependency on the module bindings, so it is directly
 * testable and reusable by anything that holds page rows.
 *
 * ## Identity is the contract
 *
 * Rows come back as the **same objects** that were passed in — never copies,
 * never projections. The materializer's subtree memo is keyed on row object
 * identity, so a `.map()` that rebuilt rows would silently degrade the whole
 * runtime to naive rebuild (the 12× D3 rejected) while still rendering
 * correctly. Any future enrichment here must preserve identity for unchanged
 * rows.
 *
 * ## Strategy
 *
 * Full re-evaluation per delivery, per D4 — 0.19 ms at a 10k-row cache. The
 * `IncrementalQuery` upgrade (delta maintenance, plus result-array identity so
 * unaffected repeaters skip materialization entirely) slots in behind the
 * `QueryResolver` interface without touching any stored config.
 */

import type { Page } from "@/src/module_bindings/types";
import type { DataSourceConfig, RepeaterRow } from "@eclosion-tech/pulp";
import { applyFilter, comparatorFor } from "./rowFilter";

/** Hidden subtrees (AI-user memory roots and the like) never surface in views. */
function isVisible(page: Page): boolean {
  return page.deletedAt == null && !page.isHidden;
}

/** Ids of every descendant of `rootId`, and nothing else. */
function descendantIds(pages: readonly Page[], rootId: bigint): Set<bigint> {
  const byParent = new Map<bigint | null, Page[]>();
  for (const p of pages) {
    const key = p.parentId ?? null;
    const arr = byParent.get(key);
    if (arr) arr.push(p);
    else byParent.set(key, [p]);
  }
  const out = new Set<bigint>();
  const queue: bigint[] = [rootId];
  while (queue.length > 0) {
    const parent = queue.shift() as bigint;
    for (const child of byParent.get(parent) ?? []) {
      if (out.has(child.id)) continue; // defensive: malformed parentage
      out.add(child.id);
      queue.push(child.id);
    }
  }
  return out;
}

export function evaluatePagesQuery(
  pages: readonly Page[],
  config: DataSourceConfig,
): RepeaterRow[] {
  if (config.entity.kind !== "pages") return [];
  const { parentId = null, includeDescendants } = config.entity;

  let scoped: Page[];
  if (includeDescendants) {
    // A null root means the whole workspace, so the reachability walk is
    // unnecessary — and skipping it also keeps pages whose parent is outside
    // the cache, which the materializer treats as roots.
    scoped =
      parentId === null
        ? pages.filter(isVisible)
        : ((ids) => pages.filter((p) => ids.has(p.id) && isVisible(p)))(
            descendantIds(pages, parentId),
          );
  } else {
    scoped = pages.filter((p) => (p.parentId ?? null) === parentId && isVisible(p));
  }

  // Filtering and sorting are shared with the database resolver so a predicate
  // behaves identically whichever entity produced the row.
  let rows = applyFilter(scoped as unknown as RepeaterRow[], config.filter);
  rows =
    config.sort && config.sort.length > 0
      ? rows.slice().sort(comparatorFor(config.sort))
      : rows
          .slice()
          .sort(
            (a, b) =>
              Number((a as unknown as Page).sortOrder) -
              Number((b as unknown as Page).sortOrder),
          );

  if (config.limit !== undefined) rows = rows.slice(0, config.limit);

  // Cast, not map — see the identity note above.
  return rows;
}
