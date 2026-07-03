/**
 * The MCP tool surface: a curated allowlist over the worker's tool executor
 * plus the MCP-only memory tools.
 *
 * Deliberately excludes chat-coupled tools (render_ui, delegate,
 * request_page_access, tool_bash, …) and the wider database/property catalog —
 * v1 is memory + core page CRUD. Definitions are reused from tools.ts where
 * they exist; descriptions written for a chat agent are overridden for
 * external MCP clients (who have no memory index in a system prompt).
 */

import type Anthropic from "@anthropic-ai/sdk";
import { executeTool, getStaticToolDefs, type ConnLike, type ToolCallContext } from "../tools.js";
import { executeListMemory, executeRemember } from "./memory.js";

export interface McpToolEntry {
  name: string;
  description: string;
  /** JSON Schema for the tool input (Anthropic input_schema passes through). */
  inputSchema: Record<string, unknown>;
  handler: (
    conn: ConnLike,
    input: Record<string, unknown>,
    toolContext: ToolCallContext,
  ) => Promise<string>;
}

/** Executor-backed tools exposed under their existing names. */
const EXECUTOR_TOOLS: Array<{ name: string; descriptionOverride?: string }> = [
  { name: "create_page" },
  { name: "get_page" },
  { name: "update_page_content" },
  { name: "update_page_title" },
  { name: "list_child_pages" },
  { name: "search_pages" },
  { name: "delete_page" },
  { name: "move_page" },
  {
    name: "read_memory",
    descriptionOverride:
      "Read the full body of one of your private memory pages by id. Use list_memory or " +
      "search_memory to find page ids. Only your own memory subtree is accessible.",
  },
  {
    name: "search_memory",
    descriptionOverride:
      "Search your private memory pages (titles + bodies) for a query string and return " +
      "matching pages with snippets. Use before read_memory when you don't know which page " +
      "holds something.",
  },
];

const MEMORY_WRITE_TOOLS: McpToolEntry[] = [
  {
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
        content: {
          type: "string",
          description: "The memory to save, as markdown.",
        },
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
    handler: (conn, input, ctx) => executeRemember(conn, input, ctx),
  },
  {
    name: "list_memory",
    description:
      "List every page in your private memory subtree — id, title, depth, size, snippet, and " +
      "last-updated date. Call this to see what you already know before saving or recalling.",
    inputSchema: { type: "object", properties: {} },
    handler: (conn, _input, ctx) => executeListMemory(conn, ctx),
  },
];

export function buildToolRegistry(): McpToolEntry[] {
  const defsByName = new Map<string, Anthropic.Messages.Tool>(
    getStaticToolDefs().map((d) => [d.name, d]),
  );

  const executorEntries = EXECUTOR_TOOLS.map(({ name, descriptionOverride }) => {
    const def = defsByName.get(name);
    if (!def) {
      throw new Error(`MCP tool registry references unknown worker tool "${name}"`);
    }
    return {
      name,
      description: descriptionOverride ?? def.description ?? "",
      inputSchema: def.input_schema as Record<string, unknown>,
      handler: (conn: ConnLike, input: Record<string, unknown>, ctx: ToolCallContext) =>
        executeTool(conn, name, input, 0n, ctx),
    } satisfies McpToolEntry;
  });

  return [...MEMORY_WRITE_TOOLS, ...executorEntries];
}
