import { test } from "node:test";
import assert from "node:assert/strict";

import { transformNotionToPayload } from "./notion/transformer.js";
import type { NotionFetchResult } from "./notion/fetcher.js";

/**
 * Regression fixtures for the import-structure bugs found on the first real
 * import: every page landed flat in the container (parents unresolved), the
 * Notion title property duplicated Pear's built-in title as a "Name" column,
 * and sub-page placeholders were dead text.
 */

const T = "2026-07-13T12:00:00.000Z";

function titleProp(text: string) {
  return { type: "title", title: [{ type: "text", plain_text: text, text: { content: text, link: null }, annotations: ann() }] };
}

function ann() {
  return { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" };
}

function page(id: string, title: string, parent: Record<string, unknown>, extraProps: Record<string, unknown> = {}) {
  return {
    object: "page",
    id,
    parent,
    created_time: T,
    last_edited_time: T,
    icon: null,
    cover: null,
    properties: { Name: titleProp(title), ...extraProps },
  };
}

function dataSource(id: string, title: string) {
  return {
    object: "data_source",
    id,
    parent: { type: "workspace", workspace: true },
    created_time: T,
    last_edited_time: T,
    icon: null,
    cover: null,
    title: [{ type: "text", plain_text: title, text: { content: title, link: null }, annotations: ann() }],
    description: [],
    properties: {
      Name: { type: "title", title: {} },
      Cost: { type: "number", number: { format: "dollar" } },
      Receipt: { type: "files", files: {} },
    },
  };
}

function makeFixture(): NotionFetchResult {
  const pages = new Map<string, unknown>();
  const blocks = new Map<string, unknown[]>();

  // A database (data source) with one row page parented via data_source_id.
  pages.set("ds-1", dataSource("ds-1", "Recurring Expenses"));
  pages.set("row-1", page("row-1", "Netflix", { type: "data_source_id", data_source_id: "ds-1" }, {
    Cost: { type: "number", number: 15.99 },
    Receipt: {
      type: "files",
      files: [
        { name: "receipt.pdf", type: "file", file: { url: "https://files.notion.example/receipt" } },
        { name: "docs", type: "external", external: { url: "https://example.com/docs" } },
      ],
    },
  }));

  // A top-level page with a normal sub-page.
  pages.set("top-1", page("top-1", "Hub", { type: "workspace", workspace: true }));
  pages.set("sub-1", page("sub-1", "Sub Page", { type: "page_id", page_id: "top-1" }));

  // A second database whose relation column targets ds-1 via data_source_id
  // (the v5 config also carries the database UUID, which no fetched object is
  // keyed by), plus a relation into a database that was never shared.
  pages.set("ds-2", {
    ...dataSource("ds-2", "Vendors"),
    properties: {
      Name: { type: "title", title: {} },
      Expenses: {
        type: "relation",
        relation: { database_id: "db-uuid-unfetched", data_source_id: "ds-1", type: "single_property", single_property: {} },
      },
      Contracts: {
        type: "relation",
        relation: { database_id: "db-uuid-other", data_source_id: "ds-unshared", type: "single_property", single_property: {} },
      },
    },
  });
  pages.set("vendor-1", page("vendor-1", "Netflix Inc", { type: "data_source_id", data_source_id: "ds-2" }, {
    Expenses: { type: "relation", relation: [{ id: "row-1" }, { id: "row-unfetched" }] },
    Contracts: { type: "relation", relation: [{ id: "contract-unfetched" }] },
  }));

  // A page nested inside a block (toggle/column) of the hub page.
  pages.set("blocknested-1", page("blocknested-1", "Inside Toggle", { type: "block_id", block_id: "blk-9" }));
  blocks.set("top-1", [
    {
      object: "block", id: "blk-9", type: "toggle", has_children: true,
      parent: { type: "page_id", page_id: "top-1" },
      toggle: { rich_text: [{ type: "text", plain_text: "More", text: { content: "More", link: null }, annotations: ann() }] },
    },
    {
      // In the live API a child_page block shares its id with the page itself.
      object: "block", id: "sub-1", type: "child_page", has_children: false,
      parent: { type: "page_id", page_id: "top-1" },
      child_page: { title: "Sub Page" },
    },
  ]);

  return {
    pages,
    blocks,
    comments: new Map(),
    attachmentRefs: [],
  } as unknown as NotionFetchResult;
}

function rowsByTitle(payload: ReturnType<typeof transformNotionToPayload>) {
  const map = new Map<string, Record<string, unknown>>();
  for (const r of payload.tables.page as Array<Record<string, unknown>>) map.set(r.title as string, r);
  return map;
}

function pearIdNum(v: unknown): unknown {
  // pearBigint wire format — compare parent references structurally.
  return JSON.stringify(v);
}

test("rows nest under their data source (data_source_id parent)", () => {
  const payload = transformNotionToPayload(makeFixture(), new Map(), "aa".repeat(32), "testws");
  const pages = rowsByTitle(payload);
  const db = pages.get("Recurring Expenses")!;
  const row = pages.get("Netflix")!;
  assert.ok(db, "database page emitted");
  assert.equal(pearIdNum(row.parentId), pearIdNum(db.id));
});

test("sub-pages nest under their parent page; block-nested pages resolve to the containing page", () => {
  const payload = transformNotionToPayload(makeFixture(), new Map(), "aa".repeat(32), "testws");
  const pages = rowsByTitle(payload);
  const hub = pages.get("Hub")!;
  assert.equal(pearIdNum(pages.get("Sub Page")!.parentId), pearIdNum(hub.id));
  assert.equal(pearIdNum(pages.get("Inside Toggle")!.parentId), pearIdNum(hub.id));
});

test("row property values are emitted for data_source_id-parented rows", () => {
  const payload = transformNotionToPayload(makeFixture(), new Map(), "aa".repeat(32), "testws");
  const values = payload.tables.page_property_value as Array<Record<string, unknown>>;
  // The Netflix row's Cost number must survive — the values loop resolves the
  // row's database via its parent, which is data_source_id in the current API.
  const numberValues = values.filter(
    (v) => (v.value as { tag?: string })?.tag === "Number",
  );
  assert.equal(numberValues.length, 1, `expected 1 number value, got ${values.length} total values`);
});

test("files properties become first-class File values with blob/external refs", () => {
  const uploaded = new Map([
    ["https://files.notion.example/receipt", {
      notionUrl: "https://files.notion.example/receipt",
      objectId: "11111111-2222-3333-4444-555555555555",
      byteSize: 10,
      contentType: "application/pdf",
    }],
  ]);
  const payload = transformNotionToPayload(makeFixture(), uploaded, "aa".repeat(32), "testws");
  const defs = payload.tables.property_definition as Array<Record<string, unknown>>;
  const receipt = defs.find((d) => d.name === "Receipt")!;
  assert.equal((receipt.propertyType as { tag: string }).tag, "File");
  const values = payload.tables.page_property_value as Array<Record<string, unknown>>;
  const fileVal = values.find((v) => (v.value as { tag?: string })?.tag === "File")!;
  const refs = (fileVal.value as { value: { name: string; objectId: string; externalUrl: string }[] }).value;
  assert.equal(refs.length, 2);
  assert.equal(refs[0].objectId, "11111111-2222-3333-4444-555555555555");
  assert.equal(refs[0].externalUrl, "");
  assert.equal(refs[1].objectId, "");
  assert.equal(refs[1].externalUrl, "https://example.com/docs");
});

test("relation columns target the related data source's page; unshared targets and refs are dropped", () => {
  const payload = transformNotionToPayload(makeFixture(), new Map(), "aa".repeat(32), "testws");
  const pages = rowsByTitle(payload);
  const expensesDb = pages.get("Recurring Expenses")!;
  const netflixRow = pages.get("Netflix")!;
  const defs = payload.tables.property_definition as Array<Record<string, unknown>>;

  // Column config: resolved via data_source_id, not the database UUID.
  const relDef = defs.find((d) => d.name === "Expenses")!;
  const cfg = JSON.parse(relDef.config as string) as { targetPageId?: string };
  assert.equal(
    cfg.targetPageId,
    (expensesDb.id as { v: string }).v,
    "relation targetPageId must be the payload id of the related data source's page",
  );

  // A relation into a database that wasn't shared gets no dangling target.
  const unsharedDef = defs.find((d) => d.name === "Contracts")!;
  assert.deepEqual(JSON.parse(unsharedDef.config as string), {});

  // Row values: fetched refs remap, unfetched refs are dropped.
  const values = payload.tables.page_property_value as Array<Record<string, unknown>>;
  const relValues = values.filter((v) => (v.value as { tag?: string })?.tag === "Relation");
  const expenseVal = relValues.find(
    (v) => pearIdNum(v.pageId) === pearIdNum(pages.get("Netflix Inc")!.id)
      && pearIdNum(v.propertyDefinitionId) === pearIdNum(relDef.id),
  )!;
  const ids = (expenseVal.value as { value: { v: string }[] }).value.map((x) => x.v);
  assert.deepEqual(ids, [(netflixRow.id as { v: string }).v]);
  const contractsDef = defs.find((d) => d.name === "Contracts")!;
  const contractVal = relValues.find(
    (v) => pearIdNum(v.propertyDefinitionId) === pearIdNum(contractsDef.id),
  )!;
  assert.equal((contractVal.value as { value: unknown[] }).value.length, 0);
});

test("declared idCounts cover every assigned page id, including link targets", () => {
  const payload = transformNotionToPayload(makeFixture(), new Map(), "aa".repeat(32), "testws");
  const maxRowId = Math.max(
    ...(payload.tables.page as Array<{ id: { v: string } }>).map((r) => Number(r.id.v)),
  );
  assert.ok(payload.idCounts.page >= maxRowId, "page idCount covers all page rows");
  assert.equal(payload.idCounts.property_definition, payload.tables.property_definition.length);
  assert.equal(payload.idCounts.page_property_value, payload.tables.page_property_value.length);
});

test("the Notion title property is not emitted as a duplicate column", () => {
  const payload = transformNotionToPayload(makeFixture(), new Map(), "aa".repeat(32), "testws");
  const defs = payload.tables.property_definition as Array<Record<string, unknown>>;
  const names = defs.map((d) => d.name);
  assert.ok(!names.includes("Name"), `title property leaked into columns: ${names.join(", ")}`);
  assert.ok(names.includes("Cost"));
});

test("child_page placeholders become native pageLink blocks targeting the imported page", () => {
  const payload = transformNotionToPayload(makeFixture(), new Map(), "aa".repeat(32), "testws");
  const pages = rowsByTitle(payload);
  const subPage = pages.get("Sub Page")!;
  const contentRows = payload.tables.page_content as Array<{ content: string }>;
  const hubContent = contentRows.map((c) => c.content).find((c) => c.includes("Sub Page"));
  assert.ok(hubContent, "hub page content exists");
  const blocks = JSON.parse(hubContent!) as Array<{
    type: string;
    props: { pageId?: string; pageTitle?: string };
  }>;
  const link = blocks.find((b) => b.type === "pageLink");
  assert.ok(link, "pageLink block emitted");
  // The pageId is the payload-local id of the child's page row; the import
  // reducer offsets it into the workspace id space alongside the row itself.
  assert.equal(link!.props.pageId, (subPage.id as { v: string }).v);
  assert.equal(link!.props.pageTitle, "Sub Page");
});
