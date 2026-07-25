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
import type { DataSourceConfig, Predicate, RepeaterRow, SortRule } from "@eclosion-tech/pulp";

/** Hidden subtrees (AI-user memory roots and the like) never surface in views. */
function isVisible(page: Page): boolean {
  return page.deletedAt == null && !page.isHidden;
}

/**
 * Read a property for filtering/sorting. Tagged enums (`pageType`) compare by
 * their tag, so `{ property: "pageType", op: "eq", value: "Database" }` works.
 */
function propertyOf(page: Page, property: string): unknown {
  const v = (page as unknown as Record<string, unknown>)[property];
  if (v !== null && typeof v === "object" && "tag" in (v as Record<string, unknown>)) {
    return (v as { tag: unknown }).tag;
  }
  return v;
}

function asComparable(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object" && "microsSinceUnixEpoch" in (v as Record<string, unknown>)) {
    return Number((v as { microsSinceUnixEpoch: bigint }).microsSinceUnixEpoch);
  }
  return String(v);
}

function isEmptyValue(v: unknown): boolean {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

function matches(page: Page, p: Predicate): boolean {
  const actual = propertyOf(page, p.property);

  if (p.op === "isEmpty") return isEmptyValue(actual);
  if (p.op === "contains") {
    if (actual == null) return false;
    return String(actual).toLowerCase().includes(String(p.value ?? "").toLowerCase());
  }

  const a = asComparable(actual);
  // Ids are bigint-backed; a config written by hand or by an agent will often
  // carry them as strings, so coerce rather than silently never matching.
  const b =
    typeof p.value === "string" && typeof actual === "bigint"
      ? Number(p.value)
      : asComparable(p.value ?? null);

  switch (p.op) {
    case "eq":
      return a === b;
    case "neq":
      return a !== b;
    case "lt":
      return a !== null && b !== null && a < b;
    case "gt":
      return a !== null && b !== null && a > b;
  }
}

function compareBy(sort: SortRule[]) {
  return (x: Page, y: Page): number => {
    for (const rule of sort) {
      const a = asComparable(propertyOf(x, rule.property));
      const b = asComparable(propertyOf(y, rule.property));
      if (a === b) continue;
      // Rows missing a value sort last regardless of direction, matching the
      // grid's existing behaviour so the two views agree.
      if (a === null) return 1;
      if (b === null) return -1;
      const cmp = a < b ? -1 : 1;
      return rule.dir === "desc" ? -cmp : cmp;
    }
    return 0;
  };
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

  for (const p of config.filter ?? []) {
    scoped = scoped.filter((page) => matches(page, p));
  }

  scoped =
    config.sort && config.sort.length > 0
      ? scoped.slice().sort(compareBy(config.sort))
      : scoped.slice().sort((a, b) => a.sortOrder - b.sortOrder);

  if (config.limit !== undefined) scoped = scoped.slice(0, config.limit);

  // Cast, not map — see the identity note above.
  return scoped as unknown as RepeaterRow[];
}
