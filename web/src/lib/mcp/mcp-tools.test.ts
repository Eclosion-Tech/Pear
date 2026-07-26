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
  props?: string;
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
  /** Block-anchored comment threads. `kind` 0 = ContextThread; `status` 0 = Active, 1 = Closed. */
  conversations: Array<{
    id: number; pageId: number | null; blockAnchor: number | null; kind: number; status: number;
  }> = [];
  convMessages: Array<{ id: number; conversationId: number; content: string }> = [];
  conversationParticipants: Array<{ conversationId: number; identity: string }> = [];
  aiProfiles: Array<{ identity: string; display_name: string }> = [];
  users: Array<{ identity: string; name: string }> = [];
  aiUserConfig: Array<{ id: number }> = [{ id: 7 }];
  aiUserMemory: Array<{ aiUserId: number; rootPageId: number }> = [];
  snapshots: Array<{ id: number; pageId: number }> = [];
  schemas: Array<{ id: number; pageId: number; parentSchemaId?: number | null }> = [];
  /** property_type is the PropertyType variant INDEX (Text=0 … Rollup=11). */
  propDefs: Array<{ id: number; schemaId: number; name: string; type: number; order: number }> =
    [];
  /** value is the wire-shaped PropertyValue sum `[variantIndex, payload]`. */
  propValues: Array<{ pageId: number; propDefId: number; value: [number, unknown] }> = [];
  counters = new Map<string, number>([
    ["page", 1000],
    ["component_node", 2000],
    ["database_schema", 100],
    ["property_definition", 600],
    ["page_snapshot", 10],
    ["conversation", 500],
  ]);
  /** Extra ids to burn per insert_component — simulates a concurrent writer. */
  interleavePerInsert = 0;
  calls: string[] = [];
  /** Every `/sql` query issued — with `calls`, the subrequest count. */
  sqlQueries: string[] = [];

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
      surface_id: n.surfaceId,
      parent_id: this.optNum(n.parentId),
      component_type: n.componentType,
      props: n.props ?? "{}",
      order: n.order,
      deleted_at: this.optTs(n.deletedAtMicros),
    };
  }

  // ── sql router ─────────────────────────────────────────────────────────

  async sql<Row = unknown>(query: string, params: unknown[] = []): Promise<Row[]> {
    const q = query.replace(/\s+/g, " ").trim();
    this.sqlQueries.push(q);

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
      if (params.length === 0) {
        // resolveDatabase fetches the whole (workspace-small) table.
        return this.schemas.map((s) => ({
          id: s.id,
          page_id: s.pageId,
          parent_schema_id: this.optNum(s.parentSchemaId ?? null),
        })) as Row[];
      }
      const pageId = Number(params[0]);
      return this.schemas.filter((s) => s.pageId === pageId) as Row[];
    }
    if (q.includes("FROM property_definition")) {
      const rows = q.includes("WHERE id = ?")
        ? this.propDefs.filter((p) => p.id === Number(params[0]))
        : this.propDefs.filter((p) => new Set(params.map(Number)).has(p.schemaId));
      return rows
        .map((p) => ({
          id: p.id,
          schema_id: p.schemaId,
          name: p.name,
          property_type: [p.type, []],
          order: p.order,
        })) as Row[];
    }
    if (q.includes("FROM page_property_value")) {
      const pageIds = new Set(params.map(Number));
      return this.propValues
        .filter((v) => pageIds.has(v.pageId))
        .map((v) => ({
          page_id: v.pageId,
          property_definition_id: v.propDefId,
          value: v.value,
        })) as Row[];
    }
    if (q.includes("FROM ai_user_profile")) {
      return this.aiProfiles as Row[];
    }
    if (q.includes("FROM user")) {
      return this.users as Row[];
    }
    if (q.includes("FROM conversation_message")) {
      return this.convMessages.map((m) => ({
        id: m.id,
        conversation_id: m.conversationId,
        content: m.content,
      })) as Row[];
    }
    if (q.includes("FROM conversation")) {
      return this.conversations.map((c) => ({
        id: c.id,
        page_id: this.optNum(c.pageId),
        block_anchor: this.optNum(c.blockAnchor),
        status: [c.status, []],
        kind: [c.kind, []],
      })) as Row[];
    }
    if (q.includes("FROM component_node")) {
      // Single-surface (`surface_id = ?`) and bulk OR-chain forms both filter
      // on surface_id — every param is a surface id.
      const surfaceIds = new Set(params.map(Number));
      return this.nodes
        .filter((n) => surfaceIds.has(n.surfaceId))
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
      case "replace_page_doc":
      case "append_page_doc": {
        const [pageId, blocks] = args as [
          number,
          Array<[string, string, { some?: number[]; none?: [] }]>,
        ];
        const page = this.pages.find((p) => p.id === Number(pageId));
        if (!page) fail("Surface page not found");
        if (page!.contentFormat !== "ComponentTree") {
          fail("Page is not in ComponentTree format — component mutations are rejected");
        }
        const root = this.nodes.find(
          (n) =>
            n.surfaceId === Number(pageId) && n.parentId === null && n.deletedAtMicros === null,
        );
        if (!root) fail("No root component node for this page — cannot author content");
        const live = this.nodes
          .filter((n) => n.parentId === root!.id && n.deletedAtMicros === null)
          .sort((a, b) => a.order - b.order);
        let order: number;
        if (reducer === "replace_page_doc") {
          for (const child of live) child.deletedAtMicros = NOW_MICROS;
          order = 1000;
        } else {
          order = (live.at(-1)?.order ?? 0) + 1000;
        }
        for (const [componentType, props, yjsOpt] of blocks) {
          // Simulated concurrent writer: burn ids before ours.
          for (let i = 0; i < this.interleavePerInsert; i++) this.alloc("component_node");
          const id = this.alloc("component_node");
          this.nodes.push({
            id,
            surfaceId: Number(pageId),
            parentId: root!.id,
            componentType,
            props,
            order,
            deletedAtMicros: null,
          });
          order += 1000;
          if (yjsOpt.some !== undefined) {
            this.yjs.set(id, toHex(new Uint8Array(yjsOpt.some)));
          }
        }
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
      case "create_conversation": {
        const [pageOpt, identities, anchorOpt] = args as [
          { some?: number } | unknown[],
          string[],
          { some?: number } | unknown[],
        ];
        const unwrap = (v: unknown): number | null => {
          if (v && typeof v === "object" && "some" in (v as Record<string, unknown>)) {
            return Number((v as { some: number }).some);
          }
          return null;
        };
        const pid = unwrap(pageOpt);
        if (pid !== null && !this.pages.some((p) => p.id === pid)) fail("Page not found");
        const id = this.alloc("conversation");
        this.conversations.push({
          id,
          pageId: pid,
          blockAnchor: unwrap(anchorOpt),
          kind: 0,
          status: 0,
        });
        this.conversationParticipants.push(...(identities ?? []).map((i) => ({ conversationId: id, identity: String(i) })));
        return;
      }
      case "send_addressed_message": {
        const [conversationId, content] = args as [number, string];
        const conv = this.conversations.find((c) => c.id === Number(conversationId));
        if (!conv) fail("Conversation not found");
        if (conv!.status !== 0) fail("Conversation is closed");
        this.convMessages.push({
          id: this.convMessages.length + 1,
          conversationId: Number(conversationId),
          content: String(content),
        });
        return;
      }
      case "close_conversation": {
        const [conversationId] = args as [number];
        const conv = this.conversations.find((c) => c.id === Number(conversationId));
        if (!conv) fail("Conversation not found");
        conv!.status = 1;
        return;
      }
      case "reopen_conversation": {
        const [conversationId] = args as [number];
        const conv = this.conversations.find((c) => c.id === Number(conversationId));
        if (!conv) fail("Conversation not found");
        conv!.status = 0;
        return;
      }
      case "update_component_props": {
        const [componentId, propsJson] = args as [number, string];
        const node = this.nodes.find(
          (n) => n.id === Number(componentId) && n.deletedAtMicros == null,
        );
        if (!node) fail("Component not found");
        node!.props = String(propsJson);
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
      case "delete_page_subtree": {
        // Mirrors the module reducer: soft-deletes the page and every
        // active descendant.
        const rootId = Number(args[0]);
        const root = this.pages.find((p) => p.id === rootId);
        if (!root) fail("Page not found");
        const queue = [rootId];
        while (queue.length > 0) {
          const id = queue.pop()!;
          for (const child of this.pages.filter(
            (p) => p.parentId === id && p.deletedAtMicros == null,
          )) {
            queue.push(child.id);
          }
          const page = this.pages.find((p) => p.id === id);
          if (page && page.deletedAtMicros == null) page.deletedAtMicros = NOW_MICROS;
        }
        return;
      }
      case "restore_page": {
        const page = this.pages.find((p) => p.id === Number(args[0]));
        if (!page) fail("Page not found");
        if (page!.deletedAtMicros === null) fail("Page is not deleted");
        page!.deletedAtMicros = null;
        return;
      }
      case "set_property_value": {
        const [pageId, propDefId, wire] = args as [number, number, Record<string, unknown>];
        if (!this.pages.find((p) => p.id === Number(pageId))) fail("Page not found");
        if (!this.propDefs.find((d) => d.id === Number(propDefId))) {
          fail("PropertyDefinition not found");
        }
        // Client sends `{variantName: payload}` (lowerCamel); store as the
        // read-side positional sum so query_database exercises the decoder.
        const VARIANTS = ["text", "number", "date", "select", "multiSelect", "relation", "checkbox", "url", "person", "ai"];
        const [name, payload] = Object.entries(wire)[0] ?? [];
        const idx = VARIANTS.indexOf(String(name));
        if (idx < 0) fail(`Unknown PropertyValue variant: ${name}`);
        const existing = this.propValues.find(
          (v) => v.pageId === Number(pageId) && v.propDefId === Number(propDefId),
        );
        if (existing) existing.value = [idx, payload];
        else this.propValues.push({ pageId: Number(pageId), propDefId: Number(propDefId), value: [idx, payload] });
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
      case "add_property": {
        const [schemaId, name, propertyType] = args as [
          number,
          string,
          Record<string, []>,
          string,
        ];
        if (!this.schemas.some((schema) => schema.id === Number(schemaId))) {
          fail("Schema not found");
        }
        if (
          this.propDefs.some(
            (prop) => prop.schemaId === Number(schemaId) && prop.name === String(name),
          )
        ) {
          fail(`Property "${name}" already exists`);
        }
        const variants = [
          "text",
          "number",
          "date",
          "select",
          "multiSelect",
          "relation",
          "checkbox",
          "url",
          "person",
        ];
        const type = variants.indexOf(Object.keys(propertyType)[0]);
        if (type < 0) fail("Unknown PropertyType variant");
        const id = this.alloc("property_definition");
        const order =
          Math.max(
            0,
            ...this.propDefs
              .filter((prop) => prop.schemaId === Number(schemaId))
              .map((prop) => prop.order),
          ) + 1;
        this.propDefs.push({ id, schemaId: Number(schemaId), name: String(name), type, order });
        return;
      }
      case "delete_property": {
        const propertyDefinitionId = Number(args[0]);
        const index = this.propDefs.findIndex((prop) => prop.id === propertyDefinitionId);
        if (index < 0) fail("PropertyDefinition not found");
        this.propDefs.splice(index, 1);
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

// ── Page theme (style_v1 S5) ───────────────────────────────────────────────────

describe("set_page_theme", () => {
  /** The root container's stored props, as the renderer would read them. */
  function rootProps(fake: FakeStdb, pageId: number): Record<string, unknown> {
    const root = fake.nodes.find((n) => n.surfaceId === pageId && n.parentId === null);
    return JSON.parse(root?.props ?? "{}") as Record<string, unknown>;
  }

  test("writes a valid theme onto the page's root container", async () => {
    const fake = new FakeStdb();
    fake.seedPage({ id: 900, title: "Themed" });
    fake.seedTree(900, "");
    const pageId = 900;
    const res = await run(fake, "set_page_theme", {
      page_id: pageId,
      theme: { v: 1, background: { kind: "gradient", gradient: "dusk" }, accent: "purple" },
    });

    expect(res.ok).toBe(true);
    expect(rootProps(fake, pageId).theme).toEqual({
      v: 1,
      background: { kind: "gradient", gradient: "dusk" },
      accent: "purple",
    });
  });

  test("merges rather than replacing — layout and style survive", async () => {
    const fake = new FakeStdb();
    fake.seedPage({ id: 900, title: "Themed" });
    fake.seedTree(900, "");
    const pageId = 900;
    const root = fake.nodes.find((n) => n.surfaceId === pageId && n.parentId === null)!;
    root.props = JSON.stringify({ layout: "stack", style: { gap: "sm" } });

    await run(fake, "set_page_theme", { page_id: pageId, theme: { v: 1, font: "serif" } });

    const props = rootProps(fake, pageId);
    expect(props.layout).toBe("stack");
    expect(props.style).toEqual({ gap: "sm" });
    expect(props.theme).toEqual({ v: 1, font: "serif" });
  });

  test("refuses arbitrary CSS and never stores it", async () => {
    const fake = new FakeStdb();
    fake.seedPage({ id: 900, title: "Themed" });
    fake.seedTree(900, "");
    const pageId = 900;

    const res = await run(fake, "set_page_theme", {
      page_id: pageId,
      theme: { v: 1, accent: "#ff00ff", font: "Comic Sans MS" },
    });

    // `accent`/`font` are dropped by the allowlist, leaving a valid empty theme.
    expect(res.ok).toBe(true);
    expect(rootProps(fake, pageId).theme).toEqual({ v: 1 });
  });

  test("rejects a theme missing its version, with a usable error", async () => {
    const fake = new FakeStdb();
    fake.seedPage({ id: 900, title: "Themed" });
    fake.seedTree(900, "");
    const pageId = 900;
    const res = await run(fake, "set_page_theme", {
      page_id: pageId,
      theme: { accent: "blue" },
    });

    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/v: 1/);
    expect(rootProps(fake, pageId).theme).toBeUndefined();
  });

  test("refuses a URL as a background storage key", async () => {
    const fake = new FakeStdb();
    fake.seedPage({ id: 900, title: "Themed" });
    fake.seedTree(900, "");
    const pageId = 900;
    await run(fake, "set_page_theme", {
      page_id: pageId,
      theme: {
        v: 1,
        background: { kind: "image", storageKey: "https://evil.example/x.png" },
      },
    });
    expect(rootProps(fake, pageId).theme).toEqual({ v: 1 });
  });

  test("null clears the theme without disturbing other props", async () => {
    const fake = new FakeStdb();
    fake.seedPage({ id: 900, title: "Themed" });
    fake.seedTree(900, "");
    const pageId = 900;
    const root = fake.nodes.find((n) => n.surfaceId === pageId && n.parentId === null)!;
    root.props = JSON.stringify({ layout: "stack" });

    await run(fake, "set_page_theme", { page_id: pageId, theme: { v: 1, font: "mono" } });
    await run(fake, "set_page_theme", { page_id: pageId, theme: null });

    const props = rootProps(fake, pageId);
    expect(props.theme).toBeUndefined();
    expect(props.layout).toBe("stack");
  });

  test("round-trips through get_page_theme", async () => {
    const fake = new FakeStdb();
    fake.seedPage({ id: 900, title: "Themed" });
    fake.seedTree(900, "");
    const pageId = 900;
    await run(fake, "set_page_theme", {
      page_id: pageId,
      theme: { v: 1, density: "comfortable", radius: "lg" },
    });
    const res = await run(fake, "get_page_theme", { page_id: pageId });
    expect(res.theme).toEqual({ v: 1, density: "comfortable", radius: "lg" });
  });

  test("reports a missing page rather than writing anywhere", async () => {
    const fake = new FakeStdb();
    const res = await run(fake, "set_page_theme", { page_id: 999999, theme: { v: 1 } });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/not found/i);
  });
});


// ── Comment threads (ticket 14264) ────────────────────────────────────────────

describe("comment threads", () => {
  function seedThreads(fake: FakeStdb) {
    fake.seedPage({ id: 900, title: "Doc with comments" });
    fake.seedTree(900, "");
    fake.conversations.push(
      { id: 1, pageId: 900, blockAnchor: 2001, kind: 0, status: 0 },
      { id: 2, pageId: 900, blockAnchor: 2002, kind: 0, status: 1 }, // resolved
      { id: 3, pageId: 900, blockAnchor: null, kind: 0, status: 0 }, // sidebar chat
      { id: 4, pageId: 999, blockAnchor: 2003, kind: 0, status: 0 }, // other page
    );
    fake.convMessages.push(
      { id: 1, conversationId: 1, content: "first" },
      { id: 2, conversationId: 1, content: "latest here" },
    );
    return 900;
  }

  test("lists only block-anchored threads on the page, active by default", async () => {
    const fake = new FakeStdb();
    const pageId = seedThreads(fake);
    const res = await run(fake, "list_page_threads", { page_id: pageId });
    const ids = (res.threads as Array<{ conversation_id: number }>).map((t) => t.conversation_id);
    // 2 is resolved, 3 has no anchor (sidebar), 4 is another page.
    expect(ids).toEqual([1]);
  });

  test("include_resolved surfaces resolved threads", async () => {
    const fake = new FakeStdb();
    const pageId = seedThreads(fake);
    const res = await run(fake, "list_page_threads", { page_id: pageId, include_resolved: true });
    const threads = res.threads as Array<{ conversation_id: number; status: string }>;
    expect(threads.map((t) => t.conversation_id).sort()).toEqual([1, 2]);
    expect(threads.find((t) => t.conversation_id === 2)!.status).toBe("resolved");
  });

  test("reports message count and a preview of the newest message", async () => {
    const fake = new FakeStdb();
    const pageId = seedThreads(fake);
    const res = await run(fake, "list_page_threads", { page_id: pageId });
    const t = (res.threads as Array<Record<string, unknown>>)[0];
    expect(t.message_count).toBe(2);
    expect(t.last_message_preview).toBe("latest here");
  });

  test("post_to_thread appends a message", async () => {
    const fake = new FakeStdb();
    seedThreads(fake);
    const res = await run(fake, "post_to_thread", {
      conversation_id: 1,
      content: "@Kira can you check this?",
    });
    expect(res.ok).toBe(true);
    expect(fake.convMessages.at(-1)!.content).toBe("@Kira can you check this?");
  });

  test("post_to_thread rejects empty content without calling a reducer", async () => {
    const fake = new FakeStdb();
    seedThreads(fake);
    const before = fake.calls.length;
    const res = await run(fake, "post_to_thread", { conversation_id: 1, content: "   " });
    expect(res.ok).toBe(false);
    expect(fake.calls.length).toBe(before);
  });

  test("resolve then reopen round-trips, and a resolved thread rejects posts", async () => {
    const fake = new FakeStdb();
    seedThreads(fake);

    expect((await run(fake, "resolve_thread", { conversation_id: 1 })).ok).toBe(true);
    // Resolving is a real brake: the module refuses new messages.
    const blocked = await run(fake, "post_to_thread", { conversation_id: 1, content: "more" });
    expect(blocked.ok).toBe(false);
    expect(String(blocked.error)).toMatch(/closed/i);

    expect((await run(fake, "reopen_thread", { conversation_id: 1 })).ok).toBe(true);
    expect((await run(fake, "post_to_thread", { conversation_id: 1, content: "more" })).ok).toBe(true);
  });


  test("create_thread anchors a new thread and posts the opening message", async () => {
    const fake = new FakeStdb();
    seedThreads(fake);
    fake.aiProfiles.push({ identity: "0xkira", display_name: "Kira" });
    fake.users.push({ identity: "0xkara", name: "Kara Raynoha" });

    const res = await run(fake, "create_thread", {
      page_id: 900,
      block_id: 2001,
      content: "@Kira does this section still hold?",
      participants: ["Kira", "Kara Raynoha"],
    });

    expect(res.ok).toBe(true);
    const cid = res.conversation_id as number;
    const conv = fake.conversations.find((c) => c.id === cid)!;
    expect(conv.pageId).toBe(900);
    expect(conv.blockAnchor).toBe(2001);
    // Both an AI teammate and a person were seeded — tagging a person is how
    // they find out something needs them.
    const seeded = fake.conversationParticipants
      .filter((p) => p.conversationId === cid)
      .map((p) => p.identity)
      .sort();
    expect(seeded).toEqual(["0xkara", "0xkira"]);
    expect(fake.convMessages.at(-1)!.content).toContain("@Kira");
  });

  test("create_thread rejects an unknown participant rather than silently dropping them", async () => {
    const fake = new FakeStdb();
    seedThreads(fake);
    fake.aiProfiles.push({ identity: "0xkira", display_name: "Kira" });
    const before = fake.conversations.length;

    const res = await run(fake, "create_thread", {
      page_id: 900,
      block_id: 2001,
      participants: ["Nobody"],
    });

    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/Unknown participant/i);
    // Nothing was created — a half-made thread would be worse than a clear failure.
    expect(fake.conversations.length).toBe(before);
  });

  test("create_thread reports a missing page", async () => {
    const fake = new FakeStdb();
    seedThreads(fake);
    const res = await run(fake, "create_thread", { page_id: 424242, block_id: 1 });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/not found/i);
  });

  test("reducer rejections surface as ok:false", async () => {
    const fake = new FakeStdb();
    seedThreads(fake);
    const res = await run(fake, "resolve_thread", { conversation_id: 99999 });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/not found/i);
  });
});

// ── Registry shape ─────────────────────────────────────────────────────────────

describe("registry", () => {
  test("exposes exactly the v1 tool surface", () => {
    expect([...tools.keys()].sort()).toEqual([
      "add_property",
      "create_page",
      "create_thread",
      "delete_page",
      "delete_property",
      "get_page",
      "get_page_theme",
      "get_schema_id",
      "list_child_pages",
      "list_memory",
      "list_page_threads",
      "list_properties",
      "move_page",
      "post_to_thread",
      "query_database",
      "read_memory",
      "remember",
      "reopen_thread",
      "resolve_thread",
      "restore_page",
      "search_memory",
      "search_pages",
      "set_page_theme",
      "set_row_properties",
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

  test("get_schema_id and add_property complete the Database creation flow (#379)", async () => {
    const fake = memoryFake();
    const created = await run(fake, "create_page", {
      parent_id: 0,
      page_type: "Database",
      title: "Launch Plan",
    });
    const schemaId = created.schema_id as number;

    const schema = await run(fake, "get_schema_id", { page_id: created.page_id });
    expect(schema).toEqual({ ok: true, schema_id: schemaId });

    const added = await run(fake, "add_property", {
      schema_id: schemaId,
      name: "Status",
      property_type: "Select",
      config: '{"options":["To Do","Done"]}',
    });
    expect(added).toMatchObject({
      ok: true,
      property_id: 601,
      name: "Status",
      property_type: "Select",
    });
    expect(fake.calls).toContain("add_property");
    expect(fake.propDefs.find((prop) => prop.id === 601)).toMatchObject({
      schemaId,
      name: "Status",
      type: 3,
    });
  });

  test("add_property validates config and reports reducer errors (#379)", async () => {
    const fake = tasksFake();
    const badConfig = await run(fake, "add_property", {
      schema_id: 50,
      name: "Priority",
      property_type: "Select",
      config: "not-json",
    });
    expect(badConfig).toEqual({ ok: false, error: "config must be a valid JSON string" });

    const duplicate = await run(fake, "add_property", {
      schema_id: 50,
      name: "Status",
      property_type: "Select",
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toMatch(/already exists/);
  });

  test("delete_property removes one confirmed schema column (#70)", async () => {
    const fake = tasksFake();
    const listed = await run(fake, "list_properties", { schema_id: 50 });
    expect(listed.ok).toBe(true);
    expect(listed.properties).toEqual([
      {
        property_definition_id: 501,
        name: "Status",
        property_type: "Select",
        config: "{}",
        order: 1000,
      },
      {
        property_definition_id: 502,
        name: "Project",
        property_type: "Relation",
        config: "{}",
        order: 2000,
      },
      {
        property_definition_id: 503,
        name: "Due",
        property_type: "Date",
        config: "{}",
        order: 3000,
      },
    ]);
    const deleted = await run(fake, "delete_property", {
      property_definition_id: 503,
    });
    expect(deleted).toEqual({
      ok: true,
      property_definition_id: 503,
      name: "Due",
    });
    expect(fake.propDefs.some((prop) => prop.id === 503)).toBe(false);

    const missing = await run(fake, "delete_property", {
      property_definition_id: 999,
    });
    expect(missing).toEqual({ ok: false, error: "Property definition not found" });
  });

  test("update_page_content writes BlockNote for legacy pages", async () => {
    const fake = memoryFake();
    fake.seedPage({ id: 300, title: "Legacy", contentFormat: "BlockNote" });
    const res = await run(fake, "update_page_content", { page_id: 300, markdown: "hello" });
    expect(res.ok).toBe(true);
    expect(fake.pageContent.get(300)).toMatch(/hello/);
  });

  test("ComponentTree table writes read back as GFM instead of raw pipes (#197)", async () => {
    const fake = memoryFake();
    const markdown = "| Name | Status |\n| --- | :---: |\n| Pear | Ready |";
    const wrote = await run(fake, "update_page_content", {
      page_id: 101,
      markdown,
    });
    expect(wrote.ok).toBe(true);

    const read = await run(fake, "get_page", { page_id: 101 });
    expect(read.content).toBe(markdown);
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

// ── Database tools (#213/#215/#263) ────────────────────────────────────────────

/** Seed a Tasks-like database: Status (Select), Project (Relation), Due (Date). */
function tasksFake(): FakeStdb {
  const fake = memoryFake();
  fake.seedPage({ id: 800, title: "Tasks", pageType: "Database", contentFormat: "BlockNote" });
  fake.schemas.push({ id: 50, pageId: 800 });
  fake.propDefs.push(
    { id: 501, schemaId: 50, name: "Status", type: 3, order: 1000 }, // Select
    { id: 502, schemaId: 50, name: "Project", type: 5, order: 2000 }, // Relation
    { id: 503, schemaId: 50, name: "Due", type: 2, order: 3000 }, // Date
  );
  for (let i = 0; i < 3; i++) {
    fake.seedPage({ id: 810 + i, title: `Task ${i}`, parentId: 800 });
  }
  fake.propValues.push(
    { pageId: 810, propDefId: 501, value: [3, "Done"] },
    { pageId: 811, propDefId: 501, value: [3, "In Progress"] },
    { pageId: 811, propDefId: 502, value: [5, [68]] },
  );
  return fake;
}

describe("database tools", () => {
  test("query_database returns columns and decoded rows", async () => {
    const res = await run(tasksFake(), "query_database", { page_id: 800 });
    expect(res.ok).toBe(true);
    expect(res.columns).toEqual([
      { name: "Status", type: "Select" },
      { name: "Project", type: "Relation" },
      { name: "Due", type: "Date" },
    ]);
    const rows = res.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ page_id: 810, title: "Task 0", Status: "Done" });
    expect(rows[1].Project).toEqual([68]);
    expect(rows[2].Status).toBeNull();
    expect(res.truncated).toBe(false);
  });

  test("query_database rejects non-Database pages and unknown filter columns", async () => {
    const fake = tasksFake();
    const notDb = await run(fake, "query_database", { page_id: 200 });
    expect(notDb.ok).toBe(false);
    expect(notDb.error).toMatch(/not a Database/);
    const badCol = await run(fake, "query_database", {
      page_id: 800,
      property_filter: { property: "Nope" },
    });
    expect(badCol.ok).toBe(false);
    expect(badCol.error).toMatch(/Known columns: title, Status, Project, Due/);
  });

  test("query_database filters and paginates with explicit next_offset (#263)", async () => {
    const fake = tasksFake();
    const filtered = await run(fake, "query_database", {
      page_id: 800,
      property_filter: { property: "Status", equals: "done" },
    });
    expect((filtered.rows as unknown[]).length).toBe(1);

    const page1 = await run(fake, "query_database", { page_id: 800, limit: 2 });
    expect(page1.returned_rows).toBe(2);
    expect(page1.truncated).toBe(true);
    expect(page1.next_offset).toBe(2);
    const page2 = await run(fake, "query_database", { page_id: 800, offset: 2 });
    expect((page2.rows as Array<{ page_id: number }>)[0].page_id).toBe(812);
    expect(page2.truncated).toBe(false);
  });

  test("set_row_properties coerces by column type and round-trips (#215)", async () => {
    const fake = tasksFake();
    const res = await run(fake, "set_row_properties", {
      page_id: 812,
      properties: { Status: "To Do", Project: [68], Due: "2026-07-15" },
    });
    expect(res.ok).toBe(true);
    expect(res.applied).toEqual(["Status", "Project", "Due"]);

    const read = await run(fake, "query_database", {
      page_id: 800,
      property_filter: { property: "Status", equals: "To Do" },
    });
    const row = (read.rows as Array<Record<string, unknown>>)[0];
    expect(row.page_id).toBe(812);
    expect(row.Project).toEqual([68]);
    expect(row.Due).toMatch(/^2026-07-15T/);
  });

  test("set_row_properties rejects unknown columns and bad values with what landed", async () => {
    const fake = tasksFake();
    const unknown = await run(fake, "set_row_properties", {
      page_id: 812,
      properties: { Nope: 1 },
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/Unknown column "Nope"/);

    const bad = await run(fake, "set_row_properties", {
      page_id: 812,
      properties: { Status: "Blocked", Due: "not-a-date" },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Due.*Date/);
    expect(bad.applied).toEqual(["Status"]); // partial progress reported
  });

  test("create_page into a Database applies properties in the same call", async () => {
    const fake = tasksFake();
    const res = await run(fake, "create_page", {
      parent_id: 800,
      page_type: "Doc",
      title: "Filed by agent",
      properties: { Status: "To Do", Project: [68] },
    });
    expect(res.ok).toBe(true);
    expect(res.properties_applied).toEqual(["Status", "Project"]);
    expect(res.properties_error).toBeUndefined();

    const read = await run(fake, "query_database", {
      page_id: 800,
      property_filter: { property: "title", contains: "filed by agent" },
    });
    const row = (read.rows as Array<Record<string, unknown>>)[0];
    expect(row.Status).toBe("To Do");
    expect(row.Project).toEqual([68]);
  });

  test("restore_page undoes delete_page (#213 gap 1)", async () => {
    const fake = tasksFake();
    await run(fake, "delete_page", { page_id: 812 });
    expect(fake.pages.find((p) => p.id === 812)!.deletedAtMicros).not.toBeNull();
    const res = await run(fake, "restore_page", { page_id: 812 });
    expect(res.ok).toBe(true);
    expect(fake.pages.find((p) => p.id === 812)!.deletedAtMicros).toBeNull();
  });
});

// ── Subrequest-cost regressions (#242 acceptance) ──────────────────────────────

describe("subrequest cost stays flat", () => {
  test("a 30-block page write is one reducer call, not one per block", async () => {
    const fake = memoryFake();
    const markdown = Array.from({ length: 30 }, (_, i) => `Paragraph number ${i + 1}.`).join(
      "\n\n",
    );
    const opsBefore = fake.calls.length + fake.sqlQueries.length;
    const res = await run(fake, "update_page_content", { page_id: 101, markdown });
    expect(res.ok).toBe(true);
    expect((res.created_node_ids as number[]).length).toBe(30);

    expect(fake.calls.filter((c) => c === "replace_page_doc")).toHaveLength(1);
    expect(fake.calls).not.toContain("insert_component");
    expect(fake.calls).not.toContain("save_component_yjs_state");
    expect(fake.calls).not.toContain("delete_component");
    // Whole write (incl. pre-edit snapshot + id readback) in a handful of
    // subrequests — the O(n)-in-blocks pattern is the #210/#242 regression.
    expect(fake.calls.length + fake.sqlQueries.length - opsBefore).toBeLessThanOrEqual(8);

    const read = await run(fake, "read_memory", { page_id: 101 });
    expect(read.content).toMatch(/Paragraph number 1\./);
    expect(read.content).toMatch(/Paragraph number 30\./);
  });

  test("remember append is one reducer call and never rewrites existing nodes", async () => {
    const fake = memoryFake();
    const res = await run(fake, "remember", {
      memory_page_id: 101,
      content: "one\n\ntwo\n\nthree\n\nfour\n\nfive\n\nsix",
    });
    expect(res.ok).toBe(true);
    expect(fake.calls.filter((c) => c === "append_page_doc")).toHaveLength(1);
    expect(fake.calls).not.toContain("replace_page_doc");
    expect(fake.calls).not.toContain("delete_component");
    const read = await run(fake, "read_memory", { page_id: 101 });
    expect(read.content).toMatch(/old note/);
    expect(read.content).toMatch(/six/);
  });

  test("list_memory and search_memory cost stays flat on a 50-page subtree (#241)", async () => {
    const fake = memoryFake();
    for (let i = 0; i < 50; i++) {
      const page = fake.seedPage({
        id: 500 + i,
        title: `Note ${i}`,
        parentId: 100,
        contentFormat: "ComponentTree",
      });
      fake.seedTree(page.id, `body of note ${i}`);
    }
    fake.sqlQueries = [];
    const list = await run(fake, "list_memory");
    expect(list.ok).toBe(true);
    expect((list.pages as unknown[]).length).toBe(52); // root + Notes + 50
    // Old shape: 2+ queries per page (>100 here) — the #241 killer.
    expect(fake.sqlQueries.length).toBeLessThanOrEqual(12);

    fake.sqlQueries = [];
    const search = await run(fake, "search_memory", { query: "note 42" });
    expect(search.ok).toBe(true);
    expect(fake.sqlQueries.length).toBeLessThanOrEqual(12);
  });
});

// ── get_page windowing (#211) ──────────────────────────────────────────────────

describe("get_page windowing", () => {
  test("long pages window with explicit truncation metadata instead of a silent clip", async () => {
    const fake = memoryFake();
    fake.seedPage({ id: 600, title: "Long legacy", contentFormat: "BlockNote" });
    fake.pageContent.set(600, "x".repeat(45_000));

    const first = await run(fake, "get_page", { page_id: 600 });
    expect(first.ok).toBe(true);
    expect((first.content as string).length).toBe(20_000);
    expect(first.total_chars).toBe(45_000);
    expect(first.truncated).toBe(true);
    expect(first.next_offset).toBe(20_000);

    const last = await run(fake, "get_page", { page_id: 600, offset: 40_000 });
    expect((last.content as string).length).toBe(5_000);
    expect(last.truncated).toBe(false);
    expect(last.next_offset).toBeUndefined();
  });

  test("short pages return complete content with truncated:false", async () => {
    const res = await run(memoryFake(), "get_page", { page_id: 101 });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(false);
    expect(res.content).toMatch(/old note/);
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
