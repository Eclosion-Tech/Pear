import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { transformNotionToPayload } from "./notion/transformer.js";
import type { NotionFetchResult } from "./notion/fetcher.js";

/**
 * Import-parity suite: every fixture here reproduces a way Notion data was
 * silently dropped or degraded (see the 2026-07-15 audit), plus a coverage
 * tripwire that fails when a Notion API addition isn't explicitly triaged.
 */

const T = "2026-07-15T12:00:00.000Z";
const require = createRequire(import.meta.url);

function ann(overrides: Record<string, unknown> = {}) {
  return {
    bold: false, italic: false, strikethrough: false,
    underline: false, code: false, color: "default", ...overrides,
  };
}

function rt(text: string, annotations: Record<string, unknown> = {}) {
  return { type: "text", plain_text: text, text: { content: text, link: null }, annotations: ann(annotations) };
}

function titleProp(text: string) {
  return { type: "title", id: "title", title: [rt(text)] };
}

function page(id: string, title: string, extraProps: Record<string, unknown> = {}) {
  return {
    object: "page",
    id,
    parent: { type: "workspace", workspace: true },
    created_time: T,
    last_edited_time: T,
    icon: null,
    cover: null,
    properties: { Name: titleProp(title), ...extraProps },
  };
}

function fixture(opts: {
  pages?: Map<string, unknown>;
  blocks?: Map<string, unknown[]>;
  comments?: Map<string, unknown[]>;
  userNames?: Map<string, string>;
}): NotionFetchResult {
  return {
    pages: opts.pages ?? new Map(),
    blocks: opts.blocks ?? new Map(),
    comments: opts.comments ?? new Map(),
    attachmentRefs: [],
    userNames: opts.userNames ?? new Map(),
  } as unknown as NotionFetchResult;
}

function transform(f: NotionFetchResult, uploads = new Map()) {
  return transformNotionToPayload(f, uploads, "aa".repeat(32), "testws");
}

function contentBlocksOf(payload: ReturnType<typeof transform>, titleIncludes: string) {
  const pages = payload.tables.page as Array<{ id: unknown; title: string }>;
  const target = pages.find((p) => p.title.includes(titleIncludes))!;
  const rows = payload.tables.page_content as Array<{ pageId: unknown; content: string }>;
  const row = rows.find((r) => JSON.stringify(r.pageId) === JSON.stringify(target.id))!;
  return JSON.parse(row.content) as Array<Record<string, unknown>>;
}

function block(pageId: string, id: string, type: string, payload: Record<string, unknown>, hasChildren = false) {
  return {
    object: "block", id, type, has_children: hasChildren,
    parent: { type: "page_id", page_id: pageId },
    [type]: payload,
  };
}

// ── Rich text fidelity ─────────────────────────────────────────────────────────

test("page @-mentions become internal links; colors become styles", () => {
  const pages = new Map<string, unknown>([
    ["p1", page("p1", "Home")],
    ["p2", page("p2", "Target")],
  ]);
  const blocks = new Map<string, unknown[]>([
    ["p1", [block("p1", "b1", "paragraph", {
      rich_text: [
        { type: "mention", plain_text: "Target", mention: { type: "page", page: { id: "p2" } }, annotations: ann() },
        rt("warm", { color: "red" }),
        rt("cool", { color: "blue_background" }),
      ],
    })]],
  ]);
  const payload = transform(fixture({ pages, blocks }));
  const flat = JSON.stringify(contentBlocksOf(payload, "Home"));
  assert.match(flat, /\/workspace\/testws\/\d+/, "mention links to the imported page");
  assert.match(flat, /"textColor":"red"/);
  assert.match(flat, /"backgroundColor":"blue"/);
});

// ── Native block emission ─────────────────────────────────────────────────────

test("callout, toggle, code, divider, quote, and table headers emit native blocks", () => {
  const pages = new Map<string, unknown>([["p1", page("p1", "Blocks")]]);
  const blocks = new Map<string, unknown[]>([
    ["p1", [
      block("p1", "b1", "callout", {
        rich_text: [rt("Heads up")],
        icon: { type: "emoji", emoji: "💡" },
        color: "yellow_background",
      }),
      block("p1", "b2", "toggle", { rich_text: [rt("More")] }, true),
      { ...block("p1", "b2c", "paragraph", { rich_text: [rt("hidden")] }), parent: { type: "block_id", block_id: "b2" } },
      block("p1", "b3", "code", { rich_text: [rt("SELECT 1")], language: "sql", caption: [] }),
      block("p1", "b4", "divider", {}),
      block("p1", "b5", "quote", { rich_text: [rt("wise words")] }),
      block("p1", "b6", "table", { table_width: 1, has_column_header: true, has_row_header: false }, true),
      { ...block("p1", "b6r", "table_row", { cells: [[rt("h1")]] }), parent: { type: "block_id", block_id: "b6" } },
    ]],
  ]);
  const bn = contentBlocksOf(transform(fixture({ pages, blocks })), "Blocks");
  const types = bn.map((b) => b.type);
  assert.ok(types.includes("callout"), `callout emitted (got ${types})`);
  const callout = bn.find((b) => b.type === "callout")!;
  assert.equal((callout.props as { icon: string }).icon, "💡");
  assert.equal((callout.props as { color: string }).color, "yellow");
  assert.ok(types.includes("toggleListItem"), "toggle emitted");
  const toggle = bn.find((b) => b.type === "toggleListItem")!;
  assert.equal((toggle.children as unknown[]).length, 1, "toggle keeps its children");
  const code = bn.find((b) => b.type === "codeBlock")!;
  assert.equal((code.props as { language: string }).language, "sql");
  assert.ok(types.includes("divider"), "divider emitted");
  assert.ok(types.includes("quote"), "quote emitted");
  const table = bn.find((b) => b.type === "table")!;
  assert.equal((table.content as { headerRows?: number }).headerRows, 1);
});

test("uploaded images carry storageKey; hotlinked images carry externalUrl", () => {
  const pages = new Map<string, unknown>([["p1", page("p1", "Pics")]]);
  const blocks = new Map<string, unknown[]>([
    ["p1", [
      block("p1", "b1", "image", { type: "file", file: { url: "https://n.example/a.png" }, caption: [] }),
      block("p1", "b2", "image", { type: "external", external: { url: "https://pics.example/b.png" }, caption: [rt("ext")] }),
    ]],
  ]);
  const uploads = new Map([[
    "https://n.example/a.png",
    { notionUrl: "https://n.example/a.png", objectId: "obj-123", byteSize: 5, contentType: "image/png" },
  ]]);
  const bn = contentBlocksOf(transform(fixture({ pages, blocks }), uploads), "Pics");
  const images = bn.filter((b) => b.type === "image") as Array<{ props: Record<string, string> }>;
  assert.equal(images.length, 2);
  assert.equal(images[0].props.storageKey, "obj-123");
  assert.equal(images[0].props.externalUrl, "");
  assert.equal(images[1].props.storageKey, "");
  assert.equal(images[1].props.externalUrl, "https://pics.example/b.png");
});

test("file blocks keep their filename; empty synced blocks leave a placeholder", () => {
  const pages = new Map<string, unknown>([["p1", page("p1", "Files")]]);
  const blocks = new Map<string, unknown[]>([
    ["p1", [
      block("p1", "b1", "file", { type: "external", external: { url: "https://x.example/report.pdf" }, caption: [rt("Q3 report")], name: "report.pdf" }),
      block("p1", "b2", "synced_block", { synced_from: { type: "block_id", block_id: "unshared" } }),
    ]],
  ]);
  const bn = contentBlocksOf(transform(fixture({ pages, blocks })), "Files");
  const file = bn.find((b) => b.type === "file")!;
  assert.equal((file.props as { name: string }).name, "report.pdf");
  assert.match(JSON.stringify(bn), /Synced block — original not shared/);
});

// ── Property values ───────────────────────────────────────────────────────────

test("unique_id keeps its prefix, place becomes readable text, null numbers stay empty", () => {
  const ds = {
    object: "data_source",
    id: "ds-1",
    parent: { type: "database_id", database_id: "db-ds-1" },
    database_parent: { type: "workspace", workspace: true },
    created_time: T, last_edited_time: T, icon: null, cover: null,
    title: [rt("Tracker")], description: [],
    properties: {
      Name: { type: "title", id: "t", title: {} },
      ID: { type: "unique_id", id: "u", unique_id: {} },
      Where: { type: "place", id: "pl", place: {} },
      Cost: { type: "number", id: "n", number: { format: "dollar" } },
    },
  };
  const pages = new Map<string, unknown>([
    ["ds-1", ds],
    ["row-1", {
      ...page("row-1", "Entry"),
      parent: { type: "data_source_id", data_source_id: "ds-1" },
      properties: {
        Name: titleProp("Entry"),
        ID: { type: "unique_id", id: "u", unique_id: { prefix: "TASK", number: 42 } },
        Where: { type: "place", id: "pl", place: { name: "HQ", address: "1 Main St", latitude: 40.7, longitude: -74.0 } },
        Cost: { type: "number", id: "n", number: null },
      },
    }],
  ]);
  const payload = transform(fixture({ pages }));
  const values = payload.tables.page_property_value as Array<{ value: { tag: string; value: unknown } }>;
  const texts = values.filter((v) => v.value.tag === "Text").map((v) => v.value.value);
  assert.ok(texts.includes("TASK-42"), `unique_id kept prefix (${texts})`);
  assert.ok(texts.some((t) => String(t).includes("HQ, 1 Main St")), "place formatted");
  assert.equal(values.filter((v) => v.value.tag === "Number").length, 0, "null number emits no value");
  const defs = payload.tables.property_definition as Array<{ name: string; propertyType: { tag: string } }>;
  assert.equal(defs.find((d) => d.name === "ID")!.propertyType.tag, "Text");
});

test("people resolve through the user directory; comments carry original authorship", () => {
  const pages = new Map<string, unknown>([["p1", {
    ...page("p1", "Team"),
  }]]);
  const comments = new Map<string, unknown[]>([
    ["p1", [{
      object: "comment", id: "c1",
      rich_text: [rt("looks good")],
      created_time: T,
      created_by: { object: "user", id: "u-9" },
      display_name: { type: "user", resolved_name: "Jenna" },
    }]],
  ]);
  const payload = transform(fixture({ pages, comments, userNames: new Map([["u-9", "Jenna"]]) }));
  const messages = payload.tables.conversation_message as Array<{ content: string }>;
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /^Jenna: looks good/);
});

// ── Coverage tripwire ─────────────────────────────────────────────────────────

const HANDLED_BLOCK_TYPES = new Set([
  "paragraph", "heading_1", "heading_2", "heading_3", "heading_4",
  "bulleted_list_item", "numbered_list_item", "to_do", "toggle",
  "code", "quote", "callout", "divider", "image", "file", "pdf",
  "table", "table_row", "equation", "child_page", "child_database",
  "video", "audio", "embed", "bookmark", "link_preview", "link_to_page",
  "column_list", "column", "synced_block", "template",
  "meeting_notes", "transcription",
]);
// Triaged, deliberately not imported as content (placeholder or empty).
const KNOWN_GAP_BLOCK_TYPES = new Set([
  "table_of_contents", "breadcrumb", "unsupported", "tab",
]);

test("tripwire: every Notion block type is handled or explicitly triaged", () => {
  const dts = readFileSync(
    require.resolve("@notionhq/client/build/src/api-endpoints/blocks.js").replace(/\.js$/, ".d.ts"),
    "utf8",
  );
  const types = new Set<string>();
  for (const m of dts.matchAll(/type \w+BlockObjectResponse = \{\s*type: "(\w+)"/g)) {
    types.add(m[1]);
  }
  assert.ok(types.size >= 25, `sanity: parsed ${types.size} block types from typedefs`);
  const untriaged = [...types].filter(
    (t) => !HANDLED_BLOCK_TYPES.has(t) && !KNOWN_GAP_BLOCK_TYPES.has(t),
  );
  assert.deepEqual(untriaged, [], `untriaged Notion block types: ${untriaged.join(", ")}`);
});

const HANDLED_PROPERTY_TYPES = new Set([
  "title", "rich_text", "number", "unique_id", "date", "created_time",
  "last_edited_time", "select", "status", "multi_select", "checkbox",
  "verification", "url", "email", "phone_number", "people", "created_by",
  "last_edited_by", "relation", "formula", "rollup", "files", "place",
  "button",
]);

test("tripwire: every Notion property type is handled or explicitly triaged", () => {
  const dts = readFileSync(
    require.resolve("@notionhq/client/build/src/api-endpoints/data-sources.js").replace(/\.js$/, ".d.ts"),
    "utf8",
  );
  const types = new Set<string>();
  for (const m of dts.matchAll(/type \w+DatabasePropertyConfigResponse = \{\s*type: "(\w+)"/g)) {
    types.add(m[1]);
  }
  assert.ok(types.size >= 18, `sanity: parsed ${types.size} property types from typedefs`);
  const untriaged = [...types].filter((t) => !HANDLED_PROPERTY_TYPES.has(t));
  assert.deepEqual(untriaged, [], `untriaged Notion property types: ${untriaged.join(", ")}`);
});
