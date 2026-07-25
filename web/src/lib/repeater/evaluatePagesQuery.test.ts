/**
 * `evaluatePagesQuery` — the host half of the repeater's data path.
 *
 * The identity test at the bottom is the load-bearing one: correctness here is
 * easy to eyeball, but a resolver that copies rows breaks the materializer's
 * memo silently, costing the 12× D3 was decided on while still rendering the
 * right pixels.
 */

import { describe, expect, test } from "vitest";
import type { Page } from "@/src/module_bindings/types";
import type { DataSourceConfig } from "@eclosion-tech/pulp";
import { evaluatePagesQuery } from "./evaluatePagesQuery";

function page(
  id: bigint,
  parentId: bigint | null,
  title: string,
  extra: Record<string, unknown> = {},
): Page {
  return {
    id,
    parentId: parentId ?? undefined,
    pageType: { tag: "Doc" },
    title,
    sortOrder: Number(id),
    embedding: undefined,
    createdBy: { tag: "Human" },
    createdAt: { microsSinceUnixEpoch: 0n },
    updatedAt: { microsSinceUnixEpoch: 0n },
    deletedAt: undefined,
    icon: undefined,
    parentPk: parentId ?? 0n,
    isHidden: false,
    contentFormat: { tag: "ComponentTree" },
    ...extra,
  } as Page;
}

const PAGES: Page[] = [
  page(1n, null, "Root A"),
  page(2n, null, "Root B"),
  page(10n, 1n, "Child of A"),
  page(11n, 1n, "Another child of A"),
  page(100n, 10n, "Grandchild"),
  page(50n, null, "Deleted", { deletedAt: { microsSinceUnixEpoch: 1n } }),
  page(60n, null, "Hidden", { isHidden: true }),
];

function ds(entity: DataSourceConfig["entity"], rest: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return { v: 1, entity, ...rest };
}

describe("scoping", () => {
  test("direct children only, by default", () => {
    const out = evaluatePagesQuery(PAGES, ds({ kind: "pages", parentId: 1n }));
    expect(out.map((r) => r.id)).toEqual([10n, 11n]);
  });

  test("includeDescendants walks the whole subtree", () => {
    const out = evaluatePagesQuery(
      PAGES,
      ds({ kind: "pages", parentId: 1n, includeDescendants: true }),
    );
    expect(out.map((r) => r.id).sort((a, b) => Number(a - b))).toEqual([10n, 11n, 100n]);
  });

  test("a null parent means root pages", () => {
    const out = evaluatePagesQuery(PAGES, ds({ kind: "pages", parentId: null }));
    expect(out.map((r) => r.id)).toEqual([1n, 2n]);
  });

  test("a null parent with includeDescendants means the whole workspace — the sidebar shape", () => {
    const out = evaluatePagesQuery(
      PAGES,
      ds({ kind: "pages", parentId: null, includeDescendants: true }),
    );
    expect(out.map((r) => r.id).sort((a, b) => Number(a - b))).toEqual([1n, 2n, 10n, 11n, 100n]);
  });
});

describe("visibility", () => {
  test("soft-deleted and hidden pages never surface", () => {
    const out = evaluatePagesQuery(
      PAGES,
      ds({ kind: "pages", parentId: null, includeDescendants: true }),
    );
    const ids = out.map((r) => r.id);
    expect(ids).not.toContain(50n); // deleted
    expect(ids).not.toContain(60n); // hidden — AI-user memory roots live here
  });
});

describe("predicates", () => {
  test("contains is case-insensitive", () => {
    const out = evaluatePagesQuery(
      PAGES,
      ds({ kind: "pages", parentId: 1n }, { filter: [{ property: "title", op: "contains", value: "ANOTHER" }] }),
    );
    expect(out.map((r) => r.id)).toEqual([11n]);
  });

  test("eq against a tagged enum compares by tag", () => {
    const pages = [...PAGES, page(70n, null, "A database", { pageType: { tag: "Database" } })];
    const out = evaluatePagesQuery(
      pages,
      ds({ kind: "pages", parentId: null }, { filter: [{ property: "pageType", op: "eq", value: "Database" }] }),
    );
    expect(out.map((r) => r.id)).toEqual([70n]);
  });

  test("isEmpty catches absent optionals", () => {
    const pages = [page(1n, null, "no icon"), page(2n, null, "has icon", { icon: "star" })];
    const out = evaluatePagesQuery(
      pages,
      ds({ kind: "pages", parentId: null }, { filter: [{ property: "icon", op: "isEmpty" }] }),
    );
    expect(out.map((r) => r.id)).toEqual([1n]);
  });

  test("predicates AND together", () => {
    const out = evaluatePagesQuery(
      PAGES,
      ds(
        { kind: "pages", parentId: 1n },
        {
          filter: [
            { property: "title", op: "contains", value: "child" },
            { property: "id", op: "gt", value: 10 },
          ],
        },
      ),
    );
    expect(out.map((r) => r.id)).toEqual([11n]);
  });
});

describe("sort and limit", () => {
  test("sorts descending and applies limit", () => {
    const out = evaluatePagesQuery(
      PAGES,
      ds(
        { kind: "pages", parentId: null, includeDescendants: true },
        { sort: [{ property: "id", dir: "desc" }], limit: 2 },
      ),
    );
    expect(out.map((r) => r.id)).toEqual([100n, 11n]);
  });

  test("falls back to sortOrder when no sort is configured", () => {
    const out = evaluatePagesQuery(PAGES, ds({ kind: "pages", parentId: 1n }));
    expect(out.map((r) => r.id)).toEqual([10n, 11n]);
  });

  test("rows missing the sort value sort last in both directions", () => {
    const pages = [page(1n, null, "a", { icon: "z" }), page(2n, null, "b")];
    const asc = evaluatePagesQuery(pages, ds({ kind: "pages", parentId: null }, { sort: [{ property: "icon", dir: "asc" }] }));
    const desc = evaluatePagesQuery(pages, ds({ kind: "pages", parentId: null }, { sort: [{ property: "icon", dir: "desc" }] }));
    expect(asc[asc.length - 1].id).toBe(2n);
    expect(desc[desc.length - 1].id).toBe(2n);
  });
});

describe("row identity (the materializer's memo depends on this)", () => {
  test("returns the very same row objects, not copies", () => {
    const config = ds({ kind: "pages", parentId: 1n });
    const first = evaluatePagesQuery(PAGES, config);
    const second = evaluatePagesQuery(PAGES, config);

    // Same objects across evaluations — this is what lets an unchanged subtree
    // be reused verbatim rather than rebuilt.
    first.forEach((row, i) => expect(second[i]).toBe(row));
    // And they are the cache's objects, not projections of them.
    expect(first[0]).toBe(PAGES.find((p) => p.id === 10n));
  });
});
