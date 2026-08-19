import { describe, expect, test } from "vitest";
import { classifyRowMembership, unscopedFallbackSql } from "./scopedTable";

type Row = { surfaceId: bigint; deletedAt: bigint | null };

const onSurface =
  (surfaceId: bigint) =>
  (row: Row): boolean =>
    row.surfaceId === surfaceId;

const row = (surfaceId: bigint, deletedAt: bigint | null = null): Row => ({
  surfaceId,
  deletedAt,
});

describe("classifyRowMembership", () => {
  const filter = onSurface(1n);

  test("update within scope is stayIn", () => {
    expect(classifyRowMembership(filter, row(1n), row(1n, 5n))).toBe("stayIn");
  });

  test("update moving a row out of scope is leave (surfaced as delete)", () => {
    expect(classifyRowMembership(filter, row(1n), row(2n))).toBe("leave");
  });

  test("update moving a row into scope is enter (surfaced as insert)", () => {
    expect(classifyRowMembership(filter, row(2n), row(1n))).toBe("enter");
  });

  test("update entirely outside scope is stayOut (ignored)", () => {
    expect(classifyRowMembership(filter, row(2n), row(3n))).toBe("stayOut");
  });

  test("a soft delete (deletedAt set, same surface) stays in scope — surfaces as an update, not a delete", () => {
    // Scope filters must NOT exclude soft-deleted rows: consumers detect the
    // deletedAt null→set transition via onUpdate (see useComponentTree).
    expect(classifyRowMembership(filter, row(1n), row(1n, 99n))).toBe("stayIn");
  });
});

describe("unscopedFallbackSql", () => {
  test("selects the whole table by its server-side source name", () => {
    expect(unscopedFallbackSql("component_node")).toBe(
      "SELECT * FROM component_node",
    );
  });
});
