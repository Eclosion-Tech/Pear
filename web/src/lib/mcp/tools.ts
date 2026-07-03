/**
 * The Pear MCP tool surface: 12 stateless tools over `/sql` + `/call`.
 *
 * Descriptions and input schemas are carried over verbatim from the worker's
 * tool catalog (worker/src/tools.ts) with the MCP-specific overrides that the
 * WS-era registry applied (external clients have no memory index in a system
 * prompt). Output shapes match the WS implementation exactly so existing
 * clients see no difference.
 *
 * No client-side write-permission precheck exists here by design: the
 * `require_page_write` guard inside every mutating reducer is authoritative,
 * and its rejection surfaces synchronously as the tool error.
 */

import type { McpContext, McpToolEntry } from "./types";
import { getPageRow, listChildren, allLivePages, getPageContent } from "./pages";
import { readComponentTreeDoc } from "./component-tree";
import { createPage } from "./create-page";
import { writePageContent } from "./write-content";
import {
  executeListMemory,
  executeReadMemory,
  executeRemember,
  executeSearchMemory,
} from "./memory";
import { encodeOption, encodeU64 } from "./encode";
import { reducerErrorMessage } from "./errors";

// ── Page tools ────────────────────────────────────────────────────────────────

const createPageTool: McpToolEntry = {
  name: "create_page",
  description:
    "Create a new Pear page as a child of an existing page. " +
    "Use page_type 'Database' for structured data with columns, 'Doc' for rich text.",
  inputSchema: {
    type: "object",
    properties: {
      parent_id: {
        type: "number",
        description:
          "Parent page ID. Use 0 to create at the workspace root, or the current page's ID to nest under it.",
      },
      page_type: { type: "string", enum: ["Doc", "Database"] },
      title: { type: "string" },
    },
    required: ["parent_id", "page_type", "title"],
  },
  execute: async (ctx, input) => {
    const result = await createPage(ctx.transport, {
      parentId: Number(input.parent_id ?? 0),
      pageType: input.page_type === "Database" ? "Database" : "Doc",
      title: String(input.title ?? ""),
    });
    return JSON.stringify(result);
  },
};

const getPageTool: McpToolEntry = {
  name: "get_page",
  description:
    "Get details about a specific page by ID, including its title, type, parent, and content.",
  inputSchema: {
    type: "object",
    properties: { page_id: { type: "number" } },
    required: ["page_id"],
  },
  execute: async (ctx, input) => {
    const pageId = Number(input.page_id);
    const page = await getPageRow(ctx.transport, pageId);
    if (!page) return JSON.stringify({ ok: false, error: "Page not found" });

    // ComponentTree pages keep no `page_content` blob — their text lives in
    // ComponentNode rows + per-node Yjs state. Reconstruct from there; fall
    // back to the legacy blob for BlockNote/Database pages.
    const treeContent = await readComponentTreeDoc(ctx.transport, pageId);
    const content =
      treeContent !== undefined ? treeContent : await getPageContent(ctx.transport, pageId);

    return JSON.stringify({
      ok: true,
      page_id: page.id,
      title: page.title,
      page_type: page.pageType,
      parent_id: page.parentId,
      content: content.slice(0, 5000),
      next_step:
        page.pageType === "Database"
          ? "This is a Database page; its rows are NOT in `content`. Call query_database(page_id) to read its columns and rows."
          : undefined,
    });
  },
};

const updatePageContentTool: McpToolEntry = {
  name: "update_page_content",
  description:
    "Write or replace the text content of a Doc page. " +
    "Pass markdown — headings (#/##/###), bullet lists (- item), numbered lists (1. item), " +
    "and plain paragraphs are all supported. The worker converts markdown to BlockNote format automatically.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "number" },
      markdown: { type: "string", description: "Markdown text to write into the page." },
    },
    required: ["page_id", "markdown"],
  },
  execute: async (ctx, input) => {
    const pageId = Number(input.page_id);
    const page = await getPageRow(ctx.transport, pageId);
    if (!page) return JSON.stringify({ ok: false, error: "Page not found" });
    const markdown = String(input.markdown ?? input.content ?? "");
    const result = await writePageContent(ctx.transport, page, markdown, { snapshot: true });
    return JSON.stringify(result);
  },
};

const updatePageTitleTool: McpToolEntry = {
  name: "update_page_title",
  description: "Rename an existing page.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "number" },
      title: { type: "string" },
    },
    required: ["page_id", "title"],
  },
  execute: async (ctx, input) => {
    const pageId = Number(input.page_id);
    const title = String(input.title ?? "");
    try {
      await ctx.transport.call("update_page_title", [encodeU64(pageId), title]);
    } catch (err) {
      return JSON.stringify({ ok: false, error: reducerErrorMessage(err) });
    }
    return JSON.stringify({ ok: true, page_id: pageId, title });
  },
};

const listChildPagesTool: McpToolEntry = {
  name: "list_child_pages",
  description:
    "List all child pages of a given parent page. " +
    "Returns each child's id, title, page_type, and sort_order. " +
    "Use parent_id=0 to list root-level pages.",
  inputSchema: {
    type: "object",
    properties: {
      parent_id: {
        type: "number",
        description: "Parent page ID. Use 0 to list root-level pages.",
      },
    },
    required: ["parent_id"],
  },
  execute: async (ctx, input) => {
    const rawParentId = Number(input.parent_id ?? 0);
    const children = await listChildren(ctx.transport, rawParentId > 0 ? rawParentId : 0);
    return JSON.stringify({
      ok: true,
      parent_id: rawParentId,
      children: children.map((p) => ({
        page_id: p.id,
        title: p.title,
        page_type: p.pageType,
        sort_order: p.sortOrder,
      })),
    });
  },
};

const searchPagesTool: McpToolEntry = {
  name: "search_pages",
  description:
    "Search the workspace for pages by title (case-insensitive substring match). " +
    "Returns matching pages with their id, title, page_type, and parent_id. " +
    "Use this to find existing pages before creating new ones or to look up page IDs.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search term to match against page titles." },
    },
    required: ["query"],
  },
  execute: async (ctx, input) => {
    const query = String(input.query ?? "").toLowerCase();
    const pages = await allLivePages(ctx.transport);
    const results = pages
      .filter((p) => p.title.toLowerCase().includes(query))
      .slice(0, 20)
      .map((p) => ({
        page_id: p.id,
        title: p.title,
        page_type: p.pageType,
        parent_id: p.parentId,
      }));
    return JSON.stringify({ ok: true, results });
  },
};

const deletePageTool: McpToolEntry = {
  name: "delete_page",
  description:
    "Move a page to the trash (soft delete — reversible with restore_page). The page and its " +
    "children stop appearing in the workspace but are not permanently erased. Use only when the user " +
    "clearly asked to delete/remove a page; confirm the target id first.",
  inputSchema: {
    type: "object",
    properties: { page_id: { type: "number", description: "The page to trash." } },
    required: ["page_id"],
  },
  execute: async (ctx, input) => {
    const pageId = Number(input.page_id);
    const page = await getPageRow(ctx.transport, pageId);
    if (!page) return JSON.stringify({ ok: false, error: "Page not found" });
    try {
      await ctx.transport.call("delete_page", [encodeU64(pageId)]);
    } catch (err) {
      return JSON.stringify({ ok: false, page_id: pageId, error: reducerErrorMessage(err) });
    }
    return JSON.stringify({
      ok: true,
      page_id: pageId,
      title: page.title,
      note: "Moved to trash. Reversible with restore_page.",
    });
  },
};

const movePageTool: McpToolEntry = {
  name: "move_page",
  description:
    "Move a page to a new parent (re-parent it in the workspace tree). Pass new_parent_id = 0 (or " +
    "omit it) to move the page to the workspace root. Requires write access on both the page and the " +
    "destination parent.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "number", description: "The page to move." },
      new_parent_id: {
        type: "number",
        description: "Destination parent page id; 0 or omitted = workspace root.",
      },
    },
    required: ["page_id"],
  },
  execute: async (ctx, input) => {
    const pageId = Number(input.page_id);
    const rawParent = Number(input.new_parent_id ?? 0);
    const newParentId = Number.isFinite(rawParent) && rawParent > 0 ? rawParent : undefined;
    const page = await getPageRow(ctx.transport, pageId);
    if (!page) return JSON.stringify({ ok: false, error: "Page not found" });
    try {
      await ctx.transport.call("move_page", [
        encodeU64(pageId),
        encodeOption(newParentId !== undefined ? encodeU64(newParentId) : undefined),
        encodeOption(undefined), // after_page_id
      ]);
    } catch (err) {
      return JSON.stringify({ ok: false, page_id: pageId, error: reducerErrorMessage(err) });
    }
    return JSON.stringify({
      ok: true,
      page_id: pageId,
      new_parent_id: newParentId ?? null,
    });
  },
};

// ── Memory tools ──────────────────────────────────────────────────────────────

const rememberTool: McpToolEntry = {
  name: "remember",
  description:
    "Save a durable memory as a page in your private memory subtree. Without " +
    "memory_page_id, creates a new memory page titled `title` with `content` (markdown). " +
    "With memory_page_id, appends to (default) or replaces that page's content. Memories " +
    "persist across sessions and are private to you; recall them with list_memory, " +
    "search_memory, and read_memory.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Title for a new memory page. Required unless memory_page_id is given.",
      },
      content: { type: "string", description: "The memory to save, as markdown." },
      memory_page_id: {
        type: "number",
        description: "Existing memory page to update (from list_memory/search_memory).",
      },
      mode: {
        type: "string",
        enum: ["append", "replace"],
        description: "How to update an existing page. Default: append.",
      },
    },
    required: ["content"],
  },
  execute: (ctx, input) => executeRemember(ctx, input),
};

const listMemoryTool: McpToolEntry = {
  name: "list_memory",
  description:
    "List every page in your private memory subtree — id, title, depth, size, snippet, and " +
    "last-updated date. Call this to see what you already know before saving or recalling.",
  inputSchema: { type: "object", properties: {} },
  execute: (ctx) => executeListMemory(ctx),
};

const readMemoryTool: McpToolEntry = {
  name: "read_memory",
  description:
    "Read the full body of one of your private memory pages by id. Use list_memory or " +
    "search_memory to find page ids. Only your own memory subtree is accessible.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "number", description: "The memory page id." },
    },
    required: ["page_id"],
  },
  execute: (ctx, input) => executeReadMemory(ctx, input),
};

const searchMemoryTool: McpToolEntry = {
  name: "search_memory",
  description:
    "Search your private memory pages (titles + bodies) for a query string and return " +
    "matching pages with snippets. Use before read_memory when you don't know which page " +
    "holds something.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Case-insensitive substring to find." },
    },
    required: ["query"],
  },
  execute: (ctx, input) => executeSearchMemory(ctx, input),
};

export function buildToolRegistry(): McpToolEntry[] {
  return [
    rememberTool,
    listMemoryTool,
    readMemoryTool,
    searchMemoryTool,
    createPageTool,
    getPageTool,
    updatePageContentTool,
    updatePageTitleTool,
    listChildPagesTool,
    searchPagesTool,
    deletePageTool,
    movePageTool,
  ];
}
