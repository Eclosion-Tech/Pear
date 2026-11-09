import { expect, it } from "vitest";
import {
  NATIVE_RECORD_PROPERTIES,
  workspaceComponentSnapshot,
  workspaceComponentQuery,
  workspaceComponentRead,
  scalarProperty,
  writableProperty,
  type WorkspaceComponentData,
} from "./component-workspace-data";
import type { ComponentSource } from "@eclosion-tech/trellis";
const principal = "a".repeat(64),
  identity = { toHexString: () => principal };
const source: ComponentSource = {
  label: "Records",
  fields: {
    name: { type: "string", writable: true },
    status: { type: "string", writable: true },
  },
  connection: {
    adapter: "pear.database",
    schemaId: "5",
    mapping: { name: "7", status: "8" },
  },
};
const fixture = () =>
  ({
    ready: true,
    principal,
    privileged: false,
    pages: [
      { id: 10n },
      { id: 11n, parentId: 10n },
      { id: 12n, parentId: 20n },
    ],
    rules: [],
    schemas: [{ id: 5n, pageId: 10n }],
    properties: [
      { id: 7n, schemaId: 5n, propertyType: { tag: "Text" } },
      { id: 8n, schemaId: 5n, propertyType: { tag: "Select" } },
    ],
    values: [
      {
        pageId: 11n,
        propertyDefinitionId: 7n,
        value: { tag: "Text", value: "Saved value" },
      },
      {
        pageId: 11n,
        propertyDefinitionId: 8n,
        value: { tag: "Select", value: "Ready" },
      },
    ],
  }) as unknown as WorkspaceComponentData;
it("live workspace data projects only the connected database and exposes supported writes", () => {
  const value = workspaceComponentSnapshot(source, fixture());
  expect(value.records).toHaveLength(1);
  expect(value.records[0]).toEqual({
    id: "11",
    values: { name: "Saved value", status: "Ready" },
    writableFields: ["name"],
  });
  expect(value.writableFields).toEqual(["name"]);
});
it("current record ACLs revoke writes while retaining readable source data", () => {
  const data = fixture();
  data.rules = [
    {
      pageId: 10n,
      principal: { tag: "WorkspaceMember", value: identity },
      permission: { tag: "Read" },
    },
  ] as any;
  const value = workspaceComponentSnapshot(source, data);
  expect(value.records[0].values.name).toBe("Saved value");
  expect(value.records[0].writableFields).toEqual([]);
});
it("unreadable connections reveal no cached records and unready connections permit no writes", () => {
  const data = fixture();
  data.rules = [
    {
      pageId: 10n,
      principal: {
        tag: "WorkspaceMember",
        value: { toHexString: () => "other" },
      },
      permission: { tag: "Read" },
    },
  ] as any;
  expect(workspaceComponentSnapshot(source, data).records).toEqual([]);
  expect(
    workspaceComponentSnapshot(source, { ...data, ready: false }).status,
  ).toBe("loading");
  expect(
    workspaceComponentSnapshot(source, { ...fixture(), principal: "anonymous" })
      .records,
  ).toEqual([]);
});

it("creating in an empty database requires current database authority and supported property mappings", () => {
  const data = fixture();
  data.pages = data.pages.filter((page) => page.id !== 11n);
  let value = workspaceComponentSnapshot(source, data);
  expect(value.records).toEqual([]);
  expect(value.creatableFields).toEqual(["name"]);
  data.rules = [
    {
      pageId: 10n,
      principal: { tag: "WorkspaceMember", value: identity },
      permission: { tag: "Read" },
    },
  ] as any;
  value = workspaceComponentSnapshot(source, data);
  expect(value.creatableFields).toEqual([]);
});

it("queries project requested fields while reads return all declared fields", () => {
  const data = fixture();
  const result = workspaceComponentQuery(source, {
    fields: ["name"], filter: [{ field: "status", op: "eq", value: "Ready" }],
  }, data);
  expect(result).toMatchObject({ status: "ready", complete: true, records: [{ id: "11", values: { name: "Saved value" } }] });
  expect(result.records[0].values).toEqual({ name: "Saved value" });
  expect(Number.isFinite(Date.parse(result.asOf))).toBe(true);
  expect(workspaceComponentRead(source, "11", data)).toEqual({
    status: "ready", record: { id: "11", values: { name: "Saved value", status: "Ready" } },
  });
  // A page outside the connected schema is not an opened record.
  expect(workspaceComponentRead(source, "12", data).status).toBe("unavailable");
});

it("query and read distinguish denied database access from missing or unready data", () => {
  const denied = fixture();
  denied.rules = [{ pageId: 10n, principal: { tag: "WorkspaceMember", value: { toHexString: () => "other" } }, permission: { tag: "Read" } }] as any;
  for (const data of [denied, { ...fixture(), principal: "anonymous" }]) {
    expect(workspaceComponentQuery(source, { fields: ["name"] }, data)).toMatchObject({ status: "denied", records: [], complete: false });
    expect(workspaceComponentRead(source, "11", data)).toMatchObject({ status: "denied" });
    expect(workspaceComponentRead(source, "11", data).record).toBeUndefined();
  }
  for (const data of [
    { ...fixture(), ready: false },
    { ...fixture(), schemas: [] },
    { ...fixture(), pages: fixture().pages.filter(page => page.id !== 10n) },
  ]) {
    expect(workspaceComponentQuery(source, { fields: ["name"] }, data)).toMatchObject({ status: "unavailable", records: [] });
    expect(workspaceComponentRead(source, "11", data).status).toBe("unavailable");
  }
  expect(workspaceComponentQuery(source, { fields: ["name"] }, { ...denied, privileged: true }).status).toBe("ready");
});

it("queries exclude unreadable children and reads conceal whether a hidden record exists", () => {
  const data = fixture();
  data.rules = [{ pageId: 11n, principal: { tag: "WorkspaceMember", value: { toHexString: () => "other" } }, permission: { tag: "Read" } }] as any;
  expect(workspaceComponentQuery(source, { fields: ["name"] }, data)).toMatchObject({ status: "ready", records: [], complete: true });
  const unavailable = { status: "unavailable", message: "This record is unavailable." };
  expect(workspaceComponentRead(source, "11", data)).toEqual(unavailable);
  expect(workspaceComponentRead(source, "999", data)).toEqual(unavailable);
  data.pages = data.pages.map(page => page.id === 11n ? { ...page, deletedAt: {} } as any : page);
  expect(workspaceComponentRead(source, "11", data).status).toBe("unavailable");
});

it("Date(u64) maps to a read-only UTC civil day in snapshots, queries and reads", () => {
  const data = fixture();
  const dated: ComponentSource = { ...source, fields: { ...source.fields, day: { type: "date" } }, connection: { adapter: "pear.database", schemaId: "5", mapping: { name: "7", status: "8", day: "9" } } };
  data.properties = [...data.properties, { id: 9n, schemaId: 5n, propertyType: { tag: "Date" } } as any];
  data.values = [...data.values, { pageId: 11n, propertyDefinitionId: 9n, value: { tag: "Date", value: BigInt(Date.parse("2026-11-04T00:30:00Z")) } } as any];
  expect(scalarProperty("Date")).toBe("date");
  expect(writableProperty("Date")).toBe(false);
  expect(workspaceComponentSnapshot(dated, data).records[0].values.day).toBe("2026-11-04");
  expect(workspaceComponentRead(dated, "11", data).record?.values.day).toBe("2026-11-04");
  expect(workspaceComponentQuery(dated, { fields: ["day"], range: { startField: "day", from: "2026-11-04", to: "2026-11-05" } }, data).records[0].values).toEqual({ day: "2026-11-04" });
  data.values = data.values.filter(value => value.propertyDefinitionId !== 9n);
  expect(workspaceComponentRead(dated, "11", data).record?.values.day).toBeNull();
  data.values = [...data.values, { pageId: 11n, propertyDefinitionId: 9n, value: { tag: "Date", value: 2n ** 64n - 1n } } as any];
  expect(workspaceComponentRead(dated, "11", data).record?.values.day).toBeNull();
});

it("queries filter all 1200 candidates before the bounded limit; snapshots retain their cap", () => {
  const data = fixture();
  data.pages = [data.pages[0], ...Array.from({ length: 1200 }, (_, i) => ({ id: BigInt(i + 100), parentId: 10n } as any))];
  data.values = data.pages.slice(1).map((page, i) => ({ pageId: page.id, propertyDefinitionId: 7n, value: { tag: "Text", value: i >= 1100 ? "match" : "skip" } } as any));
  const request = { fields: ["name"], filter: [{ field: "name", op: "eq" as const, value: "match" }] };
  const result = workspaceComponentQuery(source, request, data);
  expect(result.records).toHaveLength(100);
  expect(result.complete).toBe(true);
  expect(result.records.every(record => BigInt(record.id) >= 1200n)).toBe(true);
  expect(workspaceComponentQuery(source, { ...request, limit: 5 }, data)).toMatchObject({ complete: false, records: result.records.slice(0, 5) });
  expect(workspaceComponentQuery(source, { fields: ["name"] }, data).records).toHaveLength(200);
  expect(workspaceComponentSnapshot(source, data).records).toHaveLength(1000);
});

it("only declared fields mapped to matching schema properties are read", () => {
  const data = fixture();
  const mapped: ComponentSource = { ...source, fields: { ...source.fields, absent: { type: "string" } }, connection: { adapter: "pear.database", schemaId: "5", mapping: { name: "7", status: "8", secret: "7" } } };
  data.properties = data.properties.map(property => property.id === 8n ? { ...property, schemaId: 99n } : property);
  expect(workspaceComponentRead(mapped, "11", data).record?.values).toEqual({ name: "Saved value", status: null, absent: null });
  expect(() => workspaceComponentQuery(mapped, { fields: ["secret"] }, data)).toThrow();
});

it("native $title and $id mappings read the page title and identity as read-only text in every path", () => {
  const data = fixture();
  data.pages = data.pages.map(page => page.id === 11n ? { ...page, title: "Marketing production schedule" } as any : page);
  const native: ComponentSource = {
    ...source, mode: "query",
    fields: { ...source.fields, title: { type: "string" }, id: { type: "string" } },
    connection: { adapter: "pear.database", schemaId: "5", mapping: { name: "7", status: "8", title: "$title", id: "$id" } },
  };
  const snapshot = workspaceComponentSnapshot(native, data);
  expect(snapshot.records[0].values).toEqual({ name: "Saved value", status: "Ready", title: "Marketing production schedule", id: "11" });
  expect(snapshot.writableFields).toEqual(["name"]);
  expect(snapshot.records[0].writableFields).toEqual(["name"]);
  expect(workspaceComponentRead(native, "11", data).record?.values).toMatchObject({ title: "Marketing production schedule", id: "11" });
  const query = workspaceComponentQuery(native, {
    fields: ["title", "id"], filter: [{ field: "title", op: "contains", value: "schedule" }], sort: [{ field: "title", direction: "asc" }],
  }, data);
  expect(query).toMatchObject({ status: "ready", complete: true, records: [{ id: "11", values: { title: "Marketing production schedule", id: "11" } }] });
  expect(workspaceComponentQuery(native, { fields: ["title"], filter: [{ field: "title", op: "eq", value: "Other" }] }, data).records).toEqual([]);
  // A native mapping never becomes writable, even when the declaration asks for it.
  const asksWritable = { ...native, fields: { ...native.fields, title: { type: "string" as const, writable: true } } };
  expect(workspaceComponentSnapshot(asksWritable, data).writableFields).toEqual(["name"]);
  expect(workspaceComponentSnapshot(asksWritable, data).records[0].values.title).toBeNull();
  expect(NATIVE_RECORD_PROPERTIES.map(property => property.id)).toEqual(["$title", "$id"]);
  expect(NATIVE_RECORD_PROPERTIES.every(property => property.type === "string" && !property.writable)).toBe(true);
});

it("saved views over a query source follow filter, sort and limit across live changes and revocation", () => {
  const data = fixture();
  const asks: ComponentSource = {
    label: "Asks", mode: "query",
    fields: { title: { type: "string" }, status: { type: "string" }, raised: { type: "date" } },
    connection: { adapter: "pear.database", schemaId: "5", mapping: { title: "$title", status: "8", raised: "9" } },
  };
  data.properties = [...data.properties, { id: 9n, schemaId: 5n, propertyType: { tag: "Date" } } as any];
  const rows: [bigint, string, string, string][] = [
    [21n, "Older open ask", "Open", "2026-02-16"], [22n, "Newer open ask", "Open", "2026-08-17"],
    [23n, "Answered ask", "Answered", "2026-08-09"], [24n, "Newest open ask", "Open", "2026-09-23"],
  ];
  data.pages = [data.pages[0], ...rows.map(([id, title]) => ({ id, parentId: 10n, title } as any))];
  data.values = rows.flatMap(([id, , status, raised]) => [
    { pageId: id, propertyDefinitionId: 8n, value: { tag: "Select", value: status } },
    { pageId: id, propertyDefinitionId: 9n, value: { tag: "Date", value: BigInt(Date.parse(`${raised}T00:00:00Z`)) } },
  ] as any);
  const view = { fields: ["title", "status", "raised"], filter: [{ field: "status", op: "eq" as const, value: "Open" }], sort: [{ field: "raised", direction: "asc" as const }], limit: 2 };
  const result = workspaceComponentQuery(asks, view, data);
  expect(result.records.map(record => record.values.title)).toEqual(["Older open ask", "Newer open ask"]);
  expect(result.complete).toBe(false);
  expect(workspaceComponentQuery(asks, { ...view, limit: 50 }, data).records.map(record => record.id)).toEqual(["21", "22", "24"]);
  // The oldest ask is answered: it leaves the view on the next evaluation.
  data.values = data.values.map(value => value.pageId === 21n && value.propertyDefinitionId === 8n ? { ...value, value: { tag: "Select", value: "Answered" } } as any : value);
  expect(workspaceComponentQuery(asks, { ...view, limit: 50 }, data).records.map(record => record.id)).toEqual(["22", "24"]);
  // Revoking one row hides it; revoking the database denies the whole view.
  data.rules = [{ pageId: 22n, principal: { tag: "WorkspaceMember", value: { toHexString: () => "other" } }, permission: { tag: "Read" } }] as any;
  expect(workspaceComponentQuery(asks, { ...view, limit: 50 }, data).records.map(record => record.id)).toEqual(["24"]);
  data.rules = [{ pageId: 10n, principal: { tag: "WorkspaceMember", value: { toHexString: () => "other" } }, permission: { tag: "Read" } }] as any;
  expect(workspaceComponentQuery(asks, { ...view, limit: 50 }, data)).toMatchObject({ status: "denied", records: [] });
});
