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
  }));

  // A top-level page with a normal sub-page.
  pages.set("top-1", page("top-1", "Hub", { type: "workspace", workspace: true }));
  pages.set("sub-1", page("sub-1", "Sub Page", { type: "page_id", page_id: "top-1" }));

  // A page nested inside a block (toggle/column) of the hub page.
  pages.set("blocknested-1", page("blocknested-1", "Inside Toggle", { type: "block_id", block_id: "blk-9" }));
  blocks.set("top-1", [
    {
      object: "block", id: "blk-9", type: "toggle", has_children: true,
      parent: { type: "page_id", page_id: "top-1" },
      toggle: { rich_text: [{ type: "text", plain_text: "More", text: { content: "More", link: null }, annotations: ann() }] },
    },
    {
      object: "block", id: "blk-child-page", type: "child_page", has_children: false,
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

test("the Notion title property is not emitted as a duplicate column", () => {
  const payload = transformNotionToPayload(makeFixture(), new Map(), "aa".repeat(32), "testws");
  const defs = payload.tables.property_definition as Array<Record<string, unknown>>;
  const names = defs.map((d) => d.name);
  assert.ok(!names.includes("Name"), `title property leaked into columns: ${names.join(", ")}`);
  assert.ok(names.includes("Cost"));
});

test("child_page placeholders become links to the imported page", () => {
  const payload = transformNotionToPayload(makeFixture(), new Map(), "aa".repeat(32), "testws");
  const contentRows = payload.tables.page_content as Array<{ content: string }>;
  const hubContent = contentRows.map((c) => c.content).find((c) => c.includes("Sub Page"));
  assert.ok(hubContent, "hub page content exists");
  const blocks = JSON.parse(hubContent!);
  const flat = JSON.stringify(blocks);
  assert.match(flat, /\/workspace\/testws\/\d+/);
  assert.match(flat, /→ Sub Page/);
});
