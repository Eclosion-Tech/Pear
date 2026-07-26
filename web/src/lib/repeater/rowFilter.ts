/**
 * Predicate and sort evaluation over repeater rows, shared by every entity kind.
 *
 * Extracted from the pages resolver when the database resolver arrived: the two
 * differ in how they *produce* rows, not in how a `dataSource`'s filter and sort
 * apply to them. Keeping one implementation means `{ property: "Status", op:
 * "eq", value: "In Progress" }` behaves identically whether "Status" is a page
 * column or a database property.
 *
 * Rows are plain records here — the resolvers flatten their own shapes before
 * calling in, so nothing in this file knows about `Page` or `PropertyValue`.
 */

import type { Predicate, RepeaterRow, SortRule } from "@eclosion-tech/pulp";

/**
 * Read a field for comparison.
 *
 * Tagged enums (`pageType`, and any live `PropertyValue` that reached here
 * unflattened) compare by their tag, so `{ property: "pageType", op: "eq",
 * value: "Database" }` works.
 */
export function propertyOf(row: RepeaterRow, property: string): unknown {
  const v = (row as unknown as Record<string, unknown>)[property];
  if (v !== null && typeof v === "object" && "tag" in (v as Record<string, unknown>)) {
    return (v as { tag: unknown }).tag;
  }
  return v;
}

export function asComparable(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  // Multi-valued cells (MultiSelect, Relation, Person) have no scalar
  // comparison. Returning the first element would silently compare against an
  // arbitrary member, so they compare as absent and `contains` handles them.
  if (Array.isArray(v)) return null;
  if (typeof v === "object" && "microsSinceUnixEpoch" in (v as Record<string, unknown>)) {
    return Number((v as { microsSinceUnixEpoch: bigint }).microsSinceUnixEpoch);
  }
  return String(v);
}

function isEmptyValue(v: unknown): boolean {
  return v == null || v === "" || (Array.isArray(v) && v.length === 0);
}

export function matchesPredicate(row: RepeaterRow, p: Predicate): boolean {
  const actual = propertyOf(row, p.property);

  if (p.op === "isEmpty") return isEmptyValue(actual);

  // `contains` is the operator for multi-valued cells: membership on an array,
  // substring on text. `eq` deliberately does NOT also mean membership —
  // overloading it would make membership expressible two ways while leaving
  // real set equality expressible in none, and `PredicateValue` is scalar so a
  // set cannot be written anyway. An `eq` against a multi-valued cell therefore
  // does not match; use `contains`.
  if (p.op === "contains") {
    if (actual == null) return false;
    if (Array.isArray(actual)) {
      const needle = String(p.value ?? "").toLowerCase();
      return actual.some((item) => String(item).toLowerCase() === needle);
    }
    return String(actual).toLowerCase().includes(String(p.value ?? "").toLowerCase());
  }

  const a = asComparable(actual);
  // Ids and dates are bigint-backed; a config written by hand or by an agent
  // will often carry them as strings, so coerce rather than never matching.
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

/** Apply every predicate (implicit AND, per D5). */
export function applyFilter(rows: RepeaterRow[], filter: Predicate[] | undefined): RepeaterRow[] {
  if (!filter || filter.length === 0) return rows;
  let out = rows;
  for (const p of filter) out = out.filter((r) => matchesPredicate(r, p));
  return out;
}

export function comparatorFor(sort: SortRule[]) {
  return (x: RepeaterRow, y: RepeaterRow): number => {
    for (const rule of sort) {
      const a = asComparable(propertyOf(x, rule.property));
      const b = asComparable(propertyOf(y, rule.property));
      if (a === b) continue;
      // Rows missing a value sort last in both directions, matching the grid so
      // the two views agree about where blanks go.
      if (a === null) return 1;
      if (b === null) return -1;
      const cmp = a < b ? -1 : 1;
      return rule.dir === "desc" ? -cmp : cmp;
    }
    return 0;
  };
}
