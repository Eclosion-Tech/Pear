/**
 * The Pear MCP tool surface: stateless tools over `/sql` + `/call`.
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
import { getPageTheme, setPageTheme } from "./theme";
import {
  createThread,
  listPageThreads,
  postToThread,
  reopenThread,
  resolveThread,
} from "./threads";
import { createPage } from "./create-page";
import { queryDatabase, setRowProperties } from "./database";
import {
  addProperty,
  deleteProperty,
  getSchemaId,
  listProperties,
} from "./database-schema";
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
    "Use page_type 'Database' for structured data with columns, 'Doc' for rich text. " +
    "When the parent is a Database page, the new page is a row — pass `properties` to set its " +
    "column values in the same call (same shapes as set_row_properties).",
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
      properties: {
        type: "object",
        description:
          "Only when the parent is a Database: column name → value map to set on the new row " +
          '(e.g. {"Status": "To Do", "Project": [68]}).',
      },
    },
    required: ["parent_id", "page_type", "title"],
  },
  execute: async (ctx, input) => {
    const result = await createPage(ctx.transport, {
      parentId: Number(input.parent_id ?? 0),
      pageType: input.page_type === "Database" ? "Database" : "Doc",
      title: String(input.title ?? ""),
    });
    const props = input.properties as Record<string, unknown> | undefined;
    if (!result.ok || result.page_id === undefined || !props || Object.keys(props).length === 0) {
      return JSON.stringify(result);
    }
    // Row-property pass — the page exists either way, so report property
    // failures alongside the successful create rather than masking it.
    const propResult = JSON.parse(await setRowProperties(ctx.transport, result.page_id, props));
    return JSON.stringify({
      ...result,
      properties_applied: propResult.applied ?? [],
      properties_error: propResult.ok ? undefined : propResult.error,
    });
  },
};

/**
 * Max characters of page content returned per get_page call. Content beyond
 * this is reachable via the `offset` param — never silently dropped (#211).
 */
const GET_PAGE_WINDOW_CHARS = 20_000;

const getPageTool: McpToolEntry = {
  name: "get_page",
  description:
    "Get details about a specific page by ID, including its title, type, parent, and content. " +
    "Long pages are returned in windows: when the response has `truncated: true`, call again with " +
    "`offset` set to the returned `next_offset` to read the rest.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "number" },
      offset: {
        type: "number",
        description:
          "Character offset to start reading from (default 0). Use the `next_offset` from a " +
          "truncated response to continue reading a long page.",
      },
    },
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

    const offset = Math.max(0, Math.trunc(Number(input.offset ?? 0)) || 0);
    const window = content.slice(offset, offset + GET_PAGE_WINDOW_CHARS);
    const truncated = offset + window.length < content.length;

    return JSON.stringify({
      ok: true,
      page_id: page.id,
      title: page.title,
      page_type: page.pageType,
      parent_id: page.parentId,
      content: window,
      total_chars: content.length,
      offset,
      truncated,
      next_offset: truncated ? offset + window.length : undefined,
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

const createThreadTool: McpToolEntry = {
  name: "create_thread",
  description:
    "Start a new comment thread anchored to a block on a page — the equivalent of selecting a block " +
    "and leaving a comment. Use it to raise something about a specific block rather than the page as " +
    "a whole. Get block ids from the page's component tree; the thread appears in the page's comment " +
    "gutter and is visible to anyone who can see the page. " +
    "Pass `participants` (names of AI users or people) to bring them in — someone must be a " +
    "participant before an `@mention` reaches them. Tag a person when something genuinely needs " +
    "their attention. " +
    "Pass `content` to post the opening message in the same call.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "number" },
      block_id: {
        type: "number",
        description: "ComponentNode id of the block to anchor the comment to.",
      },
      content: { type: "string", description: "Optional opening message." },
      participants: {
        type: "array",
        items: { type: "string" },
        description: 'Names of AI users or people to add, e.g. ["Kira", "Kara Raynoha"].',
      },
    },
    required: ["page_id", "block_id"],
  },
  execute: async (ctx, input) => {
    const pageId = Number(input.page_id);
    const page = await getPageRow(ctx.transport, pageId);
    if (!page) return JSON.stringify({ ok: false, error: "Page not found" });
    const participants = Array.isArray(input.participants)
      ? (input.participants as unknown[]).map(String)
      : [];
    return JSON.stringify(
      await createThread(ctx.transport, {
        pageId,
        blockId: Number(input.block_id),
        participants,
        content: input.content === undefined ? undefined : String(input.content),
      }),
    );
  },
};

const listPageThreadsTool: McpToolEntry = {
  name: "list_page_threads",
  description:
    "List the comment threads anchored to blocks on a page — the discussion happening in the page's " +
    "margin, as distinct from the AI sidebar. Returns each thread's conversation_id, the block it is " +
    "anchored to, whether it is resolved, its message count and a preview of the latest message. " +
    "Use this to find a thread before posting to or resolving it. Resolved threads are omitted " +
    "unless include_resolved is true.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "number" },
      include_resolved: {
        type: "boolean",
        description: "Include resolved threads. Defaults to false.",
      },
    },
    required: ["page_id"],
  },
  execute: async (ctx, input) => {
    const pageId = Number(input.page_id);
    const page = await getPageRow(ctx.transport, pageId);
    if (!page) return JSON.stringify({ ok: false, error: "Page not found" });
    const threads = await listPageThreads(
      ctx.transport,
      pageId,
      input.include_resolved === true,
    );
    return JSON.stringify({ ok: true, page_id: pageId, threads });
  },
};

const postToThreadTool: McpToolEntry = {
  name: "post_to_thread",
  description:
    "Post a message into a comment thread you participate in. Address a teammate by writing " +
    "`@Their Name` in the text — that is what wakes an AI user to respond, and an unaddressed " +
    "message is recorded but wakes nobody. Find thread ids with `list_page_threads`. " +
    "A resolved thread rejects new messages; reopen it first if you need to continue. " +
    "Note that AI-to-AI exchanges are capped: after several consecutive AI messages with no human " +
    "in between, further AI messages stop waking anyone.",
  inputSchema: {
    type: "object",
    properties: {
      conversation_id: { type: "number" },
      content: {
        type: "string",
        description: "Message text. Mention a teammate as `@Their Display Name` to wake them.",
      },
    },
    required: ["conversation_id", "content"],
  },
  execute: async (ctx, input) =>
    JSON.stringify(
      await postToThread(ctx.transport, Number(input.conversation_id), String(input.content ?? "")),
    ),
};

const resolveThreadTool: McpToolEntry = {
  name: "resolve_thread",
  description:
    "Mark a comment thread resolved, the way you would resolve a comment in a document. Use it when " +
    "the question is settled — it collapses the thread out of the page and stops further replies, " +
    "because a resolved thread rejects new messages. Prefer resolving over trailing off. " +
    "Reversible with `reopen_thread`.",
  inputSchema: {
    type: "object",
    properties: { conversation_id: { type: "number" } },
    required: ["conversation_id"],
  },
  execute: async (ctx, input) =>
    JSON.stringify(await resolveThread(ctx.transport, Number(input.conversation_id))),
};

const reopenThreadTool: McpToolEntry = {
  name: "reopen_thread",
  description:
    "Reopen a resolved comment thread so messages can be posted again. Use when something turns out " +
    "to be unfinished after all.",
  inputSchema: {
    type: "object",
    properties: { conversation_id: { type: "number" } },
    required: ["conversation_id"],
  },
  execute: async (ctx, input) =>
    JSON.stringify(await reopenThread(ctx.transport, Number(input.conversation_id))),
};

const setPageThemeTool: McpToolEntry = {
  name: "set_page_theme",
  description:
    "Set or clear a page's visual theme (background, accent colour, font, density, corner radius). " +
    "Every value is a token from a closed set — arbitrary CSS, colour codes, class names and URLs are " +
    "refused, not stored. Pass theme: null to clear. " +
    "accent/background.tone: default|blue|green|yellow|orange|red|purple|pink. " +
    "background.kind: none|tone|gradient|image. " +
    "background.gradient: dawn|dusk|ocean|forest|ember|violet. " +
    "font: system|serif|mono. density: compact|normal|comfortable. radius: none|sm|md|lg|full. " +
    "For an image background pass background.storageKey (an uploaded attachment's object id), " +
    "optional fit (cover|contain|tile|center) and opacity (0-100).",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "number" },
      theme: {
        type: ["object", "null"],
        description:
          'Theme object with a mandatory { "v": 1 }, or null to clear. ' +
          'Example: { "v": 1, "background": { "kind": "gradient", "gradient": "dusk" }, "accent": "purple", "font": "serif" }',
      },
    },
    required: ["page_id", "theme"],
  },
  execute: async (ctx, input) => {
    const pageId = Number(input.page_id);
    const page = await getPageRow(ctx.transport, pageId);
    if (!page) return JSON.stringify({ ok: false, error: "Page not found" });
    const result = await setPageTheme(ctx.transport, pageId, input.theme ?? null);
    return JSON.stringify(result);
  },
};

const getPageThemeTool: McpToolEntry = {
  name: "get_page_theme",
  description:
    "Read the visual theme currently stored on a page, or null if it has none.",
  inputSchema: {
    type: "object",
    properties: { page_id: { type: "number" } },
    required: ["page_id"],
  },
  execute: async (ctx, input) => {
    const pageId = Number(input.page_id);
    const theme = await getPageTheme(ctx.transport, pageId);
    return JSON.stringify({ ok: true, page_id: pageId, theme });
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
      // Subtree delete: matches the description — children go to the trash too.
      await ctx.transport.call("delete_page_subtree", [encodeU64(pageId)]);
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

const restorePageTool: McpToolEntry = {
  name: "restore_page",
  description: "Restore a page previously moved to the trash (undo delete_page).",
  inputSchema: {
    type: "object",
    properties: { page_id: { type: "number", description: "The trashed page to restore." } },
    required: ["page_id"],
  },
  execute: async (ctx, input) => {
    const pageId = Number(input.page_id);
    try {
      await ctx.transport.call("restore_page", [encodeU64(pageId)]);
    } catch (err) {
      return JSON.stringify({ ok: false, page_id: pageId, error: reducerErrorMessage(err) });
    }
    return JSON.stringify({ ok: true, page_id: pageId });
  },
};

// ── Database tools ────────────────────────────────────────────────────────────

const queryDatabaseTool: McpToolEntry = {
  name: "query_database",
  description:
    "Read rows from a Database page. Returns the database's columns (name + type) and its rows with " +
    "their cell values — `get_page` does NOT return database rows. Optionally filter with " +
    "`property_filter` (equality/contains on ONE named column, or the special \"title\" column). " +
    "Responses are windowed: when `truncated: true`, call again with `offset` set to the returned " +
    "`next_offset` to read the rest. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "number", description: "The Database page's id." },
      limit: { type: "number", description: "Max rows to return (default 50, capped at 200)." },
      offset: {
        type: "number",
        description:
          "Row offset to start from (default 0). Use the `next_offset` from a truncated " +
          "response to page through large databases.",
      },
      property_filter: {
        type: "object",
        description:
          'Optional filter on a single column. Set `property` to a column name (or "title") and ' +
          "provide `equals` and/or `contains`.",
        properties: {
          property: { type: "string" },
          equals: { description: "Keep rows whose column value equals this (compared as text)." },
          contains: {
            type: "string",
            description: "Keep rows whose column value contains this substring (case-insensitive).",
          },
        },
        required: ["property"],
      },
    },
    required: ["page_id"],
  },
  execute: (ctx, input) =>
    queryDatabase(ctx.transport, input as unknown as Parameters<typeof queryDatabase>[1]),
};

const setRowPropertiesTool: McpToolEntry = {
  name: "set_row_properties",
  description:
    "Set column values on a database row (a page whose parent is a Database), by column NAME. " +
    "Pass `properties` as an object mapping column names to values. Value shapes by column type: " +
    "Text/Url→string, Select→string (one option), Number→number, Checkbox→boolean, " +
    "Date→ISO date string or unix ms, MultiSelect→string[], Relation→page-id number[], " +
    "Person→identity-hex string[]. Use query_database on the parent to see column names and types. " +
    "Computed columns (Ai/Formula/Rollup) cannot be set.",
  inputSchema: {
    type: "object",
    properties: {
      page_id: { type: "number", description: "The row's page id (a child of a Database page)." },
      properties: {
        type: "object",
        description: 'Column name → value map, e.g. {"Status": "In Progress", "Project": [68]}.',
      },
    },
    required: ["page_id", "properties"],
  },
  execute: (ctx, input) =>
    setRowProperties(
      ctx.transport,
      Number(input.page_id),
      (input.properties ?? {}) as Record<string, unknown>,
    ),
};

const addPropertyTool: McpToolEntry = {
  name: "add_property",
  description:
    "Add a property (column) to a Database page. First call create_page with " +
    "page_type='Database', then use the returned schema_id to add properties. " +
    "For Select/MultiSelect include config: '{\"options\":[\"A\",\"B\"]}'.",
  inputSchema: {
    type: "object",
    properties: {
      schema_id: {
        type: "number",
        description: "Database schema ID returned by create_page or get_schema_id.",
      },
      name: { type: "string" },
      property_type: {
        type: "string",
        enum: [
          "Text",
          "Number",
          "Date",
          "Select",
          "MultiSelect",
          "Relation",
          "Checkbox",
          "Url",
          "Person",
          "File",
        ],
      },
      config: {
        type: "string",
        description:
          "JSON string. For Select/MultiSelect: '{\"options\":[\"Option1\",\"Option2\"]}'. Otherwise '{}'.",
      },
    },
    required: ["schema_id", "name", "property_type"],
  },
  execute: (ctx, input) => addProperty(ctx.transport, input),
};

const getSchemaIdTool: McpToolEntry = {
  name: "get_schema_id",
  description: "Get the database schema ID for an existing Database page.",
  inputSchema: {
    type: "object",
    properties: { page_id: { type: "number" } },
    required: ["page_id"],
  },
  execute: (ctx, input) => getSchemaId(ctx.transport, Number(input.page_id)),
};

const deletePropertyTool: McpToolEntry = {
  name: "delete_property",
  description:
    "Permanently delete one Database property (column) by property_definition_id. " +
    "Existing values in that column become inaccessible. Use only when the user clearly asked " +
    "to remove that specific column; call list_properties first to confirm its id and name.",
  inputSchema: {
    type: "object",
    properties: {
      property_definition_id: {
        type: "number",
        description: "The exact property definition id to delete.",
      },
    },
    required: ["property_definition_id"],
  },
  execute: (ctx, input) =>
    deleteProperty(ctx.transport, Number(input.property_definition_id)),
};

const listPropertiesTool: McpToolEntry = {
  name: "list_properties",
  description:
    "List the property definitions (columns) for a database schema, including the exact " +
    "property_definition_id needed by delete_property.",
  inputSchema: {
    type: "object",
    properties: {
      schema_id: {
        type: "number",
        description: "Database schema ID returned by create_page or get_schema_id.",
      },
    },
    required: ["schema_id"],
  },
  execute: (ctx, input) => listProperties(ctx.transport, Number(input.schema_id)),
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
    setPageThemeTool,
    getPageThemeTool,
    createThreadTool,
    listPageThreadsTool,
    postToThreadTool,
    resolveThreadTool,
    reopenThreadTool,
    listChildPagesTool,
    searchPagesTool,
    getSchemaIdTool,
    listPropertiesTool,
    queryDatabaseTool,
    addPropertyTool,
    deletePropertyTool,
    setRowPropertiesTool,
    deletePageTool,
    restorePageTool,
    movePageTool,
  ];
}
