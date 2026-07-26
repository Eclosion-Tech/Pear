/**
 * `database` entity rows (M4).
 *
 * Two properties matter and they fail differently:
 *
 * 1. **Flattening** — a row must expose its cells by column name, or a template
 *    cannot write `{{row.Status}}` and a filter cannot name a column.
 * 2. **Identity preservation** — an unchanged row must come back as the *same
 *    object*. This one is invisible to output assertions: composing a fresh row
 *    every delivery renders correctly and silently degrades the runtime to naive
 *    rebuild, which is the 12x D3 exists to avoid. Hence `toBe`.
 */

import { describe, expect, test } from "vitest";
import { DatabaseRowCache, schemaChainIds } from "./databaseRows";
import { applyFilter, comparatorFor } from "./rowFilter";
import type { RepeaterRow } from "@eclosion-tech/pulp";

type Page = Parameters<DatabaseRowCache["build"]>[0][number];
type Def = Parameters<DatabaseRowCache["build"]>[1][number];
type Val = NonNullable<ReturnType<Parameters<DatabaseRowCache["build"]>[2]["get"]>>[number];

function page(id: bigint, title: string, parentId = 10n): Page {
  return { id, parentId, title, isHidden: false, deletedAt: null } as Page;
}
function def(id: bigint, name: string, order = 0, schemaId = 1n): Def {
  return { id, schemaId, name, order } as Def;
}
function val(pageId: bigint, propId: bigint, tag: string, value: unknown): Val {
  return { pageId, propertyDefinitionId: propId, value: { tag, value } } as Val;
}

const DEFS = [def(100n, "Status", 0), def(101n, "Priority", 1)];

function valuesFor(...vals: Val[]) {
  const m = new Map<bigint, Val[]>();
  for (const v of vals) {
    const list = m.get(v.pageId) ?? [];
    list.push(v);
    m.set(v.pageId, list);
  }
  return m;
}

describe("flattening", () => {
  test("exposes cells by column name alongside page fields", () => {
    const rows = new DatabaseRowCache().build(
      [page(1n, "Fix the thing")],
      DEFS,
      valuesFor(val(1n, 100n, "Select", "In Progress"), val(1n, 101n, "Select", "High")),
    );
    expect(rows[0]).toMatchObject({
      id: 1n,
      title: "Fix the thing",
      Status: "In Progress",
      Priority: "High",
    });
  });

  test("columns with no stored value appear as null", () => {
    // Otherwise `isEmpty` could not tell "blank cell" from "no such column".
    const rows = new DatabaseRowCache().build([page(1n, "x")], DEFS, valuesFor());
    expect(rows[0]).toMatchObject({ Status: null, Priority: null });
  });

  test("array-valued cells stay arrays", () => {
    const rows = new DatabaseRowCache().build(
      [page(1n, "x")],
      [def(100n, "Tags")],
      valuesFor(val(1n, 100n, "MultiSelect", ["a", "b"])),
    );
    expect((rows[0] as Record<string, unknown>).Tags).toEqual(["a", "b"]);
  });

  test("a value whose definition is out of scope is skipped, not exposed by id", () => {
    const rows = new DatabaseRowCache().build(
      [page(1n, "x")],
      [def(100n, "Status")],
      valuesFor(val(1n, 100n, "Select", "Done"), val(1n, 999n, "Select", "ghost")),
    );
    const keys = Object.keys(rows[0] as Record<string, unknown>);
    expect(keys).toContain("Status");
    expect(keys).not.toContain("999");
  });
});

describe("identity preservation (the memo the materializer depends on)", () => {
  test("an unchanged delivery returns the very same row objects", () => {
    const cache = new DatabaseRowCache();
    const pages = [page(1n, "a"), page(2n, "b")];
    const vals = valuesFor(val(1n, 100n, "Select", "Todo"));

    const first = cache.build(pages, DEFS, vals);
    const second = cache.build(pages, DEFS, vals);

    first.forEach((row, i) => expect(second[i]).toBe(row));
  });

  test("changing one row's cell rebuilds only that row", () => {
    const cache = new DatabaseRowCache();
    const p1 = page(1n, "a");
    const p2 = page(2n, "b");
    const v1 = val(1n, 100n, "Select", "Todo");
    const v2 = val(2n, 100n, "Select", "Todo");

    const first = cache.build([p1, p2], DEFS, valuesFor(v1, v2));
    const v2b = val(2n, 100n, "Select", "Done");
    const second = cache.build([p1, p2], DEFS, valuesFor(v1, v2b));

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect((second[1] as Record<string, unknown>).Status).toBe("Done");
  });

  test("renaming a page rebuilds that row", () => {
    const cache = new DatabaseRowCache();
    const p1 = page(1n, "a");
    const first = cache.build([p1], DEFS, valuesFor());
    const second = cache.build([page(1n, "renamed")], DEFS, valuesFor());
    expect(second[0]).not.toBe(first[0]);
    expect((second[0] as Record<string, unknown>).title).toBe("renamed");
  });
});

describe("schema chain (D5 includeDescendants)", () => {
  const schemas = [
    { id: 1n, pageId: 10n, parentSchemaId: undefined },
    { id: 2n, pageId: 20n, parentSchemaId: 1n },
    { id: 3n, pageId: 30n, parentSchemaId: 2n },
    { id: 9n, pageId: 90n, parentSchemaId: undefined },
  ];

  test("without includeDescendants only the schema itself is in scope", () => {
    expect([...schemaChainIds(schemas, 1n, false)]).toEqual([1n]);
  });

  test("with includeDescendants the whole subtree is in scope", () => {
    expect([...schemaChainIds(schemas, 1n, true)].sort()).toEqual([1n, 2n, 3n]);
  });

  test("an unrelated schema is never included", () => {
    expect(schemaChainIds(schemas, 1n, true).has(9n)).toBe(false);
  });
});

describe("filtering and sorting database rows", () => {
  const rows = new DatabaseRowCache().build(
    [page(1n, "a"), page(2n, "b"), page(3n, "c")],
    DEFS,
    valuesFor(
      val(1n, 100n, "Select", "In Progress"),
      val(2n, 100n, "Select", "Done"),
      val(3n, 100n, "Select", "In Progress"),
    ),
  );

  test("filters by column name — the headline use case", () => {
    const out = applyFilter(rows, [
      { property: "Status", op: "eq", value: "In Progress" },
    ]);
    expect(out.map((r) => r.id)).toEqual([1n, 3n]);
  });

  test("isEmpty finds rows with no value for a column", () => {
    const out = applyFilter(rows, [{ property: "Priority", op: "isEmpty" }]);
    expect(out).toHaveLength(3);
  });

  test("contains is how you match a multi-valued cell", () => {
    const multi = new DatabaseRowCache().build(
      [page(1n, "x"), page(2n, "y")],
      [def(100n, "Tags")],
      valuesFor(
        val(1n, 100n, "MultiSelect", ["urgent", "backend"]),
        val(2n, 100n, "MultiSelect", ["docs"]),
      ),
    );
    const out = applyFilter(multi, [{ property: "Tags", op: "contains", value: "urgent" }]);
    expect(out.map((r) => r.id)).toEqual([1n]);
  });

  test("eq does NOT quietly mean membership on a multi-valued cell", () => {
    // It previously compared against the array's first element, so `Tags = "urgent"`
    // matched row 1 and not row 2 purely by ordering. Membership belongs to
    // `contains`; eq on an array matches nothing rather than guessing.
    const multi = new DatabaseRowCache().build(
      [page(1n, "x"), page(2n, "y")],
      [def(100n, "Tags")],
      valuesFor(
        val(1n, 100n, "MultiSelect", ["urgent", "backend"]),
        val(2n, 100n, "MultiSelect", ["backend", "urgent"]),
      ),
    );
    expect(applyFilter(multi, [{ property: "Tags", op: "eq", value: "urgent" }])).toHaveLength(0);
  });

  test("sorts by column, blanks last in both directions", () => {
    const mixed: RepeaterRow[] = new DatabaseRowCache().build(
      [page(1n, "a"), page(2n, "b")],
      [def(100n, "Rank")],
      valuesFor(val(1n, 100n, "Number", 2)),
    );
    const asc = mixed.slice().sort(comparatorFor([{ property: "Rank", dir: "asc" }]));
    const desc = mixed.slice().sort(comparatorFor([{ property: "Rank", dir: "desc" }]));
    expect(asc.at(-1)!.id).toBe(2n);
    expect(desc.at(-1)!.id).toBe(2n);
  });
});
