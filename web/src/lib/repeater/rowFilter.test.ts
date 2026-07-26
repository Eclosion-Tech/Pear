/**
 * `dataSource` filter and sort semantics.
 *
 * These operators are versioned and forever (D5), and they are shared by every
 * entity kind — so what `eq` means on a MultiSelect, or where blanks sort, is a
 * decision that outlives any one surface. Pinned here rather than left to be
 * inferred from whichever resolver happened to exercise them.
 */

import { describe, expect, test } from "vitest";
import type { Predicate, RepeaterRow } from "@eclosion-tech/pulp";
import { applyFilter, asComparable, comparatorFor, matchesPredicate } from "./rowFilter";

function row(fields: Record<string, unknown>): RepeaterRow {
  return { id: 1n, ...fields } as unknown as RepeaterRow;
}

const matches = (fields: Record<string, unknown>, p: Predicate) =>
  matchesPredicate(row(fields), p);

// ── eq / neq ──────────────────────────────────────────────────────────────────

describe("eq", () => {
  test("matches strings, numbers and booleans", () => {
    expect(matches({ s: "Done" }, { property: "s", op: "eq", value: "Done" })).toBe(true);
    expect(matches({ s: "Done" }, { property: "s", op: "eq", value: "done" })).toBe(false);
    expect(matches({ n: 5 }, { property: "n", op: "eq", value: 5 })).toBe(true);
    expect(matches({ b: true }, { property: "b", op: "eq", value: true })).toBe(true);
    expect(matches({ b: false }, { property: "b", op: "eq", value: true })).toBe(false);
  });

  test("coerces a string operand against a bigint field", () => {
    // Configs written by hand or by an agent routinely carry ids as strings.
    expect(matches({ pid: 68n }, { property: "pid", op: "eq", value: "68" })).toBe(true);
    expect(matches({ pid: 68n }, { property: "pid", op: "eq", value: 68 })).toBe(true);
    expect(matches({ pid: 68n }, { property: "pid", op: "eq", value: "69" })).toBe(false);
  });

  test("unwraps a tagged enum to its tag", () => {
    expect(
      matches({ kind: { tag: "Database" } }, { property: "kind", op: "eq", value: "Database" }),
    ).toBe(true);
  });

  test("does not match a multi-valued cell — membership belongs to contains", () => {
    expect(matches({ t: ["a", "b"] }, { property: "t", op: "eq", value: "a" })).toBe(false);
    expect(matches({ t: ["a"] }, { property: "t", op: "eq", value: "a" })).toBe(false);
  });

  test("a missing field does not equal a value", () => {
    expect(matches({}, { property: "nope", op: "eq", value: "x" })).toBe(false);
    expect(matches({ s: null }, { property: "s", op: "eq", value: "x" })).toBe(false);
  });

  test("eq against null matches an absent value", () => {
    expect(matches({ s: null }, { property: "s", op: "eq", value: null })).toBe(true);
    expect(matches({}, { property: "s", op: "eq", value: null })).toBe(true);
  });
});

describe("neq", () => {
  test("is the negation of eq for scalars", () => {
    expect(matches({ s: "Done" }, { property: "s", op: "neq", value: "Todo" })).toBe(true);
    expect(matches({ s: "Done" }, { property: "s", op: "neq", value: "Done" })).toBe(false);
  });

  test("a missing value is 'not equal' to a concrete one", () => {
    // Deliberate: "Status is not Done" should surface rows with no Status set,
    // which is what someone auditing unfinished work expects.
    expect(matches({}, { property: "s", op: "neq", value: "Done" })).toBe(true);
  });
});

// ── lt / gt ───────────────────────────────────────────────────────────────────

describe("lt / gt", () => {
  test("compare numbers and bigints", () => {
    expect(matches({ n: 3 }, { property: "n", op: "lt", value: 5 })).toBe(true);
    expect(matches({ n: 7 }, { property: "n", op: "gt", value: 5 })).toBe(true);
    expect(matches({ n: 5 }, { property: "n", op: "lt", value: 5 })).toBe(false);
    expect(matches({ big: 100n }, { property: "big", op: "gt", value: 50 })).toBe(true);
  });

  test("compare strings lexicographically", () => {
    expect(matches({ s: "apple" }, { property: "s", op: "lt", value: "banana" })).toBe(true);
  });

  test("compare timestamps by their micros", () => {
    const ts = { microsSinceUnixEpoch: 1_000n };
    expect(matches({ at: ts }, { property: "at", op: "gt", value: 500 })).toBe(true);
    expect(matches({ at: ts }, { property: "at", op: "lt", value: 500 })).toBe(false);
  });

  test("never match when either side is absent", () => {
    // An ordering question about a missing value has no true answer, so both
    // directions are false rather than one of them silently winning.
    expect(matches({}, { property: "n", op: "lt", value: 5 })).toBe(false);
    expect(matches({}, { property: "n", op: "gt", value: 5 })).toBe(false);
    expect(matches({ n: 5 }, { property: "n", op: "gt", value: null })).toBe(false);
  });

  test("never match a multi-valued cell", () => {
    expect(matches({ t: ["b"] }, { property: "t", op: "gt", value: "a" })).toBe(false);
  });
});

// ── contains ──────────────────────────────────────────────────────────────────

describe("contains", () => {
  test("is a substring test on text, case-insensitively", () => {
    expect(matches({ s: "In Progress" }, { property: "s", op: "contains", value: "prog" })).toBe(true);
    expect(matches({ s: "In Progress" }, { property: "s", op: "contains", value: "PROG" })).toBe(true);
    expect(matches({ s: "In Progress" }, { property: "s", op: "contains", value: "done" })).toBe(false);
  });

  test("is membership on a multi-valued cell, not substring", () => {
    expect(matches({ t: ["urgent", "backend"] }, { property: "t", op: "contains", value: "urgent" })).toBe(true);
    expect(matches({ t: ["urgent"] }, { property: "t", op: "contains", value: "URGENT" })).toBe(true);
    // A partial match against a member is NOT membership.
    expect(matches({ t: ["urgent"] }, { property: "t", op: "contains", value: "urg" })).toBe(false);
  });

  test("matches members of a relation by id", () => {
    expect(matches({ rel: [68n, 70n] }, { property: "rel", op: "contains", value: "68" })).toBe(true);
    expect(matches({ rel: [68n] }, { property: "rel", op: "contains", value: "99" })).toBe(false);
  });

  test("an absent or empty value contains nothing", () => {
    expect(matches({}, { property: "s", op: "contains", value: "x" })).toBe(false);
    expect(matches({ t: [] }, { property: "t", op: "contains", value: "x" })).toBe(false);
  });

  test("works against non-string scalars by stringifying", () => {
    expect(matches({ n: 1234 }, { property: "n", op: "contains", value: "23" })).toBe(true);
  });
});

// ── isEmpty ───────────────────────────────────────────────────────────────────

describe("isEmpty", () => {
  test("is true for missing, null and empty string", () => {
    expect(matches({}, { property: "s", op: "isEmpty" })).toBe(true);
    expect(matches({ s: null }, { property: "s", op: "isEmpty" })).toBe(true);
    expect(matches({ s: "" }, { property: "s", op: "isEmpty" })).toBe(true);
  });

  test("is true for an empty array and false for a populated one", () => {
    expect(matches({ t: [] }, { property: "t", op: "isEmpty" })).toBe(true);
    expect(matches({ t: ["a"] }, { property: "t", op: "isEmpty" })).toBe(false);
  });

  test("zero and false are values, not emptiness", () => {
    // A Number of 0 and an unchecked Checkbox are set, not blank — treating
    // them as empty would hide real rows from an "is empty" audit.
    expect(matches({ n: 0 }, { property: "n", op: "isEmpty" })).toBe(false);
    expect(matches({ b: false }, { property: "b", op: "isEmpty" })).toBe(false);
  });

  test("ignores any value operand it is given", () => {
    expect(matches({ s: "" }, { property: "s", op: "isEmpty", value: "anything" })).toBe(true);
  });
});

// ── composition ───────────────────────────────────────────────────────────────

describe("applyFilter", () => {
  const rows = [
    row({ id: 1n, Status: "In Progress", Priority: "High" }),
    row({ id: 2n, Status: "Done", Priority: "High" }),
    row({ id: 3n, Status: "In Progress", Priority: null }),
  ];

  test("predicates AND together (D5 — there is no OR)", () => {
    const out = applyFilter(rows, [
      { property: "Status", op: "eq", value: "In Progress" },
      { property: "Priority", op: "eq", value: "High" },
    ]);
    expect(out.map((r) => r.id)).toEqual([1n]);
  });

  test("an empty or absent filter is a pass-through, preserving identity", () => {
    expect(applyFilter(rows, [])).toBe(rows);
    expect(applyFilter(rows, undefined)).toBe(rows);
  });
});

// ── sorting ───────────────────────────────────────────────────────────────────

describe("comparatorFor", () => {
  test("sorts ascending and descending", () => {
    const rows = [row({ id: 1n, n: 3 }), row({ id: 2n, n: 1 }), row({ id: 3n, n: 2 })];
    expect(rows.slice().sort(comparatorFor([{ property: "n", dir: "asc" }])).map((r) => r.id))
      .toEqual([2n, 3n, 1n]);
    expect(rows.slice().sort(comparatorFor([{ property: "n", dir: "desc" }])).map((r) => r.id))
      .toEqual([1n, 3n, 2n]);
  });

  test("blanks sort last in BOTH directions", () => {
    // Matching the grid, so the two views agree about where blanks go — and so
    // reversing a sort never floats a pile of empties to the top.
    const rows = [row({ id: 1n, n: 2 }), row({ id: 2n }), row({ id: 3n, n: 1 })];
    for (const dir of ["asc", "desc"] as const) {
      const sorted = rows.slice().sort(comparatorFor([{ property: "n", dir }]));
      expect(sorted.at(-1)!.id).toBe(2n);
    }
  });

  test("falls through to the next key on a tie", () => {
    const rows = [
      row({ id: 1n, a: 1, b: "z" }),
      row({ id: 2n, a: 1, b: "a" }),
      row({ id: 3n, a: 0, b: "m" }),
    ];
    const sorted = rows.slice().sort(
      comparatorFor([
        { property: "a", dir: "asc" },
        { property: "b", dir: "asc" },
      ]),
    );
    expect(sorted.map((r) => r.id)).toEqual([3n, 2n, 1n]);
  });

  test("treats fully-tied rows as equal", () => {
    const rows = [row({ id: 1n, a: 1 }), row({ id: 2n, a: 1 })];
    expect(rows.slice().sort(comparatorFor([{ property: "a", dir: "asc" }])).map((r) => r.id))
      .toEqual([1n, 2n]);
  });
});

// ── the coercion helper ───────────────────────────────────────────────────────

describe("asComparable", () => {
  test("normalises the value shapes a row can hold", () => {
    expect(asComparable("x")).toBe("x");
    expect(asComparable(4)).toBe(4);
    expect(asComparable(4n)).toBe(4);
    expect(asComparable(true)).toBe(1);
    expect(asComparable(false)).toBe(0);
    expect(asComparable({ microsSinceUnixEpoch: 9n })).toBe(9);
  });

  test("treats absent and multi-valued as incomparable", () => {
    expect(asComparable(null)).toBeNull();
    expect(asComparable(undefined)).toBeNull();
    expect(asComparable([])).toBeNull();
    expect(asComparable(["a", "b"])).toBeNull();
  });
});
