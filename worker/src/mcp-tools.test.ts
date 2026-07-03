import { test } from "node:test";
import assert from "node:assert/strict";

import { buildToolRegistry } from "./mcp/tool-registry.js";
import { executeListMemory, executeRemember } from "./mcp/memory.js";
import type { ConnLike, ToolCallContext } from "./tools.js";

// ── Fakes ───────────────────────────────────────────────────────────────────────

/** Fake table with iter() plus optional pk-style `.field.find()` accessors. */
function table<T extends Record<string, unknown>>(
  rows: T[],
  indexes: string[] = [],
): Record<string, unknown> {
  const t: Record<string, unknown> = { iter: () => rows[Symbol.iterator]() };
  for (const field of indexes) {
    t[field] = {
      find: (key: unknown) => rows.find((r) => String(r[field]) === String(key)),
    };
  }
  return t;
}

/**
 * Stateful fake conn: a provisioned memory subtree (root 100 with one child
 * page 101, legacy BlockNote body) plus a workspace page 200 outside it.
 * Reducers mutate the arrays synchronously so executeTool's read-back
 * verification passes on the first poll.
 */
function memoryConn(opts: { withMemory?: boolean } = {}) {
  const { withMemory = true } = opts;
  const pages: Record<string, unknown>[] = [
    { id: 100n, parentId: undefined, title: "Memory", pageType: { tag: "Doc" }, deletedAt: undefined, contentFormat: { tag: "BlockNote" } },
    { id: 101n, parentId: 100n, title: "Notes", pageType: { tag: "Doc" }, deletedAt: undefined, contentFormat: { tag: "BlockNote" } },
    { id: 200n, parentId: undefined, title: "Workspace page", pageType: { tag: "Doc" }, deletedAt: undefined, contentFormat: { tag: "BlockNote" } },
  ];
  const pageContents: Record<string, unknown>[] = [{ pageId: 101n, content: "old note" }];
  let nextId = 300n;

  const db = {
    page: table(pages, ["id"]),
    page_content: table(pageContents, ["pageId"]),
    page_snapshot: table([]),
    database_schema: table([]),
    ai_user_memory: table(withMemory ? [{ aiUserId: 7n, rootPageId: 100n }] : []),
    component_node: table([]),
    component_yjs_state: table([]),
  };
  const reducers = {
    createPage: async (args: { parentId?: bigint; title: string }) => {
      pages.push({
        id: nextId++,
        parentId: args.parentId,
        title: args.title,
        pageType: { tag: "Doc" },
        deletedAt: undefined,
        contentFormat: { tag: "BlockNote" },
      });
    },
    updatePageContent: async (args: { pageId: bigint; content: string }) => {
      const row = pageContents.find((c) => String(c.pageId) === String(args.pageId));
      if (row) row.content = args.content;
      else pageContents.push({ pageId: args.pageId, content: args.content });
    },
    takeSnapshot: async () => {
      // Fail fast so takePreEditSnapshot doesn't poll for a row that never comes.
      throw new Error("no snapshots in fake");
    },
    setSharedContext: async () => {},
  };
  const conn = { db, reducers } as unknown as ConnLike;
  return { conn, pages, pageContents };
}

const CTX: ToolCallContext = { aiUserId: 7n, aiIdentityHex: "abcd" };

function contentOf(pageContents: Record<string, unknown>[], pageId: bigint): string {
  return String(pageContents.find((c) => String(c.pageId) === String(pageId))?.content ?? "");
}

// ── Registry ────────────────────────────────────────────────────────────────────

test("registry exposes exactly the v1 tool surface", () => {
  const registry = buildToolRegistry();
  const names = registry.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "create_page",
    "delete_page",
    "get_page",
    "list_child_pages",
    "list_memory",
    "move_page",
    "read_memory",
    "remember",
    "search_memory",
    "search_pages",
    "update_page_content",
    "update_page_title",
  ]);
});

test("registry excludes chat-coupled tools", () => {
  const names = new Set(buildToolRegistry().map((t) => t.name));
  for (const excluded of ["render_ui", "delegate", "request_page_access", "tool_bash", "mark_memory_consolidated", "web_search", "fetch_url"]) {
    assert.equal(names.has(excluded), false, `${excluded} must not be exposed over MCP`);
  }
});

test("every registry entry has a description and an object input schema", () => {
  for (const entry of buildToolRegistry()) {
    assert.ok(entry.description.length > 0, `${entry.name} needs a description`);
    assert.equal(entry.inputSchema.type, "object", `${entry.name} schema must be an object`);
  }
});

test("chat-specific descriptions are overridden for MCP clients", () => {
  const readMemory = buildToolRegistry().find((t) => t.name === "read_memory")!;
  assert.doesNotMatch(readMemory.description, /system prompt/i);
});

// ── list_memory ─────────────────────────────────────────────────────────────────

test("list_memory reports unprovisioned memory with guidance", async () => {
  const { conn } = memoryConn({ withMemory: false });
  const res = JSON.parse(await executeListMemory(conn, CTX));
  assert.equal(res.ok, false);
  assert.match(res.error, /provision/i);
});

test("list_memory indexes the memory subtree only", async () => {
  const { conn } = memoryConn();
  const res = JSON.parse(await executeListMemory(conn, CTX));
  assert.equal(res.ok, true);
  const ids = (res.pages as { page_id: number }[]).map((p) => p.page_id);
  assert.deepEqual(ids.sort(), [100, 101]); // workspace page 200 excluded
  const notes = (res.pages as { page_id: number; snippet: string }[]).find((p) => p.page_id === 101)!;
  assert.match(notes.snippet, /old note/);
});

// ── remember ────────────────────────────────────────────────────────────────────

test("remember rejects empty content", async () => {
  const { conn } = memoryConn();
  const res = JSON.parse(await executeRemember(conn, { content: "  " }, CTX));
  assert.equal(res.ok, false);
  assert.match(res.error, /content/);
});

test("remember requires a title for new pages", async () => {
  const { conn } = memoryConn();
  const res = JSON.parse(await executeRemember(conn, { content: "a fact" }, CTX));
  assert.equal(res.ok, false);
  assert.match(res.error, /title/);
});

test("remember errors when memory is unprovisioned", async () => {
  const { conn } = memoryConn({ withMemory: false });
  const res = JSON.parse(await executeRemember(conn, { title: "T", content: "a fact" }, CTX));
  assert.equal(res.ok, false);
  assert.match(res.error, /provision/i);
});

test("remember creates a new memory page under the root", async () => {
  const { conn, pages, pageContents } = memoryConn();
  const res = JSON.parse(
    await executeRemember(conn, { title: "User prefs", content: "likes tea" }, CTX),
  );
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  assert.equal(res.title, "User prefs");
  const created = pages.find((p) => p.title === "User prefs")!;
  assert.equal(String(created.parentId), "100"); // under the memory root
  assert.equal(res.page_id, Number(created.id));
  assert.match(contentOf(pageContents, created.id as bigint), /likes tea/);
});

test("remember appends to an existing memory page by default", async () => {
  const { conn, pageContents } = memoryConn();
  const res = JSON.parse(
    await executeRemember(conn, { memory_page_id: 101, content: "new fact" }, CTX),
  );
  assert.equal(res.ok, true);
  assert.equal(res.mode, "append");
  const stored = contentOf(pageContents, 101n);
  assert.match(stored, /old note/);
  assert.match(stored, /new fact/);
});

test("remember mode=replace overwrites the page body", async () => {
  const { conn, pageContents } = memoryConn();
  const res = JSON.parse(
    await executeRemember(conn, { memory_page_id: 101, content: "new fact", mode: "replace" }, CTX),
  );
  assert.equal(res.ok, true);
  assert.equal(res.mode, "replace");
  const stored = contentOf(pageContents, 101n);
  assert.match(stored, /new fact/);
  assert.doesNotMatch(stored, /old note/);
});

test("remember rejects a page outside the memory subtree", async () => {
  const { conn, pageContents } = memoryConn();
  const res = JSON.parse(
    await executeRemember(conn, { memory_page_id: 200, content: "sneaky" }, CTX),
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /No memory page/);
  assert.doesNotMatch(contentOf(pageContents, 200n), /sneaky/);
});

test("remember without an AI user context fails closed", async () => {
  const { conn } = memoryConn();
  const res = JSON.parse(await executeRemember(conn, { title: "T", content: "x" }, {}));
  assert.equal(res.ok, false);
});
