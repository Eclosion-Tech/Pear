import { describe, expect, test } from "vitest";
import { dataSourceEquals, parseDataSource, type DataSourceConfig } from "./dataSource";

describe("host entity parsing", () => {
  test.each([42, "42", 42n, 0, "0", 0n, "9007199254740993", 9007199254740993n])(
    "coerces surfaceId %s to bigint",
    (surfaceId) => {
      expect(parseDataSource({
        v: 1,
        entity: { kind: "host", surfaceId, source: "events" },
      })).toEqual({
        ok: true,
        config: {
          v: 1,
          entity: { kind: "host", surfaceId: BigInt(surfaceId), source: "events" },
        },
      });
    },
  );

  test("accepts a source at the 64-character limit", () => {
    const config = {
      v: 1,
      entity: { kind: "host", surfaceId: 42n, source: "s".repeat(64) },
    };
    expect(parseDataSource(config)).toEqual({ ok: true, config });
  });

  test("rejects a missing source", () => {
    expect(parseDataSource({ v: 1, entity: { kind: "host", surfaceId: 42 } })).toEqual({
      ok: false,
      error: "dataSource.entity is invalid",
    });
  });

  test.each([undefined, null, "", "s".repeat(65), 42, true, {}, []])(
    "rejects invalid source %s",
    (source) => {
      expect(parseDataSource({
        v: 1,
        entity: { kind: "host", surfaceId: 42, source },
      })).toEqual({ ok: false, error: "dataSource.entity is invalid" });
    },
  );

  test("rejects a missing surfaceId", () => {
    expect(parseDataSource({ v: 1, entity: { kind: "host", source: "events" } })).toEqual({
      ok: false,
      error: "dataSource.entity is invalid",
    });
  });

  test.each([
    undefined, null, -1, -1n, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity,
    "", "-1", "1.5", "1e3", " 42", "invalid", true, {}, [],
  ])("rejects invalid surfaceId %s", (surfaceId) => {
    expect(parseDataSource({
      v: 1,
      entity: { kind: "host", surfaceId, source: "events" },
    })).toEqual({ ok: false, error: "dataSource.entity is invalid" });
  });
});

describe("host config equality", () => {
  const config: DataSourceConfig = {
    v: 1,
    entity: { kind: "host", surfaceId: 42n, source: "events" },
  };

  test("compares identical host configs structurally", () => {
    expect(dataSourceEquals(config, {
      v: 1,
      entity: { kind: "host", surfaceId: 42n, source: "events" },
    })).toBe(true);
  });

  test.each([
    { kind: "host", surfaceId: 43n, source: "events" },
    { kind: "host", surfaceId: 42n, source: "tasks" },
    { kind: "pages", parentId: 42n },
    { kind: "database", schemaId: 42n },
  ] satisfies DataSourceConfig["entity"][])("distinguishes entity %s", (entity) => {
    const other: DataSourceConfig = { v: 1, entity };
    expect(dataSourceEquals(config, other)).toBe(false);
    expect(dataSourceEquals(other, config)).toBe(false);
  });
});

describe("existing v1 entities", () => {
  test.each([
    [{ kind: "pages" }, { kind: "pages", parentId: null, includeDescendants: false }],
    [
      { kind: "pages", parentId: 42, includeDescendants: true },
      { kind: "pages", parentId: 42n, includeDescendants: true },
    ],
    [
      { kind: "database", schemaId: "42" },
      { kind: "database", schemaId: 42n, includeDescendants: false },
    ],
    [
      { kind: "database", schemaId: 42, includeDescendants: true },
      { kind: "database", schemaId: 42n, includeDescendants: true },
    ],
  ])("preserves parsing for %s", (entity, expectedEntity) => {
    const config = {
      v: 1,
      entity,
      filter: [{ property: "title", op: "contains", value: "meeting" }],
      sort: [{ property: "title", dir: "asc" }],
      limit: 20,
    };
    expect(parseDataSource(config)).toEqual({
      ok: true,
      config: { ...config, entity: expectedEntity },
    });
  });
});
