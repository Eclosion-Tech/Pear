/**
 * Unit tests for the stateless MCP core against a fake StdbTransport.
 *
 * The fake speaks REAL wire shapes on reads — Option `[0,v]` / `[1,[]]`,
 * enums `[variantIndex, []]`, bare Timestamps `[micros]`, Yjs bytes as HEX
 * STRINGS — so the decoder path is exercised end-to-end, and its `call`
 * mutates in-memory tables + bumps a fake gap-free `id_counter`, mirroring
 * the reducers' allocation behavior (including the ComponentTree seeding
 * `create_page` does for Doc pages).
 */

import { describe, expect, test } from "vitest";
import { richTextBlockToYjsBytes } from "@eclosion-tech/pulp/rich-text/encode";
import type { StdbTransport } from "../api-endpoint";
import type { McpContext } from "./types";
import { buildToolRegistry } from "./tools";
import { resolveAiUser } from "./identity";
import { McpAuthError } from "./types";

// ── Fake StdbTransport ─────────────────────────────────────────────────────────

interface FakePage {
  id: number;
  parentId: number | null;
  title: string;
  pageType: "Doc" | "Database";
  contentFormat: "BlockNote" | "ComponentTree";
  sortOrder: number;
  deletedAtMicros: number | null;
  updatedAtMicros: number;
}

interface FakeNode {
  id: number;
  surfaceId: number;
  parentId: number | null;
  componentType: string;
  order: number;
  deletedAtMicros: number | null;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const NOW_MICROS = 1_783_105_049_000_000;

class FakeStdb implements StdbTransport {
  pages: FakePage[] = [];
  nodes: FakeNode[] = [];
  yjs = new Map<number, string>(); // node id → hex
  pageContent = new Map<number, string>();
  aiUserConfig: Array<{ id: number }> = [{ id: 7 }];
  aiUserMemory: Array<{ aiUserId: number; rootPageId: number }> = [];
  snapshots: Array<{ id: number; pageId: number }> = [];
  schemas: Array<{ id: number; pageId: number }> = [];
  counters = new Map<string, number>([
    ["page", 1000],
    ["component_node", 2000],
    ["database_schema", 100],
    ["page_snapshot", 10],
  ]);
  /** Extra ids to burn per insert_component — simulates a concurrent writer. */
  interleavePerInsert = 0;
  calls: string[] = [];

  alloc(name: string): number {
    const next = (this.counters.get(name) ?? 0) + 1;
    this.counters.set(name, next);
    return next;
  }

  seedPage(p: Partial<FakePage> & { id: number; title: string }): FakePage {
    const page: FakePage = {
      parentId: null,
      pageType: "Doc",
      contentFormat: "ComponentTree",
      sortOrder: 1000,
      deletedAtMicros: null,
      updatedAtMicros: NOW_MICROS,
      ...p,
    };
    this.pages.push(page);
    this.counters.set("page", Math.max(this.counters.get("page")!, page.id));
    return page;
  }

  /** Seed a ComponentTree body: root Container + one RichText child. */
  seedTree(pageId: number, text: string): void {
    const rootId = this.alloc("component_node");
    this.nodes.push({ id: rootId, surfaceId: pageId, parentId: null, componentType: "Container", order: 1000, deletedAtMicros: null });
    const nodeId = this.alloc("component_node");
    this.nodes.push({ id: nodeId, surfaceId: pageId, parentId: rootId, componentType: "RichText", order: 1000, deletedAtMicros: null });
    this.yjs.set(nodeId, toHex(richTextBlockToYjsBytes(text, true)));
  }

  // ── Wire-shape emitters (real STDB /sql shapes) ────────────────────────

  private optNum(v: number | null): unknown {
    return v === null ? [1, []] : [0, v];
  }
  private optTs(v: number | null): unknown {
    return v === null ? [1, []] : [0, [v]];
  }
  private pageWire(p: FakePage): Record<string, unknown> {
    return {
      id: p.id,
      parent_id: this.optNum(p.parentId),
      title: p.title,
      page_type: [p.pageType === "Doc" ? 0 : 1, []],
      content_format: [p.contentFormat === "BlockNote" ? 0 : 1, []],
      sort_order: p.sortOrder,
      deleted_at: this.optTs(p.deletedAtMicros),
      updated_at: [p.updatedAtMicros], // bare Timestamp = single-element Product
    };
  }
  private nodeWire(n: FakeNode): Record<string, unknown> {
    return {
      id: n.id,
      parent_id: this.optNum(n.parentId),
      component_type: n.componentType,
      order: n.order,
      deleted_at: this.optTs(n.deletedAtMicros),
    };
  }

  // ── sql router ─────────────────────────────────────────────────────────

  async sql<Row = unknown>(query: string, params: unknown[] = []): Promise<Row[]> {
    const q = query.replace(/\s+/g, " ").trim();

    if (q.includes("FROM ai_user_config")) {
      return this.aiUserConfig as Row[];
    }
    if (q.includes("FROM id_counter")) {
      const name = String(params[0]);
      return [{ value: this.counters.get(name) ?? 0 }] as Row[];
    }
    if (q.includes("FROM ai_user_memory")) {
      return this.aiUserMemory.map((m) => ({
        ai_user_id: m.aiUserId,
        root_page_id: m.rootPageId,
      })) as Row[];
    }
    if (q.includes("FROM page_content")) {
      const pageId = Number(params[0]);
      const content = this.pageContent.get(pageId);
      return (content !== undefined ? [{ content }] : []) as Row[];
    }
    if (q.includes("FROM page_snapshot")) {
      const pageId = Number(params[0]);
      return this.snapshots.filter((s) => s.pageId === pageId) as Row[];
    }
    if (q.includes("FROM database_schema")) {
      const pageId = Number(params[0]);
      return this.schemas.filter((s) => s.pageId === pageId) as Row[];
    }
    if (q.includes("FROM component_node")) {
      const surfaceId = Number(params[0]);
      return this.nodes
        .filter((n) => n.surfaceId === surfaceId)
        .map((n) => this.nodeWire(n)) as Row[];
    }
    if (q.includes("FROM component_yjs_state")) {
      const ids = new Set(params.map(Number));
      return [...this.yjs.entries()]
        .filter(([id]) => ids.has(id))
        .map(([id, hex]) => ({ component_node_id: id, data: hex })) as Row[];
    }
    if (q.includes("FROM page")) {
      let rows = this.pages;
      if (q.includes("WHERE id = ?")) {
        rows = rows.filter((p) => p.id === Number(params[0]));
      } else if (q.includes("WHERE parent_pk = ? AND title = ?")) {
        rows = rows.filter(
          (p) => (p.parentId ?? 0) === Number(params[0]) && p.title === String(params[1]),
        );
      } else if (q.includes("WHERE parent_pk = ?")) {
        rows = rows.filter((p) => (p.parentId ?? 0) === Number(params[0]));
      }
      return rows.map((p) => this.pageWire(p)) as Row[];
    }
    throw new Error(`FakeStdb: unrouted query: ${q}`);
  }

  // ── call (reducer) implementations ─────────────────────────────────────

  async call(reducer: string, args: unknown[]): Promise<void> {
    this.calls.push(reducer);
    const fail = (msg: string): never => {
      throw new Error(`SpacetimeDB reducer '${reducer}' failed (530): ${msg}`);
    };
    switch (reducer) {
      case "create_page": {
        const [parentOpt, pageType, title] = args as [
          { some?: number; none?: [] },
          Record<string, unknown>,
          string,
        ];
        if (!title.trim()) fail("Title is required");
        const id = this.alloc("page");
        const page: FakePage = {
          id,
          parentId: parentOpt.some !== undefined ? Number(parentOpt.some) : null,
          title,
          pageType: "database" in pageType ? "Database" : "Doc",
          contentFormat: "database" in pageType ? "BlockNote" : "ComponentTree",
          sortOrder: 1000,
          deletedAtMicros: null,
          updatedAtMicros: NOW_MICROS,
        };
        this.pages.push(page);
        if (page.pageType === "Doc") {
          // Server seeds Doc pages: root Container + default RichText.
          const rootId = this.alloc("component_node");
          this.nodes.push({ id: rootId, surfaceId: id, parentId: null, componentType: "Container", order: 1000, deletedAtMicros: null });
          const rtId = this.alloc("component_node");
          this.nodes.push({ id: rtId, surfaceId: id, parentId: rootId, componentType: "RichText", order: 1000, deletedAtMicros: null });
        }
        return;
      }
      case "insert_component": {
        const [parentId, componentType, , afterOpt] = args as [
          number,
          string,
          string,
          { some?: number; none?: [] },
        ];
        const parent = this.nodes.find((n) => n.id === Number(parentId));
        if (!parent) fail("Parent component not found");
        // Simulated concurrent writer: burn ids before ours.
        for (let i = 0; i < this.interleavePerInsert; i++) this.alloc("component_node");
        const id = this.alloc("component_node");
        const siblings = this.nodes.filter(
          (n) => n.parentId === Number(parentId) && n.deletedAtMicros === null,
        );
        const afterId = afterOpt.some !== undefined ? Number(afterOpt.some) : undefined;
        const order =
          afterId !== undefined
            ? (siblings.find((s) => s.id === afterId)?.order ?? 0) + 1000
            : (siblings.at(-1)?.order ?? 0) + 1000;
        this.nodes.push({
          id,
          surfaceId: parent!.surfaceId,
          parentId: Number(parentId),
          componentType,
          order,
          deletedAtMicros: null,
        });
        return;
      }
      case "delete_component": {
        const node = this.nodes.find((n) => n.id === Number(args[0]));
        if (!node) fail("Component not found");
        node!.deletedAtMicros = NOW_MICROS;
        return;
      }
      case "save_component_yjs_state": {
        const [nodeId, data] = args as [number, number[]];
        if (!this.nodes.find((n) => n.id === Number(nodeId))) fail("Component not found");
        this.yjs.set(Number(nodeId), toHex(new Uint8Array(data)));
        return;
      }
      case "update_page_content": {
        const [pageId, content] = args as [number, string];
        const page = this.pages.find((p) => p.id === Number(pageId));
        if (!page) fail("Page not found");
        if (page!.contentFormat === "ComponentTree") {
          fail(
            "Page is in ComponentTree format — use the component reducers (insert_component / update_component_props / save_component_yjs_state) instead",
          );
        }
        this.pageContent.set(Number(pageId), content);
        return;
      }
      case "update_page_title": {
        const [pageId, title] = args as [number, string];
        if (!String(title).trim()) fail("Title is required");
        const page = this.pages.find((p) => p.id === Number(pageId));
        if (!page) fail("Page not found");
        page!.title = String(title);
        return;
      }
      case "delete_page": {
        const page = this.pages.find((p) => p.id === Number(args[0]));
        if (!page) fail("Page not found");
        page!.deletedAtMicros = NOW_MICROS;
        return;
      }
      case "move_page": {
        const [pageId, parentOpt] = args as [number, { some?: number; none?: [] }];
        const page = this.pages.find((p) => p.id === Number(pageId));
        if (!page) fail("Page not found");
        page!.parentId = parentOpt.some !== undefined ? Number(parentOpt.some) : null;
        return;
      }
      case "take_snapshot": {
        const pageId = Number(args[0]);
        this.snapshots.push({ id: this.alloc("page_snapshot"), pageId });
        return;
      }
      case "create_database_schema": {
        const pageId = Number(args[0]);
        this.schemas.push({ id: this.alloc("database_schema"), pageId });
        return;
      }
      default:
        fail(`Unknown reducer: ${reducer}`);
    }
  }
}

// ── Harness helpers ────────────────────────────────────────────────────────────

function memoryFake(opts: { withMemory?: boolean } = {}): FakeStdb {
  const fake = new FakeStdb();
  fake.seedPage({ id: 100, title: "Memory · Test AI", contentFormat: "ComponentTree" });
  fake.seedTree(100, "");
  const notes = fake.seedPage({
    id: 101,
    title: "Notes",
    parentId: 100,
    contentFormat: "ComponentTree",
  });
  fake.seedTree(notes.id, "old note");
  fake.seedPage({ id: 200, title: "Workspace page", contentFormat: "ComponentTree" });
  fake.seedTree(200, "workspace body");
  if (opts.withMemory !== false) {
    fake.aiUserMemory.push({ aiUserId: 7, rootPageId: 100 });
  }
  return fake;
}

function ctxFor(fake: FakeStdb): McpContext {
  return { transport: fake, aiUserId: 7n };
}

const tools = new Map(buildToolRegistry().map((t) => [t.name, t]));

async function run(
  fake: FakeStdb,
  tool: string,
  input: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const entry = tools.get(tool);
  if (!entry) throw new Error(`no tool ${tool}`);
  return JSON.parse(await entry.execute(ctxFor(fake), input));
}

// ── Registry shape ─────────────────────────────────────────────────────────────

describe("registry", () => {
  test("exposes exactly the v1 tool surface", () => {
    expect([...tools.keys()].sort()).toEqual([
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

  test("excludes chat-coupled tools", () => {
    for (const excluded of ["render_ui", "delegate", "request_page_access", "tool_bash", "mark_memory_consolidated", "web_search", "fetch_url"]) {
      expect(tools.has(excluded)).toBe(false);
    }
  });

  test("every entry has a description and an object input schema", () => {
    for (const entry of tools.values()) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.inputSchema.type).toBe("object");
    }
  });

  test("chat-specific descriptions are overridden for MCP clients", () => {
    expect(tools.get("read_memory")!.description).not.toMatch(/system prompt/i);
  });
});

// ── Identity ───────────────────────────────────────────────────────────────────

describe("resolveAiUser", () => {
  test("resolves the RLS-visible config row", async () => {
    expect(await resolveAiUser(memoryFake())).toBe(7n);
  });

  test("throws McpAuthError when the token has no AI-user row", async () => {
    const fake = memoryFake();
    fake.aiUserConfig = [];
    await expect(resolveAiUser(fake)).rejects.toBeInstanceOf(McpAuthError);
  });
});

// ── Memory tools ───────────────────────────────────────────────────────────────

describe("memory", () => {
  test("list_memory reports unprovisioned memory with guidance", async () => {
    const res = await run(memoryFake({ withMemory: false }), "list_memory");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/provision/i);
  });

  test("list_memory indexes the memory subtree only, with wire-decoded dates", async () => {
    const res = await run(memoryFake(), "list_memory");
    expect(res.ok).toBe(true);
    const pages = res.pages as Array<{ page_id: number; snippet: string; updated?: string }>;
    expect(pages.map((p) => p.page_id).sort()).toEqual([100, 101]); // 200 excluded
    expect(pages.find((p) => p.page_id === 101)!.snippet).toMatch(/old note/);
    // Bare `[micros]` Timestamp decoded into a date, not dropped.
    expect(pages[0].updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("read_memory rejects pages outside the memory subtree", async () => {
    const res = await run(memoryFake(), "read_memory", { page_id: 200 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No memory page/);
  });

  test("search_memory scores title and body matches", async () => {
    const res = await run(memoryFake(), "search_memory", { query: "old note" });
    expect(res.ok).toBe(true);
    const matches = res.matches as Array<{ page_id: number }>;
    expect(matches[0].page_id).toBe(101);
  });

  test("remember rejects empty content", async () => {
    const res = await run(memoryFake(), "remember", { content: "  " });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/content/);
  });

  test("remember requires a title for new pages", async () => {
    const res = await run(memoryFake(), "remember", { content: "a fact" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/title/);
  });

  test("remember errors when memory is unprovisioned", async () => {
    const res = await run(memoryFake({ withMemory: false }), "remember", {
      title: "T",
      content: "a fact",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/provision/i);
  });

  test("remember creates a new memory page under the root and round-trips", async () => {
    const fake = memoryFake();
    const res = await run(fake, "remember", { title: "User prefs", content: "likes tea" });
    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    const created = fake.pages.find((p) => p.title === "User prefs")!;
    expect(created.parentId).toBe(100);
    expect(res.page_id).toBe(created.id);
    const read = await run(fake, "read_memory", { page_id: created.id });
    expect(read.content).toMatch(/likes tea/);
  });

  test("remember appends by default and replaces on demand", async () => {
    const fake = memoryFake();
    const append = await run(fake, "remember", { memory_page_id: 101, content: "new fact" });
    expect(append.ok).toBe(true);
    expect(append.mode).toBe("append");
    let read = await run(fake, "read_memory", { page_id: 101 });
    expect(read.content).toMatch(/old note/);
    expect(read.content).toMatch(/new fact/);

    const replace = await run(fake, "remember", {
      memory_page_id: 101,
      content: "only this",
      mode: "replace",
    });
    expect(replace.ok).toBe(true);
    read = await run(fake, "read_memory", { page_id: 101 });
    expect(read.content).toMatch(/only this/);
    expect(read.content).not.toMatch(/old note/);
  });

  test("remember rejects a page outside the memory subtree", async () => {
    const fake = memoryFake();
    const res = await run(fake, "remember", { memory_page_id: 200, content: "sneaky" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No memory page/);
  });
});

// ── Page tools ─────────────────────────────────────────────────────────────────

describe("pages", () => {
  test("create_page discovers the id via the counter and get_page round-trips", async () => {
    const fake = memoryFake();
    const created = await run(fake, "create_page", {
      parent_id: 0,
      page_type: "Doc",
      title: "Fresh Doc",
    });
    expect(created.ok).toBe(true);
    const pageId = created.page_id as number;

    const wrote = await run(fake, "update_page_content", {
      page_id: pageId,
      markdown: "# Title\n\nBody **bold** text.",
    });
    expect(wrote.ok).toBe(true);
    expect(wrote.snapshot_id).toBeTypeOf("number"); // pre-edit snapshot taken

    const got = await run(fake, "get_page", { page_id: pageId });
    expect(got.ok).toBe(true);
    expect(got.content).toMatch(/# Title/);
    expect(got.content).toMatch(/Body bold text\./);
  });

  test("create_page Database branch reports schema id", async () => {
    const res = await run(memoryFake(), "create_page", {
      parent_id: 0,
      page_type: "Database",
      title: "Tasks",
    });
    expect(res.ok).toBe(true);
    expect(res.schema_id).toBeTypeOf("number");
    expect(res.next_step).toMatch(/add_property/);
  });

  test("update_page_content writes BlockNote for legacy pages", async () => {
    const fake = memoryFake();
    fake.seedPage({ id: 300, title: "Legacy", contentFormat: "BlockNote" });
    const res = await run(fake, "update_page_content", { page_id: 300, markdown: "hello" });
    expect(res.ok).toBe(true);
    expect(fake.pageContent.get(300)).toMatch(/hello/);
  });

  test("get_page returns Page not found for unknown ids", async () => {
    const res = await run(memoryFake(), "get_page", { page_id: 999_999 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Page not found");
  });

  test("list_child_pages and search_pages exclude deleted pages", async () => {
    const fake = memoryFake();
    fake.seedPage({ id: 400, title: "Gone", deletedAtMicros: NOW_MICROS });
    const list = await run(fake, "list_child_pages", { parent_id: 0 });
    const ids = (list.children as Array<{ page_id: number }>).map((c) => c.page_id);
    expect(ids).not.toContain(400);
    const search = await run(fake, "search_pages", { query: "gone" });
    expect(search.results).toEqual([]);
  });

  test("delete_page and move_page happy paths", async () => {
    const fake = memoryFake();
    const move = await run(fake, "move_page", { page_id: 200, new_parent_id: 100 });
    expect(move.ok).toBe(true);
    expect(fake.pages.find((p) => p.id === 200)!.parentId).toBe(100);

    const del = await run(fake, "delete_page", { page_id: 200 });
    expect(del.ok).toBe(true);
    expect(del.note).toMatch(/trash/i);
    expect(fake.pages.find((p) => p.id === 200)!.deletedAtMicros).not.toBeNull();
  });

  test("reducer rejections surface as ok:false with the Err text", async () => {
    const res = await run(memoryFake(), "update_page_title", { page_id: 101, title: "  " });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Title is required/);
    // The transport wrapper prefix is stripped down to the reducer's message.
    expect(res.error).not.toMatch(/SpacetimeDB reducer/);
  });
});

// ── Counter-race fallback ──────────────────────────────────────────────────────

describe("id discovery under concurrency", () => {
  test("writeComponentTreeDoc attributes nodes correctly when a concurrent writer interleaves", async () => {
    const fake = memoryFake();
    fake.interleavePerInsert = 3; // every insert burns 3 foreign ids first
    const res = await run(fake, "update_page_content", {
      page_id: 101,
      markdown: "# H\n\npara one\n\n- item",
    });
    expect(res.ok).toBe(true);
    const createdIds = res.created_node_ids as number[];
    expect(createdIds).toHaveLength(3);
    // Every attributed id must be a real live node of the right page.
    for (const id of createdIds) {
      const node = fake.nodes.find((n) => n.id === id);
      expect(node?.surfaceId).toBe(101);
      expect(node?.deletedAtMicros).toBeNull();
    }
    const read = await run(fake, "read_memory", { page_id: 101 });
    expect(read.content).toMatch(/# H/);
    expect(read.content).toMatch(/para one/);
    expect(read.content).toMatch(/- item/);
  });
});
